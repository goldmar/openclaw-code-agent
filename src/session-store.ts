import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type {
  PersistedSessionInfo,
  SessionStatus,
  SessionActionToken,
} from "./types";
import type { Session } from "./session";
import { getSessionOutputFilePath } from "./session";
import { resolveOpenclawHomeDir } from "./openclaw-paths";
import { canonicalizeSessionRoute } from "./session-route";
import { SessionActionTokenStore } from "./session-action-token-store";
import { getBackendConversationId, resolveHarnessName } from "./session-backend-ref";
import {
  assertNewSchemaEntry,
  normalizeActionToken,
  normalizePersistedEntry,
  STORE_SCHEMA_VERSION,
  type SessionStoreSchema,
} from "./session-store-normalization";

/**
 * Resolve persisted session index path using this precedence chain:
 * 1) `OPENCLAW_CODE_AGENT_SESSIONS_PATH`
 * 2) `OPENCLAW_HOME` + `code-agent-sessions.json`
 * 3) `$HOME/.openclaw/code-agent-sessions.json`
 */
function resolveSessionIndexPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCLAW_CODE_AGENT_SESSIONS_PATH?.trim();
  if (explicit) return explicit;
  return join(resolveOpenclawHomeDir(env), "code-agent-sessions.json");
}

const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);
const TMP_OUTPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface SessionStoreOptions {
  env?: NodeJS.ProcessEnv;
  indexPath?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

/**
 * Durable storage/index for resumable sessions and lightweight output snapshots.
 */
export class SessionStore {
  readonly persisted: Map<string, PersistedSessionInfo> = new Map();
  readonly idIndex: Map<string, string> = new Map();
  readonly nameIndex: Map<string, string> = new Map();
  readonly backendIdIndex: Map<string, string> = new Map();
  readonly actionTokens: Map<string, SessionActionToken>;
  readonly actionTokenStore: SessionActionTokenStore;
  private readonly indexPath: string;

  constructor(options: SessionStoreOptions = {}) {
    const env = options.env ?? process.env;
    this.indexPath = options.indexPath ?? resolveSessionIndexPath(env);
    this.actionTokenStore = new SessionActionTokenStore(() => this.saveIndex(), TMP_OUTPUT_MAX_AGE_MS);
    this.actionTokens = this.actionTokenStore.tokens;

    if (env.OPENCLAW_DEBUG_SESSION_STORE === "1") {
      console.warn(`[SessionStore] index path: ${this.indexPath}`);
    }
    this.loadIndex();
  }

  private loadIndex(): void {
    try {
      const raw = readFileSync(this.indexPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.archiveLegacyIndex("legacy array store");
        this.saveIndex();
        return;
      }
      if (
        !isRecord(parsed) ||
        (parsed.schemaVersion !== STORE_SCHEMA_VERSION && parsed.schemaVersion !== 4)
      ) {
        this.archiveLegacyIndex(`schema mismatch (expected v${STORE_SCHEMA_VERSION})`);
        this.saveIndex();
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
          this.persisted.clear();
          this.idIndex.clear();
          this.nameIndex.clear();
          this.backendIdIndex.clear();
          this.actionTokenStore.clear();
          this.archiveLegacyIndex("invalid v4 session entry");
          this.saveIndex();
          return;
        }

        this.indexPersistedEntry(entry);
      }

      if (archivedLegacyCodex.length > 0) {
        this.archiveLegacyCodexEntries(archivedLegacyCodex);
        this.saveIndex();
      }

      const tokensRaw = Array.isArray(parsed.actionTokens) ? parsed.actionTokens : [];
      for (const candidate of tokensRaw) {
        const token = normalizeActionToken(candidate);
        if (!token) {
          this.persisted.clear();
          this.idIndex.clear();
          this.nameIndex.clear();
          this.backendIdIndex.clear();
          this.actionTokenStore.clear();
          this.archiveLegacyIndex("invalid v4 action token");
          this.saveIndex();
          return;
        }
        this.actionTokens.set(token.id, token);
      }

      this.actionTokenStore.purgeExpiredActionTokens();
    } catch {
      // File doesn't exist yet or is corrupt — start fresh
    }
  }

  saveIndex(): void {
    try {
      mkdirSync(dirname(this.indexPath), { recursive: true });
      const tmp = this.indexPath + ".tmp";
      const payload: SessionStoreSchema = {
        schemaVersion: STORE_SCHEMA_VERSION,
        sessions: [...this.persisted.values()],
        actionTokens: this.actionTokenStore.listForPersistence(),
      };
      writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
      renameSync(tmp, this.indexPath);
    } catch (err: unknown) {
      console.warn(`[SessionStore] Failed to save session index: ${errorMessage(err)}`);
    }
  }

  assertPersistedEntry(entry: PersistedSessionInfo): void {
    assertNewSchemaEntry(entry);
  }

  private indexPersistedEntry(entry: PersistedSessionInfo): void {
    this.persisted.set(entry.harnessSessionId, entry);
    if (entry.sessionId) this.idIndex.set(entry.sessionId, entry.harnessSessionId);
    if (entry.name) this.nameIndex.set(entry.name, entry.harnessSessionId);
    const backendConversationId = getBackendConversationId(entry);
    if (backendConversationId) this.backendIdIndex.set(backendConversationId, entry.harnessSessionId);
  }

  private removePersistedIndexes(entry: PersistedSessionInfo): void {
    this.persisted.delete(entry.harnessSessionId);

    for (const [k, v] of this.idIndex) {
      if (v === entry.harnessSessionId) this.idIndex.delete(k);
    }
    for (const [k, v] of this.nameIndex) {
      if (v === entry.harnessSessionId) this.nameIndex.delete(k);
    }
    for (const [k, v] of this.backendIdIndex) {
      if (v === entry.harnessSessionId) this.backendIdIndex.delete(k);
    }
  }

  private archiveLegacyIndex(reason: string): void {
    try {
      if (!existsSync(this.indexPath)) return;
      const archivedPath = `${this.indexPath}.legacy-${Date.now()}.json`;
      renameSync(this.indexPath, archivedPath);
      console.warn(`[SessionStore] Breaking upgrade: archived ${reason} session store to ${archivedPath}. Legacy sessions are not loaded by this release.`);
    } catch (err: unknown) {
      console.warn(`[SessionStore] Failed to archive legacy session store: ${errorMessage(err)}`);
    }
  }

  private archiveLegacyCodexEntries(entries: unknown[]): void {
    try {
      if (entries.length === 0) return;
      const archivedPath = `${this.indexPath}.codex-sdk-legacy-${Date.now()}.json`;
      writeFileSync(archivedPath, JSON.stringify(entries, null, 2), "utf-8");
      console.warn(`[SessionStore] Breaking Codex transport upgrade: archived ${entries.length} legacy Codex SDK session(s) to ${archivedPath}. They are not loaded by the App Server backend.`);
    } catch (err: unknown) {
      console.warn(`[SessionStore] Failed to archive legacy Codex SDK sessions: ${errorMessage(err)}`);
    }
  }

  /** Persist a running-session stub so crash/restart can recover routing metadata. */
  markRunning(session: Session): void {
    if (!session.harnessSessionId) return;
    const route = canonicalizeSessionRoute({
      route: session.route,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originSessionKey: session.originSessionKey,
    });
    if (!route) return;
    const stub: PersistedSessionInfo = {
      sessionId: session.id,
      harnessSessionId: session.harnessSessionId,
      backendRef: session.backendRef ?? {
        kind: resolveHarnessName(session) === "codex" ? "codex-app-server" : "claude-code",
        conversationId: session.harnessSessionId,
      },
      name: session.name,
      prompt: session.prompt,
      workdir: session.originalWorkdir ?? session.workdir, // E1: Always write originalWorkdir
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      createdAt: session.startedAt,
      status: "running",
      lifecycle: session.lifecycle,
      approvalState: session.approvalState,
      worktreeState: session.worktreeState,
      runtimeState: session.runtimeState,
      deliveryState: session.deliveryState,
      costUsd: 0,
      originAgentId: session.originAgentId,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originSessionKey: session.originSessionKey,
      route,
      harness: session.harnessName,
      currentPermissionMode: session.currentPermissionMode,
      pendingPlanApproval: session.pendingPlanApproval,
      planApprovalContext: session.planApprovalContext,
      planDecisionVersion: session.planDecisionVersion,
      planApproval: session.planApproval,
      codexApprovalPolicy: session.codexApprovalPolicy,
      worktreePath: session.worktreePath,
      worktreeBranch: session.worktreeBranch,
      worktreeStrategy: session.worktreeStrategy,
      worktreeBaseBranch: session.worktreeBaseBranch,
      worktreePrTargetRepo: session.worktreePrTargetRepo,
      resumable: session.isExplicitlyResumable,
    };
    assertNewSchemaEntry(stub);
    this.indexPersistedEntry(stub);
    this.saveIndex();
  }

  /** True when this internal session id was already indexed in persisted storage. */
  hasRecordedSession(sessionId: string): boolean {
    return this.idIndex.has(sessionId);
  }

  /** Persist terminal session metadata and write a best-effort tmp output snapshot. */
  persistTerminal(session: Session): void {
    if (!session.harnessSessionId) return;
    const route = canonicalizeSessionRoute({
      route: session.route,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originSessionKey: session.originSessionKey,
    });
    if (!route) return;

    let outputPath: string | undefined;
    try {
      const outputFile = getSessionOutputFilePath(session.id);
      if (existsSync(outputFile)) {
        // The incremental appendFileSync writes during session execution already
        // produced a complete file. Using it directly preserves output that may
        // have been evicted from the in-memory buffer (capped at 2000 items).
        outputPath = outputFile;
      } else {
        // Fallback: no incremental file exists (e.g. disk error during session),
        // so write the in-memory buffer as a best-effort snapshot.
        const fullOutput = session.getOutput().join("\n");
        if (fullOutput.length > 0) {
          writeFileSync(outputFile, fullOutput, "utf-8");
          outputPath = outputFile;
        }
      }
    } catch (err: unknown) {
      console.warn(`[SessionStore] Failed to write output file for session ${session.id}: ${errorMessage(err)}`);
    }

    const info: PersistedSessionInfo = {
      sessionId: session.id,
      harnessSessionId: session.harnessSessionId,
      backendRef: session.backendRef ?? {
        kind: resolveHarnessName(session) === "codex" ? "codex-app-server" : "claude-code",
        conversationId: session.harnessSessionId,
      },
      name: session.name,
      prompt: session.prompt,
      workdir: session.originalWorkdir ?? session.workdir, // E1: Always write originalWorkdir
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      createdAt: session.startedAt,
      completedAt: session.completedAt,
      status: session.status,
      lifecycle: session.lifecycle,
      approvalState: session.approvalState,
      worktreeState: session.worktreeState,
      runtimeState: session.runtimeState,
      deliveryState: session.deliveryState,
      killReason: session.killReason,
      costUsd: session.costUsd,
      originAgentId: session.originAgentId,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originSessionKey: session.originSessionKey,
      route,
      outputPath,
      harness: session.harnessName,
      currentPermissionMode: session.currentPermissionMode,
      pendingPlanApproval: session.pendingPlanApproval,
      planApprovalContext: session.planApprovalContext,
      planDecisionVersion: session.planDecisionVersion,
      planApproval: session.planApproval,
      codexApprovalPolicy: session.codexApprovalPolicy,
      worktreePath: session.worktreePath,
      worktreeBranch: session.worktreeBranch,
      worktreeStrategy: session.worktreeStrategy,
      worktreeBaseBranch: session.worktreeBaseBranch,
      worktreePrTargetRepo: session.worktreePrTargetRepo,
      resumable: session.isExplicitlyResumable,
    };
    assertNewSchemaEntry(info);

    this.indexPersistedEntry(info);
    this.saveIndex();
  }

  /** Return newest persisted entry for a user-facing name, handling name collisions. */
  getLatestPersistedByName(name: string): PersistedSessionInfo | undefined {
    let winner: PersistedSessionInfo | undefined;
    let winnerCreatedAt = Number.NEGATIVE_INFINITY;
    let winnerCompletedAt = Number.NEGATIVE_INFINITY;
    let winnerOrder = Number.NEGATIVE_INFINITY;
    let order = 0;

    for (const info of this.persisted.values()) {
      if (info.name !== name) {
        order++;
        continue;
      }

      const createdAt = info.createdAt ?? Number.NEGATIVE_INFINITY;
      const completedAt = info.completedAt ?? Number.NEGATIVE_INFINITY;
      const isBetter = createdAt > winnerCreatedAt
        || (createdAt === winnerCreatedAt && completedAt > winnerCompletedAt)
        || (createdAt === winnerCreatedAt && completedAt === winnerCompletedAt && order > winnerOrder);

      if (isBetter) {
        winner = info;
        winnerCreatedAt = createdAt;
        winnerCompletedAt = completedAt;
        winnerOrder = order;
      }

      order++;
    }

    return winner;
  }

  /** Resolve any session reference to a harness session id, if possible. */
  resolveHarnessSessionId(ref: string, activeHarnessSessionId?: string): string | undefined {
    if (activeHarnessSessionId) return activeHarnessSessionId;

    const byId = this.idIndex.get(ref);
    if (byId) {
      const entry = this.persisted.get(byId);
      const backendConversationId = entry ? getBackendConversationId(entry) : undefined;
      return backendConversationId ?? byId;
    }

    const byName = this.getLatestPersistedByName(ref);
    if (byName) return getBackendConversationId(byName) ?? byName.harnessSessionId;

    const byBackendId = this.backendIdIndex.get(ref);
    if (byBackendId) {
      const entry = this.persisted.get(byBackendId);
      const backendConversationId = entry ? getBackendConversationId(entry) : undefined;
      return backendConversationId ?? byBackendId;
    }

    if (this.persisted.has(ref)) {
      const entry = this.persisted.get(ref);
      return entry ? (getBackendConversationId(entry) ?? ref) : ref;
    }

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref;
    return undefined;
  }

  /** Resolve persisted session metadata by harness id, internal id, or name. */
  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    const byId = this.idIndex.get(ref);
    if (byId) return this.persisted.get(byId);
    const byName = this.getLatestPersistedByName(ref);
    if (byName) return byName;
    const byBackendId = this.backendIdIndex.get(ref);
    if (byBackendId) return this.persisted.get(byBackendId);
    return this.persisted.get(ref);
  }

  /** List persisted sessions sorted by completion time (newest first). */
  listPersistedSessions(): PersistedSessionInfo[] {
    return [...this.persisted.values()].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }

  /** Best-effort cleanup for stale tmp output files written by persistTerminal. */
  cleanupTmpOutputFiles(now: number): void {
    this.actionTokenStore.purgeExpiredActionTokens(now);
    try {
      const tmpDir = tmpdir();
      const tmpFiles = readdirSync(tmpDir).filter((f) => f.startsWith("openclaw-agent-") && f.endsWith(".txt"));
      for (const file of tmpFiles) {
        try {
          const filePath = join(tmpDir, file);
          const mtime = statSync(filePath).mtimeMs;
          if (now - mtime > TMP_OUTPUT_MAX_AGE_MS) {
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

  /** Enforce max persisted session retention by evicting oldest records and indexes. */
  evictOldestPersisted(maxPersistedSessions: number): void {
    const all = this.listPersistedSessions();
    if (all.length <= maxPersistedSessions) return;

    const toEvict = all.slice(maxPersistedSessions);
    for (const info of toEvict) {
      this.removePersistedIndexes(info);
    }
    this.saveIndex();
  }

  /** True when a runtime terminal session exceeded the configured in-memory TTL. */
  shouldGcActiveSession(session: Session, now: number, cleanupMaxAgeMs: number): boolean {
    if (!session.completedAt) return false;
    if (!TERMINAL_STATUSES.has(session.status)) return false;
    return now - session.completedAt > cleanupMaxAgeMs;
  }

  getActionToken(tokenId: string): SessionActionToken | undefined {
    return this.actionTokenStore.getActionToken(tokenId);
  }

  consumeActionToken(tokenId: string): SessionActionToken | undefined {
    return this.actionTokenStore.consumeActionToken(tokenId);
  }

  deleteActionTokensForSession(sessionId: string): void {
    this.actionTokenStore.deleteActionTokensForSession(sessionId);
  }

  purgeExpiredActionTokens(now: number = Date.now()): void {
    this.actionTokenStore.purgeExpiredActionTokens(now);
  }
}
