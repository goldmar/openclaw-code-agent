import type {
  HarnessConfig,
  OpenClawPluginToolContext,
  PluginConfig,
  RawPluginConfig,
  ReasoningEffort,
  SessionRoute,
} from "./types";
import {
  parseThreadIdFromSessionKey,
  routeFromOriginMetadata,
} from "./session-route";

const DEFAULT_HARNESS = "claude-code";
const BUILTIN_HARNESS_CONFIGS: Record<string, HarnessConfig> = {
  "claude-code": {
    defaultModel: "opus",
    allowedModels: ["sonnet", "opus"],
  },
  codex: {
    defaultModel: "gpt-6.1-sol",
    allowedModels: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    // Preserve medium reasoning when Codex changes its model/catalog default.
    reasoningEffort: "medium",
    // No builtin permissionProfile / approvalPolicy / approvalsReviewer:
    // unset values follow the host tools.exec.mode (see resolveCodexExecutionSettings).
  },
  opencode: {},
};

// -- Plugin config singleton --

export let pluginConfig: PluginConfig = {
  maxSessions: 20,
  idleTimeoutMinutes: 15,
  sessionGcAgeMinutes: 1440,
  maxPersistedSessions: 10000,
  maxAutoResponds: 10,
  permissionMode: "plan",
  planApproval: "delegate",
  defaultWorktreeStrategy: "delegate",
  autoUpdate: true,
  worktreeGitHooks: "run",
  harnesses: {
    "claude-code": { ...BUILTIN_HARNESS_CONFIGS["claude-code"] },
    codex: { ...BUILTIN_HARNESS_CONFIGS.codex },
    opencode: { ...BUILTIN_HARNESS_CONFIGS.opencode },
  },
};

/** Replace plugin config singleton with defaults applied for omitted fields. */
export function setPluginConfig(config: Partial<RawPluginConfig>): void {
  const defaultHarness = config.defaultHarness ?? DEFAULT_HARNESS;
  const harnesses: Record<string, HarnessConfig> = {};

  for (const [name, builtin] of Object.entries(BUILTIN_HARNESS_CONFIGS)) {
    const next: HarnessConfig = { ...builtin };
    if (builtin.allowedModels) {
      next.allowedModels = [...builtin.allowedModels];
    }
    harnesses[name] = next;
  }

  for (const [name, value] of Object.entries(config.harnesses ?? {})) {
    const existing = harnesses[name] ?? {};
    const next: HarnessConfig = {
      ...existing,
      defaultModel: value.defaultModel ?? existing.defaultModel,
      reasoningEffort: value.reasoningEffort ?? existing.reasoningEffort,
      fastMode: value.fastMode ?? existing.fastMode,
      permissionProfile: value.permissionProfile ?? existing.permissionProfile,
      approvalPolicy: value.approvalPolicy ?? existing.approvalPolicy,
      approvalsReviewer: value.approvalsReviewer ?? existing.approvalsReviewer,
    };
    if (value.allowedModels !== undefined) {
      next.allowedModels = value.allowedModels ? [...value.allowedModels] : value.allowedModels;
    } else if (value.defaultModel !== undefined) {
      next.allowedModels = undefined;
    }
    harnesses[name] = next;
  }

  pluginConfig = {
    maxSessions: config.maxSessions ?? 20,
    defaultWorkdir: config.defaultWorkdir,
    idleTimeoutMinutes: config.idleTimeoutMinutes ?? 15,
    sessionGcAgeMinutes: config.sessionGcAgeMinutes ?? 1440,
    maxPersistedSessions: config.maxPersistedSessions ?? 10000,
    fallbackChannel: config.fallbackChannel,
    agentChannels: config.agentChannels,
    maxAutoResponds: config.maxAutoResponds ?? 10,
    permissionMode: config.permissionMode ?? "plan",
    planApproval: config.planApproval ?? "delegate",
    defaultHarness,
    harnesses,
    defaultWorktreeStrategy: config.defaultWorktreeStrategy ?? "delegate",
    worktreeDir: config.worktreeDir,
    autoUpdate: config.autoUpdate ?? true,
    worktreeGitHooks: config.worktreeGitHooks === "skip" ? "skip" : "run",
    trustedVerifierCommands: config.trustedVerifierCommands,
    requiredGoalVerifierCommands: Array.isArray(config.requiredGoalVerifierCommands)
      ? [...config.requiredGoalVerifierCommands] : config.requiredGoalVerifierCommands,
    planOfferTool: config.planOfferTool === true,
  };
  getGoalVerifierPolicyRevision();
}

