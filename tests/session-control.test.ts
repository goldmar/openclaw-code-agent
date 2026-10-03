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
    const sm: any = { resolve: () => ({ name: "s", id: "1", status: "killed" }) };
    assert.equal(getKillSessionText(sm, "s"), "ℹ️ [s] Already stopped; nothing to stop.");
    const stored: any = { resolve: (): undefined => undefined, getPersistedSession: () => ({ name: "p", status: "killed", lifecycle: "terminal" }) };
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
      closeSuspendedSession: (ref: string, completed: boolean) => { closed.push([ref, completed]); return true; },
    };
    assert.equal(getKillSessionText(sm, "s", "killed"), "⛔ [s] Stopped (it was not running).");
    assert.equal(getKillSessionText(sm, "s", "completed"), "ℹ️ [s] Marked as completed (it was not running).");
    assert.deepEqual(closed, [["s", false], ["s", true]]);
    assert.equal(killed, false, "nothing is running: no kill and no stop notice");

    // A session that could not be closed is reported as it is.
    const stuck: any = { resolve: () => session, closeSuspendedSession: () => false };
    assert.equal(getKillSessionText(stuck, "s", "killed"), "ℹ️ [s] Already stopped; nothing to stop.");
  });

  it("words every goal task status for the user", () => {
    assert.deepEqual(
      ["awaiting_verifier_confirmation", "running", "waiting_for_session", "waiting_for_plan_approval", "waiting_for_user", "succeeded", "failed", "stopped"]
        .map((status) => userGoalStatusWord(status as Parameters<typeof userGoalStatusWord>[0])),
      ["waiting for your confirmation", "running", "waiting for the session", "waiting for plan approval", "waiting for your input", "succeeded", "failed", "stopped"],
    );
  });
});
