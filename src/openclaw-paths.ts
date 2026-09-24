import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve OpenClaw's writable state directory from env or the user's home. */
export function resolveOpenclawHomeDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCLAW_HOME?.trim();
  if (explicit) return explicit;

  const home = env.HOME?.trim() || homedir();
  return join(home, ".openclaw");
}
