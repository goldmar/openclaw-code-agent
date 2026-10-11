import type { SessionRoute } from "./types";

/**
 * N2: an action token is bound to the route its buttons were delivered to
 * (`SessionActionToken.route`, stamped at delivery). A callback carrying the
 * token from any other chat is refused, on top of the host's sender check:
 * a token id copied out of one chat must not act from another one.
 *
 * Telegram binds the recorded account, chat and topic. Discord retains its
 * parent-channel/thread binding. Legacy tokens without a route remain subject
 * to the host's sender authorization.
 */
export type CallbackConversation = {
  channel: string;
  /** Host conversation id (`-100…` / `-100…:topic:N` on Telegram, `channel:…` / `user:…` on Discord). */
  conversationId?: string;
  parentConversationId?: string;
  /** Telegram `callback.chatId`. */
  chatId?: string;
  accountId?: string;
  threadId?: string | number;
  isForum?: boolean;
};

type TelegramAddress = { chat: string; scope?: "topic" | "direct-topic"; topic?: string };

function telegramAddress(value: string | undefined): TelegramAddress | undefined {
  const trimmed = value?.trim().replace(/^(?:telegram|tg):/i, "");
  const match = /^(-?\d+)(?::(?:(topic|direct-topic):)?(\d+))?$/i.exec(trimmed ?? "");
  if (!match) return undefined;
  const topic = match[3] === undefined ? undefined : telegramTopicId(match[3]);
  if (match[3] !== undefined && topic === undefined) return undefined;
  if (match[2]?.toLowerCase() === "direct-topic" && topic === "0") return undefined;
  return { chat: match[1]!, scope: topic === undefined ? undefined
    : (match[2]?.toLowerCase() ?? "topic") as TelegramAddress["scope"], topic };
}

function telegramTopicId(value: string | number): string | undefined {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return undefined;
  const id = Number(text);
  return Number.isSafeInteger(id) && id >= 0 ? String(id) : undefined;
}

function telegramMatches(conversation: CallbackConversation, route: SessionRoute): boolean {
  const expected = telegramAddress(route.target);
  if (!expected) return false;
  const addresses: TelegramAddress[] = [];
  for (const value of [conversation.chatId, conversation.parentConversationId, conversation.conversationId]) {
    if (value === undefined) continue;
    const address = telegramAddress(value);
    if (!address || address.chat !== expected.chat) return false;
    addresses.push(address);
  }
  if (!addresses.length) return false;
  if (route.accountId?.trim() && route.accountId.trim() !== conversation.accountId?.trim()) return false;

  const topics = addresses.filter(address => address.scope !== undefined);
  if (topics.some(address => address.scope !== topics[0]?.scope || address.topic !== topics[0]?.topic)) return false;
  const explicitThread = conversation.threadId === undefined ? undefined : telegramTopicId(conversation.threadId);
  const savedThread = route.threadId === undefined ? undefined : telegramTopicId(route.threadId);
  if ((conversation.threadId !== undefined && explicitThread === undefined)
    || (route.threadId !== undefined && savedThread === undefined)) return false;
  const actual = topics[0];
  if (conversation.isForum === true && (actual?.scope === "direct-topic" || expected.scope === "direct-topic")) return false;
  if (conversation.isForum === false && (actual?.scope === "topic" || expected.scope === "topic")) return false;
  if (actual && explicitThread !== undefined && actual.topic !== explicitThread) return false;
  if (expected.scope && savedThread !== undefined
    && (expected.scope === "direct-topic" || expected.topic !== savedThread)) return false;
  if (actual?.scope === "direct-topic" || expected.scope === "direct-topic") {
    return actual?.scope === "direct-topic" && expected.scope === "direct-topic"
      && actual.topic === expected.topic;
  }
  // The host supplies topic 1 for General in forums even when Telegram omits it.
  const actualTopic = actual?.topic ?? explicitThread ?? (conversation.isForum ? "1" : undefined);
  const expectedTopic = expected.topic ?? savedThread
    ?? (conversation.isForum && expected.chat.startsWith("-") ? "1" : undefined);
  return actualTopic === expectedTopic;
}

function discordConversation(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^discord:/i, "");
  if (!trimmed) return undefined;
  if (/^(?:channel|user):\d+$/i.test(trimmed)) return trimmed.toLowerCase();
  return /^\d+$/.test(trimmed) ? `channel:${trimmed}` : undefined;
}

/**
 * Whether a callback from `conversation` may act on a token bound to `route`.
 * A token without a bound route (minted by an older build, or never
 * delivered to a chat) cannot be compared and passes; the host's sender check
 * still applies. A bound token from a callback whose chat cannot be read is
 * refused (fail closed): the hosts always report the callback's chat.
 */
export function callbackMatchesTokenRoute(conversation: CallbackConversation, route: SessionRoute | undefined): boolean {
  const provider = route?.provider?.trim().toLowerCase();
  const target = route?.target?.trim();
  if (!route || !provider || !target || provider === "system" || target === "system") return true;
  if (provider !== conversation.channel) return false;
  if (provider === "telegram") {
    return telegramMatches(conversation, route);
  }
  if (provider === "discord") {
    const expected = discordConversation(target);
    const actual = [conversation.conversationId, conversation.parentConversationId]
      .map(discordConversation)
      .filter((value): value is string => !!value);
    if (!expected) return true;
    if (actual.length === 0) return false;
    // A thread's parent channel, or the thread channel itself (route thread id).
    const threadChannel = route?.threadId && /^\d+$/.test(route.threadId) ? `channel:${route.threadId}` : undefined;
    return actual.some((value) => value === expected || value === threadChannel);
  }
  return true;
}
