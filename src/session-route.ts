import { parseThreadSessionSuffix } from "openclaw/plugin-sdk/routing";
import type { SessionRoute } from "./types";

export interface SessionRouteSource {
  route?: SessionRoute;
  originChannel?: string;
  originThreadId?: string | number;
  originSessionKey?: string;
}

const KNOWN_SESSION_ROUTE_PROVIDERS = new Set([
  "telegram",
  "discord",
  "slack",
  "system",
  "mattermost",
  "feishu",
  "line",
  "whatsapp",
  "signal",
  "matrix",
  "googlechat",
  "bluebubbles",
  "imessage",
  "msteams",
]);

/** Peer kinds of host session keys (`buildAgentSessionKey`). */
const PEER_KINDS = new Set(["direct", "dm", "group", "channel"]);

type ParsedTelegramTopicConversation = {
  chatId: string;
  topicId: string;
  canonicalConversationId: string;
};

function buildTelegramTopicConversationId(params: {
  chatId: string;
  topicId: string;
}): string | null {
  const chatId = params.chatId.trim();
  const topicId = params.topicId.trim();
  if (!/^-?\d+$/.test(chatId) || !/^\d+$/.test(topicId)) {
    return null;
  }
  return `${chatId}:topic:${topicId}`;
}

function parseTelegramTopicConversation(params: {
  conversationId: string;
  parentConversationId?: string;
}): ParsedTelegramTopicConversation | null {
  const conversation = params.conversationId.trim();
  const directMatch = conversation.match(/^(-?\d+):topic:(\d+)$/i);
  if (directMatch?.[1] && directMatch[2]) {
    const canonicalConversationId = buildTelegramTopicConversationId({
      chatId: directMatch[1],
      topicId: directMatch[2],
    });
    if (!canonicalConversationId) {
      return null;
    }
    return {
      chatId: directMatch[1],
      topicId: directMatch[2],
      canonicalConversationId,
    };
  }

  if (!/^\d+$/.test(conversation)) {
    return null;
  }

  const parent = params.parentConversationId?.trim();
  if (!parent || !/^-?\d+$/.test(parent)) {
    return null;
  }

  const canonicalConversationId = buildTelegramTopicConversationId({
    chatId: parent,
    topicId: conversation,
  });
  if (!canonicalConversationId) {
    return null;
  }

  return {
    chatId: parent,
    topicId: conversation,
    canonicalConversationId,
  };
}

function parseDiscordTargetKind(sessionKey?: string): "channel" | "user" | undefined {
  const ref = parseSessionConversationRef(sessionKey);
  if (ref?.provider !== "discord" || !ref.kind || !PEER_KINDS.has(ref.kind)) return undefined;
  return ref.kind === "direct" || ref.kind === "dm" ? "user" : "channel";
}

function normalizeDiscordTarget(target: string, sessionKey?: string): string {
  if (!/^\d+$/.test(target)) return target;
  const kind = parseDiscordTargetKind(sessionKey);
  return kind ? `${kind}:${target}` : `channel:${target}`;
}

function routeToChannelString(route?: SessionRoute): string | undefined {
  if (!route?.provider || !route.target) return undefined;
  if (route.provider === "system" || route.target === "system") return undefined;
  return route.accountId
    ? `${route.provider}|${route.accountId}|${route.target}`
    : `${route.provider}|${route.target}`;
}

/**
 * Split a conversation id from its thread suffix.
 *
 * `:thread:` uses the host's public `parseThreadSessionSuffix`
 * (`openclaw/plugin-sdk/routing`), which preserves opaque peer-id case.
 * Telegram forum `:topic:` suffixes stay local: the host's topic grammar lives
 * in the Telegram channel plugin and the private-local `channel-route` helpers,
 * and `parseAgentSessionKey` lower-cases peer ids (for example Slack `C0…`
 * channel ids), so it cannot recover a deliverable target.
 */
function parseThreadSuffix(value: string): { id: string; threadId?: string } {
  const thread = parseThreadSessionSuffix(value);
  if (thread.threadId !== undefined || (thread.baseSessionKey !== undefined && thread.baseSessionKey !== value.trim())) {
    const id = thread.baseSessionKey?.trim();
    return { id: id || value, threadId: thread.threadId };
  }

  const marker = ":topic:";
  const index = value.toLowerCase().lastIndexOf(marker);
  if (index === -1) return { id: value };
  const id = value.slice(0, index).trim();
  const threadId = value.slice(index + marker.length).trim() || undefined;
  return { id: id || value, threadId };
}

