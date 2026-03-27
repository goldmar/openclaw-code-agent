import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type {
  PersistedSessionInfo,
  SessionStatus,
  SessionActionToken,
  SessionActionKind,
} from "./types";
import type { Session } from "./session";
import { getSessionOutputFilePath } from "./session";
import { resolveOpenclawHomeDir } from "./openclaw-paths";
import { canonicalizeSessionRoute } from "./session-route";
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
  readonly actionTokens: Map<string, SessionActionToken> = new Map();
  private readonly indexPath: string;

  constructor(options: SessionStoreOptions = {}) {
    const env = options.env ?? process.env;
    this.indexPath = options.indexPath ?? resolveSessionIndexPath(env);

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
      if (!isRecord(parsed) || parsed.schemaVersion !== STORE_SCHEMA_VERSION) {
        this.archiveLegacyIndex(`schema mismatch (expected v${STORE_SCHEMA_VERSION})`);
        this.saveIndex();
        return;
      }

      const sessionsRaw = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      for (const candidate of sessionsRaw) {
        const entry = normalizePersistedEntry(candidate);
        if (!entry) {
          this.persisted.clear();
          this.idIndex.clear();
          this.nameIndex.clear();
          this.actionTokens.clear();
          this.archiveLegacyIndex("invalid v4 session entry");
          this.saveIndex();
          return;
        }

        this.persisted.set(entry.harnessSessionId, entry);
        if (entry.sessionId) this.idIndex.set(entry.sessionId, entry.harnessSessionId);
        if (entry.name) this.nameIndex.set(entry.name, entry.harnessSessionId);
      }

      const tokensRaw = Array.isArray(parsed.actionTokens) ? parsed.actionTokens : [];
      for (const candidate of tokensRaw) {
        const token = normalizeActionToken(candidate);
        if (!token) {
          this.persisted.clear();
          this.idIndex.clear();
          this.nameIndex.clear();
          this.actionTokens.clear();
          this.archiveLegacyIndex("invalid v4 action token");
          this.saveIndex();
          return;
        }
        this.actionTokens.set(token.id, token);
      }

      this.purgeExpiredActionTokens();
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
        actionTokens: [...this.actionTokens.values()],
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
    this.persisted.set(stub.harnessSessionId, stub);
    this.idIndex.set(session.id, stub.harnessSessionId);
    this.nameIndex.set(session.name, stub.harnessSessionId);
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

    this.persisted.set(session.harnessSessionId, info);
    this.idIndex.set(session.id, session.harnessSessionId);
    this.nameIndex.set(session.name, session.harnessSessionId);
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
    if (byId && this.persisted.has(byId)) return byId;

    const byName = this.getLatestPersistedByName(ref);
    if (byName) return byName.harnessSessionId;

    if (this.persisted.has(ref)) return ref;

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref;
    return undefined;
  }

  /** Resolve persisted session metadata by harness id, internal id, or name. */
  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    const direct = this.persisted.get(ref);
    if (direct) return direct;
    const byId = this.idIndex.get(ref);
    if (byId) return this.persisted.get(byId);
    return this.getLatestPersistedByName(ref);
  }

  /** List persisted sessions sorted by completion time (newest first). */
  listPersistedSessions(): PersistedSessionInfo[] {
    return [...this.persisted.values()].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }

  /** Best-effort cleanup for stale tmp output files written by persistTerminal. */
  cleanupTmpOutputFiles(now: number): void {
    this.purgeExpiredActionTokens(now);
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
      this.persisted.delete(info.harnessSessionId);

      for (const [k, v] of this.idIndex) {
        if (v === info.harnessSessionId) this.idIndex.delete(k);
      }
      for (const [k, v] of this.nameIndex) {
        if (v === info.harnessSessionId) this.nameIndex.delete(k);
      }
    }
    this.saveIndex();
  }

  /** True when a runtime terminal session exceeded the configured in-memory TTL. */
  shouldGcActiveSession(session: Session, now: number, cleanupMaxAgeMs: number): boolean {
    if (!session.completedAt) return false;
    if (!TERMINAL_STATUSES.has(session.status)) return false;
    return now - session.completedAt > cleanupMaxAgeMs;
  }

  createActionToken(
    sessionId: string,
    kind: SessionActionKind,
    options: Partial<Omit<SessionActionToken, "id" | "sessionId" | "kind" | "createdAt">> = {},
  ): SessionActionToken {
    const token: SessionActionToken = {
      id: randomUUID(),
      sessionId,
      kind,
      createdAt: Date.now(),
      ...options,
    };
    this.actionTokens.set(token.id, token);
    this.saveIndex();
    return token;
  }

  getActionToken(tokenId: string): SessionActionToken | undefined {
    const token = this.actionTokens.get(tokenId);
    if (!token) return undefined;
    if (token.expiresAt != null && token.expiresAt <= Date.now()) {
      this.actionTokens.delete(tokenId);
      this.saveIndex();
      return undefined;
    }
    return token;
  }

  consumeActionToken(tokenId: string): SessionActionToken | undefined {
    const token = this.getActionToken(tokenId);
    if (!token || token.consumedAt != null) return undefined;
    token.consumedAt = Date.now();
    this.saveIndex();
    return token;
  }

  deleteActionTokensForSession(sessionId: string): void {
    let changed = false;
    for (const [tokenId, token] of this.actionTokens) {
      if (token.sessionId === sessionId) {
        this.actionTokens.delete(tokenId);
        changed = true;
      }
    }
    if (changed) this.saveIndex();
  }

  purgeExpiredActionTokens(now: number = Date.now()): void {
    let changed = false;
    for (const [tokenId, token] of this.actionTokens) {
      const expired = token.expiresAt != null && token.expiresAt <= now;
      const consumedTooOld = token.consumedAt != null && now - token.consumedAt > TMP_OUTPUT_MAX_AGE_MS;
      if (expired || consumedTooOld) {
        this.actionTokens.delete(tokenId);
        changed = true;
      }
    }
    if (changed) this.saveIndex();
  }
}
