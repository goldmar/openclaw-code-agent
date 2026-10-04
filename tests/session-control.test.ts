import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getKillSessionText, userGoalStatusWord } from "../src/application/session-control";
import { SessionManager } from "../src/session-manager";
import { registerAgentKillCommand } from "../src/commands/agent-kill";
import { setSessionManager } from "../src/singletons";
import { directTopicCommand, dmCommand, nativeTopicCommand, textTopicCommand } from "./command-contexts";

describe("/agent_kill command", () => {
  const route = { provider: "telegram", accountId: "bot", target: "12345", threadId: "42" };
  function kill(ctx: object): { text: string; session: Record<string, unknown> } {
    const session: Record<string, unknown> = { name: "s", id: "1", status: "running", costUsd: 0.25, duration: 61_000, route };
    setSessionManager({ resolve: () => session, kill: () => {} } as any);
    let handler: ((ctx: Record<string, unknown>) => { text: string }) | undefined;
    registerAgentKillCommand({ registerCommand(command: any) { handler = command.handler; } });
    try {
      return { text: handler!({ args: "s", ...ctx }).text, session };
    } finally {
      setSessionManager(null);
    }
  }

  it("answers with the one stop notice for a text command in the session's topic", () => {
    const { text, session } = kill(textTopicCommand({ chat: "12345", topic: 42, accountId: "bot" }));
    assert.equal(text, "⛔ [s] Stopped by user | $0.25 | 1m1s");
    assert.equal(session.stopNoticeReplaced, true);
  });

  it("answers with the one stop notice when typed in the session's chat", () => {
    const { text, session } = kill(nativeTopicCommand({ chat: "12345", topic: 42, accountId: "bot" }));
    assert.equal(text, "⛔ [s] Stopped by user | $0.25 | 1m1s");
    assert.equal(session.stopNoticeReplaced, true, "the lifecycle notice would repeat the reply");
  });

  it("keeps the stop notice in the session's chat when typed in another chat", () => {
    for (const ctx of [
      nativeTopicCommand({ chat: "12345", topic: 7, accountId: "bot" }),
      nativeTopicCommand({ chat: "99999", topic: 42, accountId: "bot" }),
      nativeTopicCommand({ chat: "12345", topic: 42, accountId: "other-bot" }),
      dmCommand({ chat: "12345", accountId: "bot" }),
      // A `to` the plugin does not understand is never "the same chat".
      { ...nativeTopicCommand({ chat: "12345", topic: 42, accountId: "bot" }), to: "12345" },
      { ...textTopicCommand({ chat: "12345", topic: 42, accountId: "bot" }), messageThreadId: 7 },
      directTopicCommand({ chat: "12345", topic: 42, accountId: "bot" }),
      {},
    ]) {
      const { text, session } = kill(ctx);
      assert.equal(text, "⛔ [s] Stopped.");
      assert.equal("stopNoticeReplaced" in session, false, JSON.stringify(ctx));
    }
  });

  it("answers like the buttons while the service is not running", () => {
    setSessionManager(null);
    let handler: ((ctx: Record<string, unknown>) => { text: string }) | undefined;
    registerAgentKillCommand({ registerCommand(command: any) { handler = command.handler; } });
    assert.equal(handler!({ args: "s" }).text, "⚠️ The code agent is not running right now. Try again in a moment.");
  });
});

