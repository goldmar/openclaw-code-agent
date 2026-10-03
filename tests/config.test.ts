import "./test-env";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setPluginConfig,
  pluginConfig,
  isCommandInRouteChat,
  resolveAgentChannel,
  extractAgentId,
  resolveAgentId,
  resolveOriginChannel,
  resolveOriginThreadId,
  resolveSessionRoute,
  resolveToolChannel,
} from "../src/config";
import { parseThreadIdFromSessionKey } from "../src/session-route";

beforeEach(() => {
  setPluginConfig({});
});

describe("resolveAgentChannel", () => {
  it("returns undefined when no agentChannels configured", () => {
    assert.equal(resolveAgentChannel("/foo"), undefined);
  });

  it("matches exact path", () => {
    setPluginConfig({ agentChannels: { "/home/user/project": "telegram|bot1|123" } });
    assert.equal(resolveAgentChannel("/home/user/project"), "telegram|bot1|123");
  });

  it("matches prefix", () => {
    setPluginConfig({ agentChannels: { "/home/user": "telegram|bot1|123" } });
    assert.equal(resolveAgentChannel("/home/user/project/sub"), "telegram|bot1|123");
  });

  it("picks longest-prefix match", () => {
    setPluginConfig({
      agentChannels: {
        "/home/user": "telegram|bot1|short",
        "/home/user/project": "telegram|bot1|long",
      },
    });
    assert.equal(resolveAgentChannel("/home/user/project/sub"), "telegram|bot1|long");
  });

  it("normalizes trailing slashes", () => {
    setPluginConfig({ agentChannels: { "/home/user/": "telegram|bot1|123" } });
    assert.equal(resolveAgentChannel("/home/user"), "telegram|bot1|123");
  });

  it("normalizes long runs of trailing slashes in linear time", () => {
    const trailingSlashes = "/".repeat(100_000);
    setPluginConfig({ agentChannels: { [`/home/user${trailingSlashes}`]: "telegram|bot1|123" } });
    assert.equal(resolveAgentChannel(`/home/user${trailingSlashes}`), "telegram|bot1|123");
  });

  it("returns undefined for non-matching path", () => {
    setPluginConfig({ agentChannels: { "/home/user/project": "telegram|bot1|123" } });
    assert.equal(resolveAgentChannel("/other/path"), undefined);
  });
});

describe("extractAgentId", () => {
  it("extracts middle part from 3-segment channel", () => {
    assert.equal(extractAgentId("telegram|bot123|456"), "bot123");
  });

  it("returns undefined for 2-segment channel", () => {
    assert.equal(extractAgentId("telegram|456"), undefined);
  });

  it("returns undefined for single segment", () => {
    assert.equal(extractAgentId("telegram"), undefined);
  });
});

describe("resolveAgentId", () => {
  it("combines resolveAgentChannel + extractAgentId", () => {
    setPluginConfig({ agentChannels: { "/home/user": "telegram|bot1|123" } });
    assert.equal(resolveAgentId("/home/user"), "bot1");
  });

  it("returns undefined when no channel match", () => {
    assert.equal(resolveAgentId("/no/match"), undefined);
  });
});

describe("parseThreadIdFromSessionKey", () => {
  it("parses thread ID from key with topic", () => {
    assert.equal(parseThreadIdFromSessionKey("abc:topic:123"), 123);
  });

  it("parses thread ID from key with mixed-case topic marker", () => {
    assert.equal(parseThreadIdFromSessionKey("abc:Topic:123"), 123);
  });

  it("returns undefined when no topic segment", () => {
    assert.equal(parseThreadIdFromSessionKey("abc:def"), undefined);
  });

  it("returns undefined when topic ID is not numeric", () => {
    assert.equal(parseThreadIdFromSessionKey("abc:topic:not-a-number"), undefined);
  });

  it("returns undefined for undefined input", () => {
    assert.equal(parseThreadIdFromSessionKey(undefined), undefined);
  });
});

