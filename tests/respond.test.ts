import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/session-manager";
import { setPluginConfig } from "../src/config";
import { registerHarness, type AgentHarness, type HarnessMessage } from "../src/harness";
import { createFakeHarness, createStubSession } from "./helpers";

import { executeRespond } from "../src/actions/respond";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStubSessionManager(sessions: Record<string, any> = {}): SessionManager {
  const sm = new SessionManager(5);
  sm.persisted.clear();
  sm.idIndex.clear();
  sm.nameIndex.clear();
  for (const [id, session] of Object.entries(sessions)) {
    (sm as any).sessions.set(id, session);
  }
  // Stub notifySession to avoid needing notifications
  (sm as any).notifySession = () => {};
  return sm;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  setPluginConfig({});
});

describe("executeRespond — session not found", () => {
  it("returns error when session does not exist", async () => {
    const sm = createStubSessionManager();
    const result = await executeRespond(sm, { session: "nope", message: "hello" });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("not found"));
  });
});

describe("executeRespond — auto-resume", () => {
  it("auto-resumes a killed session with done reason", async () => {
    let spawnCalled = false;
    const session = createStubSession({
      status: "killed",
      killReason: "done",
      harnessSessionId: "harness-123",
      name: "old-session",
    });
    const sm = createStubSessionManager({ "test-id": session });
    // Override spawn to track the call and return a fake resumed session
    sm.spawn = (config: any) => {
      spawnCalled = true;
      assert.equal(config.resumeSessionId, "harness-123");
      assert.equal(config.multiTurn, true);
      return createStubSession({ name: "old-session", id: "new-id" });
    };
    const result = await executeRespond(sm, { session: "test-id", message: "continue" });
    assert.ok(spawnCalled, "spawn should have been called");
    assert.equal(result.text, "Auto-resumed session old-session [new-id]. Use agent_output to see the response.");
  });

  it("preserves harness and origin routing metadata during auto-resume", async () => {
    const session = createStubSession({
      status: "completed",
      killReason: "done",
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
      return createStubSession({ name: "resumed", id: "new-id" });
    };

    const result = await executeRespond(sm, { session: "test-id", message: "continue" });
    assert.ok(result.text.includes("Auto-resumed"));
    assert.ok(capturedConfig, "spawn config should be captured");
    assert.equal(capturedConfig.harness, "codex");
    assert.equal(capturedConfig.originSessionKey, "agent:main:telegram:group:123:topic:42");
    assert.equal(capturedConfig.originChannel, "telegram|bot|123");
    assert.equal(capturedConfig.originThreadId, 42);
    assert.equal(capturedConfig.originAgentId, "agent-main");
    assert.equal(capturedConfig.permissionMode, "default");
    assert.equal(capturedConfig.codexApprovalPolicy, "on-request");
  });

  it("auto-resumes a completed session with done reason", async () => {
    const session = createStubSession({
      status: "completed",
      killReason: "done",
      harnessSessionId: "harness-456",
    });
    const sm = createStubSessionManager({ "test-id": session });
    sm.spawn = () => createStubSession({ name: "resumed", id: "new-id" });
    const result = await executeRespond(sm, { session: "test-id", message: "more work" });
    assert.equal(result.text, "Auto-resumed session resumed [new-id]. Use agent_output to see the response.");
  });

  it("auto-resumes a failed session regardless of killReason", async () => {
    const session = createStubSession({
      status: "failed",
      killReason: "unknown",
      harnessSessionId: "harness-789",
    });
    const sm = createStubSessionManager({ "test-id": session });
    sm.spawn = () => createStubSession({ name: "resumed", id: "new-id" });
    const result = await executeRespond(sm, { session: "test-id", message: "retry" });
    assert.equal(result.text, "Auto-resumed session resumed [new-id]. Use agent_output to see the response.");
  });

  it("auto-resumes a killed session with user reason", async () => {
    let spawnCalled = false;
    const session = createStubSession({
      status: "killed",
      killReason: "user",
      harnessSessionId: "harness-111",
      name: "user-killed-session",
    });
    const sm = createStubSessionManager({ "test-id": session });
    sm.spawn = (config: any) => {
      spawnCalled = true;
      assert.equal(config.resumeSessionId, "harness-111");
      return createStubSession({ name: "user-killed-session", id: "new-id" });
    };
    const result = await executeRespond(sm, { session: "test-id", message: "continue" });
    assert.ok(spawnCalled, "spawn should have been called");
    assert.equal(result.text, "Auto-resumed session user-killed-session [new-id]. Use agent_output to see the response.");
  });

  it("does NOT auto-resume a killed session with startup-timeout reason", async () => {
    const session = createStubSession({
      status: "killed",
      killReason: "startup-timeout",
      harnessSessionId: "harness-startup",
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "hello" });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("not running"));
  });

  it("does NOT auto-resume when harnessSessionId is missing", async () => {
    const session = createStubSession({
      status: "killed",
      killReason: "done",
      harnessSessionId: undefined,
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "hello" });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("not running"));
  });

  it("returns error when auto-resume spawn throws", async () => {
    const session = createStubSession({
      status: "killed",
      killReason: "done",
      harnessSessionId: "harness-err",
    });
    const sm = createStubSessionManager({ "test-id": session });
    sm.spawn = () => { throw new Error("spawn failed"); };
    const result = await executeRespond(sm, { session: "test-id", message: "continue" });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("Error auto-resuming"));
    assert.ok(result.text.includes("spawn failed"));
  });

  it("auto-resumes a killed session with idle-timeout reason", async () => {
    const session = createStubSession({
      status: "killed",
      killReason: "idle-timeout",
      harnessSessionId: "harness-idle",
    });
    const sm = createStubSessionManager({ "test-id": session });
    sm.spawn = () => createStubSession({ name: "resumed", id: "new-id" });
    const result = await executeRespond(sm, { session: "test-id", message: "wake up" });
    assert.equal(result.text, "Auto-resumed session resumed [new-id]. Use agent_output to see the response.");
  });

  it("emits only the auto-resume notification when agent_respond resumes a completed session", async () => {
    const harness = createFakeHarness("respond-resume-harness");
    registerHarness(harness);

    const session = createStubSession({
      id: "completed-id",
      status: "completed",
      killReason: "done",
      harnessSessionId: "harness-resume-only",
      harnessName: "respond-resume-harness",
      name: "resume-only",
      workdir: "/tmp/repo",
      model: "test-model",
    });
    const sm = new SessionManager(5);
    (sm as any).wakeDispatcher = {
      dispatchSessionNotification: (...args: any[]) => { ((sm as any).__dispatchCalls ??= []).push(args); },
    };
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

    const resumedSession = [...(sm as any).sessions.values()].find((candidate: any) => candidate.id !== session.id);
    if (resumedSession?.status === "running") {
      resumedSession.kill("user");
    }
  });

  it("auto-resumes a shutdown-killed session without exposing the prior terminal label", async () => {
    const session = createStubSession({
      status: "killed",
      killReason: "shutdown",
      harnessSessionId: "harness-shutdown-label",
      name: "shutdown-session",
    });
    const sm = createStubSessionManager({ "test-id": session });
    sm.spawn = () => createStubSession({ name: "shutdown-session", id: "new-id" });
    const result = await executeRespond(sm, { session: "test-id", message: "wake up" });
    assert.equal(result.text, "Auto-resumed session shutdown-session [new-id]. Use agent_output to see the response.");
  });

  it("auto-resumes a persisted shutdown-killed session after restart", async () => {
    const sm = createStubSessionManager();
    sm.persisted.set("harness-shutdown", {
      sessionId: "lWi_9aoa",
      harnessSessionId: "harness-shutdown",
      name: "codex-morning-report-telegram-400",
      prompt: "p",
      workdir: "/tmp/repo",
      model: "gpt-5",
      createdAt: 100,
      completedAt: 200,
      status: "killed",
      killReason: "shutdown",
      costUsd: 0,
      harness: "codex",
    });
    sm.idIndex.set("lWi_9aoa", "harness-shutdown");

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "codex-morning-report-telegram-400", id: "new-id" });
    };

    const result = await executeRespond(sm, { session: "codex-morning-report-telegram-400", message: "continue after restart" });
    assert.ok(result.text.includes("Auto-resumed"));
    assert.equal(capturedConfig.resumeSessionId, undefined);
  });

  it("auto-resumes a persisted restart-recovered session by short internal ID", async () => {
    const sm = createStubSessionManager();
    sm.persisted.set("harness-restart", {
      sessionId: "GccpSIqJ",
      harnessSessionId: "harness-restart",
      name: "persisted-session",
      prompt: "p",
      workdir: "/tmp/repo",
      model: "gpt-5",
      reasoningEffort: "high",
      createdAt: 100,
      status: "killed",
      costUsd: 0,
      originChannel: "telegram|bot|123",
      originThreadId: 42,
      originAgentId: "agent-main",
      originSessionKey: "agent:main:telegram:group:123:topic:42",
      harness: "codex",
      currentPermissionMode: "default",
      codexApprovalPolicy: "on-request",
    });
    sm.idIndex.set("GccpSIqJ", "harness-restart");

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "persisted-session", id: "new-id" });
    };

    const result = await executeRespond(sm, { session: "GccpSIqJ", message: "continue after restart" });
    assert.ok(result.text.includes("Auto-resumed"));
    assert.ok(capturedConfig, "spawn should use persisted session metadata");
    assert.equal(capturedConfig.resumeSessionId, undefined);
    assert.equal(capturedConfig.reasoningEffort, "high");
    assert.equal(capturedConfig.permissionMode, "default");
    assert.equal(capturedConfig.codexApprovalPolicy, "on-request");
    assert.equal(capturedConfig.harness, "codex");
  });

  it("keeps resumeSessionId for in-memory Codex sessions", async () => {
    const session = createStubSession({
      status: "completed",
      killReason: "done",
      harnessSessionId: "harness-live-codex",
      harnessName: "codex",
    });
    const sm = createStubSessionManager({ "test-id": session });

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "resumed", id: "new-id" });
    };

    const result = await executeRespond(sm, { session: "test-id", message: "continue live codex" });
    assert.ok(result.text.includes("Auto-resumed"));
    assert.equal(capturedConfig.resumeSessionId, "harness-live-codex");
  });

  it("auto-resumes a persisted session by name or harness session ID", async () => {
    const persisted = {
      sessionId: "old-id",
      harnessSessionId: "harness-persisted",
      name: "persisted-name",
      prompt: "p",
      workdir: "/tmp",
      createdAt: 100,
      completedAt: 200,
      status: "completed" as const,
      killReason: "done" as const,
      costUsd: 0,
    };

    const smByName = createStubSessionManager();
    smByName.persisted.set("harness-persisted", persisted);
    smByName.spawn = () => createStubSession({ name: "persisted-name", id: "new-id-1" });
    const byName = await executeRespond(smByName, { session: "persisted-name", message: "continue by name" });
    assert.ok(byName.text.includes("Auto-resumed"));

    const smByHarness = createStubSessionManager();
    smByHarness.persisted.set("harness-persisted", persisted);
    smByHarness.spawn = () => createStubSession({ name: "persisted-name", id: "new-id-2" });
    const byHarness = await executeRespond(smByHarness, { session: "harness-persisted", message: "continue by harness" });
    assert.ok(byHarness.text.includes("Auto-resumed"));
  });

  it("auto-resumes a persisted user-killed session after restart", async () => {
    const sm = createStubSessionManager();
    sm.persisted.set("harness-user", {
      sessionId: "old-user",
      harnessSessionId: "harness-user",
      name: "user-killed",
      prompt: "p",
      workdir: "/tmp",
      createdAt: 100,
      completedAt: 200,
      status: "killed",
      killReason: "user",
      costUsd: 0,
    });
    sm.idIndex.set("old-user", "harness-user");

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "user-killed", id: "new-id" });
    };

    const result = await executeRespond(sm, { session: "old-user", message: "continue" });
    assert.equal(result.text, "Auto-resumed session user-killed [new-id]. Use agent_output to see the response.");
    assert.equal(capturedConfig.resumeSessionId, "harness-user");
  });

  it("waits for resume launch confirmation and returns an error when the resumed turn fails before init", async () => {
    const harnessName = "resume-confirm-failure-harness";
    const failingHarness: AgentHarness = {
      name: harnessName,
      supportedPermissionModes: ["default", "plan", "bypassPermissions"],
      questionToolNames: [],
      planApprovalToolNames: [],
      launch() {
        async function* messages(): AsyncGenerator<HarnessMessage> {
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield {
            type: "result",
            data: {
              success: false,
              duration_ms: 5,
              total_cost_usd: 0,
              num_turns: 1,
              session_id: "",
              result: "resume handshake failed",
            },
          };
        }

        return { messages: messages() };
      },
      buildUserMessage(text: string, sessionId: string): unknown {
        return { type: "user", text, session_id: sessionId };
      },
    };
    registerHarness(failingHarness);

    const sourceSession = createStubSession({
      id: "completed-id",
      status: "completed",
      killReason: "done",
      harnessSessionId: "resume-dead-thread",
      harnessName,
      name: "resume-confirm-source",
      workdir: "/tmp/repo",
      model: "test-model",
    });
    const sm = createStubSessionManager({ [sourceSession.id]: sourceSession });
    (sm as any).wakeDispatcher = {
      dispatchSessionNotification: () => {},
    };

    const result = await executeRespond(sm, { session: sourceSession.id, message: "continue" });

    assert.equal(result.isError, true);
    assert.match(result.text, /resume handshake failed/);
    assert.equal(sm.persisted.size, 0, "failed pre-init resume should not persist a running stub");
  });
});

