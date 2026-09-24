import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveJsonFile } from "openclaw/plugin-sdk/json-store";
import type { PersistedSessionInfo, RepoPolicyRecord, SessionActionToken } from "./types";
import { SESSION_OUTPUT_FILE_PREFIX, SESSION_OUTPUT_FILE_SUFFIX } from "./session-output";
import { resolveOpenClawStateDir, resolveSessionOutputDir } from "./state-paths";
import {
  normalizeActionToken,
  normalizePersistedEntry,
  normalizeRepoPolicyRecord,
  STORE_SCHEMA_VERSION,
  type SessionStoreSchema,
} from "./session-store-normalization";
import { createLogger } from "./logger";

const log = createLogger("session-store-storage");

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logSessionStoreDiagnostic(event: string, fields: Record<string, unknown>): void {
  log.warn(JSON.stringify({
    component: "SessionStore",
    event,
    at: new Date().toISOString(),
    ...fields,
  }));
}

function backendRefDiagnosticFields(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  return {
    backendRefKind: typeof raw.kind === "string" ? raw.kind : undefined,
    hasBackendConversationId: typeof raw.conversationId === "string" && raw.conversationId.length > 0,
    hasBackendRunId: typeof raw.runId === "string" && raw.runId.length > 0,
  };
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

function listSessionOutputFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.startsWith(SESSION_OUTPUT_FILE_PREFIX) && file.endsWith(SESSION_OUTPUT_FILE_SUFFIX))
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

/**
 * Output files live in the plugin state dir. Releases before 5.0.0 wrote them to
 * the OS temp dir; those legacy files are still honored by stored `outputPath`
 * references and are aged out by the same maintenance cleanup.
 */
function getSessionOutputFilePaths(): string[] {
  const outputDir = resolveSessionOutputDir();
  const legacyTmpDir = tmpdir();
  return [
    ...listSessionOutputFiles(outputDir),
    ...(legacyTmpDir === outputDir ? [] : listSessionOutputFiles(legacyTmpDir)),
  ];
}

export function resolveSessionIndexPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCLAW_CODE_AGENT_SESSIONS_PATH?.trim();
  if (explicit) return explicit;
  return join(resolveOpenClawStateDir(env), "code-agent-sessions.json");
}

export function saveSessionStoreIndex(
  indexPath: string,
  sessions: PersistedSessionInfo[],
  actionTokens: SessionActionToken[],
  repoPolicies: RepoPolicyRecord[] = [],
): void {
  try {
    const payload: SessionStoreSchema = {
      schemaVersion: STORE_SCHEMA_VERSION,
      sessions,
      actionTokens,
      repoPolicies,
    };
    // Host json-store: private (0600) file, fsync'd temp write, atomic rename.
    saveJsonFile(indexPath, payload);
  } catch (err: unknown) {
    log.warn(`[SessionStore] Failed to save session index: ${errorMessage(err)}`);
  }
}

export function archiveLegacySessionIndex(indexPath: string, reason: string): boolean {
  try {
    if (!existsSync(indexPath)) return false;
    const archivedPath = getAvailableArchivePath(indexPath, "legacy");
    if (!archivedPath) {
      log.warn("[SessionStore] Failed to archive legacy session store: no available archive path");
      return false;
    }
    renameSync(indexPath, archivedPath);
    log.warn(`[SessionStore] Breaking upgrade: archived ${reason} session store to ${archivedPath}. Legacy sessions are not loaded by this release.`);
    return true;
  } catch (err: unknown) {
    log.warn(`[SessionStore] Failed to archive legacy session store: ${errorMessage(err)}`);
    return false;
  }
}

/**
 * Keep a verbatim copy of a store before rows that no longer normalize are
 * dropped, so an upgrade never discards data without a recoverable backup.
 */