describe("resolveOriginChannel", () => {
  it("passes through explicit channel with pipe", () => {
    assert.equal(resolveOriginChannel({}, "telegram|123"), "telegram|123");
  });

  it("builds from ctx.channel + chatId", () => {
    assert.equal(resolveOriginChannel({ channel: "telegram", chatId: "99" }), "telegram|99");
  });

  it("falls back to ctx.channel + senderId", () => {
    assert.equal(resolveOriginChannel({ channel: "slack", senderId: "U1" }), "slack|U1");
  });

  it("preserves non-Telegram sender fallback with thread metadata", () => {
    assert.equal(resolveOriginChannel({ messageChannel: "slack", senderId: "U1", messageThreadId: "1718048480.000000" }), "slack|U1");
  });

  it("preserves Telegram sender fallback without topic metadata", () => {
    assert.equal(resolveOriginChannel({ messageChannel: "telegram", senderId: "5551234" }), "telegram|5551234");
  });

  it("uses telegram fallback for numeric ctx.id", () => {
    assert.equal(resolveOriginChannel({ id: "12345" }), "telegram|12345");
  });

  it("uses ctx.channelId if it contains pipe", () => {
    assert.equal(resolveOriginChannel({ channelId: "discord|789" }), "discord|789");
  });

  it("builds from tool-style messageChannel + chatId", () => {
    assert.equal(resolveOriginChannel({ messageChannel: "telegram", chatId: "-1001234567890" }), "telegram|-1001234567890");
  });

  it("prefers deliveryContext routing from the current SDK surface", () => {
    assert.equal(
      resolveOriginChannel({
        deliveryContext: {
          channel: "telegram",
          to: "-1001234567890",
          accountId: "bot1",
        },
        messageChannel: "telegram",
      }),
      "telegram|bot1|-1001234567890",
    );
  });

  it("keeps Telegram topic sessions weak when only senderId is available", () => {
    assert.equal(
      resolveOriginChannel({
        messageChannel: "telegram",
        senderId: "5551234",
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
      }),
      "unknown",
    );
  });

  it("keeps Telegram message thread routes weak when only senderId is available", () => {
    assert.equal(
      resolveOriginChannel({
        messageChannel: "telegram",
        senderId: "5551234",
        messageThreadId: 13832,
      }),
      "unknown",
    );
  });

  it("keeps legacy Telegram channel thread routes weak when only senderId is available", () => {
    assert.equal(
      resolveOriginChannel({
        channel: "telegram",
        senderId: "5551234",
        messageThreadId: 13832,
      }),
      "unknown",
    );
  });

  it("keeps Telegram delivery thread routes weak when only senderId is available", () => {
    assert.equal(
      resolveOriginChannel({
        deliveryContext: {
          channel: "telegram",
          threadId: 13832,
        },
        messageChannel: "telegram",
        senderId: "5551234",
      }),
      "unknown",
    );
  });

  it("prefers ctx.channelId over lossy ctx.channel + chatId reconstruction", () => {
    assert.equal(
      resolveOriginChannel({
        channel: "telegram",
        chatId: "99",
        channelId: "telegram|bot1|99",
      }),
      "telegram|bot1|99",
    );
  });

  it("returns 'unknown' for empty ctx with no fallback", () => {
    assert.equal(resolveOriginChannel({}), "unknown");
  });

  it("uses fallbackChannel from config", () => {
    setPluginConfig({ fallbackChannel: "telegram|default" });
    assert.equal(resolveOriginChannel({}), "telegram|default");
  });
});