describe("executeRespond — non-running session", () => {
  it("returns error for starting session without auto-resume", async () => {
    const session = createStubSession({ status: "starting" });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "hello" });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("not running"));
    assert.ok(result.text.includes("starting"));
  });
});

describe("executeRespond — auto-respond safety cap", () => {
  it("resets autoRespondCount when userInitiated is true", async () => {
    const session = createStubSession({ autoRespondCount: 5 });
    const sm = createStubSessionManager({ "test-id": session });
    await executeRespond(sm, { session: "test-id", message: "hello", userInitiated: true });
    assert.equal(session.autoRespondCount, 0);
  });

  it("increments autoRespondCount when userInitiated is false", async () => {
    const session = createStubSession({ autoRespondCount: 0 });
    const sm = createStubSessionManager({ "test-id": session });
    await executeRespond(sm, { session: "test-id", message: "hello" });
    assert.equal(session.autoRespondCount, 1);
  });

  it("blocks when autoRespondCount >= maxAutoResponds and userInitiated is false", async () => {
    setPluginConfig({ maxAutoResponds: 3 });
    const session = createStubSession({ autoRespondCount: 3 });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "hello" });
    assert.ok(result.text.includes("Auto-respond limit reached"));
    assert.ok(result.text.includes("3/3"));
  });

  it("allows message when userInitiated resets counter past limit", async () => {
    setPluginConfig({ maxAutoResponds: 3 });
    const session = createStubSession({ autoRespondCount: 5 });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "hello", userInitiated: true });
    assert.ok(!result.isError, "should not be an error");
    assert.ok(result.text.includes("Message sent"));
  });
});

