import { existsSync, readFileSync } from "fs";
import type { SessionManager } from "../session-manager";
import type { Session } from "../session";
import { getSessionOutputFilePath } from "../session";
import { formatDuration, formatSessionListing } from "../format";
import type { HarnessUsage } from "../harness";
import type {
  ApprovalExecutionState,
  PermissionMode,
  PlanApprovalMode,
  PersistedSessionInfo,
  PersistedWorktreeLifecycle,
  SessionRuntimeRecoveryDiagnostics,
  SessionStatus,
  SessionWorktreeState,
} from "../types";

const DEFAULT_OUTPUT_LINES = 50;
const MIN_OUTPUT_LINES = 1;
const VALID_SESSION_STATUSES = new Set<SessionStatus>(["starting", "running", "completed", "failed", "killed"]);

/** Session output rendering options for `agent_output` and `/agent_output`. */
export interface OutputOptions {
  full?: boolean;
  lines?: number;
  /**
   * The orchestrator session calling agent_output. When it is the session's
   * origin session, record that the launching orchestrator read the outcome.
   */
  readerSessionKey?: string;
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
  usage?: HarnessUsage;
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
  model?: string;
  reasoningEffort?: PersistedSessionInfo["reasoningEffort"];
  backendRef?: PersistedSessionInfo["backendRef"];
  harnessSessionId?: string;
  requestedPermissionMode?: PermissionMode;
  currentPermissionMode?: PermissionMode;
  approvalExecutionState?: ApprovalExecutionState;
  originChannel?: string;
  originThreadId?: string | number;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeStrategy?: string;
  worktreeState?: SessionWorktreeState;
  worktreeLifecycle?: PersistedWorktreeLifecycle;
  originalWorkdir?: string;
  worktreeMerged?: boolean;
  worktreeMergedAt?: string;
  worktreePrUrl?: string;
  recovered?: boolean;
  runtimeRecovery?: SessionRuntimeRecoveryDiagnostics;
  planApproval?: PlanApprovalMode;
  approvalPromptStatus?: PersistedSessionInfo["approvalPromptStatus"];
  approvalState?: PersistedSessionInfo["approvalState"];
  pendingWorktreeDecisionSince?: string;
}

export interface SessionListingOptions {
  full?: boolean;
}

const DEFAULT_SESSION_LIST_LIMIT = 5;
const FULL_SESSION_LIST_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESOLVED_WORKTREE_STATES = new Set<string>(["merged", "released", "dismissed", "no_change"]);

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

function persistedBackendConversationId(persisted: PersistedSessionInfo): string | undefined {
  return persisted.backendRef?.conversationId ?? persisted.harnessSessionId;
}

function preferResolvedWorktreeState(
  primary: SessionWorktreeState | undefined,
  fallback: SessionWorktreeState | undefined,
): SessionWorktreeState | undefined {
  if (fallback && RESOLVED_WORKTREE_STATES.has(fallback) && (!primary || !RESOLVED_WORKTREE_STATES.has(primary))) {
    return fallback;
  }
  return primary ?? fallback;
}