export function backupSessionIndex(indexPath: string, rawPayload: string, reason: string): boolean {
  try {
    const backupPath = getAvailableArchivePath(indexPath, "legacy");
    if (!backupPath) {
      log.warn("[SessionStore] Failed to back up session store: no available archive path");
      return false;
    }
    writeFileSync(backupPath, rawPayload, { encoding: "utf-8", mode: 0o600 });
    log.warn(`[SessionStore] Upgrade: ${reason}. Backed up the original session store to ${backupPath}; valid sessions stay loaded.`);
    return true;
  } catch (err: unknown) {
    log.warn(`[SessionStore] Failed to back up session store: ${errorMessage(err)}`);
    return false;
  }
}

export const sessionStoreStorageInternals = {
  archiveLegacySessionIndex,
  backupSessionIndex,
};

export function cleanupSessionOutputFiles(now: number, maxAgeMs: number, referencedPaths: Iterable<string> = []): void {
  try {
    const referenced = new Set(referencedPaths);
    for (const filePath of getSessionOutputFilePaths()) {
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

export function getNextSessionOutputCleanupAt(now: number, maxAgeMs: number, referencedPaths: Iterable<string> = []): number | undefined {
  try {
    const referenced = new Set(referencedPaths);
    let nextCleanupAt: number | undefined;
    for (const filePath of getSessionOutputFilePaths()) {
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
    for (const filePath of getSessionOutputFilePaths()) {
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
    let droppedLegacyCodex = 0;
    const entries: PersistedSessionInfo[] = [];
    let recoveredRunningSession = false;
    let skippedInvalidEntries = 0;
    for (const candidate of sessionsRaw) {
      if (isRecord(candidate) && candidate.harness === "codex") {
        // 5.0.0 dropped the pre-App-Server Codex SDK backend. Rows without an
        // App Server backend ref cannot be resumed, so they are not loaded.
        const backendRef = isRecord(candidate.backendRef) ? candidate.backendRef : undefined;
        if (backendRef?.kind !== "codex-app-server") {
          droppedLegacyCodex += 1;
          continue;
        }
      }
      const entry = normalizePersistedEntry(candidate);
      if (!entry) {
        // Drop only the unreadable row; valid sessions from the same store stay loaded.
        skippedInvalidEntries += 1;
        continue;
      }
      if (isRecord(candidate) && candidate.status === "running") {
        recoveredRunningSession = true;
        logSessionStoreDiagnostic("session.recovered_from_running_persisted_row", {
          sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId : undefined,
          hasHarnessSessionId: typeof candidate.harnessSessionId === "string" && candidate.harnessSessionId.length > 0,
          ...backendRefDiagnosticFields(candidate.backendRef),
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

    if (droppedLegacyCodex > 0) {
      log.warn(`[SessionStore] Dropped ${droppedLegacyCodex} legacy Codex SDK session(s); only Codex App Server sessions are supported.`);
    }

    const tokensRaw = readCollection("actionTokens", "invalid action token collection");
    if (tokensRaw === undefined) return;
    const tokens: SessionActionToken[] = [];
    for (const candidate of tokensRaw) {
      const token = normalizeActionToken(candidate);
      if (!token) {
        skippedInvalidEntries += 1;
        continue;
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
        log.warn("[SessionStore] Skipping invalid repo policy entry while loading session store.");
        continue;
      }
      policies.push(policy);
    }

    if (skippedInvalidEntries > 0) {
      const reason = `dropped ${skippedInvalidEntries} unreadable session or action token entr${skippedInvalidEntries === 1 ? "y" : "ies"}`;
      // Without a backup, fall back to archiving the whole store rather than losing rows.
      if (!sessionStoreStorageInternals.backupSessionIndex(indexPath, raw, reason)) {
        if (!archiveAndReset("unreadable session store entries")) return;
        saveIndex();
        return;
      }
    }

    for (const entry of entries) indexPersistedEntry(entry);
    for (const token of tokens) setActionToken(token);
    for (const policy of policies) setRepoPolicy(policy);

    if (droppedLegacyCodex > 0 || recoveredRunningSession) saveIndex();
    if (skippedInvalidRepoPolicy || skippedInvalidEntries > 0) saveIndex();

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