describe("executeRespond — plan approval", () => {
  it("calls switchPermissionMode when approve=true and pendingPlanApproval=true with simple message", async () => {
    let modeSwitched: string | undefined;
    const session = createStubSession({
      pendingPlanApproval: true,
      switchPermissionMode(mode: string) { modeSwitched = mode; },
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "Go ahead", approve: true });
    assert.equal(modeSwitched, "bypassPermissions");
    assert.ok(result.text.includes("Message sent"));
  });

  it("rejects approve+revise when message contains revision keywords", async () => {
    const session = createStubSession({ pendingPlanApproval: true });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, {
      session: "test-id",
      message: "change the database schema",
      approve: true,
    });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("Cannot approve and revise"));
  });

  it("rejects approve+revise when message is long (>= 100 chars)", async () => {
    const session = createStubSession({ pendingPlanApproval: true });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, {
      session: "test-id",
      message: "A".repeat(100),
      approve: true,
    });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("Cannot approve and revise"));
  });

  it("adds approval warning when approve=true but no pending plan", async () => {
    const session = createStubSession({ pendingPlanApproval: false });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Go ahead",
      approve: true,
    });
    assert.ok(result.text.includes("approve=true was set but"));
  });

  it("adds info note when pendingPlanApproval=true but approve not set", async () => {
    const session = createStubSession({ pendingPlanApproval: true });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "feedback here" });
    assert.ok(result.text.includes("sending as revision feedback"));
  });

  it("detects revision keywords case-insensitively", async () => {
    const session = createStubSession({ pendingPlanApproval: true });
    const sm = createStubSessionManager({ "test-id": session });

    for (const msg of ["REPLACE the header", "Don't do X", "Update layout"]) {
      const result = await executeRespond(sm, {
        session: "test-id",
        message: msg,
        approve: true,
      });
      assert.equal(result.isError, true, `Should reject: "${msg}"`);
    }
  });

  it("allows short approval without revision keywords", async () => {
    let modeSwitched = false;
    const session = createStubSession({
      pendingPlanApproval: true,
      switchPermissionMode() { modeSwitched = true; },
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Looks good, proceed!",
      approve: true,
    });
    assert.ok(modeSwitched, "should have switched mode");
    assert.ok(!result.isError, "should succeed");
  });
});

