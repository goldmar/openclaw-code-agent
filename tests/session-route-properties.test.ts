import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  buildAgentSessionKey,
  parseThreadSessionSuffix,
  resolveThreadSessionKeys,
} from "openclaw/plugin-sdk/routing";
import {
  canonicalizeSessionRoute,
  formatOriginRouteWakeBlock,
  parseThreadIdFromSessionKey,
  resolveNotificationRoute,
  routeFromOriginMetadata,
  type SessionRouteSource,
} from "../src/session-route";
import type { SessionRoute } from "../src/types";
import { propertyParams } from "./property-harness";

/**
 * Round-trip properties for session routes against the host's own session-key
 * builders (`openclaw/plugin-sdk/routing`): OCA must recover the provider,
 * target, account, and thread from any key the host builds.
 *
 * Generated ids never contain `|` or `:`; `|` separates the fields of a
 * channel string (`provider|account|target`) and `:` the segments of a
 * session key, and no supported channel uses either inside an id.
 */

type Peer = { kind: "direct" | "group" | "channel"; id: string };
type DmScope = "per-channel-peer" | "per-account-channel-peer";

const agentIdArb = fc.constantFrom("main", "ops", "review-bot");
const accountIdArb = fc.constantFrom("default", "bot", "work", "acct2");
const snowflakeArb = fc.bigInt({ min: 10n ** 16n, max: 10n ** 19n }).map(String);
const telegramChatArb = fc.oneof(
  fc.integer({ min: 1, max: 2 ** 40 }).map((id) => `-100${id}`),
  fc.integer({ min: 1, max: 2 ** 40 }).map((id) => `-${id}`),
);
const telegramUserArb = fc.integer({ min: 1, max: 2 ** 40 }).map(String);
const slackIdArb = fc.tuple(fc.constantFrom("C", "G", "D", "U"), fc.stringMatching(/^[A-Z0-9]{8,11}$/)).map(([prefix, rest]) => `${prefix}${rest}`);
const topicIdArb = fc.integer({ min: 1, max: 999_999 }).map(String);
const slackThreadArb = fc.tuple(fc.integer({ min: 1_600_000_000, max: 1_900_000_000 }), fc.integer({ min: 0, max: 999_999 }))
  .map(([seconds, micros]) => `${seconds}.${String(micros).padStart(6, "0")}`);

type KeyCase = {
  channel: "telegram" | "discord" | "slack";
  agentId: string;
  accountId?: string;
  peer: Peer;
  dmScope: DmScope;
  threadId?: string;
  /** Telegram forum topic (`:topic:<id>`, the Telegram plugin's grammar) instead of a host `:thread:` suffix. */
  telegramTopic?: string;
};

const keyCaseArb: fc.Arbitrary<KeyCase> = fc.oneof(
  fc.record({
    channel: fc.constant("telegram" as const),
    agentId: agentIdArb,
    accountId: fc.option(accountIdArb, { nil: undefined }),
    peer: fc.oneof(
      telegramChatArb.map((id): Peer => ({ kind: "group", id })),
      telegramUserArb.map((id): Peer => ({ kind: "direct", id })),
    ),
    dmScope: fc.constantFrom<DmScope>("per-channel-peer", "per-account-channel-peer"),
    threadId: fc.option(topicIdArb, { nil: undefined }),
    telegramTopic: fc.option(topicIdArb, { nil: undefined }),
  }).map((value): KeyCase => (value.telegramTopic && value.peer.kind === "group"
    ? { ...value, threadId: undefined as string | undefined }
    : { ...value, telegramTopic: undefined as string | undefined })),
  fc.record({
    channel: fc.constant("discord" as const),
    agentId: agentIdArb,
    accountId: fc.option(accountIdArb, { nil: undefined }),
    peer: fc.oneof(
      snowflakeArb.map((id): Peer => ({ kind: "channel", id })),
      snowflakeArb.map((id): Peer => ({ kind: "group", id })),
      snowflakeArb.map((id): Peer => ({ kind: "direct", id })),
    ),
    dmScope: fc.constantFrom<DmScope>("per-channel-peer", "per-account-channel-peer"),
    threadId: fc.option(snowflakeArb, { nil: undefined }),
  }),
  fc.record({
    channel: fc.constant("slack" as const),
    agentId: agentIdArb,
    accountId: fc.option(accountIdArb, { nil: undefined }),
    peer: fc.oneof(
      slackIdArb.map((id): Peer => ({ kind: "channel", id })),
      slackIdArb.map((id): Peer => ({ kind: "direct", id })),
    ),
    dmScope: fc.constantFrom<DmScope>("per-channel-peer", "per-account-channel-peer"),
    threadId: fc.option(slackThreadArb, { nil: undefined }),
  }),
);

