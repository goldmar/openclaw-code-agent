import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCallbackHandler } from "../src/callback-handler";
import { SessionActionTokenStore } from "../src/session-action-token-store";
import { setSessionManager } from "../src/singletons";
import { createStubSession } from "./helpers";

const TELEGRAM_FORUM_TARGET = "-1001234567890";
const TELEGRAM_FORUM_THREAD_ID = "42";
const TELEGRAM_FORUM_SESSION_KEY = `agent:main:telegram:group:${TELEGRAM_FORUM_TARGET}:topic:${TELEGRAM_FORUM_THREAD_ID}`;

function createCtx(
  payload: string,
  channel: "telegram" | "discord" = "telegram",
  options: {
    telegramCallback?: Record<string, unknown>;
    authorized?: boolean;
  } = {},
) {
  const replies: string[] = [];
  const replyButtons: unknown[] = [];
  const editedMessages: string[] = [];
  const events: string[] = [];
  let callbacksAcknowledged = 0;
  let buttonsCleared = 0;
  let buttonMarkupEdits = 0;
  let componentsCleared = 0;
  const ctx = channel === "telegram"
    ? {
        channel,
        accountId: "default",
        callbackId: "callback-1",
        conversationId: `${TELEGRAM_FORUM_TARGET}:topic:${TELEGRAM_FORUM_THREAD_ID}`,
        parentConversationId: TELEGRAM_FORUM_TARGET,
        senderId: "12345",
        senderUsername: "alice",
        threadId: Number(TELEGRAM_FORUM_THREAD_ID),
        isGroup: true,
        isForum: true,
        auth: { isAuthorizedSender: options.authorized ?? true },
        callback: {
          data: `code-agent:${payload}`,
          namespace: "code-agent",
          payload,
          messageId: 99,
          chatId: TELEGRAM_FORUM_TARGET,
          messageText: "Release monitor plan offer",
          ...options.telegramCallback,
        },
        respond: {
          acknowledge: async () => { callbacksAcknowledged++; events.push("acknowledge"); },
          reply: async ({ text, buttons }: { text: string; buttons?: unknown[] }) => {
            replies.push(text);
            if (buttons) replyButtons.push(buttons);
            events.push("reply");
          },
          clearButtons: async () => { buttonsCleared++; events.push("clearButtons"); },
          editButtons: async () => { buttonMarkupEdits++; events.push("editButtons"); },
          editMessage: async ({ text }: { text: string }) => { editedMessages.push(text); events.push("editMessage"); },
        },
      }
    : {
        channel,
        auth: { isAuthorizedSender: options.authorized ?? true },
        interaction: { payload },
        respond: {
          acknowledge: async () => { callbacksAcknowledged++; events.push("acknowledge"); },
          reply: async ({ text }: { text: string }) => { replies.push(text); events.push("reply"); },
          followUp: async ({ text }: { text: string }) => { replies.push(text); events.push("followUp"); },
          editMessage: async ({ text }: { text?: string }) => {
            if (typeof text === "string") editedMessages.push(text);
            events.push("editMessage");
          },
          clearComponents: async ({ text }: { text?: string } = {}) => {
            componentsCleared++;
            if (typeof text === "string") editedMessages.push(text);
            events.push("clearComponents");
          },
        },
      };
  return {
    ctx,
    replies,
    replyButtons,
    editedMessages,
    get buttonsCleared() {
      return buttonsCleared;
    },
    get callbacksAcknowledged() {
      return callbacksAcknowledged;
    },
    get buttonMarkupEdits() {
      return buttonMarkupEdits;
    },
    get componentsCleared() {
      return componentsCleared;
    },
    events,
  };
}

function createToolResult(text: string, success: boolean) {
  return {
    content: [{ type: "text", text }],
    meta: { success },
  };
}