describe("executeRespond — default mode escalation", () => {
  it("calls switchPermissionMode when approve=true and mode is default", async () => {
    let modeSwitched: string | undefined;
    const session = createStubSession({
      pendingPlanApproval: false,
      currentPermissionMode: "default",
      switchPermissionMode(mode: string) { modeSwitched = mode; },
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "Go ahead", approve: true });
    assert.equal(modeSwitched, "bypassPermissions");
    assert.ok(result.text.includes("Message sent"));
  });

  it("no-ops with info when approve=true and mode is already bypassPermissions", async () => {
    let modeSwitched: string | undefined;
    const session = createStubSession({
      pendingPlanApproval: false,
      currentPermissionMode: "bypassPermissions",
      switchPermissionMode(mode: string) { modeSwitched = mode; },
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "Go ahead", approve: true });
    assert.equal(modeSwitched, undefined, "should not switch mode");
    assert.ok(result.text.includes("already in bypassPermissions"));
  });

  it("pendingPlanApproval takes priority over default mode escalation", async () => {
    // Edge case: default + pendingPlanApproval + approve all true.
    // The plan-approval branch fires first, calling switchPermissionMode("bypassPermissions")
    // AND applying validateApprovalMessage. The default mode escalation branch does NOT fire.
    let modeSwitched: string | undefined;
    const session = createStubSession({
      pendingPlanApproval: true,
      currentPermissionMode: "default",
      switchPermissionMode(mode: string) { modeSwitched = mode; },
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Looks good!",
      approve: true,
    });
    // switchPermissionMode was called via the plan approval path
    assert.equal(modeSwitched, "bypassPermissions");
    // No error returned
    assert.ok(!result.isError, "should not return an error");
    // No spurious warning about "no pending plan approval"
    assert.ok(!result.text.includes("approve=true was set but"), "should not warn about no pending plan approval");
  });

  it("still warns when approve=true in plan mode without pendingPlanApproval", async () => {
    const session = createStubSession({
      pendingPlanApproval: false,
      currentPermissionMode: "plan",
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "Go ahead", approve: true });
    assert.ok(result.text.includes("approve=true was set but"));
  });
});


