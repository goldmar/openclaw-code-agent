import { getPluginRuntime } from "./runtime-store";

export interface PluginTaskFlowRuntime {
  get?: (lookup: string) => Promise<unknown>;
  lookup?: (lookup: string) => Promise<unknown>;
  show?: (lookup: string) => Promise<unknown>;
  [key: string]: unknown;
}

export interface TaskFlowRuntimeAvailability {
  available: boolean;
  runtime?: PluginTaskFlowRuntime;
}

function isTaskFlowRuntime(value: unknown): value is PluginTaskFlowRuntime {
  if (!value || typeof value !== "object") return false;
  return typeof (value as { get?: unknown }).get === "function"
    || typeof (value as { lookup?: unknown }).lookup === "function"
    || typeof (value as { show?: unknown }).show === "function";
}

export function resolveTaskFlowRuntime(): PluginTaskFlowRuntime | undefined {
  const runtime = getPluginRuntime()?.taskFlow;
  return isTaskFlowRuntime(runtime) ? runtime : undefined;
}

export function getTaskFlowRuntimeAvailability(): TaskFlowRuntimeAvailability {
  const runtime = resolveTaskFlowRuntime();
  return runtime ? { available: true, runtime } : { available: false };
}
