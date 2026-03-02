import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { PluginConfig, OpenClawPluginToolContext } from "./types";

// -- Global MCP servers from ~/.claude.json --

/** MCP server definitions from the user's global Claude config. */
export type McpServerConfig = Record<string, { type: string; command: string; args?: string[]; env?: Record<string, string> }>;

let cachedMcpServers: McpServerConfig | undefined;

export function getGlobalMcpServers(): McpServerConfig {
  if (cachedMcpServers !== undefined) return cachedMcpServers;
  try {
    const raw = readFileSync(join(homedir(), ".claude.json"), "utf-8");
    const parsed = JSON.parse(raw);
    cachedMcpServers = parsed.mcpServers ?? {};
  } catch {
    cachedMcpServers = {};
  }
  return cachedMcpServers!;
}

// -- Plugin config singleton --

export let pluginConfig: PluginConfig = {
  maxSessions: 5,
  idleTimeoutMinutes: 30,
  maxPersistedSessions: 50,
  maxAutoResponds: 10,
  permissionMode: "plan",
  planApproval: "delegate",
};

export function setPluginConfig(config: Partial<PluginConfig>): void {
  pluginConfig = {
    maxSessions: config.maxSessions ?? 5,
    defaultModel: config.defaultModel,
    defaultWorkdir: config.defaultWorkdir,
    idleTimeoutMinutes: config.idleTimeoutMinutes ?? 30,
    postTurnIdleMinutes: config.postTurnIdleMinutes,
    maxPersistedSessions: config.maxPersistedSessions ?? 50,
    fallbackChannel: config.fallbackChannel,
    agentChannels: config.agentChannels,
    maxAutoResponds: config.maxAutoResponds ?? 10,
    permissionMode: config.permissionMode ?? "plan",
    planApproval: config.planApproval ?? "delegate",
  };
}

// -- Channel resolution utilities --

/**
 * Resolve the notification channel for a tool context.
 * Deduplicates the 7 copies of channel resolution from tool factories.
 *
 * Priority: ctx.messageChannel + accountId → agentChannels(workspaceDir) → ctx.messageChannel as-is
 */
export function resolveToolChannel(ctx: OpenClawPluginToolContext): string | undefined {
  if (ctx.messageChannel && ctx.agentAccountId) {
    const parts = ctx.messageChannel.split("|");
    if (parts.length >= 2) {
      return `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
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
 * Resolve origin channel from command/tool context with fallback chain.
 */
export function resolveOriginChannel(ctx: any, explicitChannel?: string): string {
  if (explicitChannel && String(explicitChannel).includes("|")) {
    return String(explicitChannel);
  }
  if (ctx?.channel && ctx?.chatId) {
    return `${ctx.channel}|${ctx.chatId}`;
  }
  if (ctx?.channel && ctx?.senderId) {
    return `${ctx.channel}|${ctx.senderId}`;
  }
  if (ctx?.id && /^-?\d+$/.test(String(ctx.id))) {
    return `telegram|${ctx.id}`;
  }
  if (ctx?.channelId && String(ctx.channelId).includes("|")) {
    return String(ctx.channelId);
  }
  return pluginConfig.fallbackChannel ?? "unknown";
}

/** Resolve Telegram thread/forum topic ID from command context. */
export function resolveOriginThreadId(ctx: any): string | number | undefined {
  return ctx?.messageThreadId ?? undefined;
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

  const normalise = (p: string) => p.replace(/\/+$/, "");
  const normWorkdir = normalise(workdir);

  const entries = Object.entries(mapping).sort((a, b) => b[0].length - a[0].length);
  for (const [dir, channel] of entries) {
    if (normWorkdir === normalise(dir) || normWorkdir.startsWith(normalise(dir) + "/")) {
      return channel;
    }
  }
  return undefined;
}

/** Parse Telegram thread ID from sessionKey format "...:topic:THREADID". */
export function parseThreadIdFromSessionKey(sessionKey?: string): number | undefined {
  if (!sessionKey) return undefined;
  const match = sessionKey.match(/:topic:(\d+)$/);
  return match ? parseInt(match[1], 10) : undefined;
}