function buildKey(input: KeyCase): string {
  const base = buildAgentSessionKey({
    agentId: input.agentId,
    channel: input.channel,
    accountId: input.accountId,
    peer: input.peer,
    dmScope: input.dmScope,
  });
  if (input.telegramTopic) return `${base}:topic:${input.telegramTopic}`;
  return resolveThreadSessionKeys({ baseSessionKey: base, threadId: input.threadId }).sessionKey;
}

/** The peer id as the host encodes it in the key (it lower-cases peer ids). */
function hostPeerId(key: string, input: KeyCase): string {
  const base = parseThreadSessionSuffix(key).baseSessionKey ?? key;
  const withoutTopic = input.telegramTopic ? base.slice(0, base.lastIndexOf(":topic:")) : base;
  const id = withoutTopic.slice(withoutTopic.lastIndexOf(":") + 1);
  assert.equal(id, input.peer.id.toLowerCase(), `the host encodes the peer id in ${key}`);
  return id;
}

function expectedTarget(input: KeyCase, peerId: string): string {
  if (input.channel !== "discord") return peerId;
  return input.peer.kind === "direct" ? `user:${peerId}` : `channel:${peerId}`;
}

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("session routes vs host session keys (properties)", () => {
  it("recovers provider, target, account, and thread from any host-built key", () => {
    fc.assert(
      fc.property(keyCaseArb, (input) => {
        const key = buildKey(input);
        const route = routeFromOriginMetadata(undefined, undefined, key);
        const thread = input.telegramTopic ?? input.threadId;
        assert.ok(route, key);
        assert.equal(route.provider, input.channel, key);
        assert.equal(route.target, expectedTarget(input, hostPeerId(key, input)), key);
        assert.equal(route.threadId, thread, key);
        assert.equal(route.sessionKey, key);
        const accountScoped = input.peer.kind === "direct" && input.dmScope === "per-account-channel-peer";
        assert.equal(route.accountId, accountScoped ? (input.accountId ?? "default").toLowerCase() : undefined, key);

        // The thread id reader used by launch resolution agrees with the route.
        const parsedThread = parseThreadIdFromSessionKey(key);
        assert.equal(parsedThread === undefined ? undefined : String(parsedThread), thread, key);
        if (input.telegramTopic) assert.equal(parsedThread, Number(input.telegramTopic));
        // ...and with the host's own suffix parser for `:thread:` keys.
        if (!input.telegramTopic) assert.equal(parseThreadSessionSuffix(key).threadId, input.threadId, key);
      }),
      propertyParams(300),
    );
  });

  it("keeps the explicit channel's target and account and the key's thread", () => {
    fc.assert(
      fc.property(keyCaseArb, fc.option(accountIdArb, { nil: undefined }), (input, channelAccount) => {
        const key = buildKey(input);
        const peerId = hostPeerId(key, input);
        const channel = channelAccount ? `${input.channel}|${channelAccount}|${peerId}` : `${input.channel}|${peerId}`;
        const route = routeFromOriginMetadata(channel, undefined, key);
        assert.ok(route);
        assert.equal(route.provider, input.channel);
        assert.equal(route.accountId, channelAccount);
        assert.equal(route.target, expectedTarget(input, peerId), `${channel} + ${key}`);
        assert.equal(route.threadId, input.telegramTopic ?? input.threadId);
      }),
      propertyParams(200),
    );
  });

  it("lets an explicit thread id override the key's thread", () => {
    fc.assert(
      fc.property(keyCaseArb, fc.oneof(topicIdArb, fc.integer({ min: 1, max: 99_999 })), (input, explicitThread) => {
        const key = buildKey(input);
        const route = routeFromOriginMetadata(undefined, explicitThread, key);
        assert.equal(route?.threadId, String(explicitThread));
      }),
      propertyParams(100),
    );
  });
});

// -- canonicalization ----------------------------------------------------------

const providerArb = fc.constantFrom("telegram", "Telegram", "discord", "slack", "matrix", "system", "unknown-chat");
const targetArb = fc.oneof(telegramChatArb, telegramUserArb, snowflakeArb, slackIdArb, snowflakeArb.map((id) => `channel:${id}`), snowflakeArb.map((id) => `user:${id}`));
const threadArb = fc.oneof(topicIdArb, slackThreadArb, fc.integer({ min: 1, max: 99_999 }));
const sessionKeyArb = fc.oneof(
  keyCaseArb.map(buildKey),
  fc.constantFrom("agent:main:main", "agent:main:direct:123", "agent:main:telegram:group:-100123:topic:7"),
  fc.string({ maxLength: 40 }),
);
const channelStringArb = fc.oneof(
  fc.tuple(providerArb, targetArb).map(([provider, target]) => `${provider}|${target}`),
  fc.tuple(providerArb, accountIdArb, targetArb).map(([provider, account, target]) => `${provider}|${account}|${target}`),
  fc.constantFrom("unknown", "telegram", "", " | "),
);
const routeArb: fc.Arbitrary<SessionRoute> = fc.record({
  provider: providerArb,
  accountId: fc.option(accountIdArb, { nil: undefined }),
  target: fc.oneof(targetArb, fc.constant("system")),
  threadId: fc.option(threadArb.map(String), { nil: undefined }),
  sessionKey: fc.option(sessionKeyArb, { nil: undefined }),
});
const sourceArb: fc.Arbitrary<SessionRouteSource> = fc.record({
  route: fc.option(routeArb, { nil: undefined }),
  originChannel: fc.option(channelStringArb, { nil: undefined }),
  originThreadId: fc.option(threadArb, { nil: undefined }),
  originSessionKey: fc.option(sessionKeyArb, { nil: undefined }),
}, { requiredKeys: [] });

