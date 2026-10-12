import "./test-env";
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeAgentRespondTool } from "../src/tools/agent-respond";
import { makeAgentLaunchTool } from "../src/tools/agent-launch";
import { setSessionManager } from "../src/singletons";
import { setPluginConfig } from "../src/config";
import type { SessionManager } from "../src/session-manager";
import { startInteractionFixture, TEST_ROUTE } from "./user-interaction-fixture";
import { waitUntil } from "./harness-backends";

type Tool = {
  name: string; label: string; description: string; parameters: object;
  execute: (id: string, input: unknown) => Promise<unknown>;
};
type Result = { isError?: boolean; content?: Array<{ text: string }>; details?: { result?: Result } };
type Control = { name: string; execute: (id: string, input: unknown) => Promise<Result> };

/** Use the pinned host's actual tool_call schema validation and dispatcher, not a mock wrapper. */
async function hostControl(tools: Tool[]): Promise<Control> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const core = join(root, "node_modules", "openclaw");
  const expected = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies.openclaw;
  assert.equal(JSON.parse(readFileSync(join(core, "package.json"), "utf8")).version, expected);
  const dist = join(core, "dist");
  async function exported<T>(name: string): Promise<T> {
    for (const file of readdirSync(dist).filter((file) => file.endsWith(".mjs"))) {
      const source = readFileSync(join(dist, file), "utf8");
      const match = source.slice(source.lastIndexOf("export {")).match(new RegExp("(?:\\{|,)\\s*" + name + " as (\\w+)"));
      if (!match) continue;
      const value = (await import(join(dist, file)))[match[1]];
      assert.equal(typeof value, "function", `Missing callable host export ${name}`);
      return value as T;
    }
    throw new Error(`Missing host export ${name}`);
  }
  const refFactory = await exported<() => unknown>("createToolSearchCatalogRef");
  const register = await exported<(params: { catalogRef: unknown; tools: Tool[] }) => void>("registerHeadlessToolSearchCatalog");
  const create = await exported<(ctx: { catalogRef: unknown; config: object }) => Control[]>("createToolSearchTools");
  const catalogRef = refFactory();
  register({ catalogRef, tools });
  const control = create({ catalogRef, config: {} }).find((tool) => tool.name === "tool_call");
  assert.ok(control);
  return control;
}

it("issue #537: native/string true approvals traverse the real wrapper and implement an admitted OpenCode plan", async () => {
  for (const planApproval of ["delegate", "approve", "ask"] as const) {
    for (const value of [true, "true"]) {
      const f = await startInteractionFixture("opencode", { permissionMode: "plan", planApproval });
      try {
        f.backend.proposePlan("Plan: make the approved scratch change.");
        await waitUntil(() => f.session.pendingPlanApproval, "pending OpenCode plan");
        const before = f.backend.turns.length;
        f.session.autoRespondCount = 2;
        let dispatched = 0;
        const tool = makeAgentRespondTool();
        const control = await hostControl([{ ...tool, label: "OCA response", execute: async (id, input) => {
          dispatched++;
          return tool.execute(id, input);
        } }]);
        const result = await control.execute("approval", { id: "agent_respond", args: {
          ocaSessionId: f.session.id, message: "Approved. Go ahead with the plan.", approve: value,
          userInitiated: value, approval_rationale: "In scope synthetic test plan.",
        } });
        assert.equal(dispatched, 1, "the host accepted both flags and reached OCA execution");
        const response = result.details?.result ?? result;
        if (planApproval === "ask") {
          assert.equal(response.isError, true);
          assert.match(JSON.stringify(response), /reserved for the user/);
          assert.equal(f.session.pendingPlanApproval, true);
          assert.equal(f.session.currentPermissionMode, "plan");
          assert.equal(f.backend.turns.length, before);
          assert.equal(f.session.autoRespondCount, 2);
        } else {
          assert.equal(response.isError, false);
          await waitUntil(() => f.backend.turns.length > before, "approved implementation turn");
          assert.equal(f.backend.turns.at(-1)?.planMode, false);
          assert.equal(f.session.currentPermissionMode, "bypassPermissions");
          assert.equal(f.session.pendingPlanApproval, false);
          assert.equal(f.session.approvalState, "approved");
          assert.equal(f.session.autoRespondCount, 0, "userInitiated true resets the counter");
        }
      } finally { await f.dispose(); setPluginConfig({}); }
    }
  }
});