describe("session-control app layer", () => {
  it("returns not found text for unknown session", () => {
    const sm: any = { resolve: (): undefined => undefined, getPersistedSession: (): undefined => undefined };
    const text = getKillSessionText(sm, "missing");
    assert.equal(text, '❌ Session "missing" not found.');
  });

  it("dismisses recovered persisted-only sessions instead of reporting not found", () => {
    let patchRef: string | undefined;
    let patch: Record<string, unknown> | undefined;
    const sm: any = {
      resolve: (): undefined => undefined,
      getPersistedSession: () => ({
        sessionId: "s-recovered",
        harnessSessionId: "h-recovered",
        name: "recovered",
        status: "killed",
        lifecycle: "suspended",
      }),
      updatePersistedSession: (ref: string, nextPatch: Record<string, unknown>) => {
        patchRef = ref;
        patch = nextPatch;
        return true;
      },
      closeSuspendedSession: SessionManager.prototype.closeSuspendedSession,
    };

    const text = getKillSessionText(sm, "recovered");

    assert.equal(patchRef, "recovered");
    assert.equal(patch?.status, "killed");
    assert.equal(patch?.lifecycle, "terminal");
    assert.equal(patch?.runtimeState, "stopped");
    assert.equal(patch?.resumable, false);
    assert.equal(patch?.killReason, "user");
    assert.equal(text, "⛔ [recovered] Stopped (it was not running).");
  });

  it("marks recovered persisted-only sessions completed when requested", () => {
    let patch: Record<string, unknown> | undefined;
    const sm: any = {
      resolve: (): undefined => undefined,
      getPersistedSession: () => ({
        sessionId: "s-recovered",
        name: "recovered",
        status: "killed",
        lifecycle: "suspended",
      }),
      updatePersistedSession: (_ref: string, nextPatch: Record<string, unknown>) => {
        patch = nextPatch;
        return true;
      },
      closeSuspendedSession: SessionManager.prototype.closeSuspendedSession,
    };

    const text = getKillSessionText(sm, "recovered", "completed");

    assert.equal(patch?.status, "completed");
    assert.equal(patch?.killReason, "done");
    assert.equal(text, "ℹ️ [recovered] Marked as completed (it was not running).");
  });

  it("marks session completed when requested", () => {
    let completed = false;
    const session = {
      name: "s",
      id: "1",
      status: "running",
      complete: () => { completed = true; },
    };
    const sm: any = { resolve: () => session };
    const text = getKillSessionText(sm, "s", "completed");
    assert.equal(completed, true);
    assert.equal(text, "ℹ️ [s] Marked as completed; the user gets the completion notice (✅ Completed, or the worktree prompt or outcome).");
  });

  it("kills session via SessionManager when reason is killed", () => {
    const session = { name: "s", id: "1", status: "running" };
    let killedId: string | undefined;
    const sm: any = {
      resolve: () => session,
      kill: (id: string) => { killedId = id; },
    };
    const text = getKillSessionText(sm, "s", "killed");
    assert.equal(killedId, "1");
    assert.match(text, /^⛔ \[.+\] Stopped\.$/);
    assert.equal("stopNoticeReplaced" in session, false, "the tool keeps the lifecycle notice");
  });

  it("answers /agent_kill with the one stop notice and suppresses the lifecycle copy", () => {
    const session: Record<string, unknown> = { name: "s", id: "1", status: "running", costUsd: 0.25, duration: 61_000 };
    const sm: any = {
      resolve: () => session,
      kill: () => { assert.equal(session.stopNoticeReplaced, true, "set before the kill emits the terminal event"); },
    };
    const text = getKillSessionText(sm, "s", "killed", { replyIsStopNotice: (target) => target === session });
    assert.equal(text, "⛔ [s] Stopped by user | $0.25 | 1m1s");
  });

  it("keeps the lifecycle stop notice when /agent_kill comes from another chat", () => {
    const session: Record<string, unknown> = { name: "s", id: "1", status: "running", costUsd: 0.25, duration: 61_000 };
    const sm: any = { resolve: () => session, kill: () => {} };
    const text = getKillSessionText(sm, "s", "killed", { replyIsStopNotice: () => false });
    assert.equal(text, "⛔ [s] Stopped.");
    assert.equal("stopNoticeReplaced" in session, false);
  });

  it("says stopped, not killed, for a session that already ended", () => {
    const closeSuspendedSession = SessionManager.prototype.closeSuspendedSession;
    const sm: any = { resolve: () => ({ name: "s", id: "1", status: "killed" }), closeSuspendedSession };
    assert.equal(getKillSessionText(sm, "s"), "ℹ️ [s] Already stopped; nothing to stop.");
    const stored: any = { resolve: (): undefined => undefined, getPersistedSession: () => ({ name: "p", status: "killed", lifecycle: "terminal" }), closeSuspendedSession };
    assert.equal(getKillSessionText(stored, "p"), "ℹ️ [p] Already stopped; nothing to stop.");
    const done: any = { resolve: () => ({ name: "s", id: "1", status: "completed" }) };
    assert.equal(getKillSessionText(done, "s"), "ℹ️ [s] Already completed; nothing to stop.");
  });

  it("closes a suspended session that is still loaded, like a stored one", () => {
    const closed: Array<[string, boolean]> = [];
    const session = { name: "s", id: "1", status: "killed", lifecycle: "suspended" };
    let killed = false;
    const sm: any = {
      resolve: () => session,
      kill: () => { killed = true; },
      closeSuspendedSession: (ref: string, completed: boolean) => { closed.push([ref, completed]); return completed ? "completed" : "killed"; },
    };
    assert.equal(getKillSessionText(sm, "s", "killed"), "⛔ [s] Stopped (it was not running).");
    assert.equal(getKillSessionText(sm, "s", "completed"), "ℹ️ [s] Marked as completed (it was not running).");
    assert.deepEqual(closed, [["s", false], ["s", true]]);
    assert.equal(killed, false, "nothing is running: no kill and no stop notice");

    // A session that could not be closed is reported as it is.
    const stuck: any = { resolve: () => session, closeSuspendedSession: (): undefined => undefined };
    assert.equal(getKillSessionText(stuck, "s", "killed"), "ℹ️ [s] Already stopped; nothing to stop.");

    // Unloaded, but the row could not be updated: the stop is not reported as done.
    const unsaved: any = { resolve: () => session, closeSuspendedSession: () => "unsaved" };
    assert.equal(getKillSessionText(unsaved, "s", "killed"), "❌ [s] Not stopped: the stop could not be saved. Try again.");

    // A session that was never persisted can only be stopped: the reply says what happened.
    const unpersisted: any = { resolve: () => session, closeSuspendedSession: () => "killed" };
    assert.equal(getKillSessionText(unpersisted, "s", "completed"), "⛔ [s] Stopped (it was not running).");

    // Marked completed with an open branch: nothing lands it, and the result says so.
    const branch = { ...session, worktreeBranch: "agent/s", worktreeStrategy: "ask" };
    const withBranch: any = { resolve: () => branch, closeSuspendedSession: () => "completed" };
    assert.equal(
      getKillSessionText(withBranch, "s", "completed"),
      "ℹ️ [s] Marked as completed (it was not running). Its branch `agent/s` is left as it is: no merge, PR or decision prompt follows. Land it with agent_merge or agent_pr, or discard it with agent_worktree_cleanup(session, dismiss_session=true).",
    );
    const goalStops: Array<[string | undefined, string]> = [];
    const goal: any = {
      resolve: () => ({ ...session, goalTaskId: "goal-1" }),
      closeSuspendedSession: (_ref: string, completed: boolean) => (completed ? "completed" : "killed"),
      stopGoalOfClosedSession: (taskId: string | undefined, outcome: string, reply?: { sameChat: (task: unknown) => boolean; text?: string; posted?: boolean }) => {
        goalStops.push([taskId, outcome]);
        // The controller: the notice is the reply in the task's own chat, posted otherwise.
        if (reply) Object.assign(reply, { text: "⛔ [ship-it] Goal task stopped\n\nStopped by user.", posted: !reply.sameChat({ route: undefined }) });
        return "ship-it";
      },
    };
    assert.equal(
      getKillSessionText(goal, "s", "completed"),
      "ℹ️ [s] Marked as completed (it was not running). Its goal task \"ship-it\" is stopped: the session was closed without running, so its verifiers did not run.",
    );
    assert.equal(getKillSessionText(goal, "s", "killed"), "⛔ [s] Stopped (it was not running).");
    assert.deepEqual(goalStops, [["goal-1", "completed"], ["goal-1", "killed"]], "the goal is told how its session was closed");
    // `/agent_kill` typed in the task's own chat: the goal notice is the one message.
    assert.equal(getKillSessionText(goal, "s", "killed", { replyIsStopNotice: () => true }), "⛔ [ship-it] Goal task stopped\n\nStopped by user.");
    // From another chat the notice was posted there, and the reply is the short line.
    assert.equal(getKillSessionText(goal, "s", "killed", { replyIsStopNotice: () => false }), "⛔ [s] Stopped (it was not running).");
    // An unsaved close stops no goal.
    const unsavedGoal: any = { ...goal, closeSuspendedSession: () => "unsaved", stopGoalOfClosedSession: () => { throw new Error("must not stop the goal"); } };
    assert.match(getKillSessionText(unsavedGoal, "s", "killed"), /^❌ \[s\] Not stopped/);
    const merged: any = { resolve: () => ({ ...branch, worktreeMerged: true }), closeSuspendedSession: () => "completed" };
    assert.equal(getKillSessionText(merged, "s", "completed"), "ℹ️ [s] Marked as completed (it was not running).");
  });

  it("rejects a plan that still waits when a suspended session is closed, loaded or stored", () => {
    const pendingPlan = { status: "killed", lifecycle: "awaiting_plan_decision", pendingPlanApproval: true, approvalState: "pending", planDecisionVersion: 2, actionablePlanDecisionVersion: 2 };
    // Stored only.
    const cleared: string[] = [];
    let patch: Record<string, unknown> | undefined;
    const stored: any = {
      resolve: (): undefined => undefined,
      getPersistedSession: () => ({ sessionId: "s-plan", name: "plan", ...pendingPlan }),
      clearPlanDecisionTokens: (ref: string) => { cleared.push(ref); },
      updatePersistedSession: (_ref: string, next: Record<string, unknown>) => { patch = next; return true; },
      closeSuspendedSession: SessionManager.prototype.closeSuspendedSession,
    };
    assert.equal(getKillSessionText(stored, "plan", "killed"), "⛔ [plan] Stopped (it was not running).");
    assert.deepEqual(cleared, ["s-plan"], "the Approve / Revise / Reject buttons are retired");
    assert.equal(patch?.pendingPlanApproval, false);
    assert.equal(patch?.approvalState, "rejected");
    assert.equal(patch?.planDecisionVersion, 3);
    assert.equal("actionablePlanDecisionVersion" in patch! && patch!.actionablePlanDecisionVersion, undefined);
    assert.equal(patch?.lifecycle, "terminal");
    assert.equal(patch?.status, "killed");
    assert.equal(patch?.resumable, false);

    // A session the user stopped (its plan was rejected then) is not dormant: nothing is closed again.
    const stopped: any = {
      resolve: (): undefined => undefined,
      getPersistedSession: () => ({ sessionId: "s-stopped", name: "stopped", status: "killed", lifecycle: "terminal" }),
      updatePersistedSession: () => { throw new Error("must not patch a stopped session"); },
      closeSuspendedSession: SessionManager.prototype.closeSuspendedSession,
    };
    assert.equal(getKillSessionText(stopped, "stopped", "killed"), "ℹ️ [stopped] Already stopped; nothing to stop.");
  });

  it("stops a running goal session through its goal task: one stop message", () => {
    const session: Record<string, unknown> = { name: "s", id: "1", status: "running", goalTaskId: "goal-1", costUsd: 0, duration: 1_000 };
    let killed = false;
    const sm: any = {
      resolve: () => session,
      kill: () => { killed = true; },
      stopGoalOfRunningSession: (_taskId: string, reply?: { sameChat: (task: unknown) => boolean; text?: string; posted?: boolean }) => {
        if (reply) Object.assign(reply, { text: "⛔ [ship-it] Goal task stopped | $0.10 | 5s\n\nStopped by user.", posted: !reply.sameChat({}) });
        return true;
      },
    };
    // In the task's own chat the goal notice is the reply; nothing else is sent.
    assert.equal(getKillSessionText(sm, "s", "killed", { replyIsStopNotice: () => true }), "⛔ [ship-it] Goal task stopped | $0.10 | 5s\n\nStopped by user.");
    // From another chat, and for the tool: the short line; the goal notice is in the task's chat.
    assert.equal(getKillSessionText(sm, "s", "killed", { replyIsStopNotice: () => false }), "⛔ [s] Stopped.");
    assert.equal(getKillSessionText(sm, "s", "killed"), "⛔ [s] Stopped.");
    assert.equal(killed, false, "the goal controller stops its session itself");
    assert.equal("stopNoticeReplaced" in session, false);

    // No active goal task owns the session: it is stopped directly, as before.
    const orphan: any = { resolve: () => session, kill: () => { killed = true; }, stopGoalOfRunningSession: () => false };
    assert.equal(getKillSessionText(orphan, "s", "killed", { replyIsStopNotice: () => true }), "⛔ [s] Stopped by user | $0.00 | 1s");
    assert.equal(killed, true);
  });

  it("words every goal task status for the user", () => {
    assert.deepEqual(
      ["awaiting_verifier_confirmation", "running", "waiting_for_session", "waiting_for_plan_approval", "waiting_for_user", "succeeded", "failed", "stopped"]
        .map((status) => userGoalStatusWord(status as Parameters<typeof userGoalStatusWord>[0])),
      ["waiting for your confirmation", "running", "waiting for the session", "waiting for plan approval", "waiting for your input", "succeeded", "failed", "stopped"],
    );
  });
});
