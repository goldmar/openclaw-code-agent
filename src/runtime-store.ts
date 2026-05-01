type TaskFlowHandle = {
  id?: string;
  lookupKey?: string;
  [key: string]: unknown;
};

type TaskFlowRuntime = {
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
}

let pluginRuntime: PluginRuntimeStore | undefined;
let runtimeConfig: unknown;

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
    } else if (runtimeConfig == null) {
      runtimeConfig = loadCurrentRuntimeConfig(pluginRuntime);
    }
    return;
  }
  pluginRuntime = undefined;
  runtimeConfig = undefined;
}

export function getPluginRuntime(): PluginRuntimeStore | undefined {
  return pluginRuntime;
}

export function getRuntimeConfig(): unknown {
  if (runtimeConfig == null) {
    runtimeConfig = loadCurrentRuntimeConfig(pluginRuntime);
  }
  return runtimeConfig;
}
