import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { PersistedSessionInfo, SessionStatus } from "./types";
import type { Session } from "./session";

const SESSION_INDEX_PATH = join(homedir(), ".openclaw", "code-agent-sessions.json");
const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);
const VALID_STATUSES = new Set<SessionStatus>(["running", "completed", "failed", "killed"]);
const TMP_OUTPUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function toNonEmptyString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeStatus(value: unknown): SessionStatus | undefined {
  if (typeof value !== "string") return undefined;
  if (!VALID_STATUSES.has(value as SessionStatus)) return undefined;
  return value === "running" ? "killed" : (value as SessionStatus);
}

function normalizePersistedEntry(raw: unknown): PersistedSessionInfo | undefined {
  if (!isRecord(raw)) return undefined;

  // Guard against ghost/corrupt rows from legacy or partially-written indexes.
  // We only keep entries with a stable harness ID + valid terminal status.
  const harnessSessionId = toNonEmptyString(raw.harnessSessionId);
  if (!harnessSessionId) return undefined;

  const status = normalizeStatus(raw.status);
  if (!status) return undefined;

  return {
    sessionId: toOptionalString(raw.sessionId),
    harnessSessionId,
    name: toNonEmptyString(raw.name, harnessSessionId),
    prompt: toNonEmptyString(raw.prompt),
    workdir: toNonEmptyString(raw.workdir, "(unknown)"),
    model: toOptionalString(raw.model),
    createdAt: toOptionalNumber(raw.createdAt),
    completedAt: toOptionalNumber(raw.completedAt),
    status,
    costUsd: typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd) ? raw.costUsd : 0,
    originAgentId: toOptionalString(raw.originAgentId),
    originChannel: toOptionalString(raw.originChannel),
    originThreadId: (typeof raw.originThreadId === "string" || typeof raw.originThreadId === "number")
      ? raw.originThreadId
      : undefined,
    originSessionKey: toOptionalString(raw.originSessionKey),
    outputPath: toOptionalString(raw.outputPath),
    harness: toOptionalString(raw.harness),
  };
}

export class SessionStore {
  readonly persisted: Map<string, PersistedSessionInfo> = new Map();
  readonly idIndex: Map<string, string> = new Map();
  readonly nameIndex: Map<string, string> = new Map();

  constructor() {
    this.loadIndex();
  }

  private loadIndex(): void {
    try {
      const raw = readFileSync(SESSION_INDEX_PATH, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;

      let hadInvalid = false;
      for (const candidate of parsed) {
        const entry = normalizePersistedEntry(candidate);
        if (!entry) {
          hadInvalid = true;
          continue;
        }

        this.persisted.set(entry.harnessSessionId, entry);
        if (entry.sessionId) this.idIndex.set(entry.sessionId, entry.harnessSessionId);
        if (entry.name) this.nameIndex.set(entry.name, entry.harnessSessionId);
      }

      if (hadInvalid) {
        this.saveIndex();
      }
    } catch {
      // File doesn't exist yet or is corrupt — start fresh
    }
  }

  private saveIndex(): void {
    try {
      mkdirSync(join(homedir(), ".openclaw"), { recursive: true });
      const tmp = SESSION_INDEX_PATH + ".tmp";
      writeFileSync(tmp, JSON.stringify([...this.persisted.values()], null, 2), "utf-8");
      renameSync(tmp, SESSION_INDEX_PATH);
    } catch (err: unknown) {
      console.warn(`[SessionStore] Failed to save session index: ${errorMessage(err)}`);
    }
  }

  markRunning(session: Session): void {
    if (!session.harnessSessionId) return;
    const stub: PersistedSessionInfo = {
      sessionId: session.id,
      harnessSessionId: session.harnessSessionId,
      name: session.name,
      prompt: session.prompt,
      workdir: session.workdir,
      model: session.model,
      createdAt: session.startedAt,
      status: "running",
      costUsd: 0,
      originAgentId: session.originAgentId,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originSessionKey: session.originSessionKey,
      harness: session.harnessName,
    };
    this.persisted.set(stub.harnessSessionId, stub);
    this.idIndex.set(session.id, stub.harnessSessionId);
    this.nameIndex.set(session.name, stub.harnessSessionId);
    this.saveIndex();
  }

  hasRecordedSession(sessionId: string): boolean {
    return this.idIndex.has(sessionId);
  }

  persistTerminal(session: Session): void {
    if (!session.harnessSessionId) return;

    let outputPath: string | undefined;
    try {
      const outputFile = join(tmpdir(), `openclaw-agent-${session.id}.txt`);
      const fullOutput = session.getOutput().join("\n");
      if (fullOutput.length > 0) {
        writeFileSync(outputFile, fullOutput, "utf-8");
        outputPath = outputFile;
      }
    } catch (err: unknown) {
      console.warn(`[SessionStore] Failed to write output file for session ${session.id}: ${errorMessage(err)}`);
    }

    const info: PersistedSessionInfo = {
      sessionId: session.id,
      harnessSessionId: session.harnessSessionId,
      name: session.name,
      prompt: session.prompt,
      workdir: session.workdir,
      model: session.model,
      createdAt: session.startedAt,
      completedAt: session.completedAt,
      status: session.status,
      costUsd: session.costUsd,
      originAgentId: session.originAgentId,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originSessionKey: session.originSessionKey,
      outputPath,
      harness: session.harnessName,
    };

    this.persisted.set(session.harnessSessionId, info);
    this.idIndex.set(session.id, session.harnessSessionId);
    this.nameIndex.set(session.name, session.harnessSessionId);
    this.saveIndex();
  }

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

  getPersistedSession(ref: string): PersistedSessionInfo | undefined {
    const direct = this.persisted.get(ref);
    if (direct) return direct;
    const byId = this.idIndex.get(ref);
    if (byId) return this.persisted.get(byId);
    return this.getLatestPersistedByName(ref);
  }

  listPersistedSessions(): PersistedSessionInfo[] {
    return [...this.persisted.values()].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }

  cleanupTmpOutputFiles(now: number): void {
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

  shouldGcActiveSession(session: Session, now: number, cleanupMaxAgeMs: number): boolean {
    if (!session.completedAt) return false;
    if (!TERMINAL_STATUSES.has(session.status)) return false;
    return now - session.completedAt > cleanupMaxAgeMs;
  }
}