describe("resolveSessionRoute", () => {
  it("builds a direct Telegram route from chat context", () => {
    assert.deepEqual(
      resolveSessionRoute({ messageChannel: "telegram", chatId: "-1001234567890", messageThreadId: 28 }),
      {
        provider: "telegram",
        accountId: undefined,
        target: "-1001234567890",
        threadId: "28",
        sessionKey: undefined,
      },
    );
  });

  it("builds a direct Telegram route from deliveryContext", () => {
    assert.deepEqual(
      resolveSessionRoute({
        deliveryContext: {
          channel: "telegram",
          to: "-1001234567890",
          accountId: "bot1",
          threadId: 28,
        },
      }),
      {
        provider: "telegram",
        accountId: "bot1",
        target: "-1001234567890",
        threadId: "28",
        sessionKey: undefined,
      },
    );
  });

  it("recovers a Telegram topic route from originSessionKey when the channel is weak", () => {
    assert.deepEqual(
      resolveSessionRoute({
        messageChannel: "telegram",
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:28",
      }),
      {
        provider: "telegram",
        target: "-1001234567890",
        threadId: "28",
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:28",
      },
    );
  });

  it("recovers a Telegram route from the internal webchat CLI envelope", () => {
    assert.deepEqual(
      resolveSessionRoute({
        deliveryContext: {
          channel: "webchat",
          to: "cli",
        },
        messageChannel: "webchat",
        sessionKey: "agent:main:telegram:direct:123456789",
      }),
      {
        provider: "telegram",
        target: "123456789",
        threadId: undefined,
        sessionKey: "agent:main:telegram:direct:123456789",
      },
    );
  });

  it("keeps trusted WebChat delivery internal when the UI opens a Telegram topic session", () => {
    const sessionKey = "agent:main:telegram:group:-1001234567890:topic:28";
    assert.deepEqual(resolveSessionRoute({
      deliveryContext: { channel: "webchat", to: sessionKey },
      messageChannel: "webchat",
      sessionKey,
    }), {
      provider: "webchat",
      accountId: undefined,
      target: sessionKey,
      threadId: undefined,
      sessionKey,
    });
  });

  it("ignores Telegram senderId fallback when a topic session key is available", () => {
    assert.deepEqual(
      resolveSessionRoute({
        messageChannel: "telegram",
        senderId: "5551234",
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
      }),
      {
        provider: "telegram",
        target: "-1001234567890",
        threadId: "13832",
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
      },
    );
  });

  it("preserves Telegram sender fallback without topic metadata in session routes", () => {
    assert.deepEqual(
      resolveSessionRoute({
        messageChannel: "telegram",
        senderId: "5551234",
      }),
      {
        provider: "telegram",
        accountId: undefined,
        target: "5551234",
        threadId: undefined,
        sessionKey: undefined,
      },
    );
  });

  it("ignores Telegram senderId fallback when messageThreadId is available", () => {
    assert.deepEqual(
      resolveSessionRoute({
        messageChannel: "telegram",
        senderId: "5551234",
        messageThreadId: 13832,
      }),
      {
        provider: "system",
        target: "system",
        sessionKey: undefined,
      },
    );
  });

  it("ignores legacy Telegram senderId fallback when messageThreadId is available", () => {
    assert.deepEqual(
      resolveSessionRoute({
        channel: "telegram",
        senderId: "5551234",
        messageThreadId: 13832,
      }),
      {
        provider: "system",
        target: "system",
        sessionKey: undefined,
      },
    );
  });

  it("ignores Telegram senderId fallback when deliveryContext.threadId is available", () => {
    assert.deepEqual(
      resolveSessionRoute({
        deliveryContext: {
          channel: "telegram",
          threadId: 13832,
        },
        messageChannel: "telegram",
        senderId: "5551234",
      }),
      {
        provider: "system",
        target: "system",
        sessionKey: undefined,
      },
    );
  });

  it("falls back to an explicit system route when chat metadata is unavailable", () => {
    assert.deepEqual(resolveSessionRoute({}), {
      provider: "system",
      target: "system",
      sessionKey: undefined,
    });
  });
});

