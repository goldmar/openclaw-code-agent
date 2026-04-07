import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { PersistedSessionInfo, SessionActionToken } from "./types";
import { resolveOpenclawHomeDir } from "./openclaw-paths";
import {
  normalizeActionToken,
  normalizePersistedEntry,
  STORE_SCHEMA_VERSION,
  type SessionStoreSchema,
} from "./session-store-normalization";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveSessionIndexPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCLAW_CODE_AGENT_SESSIONS_PATH?.trim();
  if (explicit) return explicit;
  return join(resolveOpenclawHomeDir(env), "code-agent-sessions.json");
}

export function saveSessionStoreIndex(
  indexPath: string,
  sessions: PersistedSessionInfo[],
  actionTokens: SessionActionToken[],
): void {
  try {
    mkdirSync(dirname(indexPath), { recursive: true });
    const tmp = indexPath + ".tmp";
    const payload: SessionStoreSchema = {
      schemaVersion: STORE_SCHEMA_VERSION,
      sessions,
      actionTokens,
    };
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    renameSync(tmp, indexPath);
  } catch (err: unknown) {
    console.warn(`[SessionStore] Failed to save session index: ${errorMessage(err)}`);
  }
}

export function archiveLegacySessionIndex(indexPath: string, reason: string): void {
  try {
    if (!existsSync(indexPath)) return;
    const archivedPath = `${indexPath}.legacy-${Date.now()}.json`;
    renameSync(indexPath, archivedPath);
    console.warn(`[SessionStore] Breaking upgrade: archived ${reason} session store to ${archivedPath}. Legacy sessions are not loaded by this release.`);
  } catch (err: unknown) {
    console.warn(`[SessionStore] Failed to archive legacy session store: ${errorMessage(err)}`);
  }
}

export function archiveLegacyCodexEntries(indexPath: string, entries: unknown[]): void {
  try {
    if (entries.length === 0) return;
    const archivedPath = `${indexPath}.codex-sdk-legacy-${Date.now()}.json`;
    writeFileSync(archivedPath, JSON.stringify(entries, null, 2), "utf-8");
    console.warn(`[SessionStore] Breaking Codex transport upgrade: archived ${entries.length} legacy Codex SDK session(s) to ${archivedPath}. They are not loaded by the App Server backend.`);
  } catch (err: unknown) {
    console.warn(`[SessionStore] Failed to archive legacy Codex SDK sessions: ${errorMessage(err)}`);
  }
}

export function cleanupTmpOutputFiles(now: number, maxAgeMs: number): void {
  try {
    const tmpDir = tmpdir();
    const tmpFiles = readdirSync(tmpDir).filter((f) => f.startsWith("openclaw-agent-") && f.endsWith(".txt"));
    for (const file of tmpFiles) {
      try {
        const filePath = join(tmpDir, file);
        const mtime = statSync(filePath).mtimeMs;
        if (now - mtime > maxAgeMs) {
          unlinkSync(filePath);
        }
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}

export function getNextTmpOutputCleanupAt(now: number, maxAgeMs: number): number | undefined {
  try {
    const tmpDir = tmpdir();
    const tmpFiles = readdirSync(tmpDir).filter((f) => f.startsWith("openclaw-agent-") && f.endsWith(".txt"));
    let nextCleanupAt: number | undefined;
    for (const file of tmpFiles) {
      try {
        const filePath = join(tmpDir, file);
        const expiresAt = statSync(filePath).mtimeMs + maxAgeMs;
        if (expiresAt <= now) return now;
        nextCleanupAt = nextCleanupAt == null ? expiresAt : Math.min(nextCleanupAt, expiresAt);
      } catch {
        // best-effort
      }
    }
    return nextCleanupAt;
  } catch {
    return undefined;
  }
}

export function cleanupOrphanOutputFiles(referencedPaths: Iterable<string>): void {
  try {
    const referenced = new Set(referencedPaths);
    const tmpDir = tmpdir();
    const tmpFiles = readdirSync(tmpDir).filter((f) => f.startsWith("openclaw-agent-") && f.endsWith(".txt"));
    for (const file of tmpFiles) {
      const filePath = join(tmpDir, file);
      if (referenced.has(filePath)) continue;
      try {
        unlinkSync(filePath);
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}

type LoadIndexArgs = {
  indexPath: string;
  clearAll: () => void;
  indexPersistedEntry: (entry: PersistedSessionInfo) => void;
  setActionToken: (token: SessionActionToken) => void;
  purgeExpiredActionTokens: () => void;
  saveIndex: () => void;
};

export function loadSessionStoreIndex(args: LoadIndexArgs): void {
  const {
    indexPath,
    clearAll,
    indexPersistedEntry,
    setActionToken,
    purgeExpiredActionTokens,
    saveIndex,
  } = args;

  try {
    const raw = readFileSync(indexPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      archiveLegacySessionIndex(indexPath, "legacy array store");
      saveIndex();
      return;
    }
    if (
      !isRecord(parsed) ||
      (parsed.schemaVersion !== STORE_SCHEMA_VERSION && parsed.schemaVersion !== 4)
    ) {
      archiveLegacySessionIndex(indexPath, `schema mismatch (expected v${STORE_SCHEMA_VERSION})`);
      saveIndex();
      return;
    }

    const sessionsRaw = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    const archivedLegacyCodex: unknown[] = [];
    for (const candidate of sessionsRaw) {
      if (isRecord(candidate) && candidate.harness === "codex") {
        const backendRef = isRecord(candidate.backendRef) ? candidate.backendRef : undefined;
        const backendKind = typeof backendRef?.kind === "string" ? backendRef.kind : undefined;
        if (backendKind !== "codex-app-server") {
          archivedLegacyCodex.push(candidate);
          continue;
        }
      }
      const entry = normalizePersistedEntry(candidate);
      if (!entry) {
        clearAll();
        archiveLegacySessionIndex(indexPath, "invalid v4 session entry");
        saveIndex();
        return;
      }

      indexPersistedEntry(entry);
    }

    if (archivedLegacyCodex.length > 0) {
      archiveLegacyCodexEntries(indexPath, archivedLegacyCodex);
      saveIndex();
    }

    const tokensRaw = Array.isArray(parsed.actionTokens) ? parsed.actionTokens : [];
    for (const candidate of tokensRaw) {
      const token = normalizeActionToken(candidate);
      if (!token) {
        clearAll();
        archiveLegacySessionIndex(indexPath, "invalid v4 action token");
        saveIndex();
        return;
      }
      setActionToken(token);
    }

    purgeExpiredActionTokens();
  } catch {
    // File doesn't exist yet or is corrupt — start fresh
  }
}