// A verifier proof is stale after any policy transition, including A -> B -> A.
let goalVerifierPolicyKey = "absent";
let goalVerifierPolicyRevision = 0;
export function getGoalVerifierPolicyRevision(): number {
  const raw: unknown = pluginConfig.requiredGoalVerifierCommands;
  const key = raw === undefined ? "absent" : Array.isArray(raw) && raw.length > 0
    && Array.from(raw).every((entry) => typeof entry === "string" && entry.trim())
    ? JSON.stringify(raw.map((entry: string) => entry.trim())) : "invalid";
  if (key !== goalVerifierPolicyKey) {
    goalVerifierPolicyKey = key;
    goalVerifierPolicyRevision += 1;
  }
  return goalVerifierPolicyRevision;
}

/**
 * Effective settings fixed when the shared runtime is built (SessionManager
 * limits and whether the auto-updater exists). Every other setting is read
 * live from `pluginConfig`, which follows the newest plugin registration.
 */
export function resolveRuntimeBuildSettings(config: Partial<RawPluginConfig>): {
  maxSessions: number;
  maxPersistedSessions: number;
  autoUpdate: boolean;
} {
  return {
    maxSessions: config.maxSessions ?? 20,
    maxPersistedSessions: config.maxPersistedSessions ?? 10000,
    autoUpdate: config.autoUpdate ?? true,
  };
}

export function getDefaultHarnessName(): string {
  return pluginConfig.defaultHarness ?? DEFAULT_HARNESS;
}

export function getHarnessConfig(name: string): HarnessConfig {
  const builtin = BUILTIN_HARNESS_CONFIGS[name];
  const configured = pluginConfig.harnesses[name];
  return {
    ...builtin,
    ...configured,
    allowedModels: configured?.allowedModels ?? builtin?.allowedModels,
  };
}

export function resolveDefaultModelForHarness(name: string): string | undefined {
  return getHarnessConfig(name).defaultModel;
}

export function resolveAllowedModelsForHarness(name: string): string[] | undefined {
  return pluginConfig.harnesses[name]?.allowedModels;
}

export function resolveReasoningEffortForHarness(name: string): ReasoningEffort | undefined {
  return getHarnessConfig(name).reasoningEffort;
}

export function resolveFastModeForHarness(name: string): boolean | undefined {
  return name === "codex" ? getHarnessConfig(name).fastMode : undefined;
}

// -- Channel resolution utilities --

interface OriginContextLike {
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  requesterSenderId?: string;
  id?: string | number;
  channel?: string;
  chatId?: string | number;
  senderId?: string | number;
  channelId?: string;
  messageThreadId?: string | number;
  /** Raw "To" of a chat command; the chat itself only on Telegram (see `parseTelegramCommandTarget`). */
  to?: string;
  accountId?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sessionKey?: string;
}

function toOptionalText(value: unknown): string | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function getTrustedDeliveryRoute(ctx: OriginContextLike | undefined): {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
} {
  return {
    channel: toOptionalText(ctx?.deliveryContext?.channel),
    to: toOptionalText(ctx?.deliveryContext?.to),
    accountId: toOptionalText(ctx?.deliveryContext?.accountId),
    threadId: toOptionalText(ctx?.deliveryContext?.threadId),
  };
}