describe("canonicalizeSessionRoute (properties)", () => {
  // Loading a row canonicalizes its stored route together with its origin fields.
  it("is idempotent: a canonical route stays canonical", () => {
    fc.assert(
      fc.property(sourceArb, (source) => {
        const first = canonicalizeSessionRoute(source);
        if (!first) return;
        const again = canonicalizeSessionRoute({ ...source, route: first });
        assert.deepEqual(json(again), json(first));
      }),
      propertyParams(400),
    );
  });

  it("never throws and only resolves deliverable routes", () => {
    fc.assert(
      fc.property(
        fc.record({
          route: fc.option(fc.record({
            provider: fc.string({ maxLength: 12 }),
            target: fc.string({ maxLength: 20 }),
            accountId: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
            threadId: fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
            sessionKey: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
          }), { nil: undefined }),
          originChannel: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
          originThreadId: fc.option(fc.oneof(fc.string({ maxLength: 8 }), fc.integer()), { nil: undefined }),
          originSessionKey: fc.option(fc.oneof(fc.string({ maxLength: 40 }), sessionKeyArb), { nil: undefined }),
        }, { requiredKeys: [] }),
        (source) => {
          const route = resolveNotificationRoute(source);
          if (route) {
            assert.ok(route.provider && route.target);
            assert.notEqual(route.provider, "system");
            assert.notEqual(route.target, "system");
          }
          const block = formatOriginRouteWakeBlock(source);
          if (block) {
            const line = block.split("\n").find((entry) => entry.startsWith("originRoute: "));
            assert.ok(line, block);
            const parsed = JSON.parse(line.slice("originRoute: ".length)) as Record<string, string>;
            assert.equal(parsed.provider, route?.provider);
            assert.equal(parsed.target, route?.target);
          }
        },
      ),
      propertyParams(300),
    );
  });
});

describe("session route regressions", () => {
  it("treats a blank route session key as absent, so the origin key applies at once", () => {
    const source: SessionRouteSource = { route: { provider: "telegram", target: "1", sessionKey: "" }, originSessionKey: "agent:main:telegram:group:1" };
    const first = canonicalizeSessionRoute(source);
    assert.equal(first?.sessionKey, "agent:main:telegram:group:1");
    assert.deepEqual(json(canonicalizeSessionRoute({ ...source, route: first })), json(first));
  });

  it("routes per-account-channel-peer DM keys to the peer, not to `direct:<peer>`", () => {
    const telegramKey = buildAgentSessionKey({ agentId: "main", channel: "telegram", accountId: "bot", peer: { kind: "direct", id: "123456" }, dmScope: "per-account-channel-peer" });
    assert.equal(telegramKey, "agent:main:telegram:bot:direct:123456");
    assert.deepEqual(json(routeFromOriginMetadata("telegram|bot|123456", undefined, telegramKey)), {
      provider: "telegram",
      accountId: "bot",
      target: "123456",
      sessionKey: telegramKey,
    });
    assert.equal(routeFromOriginMetadata(undefined, undefined, telegramKey)?.target, "123456");

    const discordKey = buildAgentSessionKey({ agentId: "main", channel: "discord", accountId: "bot", peer: { kind: "direct", id: "998877665544332211" }, dmScope: "per-account-channel-peer" });
    assert.equal(routeFromOriginMetadata("discord|bot|998877665544332211", undefined, discordKey)?.target, "user:998877665544332211");
    assert.equal(routeFromOriginMetadata(undefined, undefined, discordKey)?.target, "user:998877665544332211");
  });

  it("reads Discord and Slack `:thread:` ids from session keys without losing precision", () => {
    assert.equal(parseThreadIdFromSessionKey("agent:main:discord:channel:123:thread:1234567890123456789"), "1234567890123456789");
    assert.equal(parseThreadIdFromSessionKey("agent:main:slack:channel:c0abc:thread:1700000000.123456"), "1700000000.123456");
    assert.equal(parseThreadIdFromSessionKey("agent:main:telegram:group:-100123:topic:42"), 42);
    assert.equal(parseThreadIdFromSessionKey("agent:main:discord:channel:123"), undefined);
    assert.equal(parseThreadIdFromSessionKey("   "), undefined);
  });
});