function preferResolvedWorktreeLifecycle(
  primary: PersistedWorktreeLifecycle | undefined,
  fallback: PersistedWorktreeLifecycle | undefined,
): PersistedWorktreeLifecycle | undefined {
  if (fallback && RESOLVED_WORKTREE_STATES.has(fallback.state) && (!primary || !RESOLVED_WORKTREE_STATES.has(primary.state))) {
    return fallback;
  }
  return primary ?? fallback;
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

function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** One-line backend usage summary: per-model cost/tokens, context fill, background work. */
export function formatSessionUsage(usage: HarnessUsage | undefined): string | undefined {
  if (!usage) return undefined;
  const parts: string[] = [];
  const models = [...(usage.models ?? [])].sort((a, b) => b.costUsd - a.costUsd);
  if (models.length > 0) {
    parts.push(models.map((entry) => {
      const tokens = [
        `in ${formatTokenCount(entry.inputTokens)}`,
        `out ${formatTokenCount(entry.outputTokens)}`,
        ...(entry.cacheReadTokens ? [`cache read ${formatTokenCount(entry.cacheReadTokens)}`] : []),
        ...(entry.cacheWriteTokens ? [`cache write ${formatTokenCount(entry.cacheWriteTokens)}`] : []),
      ].join(", ");
      const basis = entry.costBasis === "unknown" ? " (estimated: no price table)" : "";
      return `${entry.model} $${entry.costUsd.toFixed(4)}${basis} (${tokens})`;
    }).join("; "));
  }
  if (typeof usage.contextTokens === "number") {
    const window = typeof usage.contextWindow === "number" && usage.contextWindow > 0 ? usage.contextWindow : undefined;
    const percent = window ? ` (${Math.round((usage.contextTokens / window) * 100)}%)` : "";
    parts.push(`context ${formatTokenCount(usage.contextTokens)}${window ? `/${formatTokenCount(window)}` : ""}${percent}`);
  }
  if (usage.backgroundTasks) {
    parts.push(`background tasks: ${usage.backgroundTasks}`);
  }
  return parts.length > 0 ? `Usage: ${parts.join(" | ")}` : undefined;
}

/** Build a header line for active runtime sessions. */
function outputHeaderForActiveSession(session: ActiveSessionView): string {
  const duration = formatDuration(session.duration);
  const costStr = ` | Cost: $${session.costUsd.toFixed(4)}`;
  const phaseStr = session.phase ? ` | Phase: ${session.phase}` : "";
  const lifecycleStr = session.lifecycle && session.lifecycle !== session.phase ? ` | Lifecycle: ${session.lifecycle}` : "";
  const usageLine = formatSessionUsage(session.usage);
  return [
    `Session: ${session.name} [${session.id}] | Status: ${session.status.toUpperCase()}${phaseStr}${lifecycleStr}${costStr} | Duration: ${duration}`,
    ...(usageLine ? [usageLine] : []),
    `${"─".repeat(60)}`,
  ].join("\n");
}

/** Build a header line for persisted sessions loaded from disk/tmp output. */
function outputHeaderForPersistedSession(persisted: PersistedSessionInfo, source: string): string {
  const displayName = persisted.name || persisted.sessionId || persistedBackendConversationId(persisted) || "unknown";
  const phaseStr = persisted.lifecycle ? ` | Phase: ${persisted.lifecycle}` : "";
  return [
    `Session: ${displayName} | Status: ${persisted.status.toUpperCase()}${phaseStr} | Cost: $${persisted.costUsd.toFixed(4)}`,
    source,
    `${"─".repeat(60)}`,
  ].join("\n");
}

function persistedOutputSource(persisted: PersistedSessionInfo): string {
  return `(retrieved from ${persisted.outputPath} — evicted from runtime cache — showing persisted output)`;
}

function unavailablePersistedOutputSource(persisted: PersistedSessionInfo): string {
  return persisted.outputPath
    ? `(persisted session metadata recovered; output file is unavailable at ${persisted.outputPath})`
    : "(persisted session metadata recovered; no output file was recorded before the runtime was interrupted)";
}

function unavailablePersistedOutputText(persisted: PersistedSessionInfo, reason: string): string {
  const header = outputHeaderForPersistedSession(persisted, unavailablePersistedOutputSource(persisted));
  const backendConversationId = persistedBackendConversationId(persisted);
  const backendHint = backendConversationId ? `\nBackend session: ${backendConversationId}` : "";
  return `${header}\n(no persisted output available: ${reason})${backendHint}`;
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
        const header = outputHeaderForPersistedSession(persisted, persistedOutputSource(persisted));
        return output ? `${header}\n${output}` : `${header}\n(output file was empty)`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error: Session "${ref}" was cleaned up (expired) and output file could not be read: ${message}`;
      }
    }
    if (persisted?.outputPath) {
      return unavailablePersistedOutputText(persisted, `output file is missing at ${persisted.outputPath}`);
    }
    if (persisted) {
      return unavailablePersistedOutputText(persisted, "no outputPath is stored for this recovered session");
    }
    return `Error: Session "${ref}" not found.`;
  }

  const ownsReport = options.readerSessionKey ? session.noteOutcomeSeen(options.readerSessionKey) : false;
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
  const divider = "─".repeat(60);
  if (session.pendingPlanApproval && session.planFilePath) {
    try {
      if (existsSync(session.planFilePath)) {
        const planContent = readFileSync(session.planFilePath, "utf-8");
        return `${body}\n${divider}\nPlan file: ${session.planFilePath}\n${divider}\n${planContent}`;
      }
    } catch {
      // best-effort: if the file can't be read, return normal output
    }
  }
  // The pending plan must always be readable, even when it never reached the
  // output buffer (for example a plan submitted before any assistant text).
  const pendingPlan = session.pendingPlanApproval ? session.latestPlanArtifact?.markdown?.trim() : undefined;
  if (pendingPlan && !outputLines.join("\n").includes(pendingPlan)) {
    const version = session.latestPlanArtifactVersion;
    return `${body}\n${divider}\nPending plan${version ? ` (v${version})` : ""}:\n${divider}\n${pendingPlan}`;
  }
  if (ownsReport) {
    // This read replaces the outcome wake (see Session.noteOutcomeSeen).
    return `${body}\n${divider}\n[${session.name}] ended right after launch; no separate wake follows. Tell the user the outcome in this turn.`;
  }
  return body;
}

/**
 * Return a merged listing of active and persisted sessions.
 * Active sessions override persisted rows with the same internal session ID.
 */
export function getSessionsListingText(
  sm: SessionManager,
  filter: "all" | "running" | "waiting" | "completed" | "failed" | "killed" = "all",
  originChannel?: string,
  options: SessionListingOptions = {},
): string {
  const persisted = sm.listPersistedSessions() ?? [];
  const merged = mergeActiveAndPersistedSessions(sm.list("all"), persisted);
  let sessions = merged;
  if (filter === "waiting") {
    sessions = sessions.filter((s) => describeWaiting(s) !== undefined);
  } else if (filter !== "all") {
    sessions = sessions.filter((s) => s.status === filter);
  }
  if (originChannel) {
    sessions = sessions.filter((s) => s.originChannel === originChannel);
  }
  if (filter === "waiting") {
    if (sessions.length === 0) return "Nothing is waiting for a decision or an answer.";
    return sessions.map((s) => formatSessionListing(s, { nextStep: describeWaiting(s) })).join("\n\n");
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

const WORKTREE_DECISION_STATES = new Set(["pending_decision"]);

/**
 * What a session is waiting for and the next step, or undefined when it needs
 * nothing. Covers pending plans, questions, and worktree decisions.
 */
export function describeWaiting(session: SessionListingItem): string | undefined {
  const escalated = session.approvalPromptStatus === "delivered" || session.approvalPromptStatus === "fallback_delivered";
  if (session.phase === "awaiting_plan_decision") {
    return session.planApproval === "ask" || escalated
      ? "Plan waiting for the user: Approve / Revise / Reject (buttons, or reply approve, reject, or the changes)"
      : "Plan waiting for the orchestrator's review: approve it or agent_escalate(kind='plan')";
  }
  if (session.phase === "awaiting_user_input" && session.approvalState === "changes_requested") {
    // After Revise: the plan waits for the user's requested changes, not a question.
    return "Plan revision requested: waiting for the user's changes (forward them with agent_respond, userInitiated=true)";
  }
  if (session.phase === "awaiting_user_input") {
    return "Question waiting for an answer (agent_output shows it; answer with agent_respond)";
  }
  const lifecycleState = session.worktreeLifecycle?.state ?? session.worktreeState;
  // The recorded lifecycle decides; an existing PR does not settle a branch that
  // is pending again (for example new commits waiting for Sync PR).
  const pendingDecision = lifecycleState !== undefined
    ? WORKTREE_DECISION_STATES.has(lifecycleState)
    : session.phase === "awaiting_worktree_decision"
      || Boolean(session.pendingWorktreeDecisionSince && !session.worktreeMerged && !session.worktreePrUrl);
  if (pendingDecision) {
    return session.worktreeStrategy === "delegate"
      ? "Branch waiting for the orchestrator: agent_merge, or agent_escalate(kind='worktree')"
      : `Branch waiting for the user: Merge / ${session.worktreePrUrl ? "Sync PR" : "Open PR"} / Later / Discard`;
  }
  return undefined;
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
    const backendConversationId = persistedBackendConversationId(p);
    const key = p.sessionId ?? `persisted:${backendConversationId ?? p.harnessSessionId}`;
    merged.set(key, {
      id: p.sessionId ?? backendConversationId ?? p.harnessSessionId,
      name: p.name || p.sessionId || backendConversationId || p.harnessSessionId,
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
      model: p.model,
      reasoningEffort: p.reasoningEffort,
      backendRef: p.backendRef,
      harnessSessionId: p.harnessSessionId,
      requestedPermissionMode: p.requestedPermissionMode,
      currentPermissionMode: p.currentPermissionMode,
      approvalExecutionState: p.approvalExecutionState,
      originChannel: p.originChannel,
      originThreadId: p.originThreadId,
      worktreePath: p.worktreePath,
      worktreeBranch: p.worktreeBranch,
      worktreeStrategy: p.worktreeStrategy,
      worktreeState: p.worktreeState,
      worktreeLifecycle: p.worktreeLifecycle,
      worktreeMerged: p.worktreeMerged,
      worktreeMergedAt: p.worktreeMergedAt,
      worktreePrUrl: p.worktreePrUrl,
      recovered: true,
      runtimeRecovery: p.runtimeRecovery,
      planApproval: p.planApproval,
      approvalPromptStatus: p.approvalPromptStatus,
      approvalState: p.approvalState,
      pendingWorktreeDecisionSince: p.pendingWorktreeDecisionSince,
    });
  }

  for (const session of active) {
    const persistedMatch = merged.get(session.id);
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
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      backendRef: session.backendRef,
      harnessSessionId: session.harnessSessionId,
      requestedPermissionMode: session.requestedPermissionMode,
      currentPermissionMode: session.currentPermissionMode,
      approvalExecutionState: session.approvalExecutionState,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      worktreePath: session.worktreePath,
      worktreeBranch: session.worktreeBranch,
      worktreeStrategy: session.worktreeStrategy,
      worktreeState: preferResolvedWorktreeState(session.worktreeState, persistedMatch?.worktreeState),
      worktreeLifecycle: preferResolvedWorktreeLifecycle(session.worktreeLifecycle, persistedMatch?.worktreeLifecycle),
      worktreeMerged: session.worktreeMerged ?? persistedMatch?.worktreeMerged,
      worktreeMergedAt: session.worktreeMergedAt ?? persistedMatch?.worktreeMergedAt,
      worktreePrUrl: session.worktreePrUrl ?? persistedMatch?.worktreePrUrl,
      recovered: false,
      planApproval: session.planApproval,
      approvalPromptStatus: session.approvalPromptStatus,
      approvalState: session.approvalState,
      pendingWorktreeDecisionSince: persistedMatch?.pendingWorktreeDecisionSince,
    });
  }

  return [...merged.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
