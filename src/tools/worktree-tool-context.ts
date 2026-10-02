import type { PersistedSessionInfo } from "../types";
import { existsSync, readFileSync } from "fs";
import type { ResolvedWorktreeLifecycle } from "../types";
import type { Session } from "../session";
import { getBackendConversationId, getPrimarySessionLookupRef } from "../session-backend-ref";
import type { SessionManager } from "../session-manager";
import { resolveWorktreeLifecycle } from "../worktree-lifecycle-resolver";
import { describeHookPathChanges, listHookPathChanges } from "../git-hooks";
import { persistedForActiveGeneration, persistedGeneration, type SessionGeneration } from "../session-generation";
import { pathsReferToSameLocation } from "../path-utils";
import { sessionToolError } from "./session-tool-error";

/**
 * Tool-call id the button callback handler uses when a user's Merge / Open PR
 * button runs agent_merge or agent_pr. Model tool calls never carry it.
 */
export const USER_BUTTON_TOOL_CALL_ID = "callback";

/**
 * A branch that changes git hooks or worktree setup files is merged or turned
 * into a PR only on the user's button. Called from agent_merge / agent_pr: for
 * any other caller it posts the decision prompt (naming the files) and returns
 * the refusal text; undefined when the call may proceed.
 */
export async function refuseHookChangesWithoutUser(args: {
  sessionManager: Partial<Pick<SessionManager, "requestWorktreeDecisionFromUser">>;
  toolCallId: string;
  sessionRef: string;
  repoDir: string;
  branchName: string;
  baseBranch: string;
  action: "merge" | "pr";
  /** Revalidate supported resolution immediately before decision dispatch. */
  decisionRef?: () => string | undefined;
}): Promise<string | ReturnType<typeof sessionToolError> | undefined> {
  if (args.toolCallId === USER_BUTTON_TOOL_CALL_ID) return undefined;
  let hookWarning: string | undefined;
  try {
    hookWarning = describeHookPathChanges(await listHookPathChanges(args.repoDir, args.branchName, args.baseBranch));
  } catch {
    // Without a computable branch diff the merge or PR itself cannot run
    // either; let it report the real problem.
    return undefined;
  }
  if (!hookWarning) return undefined;
  const decisionRef = args.decisionRef ? args.decisionRef() : args.sessionRef;
  if (!decisionRef) return sessionToolError("session_target_changed", "Error: The selected session changed before its worktree decision could be escalated.", true);
  const prompt = await args.sessionManager.requestWorktreeDecisionFromUser?.(
    decisionRef,
    "Changes git hook or worktree setup files; waiting for your decision.",
    { hookWarning },
  ) ?? "";
  return [
    `❌ ${args.action === "merge" ? "Not merged" : "No PR opened"}: ${hookWarning.replace(/^⚠️\s*/u, "")}`,
    `Only the user's button can ${args.action === "merge" ? "merge" : "open a PR for"} this branch. ${prompt}`,
  ].join("\n");
}

export interface ResolvedWorktreeToolTarget {
  generation?: SessionGeneration;
  initiallyPersisted?: boolean;
  activeSession?: Session;
  persistedSession?: PersistedSessionInfo;
  persistedRef?: string;
  sessionName: string;
  prompt?: string;
  outputPreview?: string;
  worktreePath?: string;
  originalWorkdir?: string;
  branchName?: string;
  notificationTarget?: {
    id: string;
    name?: string;
    harnessSessionId?: string;
    backendRef?: Session["backendRef"] | PersistedSessionInfo["backendRef"];
    route?: PersistedSessionInfo["route"];
    originChannel?: string;
    originThreadId?: string | number;
    originSessionKey?: string;
    goalTaskId?: string;
    costUsd?: number;
    createdAt?: number;
    completedAt?: number;
    harnessName?: string;
    model?: string;
    reasoningEffort?: PersistedSessionInfo["reasoningEffort"];
  };
}