describe("resolveToolChannel", () => {
  it("builds 3-segment from messageChannel + agentAccountId", () => {
    const ctx = { messageChannel: "telegram|123", agentAccountId: "bot1" };
    assert.equal(resolveToolChannel(ctx), "telegram|bot1|123");
  });

  it("preserves an already account-qualified messageChannel", () => {
    const ctx = { messageChannel: "telegram|bot1|123", agentAccountId: "bot2" };
    assert.equal(resolveToolChannel(ctx), "telegram|bot1|123");
  });

  it("falls back to agentChannels lookup via workspaceDir", () => {
    setPluginConfig({ agentChannels: { "/home/user": "telegram|bot1|456" } });
    const ctx = { workspaceDir: "/home/user/project" };
    assert.equal(resolveToolChannel(ctx), "telegram|bot1|456");
  });

  it("falls back to raw messageChannel with pipe", () => {
    const ctx = { messageChannel: "telegram|789" };
    assert.equal(resolveToolChannel(ctx), "telegram|789");
  });

  it("builds from provider-only messageChannel + chatId", () => {
    const ctx = { messageChannel: "telegram", chatId: "-1001234567890" };
    assert.equal(resolveToolChannel(ctx), "telegram|-1001234567890");
  });

  it("prefers deliveryContext when present", () => {
    const ctx = {
      deliveryContext: {
        channel: "telegram",
        to: "-1001234567890",
        accountId: "bot1",
      },
      messageChannel: "telegram",
      agentAccountId: "bot2",
    };
    assert.equal(resolveToolChannel(ctx), "telegram|bot1|-1001234567890");
  });

  it("does not derive Telegram topic routes from senderId", () => {
    const ctx = {
      messageChannel: "telegram",
      senderId: "5551234",
      sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
    };
    assert.equal(resolveToolChannel(ctx), undefined);
  });

  it("does not derive Telegram message thread routes from senderId", () => {
    const ctx = {
      messageChannel: "telegram",
      senderId: "5551234",
      messageThreadId: 13832,
    };
    assert.equal(resolveToolChannel(ctx), undefined);
  });

  it("does not derive Telegram delivery thread routes from senderId", () => {
    const ctx = {
      deliveryContext: {
        channel: "telegram",
        threadId: 13832,
      },
      messageChannel: "telegram",
      senderId: "5551234",
    };
    assert.equal(resolveToolChannel(ctx), undefined);
  });

  it("preserves Telegram sender fallback without topic metadata", () => {
    const ctx = {
      messageChannel: "telegram",
      senderId: "5551234",
    };
    assert.equal(resolveToolChannel(ctx), "telegram|5551234");
  });

  it("preserves non-Telegram sender fallback with thread metadata", () => {
    const ctx = {
      messageChannel: "slack",
      senderId: "U1",
      messageThreadId: "1718048480.000000",
    };
    assert.equal(resolveToolChannel(ctx), "slack|U1");
  });

  it("returns undefined when nothing matches", () => {
    const ctx = {};
    assert.equal(resolveToolChannel(ctx), undefined);
  });

  it("returns undefined for messageChannel without pipe and no other matches", () => {
    const ctx = { messageChannel: "nopipe" };
    assert.equal(resolveToolChannel(ctx), undefined);
  });
});

// ---------------------------------------------------------------------------
// setPluginConfig
// ---------------------------------------------------------------------------

