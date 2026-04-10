type EmbeddedRunResult = {
  payloads?: Array<{ text?: string }>;
};

type AgentDefaultsModel =
  | string
  | {
      primary?: string;
      [key: string]: unknown;
    };

export interface OpenClawConfigLike {
  agents?: {
    defaults?: {
      model?: AgentDefaultsModel;
      workspace?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

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

type EmbeddedRunParams = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: OpenClawConfigLike;
  prompt: string;
  disableTools?: boolean;
  timeoutMs: number;
  runId: string;
  provider?: string;
  model?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  thinkLevel?: string;
  streamParams?: Record<string, unknown>;
};

export interface PluginRuntimeStore {
  agent?: {
    runEmbeddedPiAgent?: (params: EmbeddedRunParams) => Promise<EmbeddedRunResult>;
  };
  taskFlow?: TaskFlowRuntime;
}

let pluginRuntime: PluginRuntimeStore | undefined;
let openClawConfig: OpenClawConfigLike | undefined;

export function setPluginRuntime(runtime: unknown): void {
  if (runtime && typeof runtime === "object") {
    pluginRuntime = runtime as PluginRuntimeStore;
    return;
  }
  pluginRuntime = undefined;
}

export function getPluginRuntime(): PluginRuntimeStore | undefined {
  return pluginRuntime;
}

export function setOpenClawConfig(config: unknown): void {
  if (config && typeof config === "object") {
    openClawConfig = config as OpenClawConfigLike;
    return;
  }
  openClawConfig = undefined;
}

export function getOpenClawConfig(): OpenClawConfigLike | undefined {
  return openClawConfig;
}
