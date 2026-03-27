type EmbeddedRunResult = {
  payloads?: Array<{ text?: string }>;
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
