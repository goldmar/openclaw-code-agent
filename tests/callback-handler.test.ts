import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCallbackHandler } from "../src/callback-handler";
import { setSessionManager } from "../src/singletons";
import { createStubSession } from "./helpers";

function createCtx(payload: string) {
  const replies: string[] = [];
  let buttonsCleared = 0;
  return {
    ctx: {
      auth: { isAuthorizedSender: true },
      callback: { payload },
      respond: {
        reply: async ({ text }: { text: string }) => { replies.push(text); },
        clearButtons: async () => { buttonsCleared++; },
      },
    },
    replies,
    get buttonsCleared() {
      return buttonsCleared;
    },
  };
}

describe("createCallbackHandler()", () => {
  beforeEach(() => {
    setSessionManager(null);
  });

  it("prompts for freeform reply on reply callbacks", async () => {
    setSessionManager({
      resolve: () => ({ name: "demo-session" }),
      getPersistedSession: () => undefined,
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("reply:sess-1");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.buttonsCleared, 1);
    assert.equal(state.replies[0], "💬 Type your reply for [demo-session] and I'll forward it to the agent.");
  });

  it("approves pending plans through executeRespond", async () => {
    let switchedTo: string | undefined;
    const session = createStubSession({
      pendingPlanApproval: true,
      sendMessage: async () => {},
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });

    setSessionManager({
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("approve:test-id");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(switchedTo, "bypassPermissions");
    assert.match(state.replies[0], /^👍 Message sent to session/);
  });

  it("resolves question-answer callbacks by session and option index", async () => {
    const resolved: Array<{ sessionId: string; optionIndex: number }> = [];
    setSessionManager({
      resolveAskUserQuestion: (sessionId: string, optionIndex: number) => {
        resolved.push({ sessionId, optionIndex });
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("question-answer:sess-42:1");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(resolved, [{ sessionId: "sess-42", optionIndex: 1 }]);
    assert.equal(state.replies[0], "✅ Answer submitted.");
  });
});
