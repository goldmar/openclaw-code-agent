import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveCodexAuthLockDir, resolveCodexAuthWorkspaceRoot } from "../openclaw-paths";

const DEFAULT_LOCK_RETRY_MS = 50;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

export const CODEX_AUTH_LOCK_DIR = resolveCodexAuthLockDir(process.env);

type AuthSnapshot = {
  lastRefresh: number;
  raw: string;
};

export interface CodexAuthWorkspace {
  tempHome: string;
  tempCodexDir: string;
  canonicalHome: string;
  canonicalCodexDir: string;
  canonicalAuthPath: string;
  canonicalSessionsPath: string;
  canonicalConfigPath?: string;
  env: Record<string, string>;
  prepareForTurn(): Promise<() => Promise<void>>;
  cleanup(): Promise<void>;
}

export interface CodexAuthWorkspaceOptions {
  lockDir?: string;
  lockRetryMs?: number;
  lockTimeoutMs?: number;
  tempRootDir?: string;
}

function buildChildEnv(baseEnv: NodeJS.ProcessEnv, tempHome: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") env[key] = value;
  }

  env.HOME = tempHome;
  return env;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensureSymlink(targetPath: string, linkPath: string): Promise<void> {
  if (await exists(linkPath)) {
    const currentTarget = await readlink(linkPath);
    if (currentTarget === targetPath) return;
    await rm(linkPath, { recursive: true, force: true });
  }

  await symlink(targetPath, linkPath);
}

function normalizeLastRefresh(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

async function readAuthSnapshot(path: string): Promise<AuthSnapshot | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { last_refresh?: unknown } | null;
    if (!parsed || typeof parsed !== "object") return null;

    const lastRefresh = normalizeLastRefresh(parsed.last_refresh);
    if (lastRefresh === null) return null;

    return { lastRefresh, raw };
  } catch {
    return null;
  }
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
}

async function syncCanonicalAuthToTemp(canonicalAuthPath: string, tempAuthPath: string): Promise<void> {
  try {
    const raw = await readFile(canonicalAuthPath, "utf8");
    await atomicWriteText(tempAuthPath, raw);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await rm(tempAuthPath, { force: true });
  }
}

async function syncTempAuthBackIfNewer(tempAuthPath: string, canonicalAuthPath: string): Promise<void> {
  const tempAuth = await readAuthSnapshot(tempAuthPath);
  if (!tempAuth) return;

  const canonicalAuth = await readAuthSnapshot(canonicalAuthPath);
  if (canonicalAuth && tempAuth.lastRefresh <= canonicalAuth.lastRefresh) return;

  await atomicWriteText(canonicalAuthPath, tempAuth.raw);
}

async function acquireLockDir(
  lockDir: string,
  timeoutMs: number,
  retryMs: number,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Codex auth lock at ${lockDir}`);
      }
      await sleep(retryMs);
    }
  }

  try {
    await writeFile(join(lockDir, "holder.json"), JSON.stringify({
      pid: process.pid,
      acquired_at: new Date().toISOString(),
    }), "utf8");
  } catch {
    // Debug metadata is best-effort only.
  }

  let released = false;

  return async () => {
    if (released) return;
    released = true;
    await rm(lockDir, { recursive: true, force: true });
  };
}

export async function createCodexAuthWorkspace(
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: CodexAuthWorkspaceOptions = {},
): Promise<CodexAuthWorkspace> {
  const requestedHome = baseEnv.HOME ?? process.env.HOME;
  if (!requestedHome) {
    throw new Error("Cannot create Codex auth workspace without HOME set");
  }
  const canonicalHome = await realpath(requestedHome).catch(() => resolve(requestedHome));
  const canonicalCodexDir = join(canonicalHome, ".codex");
  const canonicalAuthPath = join(canonicalCodexDir, "auth.json");
  const canonicalSessionsPath = join(canonicalCodexDir, "sessions");
  const configPath = join(canonicalCodexDir, "config.toml");
  const canonicalConfigPath = await exists(configPath) ? configPath : undefined;

  const tempRootDir = resolveCodexAuthWorkspaceRoot(baseEnv, options.tempRootDir);
  const tempHome = join(tempRootDir, `openclaw-codex-auth-${randomUUID()}`);
  const tempCodexDir = join(tempHome, ".codex");
  const tempAuthPath = join(tempCodexDir, "auth.json");
  const lockDir = options.lockDir ?? resolveCodexAuthLockDir(baseEnv);
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;

  await mkdir(tempCodexDir, { recursive: true });
  await ensureSymlink(canonicalSessionsPath, join(tempCodexDir, "sessions"));

  if (canonicalConfigPath) {
    await ensureSymlink(canonicalConfigPath, join(tempCodexDir, "config.toml"));
  }

  return {
    tempHome,
    tempCodexDir,
    canonicalHome,
    canonicalCodexDir,
    canonicalAuthPath,
    canonicalSessionsPath,
    canonicalConfigPath,
    env: buildChildEnv(baseEnv, tempHome),

    async prepareForTurn(): Promise<() => Promise<void>> {
      const releaseLock = await acquireLockDir(lockDir, lockTimeoutMs, lockRetryMs);

      try {
        await syncCanonicalAuthToTemp(canonicalAuthPath, tempAuthPath);
      } catch (error) {
        await releaseLock();
        throw error;
      }

      let released = false;

      return async () => {
        if (released) return;
        released = true;

        try {
          await syncTempAuthBackIfNewer(tempAuthPath, canonicalAuthPath);
        } finally {
          await releaseLock();
        }
      };
    },

    async cleanup(): Promise<void> {
      await rm(tempHome, { recursive: true, force: true });
    },
  };
}
