import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCallbackHandler } from "../src/callback-handler";
import { setSessionManager } from "../src/singletons";
import { createStubSession } from "./helpers";

function createCtx(payload: string) {
  const replies: string[] = [];
  const editedMessages: string[] = [];
  let buttonsCleared = 0;
  return {
    ctx: {
      auth: { isAuthorizedSender: true },
      callback: { payload },
      respond: {
        reply: async ({ text }: { text: string }) => { replies.push(text); },
        clearButtons: async () => { buttonsCleared++; },
        editMessage: async ({ text }: { text: string }) => { editedMessages.push(text); },
      },
    },
    replies,
    editedMessages,
    get buttonsCleared() {
      return buttonsCleared;
    },
  };
}

describe("createCallbackHandler()", () => {
  beforeEach(() => {
    setSessionManager(null);
  });

  it("surfaces PR URLs through explicit view-pr actions", async () => {
    setSessionManager({
      consumeActionToken: () => ({
        sessionId: "sess-1",
        kind: "worktree-view-pr",
        targetUrl: "https://github.com/example/repo/pull/123",
      }),
      getPersistedSession: () => ({ worktreePrUrl: "https://github.com/example/repo/pull/123" }),
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-1");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.buttonsCleared, 1);
    assert.equal(state.replies[0], "PR: https://github.com/example/repo/pull/123");
  });

  it("approves pending plans through executeRespond", async () => {
    let switchedTo: string | undefined;
    const session = createStubSession({
      pendingPlanApproval: true,
      sendMessage: async () => {},
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });

    setSessionManager({
      consumeActionToken: () => ({ sessionId: "test-id", kind: "plan-approve" }),
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-approve");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(switchedTo, "bypassPermissions");
    assert.match(state.replies[0], /^👍 Message sent to session/);
  });

  it("marks request-changes immediately so stale approvals are blocked", async () => {
    const patches: Array<Record<string, unknown>> = [];
    setSessionManager({
      consumeActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-request-changes",
        planDecisionVersion: 4,
      }),
      resolve: () => createStubSession({
        id: "test-id",
        name: "revise-me",
        pendingPlanApproval: true,
        approvalState: "pending",
        planDecisionVersion: 4,
      }),
      getPersistedSession: () => undefined,
      updatePersistedSession: (_ref: string, patch: Record<string, unknown>) => {
        patches.push(patch);
        return true;
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-revise");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.buttonsCleared, 1);
    assert.match(state.replies[0], /Type your revision feedback/);
    assert.deepEqual(patches[0], {
      approvalState: "changes_requested",
      lifecycle: "awaiting_plan_decision",
      pendingPlanApproval: true,
      planDecisionVersion: 5,
    });
  });

  it("rejects stale plan approval callbacks from an older plan-decision version", async () => {
    setSessionManager({
      consumeActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-approve",
        planDecisionVersion: 2,
      }),
      resolve: () => createStubSession({
        id: "test-id",
        name: "planner",
        pendingPlanApproval: true,
        approvalState: "pending",
        planDecisionVersion: 3,
      }),
      getPersistedSession: () => undefined,
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-stale-approve");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.buttonsCleared, 1);
    assert.match(state.replies[0], /stale/i);
  });

  it("resolves question-answer callbacks by session and option index", async () => {
    const resolved: Array<{ sessionId: string; optionIndex: number }> = [];
    setSessionManager({
      consumeActionToken: () => ({ sessionId: "sess-42", kind: "question-answer", optionIndex: 1 }),
      resolvePendingInputOption: (sessionId: string, optionIndex: number) => {
        resolved.push({ sessionId, optionIndex });
        return true;
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-question");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(resolved, [{ sessionId: "sess-42", optionIndex: 1 }]);
    assert.equal(state.replies[0], "✅ Answer submitted.");
  });

  it("rewrites worktree decision prompts to a resolved state before replying", async () => {
    setSessionManager({
      consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
      resolve: () => undefined,
      getPersistedSession: () => ({ name: "ux-fix" }),
      snoozeWorktreeDecision: () => "⏭️ Reminder snoozed 24h for `agent/ux-fix` (session: ux-fix)",
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-snooze");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(state.editedMessages, ["⏭️ Deferred for [ux-fix]"]);
    assert.equal(state.buttonsCleared, 0);
    assert.equal(state.replies[0], "⏭️ Snoozed 24h");
  });

  it("can be registered for Discord with the same action-token contract", async () => {
    setSessionManager({
      consumeActionToken: () => ({
        sessionId: "sess-discord",
        kind: "worktree-view-pr",
        targetUrl: "https://github.com/example/repo/pull/999",
      }),
      getPersistedSession: () => ({ worktreePrUrl: "https://github.com/example/repo/pull/999" }),
    } as any);

    const handler = createCallbackHandler("discord");
    const state = createCtx("discord-token");
    const result = await handler.handler(state.ctx as any);

    assert.equal(handler.channel, "discord");
    assert.deepEqual(result, { handled: true });
    assert.equal(state.replies[0], "PR: https://github.com/example/repo/pull/999");
  });
});
