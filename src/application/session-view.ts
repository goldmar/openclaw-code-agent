import { existsSync, readFileSync } from "fs";
import type { SessionManager } from "../session-manager";
import type { Session } from "../session";
import { getSessionOutputFilePath } from "../session";
import { formatDuration, formatSessionListing } from "../format";
import type { PersistedSessionInfo, SessionStatus } from "../types";

const DEFAULT_OUTPUT_LINES = 50;
const MIN_OUTPUT_LINES = 1;
const VALID_SESSION_STATUSES = new Set<SessionStatus>(["starting", "running", "completed", "failed", "killed"]);

/** Session output rendering options for `agent_output` and `/agent_output`. */
export interface OutputOptions {
  full?: boolean;
  lines?: number;
}

interface SessionResultSummary {
  result?: string;
  subtype: string;
}

interface ActiveSessionView {
  id: string;
  name: string;
  status: SessionStatus;
  phase: string;
  lifecycle?: string;
  duration: number;
  costUsd: number;
  error?: string;
  result?: SessionResultSummary;
}

interface SessionListingItem {
  id: string;
  name: string;
  status: SessionStatus;
  startedAt: number;
  completedAt?: number;
  duration: number;
  prompt: string;
  workdir: string;
  costUsd: number;
  multiTurn: boolean;
  phase: string;
  lifecycle?: string;
  resumable?: boolean;
  harness?: string;
  backendRef?: PersistedSessionInfo["backendRef"];
  harnessSessionId?: string;
  originChannel?: string;
  originThreadId?: string | number;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeStrategy?: string;
  originalWorkdir?: string;
  worktreeMerged?: boolean;
  worktreeMergedAt?: string;
  worktreePrUrl?: string;
}

export interface SessionListingOptions {
  full?: boolean;
}

const DEFAULT_SESSION_LIST_LIMIT = 5;
const FULL_SESSION_LIST_WINDOW_MS = 24 * 60 * 60 * 1000;

function normalizeLines(lines?: number): number {
  const parsed = Number(lines);
  if (!Number.isFinite(parsed) || parsed < MIN_OUTPUT_LINES) {
    return DEFAULT_OUTPUT_LINES;
  }
  return Math.floor(parsed);
}

function isSessionStatus(status: unknown): status is SessionStatus {
  return typeof status === "string" && VALID_SESSION_STATUSES.has(status as SessionStatus);
}

function splitOutputLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function readOutputLinesFromFile(path: string, options: OutputOptions, linesToShow: number): string[] {
  const fileContent = readFileSync(path, "utf-8");
  const lines = splitOutputLines(fileContent);
  return options.full ? lines : lines.slice(-linesToShow);
}

function readLiveOutputLines(session: ActiveSessionView, options: OutputOptions, linesToShow: number): string[] | null {
  if (session.status !== "starting" && session.status !== "running") return null;

  const outputPath = getSessionOutputFilePath(session.id);
  if (!existsSync(outputPath)) return null;

  try {
    return readOutputLinesFromFile(outputPath, options, linesToShow);
  } catch {
    return null;
  }
}

/** Build a header line for active runtime sessions. */
function outputHeaderForActiveSession(session: ActiveSessionView): string {
  const duration = formatDuration(session.duration);
  const costStr = ` | Cost: $${session.costUsd.toFixed(4)}`;
  const phaseStr = session.phase ? ` | Phase: ${session.phase}` : "";
  const lifecycleStr = session.lifecycle && session.lifecycle !== session.phase ? ` | Lifecycle: ${session.lifecycle}` : "";
  return [
    `Session: ${session.name} [${session.id}] | Status: ${session.status.toUpperCase()}${phaseStr}${lifecycleStr}${costStr} | Duration: ${duration}`,
    `${"─".repeat(60)}`,
  ].join("\n");
}

/** Build a header line for persisted sessions loaded from disk/tmp output. */
function outputHeaderForPersistedSession(persisted: PersistedSessionInfo): string {
  return [
    `Session: ${persisted.name || persisted.harnessSessionId} | Status: ${persisted.status.toUpperCase()} | Cost: $${persisted.costUsd.toFixed(4)}`,
    `(retrieved from ${persisted.outputPath} — evicted from runtime cache — showing persisted output)`,
    `${"─".repeat(60)}`,
  ].join("\n");
}

/** Render diagnostics when a session has no output buffer yet. */
function emptyOutputDiagnostics(session: ActiveSessionView): string {
  const diagnostics: string[] = [];
  if (session.error) diagnostics.push(`Error: ${session.error}`);
  if (session.result?.result) diagnostics.push(`Result: ${session.result.result}`);
  if (session.result) diagnostics.push(`Result status: ${session.result.subtype}`);
  return diagnostics.length > 0
    ? `\n(no output yet)\n${diagnostics.join("\n")}`
    : `\n(no output yet)`;
}

/**
 * Return formatted output for a runtime or persisted session.
 * Falls back to persisted tmp output for sessions evicted by GC.
 */
