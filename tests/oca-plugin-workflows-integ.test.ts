import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCallbackHandler } from "../src/callback-handler";
import { setPluginConfig } from "../src/config";
import { SessionManager } from "../src/session-manager";
import { SessionWorktreeMessageService } from "../src/session-worktree-message-service";
import { reconcilePersistedSessionTaskMirror } from "../src/session-task-lifecycle";
import { setPluginRuntime } from "../src/runtime-store";
import { setSessionManager } from "../src/singletons";
import { executeRespond } from "../src/actions/respond";
import { createStubSession } from "./helpers";
import type { PersistedSessionInfo } from "../src/types";

type DispatchCall = [session: Record<string, unknown>, request: Record<string, any>];

function createWorkflowManager(): { sm: SessionManager; calls: DispatchCall[]; cleanup: () => void } {
  const storeDir = mkdtempSync(join(tmpdir(), "oca-plugin-workflows-store-"));
  const sm = new SessionManager(5, 50, {
    store: {
      env: {},
      indexPath: join(storeDir, "sessions.json"),
    },
  });
  const calls: DispatchCall[] = [];
  (sm as any).notifications = {
    dispatch: (...args: DispatchCall) => { calls.push(args); },
    notifyWorktreeOutcome: (...args: DispatchCall) => { calls.push(args); },
    dispose: () => {},
  };
  (sm as any).wakeDispatcher = {
    clearRetryTimersForSession: () => {},
    dispose: () => {},
  };
  return {
    sm,
    calls,
    cleanup: () => {
      sm.dispose();
      rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

function buttonLabels(rows: Array<Array<{ label: string }>> | undefined): string[][] {
  return (rows ?? []).map((row) => row.map((button) => button.label));
}

function makeTelegramCallback(payload: string) {
  const replies: string[] = [];
  const events: string[] = [];
  let buttonMarkupEdits = 0;
  let callbacksAcknowledged = 0;
  const ctx = {
    channel: "telegram",
    accountId: "bot",
    callbackId: "callback-1",
    conversationId: "-100123:topic:42",
    parentConversationId: "-100123",
    senderId: "12345",
    senderUsername: "alice",
    threadId: 42,
    isGroup: true,
    isForum: true,
    auth: { isAuthorizedSender: true },
    callback: {
      data: `code-agent:${payload}`,
      namespace: "code-agent",
      payload,
      messageId: 99,
      chatId: "-100123",
      messageText: "Plan approval",
    },
    respond: {
      acknowledge: async () => {
        callbacksAcknowledged++;
        events.push("acknowledge");
      },
      reply: async ({ text }: { text: string }) => {
        replies.push(text);
        events.push("reply");
      },
      clearButtons: async () => {
        events.push("clearButtons");
      },
      editButtons: async () => {
        buttonMarkupEdits++;
        events.push("editButtons");
      },
      editMessage: async () => {
        events.push("editMessage");
      },
    },
  };
  return {
    ctx,
    replies,
    events,
    get buttonMarkupEdits() {
      return buttonMarkupEdits;
    },
    get callbacksAcknowledged() {
      return callbacksAcknowledged;
    },
  };
}

afterEach(() => {
  setPluginConfig({});
  setPluginRuntime(undefined);
  setSessionManager(null);
});

describe("OCA plugin workflow integration coverage", () => {
  it("drives ask-mode plan approval buttons through callback tokens and rejects stale sibling decisions", async () => {
    const { sm, calls, cleanup } = createWorkflowManager();
    try {
      const sentMessages: string[] = [];
      const notifications: string[] = [];
      const session = createStubSession({
        id: "plan-callback-session",
        name: "plan-callback",
        status: "running",
        lifecycle: "awaiting_plan_decision",
        pendingPlanApproval: true,
        planApproval: "ask",
        planDecisionVersion: 3,
        actionablePlanDecisionVersion: 3,
        approvalState: "pending",
        approvalExecutionState: "awaiting_approval",
        getOutput: () => ["Proposed plan:", "1. Add callback coverage", "2. Verify stale buttons"],
        async sendMessage(text: string) {
          sentMessages.push(text);
        },
        switchPermissionMode(mode: string) {
          session.currentPermissionMode = mode;
          session.pendingPlanApproval = false;
          session.approvalState = "approved";
          session.approvalExecutionState = "approved_then_implemented";
          session.planModeApproved = true;
          session.actionablePlanDecisionVersion = undefined;
        },
        applyControlPatch(patch: Record<string, unknown>) {
          Object.assign(session, patch);
        },
      });
      sm.notifySession = (_session: any, text: string) => {
        notifications.push(text);
      };
      (sm as any).sessions.set(session.id, session);

      await (sm as any).lifecycle.emitWaitingForInput(session);

      assert.equal(calls.length, 1);
      const request = calls[0][1];
      assert.equal(request.label, "plan-approval");
      assert.deepEqual(buttonLabels(request.buttons), [["Approve", "Revise", "Reject"]]);
      assert.match(request.userMessage, /Plan v3 ready for approval/u);
      assert.match(request.userMessage, /Add callback coverage/u);
      assert.match(request.wakeMessageOnNotifySuccess, /do NOT approve or reject this plan yourself/u);

      const approveToken = request.buttons[0][0].callbackData;
      const rejectToken = request.buttons[0][2].callbackData;
      setSessionManager(sm);
      const handler = createCallbackHandler();
      const approval = makeTelegramCallback(approveToken);
      assert.deepEqual(await handler.handler(approval.ctx as any), { handled: true });

      assert.equal(approval.callbacksAcknowledged, 1);
      assert.equal(approval.buttonMarkupEdits, 1);
      assert.deepEqual(sentMessages, ["Approved. Go ahead."]);
      assert.equal(session.currentPermissionMode, "bypassPermissions");
      assert.equal(session.pendingPlanApproval, false);
      assert.equal(session.approvalState, "approved");
      assert.equal(session.approvalExecutionState, "approved_then_implemented");
      assert.equal(session.planModeApproved, true);
      assert.deepEqual(notifications, []);
      assert.equal(typeof sm.getActionToken(approveToken)?.consumedAt, "number");

      const staleReject = makeTelegramCallback(rejectToken);
      assert.deepEqual(await handler.handler(staleReject.ctx as any), { handled: true });
      assert.equal(staleReject.buttonMarkupEdits, 1);
      assert.match(staleReject.replies[0], /no longer awaiting approval|stale|already been used/i);
      assert.equal(session.approvalState, "approved");
    } finally {
      cleanup();
    }
  });

  it("covers revise, reject, and latest revised-plan approval transitions without live Telegram", async () => {
    const { sm, cleanup } = createWorkflowManager();
    try {
      const session = createStubSession({
        id: "plan-text-session",
        name: "plan-text",
        status: "running",
        lifecycle: "awaiting_plan_decision",
        pendingPlanApproval: true,
        planDecisionVersion: 4,
        actionablePlanDecisionVersion: 4,
        approvalState: "pending",
        approvalExecutionState: "awaiting_approval",
      });
      (sm as any).sessions.set(session.id, session);

      const revise = await executeRespond(sm, {
        session: session.id,
        message: "Revise",
        userInitiated: true,
      });
      assert.match(revise.text, /Type your revision feedback/u);
      assert.equal(session.pendingPlanApproval, false);
      assert.equal(session.approvalState, "changes_requested");
      assert.equal(session.lifecycle, "awaiting_user_input");

      const staleApproval = await executeRespond(sm, {
        session: session.id,
        message: "Approved. Go ahead.",
        approve: true,
        userInitiated: true,
      });
      assert.equal(staleApproval.isError, true);
      assert.match(staleApproval.text, /changes were already requested/u);

      session.pendingPlanApproval = true;
      session.lifecycle = "awaiting_plan_decision";
      session.planDecisionVersion = 5;
      session.actionablePlanDecisionVersion = 5;
      session.switchPermissionMode = (mode: string) => {
        session.currentPermissionMode = mode;
        session.pendingPlanApproval = false;
        session.approvalState = "approved";
        session.approvalExecutionState = "approved_then_implemented";
        session.planModeApproved = true;
        session.actionablePlanDecisionVersion = undefined;
      };

      const approved = await executeRespond(sm, {
        session: session.id,
        message: "Approved. Go ahead.",
        approve: true,
        userInitiated: true,
      });
      assert.match(approved.text, /Plan approved/u);
      assert.equal(session.approvalState, "approved");
      assert.equal(session.approvalExecutionState, "approved_then_implemented");

      const rejectSession = createStubSession({
        id: "plan-reject-session",
        name: "plan-reject",
        status: "running",
        lifecycle: "awaiting_plan_decision",
        pendingPlanApproval: true,
        planDecisionVersion: 1,
        actionablePlanDecisionVersion: 1,
        approvalState: "pending",
      });
      let killedReason = "";
      rejectSession.kill = (reason: string) => {
        killedReason = reason;
        rejectSession.status = "killed";
      };
      (sm as any).sessions.set(rejectSession.id, rejectSession);

      const rejected = await executeRespond(sm, {
        session: rejectSession.id,
        message: "Reject",
        userInitiated: true,
      });
      assert.match(rejected.text, /Plan rejected/u);
      assert.equal(rejectSession.pendingPlanApproval, false);
      assert.equal(rejectSession.approvalState, "rejected");
      assert.equal(killedReason, "user");
    } finally {
      cleanup();
    }
  });

  it("routes delegated plan reviews to orchestrator first, then escalates back with canonical user buttons", async () => {
    const { sm, calls, cleanup } = createWorkflowManager();
    try {
      const session = createStubSession({
        id: "delegate-plan-session",
        name: "delegate-plan",
        status: "running",
        lifecycle: "awaiting_plan_decision",
        pendingPlanApproval: true,
        planApproval: "delegate",
        planDecisionVersion: 8,
        actionablePlanDecisionVersion: 8,
        approvalState: "pending",
        getOutput: () => ["Plan preview", "1. Inspect the workflow", "2. Implement tests"],
      });
      (sm as any).sessions.set(session.id, session);

      await (sm as any).lifecycle.emitWaitingForInput(session);
      assert.equal(calls.length, 1);
      const delegatedRequest = calls[0][1];
      assert.equal(delegatedRequest.label, "plan-approval");
      assert.equal(delegatedRequest.notifyUser, "never");
      assert.equal(delegatedRequest.buttons, undefined);
      assert.match(delegatedRequest.wakeMessage, /DELEGATED PLAN APPROVAL/u);
      assert.match(delegatedRequest.wakeMessage, /agent_output\(session='delegate-plan-session', full=true\)/u);
      assert.match(delegatedRequest.wakeMessage, /agent_request_plan_approval/u);
      assert.match(delegatedRequest.wakeMessage, /approval_rationale/u);

      const result = sm.requestPlanApprovalFromUser(
        session.id,
        "Summary:\n- Touches plan approval state\n- Risk: medium\n- Scope matches the user request",
      );
      assert.match(result, /Canonical plan approval prompt sent/u);
      assert.equal(calls.length, 2);
      const userRequest = calls[1][1];
      assert.equal(userRequest.label, "plan-approval");
      assert.deepEqual(buttonLabels(userRequest.buttons), [["Approve", "Revise", "Reject"]]);
      assert.match(userRequest.userMessage, /Plan v8 needs your decision/u);
      assert.match(userRequest.userMessage, /Risk: medium/u);
      assert.doesNotMatch(userRequest.userMessage, /undefined|NaN/u);
    } finally {
      cleanup();
    }
  });

  it("builds worktree ask/delegate notifications with policy-aware buttons and routed source-material rules", () => {
    const { sm, cleanup } = createWorkflowManager();
    try {
      const session = createStubSession({
        id: "worktree-decision-session",
        name: "worktree-decision",
        prompt: "Implement the requested plugin workflow coverage.",
        worktreeStrategy: "delegate",
        worktreePrTargetRepo: "goldmar/openclaw-code-agent",
      });
      (sm as any).sessions.set(session.id, session);
      const diffSummary = {
        commits: 2,
        filesChanged: 4,
        insertions: 120,
        deletions: 8,
        changedFiles: ["src/session-manager.ts", "tests/oca-plugin-workflows-integ.test.ts"],
        commitMessages: [
          { hash: "abc1234", message: "Add workflow coverage", author: "OCA" },
          { hash: "def5678", message: "Tighten notification assertions", author: "OCA" },
        ],
      };
      const buttons = (sm as any).getWorktreeDecisionButtons(session.id, { allowDelegate: true }, {
        merge: true,
        pr: false,
      });
      const ask = new SessionWorktreeMessageService().buildAskNotification({
        session,
        branchName: "agent/workflow-coverage",
        baseBranch: "main",
        diffSummary,
        buttons,
        summaryLines: ["Adds offline workflow coverage", "Keeps PR creation disabled by policy"],
        policyReason: "PR automation unavailable for this repo policy.",
      });

      assert.equal(ask.label, "worktree-merge-ask");
      assert.deepEqual(buttonLabels(ask.buttons), [["Merge", "Later"], ["Discard"]]);
      assert.doesNotMatch(ask.userMessage ?? "", /Open PR|Sync PR/u);
      assert.match(ask.userMessage ?? "", /Commits: 2 \| Files: 4 \| \+120 \/ -8/u);
      assert.match(ask.userMessage ?? "", /PR automation unavailable/u);
      assert.match(ask.wakeMessageOnNotifySuccess ?? "", /do NOT act on this worktree yourself/u);

      const delegated = new SessionWorktreeMessageService().buildDelegateNotification({
        session,
        branchName: "agent/workflow-coverage",
        baseBranch: "main",
        diffSummary,
        allowedActions: { merge: true, pr: false },
        policyReason: "PR automation unavailable for this repo policy.",
        originThreadLine: "Session origin route (authoritative for human follow-ups):\noriginRoute: {\"provider\":\"telegram\",\"target\":\"-100123\",\"threadId\":\"42\"}",
      });
      assert.equal(delegated.notifyUser, "never");
      assert.match(delegated.wakeMessage ?? "", /agent_output\(session='worktree-decision-session', full=true\)/u);
      assert.match(delegated.wakeMessage ?? "", /Never call agent_pr\(\) autonomously in delegate mode/u);
      assert.match(delegated.wakeMessage ?? "", /if it differs from the current chat/u);
      assert.match(delegated.wakeMessage ?? "", /PR automation unavailable/u);
      assert.doesNotMatch(delegated.wakeMessage ?? "", /undefined|NaN/u);
    } finally {
      cleanup();
    }
  });

  it("finalizes TaskFlow mirrors for completed and failed terminal sessions", () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    setPluginRuntime({
      taskFlow: {
        fromToolContext() {
          return {
            setWaiting(params: Record<string, unknown>) {
              calls.push({ method: "setWaiting", params });
              return { applied: true, flow: { flowId: String(params.flowId), revision: 10 } };
            },
            finish(params: Record<string, unknown>) {
              calls.push({ method: "finish", params });
              return { applied: true, flow: { flowId: String(params.flowId), revision: 10, status: "succeeded" } };
            },
            fail(params: Record<string, unknown>) {
              calls.push({ method: "fail", params });
              return { applied: true, flow: { flowId: String(params.flowId), revision: 10, status: "failed" } };
            },
          };
        },
      },
    });

    const base = {
      sessionId: "taskflow-terminal",
      harnessSessionId: "h-taskflow-terminal",
      backendRef: { kind: "codex-app-server", conversationId: "h-taskflow-terminal" },
      name: "taskflow-terminal",
      prompt: "p",
      workdir: "/tmp",
      lifecycle: "terminal",
      runtimeState: "stopped",
      costUsd: 0,
      route: { provider: "telegram", target: "123", sessionKey: "agent:main:telegram:group:123" },
    } satisfies Partial<PersistedSessionInfo>;

    const completedMirror = reconcilePersistedSessionTaskMirror({
      ...base,
      status: "completed",
      killReason: "done",
      taskFlowMirror: { flowId: "flow-complete", revision: 9, status: "running" },
    } as PersistedSessionInfo);
    const failedMirror = reconcilePersistedSessionTaskMirror({
      ...base,
      sessionId: "taskflow-failed",
      harnessSessionId: "h-taskflow-failed",
      status: "failed",
      killReason: "error",
      taskFlowMirror: { flowId: "flow-failed", revision: 9, status: "running" },
    } as PersistedSessionInfo);

    assert.deepEqual(calls.map((call) => call.method), ["finish", "fail"]);
    assert.equal(calls[0].params.flowId, "flow-complete");
    assert.equal(calls[0].params.expectedRevision, 9);
    assert.equal(calls[1].params.flowId, "flow-failed");
    assert.equal(calls[1].params.expectedRevision, 9);
    assert.equal(completedMirror?.revision, 10);
    assert.equal(failedMirror?.revision, 10);
  });
});
