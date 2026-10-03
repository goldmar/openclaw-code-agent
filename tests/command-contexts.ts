/**
 * Chat-command contexts in the shape the OpenClaw host passes to a plugin
 * command (`PluginCommandContext`): top-level `channel`, `to`, `accountId`,
 * `messageThreadId`, `senderId` and `sessionKey`, and never a
 * `deliveryContext`. Telegram has two paths:
 *
 * - native commands (the default): `to` is the bare chat, also in a forum
 *   topic; there is no `channelId`;
 * - text commands (`channels.telegram.commands.native: false`, or a command
 *   typed as plain text): `channelId` is set, and in a forum topic `to` is
 *   `telegram:<chat>:topic:<n>`. In the General topic `to` stays bare and
 *   `messageThreadId` is 1.
 *
 * A direct-messages topic is `telegram:<chat>:direct-topic:<n>` on both paths.
 */
// A type alias, not an interface: it is assignable to `Record<string, unknown>` handler parameters.
export type TelegramCommandContext = {
  channel: "telegram";
  channelId?: "telegram";
  to: string;
  accountId: string;
  messageThreadId?: number;
  senderId: string;
  sessionKey: string;
};

export const COMMAND_GROUP = "-1001234567890";
export const COMMAND_SENDER = "1234";

interface TopicCommandInput {
  chat?: string;
  topic: number;
  accountId?: string;
}

function topicSessionKey(chat: string, topic: number): string {
  return `agent:main:telegram:group:${chat}:topic:${topic}`;
}

/** A native Telegram command typed in a forum topic. */
export function nativeTopicCommand({ chat = COMMAND_GROUP, topic, accountId = "bot1" }: TopicCommandInput): TelegramCommandContext {
  return {
    channel: "telegram",
    to: `telegram:${chat}`,
    accountId,
    messageThreadId: topic,
    senderId: COMMAND_SENDER,
    sessionKey: topicSessionKey(chat, topic),
  };
}

/** A Telegram text command typed in a forum topic (General is topic 1, with a bare `to`). */
export function textTopicCommand({ chat = COMMAND_GROUP, topic, accountId = "bot1" }: TopicCommandInput): TelegramCommandContext {
  return {
    channel: "telegram",
    channelId: "telegram",
    to: topic === 1 ? `telegram:${chat}` : `telegram:${chat}:topic:${topic}`,
    accountId,
    messageThreadId: topic,
    senderId: COMMAND_SENDER,
    sessionKey: topicSessionKey(chat, topic),
  };
}

/** A command typed in a direct-messages topic (same `to` on both paths). */
export function directTopicCommand({ chat = COMMAND_SENDER, topic, accountId = "bot1" }: TopicCommandInput, path: "native" | "text" = "native"): TelegramCommandContext {
  return {
    channel: "telegram",
    ...(path === "text" ? { channelId: "telegram" as const } : {}),
    to: `telegram:${chat}:direct-topic:${topic}`,
    accountId,
    messageThreadId: topic,
    senderId: COMMAND_SENDER,
    sessionKey: "agent:main:main",
  };
}

/** A command typed in a Telegram DM with the default (shared) session scope. */
export function dmCommand({ chat = COMMAND_SENDER, accountId = "bot1" }: { chat?: string; accountId?: string } = {}, path: "native" | "text" = "native"): TelegramCommandContext {
  return {
    channel: "telegram",
    ...(path === "text" ? { channelId: "telegram" as const } : {}),
    to: `telegram:${chat}`,
    accountId,
    senderId: COMMAND_SENDER,
    sessionKey: "agent:main:main",
  };
}
