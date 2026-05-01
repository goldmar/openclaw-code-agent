type TaskFlowHandle = {
  id?: string;
  lookupKey?: string;
  flowId?: string;
  revision?: number;
  [key: string]: unknown;
};

type TaskFlowRuntime = {
  fromToolContext?: (ctx: { sessionKey?: string; deliveryContext?: unknown }) => unknown;
  get?: (lookup: string) => Promise<TaskFlowHandle | undefined>;
  lookup?: (lookup: string) => Promise<TaskFlowHandle | undefined>;
  show?: (lookup: string) => Promise<TaskFlowHandle | undefined>;
  [key: string]: unknown;
};

type RuntimeChannelOutboundAdapter = {
  sendText?: (ctx: {
    cfg: unknown;
    to: string;
    text: string;
    accountId?: string | null;
    threadId?: string | number | null;
  }) => Promise<unknown>;
  sendPayload?: (ctx: {
    cfg: unknown;
    to: string;
    text: string;
    payload: unknown;
    accountId?: string | null;
    threadId?: string | number | null;
  }) => Promise<unknown>;
  renderPresentation?: (params: {
    payload: unknown;
    presentation: unknown;
    ctx: {
      cfg: unknown;
      to: string;
      text: string;
      payload: unknown;
      accountId?: string | null;
      threadId?: string | number | null;
    };
  }) => Promise<unknown> | unknown;
};

type RuntimeChannel = {
  outbound?: {
    loadAdapter?: (channelId: string) => Promise<RuntimeChannelOutboundAdapter | undefined>;
  };
};

type RuntimeConfigStore = {
  current?: () => unknown;
};

export interface PluginRuntimeStore {
  taskFlow?: TaskFlowRuntime;
  channel?: RuntimeChannel;
  config?: RuntimeConfigStore;
  tasks?: Record<string, unknown>;
}

let pluginRuntime: PluginRuntimeStore | undefined;
let runtimeConfig: unknown;
let runtimeConfigLoaded = false;

function loadCurrentRuntimeConfig(runtime: PluginRuntimeStore | undefined): unknown {
  try {
    return runtime?.config?.current?.();
  } catch {
    return undefined;
  }
}

export function setPluginRuntime(runtime: unknown, config?: unknown): void {
  if (runtime && typeof runtime === "object") {
    pluginRuntime = runtime as PluginRuntimeStore;
    if (arguments.length >= 2) {
      runtimeConfig = config;
      runtimeConfigLoaded = true;
    } else if (!runtimeConfigLoaded) {
      runtimeConfig = loadCurrentRuntimeConfig(pluginRuntime);
      runtimeConfigLoaded = true;
    }
    return;
  }
  pluginRuntime = undefined;
  runtimeConfig = undefined;
  runtimeConfigLoaded = false;
}

export function getPluginRuntime(): PluginRuntimeStore | undefined {
  return pluginRuntime;
}

export function getRuntimeConfig(): unknown {
  if (!runtimeConfigLoaded) {
    runtimeConfig = loadCurrentRuntimeConfig(pluginRuntime);
    runtimeConfigLoaded = true;
  }
  return runtimeConfig;
}