function containsPrSessionReport(output: string | undefined): boolean {
  if (!output) return false;
  const headings = new Set(
    output.split(/\r?\n/)
      .map((line) => line.trim().replace(/^[#*_\s]+|[:*_\s]+$/g, "").toLowerCase()),
  );
  const hasSummary = ["root cause", "summary", "result"].some((heading) => headings.has(heading));
  const hasChanges = ["fix", "changes", "implementation", "implemented"].some((heading) => headings.has(heading));
  const hasValidation = ["validation", "verification", "tests"].some((heading) => headings.has(heading));
  return hasSummary && hasChanges && hasValidation;
}

export function resolveWorktreeToolTarget(sessionManager: SessionManager, ref: string): ResolvedWorktreeToolTarget {
  const activeSession = sessionManager.resolve(ref);
  // An alias may resolve to different active and persisted winners. Once an
  // active OCA ID won, only that ID's row may supply metadata or output.
  const persistedSession = activeSession
    ? persistedForActiveGeneration(activeSession, {
        getSessionGeneration: (generation) => sessionManager.getSessionGeneration(generation),
        listPersistedSessions: () => sessionManager.listPersistedSessions(),
        listActiveSessions: () => sessionManager.list("all"),
      })
    : sessionManager.getPersistedSession(ref);
  const generation = persistedSession ? persistedGeneration(persistedSession)
    : activeSession ? { kind: "oca" as const, sessionId: activeSession.id } : undefined;
  if (generation?.kind === "legacy" && activeSession) generation.pinnedLiveSessionId = activeSession.id;
  const persistedRef = activeSession
    ? activeSession.id
    : (persistedSession?.sessionId ?? getBackendConversationId(persistedSession ?? {}) ?? persistedSession?.harnessSessionId);
  const activeOutput = activeSession?.getOutput?.().join("\n").trim();
  let persistedOutput: string | undefined;
  if (persistedSession?.outputPath && existsSync(persistedSession.outputPath)) {
    try {
      persistedOutput = readFileSync(persistedSession.outputPath, "utf-8").trim();
    } catch {
      // PR metadata can still fall back to prompt and diff evidence.
    }
  }
  const activeHasReport = containsPrSessionReport(activeOutput);
  const persistedHasReport = containsPrSessionReport(persistedOutput);
  const output = activeHasReport === persistedHasReport
    ? ((persistedOutput?.length ?? 0) > (activeOutput?.length ?? 0) ? persistedOutput : activeOutput)
    : (persistedHasReport ? persistedOutput : activeOutput);

  return {
    generation,
    initiallyPersisted: Boolean(persistedSession),
    activeSession,
    persistedSession,
    persistedRef,
    sessionName: activeSession?.name ?? persistedSession?.name ?? ref,
    prompt: activeSession?.prompt ?? persistedSession?.prompt,
    outputPreview: output ? output.slice(-12_000) : undefined,
    worktreePath: activeSession?.worktreePath ?? persistedSession?.worktreePath,
    originalWorkdir: activeSession?.originalWorkdir ?? persistedSession?.workdir,
    branchName: activeSession?.worktreeBranch ?? persistedSession?.worktreeBranch,
    notificationTarget: activeSession ?? (persistedSession
      ? {
          id: persistedRef ?? ref,
          name: persistedSession.name,
          harnessSessionId: persistedSession.harnessSessionId,
          backendRef: persistedSession.backendRef,
          route: persistedSession.route,
          originChannel: persistedSession.originChannel,
          originThreadId: persistedSession.originThreadId,
          originSessionKey: persistedSession.originSessionKey,
          goalTaskId: persistedSession.goalTaskId,
          ...(persistedSession.costUsd !== undefined ? { costUsd: persistedSession.costUsd } : {}),
          ...(persistedSession.createdAt !== undefined ? { createdAt: persistedSession.createdAt } : {}),
          ...(persistedSession.completedAt !== undefined ? { completedAt: persistedSession.completedAt } : {}),
          ...(persistedSession.harness !== undefined ? { harnessName: persistedSession.harness } : {}),
          ...(persistedSession.model !== undefined ? { model: persistedSession.model } : {}),
          ...(persistedSession.reasoningEffort !== undefined ? { reasoningEffort: persistedSession.reasoningEffort } : {}),
        }
      : undefined),
  };
}

export function patchWorktreeTarget(sm: SessionManager, target: ResolvedWorktreeToolTarget, patch: Partial<PersistedSessionInfo>): boolean {
  return !!target.generation && sm.updateSessionGeneration(target.generation, patch, { persisted: !!target.initiallyPersisted });
}

/** The supported decision API still accepts references; prove it selects the binding. */
export function worktreeDecisionRef(sm: SessionManager, target: ResolvedWorktreeToolTarget): string | undefined {
  if (!target.generation) return undefined;
  if (target.generation.kind === "oca") {
    const id = target.generation.sessionId;
    const selectedActive = sm.resolve(id);
    if (selectedActive && selectedActive.id !== id) return undefined;
    if (target.initiallyPersisted && !sm.getSessionGeneration(target.generation)) return undefined;
    if (!target.initiallyPersisted && !sm.get(id)) return undefined;
    return id;
  }
  const row = sm.getSessionGeneration(target.generation);
  const ref = row?.backendRef?.conversationId ?? row?.harnessSessionId;
  if (!row || !ref) return undefined;
  const selectedActive = sm.resolve(ref);
  if (selectedActive && (selectedActive.id !== target.activeSession?.id
    || getBackendConversationId(selectedActive) !== target.generation.backendConversationId)) return undefined;
  const selected = sm.getPersistedSession(ref);
  return selected && !selected.sessionId && selected.harnessSessionId === target.generation.storageKey
    && getBackendConversationId(selected) === target.generation.backendConversationId ? ref : undefined;
}

function coordinates(active?: Session, persisted?: PersistedSessionInfo) {
  return {
    worktreePath: active?.worktreePath ?? persisted?.worktreePath,
    originalWorkdir: active?.originalWorkdir ?? persisted?.workdir,
    branchName: active?.worktreeBranch ?? persisted?.worktreeBranch,
    baseBranch: active?.worktreeBaseBranch ?? persisted?.worktreeBaseBranch,
  };
}

const COMPETING_RESOLUTIONS = new Set(["pr_open", "released", "dismissed", "no_change"]);
function resolutions(session: Session | PersistedSessionInfo | undefined): string[] {
  if (!session) return [];
  const values = [session.worktreeLifecycle?.state, session.worktreeState,
    "worktreeDisposition" in session ? session.worktreeDisposition : undefined];
  return values.flatMap((value) => value === "pr-opened" ? ["pr_open"] : value === "later" ? [] : value ? [value] : []);
}

export function captureWorktreeTarget(target: ResolvedWorktreeToolTarget) {
  return { ...coordinates(target.activeSession, target.persistedSession),
    activeFacts: target.activeSession ? coordinates(target.activeSession) : undefined,
    persistedFacts: target.persistedSession ? coordinates(undefined, target.persistedSession) : undefined,
    resolutions: new Set([...resolutions(target.activeSession), ...resolutions(target.persistedSession)]) };
}

/** Check only captured generation and consequential worktree facts, never aliases. */
export function checkWorktreeTarget(sm: SessionManager, target: ResolvedWorktreeToolTarget,
  admitted: ReturnType<typeof captureWorktreeTarget>, explicitBase: boolean): { changed: boolean; merged: boolean; persisted?: PersistedSessionInfo } {
  if (!target.generation) return { changed: true, merged: false };
  const persisted = target.initiallyPersisted ? sm.getSessionGeneration(target.generation) : undefined;
  const activeId = target.activeSession?.id ?? (target.generation.kind === "oca" ? target.generation.sessionId : target.generation.pinnedLiveSessionId);
  const active = activeId ? sm.get(activeId) : undefined;
  if ((target.initiallyPersisted && !persisted) || (!target.initiallyPersisted && !active)) return { changed: true, merged: false };
  const currentResolutions = [...resolutions(active), ...resolutions(persisted)];
  const merged = currentResolutions.includes("merged") || !!persisted?.worktreeMerged;
  // A proven exact generation may have cleared its coordinates during cleanup.
  if (merged) return { changed: false, merged: true, persisted };
  const samePath = (a?: string, b?: string) => a === b || pathsReferToSameLocation(a, b);
  const changedFacts = (facts: ReturnType<typeof coordinates>, before?: ReturnType<typeof coordinates>) => {
    const expected = (key: keyof typeof facts) => before?.[key] ?? admitted[key];
    return !samePath(facts.worktreePath, expected("worktreePath"))
      || !samePath(facts.originalWorkdir, expected("originalWorkdir"))
      || facts.branchName !== expected("branchName")
      || (!explicitBase && facts.baseBranch !== expected("baseBranch"));
  };
  // Compare both authoritative sources; a stale live value must not conceal a
  // changed persisted coordinate (or the reverse). Missing initial fields keep
  // their normal metadata fallback unless filled incompatibly.
  const changedSource = (facts: ReturnType<typeof coordinates>, before?: ReturnType<typeof coordinates>) => {
    const effective = { ...facts };
    for (const key of Object.keys(effective) as Array<keyof typeof effective>) {
      if (facts[key] === undefined && before?.[key] === undefined) effective[key] = admitted[key];
    }
    return changedFacts(effective, before);
  };
  const changed = (active && changedSource(coordinates(active), admitted.activeFacts))
    || (persisted && changedSource(coordinates(undefined, persisted), admitted.persistedFacts));
  const competing = currentResolutions.some((state) => COMPETING_RESOLUTIONS.has(state) && !admitted.resolutions.has(state));
  return { changed: !!changed || competing, merged, persisted };
}

export interface WorktreeToolListingTarget {
  id: string;
  name: string;
  worktreePath: string;
  worktreeBranch?: string;
  worktreeStrategy?: string;
  workdir: string;
  worktreeMerged?: boolean;
  worktreeMergedAt?: string;
  worktreePrUrl?: string;
  backendConversationId?: string;
}

export function resolveWorktreeToolSessions(
  sessionManager: SessionManager,
  target: Pick<WorktreeToolListingTarget, "id" | "name" | "backendConversationId">,
): {
  activeSession?: Session;
  persistedSession?: PersistedSessionInfo;
} {
  const refs = [
    target.id,
    target.backendConversationId,
    target.name,
  ];

  let activeSession: Session | undefined;
  let persistedSession: PersistedSessionInfo | undefined;
  for (const ref of refs) {
    if (!ref) continue;
    activeSession ??= sessionManager.resolve(ref);
    persistedSession ??= sessionManager.getPersistedSession(ref);
    if (activeSession && persistedSession) break;
  }

  return { activeSession, persistedSession };
}

export async function resolveWorktreeToolLifecycle(
  sessionManager: SessionManager,
  target: WorktreeToolListingTarget,
  options: {
    baseBranch?: string;
  } = {},
): Promise<{
  activeSession?: Session;
  persistedSession?: PersistedSessionInfo;
  resolvedLifecycle: ResolvedWorktreeLifecycle;
}> {
  const { activeSession, persistedSession } = resolveWorktreeToolSessions(sessionManager, target);
  const resolvedLifecycle = await resolveWorktreeLifecycle({
    workdir: target.workdir,
    worktreePath: target.worktreePath,
    worktreeBranch: target.worktreeBranch,
    worktreeBaseBranch: options.baseBranch ?? persistedSession?.worktreeBaseBranch,
    worktreePrTargetRepo: persistedSession?.worktreePrTargetRepo,
    worktreePushRemote: persistedSession?.worktreePushRemote,
    worktreePrUrl: persistedSession?.worktreePrUrl,
    worktreePrNumber: persistedSession?.worktreePrNumber,
    worktreeLifecycle: persistedSession?.worktreeLifecycle,
  }, {
    activeSession: Boolean(activeSession && (activeSession.status === "starting" || activeSession.status === "running")),
    includePrSync: Boolean(persistedSession?.worktreeLifecycle?.state === "pr_open" || persistedSession?.worktreePrUrl),
  });

  return {
    activeSession,
    persistedSession,
    resolvedLifecycle,
  };
}

export function listWorktreeToolTargets(sessionManager: SessionManager): WorktreeToolListingTarget[] {
  const activeSessions = sessionManager.list("all").filter((s) => s.worktreePath);
  const persistedSessions = sessionManager.listPersistedSessions().filter((p) => p.worktreePath);

  const sessionMap = new Map<string, WorktreeToolListingTarget>();

  for (const p of persistedSessions) {
    if (!p.worktreePath) continue;
    const backendConversationId = getBackendConversationId(p);
    const key = p.sessionId ?? backendConversationId;
    if (!key) continue;
    sessionMap.set(key, {
      id: key,
      name: p.name,
      worktreePath: p.worktreePath,
      worktreeBranch: p.worktreeBranch,
      worktreeStrategy: p.worktreeStrategy,
      workdir: p.workdir,
      worktreeMerged: p.worktreeMerged,
      worktreeMergedAt: p.worktreeMergedAt,
      worktreePrUrl: p.worktreePrUrl,
      backendConversationId,
    });
  }

  for (const s of activeSessions) {
    if (!s.worktreePath) continue;
    sessionMap.set(s.id, {
      id: s.id,
      name: s.name,
      worktreePath: s.worktreePath,
      worktreeBranch: s.worktreeBranch,
      worktreeStrategy: s.worktreeStrategy,
      workdir: s.originalWorkdir ?? s.workdir,
      worktreeMerged: undefined,
      worktreeMergedAt: undefined,
      worktreePrUrl: undefined,
      backendConversationId: getBackendConversationId(s),
    });
  }

  return Array.from(sessionMap.values());
}

export function matchesWorktreeToolRef(
  target: Pick<WorktreeToolListingTarget, "id" | "name" | "backendConversationId">,
  ref: string,
): boolean {
  return target.id === ref
    || target.name === ref
    || target.backendConversationId === ref;
}

export function formatWorktreeLifecycleState(state: string): string {
  switch (state) {
    case "none":
      return "none";
    case "provisioned":
      return "active";
    case "pending_decision":
      return "needs decision";
    case "merge_conflict_resolving":
      return "conflict resolving";
    case "pr_open":
      return "pr open";
    case "merged":
      return "merged";
    case "released":
      return "released";
    case "dismissed":
      return "dismissed";
    case "no_change":
      return "no change";
    case "cleanup_failed":
      return "cleanup failed";
    default:
      return state;
  }
}

export function formatWorktreePreserveReason(reason: string): string {
  switch (reason) {
    case "active_session":
      return "active session";
    case "pending_decision":
      return "pending decision";
    case "merge_conflict_resolving":
      return "conflict resolving";
    case "dirty_tracked_changes":
    case "dirty_worktree_entries":
      return "dirty worktree";
    case "unique_content":
      return "still has unique content";
    case "topology_merged":
      return "merged by ancestry";
    case "merge_noop_content_already_on_base":
      return "content already on base";
    case "pr_open":
      return "PR open";
    case "pr_merged_not_reflected_locally":
      return "merged PR not reflected locally";
    case "stale_pr_open":
      return "stale PR-open metadata";
    case "repo_missing":
      return "repo missing";
    case "branch_missing":
      return "branch missing";
    case "worktree_missing":
      return "worktree missing";
    case "base_branch_missing":
      return "base branch missing";
    default:
      if (reason.startsWith("released_by_branch:")) {
        return `represented by ${reason.slice("released_by_branch:".length)}`;
      }
      if (reason.startsWith("represented_by_branch:")) {
        return `represented by ${reason.slice("represented_by_branch:".length)}`;
      }
      return reason.replaceAll("_", " ");
  }
}

const OUTCOME_SUMMARY_MAX_CHARS = 400;

/** The orchestrator's `summary` shown under a merge/PR outcome line. */
export function withOutcomeSummary(outcomeLine: string, summary?: string): string {
  const text = summary?.replace(/\s+/g, " ").trim();
  if (!text) return outcomeLine;
  const clipped = text.length > OUTCOME_SUMMARY_MAX_CHARS ? `${text.slice(0, OUTCOME_SUMMARY_MAX_CHARS - 1)}…` : text;
  return `${outcomeLine}\n${clipped}`;
}

/** Tool-result note for a caller that passed `summary`, so it does not restate the outcome. */
export function summaryShownNote(summary?: string): string {
  return summary?.trim() ? "\nThe user saw this outcome with your summary; do not repeat it." : "";
}

/**
 * A caller that passed `summary` tells the user what changed in the outcome
 * line itself, so no follow-up summary wake is sent once that line is
 * delivered. If the line cannot be delivered, the orchestrator is still woken.
 */
export function summaryOwnership(summary?: string): { outcomeSummaryShown?: true } {
  return summary?.trim() ? { outcomeSummaryShown: true } : {};
}