function parseSessionConversationRef(
  originSessionKey?: string,
): { provider: string; kind: string; rawId: string; accountId?: string } | undefined {
  const raw = originSessionKey?.trim();
  if (!raw) return undefined;

  const rawParts = raw.split(":").filter(Boolean);
  if (rawParts[0]?.trim().toLowerCase() !== "agent") return undefined;
  // Accept canonical agent keys and tolerate additional upstream routing layers
  // ahead of the provider/kind pair, while still requiring an `agent:` prefix.
  for (let index = 2; index <= rawParts.length - 3; index += 1) {
    const provider = rawParts[index]?.trim().toLowerCase();
    if (!provider || !KNOWN_SESSION_ROUTE_PROVIDERS.has(provider)) continue;
    const kind = rawParts[index + 1]?.trim().toLowerCase();
    // The `per-account-channel-peer` DM scope puts the account between the
    // channel and the peer kind: `agent:<id>:<channel>:<account>:direct:<peer>`.
    // Like the host's `parseSessionDeliveryRoute`, that shape wins whenever the
    // third segment is `direct`/`dm`, even for an account named like a kind.
    const accountScopedKind = rawParts[index + 2]?.trim().toLowerCase();
    if (
      kind
      && (accountScopedKind === "direct" || accountScopedKind === "dm")
      && rawParts.length - index >= 4
    ) {
      const rawId = rawParts.slice(index + 3).join(":").trim();
      if (rawId) return { provider, kind: accountScopedKind, rawId, accountId: rawParts[index + 1].trim() };
    }
    const rawId = rawParts.slice(index + 2).join(":").trim();
    if (!kind || !rawId) continue;
    return { provider, kind, rawId };
  }
  return undefined;
}

export function safeParseTelegramTopicConversation(
  conversationId: string,
  parseConversation: typeof parseTelegramTopicConversation = parseTelegramTopicConversation,
) {
  try {
    return parseConversation({ conversationId });
  } catch {
    return null;
  }
}

export const sessionRouteInternals = {
  safeParseTelegramTopicConversation,
};

function buildSystemRoute(originSessionKey?: string): SessionRoute {
  return {
    provider: "system",
    target: "system",
    sessionKey: originSessionKey?.trim() || undefined,
  };
}

function withThreadOverride(route: SessionRoute, explicitThreadId?: string): SessionRoute {
  return {
    ...route,
    threadId: explicitThreadId ?? route.threadId,
  };
}

function shouldPreferTelegramSessionKeyRoute(
  provider: string,
  explicitTarget: string,
  sessionKeyRoute?: SessionRoute,
): boolean {
  return provider === "telegram"
    && sessionKeyRoute?.provider === "telegram"
    && Boolean(sessionKeyRoute.target)
    && explicitTarget !== sessionKeyRoute.target;
}

function routeFromSessionKey(originSessionKey?: string): SessionRoute | undefined {
  const trimmed = originSessionKey?.trim();
  if (!trimmed) return undefined;

  const parsed = parseSessionConversationRef(trimmed);
  if (!parsed) return undefined;

  const { provider, kind, rawId, accountId } = parsed;
  const genericConversation = parseThreadSuffix(rawId);
  let telegramConversation = null;
  if (provider === "telegram") {
    try {
      telegramConversation = sessionRouteInternals.safeParseTelegramTopicConversation(rawId);
    } catch {
      telegramConversation = null;
    }
  }
  const baseTarget = telegramConversation?.chatId ?? genericConversation.id;
  const threadId = telegramConversation?.topicId ?? genericConversation.threadId;
  const target = provider === "discord"
    ? (kind === "direct" || kind === "dm" ? `user:${baseTarget}` : `channel:${baseTarget}`)
    : baseTarget;

  return {
    provider,
    ...(accountId ? { accountId } : {}),
    target,
    threadId,
    sessionKey: trimmed,
  };
}

/**
 * The thread a session key names: a Telegram forum `:topic:<id>` suffix (as a
 * number, like Telegram's `message_thread_id`) or the host's `:thread:<id>`
 * suffix (Discord, Slack, and other channels), read with the same grammar as
 * `routeFromSessionKey`. `:thread:` ids stay strings: Discord snowflakes exceed
 * `Number.MAX_SAFE_INTEGER` and Slack thread ids are timestamps.
 */
