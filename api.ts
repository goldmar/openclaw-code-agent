export {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
  type OpenClawPluginService,
  type OpenClawPluginServiceContext,
  type PluginLogger,
} from "openclaw/plugin-sdk/core";

type PluginInteractiveHandlerResult = { handled?: boolean } | void;

export type PluginInteractiveTelegramHandlerContext = {
  channel: "telegram";
  auth: {
    isAuthorizedSender: boolean;
  };
  callback: {
    payload: string;
  };
  respond: {
    reply: (params: { text: string; buttons?: [] }) => Promise<void>;
    editMessage: (params: { text: string; buttons?: [] }) => Promise<void>;
    clearButtons: () => Promise<void>;
  };
};

export type PluginInteractiveTelegramHandlerResult = PluginInteractiveHandlerResult;

export type PluginInteractiveDiscordHandlerContext = {
  channel: "discord";
  auth: {
    isAuthorizedSender: boolean;
  };
  interaction?: {
    payload: string;
  };
  callback?: {
    payload: string;
  };
  respond: {
    acknowledge?: () => Promise<void>;
    reply: (params: { text: string; ephemeral?: boolean }) => Promise<void>;
    editMessage?: (params: { text?: string }) => Promise<void>;
    clearButtons?: () => Promise<void>;
    clearComponents?: (params?: { text?: string }) => Promise<void>;
  };
};

export type PluginInteractiveDiscordHandlerResult = PluginInteractiveHandlerResult;
