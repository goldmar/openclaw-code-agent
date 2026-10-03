import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerAgentRespondCommand } from "../src/commands/agent-respond";
import { SessionManager } from "../src/session-manager";
import { setSessionManager } from "../src/singletons";
import { createStubSession } from "./helpers";

type AgentRespondCommandHandler = (ctx: Record<string, unknown>) => Promise<{ text: string }>;

/** The chat of `createStubSession`'s route, and another topic of the same group. */
const SESSION_CHAT = { deliveryContext: { channel: "telegram", to: "12345", accountId: "bot", threadId: 42 } };
const OTHER_CHAT = { deliveryContext: { channel: "telegram", to: "12345", accountId: "bot", threadId: 7 } };

/** A real SessionManager with one session and recorded user notices. */
function managerWith(session: Record<string, unknown>): { sm: SessionManager; notices: string[] } {
  const sm = new SessionManager(5);
  (sm as any).store.persisted.clear();
  (sm as any).store.idIndex.clear();
  (sm as any).store.nameIndex.clear();
  (sm as any).sessions.set(session.id, session);
  const notices: string[] = [];
  (sm as any).notifySession = (_session: unknown, text: string) => { notices.push(text); };
  (sm as any).wakeDispatcher = { clearRetryTimersForSession: () => {}, dispose: () => {} };
  setSessionManager(sm);
  return { sm, notices };
}

function suspendedSession(): Record<string, unknown> {
  return createStubSession({
    status: "killed",
    lifecycle: "terminal",
    runtimeState: "stopped",
    killReason: "user",
    harnessSessionId: "harness-idle",
    backendRef: { kind: "claude-code", conversationId: "harness-idle" },
    name: "suspended-session",
  });
}

function captureAgentRespondCommand(): AgentRespondCommandHandler {
  let handler: AgentRespondCommandHandler | undefined;
  registerAgentRespondCommand({
    registerCommand(command: { handler: AgentRespondCommandHandler }) {
      handler = command.handler;
    },
  });
  assert.ok(handler, "expected /agent_respond handler");
  return handler;
}

describe("agent_respond command", () => {
  afterEach(() => {
    setSessionManager(null);
  });

  it("supports quoted session names and preserves the follow-up message text", async () => {
    let sentMessage: string | undefined;
    setSessionManager({
      resolve(ref: string) {
        if (ref !== "agent command") return undefined;
        return {
          id: "sess-1",
          name: "agent command",
          status: "running",
          lifecycle: "active",
          currentPermissionMode: "default",
          pendingPlanApproval: false,
          autoRespondCount: 0,
          resetAutoRespond() {},
          async interrupt() { return false; },
          async sendMessage(message: string) {
            sentMessage = message;
          },
        };
      },
      getPersistedSession: (): undefined => undefined,
      notifySession: () => {},
    } as any);

    const handler = captureAgentRespondCommand();
    const result = await handler({ args: '"agent command" continue  with   spacing' });

    // The user-facing form: no session id, no tool hint.
    assert.equal(result.text, "💬 [agent command] Message sent.");
    assert.equal(sentMessage, "continue  with   spacing");
  });

  it("answers a resume typed in the session's chat with the one Resumed line", async () => {
    const { sm, notices } = managerWith(suspendedSession());
    sm.launchSession = (() => createStubSession({ name: "suspended-session", id: "test-id", resumeSessionId: "harness-idle" })) as any;

    const result = await captureAgentRespondCommand()({ args: "test-id wake up", ...SESSION_CHAT });

    assert.match(result.text, /^▶️ \[suspended-session\] Resumed \| /);
    assert.doesNotMatch(result.text, /agent_output|test-id/);
    assert.deepEqual(notices, [], "the reply replaces the notice in the same chat");
  });

  it("keeps the Resumed notice in the session's chat when the command comes from another chat", async () => {
    const { sm, notices } = managerWith(suspendedSession());
    sm.launchSession = (() => createStubSession({ name: "suspended-session", id: "test-id", resumeSessionId: "harness-idle" })) as any;

    const result = await captureAgentRespondCommand()({ args: "test-id wake up", ...OTHER_CHAT });

    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /^▶️ \[suspended-session\] Resumed \| /);
    assert.equal(result.text, notices[0]);
  });

  it("does not treat a command without a chat as the session's chat", async () => {
    const { sm, notices } = managerWith(suspendedSession());
    sm.launchSession = (() => createStubSession({ name: "suspended-session", id: "test-id", resumeSessionId: "harness-idle" })) as any;

    await captureAgentRespondCommand()({ args: "test-id wake up" });

    assert.equal(notices.length, 1);
  });

  it("rejects a plan with one message in the session's chat and keeps the stop notice elsewhere", async () => {
    for (const [chat, replaced] of [[SESSION_CHAT, true], [OTHER_CHAT, undefined]] as const) {
      const session = createStubSession({
        lifecycle: "awaiting_plan_decision",
        pendingPlanApproval: true,
        planDecisionVersion: 2,
        actionablePlanDecisionVersion: 2,
        costUsd: 0.25,
        duration: 61_000,
      });
      const { sm } = managerWith(session);
      (sm as any).updatePersistedSession = () => true;
      sm.kill = (() => { session.status = "killed"; return true; }) as any;

      const result = await captureAgentRespondCommand()({ args: "test-id reject", ...chat });

      assert.match(result.text, replaced
        ? /^⛔ \[test-session\] Plan rejected\. Session stopped\. \| \$0\.25 \| 1m1s/
        : /^⛔ \[test-session\] Plan rejected\. Session stopped\.$/);
      // `stopNoticeReplaced` suppresses the lifecycle `⛔ Stopped by user` line.
      assert.equal(session.stopNoticeReplaced, replaced);
    }
  });

  it("asks for the revision text, and reports errors without ids or tool syntax", async () => {
    const waiting = createStubSession({
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      planDecisionVersion: 2,
      actionablePlanDecisionVersion: 2,
    });
    const revise = managerWith(waiting);
    (revise.sm as any).updatePersistedSession = () => true;
    (revise.sm as any).queueOrchestratorContext = () => true;
    assert.equal(
      (await captureAgentRespondCommand()({ args: "test-id revise", ...SESSION_CHAT })).text,
      "✏️ [test-session] Reply with the changes you want; they go to the agent.",
    );

    managerWith(createStubSession({ status: "completed", lifecycle: "terminal", killReason: "done", backendRef: undefined }));
    assert.equal(
      (await captureAgentRespondCommand()({ args: "test-id continue", ...SESSION_CHAT })).text,
      "❌ [test-session] Cannot resume: the session is closed. Start a new one.",
    );

    assert.equal(
      (await captureAgentRespondCommand()({ args: "missing hello", ...SESSION_CHAT })).text,
      '❌ Session "missing" not found.',
    );
  });
});
