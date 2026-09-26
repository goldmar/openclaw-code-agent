import type { SessionRoute } from "./types";

/**
 * N2: an action token is bound to the chat its buttons were delivered to
 * (`SessionActionToken.route`, stamped at delivery). A callback carrying the
 * token from any other chat is refused, on top of the host's sender check:
 * a token id copied out of one chat must not act from another one.
 *
 * Binding is per chat, not per topic or thread: a Telegram forum topic or a
 * Discord thread of the same chat still matches.
 */
export type CallbackConversation = {
  channel: string;
  /** Host conversation id (`-100…` / `-100…:topic:N` on Telegram, `channel:…` / `user:…` on Discord). */
  conversationId?: string;
  parentConversationId?: string;
  /** Telegram `callback.chatId`. */
  chatId?: string;
};

function telegramChatId(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/^(?:telegram|tg):/i, "");
  if (!trimmed) return undefined;
  const chat = trimmed.replace(/:(?:direct-)?topic:\d+$/i, "");
  return /^-?\d+$/.test(chat) ? chat : undefined;
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
  if (!provider || !target || provider === "system" || target === "system") return true;
  if (provider !== conversation.channel) return false;
  if (provider === "telegram") {
    const expected = telegramChatId(target);
    const actual = telegramChatId(conversation.chatId)
      ?? telegramChatId(conversation.parentConversationId)
      ?? telegramChatId(conversation.conversationId);
    if (!expected) return true;
    return actual !== undefined && expected === actual;
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