describe("executeRespond — interrupt", () => {
  it("calls session.interrupt() when interrupt=true", async () => {
    let interrupted = false;
    const session = createStubSession({
      interrupt: async () => {
        interrupted = true;
        return true;
      },
    });
    const sm = createStubSessionManager({ "test-id": session });
    await executeRespond(sm, { session: "test-id", message: "stop", interrupt: true });
    assert.ok(interrupted, "interrupt should have been called");
  });

  it("does not call interrupt when interrupt is false", async () => {
    let interrupted = false;
    const session = createStubSession({
      interrupt: async () => {
        interrupted = true;
        return true;
      },
    });
    const sm = createStubSessionManager({ "test-id": session });
    await executeRespond(sm, { session: "test-id", message: "hello", interrupt: false });
    assert.ok(!interrupted, "interrupt should not have been called");
  });

  it("emits a redirected notification when interrupting active work", async () => {
    const notifications: Array<{ text: string; label: string }> = [];
    const session = createStubSession({
      interrupt: async () => true,
    });
    const sm = createStubSessionManager({ "test-id": session });
    (sm as any).notifySession = (_session: any, text: string, label: string) => {
      notifications.push({ text, label });
    };

    const result = await executeRespond(sm, { session: "test-id", message: "redirect", interrupt: true });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.label, "redirected");
    assert.equal(notifications[0]?.text, "↪️ [test-session] Redirected");
    assert.match(result.text, /redirected active turn first/);
  });

  it("does not emit a redirected notification when no active turn is in progress", async () => {
    const notifications: Array<{ text: string; label: string }> = [];
    const session = createStubSession({
      interrupt: async () => false,
    });
    const sm = createStubSessionManager({ "test-id": session });
    (sm as any).notifySession = (_session: any, text: string, label: string) => {
      notifications.push({ text, label });
    };

    const result = await executeRespond(sm, { session: "test-id", message: "redirect", interrupt: true });

    assert.equal(notifications.length, 0);
    assert.match(result.text, /no active turn to interrupt/);
  });
});

