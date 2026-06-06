import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCallbackHandler } from "../src/callback-handler";
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
          reply: async ({ text }: { text: string }) => { replies.push(text); events.push("reply"); },
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
    assert.deepEqual(state.events.slice(0, 2), ["acknowledge", "clearButtons"]);
    assert.equal(switchedTo, "bypassPermissions");
    assert.deepEqual(state.replies, []);
  });

  it("acknowledges Telegram callbacks before terminal cleanup and agent work", async () => {
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
    assert.deepEqual(events.slice(0, 3), ["acknowledge", "getActionToken", "consumeActionToken"]);
    assert.ok(events.indexOf("clearButtons") < events.indexOf("sendMessage"));
    assert.ok(events.indexOf("acknowledge") < events.indexOf("clearButtons"));
    assert.deepEqual(replies, []);
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
    setSessionManager({
      getActionToken: () => undefined,
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("ignored", "telegram", {
      telegramCallback: {
        data: "code-agent:",
        payload: "",
      },
    });
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.callbacksAcknowledged, 1);
    assert.deepEqual(state.replies, ["⚠️ Unrecognized callback payload."]);
    assert.doesNotMatch(state.replies.join("\n"), /code-agent:/);
  });

  it("resolves question-answer callbacks by session and option index", async () => {
    const resolved: Array<{ sessionId: string; optionIndex: number }> = [];
    setSessionManager({
      getActionToken: () => ({ sessionId: "sess-42", kind: "question-answer", optionIndex: 1 }),
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

  it("rewrites worktree decision prompts to a single snoozed confirmation", async () => {
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
    assert.deepEqual(state.editedMessages, ["⏭️ Snoozed 24h for [ux-fix]"]);
    assert.equal(state.buttonsCleared, 1);
    assert.deepEqual(state.replies, []);
    assert.deepEqual(state.events, ["acknowledge", "editMessage", "clearButtons"]);
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
    assert.deepEqual(success.editedMessages, ["🗑️ Discarded for [ux-fix]"]);
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

  it("resolves Discord worktree prompts via clearComponents text updates and replies ephemerally", async () => {
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
    assert.deepEqual(clearedMessages, [{ text: "⏭️ Snoozed 24h for [ux-fix]" }]);
    assert.deepEqual(replies, []);
  });

  it("falls back to clearing Telegram buttons when worktree prompt edit fails", async () => {
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
      assert.match(
        warnings[0],
        /Failed to edit Telegram worktree prompt before clearing buttons: telegram edit failed/,
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("updates Discord worktree prompts when only clearButtons is available", async () => {
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
      assert.deepEqual(editedMessages, ["⏭️ Snoozed 24h for [ux-fix]"]);
      assert.equal(buttonsCleared, 1);
      assert.deepEqual(replies, []);
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
      assert.match(warnings[0], /clearComponents failed before text fallback: clearComponents failed/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("clears Discord worktree prompts when editMessage reports message is not modified", async () => {
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
      assert.deepEqual(replies, []);
      assert.deepEqual(warnings, []);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("clears Discord worktree prompts when editMessage throws before buttons are cleared", async () => {
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
      assert.match(warnings[0], /Failed to edit worktree prompt before clearing interactive state: edit failed/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("does not retry Discord worktree prompt cleanup after a post-edit clear failure", async () => {
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
      assert.deepEqual(editedMessages, ["⏭️ Snoozed 24h for [ux-fix]"]);
      assert.equal(clearAttempts, 1);
      assert.deepEqual(replies, ["⏭️ Snoozed 24h for [ux-fix]"]);
      assert.match(warnings[0], /Failed to resolve worktree prompt: clear failed/);
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

  it("does not clear Start Plan buttons when the plan-offer launch truly fails", async () => {
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
    assert.equal(state.buttonMarkupEdits, 0);
    assert.equal(state.buttonsCleared, 0);
    assert.equal(state.replies[0], "⚠️ Failed to start planning session: workdir is unavailable");
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