describe("createCallbackHandler()", () => {
  beforeEach(() => {
    setSessionManager(null);
  });

  afterEach(() => {
    delete process.env.OPENCLAW_CODE_AGENT_BUTTON_DIAGNOSTICS;
  });

  it("surfaces PR URLs through explicit view-pr actions", async () => {
    setSessionManager({
      getActionToken: () => ({
        sessionId: "sess-1",
        kind: "worktree-view-pr",
        targetUrl: "https://github.com/example/repo/pull/123",
      }),
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

  it("emits callback diagnostics without logging full token payloads", async (t) => {
    process.env.OPENCLAW_CODE_AGENT_BUTTON_DIAGNOSTICS = "1";
    const logs: string[] = [];
    t.mock.method(console, "info", ((message?: unknown) => {
      logs.push(String(message));
    }) as typeof console.info);
    setSessionManager({
      getActionToken: () => ({
        sessionId: "sess-1",
        kind: "plan-reject",
        planDecisionVersion: 7,
      }),
      consumeActionToken: () => ({
        sessionId: "sess-1",
        kind: "plan-reject",
        planDecisionVersion: 7,
      }),
      resolve: () => ({
        id: "sess-1",
        name: "diagnostic-session",
        pendingPlanApproval: true,
        planDecisionVersion: 7,
        actionablePlanDecisionVersion: 7,
      }),
      clearPlanDecisionTokens: () => {},
      kill: () => true,
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("code-agent:secret-callback-token");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    const joined = logs.join("\n");
    assert.match(joined, /"event":"callback_handler_registered"/);
    assert.match(joined, /"event":"callback_received"/);
    assert.match(joined, /"event":"callback_token_lookup_completed"/);
    assert.match(joined, /"event":"callback_token_consume_completed"/);
    assert.match(joined, /"tokenHash":"[a-f0-9]{12}"/);
    assert.doesNotMatch(joined, /secret-callback-token/);
  });

  it("approves pending plans through executeRespond", async () => {
    let switchedTo: string | undefined;
    const session = createStubSession({
      pendingPlanApproval: true,
      actionablePlanDecisionVersion: 1,
      sendMessage: async () => {},
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });

    setSessionManager({
      getActionToken: () => ({ sessionId: "test-id", kind: "plan-approve" }),
      consumeActionToken: () => ({ sessionId: "test-id", kind: "plan-approve" }),
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
      clearPlanDecisionTokens: () => {},
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-approve");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.callbacksAcknowledged, 1);
    assert.deepEqual(state.events.slice(0, 3), ["acknowledge", "editButtons", "clearButtons"]);
    assert.equal(switchedTo, "bypassPermissions");
    assert.deepEqual(state.replies, []);
  });

  it("acknowledges and clears Telegram plan approval buttons before agent work", async () => {
    const events: string[] = [];
    const session = createStubSession({
      pendingPlanApproval: true,
      actionablePlanDecisionVersion: 1,
      sendMessage: async () => { events.push("sendMessage"); },
      switchPermissionMode: () => { events.push("switchPermissionMode"); },
    });

    setSessionManager({
      getActionToken: () => {
        events.push("getActionToken");
        return { sessionId: "test-id", kind: "plan-approve" };
      },
      consumeActionToken: () => {
        events.push("consumeActionToken");
        return { sessionId: "test-id", kind: "plan-approve" };
      },
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => { events.push("notifySession"); },
      clearPlanDecisionTokens: () => { events.push("clearPlanDecisionTokens"); },
    } as any);

    const replies: string[] = [];
    const ctx = {
      channel: "telegram" as const,
      auth: { isAuthorizedSender: true },
      callback: { payload: "token-approve" },
      respond: {
        acknowledge: async () => { events.push("acknowledge"); },
        clearButtons: async () => { events.push("clearButtons"); },
        reply: async ({ text }: { text: string }) => { replies.push(text); events.push("reply"); },
      },
    };

    const handler = createCallbackHandler();
    const result = await handler.handler(ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(events.slice(0, 2), ["acknowledge", "getActionToken"]);
    assert.ok(events.indexOf("clearButtons") < events.indexOf("switchPermissionMode"));
    assert.ok(events.indexOf("clearButtons") < events.indexOf("sendMessage"));
    assert.ok(events.indexOf("sendMessage") < events.indexOf("consumeActionToken"));
    assert.deepEqual(replies, []);
  });

  it("markup-clears Telegram plan approval buttons before blocking approval work finishes", async () => {
    let releaseSend: (() => void) | undefined;
    const sendMayFinish = new Promise<void>((resolve) => { releaseSend = resolve; });
    let sendStarted: (() => void) | undefined;
    const sendHasStarted = new Promise<void>((resolve) => { sendStarted = resolve; });
    const session = createStubSession({
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 1,
      actionablePlanDecisionVersion: 1,
      sendMessage: async () => {
        sendStarted?.();
        await sendMayFinish;
      },
      switchPermissionMode: () => {},
    });

    setSessionManager({
      getActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-approve",
        planDecisionVersion: 1,
      }),
      consumeActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-approve",
        planDecisionVersion: 1,
      }),
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
      clearPlanDecisionTokens: () => {},
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-approve");
    const resultPromise = handler.handler(state.ctx as any);
    await sendHasStarted;

    assert.deepEqual(state.events.slice(0, 3), ["acknowledge", "editButtons", "clearButtons"]);
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.deepEqual(state.replies, []);

    releaseSend?.();
    assert.deepEqual(await resultPromise, { handled: true });
  });

  it("consumes v2026.5.28 Telegram callback data when payload is absent", async () => {
    let switchedTo: string | undefined;
    let consumed = 0;
    const session = createStubSession({
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 7,
      actionablePlanDecisionVersion: 7,
      sendMessage: async () => {},
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });

    setSessionManager({
      getActionToken: (tokenId: string) => {
        assert.equal(tokenId, "2d1bab1c-ce69-4bdb-ae5c-782504ec686e");
        return {
          sessionId: "test-id",
          kind: "plan-approve",
          planDecisionVersion: 7,
        };
      },
      consumeActionToken: (tokenId: string) => {
        consumed++;
        assert.equal(tokenId, "2d1bab1c-ce69-4bdb-ae5c-782504ec686e");
        return {
          sessionId: "test-id",
          kind: "plan-approve",
          planDecisionVersion: 7,
        };
      },
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
      clearPlanDecisionTokens: () => {},
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("unused", "telegram", {
      telegramCallback: {
        data: "code-agent:2d1bab1c-ce69-4bdb-ae5c-782504ec686e",
        payload: undefined,
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(consumed, 1);
    assert.equal(switchedTo, "bypassPermissions");
    assert.equal(state.callbacksAcknowledged, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.deepEqual(state.replies, []);
  });

  it("prefers namespaced Telegram callback data over conflicting payload text", async () => {
    let switchedTo: string | undefined;
    let consumed = 0;
    const session = createStubSession({
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 7,
      actionablePlanDecisionVersion: 7,
      sendMessage: async () => {},
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });

    setSessionManager({
      getActionToken: (tokenId: string) => {
        assert.equal(tokenId, "native-token");
        return {
          sessionId: "test-id",
          kind: "plan-approve",
          planDecisionVersion: 7,
        };
      },
      consumeActionToken: (tokenId: string) => {
        consumed++;
        assert.equal(tokenId, "native-token");
        return {
          sessionId: "test-id",
          kind: "plan-approve",
          planDecisionVersion: 7,
        };
      },
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
      clearPlanDecisionTokens: () => {},
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("derived-stale-token", "telegram", {
      telegramCallback: {
        data: "code-agent:native-token",
        payload: "derived-stale-token",
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(consumed, 1);
    assert.equal(switchedTo, "bypassPermissions");
    assert.equal(state.buttonsCleared, 1);
    assert.deepEqual(state.replies, []);
  });

  it("consumes native Telegram callback_data when payload and data aliases are absent", async () => {
    let switchedTo: string | undefined;
    let consumed = 0;
    const session = createStubSession({
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 1,
      actionablePlanDecisionVersion: 1,
      sendMessage: async () => {},
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });

    setSessionManager({
      getActionToken: (tokenId: string) => {
        assert.equal(tokenId, "4281aedb-fb15-4b05-a2c8-1b17e44ef0e4");
        return {
          sessionId: "test-id",
          kind: "plan-approve",
          planDecisionVersion: 1,
        };
      },
      consumeActionToken: (tokenId: string) => {
        consumed++;
        assert.equal(tokenId, "4281aedb-fb15-4b05-a2c8-1b17e44ef0e4");
        return {
          sessionId: "test-id",
          kind: "plan-approve",
          planDecisionVersion: 1,
        };
      },
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
      clearPlanDecisionTokens: () => {},
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("unused", "telegram", {
      telegramCallback: {
        data: undefined,
        payload: undefined,
        callback_data: "code-agent:4281aedb-fb15-4b05-a2c8-1b17e44ef0e4",
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(consumed, 1);
    assert.equal(switchedTo, "bypassPermissions");
    assert.equal(state.callbacksAcknowledged, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.deepEqual(state.replies, []);
  });

  it("prefers namespaced native Telegram plan approval data over conflicting payload text", async () => {
    let switchedTo: string | undefined;
    let consumed = 0;
    const lookups: string[] = [];
    const session = createStubSession({
      id: "k7rM7W1J",
      name: "plan-oca-v2026-6-9-compat",
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 1,
      actionablePlanDecisionVersion: 1,
      canonicalPlanPromptVersion: 1,
      approvalPromptRequiredVersion: 1,
      approvalPromptVersion: 1,
      sendMessage: async () => {},
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });

    setSessionManager({
      getActionToken: (tokenId: string) => {
        lookups.push(tokenId);
        if (tokenId !== "4281aedb-fb15-4b05-a2c8-1b17e44ef0e4") return undefined;
        return {
          sessionId: "k7rM7W1J",
          kind: "plan-approve",
          label: "Approve",
          planDecisionVersion: 1,
        };
      },
      consumeActionToken: (tokenId: string) => {
        consumed++;
        assert.equal(tokenId, "4281aedb-fb15-4b05-a2c8-1b17e44ef0e4");
        return {
          sessionId: "k7rM7W1J",
          kind: "plan-approve",
          label: "Approve",
          planDecisionVersion: 1,
        };
      },
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
      clearPlanDecisionTokens: () => {},
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("derived-stale-token", "telegram", {
      telegramCallback: {
        data: "code-agent:4281aedb-fb15-4b05-a2c8-1b17e44ef0e4",
        payload: "Approve",
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(lookups, ["4281aedb-fb15-4b05-a2c8-1b17e44ef0e4"]);
    assert.equal(consumed, 1);
    assert.equal(switchedTo, "bypassPermissions");
    assert.equal(state.callbacksAcknowledged, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.deepEqual(state.replies, []);
  });

  it("prefers namespaced native interaction plan approval data over callback payload text", async () => {
    let switchedTo: string | undefined;
    let consumed = 0;
    const lookups: string[] = [];
    const session = createStubSession({
      id: "k7rM7W1J",
      name: "plan-oca-v2026-6-9-compat",
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 1,
      actionablePlanDecisionVersion: 1,
      canonicalPlanPromptVersion: 1,
      approvalPromptRequiredVersion: 1,
      approvalPromptVersion: 1,
      sendMessage: async () => {},
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });

    setSessionManager({
      getActionToken: (tokenId: string) => {
        lookups.push(tokenId);
        if (tokenId !== "real-approval-token") return undefined;
        return {
          sessionId: "k7rM7W1J",
          kind: "plan-approve",
          label: "Approve",
          planDecisionVersion: 1,
        };
      },
      consumeActionToken: (tokenId: string) => {
        consumed++;
        assert.equal(tokenId, "real-approval-token");
        return {
          sessionId: "k7rM7W1J",
          kind: "plan-approve",
          label: "Approve",
          planDecisionVersion: 1,
        };
      },
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
      clearPlanDecisionTokens: () => {},
    } as any);

    const replies: string[] = [];
    let callbacksAcknowledged = 0;
    let buttonsCleared = 0;
    const ctx = {
      channel: "discord" as const,
      auth: { isAuthorizedSender: true },
      callback: { payload: "Approve" },
      interaction: { callback_data: "code-agent:real-approval-token" },
      respond: {
        acknowledge: async () => { callbacksAcknowledged++; },
        clearButtons: async () => { buttonsCleared++; },
        reply: async ({ text }: { text: string }) => { replies.push(text); },
      },
    };

    const handler = createCallbackHandler("discord");
    const result = await handler.handler(ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(lookups, ["real-approval-token"]);
    assert.equal(consumed, 1);
    assert.equal(switchedTo, "bypassPermissions");
    assert.equal(callbacksAcknowledged, 1);
    assert.equal(buttonsCleared, 1);
    assert.deepEqual(replies, []);
  });

  it("does not consume plan approval tokens when approval fails before applying", async () => {
    let consumed = 0;
    const tokens = [
      {
        id: "approve-token",
        sessionId: "test-id",
        kind: "plan-approve" as const,
        label: "Approve",
        planDecisionVersion: 1,
        createdAt: Date.now(),
      },
      {
        id: "revise-token",
        sessionId: "test-id",
        kind: "plan-request-changes" as const,
        label: "Revise",
        planDecisionVersion: 1,
        createdAt: Date.now(),
      },
      {
        id: "reject-token",
        sessionId: "test-id",
        kind: "plan-reject" as const,
        label: "Reject",
        planDecisionVersion: 1,
        createdAt: Date.now(),
      },
    ];
    const session = createStubSession({
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 1,
      actionablePlanDecisionVersion: 1,
      sendMessage: async () => {
        throw new Error("backend unavailable");
      },
      switchPermissionMode: () => {},
    });

    setSessionManager({
      getActionToken: () => tokens[0],
      consumeActionToken: () => {
        consumed++;
        return tokens[0];
      },
      listActiveActionTokens: (kind: string) => tokens.filter((token) => token.kind === kind),
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
      clearPlanDecisionTokens: () => {},
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-approve");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(consumed, 0);
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.match(state.replies[0], /backend unavailable/);
    assert.match(state.replies[0], /Approval is still pending/);
    assert.deepEqual(state.replyButtons[0], [[
      { label: "Approve", callbackData: "approve-token", style: "primary" },
      { label: "Revise", callbackData: "revise-token", style: "secondary" },
      { label: "Reject", callbackData: "reject-token", style: "danger" },
    ]]);
  });

  it("consumes and clears plan approval tokens when an approval error follows applied state", async () => {
    let consumed = 0;
    const session = createStubSession({
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 1,
      actionablePlanDecisionVersion: 1,
      sendMessage: async () => {
        session.pendingPlanApproval = false;
        session.approvalState = "approved";
        session.actionablePlanDecisionVersion = undefined;
        throw new Error("stream failed after approval");
      },
      switchPermissionMode: (mode: string) => {
        session.currentPermissionMode = mode;
      },
    });

    setSessionManager({
      getActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-approve",
        planDecisionVersion: 1,
      }),
      consumeActionToken: () => {
        consumed++;
        return {
          sessionId: "test-id",
          kind: "plan-approve",
          planDecisionVersion: 1,
        };
      },
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
      clearPlanDecisionTokens: () => {},
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-approve");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(consumed, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.match(state.replies[0], /stream failed after approval/);
  });

  it("reports duplicate plan approval clicks as no longer awaiting approval", async () => {
    let consumed = false;
    const token = {
      sessionId: "test-id",
      kind: "plan-approve" as const,
      planDecisionVersion: 1,
    };
    const session = createStubSession({
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 1,
      actionablePlanDecisionVersion: 1,
      sendMessage: async () => {
        session.pendingPlanApproval = false;
        session.approvalState = "approved";
        session.actionablePlanDecisionVersion = undefined;
      },
      switchPermissionMode: (mode: string) => {
        session.currentPermissionMode = mode;
      },
    });

    setSessionManager({
      getActionToken: () => consumed ? { ...token, consumedAt: Date.now() } : token,
      consumeActionToken: () => {
        if (consumed) return undefined;
        consumed = true;
        return { ...token, consumedAt: Date.now() };
      },
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
      clearPlanDecisionTokens: () => {},
    } as any);

    const handler = createCallbackHandler();
    const first = createCtx("token-approve");
    const firstResult = await handler.handler(first.ctx as any);
    const second = createCtx("token-approve");
    const secondResult = await handler.handler(second.ctx as any);

    assert.deepEqual(firstResult, { handled: true });
    assert.deepEqual(secondResult, { handled: true });
    assert.equal(first.buttonsCleared, 1);
    assert.equal(second.buttonsCleared, 1);
    assert.equal(first.buttonMarkupEdits, 1);
    assert.equal(second.buttonMarkupEdits, 1);
    assert.deepEqual(first.replies, []);
    assert.equal(second.replies[0], "⚠️ This plan is no longer awaiting approval.");
  });

  it("clears Telegram plan approval buttons when the token is missing after successful approval", async () => {
    let sendCount = 0;
    const token = {
      sessionId: "test-id",
      kind: "plan-approve" as const,
      planDecisionVersion: 1,
    };
    const session = createStubSession({
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 1,
      actionablePlanDecisionVersion: 1,
      sendMessage: async () => {
        sendCount++;
        session.pendingPlanApproval = false;
        session.approvalState = "approved";
        session.actionablePlanDecisionVersion = undefined;
      },
      switchPermissionMode: (mode: string) => {
        session.currentPermissionMode = mode;
      },
    });

    setSessionManager({
      getActionToken: () => token,
      consumeActionToken: () => undefined,
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
      clearPlanDecisionTokens: () => {},
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-approve");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(sendCount, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.equal(state.buttonMarkupEdits, 1);
    assert.deepEqual(state.replies, []);
  });

  it("serializes concurrent plan approval clicks so approval is sent once", async () => {
    let consumed = false;
    let sendCount = 0;
    let notifyCount = 0;
    let switchCount = 0;
    let releaseSend: (() => void) | undefined;
    const sendMayFinish = new Promise<void>((resolve) => { releaseSend = resolve; });
    let sendStarted: (() => void) | undefined;
    const sendHasStarted = new Promise<void>((resolve) => { sendStarted = resolve; });
    const token = {
      sessionId: "test-id",
      kind: "plan-approve" as const,
      planDecisionVersion: 1,
    };
    const session = createStubSession({
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 1,
      actionablePlanDecisionVersion: 1,
      sendMessage: async () => {
        sendCount++;
        sendStarted?.();
        await sendMayFinish;
        session.pendingPlanApproval = false;
        session.approvalState = "approved";
        session.actionablePlanDecisionVersion = undefined;
      },
      switchPermissionMode: (mode: string) => {
        switchCount++;
        session.currentPermissionMode = mode;
      },
    });

    setSessionManager({
      getActionToken: () => consumed ? { ...token, consumedAt: Date.now() } : token,
      consumeActionToken: () => {
        if (consumed) return undefined;
        consumed = true;
        return { ...token, consumedAt: Date.now() };
      },
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => { notifyCount++; },
      clearPlanDecisionTokens: () => {},
    } as any);

    const handler = createCallbackHandler();
    const first = createCtx("token-approve");
    const firstResultPromise = handler.handler(first.ctx as any);
    await sendHasStarted;

    const second = createCtx("token-approve");
    const secondResultPromise = handler.handler(second.ctx as any);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(second.replies[0], "⚠️ This plan decision is already being processed.");
    releaseSend?.();

    const [firstResult, secondResult] = await Promise.all([firstResultPromise, secondResultPromise]);

    assert.deepEqual(firstResult, { handled: true });
    assert.deepEqual(secondResult, { handled: true });
    assert.equal(sendCount, 1);
    assert.equal(switchCount, 1);
    assert.equal(notifyCount, 1);
    assert.equal(first.buttonsCleared, 1);
    assert.equal(second.buttonsCleared, 1);
    assert.equal(first.buttonMarkupEdits, 1);
    assert.equal(second.buttonMarkupEdits, 1);
    assert.deepEqual(first.replies, []);
    assert.equal(second.replies[0], "⚠️ This plan decision is already being processed.");
  });

  it("serializes sibling plan decision callbacks while approval is in flight", async () => {
    let approveConsumed = 0;
    let rejectConsumed = 0;
    let sendCount = 0;
    let killCount = 0;
    let releaseSend: (() => void) | undefined;
    const sendMayFinish = new Promise<void>((resolve) => { releaseSend = resolve; });
    let sendStarted: (() => void) | undefined;
    const sendHasStarted = new Promise<void>((resolve) => { sendStarted = resolve; });
    const approveToken = {
      sessionId: "test-id",
      kind: "plan-approve" as const,
      planDecisionVersion: 1,
    };
    const rejectToken = {
      sessionId: "test-id",
      kind: "plan-reject" as const,
      planDecisionVersion: 1,
    };
    const session = createStubSession({
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 1,
      actionablePlanDecisionVersion: 1,
      sendMessage: async () => {
        sendCount++;
        sendStarted?.();
        await sendMayFinish;
        session.pendingPlanApproval = false;
        session.approvalState = "approved";
        session.actionablePlanDecisionVersion = undefined;
      },
      switchPermissionMode: (mode: string) => {
        session.currentPermissionMode = mode;
      },
    });

    setSessionManager({
      getActionToken: (tokenId: string) => {
        if (tokenId === "token-approve") return approveToken;
        if (tokenId === "token-reject") return rejectToken;
        return undefined;
      },
      consumeActionToken: (tokenId: string) => {
        if (tokenId === "token-approve") {
          approveConsumed++;
          return approveToken;
        }
        if (tokenId === "token-reject") {
          rejectConsumed++;
          return rejectToken;
        }
        return undefined;
      },
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
      clearPlanDecisionTokens: () => {},
      kill: () => { killCount++; },
    } as any);

    const handler = createCallbackHandler();
    const approve = createCtx("token-approve");
    const approveResultPromise = handler.handler(approve.ctx as any);
    await sendHasStarted;

    const reject = createCtx("token-reject");
    const rejectResultPromise = handler.handler(reject.ctx as any);
    releaseSend?.();

    const [approveResult, rejectResult] = await Promise.all([approveResultPromise, rejectResultPromise]);

    assert.deepEqual(approveResult, { handled: true });
    assert.deepEqual(rejectResult, { handled: true });
    assert.equal(sendCount, 1);
    assert.equal(approveConsumed, 1);
    assert.equal(rejectConsumed, 0);
    assert.equal(killCount, 0);
    assert.deepEqual(approve.replies, []);
    assert.equal(reject.replies[0], "⚠️ This plan is no longer awaiting approval.");
  });

  it("serializes concurrent revise and reject plan decision callbacks", async () => {
    let reviseConsumed = 0;
    let rejectConsumed = 0;
    let clearPlanDecisionTokenCount = 0;
    let killCount = 0;
    let releaseReviseClear: (() => void) | undefined;
    const reviseClearMayFinish = new Promise<void>((resolve) => { releaseReviseClear = resolve; });
    let reviseClearStarted: (() => void) | undefined;
    const reviseClearHasStarted = new Promise<void>((resolve) => { reviseClearStarted = resolve; });
    const reviseToken = {
      sessionId: "test-id",
      kind: "plan-request-changes" as const,
      planDecisionVersion: 1,
    };
    const rejectToken = {
      sessionId: "test-id",
      kind: "plan-reject" as const,
      planDecisionVersion: 1,
    };
    const session = createStubSession({
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 1,
      actionablePlanDecisionVersion: 1,
    });

    setSessionManager({
      getActionToken: (tokenId: string) => {
        if (tokenId === "token-revise") return reviseToken;
        if (tokenId === "token-reject") return rejectToken;
        return undefined;
      },
      consumeActionToken: (tokenId: string) => {
        if (tokenId === "token-revise") {
          reviseConsumed++;
          return reviseToken;
        }
        if (tokenId === "token-reject") {
          rejectConsumed++;
          return rejectToken;
        }
        return undefined;
      },
      resolve: () => session,
      getPersistedSession: () => undefined,
      updatePersistedSession: (_sessionId: string, patch: Record<string, unknown>) => {
        Object.assign(session, patch);
      },
      clearPlanDecisionTokens: () => { clearPlanDecisionTokenCount++; },
      kill: () => { killCount++; },
    } as any);

    const handler = createCallbackHandler();
    const revise = createCtx("token-revise");
    (revise.ctx as any).respond.clearButtons = async () => {
      reviseClearStarted?.();
      await reviseClearMayFinish;
    };
    const reviseResultPromise = handler.handler(revise.ctx as any);
    await reviseClearHasStarted;

    const reject = createCtx("token-reject");
    const rejectResultPromise = handler.handler(reject.ctx as any);
    releaseReviseClear?.();

    const [reviseResult, rejectResult] = await Promise.all([reviseResultPromise, rejectResultPromise]);

    assert.deepEqual(reviseResult, { handled: true });
    assert.deepEqual(rejectResult, { handled: true });
    assert.equal(reviseConsumed, 1);
    assert.equal(rejectConsumed, 0);
    assert.equal(clearPlanDecisionTokenCount, 1);
    assert.equal(killCount, 0);
    assert.equal(session.pendingPlanApproval, false);
    assert.equal(session.approvalState, "changes_requested");
    assert.equal(revise.replies[0], "✏️ Type your revision feedback for [test-session] and I'll forward it to the agent.");
    assert.equal(reject.replies[0], "⚠️ This plan decision is stale because a newer plan review state already exists.");
  });

  it("accepts Discord callbacks that provide payload via callback and only expose clearButtons", async () => {
    let switchedTo: string | undefined;
    const session = createStubSession({
      pendingPlanApproval: true,
      actionablePlanDecisionVersion: 1,
      sendMessage: async () => {},
      switchPermissionMode: (mode: string) => { switchedTo = mode; },
    });

    let buttonsCleared = 0;
    const replies: string[] = [];
    const ctx = {
      channel: "discord" as const,
      auth: { isAuthorizedSender: true },
      callback: { payload: "token-approve" },
      respond: {
        clearButtons: async () => { buttonsCleared++; },
        reply: async ({ text }: { text: string }) => { replies.push(text); },
      },
    };

    setSessionManager({
      getActionToken: () => ({ sessionId: "test-id", kind: "plan-approve" }),
      consumeActionToken: () => ({ sessionId: "test-id", kind: "plan-approve" }),
      resolve: () => session,
      getPersistedSession: () => undefined,
      notifySession: () => {},
      clearPlanDecisionTokens: () => {},
    } as any);

    const handler = createCallbackHandler("discord");
    const result = await handler.handler(ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(switchedTo, "bypassPermissions");
    assert.equal(buttonsCleared, 1);
    assert.deepEqual(replies, []);
  });

  it("rejects plans even when Discord clearComponents falls back to acknowledge", async () => {
    let killed: { id: string; reason: string } | undefined;
    let acknowledged = 0;
    const session = createStubSession({
      id: "test-id",
      name: "reject-me",
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 1,
    });

    setSessionManager({
      getActionToken: () => ({ sessionId: "test-id", kind: "plan-reject" }),
      consumeActionToken: () => ({ sessionId: "test-id", kind: "plan-reject" }),
      resolve: () => session,
      getPersistedSession: () => undefined,
      clearPlanDecisionTokens: () => {},
      kill: (id: string, reason: string) => {
        killed = { id, reason };
      },
    } as any);

    const replies: string[] = [];
    const ctx = {
      channel: "discord" as const,
      auth: { isAuthorizedSender: true },
      interaction: { payload: "token-reject" },
      respond: {
        clearComponents: async () => {
          throw new Error("Cannot send an empty message");
        },
        acknowledge: async () => { acknowledged++; },
        reply: async ({ text }: { text: string }) => { replies.push(text); },
      },
    };

    const handler = createCallbackHandler("discord");
    const result = await handler.handler(ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(killed, { id: "test-id", reason: "user" });
    assert.equal(acknowledged, 1);
    assert.equal(replies[0], "❌ Plan rejected for [reject-me]. Session stopped.");
  });

  it("warns when Discord clearComponents fails and no acknowledge fallback is available", async () => {
    let killed: { id: string; reason: string } | undefined;
    const session = createStubSession({
      id: "test-id",
      name: "warn-me",
      pendingPlanApproval: true,
      approvalState: "pending",
      planDecisionVersion: 1,
    });

    setSessionManager({
      getActionToken: () => ({ sessionId: "test-id", kind: "plan-reject" }),
      consumeActionToken: () => ({ sessionId: "test-id", kind: "plan-reject" }),
      resolve: () => session,
      getPersistedSession: () => undefined,
      clearPlanDecisionTokens: () => {},
      kill: (id: string, reason: string) => {
        killed = { id, reason };
      },
    } as any);

    const replies: string[] = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };

    try {
      const ctx = {
        channel: "discord" as const,
        auth: { isAuthorizedSender: true },
        interaction: { payload: "token-reject" },
        respond: {
          clearComponents: async () => {
            throw new Error("Cannot send an empty message");
          },
          reply: async ({ text }: { text: string }) => { replies.push(text); },
        },
      };

      const handler = createCallbackHandler("discord");
      const result = await handler.handler(ctx as any);

      assert.deepEqual(result, { handled: true });
      assert.deepEqual(killed, { id: "test-id", reason: "user" });
      assert.equal(replies[0], "❌ Plan rejected for [warn-me]. Session stopped.");
      assert.match(warnings[0], /no acknowledge fallback available/i);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("marks request-changes immediately so stale approvals are blocked", async () => {
    const patches: Array<Record<string, unknown>> = [];
    setSessionManager({
      getActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-request-changes",
        planDecisionVersion: 4,
      }),
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
      clearPlanDecisionTokens: () => {},
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
      lifecycle: "awaiting_user_input",
      pendingPlanApproval: false,
      planApprovalContext: undefined,
      planDecisionVersion: 5,
      actionablePlanDecisionVersion: undefined,
      canonicalPlanPromptVersion: undefined,
      approvalPromptRequiredVersion: undefined,
      approvalPromptVersion: undefined,
      approvalPromptStatus: "not_sent",
      approvalPromptTransport: "none",
      approvalPromptMessageKind: "none",
      approvalPromptLastAttemptAt: undefined,
      approvalPromptDeliveredAt: undefined,
      approvalPromptFailedAt: undefined,
    });
  });

  it("rejects timed-out pending plans without leaving them pending in persisted state", async () => {
    const patches: Array<Record<string, unknown>> = [];
    setSessionManager({
      getActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-reject",
        planDecisionVersion: 4,
      }),
      consumeActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-reject",
        planDecisionVersion: 4,
      }),
      resolve: () => undefined,
      getPersistedSession: () => ({
        id: "test-id",
        name: "spellcast-release-readiness-plan",
        pendingPlanApproval: true,
        approvalState: "pending",
        planDecisionVersion: 4,
      }),
      updatePersistedSession: (_ref: string, patch: Record<string, unknown>) => {
        patches.push(patch);
        return true;
      },
      clearPlanDecisionTokens: () => {},
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-reject");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.buttonsCleared, 1);
    assert.match(state.replies[0], /Plan rejected for \[spellcast-release-readiness-plan\]\. Session remains stopped\./);
    assert.deepEqual(patches[0], {
      approvalState: "rejected",
      lifecycle: "terminal",
      runtimeState: "stopped",
      pendingPlanApproval: false,
      planApprovalContext: undefined,
      planDecisionVersion: 5,
      actionablePlanDecisionVersion: undefined,
      canonicalPlanPromptVersion: undefined,
      approvalPromptRequiredVersion: undefined,
      approvalPromptVersion: undefined,
      approvalPromptStatus: "not_sent",
      approvalPromptTransport: "none",
      approvalPromptMessageKind: "none",
      approvalPromptLastAttemptAt: undefined,
      approvalPromptDeliveredAt: undefined,
      approvalPromptFailedAt: undefined,
    });
  });

  it("accepts delivered plan prompt tokens when the actionable version is missing from session state", async () => {
    let killed: { id: string; reason: string } | undefined;
    setSessionManager({
      getActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-reject",
        planDecisionVersion: 4,
      }),
      consumeActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-reject",
        planDecisionVersion: 4,
      }),
      resolve: () => createStubSession({
        id: "test-id",
        name: "restored-plan",
        pendingPlanApproval: true,
        approvalState: "pending",
        planDecisionVersion: 5,
        approvalPromptRequiredVersion: 4,
        approvalPromptVersion: 4,
        canonicalPlanPromptVersion: 4,
      }),
      getPersistedSession: () => undefined,
      clearPlanDecisionTokens: () => {},
      kill: (id: string, reason: string) => {
        killed = { id, reason };
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-reject");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(killed, { id: "test-id", reason: "user" });
    assert.equal(state.buttonsCleared, 1);
    assert.equal(state.replies[0], "❌ Plan rejected for [restored-plan]. Session stopped.");
  });

  it("uses the newer current delivery version when approval prompt metadata diverges", async () => {
    setSessionManager({
      getActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-reject",
        planDecisionVersion: 4,
      }),
      consumeActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-reject",
        planDecisionVersion: 4,
      }),
      resolve: () => createStubSession({
        id: "test-id",
        name: "planner",
        pendingPlanApproval: true,
        approvalState: "pending",
        planDecisionVersion: 4,
        approvalPromptRequiredVersion: 4,
        approvalPromptVersion: 5,
        canonicalPlanPromptVersion: 4,
      }),
      getPersistedSession: () => undefined,
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-stale-reject");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.buttonsCleared, 1);
    assert.match(state.replies[0], /stale/i);
  });

  it("uses canonical plan prompt version before plan decision version when delivery fields are absent", async () => {
    let killed: { id: string; reason: string } | undefined;
    setSessionManager({
      getActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-reject",
        planDecisionVersion: 4,
      }),
      consumeActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-reject",
        planDecisionVersion: 4,
      }),
      resolve: () => createStubSession({
        id: "test-id",
        name: "canonical-plan",
        pendingPlanApproval: true,
        approvalState: "pending",
        planDecisionVersion: 5,
        canonicalPlanPromptVersion: 4,
      }),
      getPersistedSession: () => undefined,
      clearPlanDecisionTokens: () => {},
      kill: (id: string, reason: string) => {
        killed = { id, reason };
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-reject");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(killed, { id: "test-id", reason: "user" });
    assert.equal(state.buttonsCleared, 1);
    assert.equal(state.replies[0], "❌ Plan rejected for [canonical-plan]. Session stopped.");
  });

  it("rejects stale plan approval callbacks from an older plan-decision version", async () => {
    setSessionManager({
      getActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-approve",
        planDecisionVersion: 2,
      }),
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
        actionablePlanDecisionVersion: 3,
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

  it("rejects older plan callbacks when current delivery metadata supersedes prior canonical metadata", async () => {
    setSessionManager({
      getActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-reject",
        planDecisionVersion: 4,
      }),
      consumeActionToken: () => ({
        sessionId: "test-id",
        kind: "plan-reject",
        planDecisionVersion: 4,
      }),
      resolve: () => createStubSession({
        id: "test-id",
        name: "planner",
        pendingPlanApproval: true,
        approvalState: "pending",
        planDecisionVersion: 5,
        approvalPromptRequiredVersion: 5,
        approvalPromptVersion: 5,
        canonicalPlanPromptVersion: 4,
      }),
      getPersistedSession: () => undefined,
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-stale-reject");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.buttonsCleared, 1);
    assert.match(state.replies[0], /stale/i);
  });

  it("clears Telegram buttons and stays quiet for duplicate consumed callbacks", async () => {
    let consumes = 0;
    setSessionManager({
      getActionToken: () => undefined,
      consumeActionToken: () => {
        consumes++;
        return undefined;
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("already-used-token");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.callbacksAcknowledged, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.equal(consumes, 0);
    assert.deepEqual(state.replies, []);
    assert.deepEqual(state.events, ["acknowledge", "clearButtons"]);
  });

  it("does not echo raw malformed Telegram callback text", async () => {
    let lookups = 0;
    let consumes = 0;
    setSessionManager({
      getActionToken: () => {
        lookups++;
        return { sessionId: "stale-session", kind: "view-output" };
      },
      consumeActionToken: () => {
        consumes++;
        return { sessionId: "stale-session", kind: "view-output" };
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("ignored", "telegram", {
      telegramCallback: {
        data: "code-agent:",
        payload: "stale-payload-token",
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.callbacksAcknowledged, 1);
    assert.equal(lookups, 0);
    assert.equal(consumes, 0);
    assert.deepEqual(state.replies, ["⚠️ Unrecognized callback payload."]);
    assert.doesNotMatch(state.replies.join("\n"), /code-agent:/);
    assert.doesNotMatch(state.replies.join("\n"), /stale-payload-token/);
  });

  it("resolves question-answer callbacks by session and option index", async () => {
    const resolved: Array<{ sessionId: string; optionIndex: number }> = [];
    let consumed = 0;
    setSessionManager({
      getActionToken: () => ({ sessionId: "sess-42", kind: "question-answer", optionIndex: 1 }),
      consumeActionToken: () => {
        consumed++;
        return { sessionId: "sess-42", kind: "question-answer", optionIndex: 1 };
      },
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
    assert.equal(consumed, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.equal(state.replies[0], "✅ Answer submitted.");
  });

  it("does not consume or clear active question buttons when answer submission fails", async () => {
    let consumed = 0;
    setSessionManager({
      getActionToken: () => ({ sessionId: "sess-42", kind: "question-answer", optionIndex: 1 }),
      consumeActionToken: () => {
        consumed++;
        return { sessionId: "sess-42", kind: "question-answer", optionIndex: 1 };
      },
      resolvePendingInputOption: () => false,
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-question-stale");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(consumed, 0);
    assert.equal(state.buttonsCleared, 0);
    assert.equal(state.replies[0], "⚠️ Could not submit that answer. The question prompt is still active; try again or reply with the answer.");
  });

  it("does not consume or clear active question buttons when answer submission throws", async (t) => {
    let consumed = 0;
    const warnings: string[] = [];
    t.mock.method(console, "warn", ((message?: unknown) => {
      warnings.push(String(message));
    }) as typeof console.warn);

    setSessionManager({
      getActionToken: () => ({ sessionId: "sess-42", kind: "question-answer", optionIndex: 1 }),
      consumeActionToken: () => {
        consumed++;
        return { sessionId: "sess-42", kind: "question-answer", optionIndex: 1 };
      },
      resolvePendingInputOption: async () => {
        throw new Error("backend submit failed");
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-question-throws");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(consumed, 0);
    assert.equal(state.buttonsCleared, 0);
    assert.equal(state.replies[0], "⚠️ Could not submit that answer. The question prompt is still active; try again or reply with the answer.");
    assert.match(warnings[0], /backend submit failed/);
  });

  it("does not submit duplicate in-flight question-answer callbacks", async () => {
    let resolveSubmit!: (value: boolean) => void;
    let submitCalls = 0;
    let consumeCalls = 0;
    setSessionManager({
      getActionToken: () => ({ sessionId: "sess-42", kind: "question-answer", optionIndex: 1 }),
      consumeActionToken: () => {
        consumeCalls++;
        return { sessionId: "sess-42", kind: "question-answer", optionIndex: 1 };
      },
      resolvePendingInputOption: () => {
        submitCalls++;
        return new Promise<boolean>((resolve) => {
          resolveSubmit = resolve;
        });
      },
    } as any);

    const handler = createCallbackHandler();
    const firstState = createCtx("token-question-race");
    const firstResult = handler.handler(firstState.ctx as any);
    const secondState = createCtx("token-question-race");
    const secondResult = await handler.handler(secondState.ctx as any);

    assert.deepEqual(secondResult, { handled: true });
    assert.equal(submitCalls, 1);
    assert.equal(consumeCalls, 0);
    assert.equal(secondState.buttonsCleared, 0);
    assert.equal(secondState.replies[0], "⚠️ That answer is already being submitted. If the question remains active, try again.");

    resolveSubmit(true);
    assert.deepEqual(await firstResult, { handled: true });
    assert.equal(submitCalls, 1);
    assert.equal(consumeCalls, 1);
    assert.equal(firstState.buttonsCleared, 1);
    assert.equal(firstState.replies[0], "✅ Answer submitted.");
  });

  it("reports duplicate question-answer callbacks as stale after a successful answer", async () => {
    const token = {
      sessionId: "sess-42",
      kind: "question-answer",
      optionIndex: 1,
    };
    let submitted = false;
    let consumed = false;
    setSessionManager({
      getActionToken: () => consumed ? { ...token, consumedAt: 123 } : token,
      consumeActionToken: () => {
        consumed = true;
        return token;
      },
      resolvePendingInputOption: () => {
        assert.equal(submitted, false);
        submitted = true;
        return true;
      },
    } as any);

    const handler = createCallbackHandler();
    const firstState = createCtx("token-question-duplicate");
    const firstResult = await handler.handler(firstState.ctx as any);
    const secondState = createCtx("token-question-duplicate");
    const secondResult = await handler.handler(secondState.ctx as any);

    assert.deepEqual(firstResult, { handled: true });
    assert.deepEqual(secondResult, { handled: true });
    assert.equal(submitted, true);
    assert.equal(firstState.replies[0], "✅ Answer submitted.");
    assert.equal(secondState.replies[0], "⚠️ That question button is no longer active. Use the latest question prompt.");
  });

  it("reports success when question-answer submission succeeds but token consumption misses", async () => {
    let submitted = false;
    let consumes = 0;
    setSessionManager({
      getActionToken: () => ({ sessionId: "sess-42", kind: "question-answer", optionIndex: 1 }),
      consumeActionToken: () => {
        consumes++;
        return undefined;
      },
      resolvePendingInputOption: () => {
        submitted = true;
        return true;
      },
    } as any);

    const handler = createCallbackHandler("discord");
    const state = createCtx("token-question-consume-miss", "discord");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(submitted, true);
    assert.equal(consumes, 1);
    assert.equal(state.componentsCleared, 1);
    assert.equal(state.replies[0], "✅ Answer submitted.");
  });

  it("clears worktree merge buttons without replying when agent_merge succeeds", async () => {
    setSessionManager({
      getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-merge" }),
      consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-merge" }),
      resolve: () => undefined,
      getPersistedSession: () => ({ name: "ux-fix" }),
    } as any);

    const handler = createCallbackHandler("telegram", {
      makeAgentMergeTool: () => ({
        execute: async (_id: string, params: unknown) => {
          assert.deepEqual(params, { session: "sess-42" });
          return createToolResult("✅ Merged branch agent/ux-fix into main.", true);
        },
      }) as any,
    });
    const state = createCtx("token-merge");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(state.editedMessages, []);
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.deepEqual(state.replies, []);
    assert.deepEqual(state.events, ["acknowledge", "editButtons", "clearButtons"]);
  });

  it("clears worktree PR buttons without replying when agent_pr succeeds", async () => {
    for (const kind of ["worktree-create-pr", "worktree-update-pr"] as const) {
      setSessionManager({
        getActionToken: () => ({ sessionId: "sess-42", kind }),
        consumeActionToken: () => ({ sessionId: "sess-42", kind }),
        resolve: () => undefined,
        getPersistedSession: () => ({ name: "ux-fix" }),
      } as any);

      const handler = createCallbackHandler("telegram", {
        makeAgentPrTool: () => ({
          execute: async (_id: string, params: unknown) => {
            assert.deepEqual(params, { session: "sess-42" });
            return createToolResult("✅ PR opened: https://github.com/example/repo/pull/42", true);
          },
        }) as any,
      });
      const state = createCtx(`token-${kind}`);
      const result = await handler.handler(state.ctx as any);

      assert.deepEqual(result, { handled: true }, kind);
      assert.deepEqual(state.editedMessages, [], kind);
      assert.equal(state.buttonMarkupEdits, 1, kind);
      assert.equal(state.buttonsCleared, 1, kind);
      assert.deepEqual(state.replies, [], kind);
      assert.deepEqual(state.events, ["acknowledge", "editButtons", "clearButtons"], kind);
    }
  });

  it("keeps worktree merge and PR buttons while replying when the tool fails", async () => {
    const cases = [
      {
        kind: "worktree-merge" as const,
        text: "❌ Merge failed.",
        dependencies: {
          makeAgentMergeTool: () => ({
            execute: async () => createToolResult("❌ Merge failed.", false),
          }) as any,
        },
      },
      {
        kind: "worktree-create-pr" as const,
        text: "Error: GitHub CLI is not authenticated.",
        dependencies: {
          makeAgentPrTool: () => ({
            execute: async () => createToolResult("Error: GitHub CLI is not authenticated.", false),
          }) as any,
        },
      },
      {
        kind: "worktree-update-pr" as const,
        text: "⚠️  A PR exists but was closed without merging.",
        dependencies: {
          makeAgentPrTool: () => ({
            execute: async () => createToolResult("⚠️  A PR exists but was closed without merging.", false),
          }) as any,
        },
      },
    ];

    for (const testCase of cases) {
      setSessionManager({
        getActionToken: () => ({ sessionId: "sess-42", kind: testCase.kind }),
        consumeActionToken: () => ({ sessionId: "sess-42", kind: testCase.kind }),
        resolve: () => undefined,
        getPersistedSession: () => ({ name: "ux-fix" }),
      } as any);

      const handler = createCallbackHandler("telegram", testCase.dependencies);
      const state = createCtx(`token-${testCase.kind}`);
      const result = await handler.handler(state.ctx as any);

      assert.deepEqual(result, { handled: true }, testCase.kind);
      assert.deepEqual(state.editedMessages, [], testCase.kind);
      assert.equal(state.buttonMarkupEdits, 0, testCase.kind);
      assert.equal(state.buttonsCleared, 0, testCase.kind);
      assert.deepEqual(state.replies, [testCase.text], testCase.kind);
      assert.deepEqual(state.events, ["acknowledge", "reply"], testCase.kind);
    }
  });

  it("clears worktree decision buttons while preserving the original prompt text", async () => {
    const snoozeCalls: Array<{ sessionId: string; notifyUser?: boolean }> = [];
    setSessionManager({
      getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
      consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
      resolve: () => undefined,
      getPersistedSession: () => ({ name: "ux-fix" }),
      snoozeWorktreeDecision: (sessionId: string, options?: { notifyUser?: boolean }) => {
        snoozeCalls.push({ sessionId, notifyUser: options?.notifyUser });
        return "⏭️ Reminder snoozed 24h for `agent/ux-fix` (session: ux-fix)";
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-snooze");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(snoozeCalls, [{ sessionId: "sess-42", notifyUser: false }]);
    assert.deepEqual(state.editedMessages, []);
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.deepEqual(state.replies, ["⏭️ Snoozed 24h for [ux-fix]"]);
    assert.deepEqual(state.events, ["acknowledge", "editButtons", "clearButtons", "reply"]);
  });

  it("keeps Telegram worktree decision buttons when the action fails", async () => {
    setSessionManager({
      getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
      consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
      resolve: () => undefined,
      getPersistedSession: () => ({ name: "ux-fix" }),
      snoozeWorktreeDecision: () => "Error: session no longer has a pending worktree decision.",
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-snooze");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(state.editedMessages, []);
    assert.equal(state.buttonsCleared, 0);
    assert.equal(state.replies[0], "Error: session no longer has a pending worktree decision.");
    assert.deepEqual(state.events, ["acknowledge", "reply"]);
  });

  it("uses the same text-result predicate for snooze prompt cleanup and replies", async () => {
    const cases = [
      { result: "Error: session no longer has a pending worktree decision.", success: false, reply: "Error: session no longer has a pending worktree decision." },
      { result: "Error without colon still comes from an internal failure path.", success: false, reply: "Error without colon still comes from an internal failure path." },
      { result: "❌ Snooze failed because persisted state is unavailable.", success: false, reply: "❌ Snooze failed because persisted state is unavailable." },
      { result: "⚠️ Snooze skipped because reminders are disabled.", success: false, reply: "⚠️ Snooze skipped because reminders are disabled." },
    ];

    for (const testCase of cases) {
      setSessionManager({
        getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        resolve: () => undefined,
        getPersistedSession: () => ({ name: "ux-fix" }),
        snoozeWorktreeDecision: () => testCase.result,
      } as any);

      const handler = createCallbackHandler();
      const state = createCtx("token-snooze");
      const result = await handler.handler(state.ctx as any);

      assert.deepEqual(result, { handled: true });
      assert.equal(state.buttonsCleared, testCase.success ? 1 : 0, testCase.result);
      assert.deepEqual(state.editedMessages, testCase.success ? ["⏭️ Snoozed 24h for [ux-fix]"] : [], testCase.result);
      assert.equal(state.replies[0], testCase.reply);
    }
  });

  it("uses a friendly success reply for discard while preserving raw dismiss errors", async () => {
    let shouldFail = false;
    setSessionManager({
      getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-dismiss" }),
      consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-dismiss" }),
      resolve: () => undefined,
      getPersistedSession: () => ({ name: "ux-fix" }),
      dismissWorktree: async () => shouldFail
        ? "Error: branch deletion failed."
        : "🗑️ [ux-fix] Branch `agent/ux-fix` dismissed and permanently deleted.",
    } as any);

    const handler = createCallbackHandler();
    const success = createCtx("token-dismiss");
    const successResult = await handler.handler(success.ctx as any);

    assert.deepEqual(successResult, { handled: true });
    assert.deepEqual(success.editedMessages, []);
    assert.equal(success.buttonMarkupEdits, 1);
    assert.equal(success.buttonsCleared, 1);
    assert.equal(success.replies[0], "✅ Discarded");

    shouldFail = true;
    const failure = createCtx("token-dismiss");
    const failureResult = await handler.handler(failure.ctx as any);

    assert.deepEqual(failureResult, { handled: true });
    assert.deepEqual(failure.editedMessages, []);
    assert.equal(failure.buttonsCleared, 0);
    assert.equal(failure.replies[0], "Error: branch deletion failed.");
  });

  it("uses the same text-result predicate for discard prompt cleanup and replies", async () => {
    const cases = [
      { result: "Error: branch deletion failed.", success: false, reply: "Error: branch deletion failed." },
      { result: "Error without colon still comes from an internal failure path.", success: false, reply: "Error without colon still comes from an internal failure path." },
      { result: "❌ Branch deletion failed.", success: false, reply: "❌ Branch deletion failed." },
      { result: "⚠️ Discard skipped because worktree state changed.", success: false, reply: "⚠️ Discard skipped because worktree state changed." },
    ];

    for (const testCase of cases) {
      setSessionManager({
        getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-dismiss" }),
        consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-dismiss" }),
        resolve: () => undefined,
        getPersistedSession: () => ({ name: "ux-fix" }),
        dismissWorktree: async () => testCase.result,
      } as any);

      const handler = createCallbackHandler();
      const state = createCtx("token-dismiss");
      const result = await handler.handler(state.ctx as any);

      assert.deepEqual(result, { handled: true });
      assert.equal(state.buttonsCleared, testCase.success ? 1 : 0, testCase.result);
      assert.deepEqual(state.editedMessages, testCase.success ? ["🗑️ Discarded for [ux-fix]"] : [], testCase.result);
      assert.equal(state.replies[0], testCase.reply);
    }
  });

  it("clears Discord worktree components without replacing the prompt text", async () => {
    setSessionManager({
      getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
      consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
      resolve: () => undefined,
      getPersistedSession: () => ({ name: "ux-fix" }),
      snoozeWorktreeDecision: () => "⏭️ Reminder snoozed 24h for `agent/ux-fix` (session: ux-fix)",
    } as any);

    const clearedMessages: Array<{ text?: string }> = [];
    const replies: Array<{ text: string; ephemeral?: boolean }> = [];
    const ctx = {
      channel: "discord" as const,
      auth: { isAuthorizedSender: true },
      interaction: { payload: "token-snooze" },
      respond: {
        clearComponents: async ({ text }: { text?: string } = {}) => {
          clearedMessages.push({ text });
        },
        reply: async ({ text, ephemeral }: { text: string; ephemeral?: boolean }) => {
          replies.push({ text, ephemeral });
        },
      },
    };

    const handler = createCallbackHandler("discord");
    const result = await handler.handler(ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(clearedMessages, [{ text: undefined }]);
    assert.deepEqual(replies, [{ text: "⏭️ Snoozed 24h for [ux-fix]", ephemeral: true }]);
  });

  it("clears Telegram worktree buttons without editing prompt text when markup edit is unavailable", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };

    try {
      setSessionManager({
        getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        resolve: () => undefined,
        getPersistedSession: () => ({ name: "ux-fix" }),
        snoozeWorktreeDecision: () => "⏭️ Reminder snoozed 24h for `agent/ux-fix` (session: ux-fix)",
      } as any);

      const replies: string[] = [];
      let buttonsCleared = 0;
      const ctx = {
        channel: "telegram" as const,
        auth: { isAuthorizedSender: true },
        callback: { payload: "token-snooze" },
        respond: {
          editMessage: async () => {
            throw new Error("telegram edit failed");
          },
          clearButtons: async () => { buttonsCleared++; },
          reply: async ({ text }: { text: string }) => { replies.push(text); },
        },
      };

      const handler = createCallbackHandler();
      const result = await handler.handler(ctx as any);

      assert.deepEqual(result, { handled: true });
      assert.equal(buttonsCleared, 1);
      assert.deepEqual(replies, ["⏭️ Snoozed 24h for [ux-fix]"]);
      assert.deepEqual(warnings, []);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("clears Discord worktree buttons when only clearButtons is available", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };

    try {
      setSessionManager({
        getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        resolve: () => undefined,
        getPersistedSession: () => ({ name: "ux-fix" }),
        snoozeWorktreeDecision: () => "⏭️ Reminder snoozed 24h for `agent/ux-fix` (session: ux-fix)",
      } as any);

      const replies: string[] = [];
      const editedMessages: string[] = [];
      let buttonsCleared = 0;
      const ctx = {
        channel: "discord" as const,
        auth: { isAuthorizedSender: true },
        callback: { payload: "token-snooze" },
        respond: {
          editMessage: async ({ text }: { text: string }) => { editedMessages.push(text); },
          clearButtons: async () => { buttonsCleared++; },
          reply: async ({ text }: { text: string }) => { replies.push(text); },
        },
      };

      const handler = createCallbackHandler("discord");
      const result = await handler.handler(ctx as any);

      assert.deepEqual(result, { handled: true });
      assert.deepEqual(editedMessages, []);
      assert.equal(buttonsCleared, 1);
      assert.deepEqual(replies, ["⏭️ Snoozed 24h for [ux-fix]"]);
      assert.deepEqual(warnings, []);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("falls back to clearing Discord buttons when clearComponents worktree resolution fails", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };

    try {
      setSessionManager({
        getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        resolve: () => undefined,
        getPersistedSession: () => ({ name: "ux-fix" }),
        snoozeWorktreeDecision: () => "⏭️ Reminder snoozed 24h for `agent/ux-fix` (session: ux-fix)",
      } as any);

      const replies: string[] = [];
      let buttonsCleared = 0;
      const ctx = {
        channel: "discord" as const,
        auth: { isAuthorizedSender: true },
        callback: { payload: "token-snooze" },
        respond: {
          clearComponents: async () => {
            throw new Error("clearComponents failed");
          },
          clearButtons: async () => { buttonsCleared++; },
          reply: async ({ text }: { text: string }) => { replies.push(text); },
        },
      };

      const handler = createCallbackHandler("discord");
      const result = await handler.handler(ctx as any);

      assert.deepEqual(result, { handled: true });
      assert.equal(buttonsCleared, 1);
      assert.deepEqual(replies, ["⏭️ Snoozed 24h for [ux-fix]"]);
      assert.match(warnings[0], /Failed to clear Discord worktree components: clearComponents failed/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("clears Discord worktree buttons without editMessage when clearButtons is available", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };

    try {
      setSessionManager({
        getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        resolve: () => undefined,
        getPersistedSession: () => ({ name: "ux-fix" }),
        snoozeWorktreeDecision: () => "⏭️ Reminder snoozed 24h for `agent/ux-fix` (session: ux-fix)",
      } as any);

      const replies: string[] = [];
      let buttonsCleared = 0;
      const ctx = {
        channel: "discord" as const,
        auth: { isAuthorizedSender: true },
        callback: { payload: "token-snooze" },
        respond: {
          editMessage: async () => {
            throw new Error("Message is not modified");
          },
          clearButtons: async () => { buttonsCleared++; },
          reply: async ({ text }: { text: string }) => { replies.push(text); },
        },
      };

      const handler = createCallbackHandler("discord");
      const result = await handler.handler(ctx as any);

      assert.deepEqual(result, { handled: true });
      assert.equal(buttonsCleared, 1);
      assert.deepEqual(replies, ["⏭️ Snoozed 24h for [ux-fix]"]);
      assert.deepEqual(warnings, []);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("ignores Discord editMessage failures because worktree cleanup does not edit message text", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };

    try {
      setSessionManager({
        getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        resolve: () => undefined,
        getPersistedSession: () => ({ name: "ux-fix" }),
        snoozeWorktreeDecision: () => "⏭️ Reminder snoozed 24h for `agent/ux-fix` (session: ux-fix)",
      } as any);

      const replies: string[] = [];
      let buttonsCleared = 0;
      const ctx = {
        channel: "discord" as const,
        auth: { isAuthorizedSender: true },
        callback: { payload: "token-snooze" },
        respond: {
          editMessage: async () => {
            throw new Error("edit failed");
          },
          clearButtons: async () => { buttonsCleared++; },
          reply: async ({ text }: { text: string }) => { replies.push(text); },
        },
      };

      const handler = createCallbackHandler("discord");
      const result = await handler.handler(ctx as any);

      assert.deepEqual(result, { handled: true });
      assert.equal(buttonsCleared, 1);
      assert.deepEqual(replies, ["⏭️ Snoozed 24h for [ux-fix]"]);
      assert.deepEqual(warnings, []);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("does not edit Discord worktree prompt text when button clearing fails", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };

    try {
      setSessionManager({
        getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        consumeActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
        resolve: () => undefined,
        getPersistedSession: () => ({ name: "ux-fix" }),
        snoozeWorktreeDecision: () => "⏭️ Reminder snoozed 24h for `agent/ux-fix` (session: ux-fix)",
      } as any);

      const replies: string[] = [];
      const editedMessages: string[] = [];
      let clearAttempts = 0;
      const ctx = {
        channel: "discord" as const,
        auth: { isAuthorizedSender: true },
        callback: { payload: "token-snooze" },
        respond: {
          editMessage: async ({ text }: { text: string }) => { editedMessages.push(text); },
          clearButtons: async () => {
            clearAttempts++;
            throw new Error("clear failed");
          },
          reply: async ({ text }: { text: string }) => { replies.push(text); },
        },
      };

      const handler = createCallbackHandler("discord");
      const result = await handler.handler(ctx as any);

      assert.deepEqual(result, { handled: true });
      assert.deepEqual(editedMessages, []);
      assert.equal(clearAttempts, 1);
      assert.deepEqual(replies, ["⏭️ Snoozed 24h for [ux-fix]"]);
      assert.match(warnings[0], /Failed to clear Discord worktree buttons: clear failed/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("can be registered for Discord with the same action-token contract", async () => {
    setSessionManager({
      getActionToken: () => ({
        sessionId: "sess-discord",
        kind: "worktree-view-pr",
        targetUrl: "https://github.com/example/repo/pull/999",
      }),
      consumeActionToken: () => ({
        sessionId: "sess-discord",
        kind: "worktree-view-pr",
        targetUrl: "https://github.com/example/repo/pull/999",
      }),
      getPersistedSession: () => ({ worktreePrUrl: "https://github.com/example/repo/pull/999" }),
    } as any);

    const handler = createCallbackHandler("discord");
    const state = createCtx("discord-token", "discord");
    const result = await handler.handler(state.ctx as any);

    assert.equal(handler.channel, "discord");
    assert.deepEqual(result, { handled: true });
    assert.equal(state.componentsCleared, 1);
    assert.equal(state.replies[0], "PR: https://github.com/example/repo/pull/999");
  });

  it("launches a plan-only session from plan-offer actions", async () => {
    const launches: Array<Record<string, unknown>> = [];
    setSessionManager({
      getActionToken: () => ({
        sessionId: "plugin-readiness-v2026.5.18",
        kind: "plan-offer-start",
        route: {
          provider: "telegram",
          target: TELEGRAM_FORUM_TARGET,
          threadId: TELEGRAM_FORUM_THREAD_ID,
          sessionKey: TELEGRAM_FORUM_SESSION_KEY,
        },
        launchName: "plugin-readiness-v2026.5.18",
        launchPrompt: "Plan the required follow-up.",
        launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
        launchWorktreeStrategy: "auto-pr",
      }),
      consumeActionToken: () => ({
        sessionId: "plugin-readiness-v2026.5.18",
        kind: "plan-offer-start",
        route: {
          provider: "telegram",
          target: TELEGRAM_FORUM_TARGET,
          threadId: TELEGRAM_FORUM_THREAD_ID,
          sessionKey: TELEGRAM_FORUM_SESSION_KEY,
        },
        launchName: "plugin-readiness-v2026.5.18",
        launchPrompt: "Plan the required follow-up.",
        launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
        launchWorktreeStrategy: "auto-pr",
      }),
      launchPlanOffer: (args: Record<string, unknown>) => {
        launches.push(args);
        return { id: "sess-plan", name: "plugin-readiness-v2026.5.18" };
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-plan-offer-start");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.buttonsCleared, 1);
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal((launches[0]?.route as { threadId?: string })?.threadId, TELEGRAM_FORUM_THREAD_ID);
    assert.equal((launches[0]?.route as { sessionKey?: string })?.sessionKey, TELEGRAM_FORUM_SESSION_KEY);
    assert.equal(launches[0]?.name, "plugin-readiness-v2026.5.18");
    assert.equal(launches[0]?.prompt, "Plan the required follow-up.");
    assert.equal(launches[0]?.workdir, "/home/openclaw/workspace/openclaw-code-agent");
    assert.equal(launches[0]?.worktreeStrategy, "auto-pr");
    assert.match(state.replies[0], /Planning session started: plugin-readiness-v2026\.5\.18 \[sess-plan\]/);
  });

  it("consumes Telegram forum-topic Start Plan callbacks without surfacing raw callback text", async () => {
    const rawCallback = "code-agent:2d1bab1c-ce69-4bdb-ae5c-782504ec686e";
    const launches: Array<Record<string, unknown>> = [];
    setSessionManager({
      getActionToken: (tokenId: string) => {
        assert.equal(tokenId, "2d1bab1c-ce69-4bdb-ae5c-782504ec686e");
        return {
          sessionId: "plugin-readiness-v2026.6.1",
          kind: "plan-offer-start",
          route: {
            provider: "telegram",
            accountId: "default",
            target: TELEGRAM_FORUM_TARGET,
            threadId: TELEGRAM_FORUM_THREAD_ID,
            sessionKey: TELEGRAM_FORUM_SESSION_KEY,
          },
          launchName: "plugin-readiness-v2026.6.1",
          launchPrompt: "Plan the required follow-up.",
          launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
          launchWorktreeStrategy: "auto-pr",
        };
      },
      consumeActionToken: (tokenId: string) => {
        assert.equal(tokenId, "2d1bab1c-ce69-4bdb-ae5c-782504ec686e");
        return {
          sessionId: "plugin-readiness-v2026.6.1",
          kind: "plan-offer-start",
          route: {
            provider: "telegram",
            accountId: "default",
            target: TELEGRAM_FORUM_TARGET,
            threadId: TELEGRAM_FORUM_THREAD_ID,
            sessionKey: TELEGRAM_FORUM_SESSION_KEY,
          },
          launchName: "plugin-readiness-v2026.6.1",
          launchPrompt: "Plan the required follow-up.",
          launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
          launchWorktreeStrategy: "auto-pr",
        };
      },
      launchPlanOffer: (args: Record<string, unknown>) => {
        launches.push(args);
        return { id: "sess-plan-661", name: "plugin-readiness-v2026.6.1" };
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("ignored", "telegram", {
      telegramCallback: {
        data: rawCallback,
        payload: "2d1bab1c-ce69-4bdb-ae5c-782504ec686e",
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.equal((launches[0]?.route as { target?: string })?.target, TELEGRAM_FORUM_TARGET);
    assert.equal((launches[0]?.route as { threadId?: string })?.threadId, TELEGRAM_FORUM_THREAD_ID);
    assert.equal((launches[0]?.route as { sessionKey?: string })?.sessionKey, TELEGRAM_FORUM_SESSION_KEY);
    assert.equal(launches[0]?.worktreeStrategy, "auto-pr");
    assert.match(state.replies[0], /Planning session started: plugin-readiness-v2026\.6\.1 \[sess-plan-661\]/);
    assert.doesNotMatch(state.replies.join("\n"), /code-agent:2d1bab1c/);
  });

  it("prefers native Telegram callback_data for Start Plan when payload is not the action token", async () => {
    const rawCallback = "code-agent:2d1bab1c-ce69-4bdb-ae5c-782504ec686e";
    const launches: Array<Record<string, unknown>> = [];
    const lookups: string[] = [];
    setSessionManager({
      getActionToken: (tokenId: string) => {
        lookups.push(tokenId);
        if (tokenId !== "2d1bab1c-ce69-4bdb-ae5c-782504ec686e") return undefined;
        return {
          sessionId: "plugin-readiness-v2026.6.9",
          kind: "plan-offer-start",
          route: {
            provider: "telegram",
            accountId: "default",
            target: TELEGRAM_FORUM_TARGET,
            threadId: TELEGRAM_FORUM_THREAD_ID,
            sessionKey: TELEGRAM_FORUM_SESSION_KEY,
          },
          launchName: "plugin-readiness-v2026.6.9",
          launchPrompt: "Plan the required follow-up.",
          launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
          launchWorktreeStrategy: "auto-pr",
        };
      },
      consumeActionToken: (tokenId: string) => {
        assert.equal(tokenId, "2d1bab1c-ce69-4bdb-ae5c-782504ec686e");
        return {
          sessionId: "plugin-readiness-v2026.6.9",
          kind: "plan-offer-start",
          route: {
            provider: "telegram",
            accountId: "default",
            target: TELEGRAM_FORUM_TARGET,
            threadId: TELEGRAM_FORUM_THREAD_ID,
            sessionKey: TELEGRAM_FORUM_SESSION_KEY,
          },
          launchName: "plugin-readiness-v2026.6.9",
          launchPrompt: "Plan the required follow-up.",
          launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
          launchWorktreeStrategy: "auto-pr",
        };
      },
      launchPlanOffer: (args: Record<string, unknown>) => {
        launches.push(args);
        return { id: "sess-plan-669", name: "plugin-readiness-v2026.6.9" };
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("ignored", "telegram", {
      telegramCallback: {
        data: rawCallback,
        payload: "Start Plan",
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(lookups, ["2d1bab1c-ce69-4bdb-ae5c-782504ec686e"]);
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.equal((launches[0]?.route as { threadId?: string })?.threadId, TELEGRAM_FORUM_THREAD_ID);
    assert.equal((launches[0]?.route as { sessionKey?: string })?.sessionKey, TELEGRAM_FORUM_SESSION_KEY);
    assert.equal(launches[0]?.worktreeStrategy, "auto-pr");
    assert.match(state.replies[0], /Planning session started: plugin-readiness-v2026\.6\.9 \[sess-plan-669\]/);
    assert.doesNotMatch(state.replies.join("\n"), /code-agent:2d1bab1c/);
  });

  it("keeps using Telegram payload tokens when callback data is a non-namespaced label", async () => {
    const launches: Array<Record<string, unknown>> = [];
    const lookups: string[] = [];
    setSessionManager({
      getActionToken: (tokenId: string) => {
        lookups.push(tokenId);
        return {
          sessionId: "plugin-readiness-v2026.6.9",
          kind: "plan-offer-start",
          route: {
            provider: "telegram",
            accountId: "default",
            target: TELEGRAM_FORUM_TARGET,
            threadId: TELEGRAM_FORUM_THREAD_ID,
            sessionKey: TELEGRAM_FORUM_SESSION_KEY,
          },
          launchName: "plugin-readiness-v2026.6.9",
          launchPrompt: "Plan the required follow-up.",
          launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
          launchWorktreeStrategy: "auto-pr",
        };
      },
      consumeActionToken: (tokenId: string) => {
        assert.equal(tokenId, "payload-token");
        return {
          sessionId: "plugin-readiness-v2026.6.9",
          kind: "plan-offer-start",
          route: {
            provider: "telegram",
            accountId: "default",
            target: TELEGRAM_FORUM_TARGET,
            threadId: TELEGRAM_FORUM_THREAD_ID,
            sessionKey: TELEGRAM_FORUM_SESSION_KEY,
          },
          launchName: "plugin-readiness-v2026.6.9",
          launchPrompt: "Plan the required follow-up.",
          launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
          launchWorktreeStrategy: "auto-pr",
        };
      },
      launchPlanOffer: (args: Record<string, unknown>) => {
        launches.push(args);
        return { id: "sess-plan-payload", name: "plugin-readiness-v2026.6.9" };
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("ignored", "telegram", {
      telegramCallback: {
        data: "Start Plan",
        payload: "payload-token",
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(lookups, ["payload-token"]);
    assert.equal(launches.length, 1);
    assert.match(state.replies[0], /Planning session started: plugin-readiness-v2026\.6\.9 \[sess-plan-payload\]/);
  });

  it("consumes Telegram forum-topic Dismiss callbacks without launching a plan", async () => {
    let consumed = 0;
    let launchCount = 0;
    setSessionManager({
      getActionToken: () => ({
        sessionId: "plugin-readiness-v2026.6.1",
        kind: "plan-offer-dismiss",
        route: {
          provider: "telegram",
          target: TELEGRAM_FORUM_TARGET,
          threadId: TELEGRAM_FORUM_THREAD_ID,
          sessionKey: TELEGRAM_FORUM_SESSION_KEY,
        },
      }),
      consumeActionToken: () => {
        consumed++;
        return {
          sessionId: "plugin-readiness-v2026.6.1",
          kind: "plan-offer-dismiss",
          route: {
            provider: "telegram",
            target: TELEGRAM_FORUM_TARGET,
            threadId: TELEGRAM_FORUM_THREAD_ID,
            sessionKey: TELEGRAM_FORUM_SESSION_KEY,
          },
        };
      },
      launchPlanOffer: () => {
        launchCount++;
        return { id: "unexpected" };
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("dismiss-token", "telegram", {
      telegramCallback: {
        data: "code-agent:dismiss-token",
        payload: "dismiss-token",
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(consumed, 1);
    assert.equal(launchCount, 0);
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.equal(state.replies[0], "✅ Dismissed.");
  });

  it("saves repo policy, clears only button markup, and continues the stored launch", async () => {
    const calls: string[] = [];
    const token = {
      sessionId: "repo-policy:/repo",
      kind: "repo-policy-set" as const,
      route: {
        provider: "telegram",
        target: TELEGRAM_FORUM_TARGET,
        threadId: TELEGRAM_FORUM_THREAD_ID,
        sessionKey: TELEGRAM_FORUM_SESSION_KEY,
      },
      repoPolicy: "pr-required" as const,
      repoPolicyWorkdir: "/repo",
      launchPrompt: "Ship isolated changes",
      launchWorkdir: "/repo",
      launchName: "ship-isolated",
      launchModel: "gpt-5.5",
      launchReasoningEffort: "high" as const,
      launchFastMode: true,
      launchHarness: "codex",
      launchResumeWorktreeFrom: "stable-session-1",
      launchSessionIdOverride: "stable-session-1",
      launchClearedPersistedCodexResume: true,
      launchWorktreeStrategy: "delegate" as const,
      launchOriginAgentId: "agent-main",
    };

    setSessionManager({
      getActionToken: () => token,
      consumeActionToken: () => token,
      resolve: () => undefined,
      getPersistedSession: () => undefined,
      setRepoPolicy: (workdir: string, policy: string) => {
        calls.push(`set:${workdir}:${policy}`);
        return { policy };
      },
      clearRepoPolicyChoiceTokens: (sessionId: string) => {
        calls.push(`clear:${sessionId}`);
      },
      launchAfterRepoPolicyChoice: (args: Record<string, unknown>) => {
        calls.push(`launch:${args.prompt}:${args.harness}`);
        assert.equal(args.prompt, "Ship isolated changes");
        assert.equal(args.workdir, "/repo");
        assert.equal(args.model, "gpt-5.5");
        assert.equal(args.reasoningEffort, "high");
        assert.equal(args.fastMode, true);
        assert.equal(args.harness, "codex");
        assert.equal(args.resumeWorktreeFrom, "stable-session-1");
        assert.equal(args.sessionIdOverride, "stable-session-1");
        assert.equal(args.clearedPersistedCodexResume, true);
        assert.equal(args.worktreeStrategy, "delegate");
        assert.equal(args.originAgentId, "agent-main");
        return {
          session: { id: "sess-1", name: "ship-isolated" },
          text: "Session launched successfully\nID: sess-1",
        };
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-policy", "telegram", {
      telegramCallback: {
        messageText: "Repo policy prompt with historical context",
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(calls, [
      "set:/repo:pr-required",
      "clear:repo-policy:/repo",
      "launch:Ship isolated changes:codex",
    ]);
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.deepEqual(state.editedMessages, []);
    assert.match(state.replies[0], /Repo policy saved: Require PR/);
    assert.match(state.replies[0], /Session launched successfully/);
  });

  it("invalidates sibling repo policy tokens after one policy choice succeeds", async () => {
    const store = new SessionActionTokenStore(() => {}, 100);
    const route = {
      provider: "telegram",
      target: TELEGRAM_FORUM_TARGET,
      threadId: TELEGRAM_FORUM_THREAD_ID,
      sessionKey: TELEGRAM_FORUM_SESSION_KEY,
    };
    const baseTokenOptions = {
      route,
      repoPolicyWorkdir: "/repo",
      launchPrompt: "Ship isolated changes",
      launchWorkdir: "/repo",
    };
    const prRequiredToken = store.createActionToken("repo-policy:/repo", "repo-policy-set", {
      ...baseTokenOptions,
      repoPolicy: "pr-required",
    });
    const neverPrToken = store.createActionToken("repo-policy:/repo", "repo-policy-set", {
      ...baseTokenOptions,
      repoPolicy: "never-pr",
    });
    const outputToken = store.createActionToken("repo-policy:/repo", "view-output");

    const calls: string[] = [];
    setSessionManager({
      getActionToken: (tokenId: string) => store.getActionToken(tokenId),
      consumeActionToken: (tokenId: string) => store.consumeActionToken(tokenId),
      clearRepoPolicyChoiceTokens: (sessionId: string) => {
        calls.push(`clear:${sessionId}`);
        store.deleteActionTokensForSessionByKind(sessionId, "repo-policy-set");
      },
      resolve: () => undefined,
      getPersistedSession: () => undefined,
      setRepoPolicy: (workdir: string, policy: string) => {
        calls.push(`set:${workdir}:${policy}`);
        return { policy };
      },
      launchAfterRepoPolicyChoice: (args: Record<string, unknown>) => {
        calls.push(`launch:${args.prompt}`);
        return {
          session: { id: "sess-1", name: "ship-isolated" },
          text: "Session launched successfully\nID: sess-1",
        };
      },
    } as any);

    const handler = createCallbackHandler();
    const firstState = createCtx(prRequiredToken.id, "telegram");
    const firstResult = await handler.handler(firstState.ctx as any);

    assert.deepEqual(firstResult, { handled: true });
    assert.deepEqual(calls, [
      "set:/repo:pr-required",
      "clear:repo-policy:/repo",
      "launch:Ship isolated changes",
    ]);
    assert.equal(firstState.buttonMarkupEdits, 1);
    assert.equal(firstState.buttonsCleared, 1);
    assert.match(firstState.replies[0], /Repo policy saved: Require PR/);
    assert.equal(store.getActionToken(outputToken.id)?.id, outputToken.id);

    const secondState = createCtx(neverPrToken.id, "telegram");
    const secondResult = await handler.handler(secondState.ctx as any);

    assert.deepEqual(secondResult, { handled: true });
    assert.deepEqual(calls, [
      "set:/repo:pr-required",
      "clear:repo-policy:/repo",
      "launch:Ship isolated changes",
    ]);
    assert.equal(secondState.buttonMarkupEdits, 0);
    assert.equal(secondState.buttonsCleared, 1);
    assert.deepEqual(secondState.replies, []);
  });

  it("rejects stale repo policy callback tokens when PR automation is unavailable", async () => {
    const calls: string[] = [];
    const token = {
      sessionId: "repo-policy:/repo",
      kind: "repo-policy-set" as const,
      route: {
        provider: "telegram",
        target: TELEGRAM_FORUM_TARGET,
        threadId: TELEGRAM_FORUM_THREAD_ID,
        sessionKey: TELEGRAM_FORUM_SESSION_KEY,
      },
      repoPolicy: "pr-required" as const,
      repoPolicyWorkdir: "/repo",
      launchPrompt: "Ship isolated changes",
      launchWorkdir: "/repo",
    };

    setSessionManager({
      getActionToken: () => token,
      consumeActionToken: () => token,
      resolve: () => undefined,
      getPersistedSession: () => undefined,
      resolveRepoPolicy: () => ({
        identity: {
          key: "/repo|https://gitlab.com/example/repo",
          repoRoot: "/repo",
          remoteUrl: "https://gitlab.com/example/repo",
          provider: "unsupported",
        },
        source: "unknown",
        provider: "unsupported",
        prAvailable: false,
      }),
      setRepoPolicy: (workdir: string, policy: string) => {
        calls.push(`set:${workdir}:${policy}`);
        return { policy };
      },
      launchAfterRepoPolicyChoice: () => {
        throw new Error("should not launch");
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-policy-stale-pr", "telegram");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.deepEqual(calls, []);
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.deepEqual(state.editedMessages, []);
    assert.match(state.replies[0], /Policy pr-required requires PR automation/);
  });

  it("clears repo policy buttons when the repo cannot be resolved", async () => {
    const token = {
      sessionId: "repo-policy:/missing",
      kind: "repo-policy-set" as const,
      route: {
        provider: "telegram",
        target: TELEGRAM_FORUM_TARGET,
        threadId: TELEGRAM_FORUM_THREAD_ID,
        sessionKey: TELEGRAM_FORUM_SESSION_KEY,
      },
      repoPolicy: "pr-required" as const,
      repoPolicyWorkdir: "/missing",
      launchPrompt: "Ship isolated changes",
      launchWorkdir: "/missing",
    };

    setSessionManager({
      getActionToken: () => token,
      consumeActionToken: () => token,
      resolve: () => undefined,
      getPersistedSession: () => undefined,
      setRepoPolicy: () => undefined,
      launchAfterRepoPolicyChoice: () => {
        throw new Error("should not launch");
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-policy-missing", "telegram");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.deepEqual(state.editedMessages, []);
    assert.match(state.replies[0], /Could not resolve a git repository for \/missing/);
  });

  it("clears repo policy buttons when the deferred launch fails", async () => {
    const token = {
      sessionId: "repo-policy:/repo",
      kind: "repo-policy-set" as const,
      route: {
        provider: "telegram",
        target: TELEGRAM_FORUM_TARGET,
        threadId: TELEGRAM_FORUM_THREAD_ID,
        sessionKey: TELEGRAM_FORUM_SESSION_KEY,
      },
      repoPolicy: "pr-required" as const,
      repoPolicyWorkdir: "/repo",
      launchPrompt: "Ship isolated changes",
      launchWorkdir: "/repo",
    };

    setSessionManager({
      getActionToken: () => token,
      consumeActionToken: () => token,
      resolve: () => undefined,
      getPersistedSession: () => undefined,
      setRepoPolicy: () => ({ policy: "pr-required" }),
      clearRepoPolicyChoiceTokens: () => {},
      launchAfterRepoPolicyChoice: () => {
        throw new Error("spawn unavailable");
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-policy-launch-fails", "telegram");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.deepEqual(state.editedMessages, []);
    assert.match(state.replies[0], /Repo policy saved, but launch failed: spawn unavailable/);
  });

  it("edits Telegram message markup as a fallback when plan-offer editButtons is unavailable", async () => {
    const launches: Array<Record<string, unknown>> = [];
    setSessionManager({
      getActionToken: () => ({
        sessionId: "plugin-readiness-v2026.5.28",
        kind: "plan-offer-start",
        route: {
          provider: "telegram",
          target: TELEGRAM_FORUM_TARGET,
          threadId: TELEGRAM_FORUM_THREAD_ID,
          sessionKey: TELEGRAM_FORUM_SESSION_KEY,
        },
        launchName: "plugin-readiness-v2026.5.28",
        launchPrompt: "Plan the required follow-up.",
        launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
        launchWorktreeStrategy: "auto-pr",
      }),
      consumeActionToken: () => ({
        sessionId: "plugin-readiness-v2026.5.28",
        kind: "plan-offer-start",
        route: {
          provider: "telegram",
          target: TELEGRAM_FORUM_TARGET,
          threadId: TELEGRAM_FORUM_THREAD_ID,
          sessionKey: TELEGRAM_FORUM_SESSION_KEY,
        },
        launchName: "plugin-readiness-v2026.5.28",
        launchPrompt: "Plan the required follow-up.",
        launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
        launchWorktreeStrategy: "auto-pr",
      }),
      launchPlanOffer: (args: Record<string, unknown>) => {
        launches.push(args);
        return { id: "sess-plan-528", name: "plugin-readiness-v2026.5.28" };
      },
    } as any);

    const events: string[] = [];
    const replies: string[] = [];
    const editedMessages: string[] = [];
    let buttonsCleared = 0;
    const ctx = {
      channel: "telegram" as const,
      auth: { isAuthorizedSender: true },
      callback: {
        data: "code-agent:plan-token",
        payload: "plan-token",
        messageText: "OpenClaw release monitor: v2026.6.1",
      },
      respond: {
        acknowledge: async () => { events.push("acknowledge"); },
        editMessage: async ({ text }: { text: string }) => { editedMessages.push(text); events.push("editMessage"); },
        clearButtons: async () => { buttonsCleared++; events.push("clearButtons"); },
        reply: async ({ text }: { text: string }) => { replies.push(text); events.push("reply"); },
      },
    };

    const handler = createCallbackHandler();
    const result = await handler.handler(ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(launches.length, 1);
    assert.deepEqual(editedMessages, ["OpenClaw release monitor: v2026.6.1"]);
    assert.equal(buttonsCleared, 1);
    assert.match(replies[0], /Planning session started: plugin-readiness-v2026\.5\.28 \[sess-plan-528\]/);
    assert.deepEqual(events, ["acknowledge", "editMessage", "clearButtons", "reply"]);
  });

  it("clears Start Plan buttons when the plan-offer launch fails after consuming the token", async () => {
    setSessionManager({
      getActionToken: () => ({
        sessionId: "plugin-readiness-v2026.5.28",
        kind: "plan-offer-start",
        route: {
          provider: "telegram",
          target: TELEGRAM_FORUM_TARGET,
          threadId: TELEGRAM_FORUM_THREAD_ID,
          sessionKey: TELEGRAM_FORUM_SESSION_KEY,
        },
        launchName: "plugin-readiness-v2026.5.28",
        launchPrompt: "Plan the required follow-up.",
        launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
        launchWorktreeStrategy: "auto-pr",
      }),
      consumeActionToken: () => ({
        sessionId: "plugin-readiness-v2026.5.28",
        kind: "plan-offer-start",
        route: {
          provider: "telegram",
          target: TELEGRAM_FORUM_TARGET,
          threadId: TELEGRAM_FORUM_THREAD_ID,
          sessionKey: TELEGRAM_FORUM_SESSION_KEY,
        },
        launchName: "plugin-readiness-v2026.5.28",
        launchPrompt: "Plan the required follow-up.",
        launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
        launchWorktreeStrategy: "auto-pr",
      }),
      launchPlanOffer: () => {
        throw new Error("workdir is unavailable");
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("plan-token", "telegram", {
      telegramCallback: {
        data: "code-agent:plan-token",
        payload: "plan-token",
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.equal(state.replies[0], "⚠️ Failed to start planning session: workdir is unavailable");
    assert.deepEqual(state.events, ["acknowledge", "editButtons", "clearButtons", "reply"]);
  });

  it("clears Start Plan buttons when consumed plan-offer tokens are missing launch context", async () => {
    let launchCount = 0;
    setSessionManager({
      getActionToken: () => ({
        sessionId: "plugin-readiness-v2026.5.28",
        kind: "plan-offer-start",
        route: {
          provider: "telegram",
          target: TELEGRAM_FORUM_TARGET,
          threadId: TELEGRAM_FORUM_THREAD_ID,
          sessionKey: TELEGRAM_FORUM_SESSION_KEY,
        },
      }),
      consumeActionToken: () => ({
        sessionId: "plugin-readiness-v2026.5.28",
        kind: "plan-offer-start",
        route: {
          provider: "telegram",
          target: TELEGRAM_FORUM_TARGET,
          threadId: TELEGRAM_FORUM_THREAD_ID,
          sessionKey: TELEGRAM_FORUM_SESSION_KEY,
        },
      }),
      launchPlanOffer: () => {
        launchCount++;
        return { id: "unexpected", name: "unexpected" };
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("plan-token", "telegram", {
      telegramCallback: {
        data: "code-agent:plan-token",
        payload: "plan-token",
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(launchCount, 0);
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.equal(state.replies[0], "⚠️ This action is missing the plan launch context.");
    assert.deepEqual(state.events, ["acknowledge", "editButtons", "clearButtons", "reply"]);
  });

  it("clears Start Plan buttons quietly when an already-started plan-offer callback is retried", async () => {
    let consumes = 0;
    setSessionManager({
      getActionToken: () => ({
        sessionId: "plugin-readiness-v2026.5.28",
        kind: "plan-offer-start",
        consumedAt: Date.now(),
        route: {
          provider: "telegram",
          target: TELEGRAM_FORUM_TARGET,
          threadId: TELEGRAM_FORUM_THREAD_ID,
          sessionKey: TELEGRAM_FORUM_SESSION_KEY,
        },
      }),
      consumeActionToken: () => {
        consumes++;
        return undefined;
      },
      launchPlanOffer: () => {
        throw new Error("should not relaunch");
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("plan-token", "telegram", {
      telegramCallback: {
        data: "code-agent:plan-token",
        payload: "plan-token",
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(consumes, 1);
    assert.equal(state.buttonMarkupEdits, 1);
    assert.equal(state.buttonsCleared, 1);
    assert.deepEqual(state.replies, []);
    assert.doesNotMatch(state.replies.join("\n"), /code-agent:plan-token/);
  });

  it("blocks unauthorized Telegram topic callbacks before consuming the token", async () => {
    let lookups = 0;
    let consumes = 0;
    setSessionManager({
      getActionToken: () => {
        lookups++;
        return undefined;
      },
      consumeActionToken: () => {
        consumes++;
        return undefined;
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("approve-token", "telegram", { authorized: false });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(lookups, 0);
    assert.equal(consumes, 0);
    assert.equal(state.replies[0], "⛔ Unauthorized.");
  });
});
