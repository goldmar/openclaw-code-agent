import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type {
  CodexApprovalPolicy,
  HarnessConfig,
  OpenClawPluginToolContext,
  PluginConfig,
  RawPluginConfig,
  ReasoningEffort,
} from "./types";

// -- Global MCP servers from ~/.claude.json --

/** MCP server definitions from the user's global Claude config. */
export type McpServerConfig = Record<string, { type: string; command: string; args?: string[]; env?: Record<string, string> }>;

let cachedMcpServers: McpServerConfig | undefined;
const DEFAULT_HARNESS = "claude-code";
const BUILTIN_HARNESS_CONFIGS: Record<string, HarnessConfig> = {
  "claude-code": {
    defaultModel: "sonnet",
    allowedModels: ["sonnet", "opus"],
  },
  codex: {
    defaultModel: "gpt-5.4",
    allowedModels: ["gpt-5.4"],
    reasoningEffort: "medium",
    approvalPolicy: "on-request",
  },
};

/** Load and cache global MCP server definitions from `~/.claude.json`. */
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
  maxSessions: 20,
  idleTimeoutMinutes: 15,
  sessionGcAgeMinutes: 1440,
  maxPersistedSessions: 10000,
  maxAutoResponds: 10,
  permissionMode: "plan",
  planApproval: "ask",
  codexApprovalPolicy: "on-request",
  harnesses: {
    "claude-code": { ...BUILTIN_HARNESS_CONFIGS["claude-code"] },
    codex: { ...BUILTIN_HARNESS_CONFIGS.codex },
  },
};

/** Replace plugin config singleton with defaults applied for omitted fields. */
export function setPluginConfig(config: Partial<RawPluginConfig>): void {
  const defaultHarness = config.defaultHarness ?? DEFAULT_HARNESS;
  const harnesses: Record<string, HarnessConfig> = {};

  for (const [name, builtin] of Object.entries(BUILTIN_HARNESS_CONFIGS)) {
    harnesses[name] = {
      ...builtin,
      allowedModels: builtin.allowedModels ? [...builtin.allowedModels] : undefined,
    };
  }

  for (const [name, value] of Object.entries(config.harnesses ?? {})) {
    const existing = harnesses[name] ?? {};
    const next: HarnessConfig = {
      ...existing,
      ...value,
    };
    if (value.allowedModels !== undefined) {
      next.allowedModels = value.allowedModels ? [...value.allowedModels] : value.allowedModels;
    } else if (value.defaultModel !== undefined) {
      next.allowedModels = undefined;
    }
    harnesses[name] = next;
  }

  if (config.defaultModel !== undefined) {
    const existing = harnesses[defaultHarness] ?? {};
    harnesses[defaultHarness] = {
      ...existing,
      defaultModel: (config.harnesses?.[defaultHarness]?.defaultModel ?? config.defaultModel),
      allowedModels: config.harnesses?.[defaultHarness]?.allowedModels !== undefined
        ? existing.allowedModels
        : config.allowedModels,
    };
    console.warn(
      `[openclaw-code-agent] config.defaultModel is deprecated; use harnesses.${defaultHarness}.defaultModel instead.`,
    );
  }

  if (config.model !== undefined) {
    const existing = harnesses.codex ?? {};
    harnesses.codex = {
      ...existing,
      defaultModel: (config.harnesses?.codex?.defaultModel ?? config.model),
      allowedModels: config.harnesses?.codex?.allowedModels !== undefined ? existing.allowedModels : config.allowedModels,
    };
    console.warn("[openclaw-code-agent] config.model is deprecated; use harnesses.codex.defaultModel instead.");
  }

  if (config.reasoningEffort !== undefined) {
    const existing = harnesses.codex ?? {};
    harnesses.codex = {
      ...existing,
      reasoningEffort: (config.harnesses?.codex?.reasoningEffort ?? config.reasoningEffort),
    };
    console.warn("[openclaw-code-agent] config.reasoningEffort is deprecated; use harnesses.codex.reasoningEffort instead.");
  }

  if (config.codexApprovalPolicy !== undefined) {
    const existing = harnesses.codex ?? {};
    harnesses.codex = {
      ...existing,
      approvalPolicy: (config.harnesses?.codex?.approvalPolicy ?? config.codexApprovalPolicy),
    };
    console.warn("[openclaw-code-agent] config.codexApprovalPolicy is deprecated; use harnesses.codex.approvalPolicy instead.");
  }

  if (config.allowedModels !== undefined) {
    console.warn("[openclaw-code-agent] config.allowedModels is deprecated; use harnesses.<name>.allowedModels instead.");
    for (const [name, existing] of Object.entries(harnesses)) {
      if (config.harnesses?.[name]?.allowedModels === undefined) {
        harnesses[name] = {
          ...existing,
          allowedModels: undefined,
        };
      }
    }
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
    codexApprovalPolicy: config.codexApprovalPolicy ?? "on-request",
    planApproval: config.planApproval ?? "ask",
    defaultHarness,
    harnesses,
    allowedModels: config.allowedModels,
    defaultWorktreeStrategy: config.defaultWorktreeStrategy ?? "ask",
    worktreeDir: config.worktreeDir,
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
  return pluginConfig.harnesses[name]?.allowedModels ?? pluginConfig.allowedModels;
}

export function resolveReasoningEffortForHarness(name: string): ReasoningEffort | undefined {
  return getHarnessConfig(name).reasoningEffort;
}

export function resolveApprovalPolicyForHarness(name: string): CodexApprovalPolicy | undefined {
  return getHarnessConfig(name).approvalPolicy;
}

// -- Channel resolution utilities --

interface OriginContextLike {
  id?: string | number;
  channel?: string;
  chatId?: string | number;
  senderId?: string | number;
  channelId?: string;
  messageThreadId?: string | number;
  messageChannel?: string;
  agentAccountId?: string;
}

/**
 * Resolve the notification channel for a tool context.
 * Deduplicates the 7 copies of channel resolution from tool factories.
 *
 * Priority: ctx.messageChannel + accountId → agentChannels(workspaceDir) → ctx.messageChannel as-is
 */
export function resolveToolChannel(ctx: OpenClawPluginToolContext): string | undefined {
  if (ctx.messageChannel) {
    const parts = ctx.messageChannel.split("|");
    if (parts.length >= 3) {
      return ctx.messageChannel;
    }
    if (ctx.agentAccountId && parts.length >= 2) {
      return `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
    }
    if (parts.length === 1 && ctx.chatId) {
      return `${parts[0]}|${ctx.chatId}`;
    }
    if (parts.length === 1 && ctx.senderId) {
      return `${parts[0]}|${ctx.senderId}`;
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
export function resolveOriginChannel(ctx: OriginContextLike | undefined, explicitChannel?: string): string {
  if (explicitChannel && String(explicitChannel).includes("|")) {
    return String(explicitChannel);
  }
  if (ctx?.channelId && String(ctx.channelId).includes("|")) {
    return String(ctx.channelId);
  }
  if (ctx?.messageChannel) {
    const messageChannel = String(ctx.messageChannel);
    if (messageChannel.includes("|")) {
      return messageChannel;
    }
    if (ctx.chatId) {
      return `${messageChannel}|${ctx.chatId}`;
    }
    if (ctx.senderId) {
      return `${messageChannel}|${ctx.senderId}`;
    }
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
  return pluginConfig.fallbackChannel ?? "unknown";
}

/** Resolve Telegram thread/forum topic ID from command context. */
export function resolveOriginThreadId(ctx: OriginContextLike | undefined): string | number | undefined {
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
