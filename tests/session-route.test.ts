import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  routeFromOriginMetadata,
  safeParseTelegramTopicConversation,
  sessionRouteInternals,
} from "../src/session-route";

describe("session-route", () => {
  it("defaults bare numeric discord targets to channel routes", () => {
    const route = routeFromOriginMetadata("discord|1481874223294054540");
    assert.deepEqual(route, {
      provider: "discord",
      accountId: undefined,
      target: "channel:1481874223294054540",
      threadId: undefined,
      sessionKey: undefined,
    });
  });

  it("keeps discord dm session keys normalized to user routes", () => {
    const route = routeFromOriginMetadata(
      "discord|1481874223294054540",
      undefined,
      "agent:main:discord:dm:1481874223294054540",
    );
    assert.deepEqual(route, {
      provider: "discord",
      accountId: undefined,
      target: "user:1481874223294054540",
      threadId: undefined,
      sessionKey: "agent:main:discord:dm:1481874223294054540",
    });
  });

  it("maps discord group session keys to channel routes", () => {
    const route = routeFromOriginMetadata(
      "discord|1481874223294054540",
      undefined,
      "agent:main:discord:group:1481874223294054540",
    );
    assert.deepEqual(route, {
      provider: "discord",
      accountId: undefined,
      target: "channel:1481874223294054540",
      threadId: undefined,
      sessionKey: "agent:main:discord:group:1481874223294054540",
    });
  });

  it("canonicalizes mixed-case discord providers before target normalization", () => {
    const route = routeFromOriginMetadata(
      "Discord|1481874223294054540",
      undefined,
      "agent:main:discord:dm:1481874223294054540",
    );
    assert.deepEqual(route, {
      provider: "discord",
      accountId: undefined,
      target: "user:1481874223294054540",
      threadId: undefined,
      sessionKey: "agent:main:discord:dm:1481874223294054540",
    });
  });

  it("recovers Telegram topic routing from session keys when originChannel is weak", () => {
    const route = routeFromOriginMetadata(
      "telegram",
      undefined,
      "agent:main:telegram:group:-100123:topic:77",
    );
    assert.deepEqual(route, {
      provider: "telegram",
      target: "-100123",
      threadId: "77",
      sessionKey: "agent:main:telegram:group:-100123:topic:77",
    });
  });

  it("canonicalizes mixed-case providers before reusing recovered session-key threads", () => {
    const route = routeFromOriginMetadata(
      "Telegram|-100123",
      undefined,
      "agent:main:telegram:group:-100123:topic:77",
    );
    assert.deepEqual(route, {
      provider: "telegram",
      accountId: undefined,
      target: "-100123",
      threadId: "77",
      sessionKey: "agent:main:telegram:group:-100123:topic:77",
    });
  });

  it("lets an explicit origin thread override the recovered session-key thread", () => {
    const route = routeFromOriginMetadata(
      "telegram",
      88,
      "agent:main:telegram:group:-100123:topic:77",
    );
    assert.deepEqual(route, {
      provider: "telegram",
      target: "-100123",
      threadId: "88",
      sessionKey: "agent:main:telegram:group:-100123:topic:77",
    });
  });

  it("parses direct Telegram topic conversation ids", () => {
    assert.deepEqual(
      safeParseTelegramTopicConversation("-100123:topic:77"),
      {
        chatId: "-100123",
        topicId: "77",
        canonicalConversationId: "-100123:topic:77",
      },
    );
  });

  it("keeps generic thread suffix parsing available for non-Telegram providers", () => {
    const route = routeFromOriginMetadata(
      "slack|general",
      undefined,
      "agent:main:slack:channel:general:thread:1699999999.0001",
    );
    assert.deepEqual(route, {
      provider: "slack",
      accountId: undefined,
      target: "general",
      threadId: "1699999999.0001",
      sessionKey: "agent:main:slack:channel:general:thread:1699999999.0001",
    });
  });

  it("tolerates rebound agent session keys and still extracts the provider route", () => {
    const route = routeFromOriginMetadata(
      "telegram",
      undefined,
      "agent:hook-runner:target-agent:telegram:group:-100123:topic:77",
    );
    assert.deepEqual(route, {
      provider: "telegram",
      target: "-100123",
      threadId: "77",
      sessionKey: "agent:hook-runner:target-agent:telegram:group:-100123:topic:77",
    });
  });

  it("ignores session keys without the agent prefix", () => {
    const route = routeFromOriginMetadata(
      "telegram",
      undefined,
      "telegram:group:-100123:topic:77",
    );
    assert.deepEqual(route, {
      provider: "system",
      target: "system",
      sessionKey: "telegram:group:-100123:topic:77",
    });
  });

  it("falls back to a recovered session-key route when originChannel is malformed", () => {
    const route = routeFromOriginMetadata(
      "telegram-only",
      undefined,
      "agent:main:telegram:group:-100123:topic:77",
    );
    assert.deepEqual(route, {
      provider: "telegram",
      target: "-100123",
      threadId: "77",
      sessionKey: "agent:main:telegram:group:-100123:topic:77",
    });
  });

  it("treats mixed-case unknown origin channels as weak metadata", () => {
    const route = routeFromOriginMetadata(
      "Unknown",
      undefined,
      "agent:main:telegram:group:-100123:topic:77",
    );
    assert.deepEqual(route, {
      provider: "telegram",
      target: "-100123",
      threadId: "77",
      sessionKey: "agent:main:telegram:group:-100123:topic:77",
    });
  });

  it("falls back when a three-part origin channel is missing its target segment", () => {
    const route = routeFromOriginMetadata(
      "telegram|bot|",
      undefined,
      "agent:main:telegram:group:-100123:topic:77",
    );
    assert.deepEqual(route, {
      provider: "telegram",
      target: "-100123",
      threadId: "77",
      sessionKey: "agent:main:telegram:group:-100123:topic:77",
    });
  });

  it("falls back to a system route when malformed origin metadata has no usable session key", () => {
    const route = routeFromOriginMetadata("telegram|bot|", undefined, "not-an-agent-key");
    assert.deepEqual(route, {
      provider: "system",
      target: "system",
      sessionKey: "not-an-agent-key",
    });
  });

  it("catches Telegram parser errors and falls back gracefully", (t) => {
    assert.equal(
      safeParseTelegramTopicConversation(
        "-100123:topic:77",
        () => {
          throw new Error("boom");
        },
      ),
      null,
    );

    t.mock.method(sessionRouteInternals, "safeParseTelegramTopicConversation", () => {
      throw new Error("boom");
    });

    const route = routeFromOriginMetadata(
      "telegram",
      undefined,
      "agent:main:telegram:group:-100123:topic:77",
    );
    assert.deepEqual(route, {
      provider: "telegram",
      target: "-100123",
      threadId: "77",
      sessionKey: "agent:main:telegram:group:-100123:topic:77",
    });
  });
});