describe("executeRespond — error handling", () => {
  it("returns error when sendMessage throws", async () => {
    const session = createStubSession({
      sendMessage: async () => { throw new Error("send failed"); },
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "hello" });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("Error sending message"));
    assert.ok(result.text.includes("send failed"));
  });

  it("returns success text with message summary after successful send", async () => {
    const session = createStubSession();
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "do something important" });
    assert.ok(!result.isError);
    assert.ok(result.text.includes("Message sent"));
    assert.ok(result.text.includes("do something important"));
  });
});

describe("executeRespond — message formatting", () => {
  it("truncates message summary to 80 chars", async () => {
    const longMessage = "x".repeat(200);
    const session = createStubSession();
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: longMessage });
    // The message in the response should be truncated (80 chars + ...)
    assert.ok(result.text.includes("..."));
  });

  it("includes interrupt indicator in response text", async () => {
    const session = createStubSession();
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "stop", interrupt: true });
    assert.ok(result.text.includes("redirected active turn first"));
  });
});

describe("executeRespond — resolve by name", () => {
  it("resolves session by name via sm.resolve()", async () => {
    const session = createStubSession({ name: "my-session", id: "abc" });
    const sm = createStubSessionManager({ abc: session });
    const result = await executeRespond(sm, { session: "my-session", message: "hello" });
    assert.ok(result.text.includes("Message sent"));
    assert.ok(result.text.includes("my-session"));
  });
});
