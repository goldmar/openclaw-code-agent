import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { Type } from "../src/tool-parameter-schema";
import { normalizeBooleanParams } from "../src/tools/boolean-normalization";
import { makeAgentRespondTool } from "../src/tools/agent-respond";
import { makeAgentLaunchTool } from "../src/tools/agent-launch";
import { makeAgentMergeTool } from "../src/tools/agent-merge";
import { makeAgentPrTool } from "../src/tools/agent-pr";
import { makeAgentOutputTool } from "../src/tools/agent-output";
import { makeAgentSessionsTool } from "../src/tools/agent-sessions";
import { makeAgentWorktreeCleanupTool } from "../src/tools/agent-worktree-cleanup";
import { makeAgentRepoPolicyTool } from "../src/tools/agent-repo-policy";
import { setSessionManager } from "../src/singletons";
import { setPluginConfig } from "../src/config";
import type { SessionManager } from "../src/session-manager";
import { createStubSession } from "./helpers";

const invalid = [null, 0, 1, -1, "", "TRUE", "False", " true", "false ", "1", "0", "yes", [], {}, new Boolean(false)];
const boundaries = () => [
  { tool: makeAgentRespondTool(), fields: ["approve", "interrupt", "userInitiated"], extra: { ocaSessionId: "exact-id", message: "Continue" } },
  { tool: makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true }), fields: ["fork_session", "force_new_session"], extra: { prompt: "Continue" } },
  { tool: makeAgentMergeTool(), fields: ["push", "delete_branch"], extra: { ocaSessionId: "exact-id" } },
  { tool: makeAgentPrTool(), fields: ["force_new", "update_metadata"], extra: { ocaSessionId: "exact-id" } },
  { tool: makeAgentOutputTool(), fields: ["full"], extra: { ocaSessionId: "exact-id" } },
  { tool: makeAgentSessionsTool(), fields: ["full"], extra: {} },
  { tool: makeAgentWorktreeCleanupTool(), fields: ["dismiss_session"], extra: { ocaSessionId: "exact-id" } },
  { tool: makeAgentRepoPolicyTool({ workspaceDir: "/tmp" }), fields: ["reset", "list", "cleanup"], extra: {} },
];
afterEach(() => { setSessionManager(null); setPluginConfig({}); });

function manager(value: object) { setSessionManager(value as SessionManager); }

describe("public boolean boundary", () => {
  it("validates native booleans and only exact lowercase strings against every advertised schema", () => {
    for (const { tool, fields, extra } of boundaries()) {
      for (const field of fields) {
        for (const value of [true, false, "true", "false"]) {
          assert.equal(Check(tool.parameters, { ...extra, [field]: value }), true, `${tool.name}.${field}: ${value}`);
        }
        assert.equal(Check(tool.parameters, extra), true, `${tool.name}.${field}: omitted`);
        // Boxed booleans are not JSON; exercise those through direct execution below.
        for (const value of invalid.filter((value) => !(value instanceof Boolean))) {
          assert.equal(Check(tool.parameters, { ...extra, [field]: value }), false, `${tool.name}.${field}: ${JSON.stringify(value)}`);
        }
      }
    }
  });

  it("rejects every invalid boolean before lookup, launch, Git, approval, notification or policy effects", async () => {
    manager(new Proxy({}, { get() { assert.fail("invalid boolean reached SessionManager"); } }));
    for (const { tool, fields, extra } of boundaries()) {
      for (const field of fields) for (const value of invalid) {
        const result = await tool.execute("invalid", { ...extra, [field]: value });
        assert.match(result.content[0].text, /Invalid parameters/, `${tool.name}.${field}: ${JSON.stringify(value)}`);
      }
    }
  });

  it("copies input and preserves omission distinctly from invalid values", () => {
    const schema = Type.Object({ flag: Type.Optional(Type.Boolean()) });
    const input = { flag: "false" };
    assert.deepEqual(normalizeBooleanParams(input, ["flag"], (value): value is { flag?: boolean } => Check(schema, value)), { flag: false });
    assert.deepEqual(input, { flag: "false" });
    assert.deepEqual(normalizeBooleanParams({}, ["flag"], (value): value is { flag?: boolean } => Check(schema, value)), {});
    assert.deepEqual(normalizeBooleanParams({ flag: undefined }, ["flag"], (value): value is { flag?: boolean } => Check(schema, value)), { flag: undefined });
    assert.equal(normalizeBooleanParams({ flag: "bad" }, ["flag"], (value): value is { flag?: boolean } => Check(schema, value)), undefined);
  });
});

