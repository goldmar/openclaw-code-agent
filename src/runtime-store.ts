type EmbeddedRunResult = {
  payloads?: Array<{ text?: string }>;
};

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
  prompt: string;
  disableTools?: boolean;
  timeoutMs: number;
  runId: string;
};

export interface PluginRuntimeStore {
  agent?: {
    runEmbeddedPiAgent?: (params: EmbeddedRunParams) => Promise<EmbeddedRunResult>;
  };
  taskFlow?: TaskFlowRuntime;
}

let pluginRuntime: PluginRuntimeStore | undefined;

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
