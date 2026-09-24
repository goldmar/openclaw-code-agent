import { join } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const CODE_AGENT_PLUGIN_ID = "openclaw-code-agent";

/**
 * OpenClaw's state directory, resolved by the host's public
 * `openclaw/plugin-sdk/state-paths` helper so OCA follows the same
 * `OPENCLAW_STATE_DIR` / `OPENCLAW_HOME` rules as the Gateway.
 */
export function resolveOpenClawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStateDir(env);
}

/** Plugin-owned state root: `<stateDir>/plugin-state/openclaw-code-agent`. */
export function resolveCodeAgentStateDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveOpenClawStateDir(env),
): string {
  return join(stateDir, "plugin-state", CODE_AGENT_PLUGIN_ID);
}

/** Directory for persisted per-session output transcripts. */
export function resolveSessionOutputDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCodeAgentStateDir(env), "output");
}
