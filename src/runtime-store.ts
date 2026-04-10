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

export interface PluginRuntimeStore {
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
