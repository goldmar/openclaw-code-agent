import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCallbackHandler } from "../src/callback-handler";
import { setSessionManager } from "../src/singletons";
import { createStubSession } from "./helpers";

function createCtx(payload: string, channel: "telegram" | "discord" = "telegram") {
  const replies: string[] = [];
  const editedMessages: string[] = [];
  let buttonsCleared = 0;
  let componentsCleared = 0;
  const ctx = channel === "telegram"
    ? {
        channel,
        auth: { isAuthorizedSender: true },
        callback: { payload },
        respond: {
          reply: async ({ text }: { text: string }) => { replies.push(text); },
          clearButtons: async () => { buttonsCleared++; },
          editMessage: async ({ text }: { text: string }) => { editedMessages.push(text); },
        },
      }
    : {
        channel,
        auth: { isAuthorizedSender: true },
        interaction: { payload },
        respond: {
          acknowledge: async () => {},
          reply: async ({ text }: { text: string }) => { replies.push(text); },
          followUp: async ({ text }: { text: string }) => { replies.push(text); },
          editMessage: async ({ text }: { text?: string }) => {
            if (typeof text === "string") editedMessages.push(text);
          },
          clearComponents: async ({ text }: { text?: string } = {}) => {
            componentsCleared++;
            if (typeof text === "string") editedMessages.push(text);
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
    get componentsCleared() {
      return componentsCleared;
    },
  };
}

describe("createCallbackHandler()", () => {
  beforeEach(() => {
    setSessionManager(null);
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
    assert.equal(switchedTo, "bypassPermissions");
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
      pendingPlanApproval: false,
      planApprovalContext: undefined,
      planDecisionVersion: 5,
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

  it("rewrites worktree decision prompts to a resolved state before replying", async () => {
    setSessionManager({
      getActionToken: () => ({ sessionId: "sess-42", kind: "worktree-decide-later" }),
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
      assert.equal(replies[0], "⏭️ Snoozed 24h");
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
      assert.deepEqual(editedMessages, ["⏭️ Deferred for [ux-fix]"]);
      assert.equal(buttonsCleared, 1);
      assert.equal(replies[0], "⏭️ Snoozed 24h");
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
      assert.equal(replies[0], "⏭️ Snoozed 24h");
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
      assert.equal(replies[0], "⏭️ Snoozed 24h");
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
      assert.equal(replies[0], "⏭️ Snoozed 24h");
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
      assert.deepEqual(editedMessages, ["⏭️ Deferred for [ux-fix]"]);
      assert.equal(clearAttempts, 1);
      assert.equal(replies[0], "⏭️ Snoozed 24h");
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

  it("launches a plan-only session from monitor report actions", async () => {
    const launches: Array<Record<string, unknown>> = [];
    setSessionManager({
      getActionToken: () => ({
        sessionId: "openclaw-release-v2026.3.31",
        kind: "monitor-start-plan",
        route: {
          provider: "telegram",
          target: "-1003863755361",
          threadId: "13832",
          sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
        },
        launchName: "oc-release-v2026.3.31",
        launchPrompt: "Plan the required follow-up.",
        launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
      }),
      consumeActionToken: () => ({
        sessionId: "openclaw-release-v2026.3.31",
        kind: "monitor-start-plan",
        route: {
          provider: "telegram",
          target: "-1003863755361",
          threadId: "13832",
          sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
        },
        launchName: "oc-release-v2026.3.31",
        launchPrompt: "Plan the required follow-up.",
        launchWorkdir: "/home/openclaw/workspace/openclaw-code-agent",
      }),
      launchMonitorPlan: (args: Record<string, unknown>) => {
        launches.push(args);
        return { id: "sess-plan", name: "oc-release-v2026.3.31" };
      },
    } as any);

    const handler = createCallbackHandler();
    const state = createCtx("token-monitor-start");
    const result = await handler.handler(state.ctx as any);

    assert.deepEqual(result, { handled: true });
    assert.equal(state.buttonsCleared, 1);
    assert.equal(launches[0]?.workdir, "/home/openclaw/workspace/openclaw-code-agent");
    assert.match(state.replies[0], /Planning session started: oc-release-v2026\.3\.31 \[sess-plan\]/);
  });
});