export function getSessionOutputText(
  sm: SessionManager,
  ref: string,
  options: OutputOptions = {},
): string {
  const linesToShow = normalizeLines(options.lines);
  const session = sm.resolve(ref);
  if (!session) {
    const persisted = sm.getPersistedSession(ref);
    if (persisted?.outputPath && existsSync(persisted.outputPath)) {
      try {
        const output = readOutputLinesFromFile(persisted.outputPath, options, linesToShow).join("\n");
        const header = outputHeaderForPersistedSession(persisted);
        return output ? `${header}\n${output}` : `${header}\n(output file was empty)`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error: Session "${ref}" was cleaned up (expired) and output file could not be read: ${message}`;
      }
    }
    return `Error: Session "${ref}" not found.`;
  }

  const liveOutputLines = readLiveOutputLines(session, options, linesToShow);
  const outputLines = liveOutputLines && liveOutputLines.length > 0
    ? liveOutputLines
    : (options.full ? session.getOutput() : session.getOutput(linesToShow));
  const header = outputHeaderForActiveSession(session);
  const body = outputLines.length === 0
    ? `${header}${emptyOutputDiagnostics(session)}`
    : `${header}\n${outputLines.join("\n")}`;

  // When awaiting plan approval, append the plan file contents so the
  // orchestrator can read the full plan without having to know the file path.
  if (session.pendingPlanApproval && session.planFilePath) {
    try {
      if (existsSync(session.planFilePath)) {
        const planContent = readFileSync(session.planFilePath, "utf-8");
        const divider = "─".repeat(60);
        return `${body}\n${divider}\nPlan file: ${session.planFilePath}\n${divider}\n${planContent}`;
      }
    } catch {
      // best-effort: if the file can't be read, return normal output
    }
  }
  return body;
}

/**
 * Return a merged listing of active and persisted sessions.
 * Active sessions override persisted rows with the same internal session ID.
 */
export function getSessionsListingText(
  sm: SessionManager,
  filter: "all" | "running" | "completed" | "failed" | "killed" = "all",
  originChannel?: string,
  options: SessionListingOptions = {},
): string {
  const persisted = sm.listPersistedSessions() ?? [];
  const merged = mergeActiveAndPersistedSessions(sm.list("all"), persisted);
  let sessions = merged;
  if (filter !== "all") {
    sessions = sessions.filter((s) => s.status === filter);
  }
  if (originChannel) {
    sessions = sessions.filter((s) => s.originChannel === originChannel);
  }
  if (options.full) {
    const cutoff = Date.now() - FULL_SESSION_LIST_WINDOW_MS;
    sessions = sessions.filter((s) => (s.startedAt ?? 0) >= cutoff);
  } else {
    sessions = sessions.slice(0, DEFAULT_SESSION_LIST_LIMIT);
  }
  if (sessions.length === 0) return "No sessions found.";
  return sessions.map((s) => formatSessionListing(s)).join("\n\n");
}

/**
 * Merge active runtime sessions with persisted sessions.
 *
 * Why merge: active map is current runtime state; persisted map survives restart
 * and GC so historical/resumable sessions remain visible.
 *
 * Why dedup by ID (not name): names are user-facing and can collide; internal
 * session IDs uniquely identify one lifecycle record.
 */
function mergeActiveAndPersistedSessions(active: Session[], persisted: PersistedSessionInfo[]): SessionListingItem[] {
  const merged = new Map<string, SessionListingItem>();

  for (const p of persisted) {
    if (!isSessionStatus(p.status)) {
      continue;
    }
    const end = p.completedAt ?? Date.now();
    const start = p.createdAt ?? end;
    const key = p.sessionId ?? `persisted:${p.harnessSessionId}`;
    merged.set(key, {
      id: p.sessionId ?? p.harnessSessionId,
      name: p.name || p.harnessSessionId,
      status: p.status,
      startedAt: p.createdAt ?? 0,
      completedAt: p.completedAt,
      duration: Math.max(0, end - start),
      prompt: p.prompt ?? "",
      workdir: p.workdir ?? "(unknown)",
      costUsd: p.costUsd ?? 0,
      multiTurn: true, // Persisted sessions are always resumable multi-turn records.
      phase: p.lifecycle ?? p.status,
      lifecycle: p.lifecycle,
      resumable: p.resumable,
      harness: p.harness,
      backendRef: p.backendRef,
      harnessSessionId: p.harnessSessionId,
      originChannel: p.originChannel,
      originThreadId: p.originThreadId,
      worktreePath: p.worktreePath,
      worktreeBranch: p.worktreeBranch,
      worktreeStrategy: p.worktreeStrategy,
      worktreeMerged: p.worktreeMerged,
      worktreeMergedAt: p.worktreeMergedAt,
      worktreePrUrl: p.worktreePrUrl,
    });
  }

  for (const session of active) {
    merged.set(session.id, {
      id: session.id,
      name: session.name,
      status: session.status,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      duration: session.duration,
      prompt: session.prompt,
      workdir: session.originalWorkdir ?? session.workdir,
      costUsd: session.costUsd,
      multiTurn: session.multiTurn,
      phase: session.phase,
      lifecycle: session.lifecycle,
      resumable: session.isExplicitlyResumable,
      harness: session.harnessName,
      backendRef: session.backendRef,
      harnessSessionId: session.harnessSessionId,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      worktreePath: session.worktreePath,
      worktreeBranch: session.worktreeBranch,
      worktreeStrategy: session.worktreeStrategy,
      worktreeMerged: undefined, // Active sessions don't have merge status yet
      worktreeMergedAt: undefined,
      worktreePrUrl: undefined,
    });
  }

  return [...merged.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
