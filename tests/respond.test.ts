import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/session-manager";
import { setPluginConfig } from "../src/config";
import { registerHarness } from "../src/harness";
import { createFakeHarness, createStubSession } from "./helpers";
import { executeRespond } from "../src/actions/respond";

function createStubSessionManager(sessions: Record<string, any> = {}): SessionManager {
  const sm = new SessionManager(5);
  sm.persisted.clear();
  sm.idIndex.clear();
  sm.nameIndex.clear();
  for (const [id, session] of Object.entries(sessions)) {
    (sm as any).sessions.set(id, session);
  }
  (sm as any).notifySession = () => {};
  (sm as any).notifications = {
    dispatch: () => {},
    notifyWorktreeOutcome: () => {},
    dispose: () => {},
  };
  (sm as any).wakeDispatcher = {
    clearRetryTimersForSession: () => {},
    dispose: () => {},
  };
  return sm;
}

beforeEach(() => {
  setPluginConfig({});
});

describe("executeRespond", () => {
  it("returns an error when the session does not exist", async () => {
    const sm = createStubSessionManager();
    const result = await executeRespond(sm, { session: "missing", message: "hello" });
    assert.equal(result.isError, true);
    assert.match(result.text, /not found/);
  });

  it("auto-resumes killed sessions with resumable backend state", async () => {
    const session = createStubSession({
      status: "killed",
      lifecycle: "terminal",
      runtimeState: "stopped",
      isExplicitlyResumable: false,
      killReason: "user",
      harnessSessionId: "harness-idle",
      name: "suspended-session",
    });
    const sm = createStubSessionManager({ "test-id": session });

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "suspended-session", id: "test-id" });
    };

    const result = await executeRespond(sm, { session: "test-id", message: "wake up" });
    assert.equal(result.text, "Auto-resumed session suspended-session [test-id]. Use agent_output to see the response.");
    assert.equal(capturedConfig.resumeSessionId, "harness-idle");
    assert.equal(capturedConfig.sessionIdOverride, "test-id");
  });

  it("preserves routing and harness metadata during explicit resume", async () => {
    const session = createStubSession({
      status: "killed",
      lifecycle: "suspended",
      runtimeState: "stopped",
      isExplicitlyResumable: true,
      killReason: "idle-timeout",
      harnessSessionId: "harness-meta",
      harnessName: "codex",
      originChannel: "telegram|bot|123",
      originThreadId: 42,
      originAgentId: "agent-main",
      originSessionKey: "agent:main:telegram:group:123:topic:42",
      currentPermissionMode: "default",
      codexApprovalPolicy: "on-request",
    });
    const sm = createStubSessionManager({ "test-id": session });

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "resumed", id: "test-id" });
    };

    const result = await executeRespond(sm, { session: "test-id", message: "continue" });
    assert.ok(result.text.includes("Auto-resumed"));
    assert.equal(capturedConfig.harness, "codex");
    assert.equal(capturedConfig.originSessionKey, "agent:main:telegram:group:123:topic:42");
    assert.equal(capturedConfig.originChannel, "telegram|bot|123");
    assert.equal(capturedConfig.originThreadId, 42);
    assert.equal(capturedConfig.originAgentId, "agent-main");
    assert.equal(capturedConfig.permissionMode, "default");
    assert.equal(capturedConfig.codexApprovalPolicy, "on-request");
    assert.equal(capturedConfig.sessionIdOverride, "test-id");
  });

  it("keeps completed sessions closed by default", async () => {
    const session = createStubSession({
      status: "completed",
      lifecycle: "terminal",
      killReason: "done",
      harnessSessionId: "harness-done",
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "continue" });
    assert.equal(result.isError, true);
    assert.match(result.text, /Resume unavailable/);
    assert.match(result.text, /completed/);
  });

  it("returns an explicit auto-resume error when spawn fails", async () => {
    const session = createStubSession({
      status: "killed",
      lifecycle: "suspended",
      runtimeState: "stopped",
      isExplicitlyResumable: true,
      killReason: "idle-timeout",
      harnessSessionId: "harness-err",
    });
    const sm = createStubSessionManager({ "test-id": session });
    sm.spawn = () => { throw new Error("spawn failed"); };

    const result = await executeRespond(sm, { session: "test-id", message: "continue" });
    assert.equal(result.isError, true);
    assert.match(result.text, /Resume unavailable/);
    assert.match(result.text, /missing_backend_state/);
    assert.match(result.text, /spawn failed/);
  });

  it("injects plan-approval context when resuming a suspended plan session with approve=true", async () => {
    const sm = createStubSessionManager();
    sm.persisted.set("harness-plan", {
      sessionId: "dead-plan",
      harnessSessionId: "harness-plan",
      name: "plan-session",
      prompt: "Plan only and stop.",
      workdir: "/tmp",
      status: "killed",
      lifecycle: "suspended",
      resumable: true,
      killReason: "idle-timeout",
      currentPermissionMode: "plan",
      pendingPlanApproval: true,
      costUsd: 0.05,
      harness: "respond-resume-harness",
    } as any);
    sm.idIndex.set("dead-plan", "harness-plan");

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "plan-session", id: "dead-plan" });
    };

    const result = await executeRespond(sm, {
      session: "dead-plan",
      message: "Approved. Go ahead.",
      approve: true,
    });

    assert.ok(result.text.includes("Auto-resumed"));
    assert.equal(capturedConfig.permissionMode, "bypassPermissions");
    assert.match(capturedConfig.prompt, /The user has approved your plan/i);
    assert.equal(capturedConfig.sessionIdOverride, "dead-plan");
  });

  it("auto-resumes a shutdown-killed pending-plan session when approve=true is sent", async () => {
    const sm = createStubSessionManager();
    sm.persisted.set("harness-plan-shutdown", {
      sessionId: "dead-plan-shutdown",
      harnessSessionId: "harness-plan-shutdown",
      name: "plan-session-shutdown",
      prompt: "Plan only and stop.",
      workdir: "/tmp",
      status: "killed",
      lifecycle: "terminal",
      resumable: false,
      killReason: "shutdown",
      currentPermissionMode: "plan",
      pendingPlanApproval: true,
      costUsd: 0.05,
      harness: "respond-resume-harness",
    } as any);
    sm.idIndex.set("dead-plan-shutdown", "harness-plan-shutdown");

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "plan-session-shutdown", id: "dead-plan-shutdown" });
    };

    const result = await executeRespond(sm, {
      session: "dead-plan-shutdown",
      message: "Approved. Go ahead.",
      approve: true,
    });

    assert.ok(result.text.includes("Auto-resumed"));
    assert.equal(capturedConfig.resumeSessionId, "harness-plan-shutdown");
    assert.equal(capturedConfig.permissionMode, "bypassPermissions");
    assert.match(capturedConfig.prompt, /The user has approved your plan/i);
    assert.equal(capturedConfig.sessionIdOverride, "dead-plan-shutdown");
  });

  it("auto-resumes a shutdown-killed pending-plan session for revision feedback too", async () => {
    const sm = createStubSessionManager();
    sm.persisted.set("harness-plan-revise", {
      sessionId: "dead-plan-revise",
      harnessSessionId: "harness-plan-revise",
      name: "plan-session-revise",
      prompt: "Plan only and stop.",
      workdir: "/tmp",
      status: "killed",
      lifecycle: "terminal",
      resumable: false,
      killReason: "shutdown",
      currentPermissionMode: "plan",
      pendingPlanApproval: true,
      costUsd: 0.05,
      harness: "respond-resume-harness",
    } as any);
    sm.idIndex.set("dead-plan-revise", "harness-plan-revise");

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "plan-session-revise", id: "dead-plan-revise" });
    };

    const result = await executeRespond(sm, {
      session: "dead-plan-revise",
      message: "Please revise the plan to avoid touching migrations.",
    });

    assert.ok(result.text.includes("Auto-resumed"));
    assert.equal(capturedConfig.resumeSessionId, "harness-plan-revise");
    assert.equal(capturedConfig.permissionMode, "plan");
    assert.doesNotMatch(capturedConfig.prompt, /The user has approved your plan/i);
    assert.equal(capturedConfig.sessionIdOverride, "dead-plan-revise");
  });

  it("sends messages to active running sessions without auto-resuming", async () => {
    const session = createStubSession({
      status: "running",
      lifecycle: "active",
      sendMessage: async () => {},
    });
    const sm = createStubSessionManager({ "test-id": session });

    const result = await executeRespond(sm, { session: "test-id", message: "hello" });
    assert.equal(result.isError, undefined);
    assert.match(result.text, /Message sent to session/);
  });

  it("handles plan approval for active sessions", async () => {
    let switchedTo: string | undefined;
    const session = createStubSession({
      status: "running",
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      sendMessage: async () => {},
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });
    const sm = createStubSessionManager({ "test-id": session });

    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Approved. Go ahead.",
      approve: true,
    });

    assert.equal(switchedTo, "bypassPermissions");
    assert.equal(result.isError, undefined);
    assert.match(result.text, /Message sent to session/);
  });

  it("blocks approve=true after plan changes were already requested", async () => {
    const session = createStubSession({
      status: "running",
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      approvalState: "changes_requested",
      sendMessage: async () => {
        throw new Error("sendMessage should not be called");
      },
    });
    const sm = createStubSessionManager({ "test-id": session });

    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Approved. Go ahead.",
      approve: true,
    });

    assert.equal(result.isError, true);
    assert.match(result.text, /already requested/i);
  });

  it("enforces the auto-respond safety cap for non-user replies", async () => {
    const session = createStubSession({
      status: "running",
      lifecycle: "active",
      autoRespondCount: 10,
      sendMessage: async () => {},
    });
    const sm = createStubSessionManager({ "test-id": session });

    const result = await executeRespond(sm, {
      session: "test-id",
      message: "auto",
      userInitiated: false,
    });

    assert.match(result.text, /Auto-respond limit reached/);
  });

  it("relaunches fresh when shutdown happened before the harness ever started", async () => {
    const session = createStubSession({
      status: "killed",
      lifecycle: "terminal",
      killReason: "shutdown",
      harnessSessionId: undefined,
      prompt: "original prompt",
      workdir: "/tmp/repo",
      name: "startup-failure",
    });
    const sm = createStubSessionManager({ "test-id": session });

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "startup-failure", id: "test-id", status: "running" });
    };

    const result = await executeRespond(sm, { session: "test-id", message: "continue" });
    assert.match(result.text, /relaunched fresh/i);
    assert.equal(capturedConfig.prompt, "original prompt");
    assert.equal(capturedConfig.sessionIdOverride, "test-id");
  });

  it("returns a typed resume-unavailable reason when backend state is missing", async () => {
    const session = createStubSession({
      status: "killed",
      lifecycle: "terminal",
      killReason: "unknown",
      harnessSessionId: undefined,
      name: "missing-backend",
    });
    const sm = createStubSessionManager({ "test-id": session });

    const result = await executeRespond(sm, { session: "test-id", message: "continue" });
    assert.equal(result.isError, true);
    assert.match(result.text, /Resume unavailable/);
    assert.match(result.text, /missing_backend_state/);
  });

  it("emits only the auto-resume notification when resuming a suspended session", async () => {
    const harness = createFakeHarness("respond-resume-harness");
    registerHarness(harness);

    const session = createStubSession({
      id: "suspended-id",
      status: "killed",
      lifecycle: "suspended",
      runtimeState: "stopped",
      isExplicitlyResumable: true,
      killReason: "idle-timeout",
      harnessSessionId: "harness-resume-only",
      harnessName: "respond-resume-harness",
      name: "resume-only",
      workdir: "/tmp/repo",
      model: "test-model",
    });
    const sm = new SessionManager(5);
    (sm as any).notifications = {
      dispatch: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
      notifyWorktreeOutcome: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
      dispose: () => {},
    };
    (sm as any).wakeDispatcher = { clearRetryTimersForSession: () => {}, dispose: () => {} };
    (sm as any).__dispatchCalls = [];
    (sm as any).sessions.set(session.id, session);

    const pending = executeRespond(sm, { session: session.id, message: "continue" });
    setTimeout(() => {
      harness.pushMessage({ type: "init", session_id: "harness-resume-only" });
    }, 5);
    setTimeout(() => {
      harness.pushMessage({
        type: "result",
        data: {
          success: true,
          duration_ms: 5,
          total_cost_usd: 0,
          num_turns: 1,
          session_id: "harness-resume-only",
        },
      });
      harness.endMessages();
    }, 25);

    const result = await pending;

    assert.ok(result.text.includes("Auto-resumed"));
    assert.equal((sm as any).__dispatchCalls.length, 1);
    const [_resumedSession, request] = (sm as any).__dispatchCalls[0];
    assert.equal(request.label, "notification");
    assert.match(request.userMessage, /▶️ \[resume-only\] Auto-resumed/);
    assert.doesNotMatch(request.userMessage, /Launched/);
  });
});
