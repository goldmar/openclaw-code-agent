export {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
  type OpenClawPluginService,
  type OpenClawPluginServiceContext,
  type PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";

// Host types come from the published SDK above (`OpenClawPluginApi["runtime"]` is
// the public `PluginRuntime`; see src/runtime-store.ts). The interactive handler
// contexts below stay local: the public SDK only publishes the generic
// `PluginInteractiveRegistration<unknown>` (OpenClaw 2026.9.6), and the concrete
// Telegram/Discord callback contexts are owned by the channel plugins without a
// public export. This is the subset of those contracts this plugin consumes.
export type PluginInteractiveHandlerResult = { handled?: boolean } | void;

export type PluginInteractiveTelegramHandlerContext = {
  channel: "telegram";
  accountId?: string;
  callbackId?: string;
  conversationId?: string;
  parentConversationId?: string;
  senderId?: string;
  senderUsername?: string;
  threadId?: number;
  isGroup?: boolean;
  isForum?: boolean;
  auth: { isAuthorizedSender: boolean };
  /** `data` is the full button data; `payload` is the part after `<namespace>:`. */
  callback: {
    data: string;
    namespace: string;
    payload: string;
    messageId: number;
    chatId: string;
    messageText?: string;
  };
  respond: {
    acknowledge?: () => Promise<void>;
    reply: (params: { text: string; buttons?: unknown[] }) => Promise<void>;
    editMessage?: (params: { text: string; buttons?: unknown[] }) => Promise<void>;
    editButtons?: (params: { buttons: unknown[] }) => Promise<void>;
    clearButtons?: () => Promise<void>;
    deleteMessage?: () => Promise<void>;
  };
};

export type PluginInteractiveDiscordHandlerContext = {
  channel: "discord";
  auth: { isAuthorizedSender: boolean };
  /** `data` is the full component callback data; `payload` is the part after `<namespace>:`. */
  interaction: {
    kind: "button" | "select" | "modal";
    data: string;
    namespace: string;
    payload: string;
    messageId?: string;
    values?: string[];
  };
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
  handler:
    | ((ctx: PluginInteractiveTelegramHandlerContext) => Promise<PluginInteractiveHandlerResult>)
    | ((ctx: PluginInteractiveTelegramHandlerContext) => PluginInteractiveHandlerResult);
};

export type PluginInteractiveDiscordHandlerRegistration = {
  channel: "discord";
  namespace: string;
  handler:
    | ((ctx: PluginInteractiveDiscordHandlerContext) => Promise<PluginInteractiveHandlerResult>)
    | ((ctx: PluginInteractiveDiscordHandlerContext) => PluginInteractiveHandlerResult);
};

export type PluginInteractiveTelegramHandlerResult = PluginInteractiveHandlerResult;
export type PluginInteractiveDiscordHandlerResult = PluginInteractiveHandlerResult;
