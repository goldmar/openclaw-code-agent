import type { OpenClawPluginApi } from "../api";

/**
 * Published OpenClaw plugin runtime surface (`api.runtime`).
 *
 * The type comes from the host's public `openclaw/plugin-sdk/plugin-entry`
 * declarations (type-only import; nothing is bundled). Every surface OCA calls
 * exists on the supported OpenClaw floor (2026.9.7), so consumers call it
 * directly; the runtime itself is absent only before registration.
 */
export type PluginRuntime = OpenClawPluginApi["runtime"];

let pluginRuntime: PluginRuntime | undefined;
let runtimeConfig: unknown;
let runtimeConfigLoaded = false;

function loadCurrentRuntimeConfig(runtime: PluginRuntime | undefined): unknown {
  try {
    return runtime?.config?.current?.();
  } catch {
    return undefined;
  }
}

export function setPluginRuntime(runtime: unknown, config?: unknown): void {
  if (runtime && typeof runtime === "object") {
    pluginRuntime = runtime as PluginRuntime;
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

export function getPluginRuntime(): PluginRuntime | undefined {
  return pluginRuntime;
}

export function getRuntimeConfig(): unknown {
  if (!runtimeConfigLoaded) {
    runtimeConfig = loadCurrentRuntimeConfig(pluginRuntime);
    runtimeConfigLoaded = true;
  }
  return runtimeConfig;
}