describe("respond execution with repaired representations", () => {
  async function run(flags: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    const effects: string[] = [];
    const session = createStubSession({ id: "exact-id", currentPermissionMode: "default", autoRespondCount: 2,
      sendMessage: async () => { effects.push("send"); },
      interrupt: async () => { effects.push("interrupt"); return true; },
      switchPermissionMode: (mode: string) => { effects.push(mode); }, ...overrides });
    manager({ resolve: (ref: string) => { assert.equal(ref, "exact-id"); return session; }, getPersistedSession: (): undefined => undefined });
    const result = await makeAgentRespondTool().execute("respond", { ocaSessionId: "exact-id", message: "Continue", ...flags });
    return { result, effects, count: session.autoRespondCount };
  }

  it("string false and omission send without permission escalation, interruption or resetting the response count", async () => {
    const native = await run({ approve: false, interrupt: false, userInitiated: false });
    assert.equal(native.result.isError, false);
    assert.deepEqual(native.effects, ["send"]);
    assert.equal(native.count, 3);
    assert.deepEqual(await run({ approve: "false", interrupt: "false", userInitiated: "false" }), native);
    assert.deepEqual(await run({}), native);
  });

  it("string true performs the same admitted interruption, permission change and count reset as native true", async () => {
    const native = await run({ approve: true, interrupt: true, userInitiated: true });
    assert.equal(native.result.isError, false);
    assert.deepEqual(native.effects, ["interrupt", "bypassPermissions", "send"]);
    assert.equal(native.count, 0);
    assert.deepEqual(await run({ approve: "true", interrupt: "true", userInitiated: "true" }), native);
  });

  it("string true cannot approve an ask-mode plan even while claiming userInitiated", async () => {
    for (const value of [true, "true"]) {
      const outcome = await run({ approve: value, userInitiated: value }, { currentPermissionMode: "plan", lifecycle: "awaiting_plan_decision",
        pendingPlanApproval: true, approvalState: "pending", planApproval: "ask", planDecisionVersion: 1, actionablePlanDecisionVersion: 1 });
      assert.equal(outcome.result.isError, true);
      assert.match(outcome.result.content[0].text, /reserved for the user/);
      assert.deepEqual(outcome.effects, []);
      assert.equal(outcome.count, 2);
    }
  });

  it("string true preserves the goal owner's refusal before any response effect", async () => {
    const effects: string[] = [];
    const session = createStubSession({ id: "exact-id", goalTaskId: "owned-goal", currentPermissionMode: "default",
      sendMessage: async () => effects.push("send"), interrupt: async () => effects.push("interrupt"),
      switchPermissionMode: () => effects.push("approval") });
    manager({ resolve: () => session, continueGoalSession: async () => { throw new Error("Owner refused continuation"); } });
    const result = await makeAgentRespondTool().execute("owner", { ocaSessionId: "exact-id", message: "Continue", approve: "true", interrupt: "true", userInitiated: "true" });
    assert.match(result.content[0].text, /Owner refused/);
    assert.deepEqual(effects, []);
  });
});