function buildChannelString(channel?: string, to?: string, accountId?: string): string | undefined {
  if (!channel || !to) return undefined;
  return accountId
    ? `${channel}|${accountId}|${to}`
    : `${channel}|${to}`;
}

function getFallbackSenderId(ctx: OriginContextLike | undefined): string | undefined {
  return toOptionalText(ctx?.requesterSenderId ?? ctx?.senderId);
}

function shouldAvoidTelegramSenderFallback(
  ctx: Pick<OriginContextLike, "deliveryContext" | "messageChannel" | "channel" | "sessionKey" | "messageThreadId">,
): boolean {
  const provider = toOptionalText(ctx.deliveryContext?.channel) ?? ctx.messageChannel ?? ctx.channel;
  if (provider?.toLowerCase() !== "telegram") return false;
  return Boolean(
    parseThreadIdFromSessionKey(ctx.sessionKey)
      || toOptionalText(ctx.messageThreadId)
      || toOptionalText(ctx.deliveryContext?.threadId),
  );
}

/**
 * Resolve the notification channel for a tool context.
 * Deduplicates the 7 copies of channel resolution from tool factories.
 *
 * Priority: trusted ctx.deliveryContext → ctx.messageChannel (full, or + accountId/chat id/sender id)
 * → agentChannels(workspaceDir) → pipe-delimited ctx.messageChannel as-is
 */
