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
    assert.equal(result.text, "Resume started for session suspended-session [test-id]. Use agent_output to see the response.");
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
      requestedPermissionMode: "default",
      currentPermissionMode: "default",
      codexApprovalPolicy: "never",
    });
    const sm = createStubSessionManager({ "test-id": session });

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "resumed", id: "test-id" });
    };

    const result = await executeRespond(sm, { session: "test-id", message: "continue" });
    assert.match(result.text, /Resume started for session/);
    assert.equal(capturedConfig.harness, "codex");
    assert.equal(capturedConfig.originSessionKey, "agent:main:telegram:group:123:topic:42");
    assert.equal(capturedConfig.originChannel, "telegram|bot|123");
    assert.equal(capturedConfig.originThreadId, 42);
    assert.equal(capturedConfig.originAgentId, "agent-main");
    assert.equal(capturedConfig.permissionMode, "default");
    assert.equal(capturedConfig.requestedPermissionMode, "default");
    assert.equal(capturedConfig.codexApprovalPolicy, "never");
    assert.equal(capturedConfig.sessionIdOverride, "test-id");
  });

  it("keeps completed non-Codex sessions closed by default", async () => {
    const session = createStubSession({
      status: "completed",
      lifecycle: "terminal",
      killReason: "done",
      harnessSessionId: "harness-done",
      backendRef: { kind: "claude-code", conversationId: "harness-done" },
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "continue" });
    assert.equal(result.isError, true);
    assert.match(result.text, /Resume unavailable/);
    assert.match(result.text, /completed/);
  });

  it("auto-resumes completed Codex App Server sessions in the common case", async () => {
    const session = createStubSession({
      status: "completed",
      lifecycle: "terminal",
      killReason: "done",
      harnessSessionId: "thread-codex-complete",
      harnessName: "codex",
      backendRef: { kind: "codex-app-server", conversationId: "thread-codex-complete" },
      name: "codex-complete",
    });
    const sm = createStubSessionManager({ "test-id": session });

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "codex-complete", id: "test-id" });
    };

    const result = await executeRespond(sm, { session: "test-id", message: "continue implementation" });
    assert.match(result.text, /Resume started for session/);
    assert.equal(capturedConfig.resumeSessionId, "thread-codex-complete");
    assert.equal(capturedConfig.sessionIdOverride, "test-id");
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
      requestedPermissionMode: "plan",
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

    assert.match(result.text, /Plan approved for session/);
    assert.equal(capturedConfig.permissionMode, "bypassPermissions");
    assert.equal(capturedConfig.requestedPermissionMode, "plan");
    assert.equal(capturedConfig.approvalState, "approved");
    assert.equal(capturedConfig.approvalExecutionState, "approved_then_implemented");
    assert.equal(capturedConfig.planModeApproved, true);
    assert.equal(capturedConfig.pendingPlanApproval, false);
    assert.match(capturedConfig.prompt, /The user has approved your plan/i);
    assert.equal(capturedConfig.sessionIdOverride, "dead-plan");
  });

  it("passes a stable worktree resume ref when approving a stopped delegate worktree plan", async () => {
    const sm = createStubSessionManager();
    sm.persisted.set("019e6c36-1321-7130-a871-7b4303e8ff32", {
      sessionId: "SPhNrL4Q",
      harnessSessionId: "019e6c36-1321-7130-a871-7b4303e8ff32",
      backendRef: {
        kind: "codex-app-server",
        conversationId: "019e6c36-1321-7130-a871-7b4303e8ff32",
        runId: "019e6c43-3db5-7b30-8ccc-720c9979bcbe",
      },
      name: "repair-real-openclaw-dashboard",
      prompt: "Repair dashboard after plan approval.",
      workdir: "/home/openclaw/workspace/openclaw-dashboard",
      worktreePath: "/home/openclaw/workspace/openclaw-dashboard/.worktrees/openclaw-worktree-repair-real-openclaw-dashboard",
      worktreeBranch: "agent/repair-real-openclaw-dashboard",
      worktreeStrategy: "delegate",
      status: "completed",
      lifecycle: "awaiting_plan_decision",
      approvalState: "pending",
      planApproval: "delegate",
      currentPermissionMode: "plan",
      requestedPermissionMode: "plan",
      pendingPlanApproval: true,
      planDecisionVersion: 1,
      actionablePlanDecisionVersion: 1,
      planModeApproved: false,
      costUsd: 0.05,
      harness: "codex",
      route: {
        provider: "telegram",
        target: "12345",
        sessionKey: "agent:main:telegram:group:12345",
      },
    } as any);
    sm.idIndex.set("SPhNrL4Q", "019e6c36-1321-7130-a871-7b4303e8ff32");

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "repair-real-openclaw-dashboard", id: "SPhNrL4Q" });
    };

    const result = await executeRespond(sm, {
      session: "SPhNrL4Q",
      message: "Approved. Go ahead.",
      approve: true,
      approvalRationale: "The plan is in scope.",
    });

    assert.match(result.text, /Plan approved for session/);
    assert.equal(capturedConfig.workdir, "/home/openclaw/workspace/openclaw-dashboard");
    assert.equal(capturedConfig.resumeSessionId, "019e6c36-1321-7130-a871-7b4303e8ff32");
    assert.equal(capturedConfig.resumeWorktreeFrom, "SPhNrL4Q");
    assert.equal(capturedConfig.worktreeStrategy, "delegate");
    assert.equal(capturedConfig.permissionMode, "bypassPermissions");
    assert.equal(capturedConfig.planModeApproved, true);
  });

  it("does not add a worktree resume ref for explicit off approvals", async () => {
    const sm = createStubSessionManager();
    sm.persisted.set("harness-plan-off", {
      sessionId: "dead-plan-off",
      harnessSessionId: "harness-plan-off",
      name: "plan-session-off",
      prompt: "Plan only and stop.",
      workdir: "/tmp/repo",
      status: "killed",
      lifecycle: "suspended",
      resumable: true,
      killReason: "idle-timeout",
      requestedPermissionMode: "plan",
      currentPermissionMode: "plan",
      pendingPlanApproval: true,
      worktreeStrategy: "off",
      costUsd: 0.05,
      harness: "respond-resume-harness",
    } as any);
    sm.idIndex.set("dead-plan-off", "harness-plan-off");

    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "plan-session-off", id: "dead-plan-off" });
    };

    const result = await executeRespond(sm, {
      session: "dead-plan-off",
      message: "Approved. Go ahead.",
      approve: true,
    });

    assert.match(result.text, /Plan approved for session/);
    assert.equal(capturedConfig.worktreeStrategy, "off");
    assert.equal(capturedConfig.resumeWorktreeFrom, undefined);
  });

  it("routes free-text replies into a live native pending-input request", async () => {
    let submittedText: string | undefined;
    let sendMessageCalled = false;
    let interruptCalled = false;
    const session = createStubSession({
      pendingInputState: {
        requestId: "req-1",
        kind: "question",
        promptText: "What should the renamed skill set optimize first?",
        options: ["Clarity first", "Short names"],
        allowsFreeText: true,
      },
      submitPendingInputText: async (text: string) => {
        submittedText = text;
        return true;
      },
      sendMessage: async () => {
        sendMessageCalled = true;
      },
      interrupt: async () => {
        interruptCalled = true;
        return true;
      },
    });
    const sm = createStubSessionManager({ "test-id": session });

    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Optimize first for accurate names and following best practices.",
      userInitiated: true,
      interrupt: true,
    });

    assert.equal(submittedText, "Optimize first for accurate names and following best practices.");
    assert.equal(sendMessageCalled, false);
    assert.equal(interruptCalled, false);
    assert.match(result.text, /Pending input request submitted/);
  });

  it("truthfully reports an answered wizard step while another question remains", async () => {
    const session = createStubSession({
      pendingInputState: {
        requestId: "req-multi", kind: "question", promptText: "First?", options: [],
        allowsFreeText: true, activeQuestionIndex: 0,
        questions: [
          { id: "fast_path_scope", question: "First?", options: [] },
          { id: "think_default", question: "Second?", options: [] },
        ],
      },
      submitPendingInputText: async () => true,
    });
    const result = await executeRespond(createStubSessionManager({ "test-id": session }), {
      session: "test-id", message: "first answer", userInitiated: true,
    });

    assert.match(result.text, /question answered.*more input is required/i);
    assert.match(result.text, /next question is being delivered/i);
    assert.doesNotMatch(result.text, /request submitted/i);
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
      planApproval: "delegate",
      costUsd: 0.05,
      harness: "respond-resume-harness",
    } as any);
    sm.idIndex.set("dead-plan-shutdown", "harness-plan-shutdown");

    const notifications: Array<{ text: string; label?: string; idempotencyKey?: string }> = [];
    let capturedConfig: any;
    sm.spawn = (config: any) => {
      capturedConfig = config;
      return createStubSession({ name: "plan-session-shutdown", id: "dead-plan-shutdown", startedAt: 1_780_000_003_000 });
    };
    (sm as any).notifySession = (_session: any, text: string, label?: string, idempotencyKey?: string) => {
      notifications.push({ text, label, idempotencyKey });
    };

    const result = await executeRespond(sm, {
      session: "dead-plan-shutdown",
      message: "Approved. Go ahead.",
      approve: true,
      approvalRationale: "The plan stays in bounds and only touches low-risk files.",
    });

    assert.match(result.text, /Plan approved for session/);
    assert.equal(capturedConfig.resumeSessionId, "harness-plan-shutdown");
    assert.equal(capturedConfig.permissionMode, "bypassPermissions");
    assert.match(capturedConfig.prompt, /The user has approved your plan/i);
    assert.equal(capturedConfig.sessionIdOverride, "dead-plan-shutdown");
    assert.equal(capturedConfig.approvalRationale, "The plan stays in bounds and only touches low-risk files.");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].label, "plan-approved");
    assert.equal(notifications[0].text, "👍 [plan-session-shutdown] Plan approved (resumed)");
    assert.equal(
      notifications[0].idempotencyKey,
      "agent-respond-plan-approved-resumed:dead-plan-shutdown:1780000003000:harness-plan-shutdown:vunknown",
    );
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

    assert.ok(result.text.includes("Resume started"));
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
      actionablePlanDecisionVersion: 2,
      sendMessage: async () => {},
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });
    const sm = createStubSessionManager({ "test-id": session });

    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Approved. Go ahead.",
      approve: true,
      approvalRationale: "The scope matches the request and the change is low risk.",
    });

    assert.equal(switchedTo, "bypassPermissions");
    assert.equal(result.isError, undefined);
    assert.match(result.text, /Plan approved for session/);
    assert.equal(session.approvalRationale, "The scope matches the request and the change is low risk.");
  });

  it("routes plain-text Approve during pending plan approval through approval handling", async () => {
    let switchedTo: string | undefined;
    let sentMessage: string | undefined;
    const session = createStubSession({
      status: "running",
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      actionablePlanDecisionVersion: 2,
      sendMessage: async (message: string) => {
        sentMessage = message;
      },
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });
    const sm = createStubSessionManager({ "test-id": session });

    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Approve",
      userInitiated: true,
    });

    assert.equal(result.isError, undefined);
    assert.match(result.text, /Plan approved for session/);
    assert.equal(switchedTo, "bypassPermissions");
    assert.equal(sentMessage, "Approved. Go ahead.");
  });

  it("does not route plain-text Approve when lifecycle is not awaiting a plan decision", async () => {
    let switchedTo: string | undefined;
    let sentMessage: string | undefined;
    const session = createStubSession({
      status: "running",
      lifecycle: "active",
      pendingPlanApproval: true,
      actionablePlanDecisionVersion: 2,
      sendMessage: async (message: string) => {
        sentMessage = message;
      },
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });
    const sm = createStubSessionManager({ "test-id": session });

    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Approve",
      userInitiated: true,
    });

    assert.equal(result.isError, undefined);
    assert.match(result.text, /Message sent to session/);
    assert.equal(switchedTo, undefined);
    assert.equal(sentMessage, "Approve");
  });

  it("routes plain-text Revise during pending plan approval to request-changes state", async () => {
    let sentMessage: string | undefined;
    const patches: Array<{ ref: string; patch: Record<string, unknown> }> = [];
    const session = createStubSession({
      status: "running",
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 4,
      actionablePlanDecisionVersion: 4,
      sendMessage: async (message: string) => {
        sentMessage = message;
      },
    });
    const sm = createStubSessionManager({ "test-id": session });
    const reviseToken = (sm as any).interactions.createActionToken("test-id", "plan-request-changes", {
      planDecisionVersion: 4,
    });
    (sm as any).updatePersistedSession = (ref: string, patch: Record<string, unknown>) => {
      patches.push({ ref, patch });
      return true;
    };

    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Revise",
      userInitiated: true,
    });

    assert.equal(result.isError, undefined);
    assert.match(result.text, /Type your revision feedback/);
    assert.equal(sentMessage, undefined);
    assert.equal(session.approvalState, "changes_requested");
    assert.equal(session.pendingPlanApproval, false);
    assert.equal(session.lifecycle, "awaiting_user_input");
    assert.equal(session.actionablePlanDecisionVersion, undefined);
    assert.equal(sm.getActionToken(reviseToken.id), undefined);
    assert.equal(patches[0].patch.approvalState, "changes_requested");
  });

  it("routes plain-text Reject during pending plan approval to terminal rejection", async () => {
    let sentMessage: string | undefined;
    let killed: { id: string; reason: string } | undefined;
    const patches: Array<{ ref: string; patch: Record<string, unknown> }> = [];
    const session = createStubSession({
      status: "running",
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 8,
      actionablePlanDecisionVersion: 8,
      approvalPromptRequiredVersion: 8,
      approvalPromptVersion: 8,
      approvalPromptStatus: "delivered",
      approvalPromptTransport: "direct-message",
      approvalPromptMessageKind: "canonical_buttons",
      sendMessage: async (message: string) => {
        sentMessage = message;
      },
    });
    const sm = createStubSessionManager({ "test-id": session });
    const rejectToken = (sm as any).interactions.createActionToken("test-id", "plan-reject", {
      planDecisionVersion: 8,
    });
    (sm as any).updatePersistedSession = (ref: string, patch: Record<string, unknown>) => {
      patches.push({ ref, patch });
      return true;
    };
    sm.kill = (id: string, reason?: any) => {
      killed = { id, reason };
      session.status = "killed";
      return true;
    };

    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Reject",
      userInitiated: true,
    });

    assert.equal(result.isError, undefined);
    assert.match(result.text, /Plan rejected for \[test-session\]\. Session stopped\./);
    assert.equal(sentMessage, undefined, "Reject must not be forwarded as revision feedback");
    assert.deepEqual(killed, { id: "test-id", reason: "user" });
    assert.equal(session.approvalState, "rejected");
    assert.equal(session.pendingPlanApproval, false);
    assert.equal(session.lifecycle, "terminal");
    assert.equal(session.actionablePlanDecisionVersion, undefined);
    assert.equal(session.approvalPromptStatus, "not_sent");
    assert.equal(sm.getActionToken(rejectToken.id), undefined);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].patch.pendingPlanApproval, false);
    assert.equal(patches[0].patch.approvalState, "rejected");
    assert.equal(patches[0].patch.planDecisionVersion, 9);
  });

  it("does not echo delegated approval as a second push for active sessions", async () => {
    const notifications: Array<{ text: string; label?: string }> = [];
    let switchedTo: string | undefined;
    const session = createStubSession({
      status: "running",
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      actionablePlanDecisionVersion: 2,
      planApproval: "delegate",
      sendMessage: async () => {},
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });
    const sm = createStubSessionManager({ "test-id": session });
    (sm as any).notifySession = (_session: any, text: string, label?: string) => {
      notifications.push({ text, label });
    };

    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Approved. Go ahead.",
      approve: true,
      approvalRationale: "The scope matches the request and the change is low risk.",
    });

    assert.equal(switchedTo, "bypassPermissions");
    assert.equal(result.isError, undefined);
    assert.equal(session.approvalRationale, "The scope matches the request and the change is low risk.");
    assert.equal(notifications.length, 0);
  });

  it("persists active plan approval state without an extra push", async () => {
    const persistedPatches: Array<{ ref: string; patch: Record<string, unknown> }> = [];
    const notifications: Array<{ text: string; label?: string }> = [];
    const session = createStubSession({
      status: "running",
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      approvalState: "pending",
      requestedPermissionMode: "plan",
      currentPermissionMode: "plan",
      planDecisionVersion: 2,
      actionablePlanDecisionVersion: 2,
      planModeApproved: false,
      approvalExecutionState: "awaiting_approval",
      planApproval: "delegate",
      sendMessage: async () => {
        session.lifecycle = "active";
        session.pendingPlanApproval = false;
        session.approvalState = "approved";
        session.currentPermissionMode = "bypassPermissions";
        session.actionablePlanDecisionVersion = undefined;
        session.planModeApproved = true;
        session.approvalExecutionState = "approved_then_implemented";
      },
      switchPermissionMode: () => {},
    });
    const sm = createStubSessionManager({ "test-id": session });
    (sm as any).updatePersistedSession = (ref: string, patch: Record<string, unknown>) => {
      persistedPatches.push({ ref, patch });
      return true;
    };
    (sm as any).notifySession = (_session: any, text: string, label?: string) => {
      notifications.push({ text, label });
    };

    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Approved. Go ahead.",
      approve: true,
      approvalRationale: "The plan matches topic 28 scope.",
    });

    assert.equal(result.isError, undefined);
    assert.equal(persistedPatches.length, 1);
    assert.equal(persistedPatches[0].ref, "test-id");
    assert.equal(persistedPatches[0].patch.approvalState, "approved");
    assert.equal(persistedPatches[0].patch.approvalExecutionState, "approved_then_implemented");
    assert.equal(persistedPatches[0].patch.requestedPermissionMode, "plan");
    assert.equal(persistedPatches[0].patch.currentPermissionMode, "bypassPermissions");
    assert.equal(persistedPatches[0].patch.pendingPlanApproval, false);
    assert.equal(persistedPatches[0].patch.actionablePlanDecisionVersion, undefined);
    assert.equal(persistedPatches[0].patch.planModeApproved, true);
    assert.equal(persistedPatches[0].patch.approvalRationale, "The plan matches topic 28 scope.");
    assert.equal(notifications.length, 0);
  });

  it("does not infer delegated approval rationale from arbitrary message text", async () => {
    const notifications: Array<{ text: string; label?: string }> = [];
    const session = createStubSession({
      status: "running",
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      actionablePlanDecisionVersion: 2,
      planApproval: "delegate",
      sendMessage: async () => {},
      switchPermissionMode: () => {},
    });
    const sm = createStubSessionManager({ "test-id": session });
    (sm as any).notifySession = (_session: any, text: string, label?: string) => {
      notifications.push({ text, label });
    };

    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Approved because the change is straightforward. Go ahead.",
      approve: true,
    });

    assert.equal(result.isError, undefined);
    assert.equal(session.approvalRationale, undefined);
    assert.equal(notifications.length, 0);
  });

  it("allows approve=true for the latest actionable revised plan even if changes were requested previously", async () => {
    const session = createStubSession({
      status: "running",
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      approvalState: "changes_requested",
      planDecisionVersion: 3,
      actionablePlanDecisionVersion: 3,
      sendMessage: async () => {},
      switchPermissionMode: () => {},
    });
    const sm = createStubSessionManager({ "test-id": session });

    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Approved. Go ahead.",
      approve: true,
    });

    assert.equal(result.isError, undefined);
    assert.match(result.text, /Plan approved for session/i);
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

  it("uses only the foreground acknowledgement when auto-resuming a suspended session", async () => {
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
      worktreeStrategy: "off",
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

    assert.ok(result.text.includes("Resume started"));
    assert.equal((sm as any).__dispatchCalls.length, 0);
  });

  it("does not emit a lifecycle resume notification when auto-resume startup fails", async () => {
    const harness = createFakeHarness("respond-resume-failure-harness");
    registerHarness(harness);

    const session = createStubSession({
      id: "resume-failure-id",
      status: "killed",
      lifecycle: "suspended",
      runtimeState: "stopped",
      isExplicitlyResumable: true,
      killReason: "idle-timeout",
      harnessSessionId: "harness-resume-failure",
      harnessName: "respond-resume-failure-harness",
      name: "resume-failure",
      workdir: "/tmp/repo",
      worktreeStrategy: "off",
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
      harness.pushMessage({
        type: "result",
        data: {
          success: false,
          duration_ms: 5,
          total_cost_usd: 0,
          num_turns: 0,
          session_id: "harness-resume-failure",
          result: "backend resume failed before running",
          is_error: true,
        },
      });
      harness.endMessages();
    }, 5);

    const result = await pending;

    assert.equal(result.isError, true);
    assert.match(result.text, /Resume unavailable/);
    assert.match(result.text, /backend resume failed before running/);
    const requests = ((sm as any).__dispatchCalls as any[]).map(([_session, request]) => request);
    assert.equal(requests.some((request) => request.label === "resumed-launch"), false);
    assert.equal(requests.some((request) => /Resumed/.test(request.userMessage ?? "")), false);
  });
});