export function parseThreadIdFromSessionKey(sessionKey?: string): number | string | undefined {
  const topic = sessionKey?.match(/:topic:(\d+)$/i);
  if (topic) return parseInt(topic[1], 10);
  if (!sessionKey?.trim()) return undefined;
  return parseThreadSessionSuffix(sessionKey).threadId;
}

export function isDirectSessionRoute(route?: SessionRoute): boolean {
  return Boolean(route?.provider && route.target && route.provider !== "system" && route.target !== "system");
}

/**
 * Internal chat surfaces: OpenClaw WebChat, which the Control UI and the native
 * iOS/Android/macOS apps use. They are not outbound channels ("`webchat` is the
 * internal WebChat UI channel and is not a configurable outbound channel"), so
 * a `message` send or a durable outbound send to them always fails with
 * "Outbound not configured for channel: webchat". In such a conversation the
 * orchestrator's own reply is the message, and plugin notices are appended to
 * the conversation with the Gateway's `chat.inject`.
 */
const INTERNAL_CHAT_PROVIDERS = new Set(["webchat"]);

export function isInternalChatProvider(provider?: string): boolean {
  return Boolean(provider && INTERNAL_CHAT_PROVIDERS.has(provider.trim().toLowerCase()));
}

/**
 * A Telegram direct-messages topic (the Direct Messages chat of a channel) is
 * addressed inside the target, `<chat>:direct-topic:<n>`: that is the form the
 * host's outbound sends parse (`parseTelegramTarget`) and deliver with
 * `direct_messages_topic_id`. It is never a `threadId`, which the host sends as
 * `message_thread_id`.
 */
const TELEGRAM_DIRECT_TOPIC_TARGET = /^(?:telegram:)?-?\d+:direct-topic:\d+$/i;

export function isTelegramDirectTopicTarget(target?: string): boolean {
  return TELEGRAM_DIRECT_TOPIC_TARGET.test(target?.trim() ?? "");
}

/**
 * Canonical form of a Telegram route into a direct-messages topic: the topic
 * is in the target and there is no thread id. A session key names such a topic
 * as a thread (`…:thread:<chat>:direct-topic:<n>`, or `direct-topic:<n>`), and
 * routes stored before this form existed carry that as `threadId`; both are
 * folded into the target. A thread id that names another chat is left alone.
 */
function normalizeTelegramDirectTopicRoute(route: SessionRoute | undefined): SessionRoute | undefined {
  if (!route || route.provider !== "telegram" || !route.target) return route;
  if (isTelegramDirectTopicTarget(route.target)) {
    return route.threadId === undefined ? route : { ...route, threadId: undefined };
  }
  const topic = /^(?:(-?\d+):)?direct-topic:(\d+)$/i.exec(String(route.threadId ?? "").trim());
  if (!topic) return route;
  const chat = route.target.trim().replace(/^telegram:/i, "");
  if (!/^-?\d+$/.test(chat) || (topic[1] !== undefined && topic[1] !== chat)) return route;
  return { ...route, target: `${chat}:direct-topic:${topic[2]}`, threadId: undefined };
}

export function routeFromOriginMetadata(
  originChannel?: string,
  originThreadId?: string | number,
  originSessionKey?: string,
): SessionRoute | undefined {
  return normalizeTelegramDirectTopicRoute(routeFromRawOriginMetadata(originChannel, originThreadId, originSessionKey));
}

