import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setPluginConfig,
  pluginConfig,
  resolveAgentChannel,
  extractAgentId,
  resolveAgentId,
  parseThreadIdFromSessionKey,
  resolveOriginChannel,
  resolveOriginThreadId,
  resolveToolChannel,
} from "../src/config";

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

  it("returns undefined when no topic segment", () => {
    assert.equal(parseThreadIdFromSessionKey("abc:def"), undefined);
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

  it("uses telegram fallback for numeric ctx.id", () => {
    assert.equal(resolveOriginChannel({ id: "12345" }), "telegram|12345");
  });

  it("uses ctx.channelId if it contains pipe", () => {
    assert.equal(resolveOriginChannel({ channelId: "discord|789" }), "discord|789");
  });

  it("returns 'unknown' for empty ctx with no fallback", () => {
    assert.equal(resolveOriginChannel({}), "unknown");
  });

  it("uses fallbackChannel from config", () => {
    setPluginConfig({ fallbackChannel: "telegram|default" });
    assert.equal(resolveOriginChannel({}), "telegram|default");
  });
});

describe("resolveToolChannel", () => {
  it("builds 3-segment from messageChannel + agentAccountId", () => {
    const ctx = { messageChannel: "telegram|123", agentAccountId: "bot1" };
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
      defaultModel: "opus",
      defaultWorkdir: "/work",
      idleTimeoutMinutes: 60,
      postTurnIdleMinutes: 15,
      maxPersistedSessions: 100,
      fallbackChannel: "telegram|fallback",
      agentChannels: { "/a": "telegram|b|c" },
      maxAutoResponds: 20,
      permissionMode: "bypassPermissions",
      planApproval: "ask",
    });
    assert.equal(pluginConfig.maxSessions, 10);
    assert.equal(pluginConfig.defaultModel, "opus");
    assert.equal(pluginConfig.defaultWorkdir, "/work");
    assert.equal(pluginConfig.idleTimeoutMinutes, 60);
    assert.equal(pluginConfig.postTurnIdleMinutes, 15);
    assert.equal(pluginConfig.maxPersistedSessions, 100);
    assert.equal(pluginConfig.fallbackChannel, "telegram|fallback");
    assert.deepEqual(pluginConfig.agentChannels, { "/a": "telegram|b|c" });
    assert.equal(pluginConfig.maxAutoResponds, 20);
    assert.equal(pluginConfig.permissionMode, "bypassPermissions");
    assert.equal(pluginConfig.planApproval, "ask");
  });

  it("uses defaults for missing numeric fields", () => {
    setPluginConfig({});
    assert.equal(pluginConfig.maxSessions, 5);
    assert.equal(pluginConfig.idleTimeoutMinutes, 30);
    assert.equal(pluginConfig.maxPersistedSessions, 50);
    assert.equal(pluginConfig.maxAutoResponds, 10);
  });

  it("uses default for missing permissionMode", () => {
    setPluginConfig({});
    assert.equal(pluginConfig.permissionMode, "plan");
  });

  it("uses default for missing planApproval", () => {
    setPluginConfig({});
    assert.equal(pluginConfig.planApproval, "delegate");
  });

  it("preserves optional fields as undefined when not provided", () => {
    setPluginConfig({});
    assert.equal(pluginConfig.defaultModel, undefined);
    assert.equal(pluginConfig.defaultWorkdir, undefined);
    assert.equal(pluginConfig.postTurnIdleMinutes, undefined);
    assert.equal(pluginConfig.fallbackChannel, undefined);
    assert.equal(pluginConfig.agentChannels, undefined);
  });

  it("handles empty object input", () => {
    setPluginConfig({});
    // Should not throw, and all defaults should be applied
    assert.equal(pluginConfig.maxSessions, 5);
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
    assert.equal(pluginConfig.maxSessions, 5);
    assert.equal(pluginConfig.idleTimeoutMinutes, 30);
    assert.equal(pluginConfig.maxPersistedSessions, 50);
    assert.equal(pluginConfig.maxAutoResponds, 10);
    assert.equal(pluginConfig.permissionMode, "plan");
    assert.equal(pluginConfig.planApproval, "delegate");
  });

  it("setPluginConfig mutates the module-level singleton", () => {
    setPluginConfig({ maxSessions: 99 });
    assert.equal(pluginConfig.maxSessions, 99);
    // Reset for other tests
    setPluginConfig({});
    assert.equal(pluginConfig.maxSessions, 5);
  });
});
