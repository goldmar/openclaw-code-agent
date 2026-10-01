import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SessionRoute } from "../src/types";
import {
  canonicalizeSessionRoute,
  formatOriginRouteWakeBlock,
  isInternalChatProvider,
  ROUTED_REPLY_RULE,
  routeFromOriginMetadata,
  safeParseTelegramTopicConversation,
  sessionRouteInternals,
} from "../src/session-route";

describe("session-route", () => {
  it("defaults bare numeric discord targets to channel routes", () => {
    const route = routeFromOriginMetadata("discord|1400000000000000001");
    assert.deepEqual(route, {
      provider: "discord",
      accountId: undefined,
      target: "channel:1400000000000000001",
      threadId: undefined,
      sessionKey: undefined,
    });
  });

  it("keeps discord dm session keys normalized to user routes", () => {
    const route = routeFromOriginMetadata(
      "discord|1400000000000000001",
      undefined,
      "agent:main:discord:dm:1400000000000000001",
    );
    assert.deepEqual(route, {
      provider: "discord",
      accountId: undefined,
      target: "user:1400000000000000001",
      threadId: undefined,
      sessionKey: "agent:main:discord:dm:1400000000000000001",
    });
  });

  it("maps discord group session keys to channel routes", () => {
    const route = routeFromOriginMetadata(
      "discord|1400000000000000001",
      undefined,
      "agent:main:discord:group:1400000000000000001",
    );
    assert.deepEqual(route, {
      provider: "discord",
      accountId: undefined,
      target: "channel:1400000000000000001",
      threadId: undefined,
      sessionKey: "agent:main:discord:group:1400000000000000001",
    });
  });

  it("canonicalizes mixed-case discord providers before target normalization", () => {
    const route = routeFromOriginMetadata(
      "Discord|1400000000000000001",
      undefined,
      "agent:main:discord:dm:1400000000000000001",
    );
    assert.deepEqual(route, {
      provider: "discord",
      accountId: undefined,
      target: "user:1400000000000000001",
      threadId: undefined,
      sessionKey: "agent:main:discord:dm:1400000000000000001",
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

  it("prefers Telegram group-topic session keys over conflicting DM-like origin targets", () => {
    const route = routeFromOriginMetadata(
      "telegram|5551234",
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

  it("repairs persisted Telegram routes whose target drifted to a DM", () => {
    const route = canonicalizeSessionRoute({
      route: {
        provider: "telegram",
        target: "5551234",
        threadId: "77",
        sessionKey: "agent:main:telegram:group:-100123:topic:77",
      },
      originChannel: "telegram",
      originThreadId: 77,
      originSessionKey: "agent:main:telegram:group:-100123:topic:77",
    });
    assert.deepEqual(route, {
      provider: "telegram",
      accountId: undefined,
      target: "-100123",
      threadId: "77",
      sessionKey: "agent:main:telegram:group:-100123:topic:77",
    });
  });

  it("formats an authoritative wake originRoute block for Telegram topic follow-ups", () => {
    const block = formatOriginRouteWakeBlock({
      originChannel: "telegram|-1001234567890",
      originThreadId: 13832,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
      route: {
        provider: "telegram",
        target: "5551234",
        threadId: "13832",
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
      },
    });

    assert.match(block, /^originRoute: \{/);
    assert.match(block, /"provider":"telegram"/);
    assert.match(block, /"target":"-1001234567890"/);
    assert.match(block, /"threadId":"13832"/);
    assert.doesNotMatch(block, /sessionKey/);
    assert.ok(block.endsWith(ROUTED_REPLY_RULE), block);
  });

  it("does not format a wake originRoute block for system routes", () => {
    const block = formatOriginRouteWakeBlock({
      originChannel: "unknown",
      route: {
        provider: "system",
        target: "system",
      },
    });

    assert.equal(block, "");
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

  it("repairs an internal webchat CLI envelope from an authoritative Telegram session key", () => {
    const route = routeFromOriginMetadata(
      "webchat|cli",
      undefined,
      "agent:main:telegram:direct:123456789",
    );
    assert.deepEqual(route, {
      provider: "telegram",
      target: "123456789",
      threadId: undefined,
      sessionKey: "agent:main:telegram:direct:123456789",
    });
  });

  it("preserves real WebChat origins when the UI opens an external-channel session", () => {
    for (const sessionKey of [
      "agent:main:telegram:group:-100123:topic:77",
      "agent:main:discord:channel:1400000000000000001",
      "agent:main:slack:channel:C123:thread:1718048480.000000",
    ]) {
      const expected: SessionRoute = {
        provider: "webchat",
        accountId: undefined,
        target: sessionKey,
        threadId: undefined,
        sessionKey,
      };
      assert.deepEqual(routeFromOriginMetadata(`webchat|${sessionKey}`, undefined, sessionKey), expected);
      assert.deepEqual(canonicalizeSessionRoute({ route: expected }), expected);
    }
  });

  it("does not treat other explicit WebChat targets as CLI continuation envelopes", () => {
    const sessionKey = "agent:main:telegram:group:-100123:topic:77";
    for (const originChannel of ["webchat|dashboard", "webchat|account|cli"]) {
      const route = routeFromOriginMetadata(originChannel, undefined, sessionKey);
      assert.equal(route?.provider, "webchat");
      assert.equal(route?.threadId, undefined);
    }
  });

  it("removes external account and thread metadata from persisted WebChat UI routes and wake blocks", () => {
    const sessionKey = "agent:main:telegram:group:-100123:topic:77";
    const source = {
      route: { provider: "webchat", accountId: "telegram-bot", target: sessionKey, threadId: "77", sessionKey },
      originChannel: `webchat|${sessionKey}`,
      originSessionKey: sessionKey,
      originThreadId: 77,
    };
    assert.deepEqual(canonicalizeSessionRoute(source), {
      provider: "webchat", accountId: undefined, target: sessionKey, threadId: undefined, sessionKey,
    });
    const block = formatOriginRouteWakeBlock(source);
    assert.match(block, /"provider":"webchat"/);
    assert.match(block, new RegExp(`"target":"${sessionKey}"`));
    assert.doesNotMatch(block, /"(?:accountId|threadId)":/);
    assert.ok(!block.includes(ROUTED_REPLY_RULE));
    assert.match(block, /ordinary visible final answer in this WebChat session/);
    assert.match(block, /Do not use the message tool/);
    assert.doesNotMatch(block, /NO_REPLY/);
  });

  it("recovers the CLI route's account and topic while respecting an explicit thread", () => {
    const sessionKey = "agent:main:telegram:second-bot:direct:123456789:topic:77";
    assert.deepEqual(routeFromOriginMetadata("webchat|cli", 88, sessionKey), {
      provider: "telegram",
      accountId: "second-bot",
      target: "123456789",
      threadId: "88",
      sessionKey,
    });
  });

  it("preserves a webchat CLI envelope when no external session route is recoverable", () => {
    const route = routeFromOriginMetadata("webchat|cli");
    assert.deepEqual(route, {
      provider: "webchat",
      accountId: undefined,
      target: "cli",
      threadId: undefined,
      sessionKey: undefined,
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

describe("wake reply rule", () => {
  it("tells the orchestrator to reach the user with the message tool, for any route", () => {
    for (const sessionKey of ["agent:main:direct:5551234", "agent:main:telegram:direct:5551234", "agent:main:main"]) {
      const block = formatOriginRouteWakeBlock({ route: { provider: "telegram", target: "5551234", sessionKey } });
      assert.equal(block, `originRoute: {"provider":"telegram","target":"5551234"}\n${ROUTED_REPLY_RULE}`);
    }
    assert.match(ROUTED_REPLY_RULE, /message\(action='send', final=true\) to originRoute/);
    assert.match(ROUTED_REPLY_RULE, /accountId and threadId only when originRoute has them/);
    assert.match(ROUTED_REPLY_RULE, /ordinary final assistant reply to this wake is private/);
    const scoped = formatOriginRouteWakeBlock({
      route: { provider: "telegram", accountId: "second-bot", target: "5551234", sessionKey: "agent:main:telegram:direct:5551234" },
    });
    assert.match(scoped, /"accountId":"second-bot"/);
    assert.match(scoped, /accountId and threadId only when originRoute has them/);
  });

  it("gives internal chat keys explicit visible-final guidance without a message-tool route", () => {
    const key = "agent:main:ios-00000000-0000-4000-8000-000000000001";
    assert.equal(isInternalChatProvider("webchat"), true);
    assert.equal(isInternalChatProvider("WebChat"), true);
    assert.equal(isInternalChatProvider("telegram"), false);
    for (const source of [
      { route: { provider: "webchat", target: key, sessionKey: key } },
      { originChannel: `webchat|${key}`, originSessionKey: key },
    ]) {
      const block = formatOriginRouteWakeBlock(source);
      assert.match(block, /ordinary visible final answer/);
      assert.ok(!block.includes(ROUTED_REPLY_RULE));
    }
    // The Control UI's (and newer apps') conversation keys take the same path.
    const dashboardKey = "agent:main:dashboard:00000000-0000-4000-8000-000000000002";
    assert.match(formatOriginRouteWakeBlock({ route: { provider: "webchat", target: dashboardKey, sessionKey: dashboardKey } }), /ordinary visible final answer/);
    assert.match(formatOriginRouteWakeBlock({ route: { provider: "telegram", target: "5551234" } }), /originRoute/);
  });
});