function routeFromRawOriginMetadata(
  originChannel?: string,
  originThreadId?: string | number,
  originSessionKey?: string,
): SessionRoute | undefined {
  const sessionKeyRoute = routeFromSessionKey(originSessionKey);
  const explicitThreadId = originThreadId != null ? String(originThreadId) : undefined;
  const normalizedChannel = originChannel?.trim();
  if (!normalizedChannel || normalizedChannel.toLowerCase() === "unknown") {
    return sessionKeyRoute
      ? withThreadOverride(sessionKeyRoute, explicitThreadId)
      : buildSystemRoute(originSessionKey);
  }

  const parts = normalizedChannel.split("|").map((part) => part.trim());
  if (parts.length < 2) {
    return sessionKeyRoute
      ? withThreadOverride(sessionKeyRoute, explicitThreadId)
      : buildSystemRoute(originSessionKey);
  }

  const [provider, second, third] = parts;
  const rawTarget = parts.length >= 3 ? third : second;
  const accountId = parts.length >= 3 ? second : undefined;
  const normalizedProvider = provider?.toLowerCase();
  if (!normalizedProvider || !rawTarget) {
    return sessionKeyRoute
      ? withThreadOverride(sessionKeyRoute, explicitThreadId)
      : buildSystemRoute(originSessionKey);
  }

  // Recover only the CLI continuation envelope. Real WebChat turns target the
  // canonical session key, including when the UI opens an external-channel
  // session; that explicit internal origin must remain internal.
  if (
    sessionKeyRoute
    && normalizedProvider === "webchat"
    && parts.length === 2
    && rawTarget === "cli"
    && sessionKeyRoute.provider !== "system"
  ) {
    return withThreadOverride(sessionKeyRoute, explicitThreadId);
  }

  // WebChat addresses the opened session itself. A topic/thread or account
  // inherited from that session's external channel is not a UI address.
  if (normalizedProvider === "webchat") {
    return {
      provider: normalizedProvider,
      accountId: undefined,
      target: rawTarget,
      threadId: undefined,
      sessionKey: originSessionKey?.trim() || undefined,
    };
  }

  const target = normalizedProvider === "discord"
    ? normalizeDiscordTarget(rawTarget, originSessionKey)
    : rawTarget;
  if (shouldPreferTelegramSessionKeyRoute(normalizedProvider, target, sessionKeyRoute)) {
    return {
      provider: normalizedProvider,
      accountId,
      target: sessionKeyRoute.target,
      threadId: explicitThreadId ?? sessionKeyRoute.threadId,
      sessionKey: originSessionKey?.trim() || undefined,
    };
  }

  return {
    provider: normalizedProvider,
    accountId,
    target,
    threadId: explicitThreadId ?? (sessionKeyRoute?.provider === normalizedProvider ? sessionKeyRoute.threadId : undefined),
    sessionKey: originSessionKey?.trim() || undefined,
  };
}

export function canonicalizeSessionRoute(source: SessionRouteSource): SessionRoute | undefined {
  return routeFromOriginMetadata(
    routeToChannelString(source.route) ?? source.originChannel,
    source.route?.threadId ?? source.originThreadId,
    // A blank route key is no key: the origin key applies, as on the next load.
    source.route?.sessionKey?.trim() || source.originSessionKey,
  ) ?? source.route;
}

export function resolveNotificationRoute(source: SessionRouteSource): SessionRoute | undefined {
  const route = canonicalizeSessionRoute(source);
  return isDirectSessionRoute(route) ? route : undefined;
}

function compactRouteObject(route: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(route).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

/**
 * External wake replies use a final message-tool send to the pinned origin
 * route. Its host receipt establishes delivery even for session keys that do
 * not name the external channel (per-peer, cron, sub-agent, ACP or custom
 * keys). WebChat instead uses its own visible final-answer contract below.
 */
export const ROUTED_REPLY_RULE =
  "To tell the user anything, use message(action='send', final=true) to originRoute (channel = provider, target, accountId and threadId only when originRoute has them), then answer NO_REPLY. An ordinary final assistant reply to this wake is private and does not replace the message-tool send.";

export function formatOriginRouteWakeBlock(source: SessionRouteSource): string {
  const route = canonicalizeSessionRoute(source);
  if (!isDirectSessionRoute(route)) return "";

  // The session key is left out: it is not an address the message tool takes.
  const originRoute = compactRouteObject({
    provider: route?.provider,
    accountId: route?.accountId,
    target: route?.target,
    // WebChat has no thread, and a Telegram direct-messages topic is in the target.
    threadId: route?.provider === "webchat" || isTelegramDirectTopicTarget(route?.target)
      ? undefined
      : route?.threadId ?? (source.originThreadId != null ? String(source.originThreadId) : undefined),
  });

  if (Object.keys(originRoute).length === 0) return "";

  const replyRule = route?.provider === "webchat"
    ? "Reply with an ordinary visible final answer in this WebChat session. Do not use the message tool to send this update."
    : ROUTED_REPLY_RULE;
  return [`originRoute: ${JSON.stringify(originRoute)}`, replyRule].join("\n");
}
