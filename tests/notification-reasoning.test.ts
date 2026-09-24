import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPluginConfig } from "../src/config";
import { SessionManager } from "../src/session-manager";
import { getSessionsListingText } from "../src/application/session-view";
import { Session } from "../src/session";
import { STORE_SCHEMA_VERSION } from "../src/session-store-normalization";
import { SessionStore } from "../src/session-store";
import { SessionNotificationService } from "../src/session-notifications";
import { SessionRuntimeBootstrapService } from "../src/session-runtime-bootstrap-service";
import { SessionWorktreeMessageService } from "../src/session-worktree-message-service";
import { formatHarnessModelLabel, formatReasoningMetadataSuffix } from "../src/session-display";
import { buildCompletedPayload, buildFailedPayload, buildTurnCompletePayload, buildWaitingForInputPayload } from "../src/session-notification-builder";
import { resolveAgentLaunchRequest } from "../src/tools/agent-launch-resolution";
import { resolveWorktreeToolTarget } from "../src/tools/worktree-tool-context";
import { makeAgentLaunchTool } from "../src/tools/agent-launch";
import { setSessionManager } from "../src/singletons";
import type { SessionNotificationRequest } from "../src/wake-dispatcher";
import type { PersistedSessionInfo, ReasoningEffort } from "../src/types";
import { resetCodexModelCatalogForTests } from "../src/harness/codex-model-catalog";
import { seedCodexModelCatalog } from "./codex-model-catalog-fixture";

const LIFECYCLE_NOTIFICATION_VARIANTS = [
  "launch", "resumed-launch", "progress", "running", "completed", "failed", "cancelled",
  "suspended", "recovered", "restart", "resume", "fork", "notification", "agent-respond",
  "plan-submitted", "plan-approval", "plan-approved", "plan-revised", "plan-rejected",
  "plan-approval-timeout", "permission-prompt", "decision-prompt", "worktree-manual",
  "worktree-no-change", "worktree-dirty", "worktree-merge-failed", "worktree-cleaned",
  "pr-opened", "pr-updated", "pr-merged", "goal-task-started", "goal-task-progress",
  "goal-task-failed", "goal-task-succeeded",
] as const;

function makeSession(reasoningEffort?: ReasoningEffort): Session {
  return new Session({
    prompt: "Implement the task", workdir: "/tmp", harness: "codex", reasoningEffort,
    route: { provider: "telegram", target: "test-route" },
  }, "reasoning-test");
}

function recorder(persisted?: PersistedSessionInfo) {
  const requests: SessionNotificationRequest[] = [];
  const service = new SessionNotificationService({
    dispatchSessionNotification: (_session: unknown, request: SessionNotificationRequest) => requests.push(request),
  } as any, () => {}, { getPersistedSession: () => persisted });
  return { service, requests };
}