it("issue #537: wrapper false/omission remain planning and malformed flags never dispatch", async () => {
  for (const value of [undefined, false, "false"]) {
    const f = await startInteractionFixture("opencode", { permissionMode: "plan", planApproval: "delegate" });
    try {
      f.backend.proposePlan("Plan: make the approved scratch change.");
      await waitUntil(() => f.session.pendingPlanApproval, "pending OpenCode plan");
      const before = f.backend.turns.length;
      f.session.autoRespondCount = 2;
      let dispatched = 0;
      const tool = makeAgentRespondTool();
      const control = await hostControl([{ ...tool, label: "OCA response", execute: async (id, input) => {
        dispatched++;
        return tool.execute(id, input);
      } }]);
      for (const key of ["approve", "userInitiated", "interrupt"]) for (const bad of [null, 1, "TRUE", "false "]) {
        await assert.rejects(control.execute("invalid", { id: "agent_respond", args: {
          ocaSessionId: f.session.id, message: "Approved. Go ahead.", [key]: bad,
        } }), (error: unknown) => {
          assert.ok(error instanceof Error && error.cause instanceof Error);
          assert.match(error.cause.message, /^Invalid arguments for tool/);
          return true;
        });
        assert.equal(dispatched, 0, "invalid representation is rejected by the actual host validator");
        assert.equal(f.session.pendingPlanApproval, true);
        assert.equal(f.backend.turns.length, before);
        assert.equal(f.session.autoRespondCount, 2);
      }
      const flags = value === undefined ? {} : { approve: value, userInitiated: value, interrupt: value };
      const result = await control.execute("feedback", { id: "agent_respond", args: {
        ocaSessionId: f.session.id, message: "Please revise the plan with this feedback.", ...flags,
      } });
      assert.equal((result.details?.result ?? result).isError, false);
      assert.equal(dispatched, 1);
      await waitUntil(() => f.backend.turns.length > before, "planning feedback turn");
      assert.equal(f.backend.turns.at(-1)?.planMode, true);
      assert.equal(f.session.currentPermissionMode, "plan");
      assert.notEqual(f.session.approvalState, "approved");
      assert.equal(f.session.autoRespondCount, 3, "false/omission do not claim user authority");
    } finally { await f.dispose(); setPluginConfig({}); }
  }
});

it("issue #537: the wrapper admits native/string launch flags and preserves killed-session resume/fork decisions", async () => {
  setPluginConfig({ harnesses: { opencode: { defaultModel: "minimax-coding-plan/MiniMax-M3" } } });
  const saved = {
    sessionId: "stable-id", name: "stopped", status: "killed", lifecycle: "terminal", killReason: "shutdown",
    resumable: true, harness: "opencode", harnessSessionId: "backend-thread", backendRef: { kind: "opencode-server", conversationId: "backend-thread" },
    workdir: "/tmp", originSessionKey: TEST_ROUTE.sessionKey,
  };
  let launches: Record<string, unknown>[] = [];
  setSessionManager({
    resolve: (): undefined => undefined, getPersistedSession: () => saved,
    list: (): never[] => [], listPersistedSessions: () => [saved], resolveBackendConversationId: () => "backend-thread",
    launchSession: (config: Record<string, unknown>) => {
      launches.push(config);
      return { id: config.sessionIdOverride ?? "new-id", name: "wrapper-launch" };
    },
  } as unknown as SessionManager);
  try {
    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", sessionKey: TEST_ROUTE.sessionKey,
      messageChannel: "telegram", requesterSenderId: TEST_ROUTE.target, oneShotCliRun: true });
    let dispatched = 0;
    const control = await hostControl([{ ...tool, label: "OCA launch", execute: async (id, input) => {
      dispatched++;
      return tool.execute(id, input);
    } }]);
    for (const key of ["force_new_session", "fork_session"]) for (const bad of [null, 1, "TRUE", "false "]) {
      await assert.rejects(control.execute("invalid", { id: "agent_launch", args: { prompt: "Fresh task", harness: "opencode", [key]: bad } }), (error: unknown) => {
        assert.ok(error instanceof Error && error.cause instanceof Error);
        assert.match(error.cause.message, /^Invalid arguments for tool/);
        return true;
      });
      assert.equal(dispatched, 0);
      assert.equal(launches.length, 0);
    }
    for (const value of [undefined, false, "false", true, "true"]) {
      launches = [];
      const flags = value === undefined ? {} : { force_new_session: value };
      const result = await control.execute("fresh", { id: "agent_launch", args: {
        prompt: "Fresh task", harness: "opencode", permission_mode: "default", worktree_strategy: "off", ...flags,
      } });
      const force = value === true || value === "true";
      assert.equal(launches.length, force ? 1 : 0);
      if (!force) assert.match(JSON.stringify(result), /Resume-first protection/);
      else assert.equal(launches[0].model, "minimax-coding-plan/MiniMax-M3");

      launches = [];
      const forkFlag = value === undefined ? {} : { fork_session: value };
      await control.execute("resume", { id: "agent_launch", args: {
        prompt: "Continue task", harness: "opencode", permission_mode: "default", worktree_strategy: "off",
        resume_session_id: saved.sessionId, ...forkFlag,
      } });
      assert.equal(launches.length, 1);
      assert.equal(launches[0].resumeSessionId, "backend-thread");
      assert.equal(launches[0].forkSession, value === undefined ? undefined : force);
      assert.equal(launches[0].sessionIdOverride, force ? undefined : saved.sessionId);
    }
    assert.equal(dispatched, 10, "every valid boolean/omission passes host validation");
  } finally { setSessionManager(null); setPluginConfig({}); }
});
