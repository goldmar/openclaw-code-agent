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
  if (!sessionKey) return undefined;
  const match = sessionKey.match(/^agent:[^:]+:discord:(direct|dm|channel|group):/i);
  if (!match?.[1]) return undefined;
  const kind = match[1].toLowerCase();
  return kind === "direct" || kind === "dm" ? "user" : "channel";
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

function parseThreadSuffix(value: string): { id: string; threadId?: string } {
  const normalizedValue = value.toLowerCase();
  const markers = [":thread:", ":topic:"];

  for (const marker of markers) {
    const index = normalizedValue.lastIndexOf(marker);
    if (index === -1) continue;
    const id = value.slice(0, index).trim();
    const threadId = value.slice(index + marker.length).trim() || undefined;
    return { id: id || value, threadId };
  }

  return { id: value };
}

function parseSessionConversationRef(
  originSessionKey?: string,
): { provider: string; kind: string; rawId: string } | undefined {
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

function routeFromSessionKey(originSessionKey?: string): SessionRoute | undefined {
  const trimmed = originSessionKey?.trim();
  if (!trimmed) return undefined;

  const parsed = parseSessionConversationRef(trimmed);
  if (!parsed) return undefined;

  const { provider, kind, rawId } = parsed;
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
    target,
    threadId,
    sessionKey: trimmed,
  };
}

export function parseThreadIdFromSessionKey(sessionKey?: string): number | undefined {
  const match = sessionKey?.match(/:topic:(\d+)$/);
  return match ? parseInt(match[1], 10) : undefined;
}

export function isDirectSessionRoute(route?: SessionRoute): boolean {
  return Boolean(route?.provider && route.target && route.provider !== "system" && route.target !== "system");
}

export function routeFromOriginMetadata(
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

  const target = normalizedProvider === "discord"
    ? normalizeDiscordTarget(rawTarget, originSessionKey)
    : rawTarget;

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
    source.route?.sessionKey ?? source.originSessionKey,
  ) ?? source.route;
}

export function resolveNotificationRoute(source: SessionRouteSource): SessionRoute | undefined {
  const route = canonicalizeSessionRoute(source);
  return isDirectSessionRoute(route) ? route : undefined;
}
