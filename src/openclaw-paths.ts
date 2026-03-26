import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve OpenClaw's writable state directory from env or the user's home. */
export function resolveOpenclawHomeDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCLAW_HOME?.trim();
  if (explicit) return explicit;

  const home = env.HOME?.trim() || homedir();
  return join(home, ".openclaw");
}

/** Resolve the stable root used for isolated Codex auth workspaces. */
export function resolveCodexAuthWorkspaceRoot(
  env: NodeJS.ProcessEnv,
  explicitRootDir?: string,
): string {
  const explicit = explicitRootDir?.trim();
  if (explicit) return explicit;
  return join(resolveOpenclawHomeDir(env), "codex-auth");
}

/** Resolve the default lock path used to serialize auth bootstrap. */
export function resolveCodexAuthLockDir(env: NodeJS.ProcessEnv): string {
  return join(resolveOpenclawHomeDir(env), "codex-auth.lock");
}