describe("launch execution with repaired representations", () => {
  it("fork string false preserves the stable ID; string true forks, including the deferred policy path", async () => {
    for (const deferred of [false, true]) for (const value of [undefined, false, "false", true, "true"]) {
      setPluginConfig({ defaultHarness: "codex" });
      let launch: Record<string, unknown> | undefined;
      manager({ resolve: (): undefined => undefined, getPersistedSession: () => ({ sessionId: "stable-id", harness: "codex", name: "stable-name", status: "killed",
          lifecycle: "terminal", killReason: "shutdown", backendRef: { kind: "codex-app-server", conversationId: "thread-id" } }),
        resolveBackendConversationId: () => "thread-id",
        launchSession: (config: Record<string, unknown>) => { launch = config; return { id: "stable-id", name: "stable-name" }; },
        ...(deferred ? { checkRepoPolicyForLaunch: () => ({ ok: false, text: "Policy needed" }), requestRepoPolicyForLaunch: (config: Record<string, unknown>) => { launch = config; return "Deferred"; } } : {}),
      });
      const result = await makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true }).execute("launch", { prompt: "Continue", resume_session_id: "stable-id",
        fork_session: value, force_new_session: "false", worktree_strategy: deferred ? "manual" : "off" });
      assert.doesNotMatch(result.content[0].text, /Error:/);
      assert.ok(launch);
      const fork = value === true || value === "true";
      assert.equal(launch.forkSession, value === undefined ? undefined : fork);
      assert.equal(launch.sessionIdOverride, fork ? undefined : "stable-id");
      if (deferred) assert.equal(launch.forceNewSession, false);
    }
  });

  it("force_new_session string false retains resume-first protection and string true intentionally launches", async () => {
    const key = "agent:main:telegram:group:12345:topic:42";
    for (const value of [undefined, false, "false", true, "true"]) {
      let launched = false;
      manager({ list: () => [{ id: "linked", name: "linked", status: "running", workdir: "/tmp", originSessionKey: key }], listPersistedSessions: (): never[] => [],
        launchSession: () => { launched = true; return { id: "fresh", name: "fresh" }; } });
      const result = await makeAgentLaunchTool({ workspaceDir: "/tmp", sessionKey: key, messageChannel: "telegram", requesterSenderId: "12345", oneShotCliRun: true }).execute("launch", { prompt: "Fresh task", force_new_session: value });
      assert.equal(launched, value === true || value === "true");
      if (!launched) assert.match(result.content[0].text, /Resume-first protection/);
    }
  });
});

describe("view, cleanup and policy execution", () => {
  it("output full preserves the default line limit and requests all output only for true", async () => {
    for (const value of [undefined, false, "false", true, "true"]) {
      const calls: Array<number | undefined> = [];
      const session = createStubSession({ id: "exact-id", duration: 0, costUsd: 0, getOutput: (lines?: number) => { calls.push(lines); return ["Output"]; } });
      manager({ resolve: () => session, getPersistedSession: (): undefined => undefined });
      const result = await makeAgentOutputTool().execute("output", { ocaSessionId: "exact-id", full: value });
      assert.match(result.content[0].text, /Output/);
      assert.deepEqual(calls, [value === true || value === "true" ? undefined : 50]);
    }
  });

  it("sessions full preserves the five-session default and enables the 24-hour view only for true", async () => {
    manager({ list: () => Array.from({ length: 6 }, (_, i) => createStubSession({ id: `id-${i}`, name: `name-${i}`, prompt: "Task", duration: 0, costUsd: 0, startedAt: Date.now() - i })), listPersistedSessions: (): never[] => [] });
    for (const value of [undefined, false, "false", true, "true"]) {
      const result = await makeAgentSessionsTool().execute("list", { full: value });
      assert.equal((result.content[0].text.match(/name-\d/g) ?? []).length, value === true || value === "true" ? 6 : 5);
    }
  });

  it("dismiss_session false and omission preserve the preview path; true invokes dismissal", async () => {
    for (const value of [undefined, false, "false", true, "true"]) {
      const dismissals: string[] = [];
      manager({ list: (): never[] => [], listPersistedSessions: (): never[] => [], resolve: (): undefined => undefined, getPersistedSession: () => ({ sessionId: "exact-id" }),
        dismissWorktree: async (ref: string) => { dismissals.push(ref); return "Dismissed"; } });
      const result = await makeAgentWorktreeCleanupTool().execute("cleanup", { ocaSessionId: "exact-id", mode: "preview_all", dismiss_session: value });
      assert.deepEqual(dismissals, value === true || value === "true" ? ["exact-id"] : []);
      assert.doesNotMatch(result.content[0].text, /Invalid parameters/);
    }
  });

  it("policy reset/list/cleanup strings have the same effects as native values and defaults", async () => {
    for (const field of ["reset", "list", "cleanup"]) for (const value of [undefined, false, "false", true, "true"]) {
      const effects: string[] = [];
      manager({ cleanupRepoPolicies: async (): Promise<never[]> => { effects.push("cleanup"); return []; }, listRepoPolicies: (): never[] => { effects.push("list"); return []; },
        resetRepoPolicy: async (): Promise<never[]> => { effects.push("reset"); return []; }, resolveRepoPolicy: async () => { effects.push("show"); return {}; }, findStoredRepoPolicies: (): never[] => [] });
      const result = await makeAgentRepoPolicyTool({ workspaceDir: "/tmp" }).execute("policy", { [field]: value });
      assert.doesNotMatch(result.content[0].text, /Invalid parameters/);
      assert.deepEqual(effects, [value === true || value === "true" ? field : "show"]);
    }
  });
});
