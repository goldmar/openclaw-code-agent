export {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
  type OpenClawPluginService,
  type OpenClawPluginServiceContext,
  type PluginLogger,
} from "openclaw/plugin-sdk/core";

// OpenClaw v2026.4.8 widened `registerInteractiveHandler(...)` to a generic
// registration type, so `Parameters<...>[0]` no longer preserves the concrete
// Telegram/Discord callback contracts. Keep a local compatibility surface for
// the subset this plugin actually consumes.
export type PluginInteractiveHandlerResult = { handled?: boolean } | void;

export type PluginInteractiveTelegramHandlerContext = {
  channel: "telegram";
  auth: { isAuthorizedSender: boolean };
  callback?: { payload?: string };
  respond: {
    reply: (params: { text: string; buttons?: unknown[] }) => Promise<void>;
    editMessage?: (params: { text: string; buttons?: unknown[] }) => Promise<void>;
    clearButtons?: () => Promise<void>;
  };
};

export type PluginInteractiveDiscordHandlerContext = {
  channel: "discord";
  auth: { isAuthorizedSender: boolean };
  interaction?: { payload?: string };
  respond: {
    acknowledge?: () => Promise<void>;
    reply: (params: { text: string; ephemeral?: boolean }) => Promise<void>;
    editMessage?: (params: { text?: string; components?: unknown }) => Promise<void>;
    clearComponents?: (params?: { text?: string }) => Promise<void>;
    followUp?: (params: { text: string; ephemeral?: boolean }) => Promise<void>;
  };
};

export type PluginInteractiveTelegramHandlerRegistration = {
  channel: "telegram";
  namespace: string;
  handler: (ctx: PluginInteractiveTelegramHandlerContext) => Promise<PluginInteractiveHandlerResult> | PluginInteractiveHandlerResult;
};

export type PluginInteractiveDiscordHandlerRegistration = {
  channel: "discord";
  namespace: string;
  handler: (ctx: PluginInteractiveDiscordHandlerContext) => Promise<PluginInteractiveHandlerResult> | PluginInteractiveHandlerResult;
};

export type PluginInteractiveTelegramHandlerResult = PluginInteractiveHandlerResult;
export type PluginInteractiveDiscordHandlerResult = PluginInteractiveHandlerResult;
