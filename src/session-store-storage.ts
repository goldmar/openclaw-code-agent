import { randomBytes } from "crypto";
import { closeSync, existsSync, linkSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
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
import { assertTestSafeStatePath } from "./test-state-guard";

const log = createLogger("session-store-storage");

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logSessionStoreDiagnostic(event: string, fields: Record<string, unknown>): void {
  // Routine lifecycle diagnostics log at info; failure events stay at warn.
  const level = /(?:error|fail)/i.test(event) ? "warn" : "info";
  log[level](JSON.stringify({
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

/** Returns true when the index was written. */
export function saveSessionStoreIndex(
  indexPath: string,
  sessions: unknown[],
  actionTokens: SessionActionToken[],
  repoPolicies: RepoPolicyRecord[] = [],
  revision?: number,
): boolean {
  assertTestSafeStatePath(indexPath, "write the session store");
  try {
    const payload: SessionStoreSchema = {
      schemaVersion: STORE_SCHEMA_VERSION,
      ...(revision != null ? { revision } : {}),
      sessions: sessions as PersistedSessionInfo[],
      actionTokens,
      repoPolicies,
    };
    // Host json-store: private (0600) file, fsync'd temp write, atomic rename.
    sessionStoreStorageInternals.saveJsonFile(indexPath, payload);
    return true;
  } catch (err: unknown) {
    log.warn(`[SessionStore] Failed to save session index: ${errorMessage(err)}`);
    return false;
  }
}

/**
 * Identity of the index file on disk. Atomic renames change the inode, so any
 * write by another writer changes the signature; "missing" when absent.
 */
export function statSessionStoreIndex(indexPath: string): string {
  try {
    const stats = statSync(indexPath);
    return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/** Raw rows of the current on-disk index, for merging; undefined when unreadable or incompatible. */
export type SessionStoreDiskSnapshot = {
  revision: number;
  sessions: unknown[];
  actionTokens: unknown[];
  repoPolicies: unknown[];
};

/**
 * A schema version newer than this build writes. Such an index belongs to a
 * newer build (for example during an upgrade overlap or after a downgrade):
 * this build never archives, backs up, or overwrites it.
 */
export function newerSchemaVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > STORE_SCHEMA_VERSION ? value : undefined;
}

/** Schema versions whose rows the normalizers read (the same set startup loading accepts). */
const READABLE_SCHEMA_VERSIONS = new Set<unknown>([STORE_SCHEMA_VERSION, 6, 4]);

/**
 * Read the current on-disk index for merging. `unreadable` carries the raw text
 * of a file that exists but cannot be merged (corrupt, or an unknown schema), so
 * the caller can back it up before replacing it.
 */
export function readSessionStoreSnapshot(
  indexPath: string,
): SessionStoreDiskSnapshot | { unreadable: string } | { newerSchema: number } | undefined {
  let raw: string;
  try {
    raw = readFileSync(indexPath, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const newer = isRecord(parsed) ? newerSchemaVersion(parsed.schemaVersion) : undefined;
    if (newer !== undefined) return { newerSchema: newer };
    if (!isRecord(parsed) || !READABLE_SCHEMA_VERSIONS.has(parsed.schemaVersion)) return { unreadable: raw };
    const list = (value: unknown): unknown[] | undefined => value === undefined ? [] : Array.isArray(value) ? value : undefined;
    const sessions = list(parsed.sessions);
    const actionTokens = list(parsed.actionTokens);
    const repoPolicies = list(parsed.repoPolicies);
    if (!sessions || !actionTokens || !repoPolicies) return { unreadable: raw };
    return {
      revision: typeof parsed.revision === "number" && Number.isFinite(parsed.revision) ? parsed.revision : 0,
      sessions,
      actionTokens,
      repoPolicies,
    };
  } catch {
    return { unreadable: raw };
  }
}

/** Keep a verbatim copy of an index another writer left in a form this build cannot merge. */
export function backupUnmergeableSessionIndex(indexPath: string, raw: string): boolean {
  return sessionStoreStorageInternals.backupSessionIndex(indexPath, raw, "another writer left a session store this build cannot merge");
}

/** `<pid>/<instance>` marker for running rows written by this process. */
export function runtimeOwnerMarker(instanceId: string): string {
  return `${process.pid}/${instanceId}`;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True for a `running` row owned by another, still-alive process. Such a row is
 * never normalized, adopted, or overwritten by this process. Rows from this
 * process (an earlier runtime that already stopped) or from a dead process are
 * recovered normally.
 */
export function isForeignLiveRunningRow(raw: unknown): boolean {
  if (!isRecord(raw) || raw.status !== "running" || typeof raw.runtimeOwner !== "string") return false;
  const pid = Number.parseInt(raw.runtimeOwner.split("/")[0] ?? "", 10);
  return pid !== process.pid && isProcessAlive(pid);
}

/** A lock older than this is stale: a holder keeps it only for one synchronous read-merge-write. */
export const SESSION_STORE_LOCK_STALE_MS = 10_000;

function readLockFile(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, "utf-8");
  } catch {
    return undefined;
  }
}

function lockHolderIsGone(content: string): boolean {
  const [pidText, atText] = content.split(" ");
  const pid = Number.parseInt(pidText ?? "", 10);
  const at = Number.parseInt(atText ?? "", 10);
  if (!Number.isFinite(at) || Date.now() - at > SESSION_STORE_LOCK_STALE_MS) return true;
  return pid !== process.pid && !isProcessAlive(pid);
}

/**
 * Remove the lock file only if it still holds `expected`. The lock is first
 * renamed to a private name (atomic, so only one breaker wins), then checked:
 * when another writer replaced the stale lock in between, its fresh lock is
 * put back instead of being deleted. Returns true when the stale lock is gone.
 */
function breakLockIfUnchanged(lockPath: string, expected: string): boolean {
  const claimed = `${lockPath}.break-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(lockPath, claimed);
  } catch (err) {
    // Already gone (another writer broke or released it): the path is free.
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  const content = readLockFile(claimed);
  if (content === expected) {
    try { unlinkSync(claimed); } catch { /* best-effort */ }
    return true;
  }
  // We took a lock that is not the stale one we inspected: restore it (a link
  // fails if yet another writer already created a new lock) and back off.
  try { linkSync(claimed, lockPath); } catch { /* the path is taken again */ }
  try { unlinkSync(claimed); } catch { /* best-effort */ }
  return false;
}

/**
 * Result of a non-blocking attempt at the `<index>.lock` file:
 * `release` when held, `"busy"` when another live writer holds it, and
 * `"unavailable"` when no lock file can be created (the save then reports the
 * underlying problem itself).
 */
export type SessionStoreLockAttempt = { release: () => void } | "busy" | "unavailable";

/**
 * Try once, without waiting, to take the exclusive lock that makes the
 * read-merge-write of a save one step across processes. A lock whose holder
 * died, or that is older than `SESSION_STORE_LOCK_STALE_MS`, is broken
 * atomically (see `breakLockIfUnchanged`). `force` also breaks a live lock
 * (only used for the final write at shutdown). Release removes the lock only
 * while it still carries this holder's token.
 */
export function tryAcquireSessionStoreLock(indexPath: string, options: { force?: boolean } = {}): SessionStoreLockAttempt {
  assertTestSafeStatePath(indexPath, "lock the session store");
  const lockPath = `${indexPath}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = `${process.pid} ${Date.now()} ${randomBytes(8).toString("hex")}`;
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return {
        release: () => {
          if (readLockFile(lockPath) !== token) return;
          try { unlinkSync(lockPath); } catch { /* best-effort */ }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return "unavailable";
      const content = readLockFile(lockPath);
      if (content === undefined) continue;
      if (!options.force && !lockHolderIsGone(content)) return "busy";
      if (!breakLockIfUnchanged(lockPath, content)) return "busy";
    }
  }
  return "busy";
}

export function archiveLegacySessionIndex(indexPath: string, reason: string): boolean {
  assertTestSafeStatePath(indexPath, "archive the session store");
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
function backupSessionIndex(indexPath: string, rawPayload: string, reason: string): boolean {
  assertTestSafeStatePath(indexPath, "back up the session store");
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
  /** The atomic index write (fault-injection and snapshot tests wrap it). */
  saveJsonFile,
};

export function cleanupSessionOutputFiles(now: number, maxAgeMs: number, referencedPaths: Iterable<string> = []): void {
  assertTestSafeStatePath(resolveSessionOutputDir(), "clean up output files in");
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

/**
 * Delete unreferenced output files in the plugin's own output directory that
 * are older than `minAgeMs`. The legacy OS temp directory is shared with other
 * processes (older builds, other installs), so it is only ever aged out by
 * `cleanupSessionOutputFiles`, never swept here.
 */
export function cleanupOrphanOutputFiles(
  referencedPaths: Iterable<string>,
  options: { now?: number; minAgeMs?: number } = {},
): void {
  const outputDir = resolveSessionOutputDir();
  assertTestSafeStatePath(outputDir, "clean up output files in");
  const now = options.now ?? Date.now();
  const minAgeMs = options.minAgeMs ?? 0;
  try {
    const referenced = new Set(referencedPaths);
    for (const filePath of listSessionOutputFiles(outputDir)) {
      if (referenced.has(filePath)) continue;
      try {
        if (now - statSync(filePath).mtimeMs < minAgeMs) continue;
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
  setRevision?: (revision: number) => void;
  /** Keep a row another live process runs, verbatim and unindexed. */
  carrySession?: (raw: unknown) => void;
  /** The index was written by a newer build: load nothing and never write it. */
  onNewerSchema?: (schemaVersion: number) => void;
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
    setRevision,
    carrySession,
    onNewerSchema,
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
    const newer = isRecord(parsed) ? newerSchemaVersion(parsed.schemaVersion) : undefined;
    if (newer !== undefined) {
      onNewerSchema?.(newer);
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

    if (typeof parsed.revision === "number" && Number.isFinite(parsed.revision)) setRevision?.(parsed.revision);

    const sessionsRaw = readCollection("sessions", "invalid sessions collection");
    if (sessionsRaw === undefined) return;
    let droppedLegacyCodex = 0;
    const entries: PersistedSessionInfo[] = [];
    let recoveredRunningSession = false;
    let skippedInvalidEntries = 0;
    const carried: unknown[] = [];
    for (const candidate of sessionsRaw) {
      if (carrySession && isForeignLiveRunningRow(candidate)) {
        // Another live process runs this session: never recover it as ours.
        carried.push(candidate);
        continue;
      }
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
    for (const raw of carried) carrySession?.(raw);
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
