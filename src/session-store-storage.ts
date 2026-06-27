import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { PersistedSessionInfo, RepoPolicyRecord, SessionActionToken } from "./types";
import { resolveOpenclawHomeDir } from "./openclaw-paths";
import {
  normalizeActionToken,
  normalizePersistedEntry,
  normalizeRepoPolicyRecord,
  STORE_SCHEMA_VERSION,
  type SessionStoreSchema,
} from "./session-store-normalization";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logSessionStoreDiagnostic(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({
    component: "SessionStore",
    event,
    at: new Date().toISOString(),
    ...fields,
  }));
}

function getAvailableArchivePath(indexPath: string, archivePrefix: string, now: number = Date.now()): string | undefined {
  const basePath = `${indexPath}.${archivePrefix}-${now}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const candidate = `${basePath}${suffix}.json`;
    if (!existsSync(candidate)) return candidate;
  }
  return undefined;
}

function getTmpOutputFilePaths(): string[] {
  const tmpDir = tmpdir();
  return readdirSync(tmpDir)
    .filter((file) => file.startsWith("openclaw-agent-") && file.endsWith(".txt"))
    .map((file) => join(tmpDir, file));
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
  repoPolicies: RepoPolicyRecord[] = [],
): void {
  try {
    mkdirSync(dirname(indexPath), { recursive: true });
    const tmp = indexPath + ".tmp";
    const payload: SessionStoreSchema = {
      schemaVersion: STORE_SCHEMA_VERSION,
      sessions,
      actionTokens,
      repoPolicies,
    };
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    renameSync(tmp, indexPath);
  } catch (err: unknown) {
    console.warn(`[SessionStore] Failed to save session index: ${errorMessage(err)}`);
  }
}

export function archiveLegacySessionIndex(indexPath: string, reason: string): boolean {
  try {
    if (!existsSync(indexPath)) return false;
    const archivedPath = getAvailableArchivePath(indexPath, "legacy");
    if (!archivedPath) {
      console.warn("[SessionStore] Failed to archive legacy session store: no available archive path");
      return false;
    }
    renameSync(indexPath, archivedPath);
    console.warn(`[SessionStore] Breaking upgrade: archived ${reason} session store to ${archivedPath}. Legacy sessions are not loaded by this release.`);
    return true;
  } catch (err: unknown) {
    console.warn(`[SessionStore] Failed to archive legacy session store: ${errorMessage(err)}`);
    return false;
  }
}

export const sessionStoreStorageInternals = {
  archiveLegacySessionIndex,
};

export function archiveLegacyCodexEntries(indexPath: string, entries: unknown[]): void {
  try {
    if (entries.length === 0) return;
    const archivedPath = getAvailableArchivePath(indexPath, "codex-sdk-legacy");
    if (!archivedPath) {
      console.warn("[SessionStore] Failed to archive legacy Codex SDK sessions: no available archive path");
      return;
    }
    writeFileSync(archivedPath, JSON.stringify(entries, null, 2), "utf-8");
    console.warn(`[SessionStore] Breaking Codex transport upgrade: archived ${entries.length} legacy Codex SDK session(s) to ${archivedPath}. They are not loaded by the App Server backend.`);
  } catch (err: unknown) {
    console.warn(`[SessionStore] Failed to archive legacy Codex SDK sessions: ${errorMessage(err)}`);
  }
}

export function cleanupTmpOutputFiles(now: number, maxAgeMs: number, referencedPaths: Iterable<string> = []): void {
  try {
    const referenced = new Set(referencedPaths);
    for (const filePath of getTmpOutputFilePaths()) {
      if (referenced.has(filePath)) continue;
      try {
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

export function getNextTmpOutputCleanupAt(now: number, maxAgeMs: number, referencedPaths: Iterable<string> = []): number | undefined {
  try {
    const referenced = new Set(referencedPaths);
    let nextCleanupAt: number | undefined;
    for (const filePath of getTmpOutputFilePaths()) {
      if (referenced.has(filePath)) continue;
      try {
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
    for (const filePath of getTmpOutputFilePaths()) {
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
  setRepoPolicy: (policy: RepoPolicyRecord) => void;
  purgeExpiredActionTokens: () => void;
  saveIndex: () => void;
};

export function loadSessionStoreIndex(args: LoadIndexArgs): void {
  const {
    indexPath,
    clearAll,
    indexPersistedEntry,
    setActionToken,
    setRepoPolicy,
    purgeExpiredActionTokens,
    saveIndex,
  } = args;

  const archiveAndReset = (reason: string): boolean => {
    if (!sessionStoreStorageInternals.archiveLegacySessionIndex(indexPath, reason)) return false;
    clearAll();
    return true;
  };

  try {
    const raw = readFileSync(indexPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      if (!archiveAndReset("legacy array store")) return;
      saveIndex();
      return;
    }
    if (
      !isRecord(parsed) ||
      (parsed.schemaVersion !== STORE_SCHEMA_VERSION && parsed.schemaVersion !== 6 && parsed.schemaVersion !== 4)
    ) {
      if (!archiveAndReset(`schema mismatch (expected v${STORE_SCHEMA_VERSION})`)) return;
      saveIndex();
      return;
    }

    const readCollection = (key: "sessions" | "actionTokens" | "repoPolicies", reason: string): unknown[] | undefined => {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) return [];
      const value = parsed[key];
      if (Array.isArray(value)) return value;
      if (!archiveAndReset(reason)) return undefined;
      saveIndex();
      return undefined;
    };

    const sessionsRaw = readCollection("sessions", "invalid sessions collection");
    if (sessionsRaw === undefined) return;
    const archivedLegacyCodex: unknown[] = [];
    const entries: PersistedSessionInfo[] = [];
    let recoveredRunningSession = false;
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
        if (!archiveAndReset("invalid v4 session entry")) return;
        saveIndex();
        return;
      }
      if (isRecord(candidate) && candidate.status === "running") {
        recoveredRunningSession = true;
        logSessionStoreDiagnostic("session.recovered_from_running_persisted_row", {
          sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId : undefined,
          harnessSessionId: typeof candidate.harnessSessionId === "string" ? candidate.harnessSessionId : undefined,
          backendRef: isRecord(candidate.backendRef) ? candidate.backendRef : undefined,
          rawStatus: candidate.status,
          rawLifecycle: candidate.lifecycle,
          rawRuntimeState: candidate.runtimeState,
          normalizedStatus: entry.status,
          normalizedLifecycle: entry.lifecycle,
          normalizedRuntimeState: entry.runtimeState,
          reason: entry.runtimeRecovery?.reason,
        });
      }

      entries.push(entry);
    }

    if (archivedLegacyCodex.length > 0) {
      archiveLegacyCodexEntries(indexPath, archivedLegacyCodex);
    }

    const tokensRaw = readCollection("actionTokens", "invalid action token collection");
    if (tokensRaw === undefined) return;
    const tokens: SessionActionToken[] = [];
    for (const candidate of tokensRaw) {
      const token = normalizeActionToken(candidate);
      if (!token) {
        if (!archiveAndReset("invalid v4 action token")) return;
        saveIndex();
        return;
      }
      tokens.push(token);
    }

    const policiesRaw = readCollection("repoPolicies", "invalid repo policy collection");
    if (policiesRaw === undefined) return;
    const policies: RepoPolicyRecord[] = [];
    let skippedInvalidRepoPolicy = false;
    for (const candidate of policiesRaw) {
      const policy = normalizeRepoPolicyRecord(candidate);
      if (!policy) {
        skippedInvalidRepoPolicy = true;
        console.warn("[SessionStore] Skipping invalid repo policy entry while loading session store.");
        continue;
      }
      policies.push(policy);
    }

    for (const entry of entries) indexPersistedEntry(entry);
    for (const token of tokens) setActionToken(token);
    for (const policy of policies) setRepoPolicy(policy);

    if (archivedLegacyCodex.length > 0 || recoveredRunningSession) saveIndex();
    if (skippedInvalidRepoPolicy) saveIndex();

    purgeExpiredActionTokens();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist yet — start fresh without creating it.
      return;
    }
    if (!archiveAndReset("corrupt or unreadable")) return;
    saveIndex();
  }
}