export function resolveToolChannel(ctx: OpenClawPluginToolContext): string | undefined {
  const trustedRoute = getTrustedDeliveryRoute(ctx);
  const trustedChannel = buildChannelString(trustedRoute.channel, trustedRoute.to, trustedRoute.accountId);
  if (trustedChannel) {
    return trustedChannel;
  }
  if (ctx.messageChannel) {
    const parts = ctx.messageChannel.split("|");
    if (parts.length >= 3) {
      return ctx.messageChannel;
    }
    if (ctx.agentAccountId && parts.length >= 2) {
      return `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
    }
    const legacyChatId = toOptionalText((ctx as OriginContextLike).chatId);
    if (parts.length === 1 && legacyChatId) {
      return `${parts[0]}|${legacyChatId}`;
    }
    const fallbackSenderId = getFallbackSenderId(ctx);
    if (parts.length === 1 && fallbackSenderId && !shouldAvoidTelegramSenderFallback(ctx)) {
      return `${parts[0]}|${fallbackSenderId}`;
    }
  }
  if (ctx.workspaceDir) {
    const ch = resolveAgentChannel(ctx.workspaceDir);
    if (ch) return ch;
  }
  if (ctx.messageChannel && ctx.messageChannel.includes("|")) {
    return ctx.messageChannel;
  }
  return undefined;
}

/**
 * The chat a Telegram chat command was typed in, from the host's `to`:
 * `telegram:<chat>` (native commands; text commands outside forum topics, and
 * in the General topic), `telegram:<chat>:topic:<n>` (text commands in a forum
 * topic) or `telegram:<chat>:direct-topic:<n>` (direct-messages topics, on both
 * paths). Any other shape is not understood.
 */
function parseTelegramCommandTarget(to: unknown): { chat: string; topic?: string; directTopic?: boolean } | undefined {
  const match = /^telegram:(-?\d+)(?::(topic|direct-topic):(\d+))?$/.exec(toOptionalText(to) ?? "");
  if (!match) return undefined;
  return { chat: match[1]!, ...(match[3] ? { topic: match[3], directTopic: match[2] === "direct-topic" } : {}) };
}

/**
 * Resolve origin channel from command/tool context with fallback chain.
 */
export function resolveOriginChannel(ctx: OriginContextLike | undefined, explicitChannel?: string): string {
  if (explicitChannel && String(explicitChannel).includes("|")) {
    return String(explicitChannel);
  }
  const trustedRoute = getTrustedDeliveryRoute(ctx);
  const trustedChannel = buildChannelString(trustedRoute.channel, trustedRoute.to, trustedRoute.accountId);
  if (trustedChannel) {
    return trustedChannel;
  }
  if (ctx?.channelId && String(ctx.channelId).includes("|")) {
    return String(ctx.channelId);
  }
  // A Telegram chat command names its chat (`to: "telegram:<chat id>"`, or
  // `telegram:<chat id>:topic:<n>` for a text command in a forum topic) and the
  // bot account that received it. Keeping that account makes the session's
  // notices leave through the bot the user typed to, and lets a later command
  // in the same chat be recognised (`isCommandInRouteChat`). The topic itself
  // comes from `messageThreadId` (`resolveOriginThreadId`). A direct-messages
  // topic (`telegram:<chat id>:direct-topic:<n>`) stays inside the target: the
  // host delivers that form with `direct_messages_topic_id`, and it is never a
  // thread id. Other providers' `to` is not the chat.
  const commandTarget = parseTelegramCommandTarget(ctx?.to);
  const commandChat = commandTarget?.directTopic
    ? `${commandTarget.chat}:direct-topic:${commandTarget.topic}`
    : commandTarget?.chat;
  const commandAccount = toOptionalText(ctx?.accountId);
  if (commandChat && commandAccount && toOptionalText(ctx?.channel)?.toLowerCase() === "telegram" && !ctx?.messageChannel) {
    return `telegram|${commandAccount}|${commandChat}`;
  }
  if (ctx?.messageChannel) {
    const messageChannel = String(ctx.messageChannel);
    if (messageChannel.includes("|")) {
      return messageChannel;
    }
    const legacyChatId = toOptionalText(ctx.chatId);
    if (legacyChatId) {
      return `${messageChannel}|${legacyChatId}`;
    }
    const fallbackSenderId = getFallbackSenderId(ctx);
    if (fallbackSenderId && !shouldAvoidTelegramSenderFallback(ctx)) {
      return `${messageChannel}|${fallbackSenderId}`;
    }
  }
  const legacyChannel = toOptionalText(ctx?.channel);
  const legacyChatId = toOptionalText(ctx?.chatId);
  if (legacyChannel && legacyChatId) {
    return `${legacyChannel}|${legacyChatId}`;
  }
  const fallbackSenderId = getFallbackSenderId(ctx);
  if (legacyChannel && fallbackSenderId && !shouldAvoidTelegramSenderFallback(ctx)) {
    return `${legacyChannel}|${fallbackSenderId}`;
  }
  if (ctx?.id && /^-?\d+$/.test(String(ctx.id))) {
    return `telegram|${ctx.id}`;
  }
  return pluginConfig.fallbackChannel ?? "unknown";
}

/** Resolve Telegram thread/forum topic ID from command context. */
export function resolveOriginThreadId(ctx: OriginContextLike | undefined): string | number | undefined {
  const trusted = getTrustedDeliveryRoute(ctx).threadId;
  if (trusted !== undefined) return trusted;
  // In a direct-messages topic the host's `messageThreadId` is that topic's id,
  // which is not a thread id (see `resolveOriginChannel`).
  if (parseTelegramCommandTarget(ctx?.to)?.directTopic) return undefined;
  return ctx?.messageThreadId ?? undefined;
}

/** Build the explicit session route used for notifications and wakes. */
export function resolveSessionRoute(
  ctx: OriginContextLike | undefined,
  explicitChannel?: string,
  explicitSessionKey?: string,
): SessionRoute | undefined {
  return routeFromOriginMetadata(
    resolveOriginChannel(ctx, explicitChannel),
    resolveOriginThreadId(ctx),
    explicitSessionKey ?? ctx?.sessionKey,
  );
}

/**
 * A chat command was typed in the chat (and topic) that receives the session's
 * or goal task's notices. Only then may the command's reply replace a notice.
 * Compared on the address the host gives the command (`channel`, `to`,
 * `accountId`, `messageThreadId`), never on the session key: with the default
 * DM scope every DM on every channel shares `agent:<id>:main`. Telegram only:
 * there `to` is the chat (`telegram:<chat id>`; a text command in a forum topic
 * has `telegram:<chat id>:topic:<n>` with the same `<n>` in `messageThreadId`).
 * Elsewhere it is not (WhatsApp: the bot's own number; Discord and Slack:
 * `slash:<user>`), so every other provider and every unknown chat is never
 * "the same chat". A command typed in a direct-messages topic
 * (`telegram:<chat id>:direct-topic:<n>`) matches only a route into that same
 * direct topic (`<chat id>:direct-topic:<n>` as the target, no thread). A wrong
 * "yes" would drop a notice from the chat that should get it, so every form
 * that is not understood is a "no": another `to` shape, or a topic in `to` that
 * differs from `messageThreadId`.
 */
export function isCommandInRouteChat(
  ctx: OriginContextLike | undefined,
  target: { route?: SessionRoute } | undefined,
): boolean {
  const route = target?.route;
  if (!route || route.provider !== "telegram" || toOptionalText(ctx?.channel)?.toLowerCase() !== "telegram") return false;
  const own = parseTelegramCommandTarget(ctx?.to);
  if (!own) return false;
  const thread = toOptionalText(ctx?.messageThreadId);
  if (own.topic && thread && thread !== own.topic) return false;
  const accountId = toOptionalText(ctx?.accountId);
  // A command's bot account must be the route's: a route without one is
  // delivered through the default bot, which need not be the command's.
  if (accountId && accountId !== route.accountId) return false;
  // The host addresses the chat as `telegram:<id>`; stored targets are bare.
  const routeTarget = route.target?.trim().replace(/^telegram:/, "");
  if (own.directTopic) {
    return routeTarget === `${own.chat}:direct-topic:${own.topic}` && String(route.threadId ?? "") === "";
  }
  return own.chat === routeTarget && (thread ?? own.topic ?? "") === String(route.threadId ?? "");
}

/**
 * Whether the host sends nothing for a command that returns `suppressReply`.
 * Observed host difference (OpenClaw 2026.9.8), not a documented contract:
 * Telegram's native command path honours it, while the text-command path
 * (`channels.telegram.commands.native: false`, or a command typed as plain
 * text) ignores it and prints its own "No response generated. Please try
 * again." Only the text path puts `channelId` on the command context.
 */
export function hostHonoursSuppressReply(ctx: { channelId?: unknown } | undefined): boolean {
  return ctx?.channelId === undefined || ctx.channelId === null;
}

/** Extract agentId from "channel|account|target" string. */
export function extractAgentId(channelStr: string): string | undefined {
  const parts = channelStr.split("|");
  if (parts.length >= 3 && parts[1]) return parts[1];
  return undefined;
}

/** Resolve agentId for a workdir via agentChannels config. */
export function resolveAgentId(workdir: string): string | undefined {
  const channel = resolveAgentChannel(workdir);
  if (!channel) return undefined;
  return extractAgentId(channel);
}

/** Look up notification channel for a workdir from agentChannels config (longest-prefix match). */
export function resolveAgentChannel(workdir: string): string | undefined {
  const mapping = pluginConfig.agentChannels;
  if (!mapping) return undefined;

  const normalise = (p: string) => {
    let end = p.length;
    while (end > 0 && p[end - 1] === "/") end -= 1;
    return p.slice(0, end);
  };
  const normWorkdir = normalise(workdir);

  const entries = Object.entries(mapping).sort((a, b) => b[0].length - a[0].length);
  for (const [dir, channel] of entries) {
    if (normWorkdir === normalise(dir) || normWorkdir.startsWith(normalise(dir) + "/")) {
      return channel;
    }
  }
  return undefined;
}
