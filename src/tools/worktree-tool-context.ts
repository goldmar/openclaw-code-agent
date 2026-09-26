import type { PersistedSessionInfo } from "../types";
import { existsSync, readFileSync } from "fs";
import type { ResolvedWorktreeLifecycle } from "../types";
import type { Session } from "../session";
import { getBackendConversationId, getPersistedMutationRefs, getPrimarySessionLookupRef } from "../session-backend-ref";
import type { SessionManager } from "../session-manager";
import { resolveWorktreeLifecycle } from "../worktree-lifecycle-resolver";
import { describeHookPathChanges, listHookPathChanges } from "../git-hooks";

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
}): Promise<string | undefined> {
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
  const prompt = await args.sessionManager.requestWorktreeDecisionFromUser?.(
    args.sessionRef,
    "Changes git hook or worktree setup files; waiting for your decision.",
    { hookWarning },
  ) ?? "";
  return [
    `❌ ${args.action === "merge" ? "Not merged" : "No PR opened"}: ${hookWarning.replace(/^⚠️\s*/u, "")}`,
    `Only the user's button can ${args.action === "merge" ? "merge" : "open a PR for"} this branch. ${prompt}`,
  ].join("\n");
}

export interface ResolvedWorktreeToolTarget {
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
  const persistedSession = sessionManager.getPersistedSession(ref);
  const persistedRef = activeSession
    ? getPrimarySessionLookupRef(activeSession)
    : (persistedSession ? getPrimarySessionLookupRef(persistedSession) : undefined);
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

export function getPersistedTargetMutationRefs(target: ResolvedWorktreeToolTarget): string[] {
  return [
    ...(target.persistedSession ? getPersistedMutationRefs(target.persistedSession) : []),
    ...(target.activeSession ? getPersistedMutationRefs(target.activeSession) : []),
  ].filter((ref, index, refs) => refs.indexOf(ref) === index);
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

/**
 * A caller that passed `summary` already told the user what changed, so the
 * outcome wake that asks the orchestrator for a follow-up summary is skipped
 * (and no pending-summary repair flag is persisted).
 */
export function summaryOwnership(summary?: string): { completionSummaryOwner?: "foreground" } {
  return summary?.trim() ? { completionSummaryOwner: "foreground" } : {};
}
