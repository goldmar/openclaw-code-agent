import { existsSync, readFileSync } from "fs";
import type { SessionManager } from "../session-manager";
import type { Session } from "../session";
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
  harnessSessionId?: string;
  originChannel?: string;
  originThreadId?: string | number;
}

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

/** Build a header line for active runtime sessions. */
function outputHeaderForActiveSession(session: ActiveSessionView): string {
  const duration = formatDuration(session.duration);
  const costStr = ` | Cost: $${session.costUsd.toFixed(4)}`;
  const phaseStr = session.status === "running" ? ` | Phase: ${session.phase}` : "";
  return [
    `Session: ${session.name} [${session.id}] | Status: ${session.status.toUpperCase()}${phaseStr}${costStr} | Duration: ${duration}`,
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
        const fileContent = readFileSync(persisted.outputPath, "utf-8");
        let output = fileContent;
        if (!options.full && fileContent) {
          const lines = fileContent.split("\n");
          output = lines.slice(-linesToShow).join("\n");
        }
        const header = outputHeaderForPersistedSession(persisted);
        return output ? `${header}\n${output}` : `${header}\n(output file was empty)`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error: Session "${ref}" was cleaned up (expired) and output file could not be read: ${message}`;
      }
    }
    return `Error: Session "${ref}" not found.`;
  }

  const outputLines = options.full ? session.getOutput() : session.getOutput(linesToShow);
  const header = outputHeaderForActiveSession(session);
  if (outputLines.length === 0) {
    return `${header}${emptyOutputDiagnostics(session)}`;
  }
  return `${header}\n${outputLines.join("\n")}`;
}

/**
 * Return a merged listing of active and persisted sessions.
 * Active sessions override persisted rows with the same internal session ID.
 */
export function getSessionsListingText(
  sm: SessionManager,
  filter: "all" | "running" | "completed" | "failed" | "killed" = "all",
  originChannel?: string,
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
      phase: p.status,
      harnessSessionId: p.harnessSessionId,
      originChannel: p.originChannel,
      originThreadId: p.originThreadId,
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
      workdir: session.workdir,
      costUsd: session.costUsd,
      multiTurn: session.multiTurn,
      phase: session.phase,
      harnessSessionId: session.harnessSessionId,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
    });
  }

  return [...merged.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