describe("notification reasoning visibility", () => {
  beforeEach(() => { seedCodexModelCatalog(); });
  afterEach(() => { setPluginConfig({}); setSessionManager(null); resetCodexModelCatalogForTests(); });

  it("uses explicit launch effort ahead of configured defaults and leaves unset Codex effort to Codex", () => {
    setPluginConfig({ harnesses: { codex: { reasoningEffort: "high" } } });
    assert.equal(makeSession().reasoningEffort, "high");
    assert.equal(makeSession("low").reasoningEffort, "low");
    setPluginConfig({});
    assert.equal(makeSession().reasoningEffort, undefined);
  });

  it("prefers the Codex session's own reported effort support over the shared catalog", () => {
    assert.equal(formatHarnessModelLabel({ harness: "codex", model: "gpt-6-sol", reasoningEffort: "max", reasoningEffortSupported: false }), "codex | gpt-6-sol");
    assert.equal(formatHarnessModelLabel({ harness: "codex", model: "custom-model", reasoningEffort: "high", reasoningEffortSupported: true }), "codex | custom-model | reasoning: high");
  });

  it("uses Codex model/list efforts and falls back to universal levels before the catalog loads", () => {
    assert.equal(formatHarnessModelLabel({ harness: "codex", model: "gpt-6-luna", reasoningEffort: "max" }), "codex | gpt-6-luna | reasoning: max");
    assert.equal(formatHarnessModelLabel({ harness: "codex", model: "gpt-5.5", reasoningEffort: "max" }), "codex | gpt-5.5");
    resetCodexModelCatalogForTests();
    assert.equal(formatHarnessModelLabel({ harness: "codex", model: "gpt-6-luna", reasoningEffort: "high" }), "codex | gpt-6-luna | reasoning: high");
    assert.equal(formatHarnessModelLabel({ harness: "codex", model: "gpt-6-luna", reasoningEffort: "max" }), "codex | gpt-6-luna");
  });

  for (const input of [
    { harness: "codex", model: "gpt-6-astra" },
    { harness: "codex", model: "gpt-4o", reasoningEffort: "high" },
    { harness: "codex", model: "custom-model", reasoningEffort: "high" },
    { harness: "codex", reasoningEffort: "high" },
    { harness: "opencode", model: "gpt-6-astra", reasoningEffort: "high" },
    { harness: "other", model: "gpt-6-astra", reasoningEffort: "high" },
    { harness: "claude-code", model: "haiku", reasoningEffort: "high" },
    { harness: "claude-code", model: "claude-sonnet-4-6", reasoningEffort: "xhigh" },
    { harness: "codex", model: "gpt-6-astra", reasoningEffort: "bogus" },
    { harness: "codex", model: "gpt-5.1-2025-11-13", reasoningEffort: "xhigh" },
    { harness: "codex", model: "gpt-5.5-2026-05-01", reasoningEffort: "max" },
    { harness: "claude-code", model: "claude-sonnet-4-6-20260217", reasoningEffort: "xhigh" },
    { harness: "claude-code", model: "claude-opus-4-5-20251101", reasoningEffort: "max" },
  ]) {
    it(`omits unknown/unsupported settings: ${JSON.stringify(input)}`, () => {
      assert.doesNotMatch(formatHarnessModelLabel(input as any) ?? "", /reasoning:/);
      assert.equal(formatReasoningMetadataSuffix(input as any), "");
    });
  }

  it("formats known Codex and Claude effort without altering provider IDs", () => {
    for (const [harness, model, effort] of [
      ["codex", "gpt-6-sol", "medium"],
      ["codex", "gpt-6-sol", "max"],
      ["codex", "gpt-6-astra", "medium"],
      ["codex", "openai/gpt-5.6-sol", "max"],
      ["claude-code", "opus", "medium"],
      ["claude-code", "opus", "xhigh"],
      ["claude-code", "anthropic/claude-opus-5-5", "medium"],
      ["claude-code", "anthropic/claude-opus-5-5", "xhigh"],
      ["claude-code", "anthropic/claude-opus-5-5", "max"],
      ["claude-code", "anthropic/claude-sonnet-4-7", "high"],
      ["claude-code", "claude-opus-4-7", "xhigh"],
      ["codex", "openai/gpt-6-astra-2026-09-01", "max"],
      ["codex", "gpt-5.6-sol-2026-07-01", "xhigh"],
      ["claude-code", "anthropic/claude-opus-4-7-20260416", "xhigh"],
      ["claude-code", "claude-sonnet-4-6-20260217", "max"],
    ]) {
      assert.equal(formatHarnessModelLabel({ harness, model, reasoningEffort: effort as ReasoningEffort }),
        `${harness} | ${model} | reasoning: ${effort}`);
    }
  });

  it("treats lifecycle model and reasoning metadata as an atomic display unit", () => {
    assert.equal(formatReasoningMetadataSuffix({
      harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "high",
    }), " | codex | gpt-5.6-sol | reasoning: high");
    assert.equal(formatReasoningMetadataSuffix({ harness: "codex", reasoningEffort: "high" }), "");
    assert.equal(formatReasoningMetadataSuffix({ model: "gpt-5.6-sol", reasoningEffort: "high" }), "");
    assert.equal(formatReasoningMetadataSuffix({
      harness: "codex", model: "custom-model", reasoningEffort: "high",
    }), "");
  });

  for (const resumed of [false, true]) {
    it(`renders the effective level at ${resumed ? "resumed" : "initial"} launch and terminal delivery once`, async () => {
      const session = makeSession("medium");
      if (resumed) Object.assign(session, { resumeSessionId: "backend-thread", resumedFromSessionName: "original" });
      // No backend invocation is needed to exercise the real bootstrap renderer.
      session.start = async () => {};
      const { service, requests } = recorder();
      const bootstrap = new SessionRuntimeBootstrapService({
        hydrateSpawnedSession: () => {}, markRunning: () => {}, handleTerminal: async () => {},
        handleTurnEnd: async () => {}, formatLaunchWorkdirLabel: () => "/tmp",
        notifySession: (target, text, label) => service.dispatch(target, { label: label!, userMessage: text }),
      });
      await bootstrap.initializeSession(session, {} as any, {} as any);
      assert.equal(requests[0]?.userMessage,
        `${resumed ? "▶️ [original] Resumed | Follow-up label: reasoning-test" : "🚀 [reasoning-test] Launched"} | /tmp | codex | gpt-6-sol | reasoning: medium`);
      setPluginConfig({ harnesses: { codex: { reasoningEffort: "high" } } });
      for (const [label, payload] of [
        ["completed", buildCompletedPayload({ session, preview: "Done", originThreadLine: "" })],
        ["failed", buildFailedPayload({ session, preview: "", originThreadLine: "", errorSummary: "Failure", worktreeAutoCleaned: false })],
        ["turn-complete", buildTurnCompletePayload({ session, preview: "Next", originThreadLine: "" })],
      ] as const) {
        assert.match(payload.userMessage, /\| reasoning: medium(?:\n|$)/);
        service.dispatch(session, { label, ...payload });
      }
      for (const request of requests) assert.equal(request.userMessage?.match(/reasoning: medium/g)?.length, 1);
    });
  }

  it("covers every shared lifecycle notification variant without changing bodies or buttons", () => {
    const session = makeSession("high");
    const { service, requests } = recorder();
    const buttons = [[{ label: "Approve", callbackData: "unchanged-token" }]];
    for (const label of LIFECYCLE_NOTIFICATION_VARIANTS) {
      service.dispatch(session, { label, userMessage: `📋 [reasoning-test] ${label}\n\n**Keep markup** https://example.com/pr/1`, buttons });
      const request = requests.at(-1)!;
      assert.equal(request.userMessage, `📋 [reasoning-test] ${label} | codex | gpt-6-sol | reasoning: high\n\n**Keep markup** https://example.com/pr/1`);
      assert.equal(request.buttons, buttons);
    }
    const payload = buildWaitingForInputPayload({ session, preview: "Question?", originThreadLine: "" });
    service.dispatch(session, payload);
    assert.match(requests.at(-1)!.userMessage!, /Question waiting for reply: \| codex \| gpt-6-sol \| reasoning: high\n/);
    service.dispatch(session, {
      label: "plan-approval", userMessages: [
        { text: "📋 [reasoning-test] Plan (1/2):\nBody one", requiredForSequenceSuccess: true },
        { text: "📋 [reasoning-test] Plan (2/2):\nBody two", buttons, requiredForSequenceSuccess: true },
        { text: "Continuation body without a heading", requiredForSequenceSuccess: true },
      ],
    });
    const pages = requests.at(-1)!.userMessages!;
    assert.match(pages[0].text, /reasoning: high\nBody one$/);
    assert.match(pages[1].text, /reasoning: high\nBody two$/);
    assert.equal(pages[1].buttons, buttons);
    assert.ok(pages.every((page) => page.requiredForSequenceSuccess));
    assert.equal(pages[2].text, "Continuation body without a heading");
    const noChange = new SessionWorktreeMessageService().buildNoChangeNotification({
      session, cleanupSucceeded: true, worktreePath: "/tmp/wt", preview: "Done",
    });
    assert.match(noChange.userMessage!, /reasoning: high$/);
  });

  it("never emits orphan reasoning when model metadata is unavailable", () => {
    const { service, requests } = recorder();
    const modelUnavailable = { id: "missing-model", harnessName: "codex", reasoningEffort: "high" } as any;
    for (const label of LIFECYCLE_NOTIFICATION_VARIANTS) {
      service.dispatch(modelUnavailable, {
        label: `missing-model-${label}`,
        userMessage: `📋 [missing-model] ${label}`,
      });
    }
    for (const request of requests) {
      assert.doesNotMatch(request.userMessage!, /reasoning:/);
    }
  });

  it("round-trips running/terminal settings and restores manual PR/merge metadata without consulting new defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "oca-reasoning-"));
    try {
      const path = join(dir, "sessions.json");
      const options = { env: { OPENCLAW_CODE_AGENT_SESSIONS_PATH: path } };
      const session = makeSession("low");
      session.harnessSessionId = "thread-reasoning";
      const store = new SessionStore(options);
      store.markRunning(session);
      assert.equal(new SessionStore(options).getPersistedSession(session.id)?.reasoningEffort, "low");
      setPluginConfig({ harnesses: { codex: { reasoningEffort: "high" } } });
      session.transition("running");
      session.transition("failed");
      store.persistTerminal(session);
      const restored = new SessionStore(options).getPersistedSession(session.id)!;
      assert.equal(restored.status, "failed");
      assert.equal(restored.reasoningEffort, "low");
      const { service, requests } = recorder(restored);
      service.dispatch({ id: session.id } as any, { label: "recovery", userMessage: "⚠️ Recovered after restart" });
      assert.match(requests[0].userMessage!, /reasoning: low$/);
      const target = resolveWorktreeToolTarget({ resolve: () => undefined, getPersistedSession: () => restored } as any, session.id);
      assert.equal(target.notificationTarget?.reasoningEffort, "low");
      for (const outcome of ["✅ PR opened: https://example.com/pr/1", "✅ Merged task → main"]) {
        service.notifyWorktreeOutcome(target.notificationTarget as any, outcome, { summaryWakeRequired: false });
        assert.match(requests.at(-1)!.userMessage!, /codex \| gpt-6-sol \| reasoning: low$/);
      }
      // Old records without effort remain unknown even when today's config knows a default.
      delete restored.reasoningEffort;
      writeFileSync(path, JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, sessions: [restored], actionTokens: [], repoPolicies: [] }));
      const legacy = new SessionStore(options).getPersistedSession(session.id)!;
      assert.ok(legacy);
      assert.equal(legacy.reasoningEffort, undefined);
      const old = recorder(legacy);
      old.service.dispatch({ id: session.id } as any, { label: "recovery", userMessage: "Recovered" });
      assert.equal(old.requests[0].userMessage, "Recovered");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  for (const fork of [false, true]) {
    it(`retains saved effort for ${fork ? "fork" : "resume"}, with explicit override first`, () => {
      setPluginConfig({ defaultHarness: "codex", harnesses: { codex: { reasoningEffort: "high" } } });
      const params = { prompt: "Continue", workdir: "/tmp", resume_session_id: "old", fork_session: fork };
      const manager = {
        resolveBackendConversationId: () => "old-thread",
        getPersistedSession: () => ({ harness: "codex", reasoningEffort: "low" as const }),
      };
      const ctx = { workspaceDir: "/tmp", oneShotCliRun: true };
      const inherited = resolveAgentLaunchRequest(params, ctx, manager);
      assert.equal(inherited.kind, "resolved");
      if (inherited.kind === "resolved") assert.equal(inherited.reasoningEffort, "low");
      const explicit = resolveAgentLaunchRequest({ ...params, reasoning_effort: "medium" }, ctx, manager);
      assert.equal(explicit.kind, "resolved");
      if (explicit.kind === "resolved") assert.equal(explicit.reasoningEffort, "medium");
    });
  }

  it("shows live and restored session listings with their saved levels", () => {
    const session = makeSession("low");
    const text = getSessionsListingText({
      list: () => [session],
      listPersistedSessions: () => [{
        sessionId: "saved-list", name: "saved", status: "failed", harness: "codex",
        model: "gpt-6-astra", reasoningEffort: "high", createdAt: Date.now(),
      }],
    } as any, "all");
    assert.match(text, /gpt-6-sol \| reasoning: low/);
    assert.match(text, /gpt-6-astra \| reasoning: high/);
  });

  it("carries goal progress and terminal settings through routing proxies", () => {
    const { service, requests } = recorder();
    const manager = Object.create(SessionManager.prototype);
    manager.notifications = service;
    manager.resolve = () => undefined;
    manager.getPersistedSession = () => undefined;
    const task = { id: "goal", name: "goal", harness: "codex", model: "gpt-6-astra", reasoningEffort: "medium" };
    for (const label of ["goal-task-started", "goal-task-progress", "goal-task-failed", "goal-task-succeeded"]) {
      manager.emitGoalTaskUpdate(task, "Goal update", label);
      assert.match(requests.at(-1)!.userMessage!, /reasoning: medium(?:\n|$)/);
    }
  });

  it("passes explicit tool overrides to spawn and rejects invalid effort before launching", async () => {
    const configs: any[] = [];
    setPluginConfig({ defaultHarness: "codex" });
    setSessionManager({ launchSession: (config: any) => { configs.push(config); return { ...config, id: "launch", name: "launch" }; } } as any);
    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    await tool.execute("valid", { prompt: "Task", reasoning_effort: "high" });
    assert.equal(configs[0]?.reasoningEffort, "high");
    const invalid = await tool.execute("invalid", { prompt: "Task", reasoning_effort: "invalid" });
    assert.match((invalid.content[0] as any).text, /Invalid parameters/);
    assert.equal(configs.length, 1);
  });
});