describe("setPluginConfig", () => {
  it("applies all provided fields", () => {
    setPluginConfig({
      maxSessions: 10,
      harnesses: {
        "claude-code": {
          defaultModel: "opus",
          allowedModels: ["opus"],
        },
        codex: {
          defaultModel: "gpt-5.3-codex",
          allowedModels: ["gpt-5.3-codex", "gpt-5.4"],
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      defaultWorkdir: "/work",
      idleTimeoutMinutes: 60,
      sessionGcAgeMinutes: 120,
      maxPersistedSessions: 100,
      fallbackChannel: "telegram|fallback",
      agentChannels: { "/a": "telegram|b|c" },
      maxAutoResponds: 20,
      permissionMode: "bypassPermissions",
      planApproval: "ask",
    });
    assert.equal(pluginConfig.maxSessions, 10);
    assert.equal(pluginConfig.harnesses["claude-code"]?.defaultModel, "opus");
    assert.deepEqual(pluginConfig.harnesses["claude-code"]?.allowedModels, ["opus"]);
    assert.equal(pluginConfig.harnesses.codex?.defaultModel, "gpt-5.3-codex");
    assert.deepEqual(pluginConfig.harnesses.codex?.allowedModels, ["gpt-5.3-codex", "gpt-5.4"]);
    assert.equal(pluginConfig.harnesses.codex?.reasoningEffort, "high");
    assert.equal(pluginConfig.harnesses.codex?.fastMode, true);
    assert.equal(pluginConfig.defaultWorkdir, "/work");
    assert.equal(pluginConfig.idleTimeoutMinutes, 60);
    assert.equal(pluginConfig.sessionGcAgeMinutes, 120);
    assert.equal(pluginConfig.maxPersistedSessions, 100);
    assert.equal(pluginConfig.fallbackChannel, "telegram|fallback");
    assert.deepEqual(pluginConfig.agentChannels, { "/a": "telegram|b|c" });
    assert.equal(pluginConfig.maxAutoResponds, 20);
    assert.equal(pluginConfig.permissionMode, "bypassPermissions");
    assert.equal(pluginConfig.planApproval, "ask");
  });

  it("applies Codex execution settings and ignores the removed top-level codexApprovalPolicy key", () => {
    setPluginConfig({
      harnesses: {
        codex: {
          approvalPolicy: "on-request",
          permissionProfile: ":workspace",
          approvalsReviewer: "auto_review",
        },
      },
      codexApprovalPolicy: "on-request" as any,
    } as any);

    assert.equal(pluginConfig.harnesses.codex?.approvalPolicy, "on-request");
    assert.equal(pluginConfig.harnesses.codex?.permissionProfile, ":workspace");
    assert.equal(pluginConfig.harnesses.codex?.approvalsReviewer, "auto_review");
    assert.equal("codexApprovalPolicy" in pluginConfig, false);
  });

  it("leaves Codex execution keys unset so they follow the host tools.exec.mode", () => {
    setPluginConfig({});
    assert.equal(pluginConfig.harnesses.codex?.permissionProfile, undefined);
    assert.equal(pluginConfig.harnesses.codex?.approvalPolicy, undefined);
    assert.equal(pluginConfig.harnesses.codex?.approvalsReviewer, undefined);
  });

  it("keeps explicitly configured Codex execution keys", () => {
    setPluginConfig({ harnesses: { codex: { permissionProfile: ":danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" } } });
    assert.equal(pluginConfig.harnesses.codex?.permissionProfile, ":danger-full-access");
    assert.equal(pluginConfig.harnesses.codex?.approvalPolicy, "never");
    assert.equal(pluginConfig.harnesses.codex?.approvalsReviewer, "user");
  });

  it("accepts current SDK readiness extended reasoning efforts", () => {
    setPluginConfig({
      harnesses: {
        codex: {
          reasoningEffort: "xhigh",
        },
        "claude-code": {
          reasoningEffort: "max",
        },
      },
    });

    assert.equal(pluginConfig.harnesses.codex?.reasoningEffort, "xhigh");
    assert.equal(pluginConfig.harnesses["claude-code"]?.reasoningEffort, "max");
  });

  it("uses defaults for missing numeric fields", () => {
    setPluginConfig({});
    assert.equal(pluginConfig.maxSessions, 20);
    assert.equal(pluginConfig.idleTimeoutMinutes, 15);
    assert.equal(pluginConfig.sessionGcAgeMinutes, 1440);
    assert.equal(pluginConfig.maxPersistedSessions, 10000);
    assert.equal(pluginConfig.maxAutoResponds, 10);
    assert.equal(pluginConfig.harnesses["claude-code"]?.defaultModel, "opus");
    assert.deepEqual(pluginConfig.harnesses["claude-code"]?.allowedModels, ["sonnet", "opus"]);
    assert.equal(pluginConfig.harnesses.codex?.defaultModel, "gpt-6.1-sol");
    assert.deepEqual(pluginConfig.harnesses.codex?.allowedModels, ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    assert.equal(pluginConfig.harnesses.codex?.reasoningEffort, "medium");
    assert.equal(pluginConfig.harnesses.codex?.fastMode, undefined);
    assert.deepEqual(pluginConfig.harnesses.opencode, {});
  });

  it("uses default for missing permissionMode", () => {
    setPluginConfig({});
    assert.equal(pluginConfig.permissionMode, "plan");
  });

  it("drops built-in allowedModels when a harness sets a custom defaultModel", () => {
    setPluginConfig({
      harnesses: {
        codex: {
          defaultModel: "gpt-5.3-codex",
        },
      },
    });

    assert.equal(pluginConfig.harnesses.codex?.defaultModel, "gpt-5.3-codex");
    assert.equal(pluginConfig.harnesses.codex?.allowedModels, undefined);
  });

  it("uses default for missing planApproval", () => {
    setPluginConfig({});
    assert.equal(pluginConfig.planApproval, "delegate");
  });

  it("uses default for missing defaultWorktreeStrategy", () => {
    setPluginConfig({});
    assert.equal(pluginConfig.defaultWorktreeStrategy, "delegate");
  });

  it("preserves optional fields as undefined when not provided", () => {
    setPluginConfig({});
    assert.equal(pluginConfig.harnesses["claude-code"]?.defaultModel, "opus");
    assert.deepEqual(pluginConfig.harnesses["claude-code"]?.allowedModels, ["sonnet", "opus"]);
    assert.equal(pluginConfig.harnesses.codex?.defaultModel, "gpt-6.1-sol");
    assert.deepEqual(pluginConfig.harnesses.codex?.allowedModels, ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    assert.deepEqual(pluginConfig.harnesses.opencode, {});
    assert.equal(pluginConfig.defaultWorkdir, undefined);
    assert.equal(pluginConfig.fallbackChannel, undefined);
    assert.equal(pluginConfig.agentChannels, undefined);
    assert.equal("allowedModels" in pluginConfig, false);
  });

  it("handles empty object input", () => {
    setPluginConfig({});
    // Should not throw, and all defaults should be applied
    assert.equal(pluginConfig.maxSessions, 20);
    assert.equal(pluginConfig.planApproval, "delegate");
  });
});

// ---------------------------------------------------------------------------
// resolveOriginThreadId
// ---------------------------------------------------------------------------

describe("resolveOriginThreadId", () => {
  it("returns messageThreadId from context", () => {
    assert.equal(resolveOriginThreadId({ messageThreadId: 42 }), 42);
  });

  it("prefers deliveryContext.threadId from the current SDK surface", () => {
    assert.equal(resolveOriginThreadId({ deliveryContext: { threadId: 77 }, messageThreadId: 42 }), "77");
  });

  it("returns string messageThreadId from context", () => {
    assert.equal(resolveOriginThreadId({ messageThreadId: "topic-1" }), "topic-1");
  });

  it("returns undefined when messageThreadId is absent", () => {
    assert.equal(resolveOriginThreadId({}), undefined);
  });

  it("returns undefined for undefined context", () => {
    assert.equal(resolveOriginThreadId(undefined), undefined);
  });

  it("returns undefined for null context", () => {
    assert.equal(resolveOriginThreadId(null), undefined);
  });
});

// ---------------------------------------------------------------------------
// pluginConfig singleton behavior
// ---------------------------------------------------------------------------

describe("pluginConfig singleton", () => {
  it("pluginConfig reflects initial defaults after reset", () => {
    setPluginConfig({});
    assert.equal(pluginConfig.maxSessions, 20);
    assert.equal(pluginConfig.idleTimeoutMinutes, 15);
    assert.equal(pluginConfig.sessionGcAgeMinutes, 1440);
    assert.equal(pluginConfig.maxPersistedSessions, 10000);
    assert.equal(pluginConfig.maxAutoResponds, 10);
    assert.equal(pluginConfig.permissionMode, "plan");
    assert.equal(pluginConfig.planApproval, "delegate");
    assert.equal(pluginConfig.defaultWorktreeStrategy, "delegate");
    assert.equal(pluginConfig.harnesses["claude-code"]?.defaultModel, "opus");
    assert.deepEqual(pluginConfig.harnesses["claude-code"]?.allowedModels, ["sonnet", "opus"]);
    assert.equal(pluginConfig.harnesses.codex?.defaultModel, "gpt-6.1-sol");
    assert.deepEqual(pluginConfig.harnesses.codex?.allowedModels, ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    assert.equal(pluginConfig.harnesses.codex?.reasoningEffort, "medium");
    assert.equal(pluginConfig.harnesses.codex?.fastMode, undefined);
    assert.deepEqual(pluginConfig.harnesses.opencode, {});
  });

  it("setPluginConfig mutates the module-level singleton", () => {
    setPluginConfig({ maxSessions: 99 });
    assert.equal(pluginConfig.maxSessions, 99);
    // Reset for other tests
    setPluginConfig({});
    assert.equal(pluginConfig.maxSessions, 20);
  });
});

describe("autoUpdate config", () => {
  it("defaults to enabled and honors an explicit false", () => {
    setPluginConfig({});
    assert.equal(pluginConfig.autoUpdate, true);
    setPluginConfig({ autoUpdate: false });
    assert.equal(pluginConfig.autoUpdate, false);
    setPluginConfig({ autoUpdate: true });
    assert.equal(pluginConfig.autoUpdate, true);
  });
});

describe("isCommandInRouteChat", () => {
  // The host's PluginCommandContext: `channel`, `senderId`, `sessionKey`, `to`
  // and `messageThreadId`, without a `deliveryContext`.
  const topicRoute = { provider: "telegram", target: "-1001234567890", threadId: "42", sessionKey: "agent:main:telegram:group:-1001234567890:topic:42" };
  const topicCommand = {
    channel: "telegram",
    senderId: "1234",
    sessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
    to: "telegram:-1001234567890",
    messageThreadId: 42,
  };
  const dmRoute = { provider: "telegram", target: "1234", sessionKey: "agent:main:main" };
  const dmCommand = { channel: "telegram", senderId: "1234", sessionKey: "agent:main:main", to: "telegram:1234" };

  it("is true for a command typed in the session's Telegram topic", () => {
    assert.equal(isCommandInRouteChat(topicCommand, { route: topicRoute }), true);
    assert.equal(isCommandInRouteChat({ ...topicCommand, messageThreadId: "42" }, { route: topicRoute }), true);
  });

  it("is false for another topic of the same group", () => {
    assert.equal(isCommandInRouteChat({ ...topicCommand, messageThreadId: 7 }, { route: topicRoute }), false);
    assert.equal(isCommandInRouteChat({ ...topicCommand, messageThreadId: undefined }, { route: topicRoute }), false);
    // The session key alone does not make it the same chat.
    assert.equal(
      isCommandInRouteChat({ ...topicCommand, to: "telegram:-1009876543210" }, { route: topicRoute }),
      false,
    );
  });

  it("is true for a command typed in the session's Telegram DM", () => {
    assert.equal(isCommandInRouteChat(dmCommand, { route: dmRoute }), true);
    assert.equal(isCommandInRouteChat(dmCommand, { route: { ...dmRoute, target: "telegram:1234" } }), true);
  });

  it("is false for the shared main session key from another provider or DM", () => {
    // Discord and Slack commands carry `to: "slash:<user id>"`, not the chat.
    for (const channel of ["discord", "slack"]) {
      assert.equal(isCommandInRouteChat({ ...dmCommand, channel, to: "slash:1234" }, { route: dmRoute }), false);
      assert.equal(
        isCommandInRouteChat({ ...dmCommand, channel, to: "slash:1234" }, { route: { provider: channel, target: "slash:1234" } }),
        false,
      );
    }
    assert.equal(isCommandInRouteChat({ ...dmCommand, senderId: "4321", to: "telegram:4321" }, { route: dmRoute }), false);
    assert.equal(isCommandInRouteChat({ ...dmCommand, messageThreadId: 3 }, { route: dmRoute }), false);
  });

  it("is false on WhatsApp, where `to` is the bot's own number in every chat", () => {
    // A session routed to the self-chat: any other WhatsApp chat carries the same `to`.
    const selfChat = { provider: "whatsapp", target: "+15550001111", sessionKey: "agent:main:main" };
    const command = { channel: "whatsapp", senderId: "+15550002222", sessionKey: "agent:main:main", to: "+15550001111" };
    assert.equal(isCommandInRouteChat(command, { route: selfChat }), false);
    assert.equal(isCommandInRouteChat({ deliveryContext: { channel: "whatsapp", to: "+15550001111" } }, { route: selfChat }), false);
  });

  it("is false for the same user's DM with another Telegram bot account", () => {
    const route = { ...dmRoute, accountId: "bot1" };
    assert.equal(isCommandInRouteChat({ ...dmCommand, accountId: "bot1" }, { route }), true);
    assert.equal(isCommandInRouteChat({ ...dmCommand, accountId: "bot2" }, { route }), false);
    // A route without an account (a session launched with `/agent`) is sent through
    // the default bot: a command that names its account never matches it.
    assert.equal(isCommandInRouteChat({ ...dmCommand, accountId: "bot2" }, { route: dmRoute }), false);
    assert.equal(isCommandInRouteChat({ ...dmCommand, accountId: "bot1" }, { route: dmRoute }), false);
    assert.equal(
      isCommandInRouteChat({ deliveryContext: { channel: "telegram", to: "1234", accountId: "bot1" } }, { route: dmRoute }),
      false,
    );
    // Neither side names an account.
    assert.equal(isCommandInRouteChat({ ...dmCommand, accountId: undefined }, { route: dmRoute }), true);
    assert.equal(
      isCommandInRouteChat({ deliveryContext: { channel: "telegram", to: "1234", accountId: "bot2" } }, { route }),
      false,
    );
  });

  it("is false for a forum-topic address inside `to` (text-command path)", () => {
    assert.equal(
      isCommandInRouteChat({ ...topicCommand, to: "telegram:-1001234567890:topic:42" }, { route: topicRoute }),
      false,
    );
  });

  it("is false when the command's chat or the route is unknown", () => {
    assert.equal(isCommandInRouteChat(undefined, { route: dmRoute }), false);
    assert.equal(isCommandInRouteChat(dmCommand, undefined), false);
    assert.equal(isCommandInRouteChat(dmCommand, {}), false);
    assert.equal(isCommandInRouteChat({ sessionKey: "agent:main:main" }, { route: dmRoute }), false);
    assert.equal(isCommandInRouteChat({ channel: "telegram", senderId: "1234", sessionKey: "agent:main:main" }, { route: dmRoute }), false);
    assert.equal(isCommandInRouteChat({ ...dmCommand, to: "telegram:" }, { route: dmRoute }), false);
    assert.equal(isCommandInRouteChat({ ...dmCommand, channel: undefined }, { route: dmRoute }), false);
    assert.equal(isCommandInRouteChat({ ...dmCommand, channel: "system", to: "system" }, { route: { provider: "system", target: "system" } }), false);
  });
});
