import { assertBranchName, assertBranchOrRemoteTrackingRef, branchNameValidationError, localBranchRef, targetRepoValidationError } from "../worktree-ref-validation";
import { repoHookGitArgs } from "../git-hooks";
import { Type } from "../tool-parameter-schema";
import { runGit, withRepoLock } from "../git-exec";
import { existsSync } from "fs";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext, PersistedSessionInfo } from "../types";
import type { DiffSummary, PRBodyReadResult, PRStatus } from "../worktree";
import { getDiffSummary, createPR, pushBranch, isGitHubCLIAvailable, resolveLandingBaseBranch, syncWorktreePR, syncWorktreePRByUrl, commentOnPR, resolveTargetRepo, formatWorktreeOutcomeLine, branchExists, isBranchAncestorOfBase, getBranchName, getCheckoutPathForBranch, getPRBody, updatePRBody, updatePRTitle, fetchRemoteBranchRef, getCommitsNotInPr, resolvePrBaseRemote } from "../worktree";
import { buildPrMetadata, createRuntimePrMetadataProvider, formatPrBody, isOcaFallbackPrBody, isOcaGeneratedPrBody, isOcaGeneratedPrTitle } from "../worktree-pr-metadata";
import type { PrMetadata, PrMetadataProvider } from "../worktree-pr-metadata";
import { buildMergedPatch, buildPrOpenPatch } from "../worktree-session-patches";
import { formatCount } from "../format";
import { owedCompletionCycle, patchWorktreeTarget, worktreeDecisionRef, refuseHookChangesWithoutUser, resolveWorktreeToolTarget, summaryOwnership, summaryShownNote, withOutcomeSummary } from "./worktree-tool-context";
import { createLogger } from "../logger";

const log = createLogger("agent-pr");

export { buildPrMetadata, createRuntimePrMetadataProvider, formatPrBody, isOcaGeneratedPrBody, isOcaGeneratedPrTitle } from "../worktree-pr-metadata";
export type { PrMetadata, PrMetadataEvidence, PrMetadataProvider, PrMetadataResult } from "../worktree-pr-metadata";

interface AgentPrParams {
  session: string;
  title?: string;
  body?: string;
  update_metadata?: boolean;
  summary?: string;
  base_branch?: string;
  force_new?: boolean;
  target_repo?: string;
}

function isAgentPrParams(value: unknown): value is AgentPrParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.session === "string";
}

type AgentPrExecuteResult = {
  content: Array<{ type: "text"; text: string }>;
  meta: {
    success: boolean;
    state:
      | "error"
      | "pr_open"
      | "pr_updated"
      | "merged"
      | "closed"
      | "created"
      /** `force_new` met an open or merged PR (`prState`); nothing was pushed or created. */
      | "force_new_refused";
    prState?: "open" | "merged";
    /** An outcome notice went to the user; otherwise a button press shows the tool text. */
    outcomeNotified?: boolean;
    decisionRequested?: boolean;
  };
};

export type ExistingTargetPrBranchResolution =
  | {
      success: true;
      branchName: string;
      alreadyRepresented: boolean;
    }
  | {
      success: false;
      error: string;
    };

export function shouldIgnoreClosedTargetPrForForceNew(forceNew: boolean | undefined, prStatus: PRStatus | undefined): boolean {
  // Only a PR closed without merging is replaced: an open or merged PR refuses force_new.
  return forceNew === true && prStatus?.exists === true && prStatus.state === "closed";
}

export function normalizeForceNewReplacementPrStatus(
  prStatus: PRStatus,
  ignoredTargetPrStatus: PRStatus | undefined,
  options: { forceNewIgnoresClosedTargetPr: boolean },
): PRStatus {
  if (
    options.forceNewIgnoresClosedTargetPr
    && prStatus.exists
    && prStatus.state !== "open"
    && ignoredTargetPrStatus?.exists === true
    && (
      (prStatus.url !== undefined && prStatus.url === ignoredTargetPrStatus.url)
      || (prStatus.number !== undefined && prStatus.number === ignoredTargetPrStatus.number)
    )
  ) {
    return { exists: false, state: "none" };
  }
  return prStatus;
}

async function moveBranchFastForward(repoDir: string, targetBranch: string, sourceRef: string): Promise<ExistingTargetPrBranchResolution> {
  await assertBranchName(targetBranch);
  await assertBranchOrRemoteTrackingRef(sourceRef);
  try {
    // Only a true fast-forward may move the local branch: a local branch with
    // commits the source lacks (for example unpushed work) is never rewound.
    if (!(await isBranchAncestorOfBase(repoDir, targetBranch, sourceRef))) {
      return {
        success: false,
        error: `Refusing to move ${targetBranch} to ${sourceRef}: the local ${targetBranch} has commits that ${sourceRef} does not contain. Reconcile them manually, then run agent_pr again.`,
      };
    }
    const sourceCommitRef = sourceRef.startsWith("refs/remotes/") ? sourceRef : await localBranchRef(sourceRef);
    const targetWorktreePath = await getCheckoutPathForBranch(repoDir, targetBranch);
    if (targetWorktreePath) {
      await runGit([...repoHookGitArgs(), "-C", targetWorktreePath, "merge", "--ff-only", sourceCommitRef], { timeout: 30_000 });
      return { success: true, branchName: targetBranch, alreadyRepresented: false };
    }

    // Not checked out anywhere: compare-and-swap the ref so a concurrent change is never overwritten.
    const oldCommit = (await runGit(["-C", repoDir, "rev-parse", "--verify", await localBranchRef(targetBranch)], { timeout: 10_000 })).trim();
    const newCommit = (await runGit(["-C", repoDir, "rev-parse", "--verify", `${sourceCommitRef}^{commit}`], { timeout: 10_000 })).trim();
    await runGit(["-C", repoDir, "update-ref", await localBranchRef(targetBranch), newCommit, oldCommit], { timeout: 10_000 });
    return { success: true, branchName: targetBranch, alreadyRepresented: false };
  } catch (err) {
    return {
      success: false,
      error: `Failed to fast-forward existing PR branch ${targetBranch} from ${sourceRef}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Select (and fast-forward when needed) the branch an existing open PR should be
 * updated from. The ref checks and branch writes run under the repository lock
 * so they cannot interleave with a concurrent merge, checkout, or worktree
 * change on the same checkout.
 */
export function resolveExistingTargetPrUpdateBranch(args: {
  repoDir: string;
  sourceBranch: string;
  targetPrStatus: PRStatus;
  remote?: string;
}): Promise<ExistingTargetPrBranchResolution> {
  return withRepoLock(args.repoDir, () => resolveExistingTargetPrUpdateBranchLocked(args));
}

async function resolveExistingTargetPrUpdateBranchLocked(args: {
  repoDir: string;
  sourceBranch: string;
  targetPrStatus: PRStatus;
  remote?: string;
}): Promise<ExistingTargetPrBranchResolution> {
  const { repoDir, sourceBranch, targetPrStatus } = args;
  await assertBranchName(sourceBranch);
  if (!targetPrStatus.exists || targetPrStatus.state !== "open" || !targetPrStatus.headRefName) {
    return { success: false, error: "Target PR is not an open PR with a resolvable head branch." };
  }

  const targetBranch = targetPrStatus.headRefName;
  await assertBranchName(targetBranch);
  const remoteTargetRef = await fetchRemoteBranchRef(repoDir, targetBranch, args.remote);
  const authoritativeTargetRef = remoteTargetRef ?? targetBranch;
  if (targetBranch === sourceBranch && !remoteTargetRef) {
    return { success: true, branchName: sourceBranch, alreadyRepresented: false };
  }
  if (!(await branchExists(repoDir, targetBranch)) && !remoteTargetRef) {
    return { success: false, error: `Target PR branch ${targetBranch} is not available locally. Fetch it before updating the PR.` };
  }
  if (await isBranchAncestorOfBase(repoDir, sourceBranch, authoritativeTargetRef)) {
    if (
      remoteTargetRef
      && !(await isBranchAncestorOfBase(repoDir, remoteTargetRef, targetBranch))
      && await isBranchAncestorOfBase(repoDir, targetBranch, remoteTargetRef)
    ) {
      const synced = await moveBranchFastForward(repoDir, targetBranch, remoteTargetRef);
      if ("error" in synced) return synced;
    }
    // Local ancestry can select the branch, but only a fetched remote ref proves
    // the PR head already contains the helper work and makes skipping the push safe.
    return { success: true, branchName: targetBranch, alreadyRepresented: Boolean(remoteTargetRef) };
  }

  // The existing PR head may be checked out in the parent checkout and updated there
  // while the managed worktree still records its temporary helper branch. Prefer that
  // checked-out head only when it safely contains both the remote PR head and helper work.
  if (
    (await getBranchName(repoDir)) === targetBranch
    && await isBranchAncestorOfBase(repoDir, authoritativeTargetRef, targetBranch)
    && await isBranchAncestorOfBase(repoDir, sourceBranch, targetBranch)
  ) {
    return { success: true, branchName: targetBranch, alreadyRepresented: false };
  }
  if (!(await isBranchAncestorOfBase(repoDir, authoritativeTargetRef, sourceBranch))) {
    return {
      success: false,
      error: `Refusing to create a sibling PR: target PR branch ${targetBranch} and follow-up branch ${sourceBranch} have diverged. Reconcile them manually, then run agent_pr again.`,
    };
  }

  return moveBranchFastForward(repoDir, targetBranch, sourceBranch);
}

export async function discoverExistingTargetPr(args: {
  repoDir: string;
  worktreeBranch: string;
  expectedParentBranch?: string;
  baseBranch: string;
  targetRepo?: string;
  pushRemote?: string;
}): Promise<PRStatus | undefined> {
  const parentBranch = await getBranchName(args.repoDir);
  if (!parentBranch || parentBranch !== args.expectedParentBranch || parentBranch === args.worktreeBranch || parentBranch === args.baseBranch) return undefined;
  const status = await syncWorktreePR(args.repoDir, parentBranch, args.targetRepo, args.baseBranch, { pushRemote: args.pushRemote });
  return status.exists
    && status.state === "open"
    && status.headRefName === parentBranch
    && (!status.baseRefName || status.baseRefName === args.baseBranch)
    ? status
    : undefined;
}

export async function resolveExistingTargetPrUpdateSourceBranch(args: {
  repoDir: string;
  fallbackBranch: string;
  targetPrStatus: PRStatus;
}): Promise<string> {
  const targetBranch = args.targetPrStatus.headRefName;
  if (!targetBranch || targetBranch === args.fallbackBranch) {
    return args.fallbackBranch;
  }

  const currentBranch = await getBranchName(args.repoDir);
  if (currentBranch === targetBranch) {
    return currentBranch;
  }

  return args.fallbackBranch;
}

export function buildPrOutcomeDetailLines(args: {
  branchName: string;
  baseBranch: string;
  prUrl?: string;
  prNumber?: number;
  targetRepo?: string;
  commits?: number;
  insertions?: number;
  deletions?: number;
  action: "opened" | "updated";
}): string[] {
  return [
    args.action === "opened"
      ? `Opened PR for branch ${args.branchName} into ${args.baseBranch}.`
      : `Updated PR for branch ${args.branchName} into ${args.baseBranch}.`,
    ...(args.prUrl ? [`PR URL: ${args.prUrl}.`] : []),
    ...(args.prNumber ? [`PR number: #${args.prNumber}.`] : []),
    ...(args.targetRepo ? [`Target repository: ${args.targetRepo}.`] : []),
    ...(args.commits !== undefined
      ? [`Pushed ${formatCount(args.commits, "new commit")} (+${args.insertions ?? 0}/-${args.deletions ?? 0}).`]
      : []),
  ];
}

export function buildPrCompletionWakeOutcomeKey(args: {
  action: "opened" | "updated";
  branchName: string;
  prUrl?: string;
  prNumber?: number;
  targetRepo?: string;
  diffSummary?: DiffSummary;
}): string {
  const prIdentity = args.prNumber !== undefined
    ? `#${args.prNumber}`
    : (args.prUrl ?? "unknown-pr");
  const commits = args.diffSummary?.commitMessages
    .map((commit) => commit.hash.trim())
    .filter(Boolean)
    .join(",");
  const materialChange = args.action === "updated"
    ? (commits || [
        `commits:${args.diffSummary?.commits ?? "unknown"}`,
        `insertions:${args.diffSummary?.insertions ?? "unknown"}`,
        `deletions:${args.diffSummary?.deletions ?? "unknown"}`,
      ].join(","))
    : "created";
  return [
    "worktree-pr",
    args.action,
    args.targetRepo ?? "default-repo",
    prIdentity,
    args.branchName,
    materialChange,
  ].join(":");
}

type MetadataRefreshResult =
  | { status: "updated"; updatedTitle: boolean; updatedBody: boolean; reason: "explicit" | "generated" | "forced" }
  | { status: "skipped"; reason: "missing-pr-identity" | "human-edited" | "empty-body" | "unchanged" }
  | { status: "failed"; reason: string };

type MetadataRefreshOperations = {
  getBody?: (repoDir: string, prNumberOrUrl: number | string, targetRepo?: string) => PRBodyReadResult | Promise<PRBodyReadResult>;
  updateBody?: (repoDir: string, prNumberOrUrl: number | string, body: string, targetRepo?: string) => boolean | Promise<boolean>;
  updateTitle?: (repoDir: string, prNumberOrUrl: number | string, title: string, targetRepo?: string) => boolean | Promise<boolean>;
};

export async function refreshOpenPrMetadata(args: {
  repoDir: string;
  prStatus: PRStatus;
  targetRepo?: string;
  sessionName: string;
  branchName?: string;
  prompt?: string;
  outputPreview?: string;
  diffSummary?: DiffSummary;
  explicitTitle?: string;
  explicitBody?: string;
  forceRefresh: boolean;
  metadataProvider?: PrMetadataProvider;
  operations?: MetadataRefreshOperations;
}): Promise<MetadataRefreshResult> {
  const prIdentity = args.prStatus.number ?? args.prStatus.url;
  if (!prIdentity) return { status: "skipped", reason: "missing-pr-identity" };
  const readBody = args.operations?.getBody ?? getPRBody;
  const writeBody = args.operations?.updateBody ?? updatePRBody;
  const writeTitle = args.operations?.updateTitle ?? updatePRTitle;

  if (args.explicitTitle !== undefined || args.explicitBody !== undefined) {
    const updatedTitle = args.explicitTitle === undefined
      ? false
      : await writeTitle(args.repoDir, prIdentity, args.explicitTitle, args.targetRepo);
    if (args.explicitTitle !== undefined && !updatedTitle) {
      return { status: "failed", reason: "failed to update explicit PR title" };
    }

    const updatedBody = args.explicitBody === undefined
      ? false
      : await writeBody(args.repoDir, prIdentity, args.explicitBody, args.targetRepo);
    if (args.explicitBody !== undefined && !updatedBody) {
      return { status: "failed", reason: "failed to update explicit PR body" };
    }

    return { status: "updated", updatedTitle, updatedBody, reason: "explicit" };
  }

  const currentBodyResult = await readBody(args.repoDir, prIdentity, args.targetRepo);
  if (currentBodyResult.ok === false) {
    return { status: "failed", reason: `failed to read PR body: ${currentBodyResult.error}` };
  }
  const currentBody = currentBodyResult.body ?? "";
  if (currentBody.trim() === "" && !args.forceRefresh) return { status: "skipped", reason: "empty-body" };

  const replaceable = args.forceRefresh || isOcaGeneratedPrBody(currentBody);
  if (!replaceable) return { status: "skipped", reason: "human-edited" };

  const metadataResult = await buildPrMetadata({
    sessionName: args.sessionName,
    branchName: args.branchName,
    prompt: args.prompt,
    outputPreview: args.outputPreview,
    diffSummary: args.diffSummary,
    provider: args.metadataProvider,
  });
  if (metadataResult.ok === false) {
    return { status: "failed", reason: metadataResult.error };
  }
  const hasSessionReport = metadataResult.evidence.sessionSummary.length > 0
    || metadataResult.evidence.sessionChanges.length > 0;
  if (metadataResult.fallbackReason !== undefined && (!hasSessionReport || !isOcaFallbackPrBody(currentBody))) {
    return {
      status: "failed",
      reason: "generated PR metadata was unavailable; preserved existing generated PR metadata",
    };
  }

  const nextBody = formatPrBody({
    sessionName: args.sessionName,
    metadata: metadataResult.metadata,
    diffSummary: args.diffSummary,
  });
  const shouldRefreshTitle = args.forceRefresh || isOcaGeneratedPrTitle(args.prStatus.title);
  let updatedTitle = false;
  if (shouldRefreshTitle && args.prStatus.title?.trim() !== metadataResult.metadata.title.trim()) {
    updatedTitle = await writeTitle(args.repoDir, prIdentity, metadataResult.metadata.title, args.targetRepo);
    if (!updatedTitle) return { status: "failed", reason: "failed to update generated PR title" };
  }

  if (nextBody.trim() === currentBody.trim()) {
    return updatedTitle
      ? { status: "updated", updatedTitle, updatedBody: false, reason: args.forceRefresh ? "forced" : "generated" }
      : { status: "skipped", reason: "unchanged" };
  }

  const updatedBody = await writeBody(args.repoDir, prIdentity, nextBody, args.targetRepo);
  if (!updatedBody) return { status: "failed", reason: "failed to update generated PR body" };

  return { status: "updated", updatedTitle, updatedBody, reason: args.forceRefresh ? "forced" : "generated" };
}

function formatMetadataRefreshLine(result: MetadataRefreshResult): string | undefined {
  if (result.status === "updated") {
    if (result.updatedTitle && result.updatedBody) {
      return result.reason === "explicit"
        ? "📝 Replaced PR title/body with explicitly provided metadata."
        : "📝 Refreshed PR title/body from current OpenClaw metadata.";
    }
    if (result.updatedTitle) {
      return result.reason === "explicit"
        ? "📝 Replaced PR title with the explicitly provided title."
        : "📝 Refreshed PR title from current OpenClaw metadata.";
    }
    if (result.updatedBody) {
      return result.reason === "explicit"
        ? "📝 Replaced PR body with the explicitly provided body."
        : "📝 Refreshed PR body from current OpenClaw metadata.";
    }
  }
  if (result.status === "failed") {
    return `⚠️ PR metadata refresh failed: ${result.reason}`;
  }
  return undefined;
}

/** Register the `agent_pr` tool factory. */
export function makeAgentPrTool(_ctx?: OpenClawPluginToolContext, options: { metadataProvider?: PrMetadataProvider; terminalCompletion?: boolean } = {}) {
  return {
    name: "agent_pr",
    description: "Push a worktree branch and open a GitHub PR, or update the session's open PR (push plus a comment listing new commits). Posts the outcome to the user.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID" }),
      title: Type.Optional(Type.String({ description: "Default: generated" })),
      body: Type.Optional(Type.String({ description: "Default: generated. On an open PR, replaces the body." })),
      update_metadata: Type.Optional(Type.Boolean({ description: "Open PR: regenerate title and body (default: only OCA-generated ones)" })),
      base_branch: Type.Optional(Type.String({ description: "Base for a new PR. Default: the session's recorded base (worktree_base_branch at launch), else the detected default branch. An existing PR keeps its own base" })),
      force_new: Type.Optional(Type.Boolean({ description: "Open a new PR: fail instead of updating an open one; replaces one closed without merging" })),
      target_repo: Type.Optional(Type.String({ description: "owner/repo for cross-fork PRs (default: the upstream remote, else origin)" })),
      summary: Type.Optional(Type.String({ description: "One or two lines for the user on what changed; shown under the outcome line. Then no follow-up summary is requested from you." })),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }
      // Keep the manager this call started with: a Gateway stop can clear the
      // shared reference while a merge or PR is still running, and the outcome
      // must still be recorded on the manager (and store) that started it.
      const sm = sessionManager;
      if (!isAgentPrParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { session, title?, body?, update_metadata?, base_branch?, force_new?, target_repo?, summary? }." }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }

      if (params.base_branch !== undefined) {
        const branchError = await branchNameValidationError(params.base_branch);
        if (branchError) return { content: [{ type: "text", text: `Error: ${branchError}` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }
      if (params.target_repo !== undefined) {
        const repoError = targetRepoValidationError(params.target_repo);
        if (repoError) return { content: [{ type: "text", text: `Error: target_repo: ${repoError}` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }

      // Check if gh CLI is available
      if (!(await isGitHubCLIAvailable())) {
        return { content: [{ type: "text", text: "Error: GitHub CLI (gh) is not available. Install it and authenticate to create PRs." }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }

      // Resolve session (active or persisted)
      const target = resolveWorktreeToolTarget(sm, params.session);
      const targetSession = target.activeSession;
      const persistedSession = target.persistedSession;
      // Only the managed terminal caller may combine completion with a PR outcome.
      // Read current execution status by the captured identity after async PR work.
      const isTerminalCompletion = (): boolean => {
        if (!options.terminalCompletion || !target.generation) return false;
        const activeId = target.generation.kind === "oca"
          ? target.generation.sessionId : target.generation.pinnedLiveSessionId;
        const current = (activeId ? sm.get(activeId) : undefined)
          ?? sm.getSessionGeneration(target.generation);
        return current?.status === "completed";
      };

      if (!targetSession && !persistedSession) {
        return { content: [{ type: "text", text: `Error: Session "${params.session}" not found.` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }

      const { worktreePath, originalWorkdir, sessionName } = target;
      let { branchName } = target;

      if (!worktreePath || !originalWorkdir) {
        return { content: [{ type: "text", text: `Error: Session "${params.session}" does not have a worktree.` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }

      if (!branchName) {
        return { content: [{ type: "text", text: `Error: Cannot determine branch name for worktree ${worktreePath}. The worktree may have been removed and no persisted branch name is available.` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }
      if (!existsSync(worktreePath)) {
        log.info(`[agent_pr] Worktree directory ${worktreePath} no longer exists; proceeding with branch "${branchName}" via originalWorkdir (${originalWorkdir})`);
      }

      // Where a NEW PR goes and which of the branch's PRs a lookup prefers: the
      // session's landing base (the base this call names, else the base
      // recorded at launch, which is the target and not where the worktree was
      // created from, else the detected default branch). An existing PR keeps
      // its own base for everything said or counted about it: see `existingPrBase`.
      const pushRemote = persistedSession?.worktreePushRemote ?? targetSession?.worktreePushRemote ?? "origin";
      const baseBranch = await resolveLandingBaseBranch(persistedSession ?? targetSession, originalWorkdir, params.base_branch);
      /** The base of the PR that is being updated or settled; never retargeted by this call. */
      const existingPrBase = (status: PRStatus): string => status.baseRefName ?? baseBranch;
      const decisionRef = worktreeDecisionRef(sm, target);
      if (!decisionRef) return { content: [{ type: "text", text: "Error: The selected session changed before PR preparation." }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      const metadataProvider = options.metadataProvider ?? createRuntimePrMetadataProvider();
      /**
       * A PR that needed no new outcome (already merged, or up to date). When it
       * resolves a deferred completion it is that session's `✅` and is sent to
       * the user; otherwise the returned `ℹ️` line is only the tool text (a
       * button press shows it as its reply).
       */
      const settledPrLine = (what: string, prUrl: string, owedCycle: number | undefined): string => {
        if (owedCycle === undefined) return `ℹ️ [${sessionName}] ${what}: ${prUrl}`;
        const line = `✅ [${sessionName}] Completed — ${what}: ${prUrl}`;
        sm.notifyWorktreeOutcome(target.notificationTarget!, withOutcomeSummary(line, params.summary), {
          ...summaryOwnership(params.summary),
          completionWakeOutcomeKey: `worktree-pr:settled:${branchName}:${prUrl}:${owedCycle}`,
          detailLines: [`${what}: ${prUrl}.`, `No new commits were pushed for branch ${branchName}.`],
        });
        return line;
      };
      const persistPrOpen = (args: {
        prUrl: string;
        prNumber?: number;
        targetRepo?: string;
        disposition?: "pr-opened";
        /** The PR's own base (an existing PR), else the base the new PR was created into. */
        prBase?: string;
      }) => {
        const patch = buildPrOpenPatch(
          {
            worktreeBaseBranch: args.prBase ?? persistedSession?.worktreeBaseBranch ?? targetSession?.worktreeBaseBranch ?? baseBranch,
            worktreePrTargetRepo: persistedSession?.worktreePrTargetRepo ?? targetSession?.worktreePrTargetRepo,
            worktreePushRemote: persistedSession?.worktreePushRemote ?? targetSession?.worktreePushRemote,
          },
          {
            prUrl: args.prUrl,
            prNumber: args.prNumber,
            baseBranch: args.prBase ?? baseBranch,
            targetRepo: args.targetRepo,
            disposition: args.disposition,
          },
        );
        // Every PR resolution consumes the `✅` owed to a deferred completion.
        // `branchName` is the branch that was pushed: the PR's head.
        if (!patchWorktreeTarget(sm, target, { ...patch, deferredCompletionCycle: undefined, worktreePrClosed: undefined, worktreePrBaseBranch: args.prBase ?? baseBranch, worktreePrHeadBranch: branchName })) {
          throw new Error("PR operation completed, but its selected session state could not be updated. Reconcile before retrying.");
        }
      };

      // Resolve target repository for cross-repo PRs
      const targetRepo = await resolveTargetRepo(originalWorkdir, params.target_repo ?? persistedSession?.worktreePrTargetRepo);
      const explicitTargetPrUrl = persistedSession?.worktreePrUrl ?? targetSession?.worktreePrUrl;
      const explicitTargetPrStatus = explicitTargetPrUrl
        ? await syncWorktreePRByUrl(originalWorkdir, explicitTargetPrUrl, targetRepo, pushRemote)
        : undefined;
      if (explicitTargetPrUrl && (!explicitTargetPrStatus?.exists || explicitTargetPrStatus.ownHead === false)) {
        return {
          content: [{
            type: "text",
            text: `Error: Session is associated with ${explicitTargetPrUrl}, but ${explicitTargetPrStatus?.ownHead === false ? "that PR does not belong to the selected push remote" : "that PR could not be resolved"}. Refusing to create a sibling PR from \`${branchName}\`.`,
          }],
          meta: { success: false, state: "error" },
        } satisfies AgentPrExecuteResult;
      }
      const forceNewIgnoresClosedTargetPr = shouldIgnoreClosedTargetPrForForceNew(params.force_new, explicitTargetPrStatus);
      const effectiveTargetPrUrl = forceNewIgnoresClosedTargetPr ? undefined : explicitTargetPrUrl;
      const discoveredTargetPrStatus = !explicitTargetPrUrl && !params.force_new
        ? await discoverExistingTargetPr({
            repoDir: originalWorkdir,
            worktreeBranch: branchName,
            expectedParentBranch: persistedSession?.worktreeParentBranch ?? targetSession?.worktreeParentBranch,
            baseBranch,
            targetRepo,
            pushRemote,
          })
        : undefined;
      const effectiveTargetPrStatus = forceNewIgnoresClosedTargetPr
        ? undefined
        : (explicitTargetPrStatus ?? discoveredTargetPrStatus);
      const resolvedTargetPrUrl = effectiveTargetPrUrl ?? discoveredTargetPrStatus?.url;
      // ---- 1. Find the PR this call acts on. Reads only: nothing is pushed,
      // moved or changed above this line or in this step.
      // The session's recorded (or discovered parent) PR; else the PR of this
      // branch. Beside a merged recorded PR an open PR of this branch wins:
      // it is what a push would update. A recorded closed PR is kept until
      // the user explicitly asks for its replacement.
      const recordedPr = effectiveTargetPrStatus?.exists ? effectiveTargetPrStatus : undefined;
      const branchLookup = !recordedPr || recordedPr.state === "merged"
        ? await syncWorktreePR(originalWorkdir, branchName, targetRepo, baseBranch, { preferOpen: true, pushRemote })
        : undefined;
      if (branchLookup?.lookupFailed) {
        // "Could not look" is not "there is no PR": acting on it could push
        // into an open PR nobody checked.
        return {
          content: [{ type: "text", text: `❌ No PR opened: could not check existing pull requests for \`${branchName}\`: ${branchLookup.lookupFailed}` }],
          meta: { success: false, state: "error" },
        };
      }
      const targetFoundByBranch = !recordedPr || (branchLookup?.exists === true && branchLookup.state === "open");
      const existingPrBeforePush = normalizeForceNewReplacementPrStatus(
        targetFoundByBranch ? branchLookup! : recordedPr!,
        explicitTargetPrStatus,
        { forceNewIgnoresClosedTargetPr },
      );
      /** The URL the target is re-read by after the push; none when it was found by branch. */
      const targetPrUrl = targetFoundByBranch ? undefined : resolvedTargetPrUrl;

      // force_new never replaces an open or merged PR: refuse before pushing
      // anything. A flag left from an earlier "closed" finding is stale then
      // (the PR was reopened or merged), so the next buttons are Sync PR / View PR.
      // When that PR is not the one the session recorded (the recorded one
      // was closed and another was opened from this branch), the session
      // adopts it, so the next PR action and Sync PR / View PR target it.
      // Only a PR found by this session's branch is adopted, never another URL.
      const forceNewRefusal = (status: PRStatus, foundByBranch: boolean): AgentPrExecuteResult => {
        const adopt = foundByBranch && status.url !== undefined && status.url !== explicitTargetPrUrl && status.headRefName === branchName;
        const patch: Partial<PersistedSessionInfo> = {
          ...(persistedSession?.worktreePrClosed ? { worktreePrClosed: undefined } : {}),
          ...(adopt ? { worktreePrUrl: status.url, worktreePrNumber: status.number, worktreePrBaseBranch: status.baseRefName, worktreePrHeadBranch: status.headRefName } : {}),
        };
        if (Object.keys(patch).length > 0 && !patchWorktreeTarget(sm, target, patch)) {
          log.warn(`[agent_pr] Could not update the PR record of session ${sessionName} after a refused force_new`);
        }
        return {
          content: [{
            type: "text",
            text: `⚠️ Cannot create new PR: A PR already exists for \`${branchName}\` (${status.state}).\n\n` +
                  `Existing PR: ${status.url}\n\n` +
                  `To create a new PR, you must first close/merge the existing PR manually or use a different branch.`
          }],
          meta: { success: false, state: "force_new_refused", ...(status.state === "open" || status.state === "merged" ? { prState: status.state } : {}) },
        };
      };
      /** Record a PR that was merged and answer; nothing is pushed or moved. */
      const settleMerged = (prStatus: PRStatus): AgentPrExecuteResult => {
        const mergedPatch: Partial<PersistedSessionInfo> = {
          ...buildMergedPatch({
            // The base the PR was merged into is the base the session landed on.
            worktreeBaseBranch: prStatus.baseRefName ?? persistedSession?.worktreeBaseBranch ?? targetSession?.worktreeBaseBranch ?? baseBranch,
            worktreePrTargetRepo: persistedSession?.worktreePrTargetRepo ?? targetSession?.worktreePrTargetRepo,
            worktreePushRemote: persistedSession?.worktreePushRemote ?? targetSession?.worktreePushRemote,
          }, {
            resolutionSource: "agent_pr",
            mergedAt: prStatus.mergedAt,
            resolvedAt: prStatus.mergedAt,
            clearResolverSessionId: true,
          }),
          worktreePrUrl: prStatus.url,
          worktreePrNumber: prStatus.number,
          worktreePrBaseBranch: prStatus.baseRefName,
          worktreeDisposition: "merged",
          worktreeDecisionSnoozedUntil: undefined,
          deferredCompletionCycle: undefined,
          worktreePrClosed: undefined,
        };
        const owedCycle = owedCompletionCycle(sm, target.generation);
        if (!patchWorktreeTarget(sm, target, mergedPatch)) {
          return { content: [{ type: "text", text: "Error: PR is merged, but its selected session state could not be updated. Reconcile before retrying." }], meta: { success: false, state: "error" } };
        }
        return {
          content: [{
            type: "text",
            text: `${settledPrLine("PR was already merged", prStatus.url!, owedCycle)}\n\n` +
                  `The worktree branch \`${branchName}\` can be cleaned up with agent_merge(delete_branch=true).` +
                  (owedCycle === undefined ? "" : summaryShownNote(params.summary))
          }],
          meta: { success: true, state: "merged", ...(owedCycle === undefined ? {} : { outcomeNotified: true }) },
        };
      };
      /** A PR closed without merging: remember it (the prompts then offer New PR) and ask; nothing is pushed or moved. */
      const answerClosed = (prStatus: PRStatus): AgentPrExecuteResult => {
        // Case: PR was closed without merging — ask user what to do. The row
        // remembers it, so every decision prompt offers New PR from now on.
        if (!patchWorktreeTarget(sm, target, { worktreePrClosed: true })) {
          // Only the buttons of later prompts depend on it (they would offer Open PR / Sync PR again).
          log.warn(`[agent_pr] Could not record the closed PR of session ${sessionName}`);
        }
        return {
          content: [{
            type: "text",
            text: `⚠️ A PR exists but was closed without merging: ${prStatus.url}\n\n` +
                  `What would you like to do?\n\n` +
                  `1. Reopen the closed PR manually on GitHub, then call agent_pr() again to update it\n` +
                  `2. Close and delete the branch with agent_merge(delete_branch=true), then start a new session/worktree\n` +
                  `3. Call agent_pr(force_new=true) to open a fresh PR from the same branch (the user's New PR button does this)\n\n` +
                  `(This tool does not reopen or replace a closed PR on its own, to avoid unintended actions.)`
          }],
          meta: { success: false, state: "closed" },
        };
      };

      /** The merged PR that commits made after its merge replace with a new PR. */
      let supersededMergedPrUrl: string | undefined;
      // ---- 2. Outcomes that push and move nothing return here, before any
      // local branch movement, push or PR change (and so before the hook
      // check, which guards exactly those).
      if (existingPrBeforePush.exists) {
        if (params.force_new && (existingPrBeforePush.state === "open" || existingPrBeforePush.state === "merged")) {
          return forceNewRefusal(existingPrBeforePush, targetFoundByBranch);
        }
        if (existingPrBeforePush.state === "merged") {
          // Only the immutable merged head proves what was merged: a pruned
          // remote branch or an OCA settlement timestamp is not that boundary.
          const afterMerge = await getCommitsNotInPr(originalWorkdir, branchName, existingPrBeforePush, pushRemote);
          if (!afterMerge) return { content: [{ type: "text", text: "Error: Could not determine commits beyond the merged PR head. Nothing was pushed; reconcile the PR evidence and retry." }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
          if (afterMerge.count === 0) return settleMerged(existingPrBeforePush);
          supersededMergedPrUrl = existingPrBeforePush.url;
        }
        // (With force_new a closed PR is replaced by a new one: that is a push, below.)
        if (existingPrBeforePush.state === "closed" && !params.force_new) return answerClosed(existingPrBeforePush);
      }
      /** The open PR this call updates, if any; otherwise a new PR is opened. */
      const openPrToUpdate = existingPrBeforePush.exists && existingPrBeforePush.state === "open" ? existingPrBeforePush : undefined;

      const targetFingerprint = (status: PRStatus): string => JSON.stringify([status.exists, status.state, status.url, status.headRefName, status.baseRefName, status.ownHead]);
      const revalidatePrTarget = async (): Promise<AgentPrExecuteResult | undefined> => {
        const current = targetPrUrl
          ? await syncWorktreePRByUrl(originalWorkdir, targetPrUrl, targetRepo, pushRemote)
          : normalizeForceNewReplacementPrStatus(await syncWorktreePR(originalWorkdir, branchName, targetRepo, baseBranch, { preferOpen: true, pushRemote }), explicitTargetPrStatus, { forceNewIgnoresClosedTargetPr });
        if (current.lookupFailed || current.ownHead === false || targetFingerprint(current) !== targetFingerprint(existingPrBeforePush)) {
          return { content: [{ type: "text", text: "Error: PR target changed during preparation or could not be revalidated. Nothing was pushed; retry to check the current PR's own base and head." }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
        }
        return undefined;
      };
      const repoPolicy = await sm.resolveRepoPolicy(originalWorkdir);
      if (repoPolicy?.policy === "never-pr" && !openPrToUpdate) {
        return { content: [{ type: "text", text: `Error: Repo policy forbids PR creation for ${repoPolicy.identity?.repoRoot ?? originalWorkdir}.` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }
      if (repoPolicy && !repoPolicy.prAvailable) {
        return { content: [{ type: "text", text: `Error: PR automation is unavailable for ${repoPolicy.identity?.repoRoot ?? originalWorkdir}. Provider: ${repoPolicy.provider}.` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }
      const changedBeforeMovement = await revalidatePrTarget();
      if (changedBeforeMovement) return changedBeforeMovement;

      // ---- 3. From here on the call pushes: to update the open PR found in
      // step 1, or to open a new one. Hook and worktree-setup changes need the
      // user first. They are judged against the base the push is reviewed
      // against: the open PR's own base, else the base the new PR goes into.
      // A check that cannot be computed counts as "changed".
      const baseRemote = await resolvePrBaseRemote(originalWorkdir, targetRepo, pushRemote);
      const hookCheckBase = openPrToUpdate ? existingPrBase(openPrToUpdate) : baseBranch;
      /** Undefined when `branch` may be pushed; else the answer (the user was asked). */
      const refuseHookChanges = async (branch: string): Promise<AgentPrExecuteResult | undefined> => {
        let decisionRequested = false;
        const refusal = await refuseHookChangesWithoutUser({
          sessionManager: sm,
          toolCallId: _id,
          sessionRef: decisionRef,
          decisionRef: () => worktreeDecisionRef(sm, target),
          repoDir: originalWorkdir,
          branchName: branch,
          baseBranch: hookCheckBase,
          remote: baseRemote,
          preferRemoteBase: targetRepo !== undefined || pushRemote !== "origin",
          hookCheckUnavailable: baseRemote === undefined,
          action: "pr",
          onDecisionRequested: () => { decisionRequested = true; },
        });
        if (!refusal) return undefined;
        return { ...(typeof refusal === "string" ? { content: [{ type: "text", text: refusal }] } : refusal), meta: { success: false, state: "error", ...(decisionRequested ? { decisionRequested: true } : {}) } } satisfies AgentPrExecuteResult;
      };
      // A PR the session recorded may be headed by another branch (a follow-up
      // session of that PR). The branch whose commits go into it is chosen
      // here, read-only, so that it is checked before any branch is moved.
      const recordedOpenPr = openPrToUpdate && !targetFoundByBranch ? openPrToUpdate : undefined;
      const sourceBranch = recordedOpenPr
        ? await resolveExistingTargetPrUpdateSourceBranch({ repoDir: originalWorkdir, fallbackBranch: branchName, targetPrStatus: recordedOpenPr })
        : branchName;
      const sourceRefusal = await refuseHookChanges(sourceBranch);
      if (sourceRefusal) return sourceRefusal;
      const changedAfterHookCheck = await revalidatePrTarget();
      if (changedAfterHookCheck) return changedAfterHookCheck;

      // ---- 4. Local branch movement (the checked branch fast-forwarded into
      // the PR's head branch), policy, then the push.
      let targetBranchAlreadyRepresented = false;
      if (recordedOpenPr) {
        const branchResolution = await resolveExistingTargetPrUpdateBranch({
          repoDir: originalWorkdir,
          sourceBranch,
          targetPrStatus: recordedOpenPr,
          remote: pushRemote,
        });
        if ("error" in branchResolution) {
          return {
            content: [{ type: "text", text: `Error: ${branchResolution.error}` }],
            meta: { success: false, state: "error" },
          } satisfies AgentPrExecuteResult;
        }
        branchName = branchResolution.branchName;
        targetBranchAlreadyRepresented = branchResolution.alreadyRepresented;
      }
      // ---- 5. The push. Every path that reaches this line updates an open PR
      // or opens a new one. The branch pushed is the branch checked: when the
      // PR's head branch is pushed instead of the one checked in step 3 (it
      // may hold commits of its own), it is checked first.
      if (!targetBranchAlreadyRepresented && branchName !== sourceBranch) {
        const pushedBranchRefusal = await refuseHookChanges(branchName);
        if (pushedBranchRefusal) return pushedBranchRefusal;
      }
      const changedBeforePush = await revalidatePrTarget();
      if (changedBeforePush) return changedBeforePush;
      if (!targetBranchAlreadyRepresented && !(await pushBranch(originalWorkdir, branchName, pushRemote))) {
        return { content: [{ type: "text", text: `❌ Failed to push \`${branchName}\` — cannot create/update PR` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }

      // Sync PR state from GitHub
      const afterPush = targetPrUrl && !supersededMergedPrUrl
        ? await syncWorktreePRByUrl(originalWorkdir, targetPrUrl, targetRepo, pushRemote)
        : await syncWorktreePR(originalWorkdir, branchName, targetRepo, baseBranch, { preferOpen: true, pushRemote });
      if (afterPush.lookupFailed) {
        return {
          content: [{ type: "text", text: `❌ PR not created or updated: \`${branchName}\` was pushed, but existing pull requests could not be checked: ${afterPush.lookupFailed}` }],
          meta: { success: false, state: "error" },
        };
      }
      const syncedPrStatus = normalizeForceNewReplacementPrStatus(afterPush, explicitTargetPrStatus, { forceNewIgnoresClosedTargetPr });
      // force_new replaces a PR that was closed without merging, whether the
      // session recorded it or it was found by branch: GitHub accepts a new PR
      // from the same branch.
      // The same holds for a merged PR that has commits made after its merge.
      const prStatus: PRStatus = (params.force_new && syncedPrStatus.exists && syncedPrStatus.state === "closed")
        || (supersededMergedPrUrl !== undefined && syncedPrStatus.exists && syncedPrStatus.state === "merged" && syncedPrStatus.url === supersededMergedPrUrl)
        ? { exists: false, state: "none" }
        : syncedPrStatus;

      // Handle force_new parameter
      if (params.force_new && prStatus.exists) return forceNewRefusal(prStatus, targetPrUrl === undefined);

      // PR Lifecycle Handling
      if (prStatus.exists && prStatus.state === "open") {
        // Case: Open PR exists. Its own base is the base for counts, comments,
        // detail lines and the recorded lifecycle.
        const openPrBase = existingPrBase(prStatus);
        const diffSummary = await getDiffSummary(originalWorkdir, branchName, openPrBase);
        const metadataRefresh = await refreshOpenPrMetadata({
          repoDir: originalWorkdir,
          prStatus,
          targetRepo,
          sessionName,
          branchName,
          prompt: target.prompt,
          outputPreview: target.outputPreview,
          diffSummary,
          explicitTitle: params.title,
          explicitBody: params.body,
          forceRefresh: params.update_metadata === true,
          metadataProvider,
        });

        if (diffSummary && diffSummary.commits > 0) {
          // New commits pushed — add detailed comment
          const commitList = diffSummary.commitMessages
            .slice(0, 5)
            .map((c) => `• ${c.hash} ${c.message} (${c.author})`)
            .join("\n");
          const moreCommits = diffSummary.commits > 5 ? `\n...and ${formatCount(diffSummary.commits - 5, "more commit")}` : "";

          const commentBody = [
            `🔄 **New commits pushed**`,
            ``,
            `${formatCount(diffSummary.commits, "new commit")} (+${diffSummary.insertions} / -${diffSummary.deletions})`,
            ``,
            `### Latest commits:`,
            commitList + moreCommits,
            ``,
            `---`,
            `🤖 [openclaw-code-agent](https://github.com/goldmar/openclaw-code-agent)`,
          ].join("\n");

          const commented = await commentOnPR(originalWorkdir, prStatus.number!, commentBody, targetRepo);

          // The push succeeded and the PR exists, with or without the comment:
          // record it as open so state, buttons and the owed `✅` agree.
          const commentFailedLine = commented ? "" : "\n⚠️ The PR comment could not be added.";
          const resolvesDeferredCompletion = owedCompletionCycle(sm, target.generation) !== undefined;
          persistPrOpen({ prBase: openPrBase, prUrl: prStatus.url, prNumber: prStatus.number, targetRepo });
          const updateOutcomeLine = formatWorktreeOutcomeLine({
            kind: "pr-updated",
            sessionCompleted: isTerminalCompletion() || resolvesDeferredCompletion,
            sessionName,
            branch: branchName,
            prUrl: prStatus.url,
            filesChanged: diffSummary.filesChanged,
            insertions: diffSummary.insertions,
            deletions: diffSummary.deletions,
          });
          sm.notifyWorktreeOutcome(
            target.notificationTarget!,
            withOutcomeSummary(`${updateOutcomeLine}${commentFailedLine}`, params.summary),
            {
              ...summaryOwnership(params.summary),
              completionWakeOutcomeKey: buildPrCompletionWakeOutcomeKey({
                action: "updated",
                branchName,
                prUrl: prStatus.url,
                prNumber: prStatus.number,
                targetRepo,
                diffSummary,
              }),
              detailLines: buildPrOutcomeDetailLines({
                action: "updated",
                branchName,
                baseBranch: openPrBase,
                prUrl: prStatus.url,
                prNumber: prStatus.number,
                targetRepo,
                commits: diffSummary.commits,
                insertions: diffSummary.insertions,
                deletions: diffSummary.deletions,
              }),
            },
          );
          return {
            content: [{
              type: "text",
              text: [
                `${updateOutcomeLine}${commentFailedLine}`,
                ``,
                commented
                  ? `📝 Added comment detailing ${formatCount(diffSummary.commits, "new commit")} (+${diffSummary.insertions} / -${diffSummary.deletions})`
                  : `${formatCount(diffSummary.commits, "new commit")} pushed (+${diffSummary.insertions} / -${diffSummary.deletions})`,
                formatMetadataRefreshLine(metadataRefresh),
                summaryShownNote(params.summary).trim(),
              ].filter(Boolean).join("\n"),
            }],
            meta: { success: true, state: "pr_updated", outcomeNotified: true },
          } satisfies AgentPrExecuteResult;
        } else {
          // No new commits
          const owedCycle = owedCompletionCycle(sm, target.generation);
          persistPrOpen({ prBase: openPrBase, prUrl: prStatus.url, prNumber: prStatus.number, targetRepo });
          const upToDateLine = settledPrLine("PR is up to date", prStatus.url!, owedCycle);
          const metadataRefreshLine = formatMetadataRefreshLine(metadataRefresh);
          return {
            content: [{
              type: "text",
              text: `${upToDateLine}\n\n` +
                    `No new commits to push.` +
                    `${metadataRefreshLine ? `\n${metadataRefreshLine}` : ""}` +
                    (owedCycle === undefined ? "" : summaryShownNote(params.summary))
            }],
            meta: { success: true, state: "pr_open", ...(owedCycle === undefined ? {} : { outcomeNotified: true }) },
          } satisfies AgentPrExecuteResult;
        }
      } else if (prStatus.exists && prStatus.state === "merged") {
        // Merged between the look-up and now.
        return settleMerged(prStatus);
      } else if (prStatus.exists && prStatus.state === "closed") {
        return answerClosed(prStatus);
      } else {
        // Case: No PR exists — create new PR
        if (repoPolicy?.policy === "never-pr") {
          return { content: [{ type: "text", text: `Error: Repo policy forbids PR creation for ${repoPolicy.identity?.repoRoot ?? originalWorkdir}.` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
        }
        const diffSummary = (!params.title || !params.body)
          ? await getDiffSummary(originalWorkdir, branchName, baseBranch)
          : undefined;
        let generatedMetadata: PrMetadata | undefined;
        if (!params.title || !params.body) {
          const metadataResult = await buildPrMetadata({
            sessionName,
            branchName,
            prompt: target.prompt,
            outputPreview: target.outputPreview,
            diffSummary,
            provider: metadataProvider,
          });
          if (metadataResult.ok === false) {
            return {
              content: [{ type: "text", text: `❌ ${metadataResult.error}` }],
              meta: { success: false, state: "error" },
            } satisfies AgentPrExecuteResult;
          }
          generatedMetadata = metadataResult.metadata;
        }

        const prTitle = params.title ?? generatedMetadata!.title;
        let prBody = params.body;

        if (!prBody) {
          prBody = formatPrBody({
            sessionName,
            metadata: generatedMetadata!,
            diffSummary,
          });
        }

        // Open the PR after title/body generation is complete.
        const prResult = await createPR(originalWorkdir, branchName, baseBranch, prTitle, prBody, targetRepo, { draft: true, pushRemote });

        if (prResult.success && prResult.prUrl) {
          // Sync again to get PR number
          const newPrStatus = await syncWorktreePR(originalWorkdir, branchName, targetRepo, baseBranch, { pushRemote });

          // Persist PR URL and number
          const resolvesDeferredCompletion = owedCompletionCycle(sm, target.generation) !== undefined;
          persistPrOpen({
            prUrl: prResult.prUrl,
            prNumber: newPrStatus.number,
            targetRepo,
            disposition: "pr-opened",
          });

          // Notify via unified outcome pipeline
          const outcomeLine = formatWorktreeOutcomeLine({
            kind: "pr-opened",
            sessionCompleted: isTerminalCompletion() || resolvesDeferredCompletion,
            sessionName,
            branch: branchName,
            targetRepo,
            prUrl: prResult.prUrl,
          });
          sm.notifyWorktreeOutcome(
            target.notificationTarget!,
            withOutcomeSummary(outcomeLine, params.summary),
            {
              ...summaryOwnership(params.summary),
              completionWakeOutcomeKey: buildPrCompletionWakeOutcomeKey({
                action: "opened",
                branchName,
                prUrl: prResult.prUrl,
                prNumber: newPrStatus.number,
                targetRepo,
              }),
              detailLines: buildPrOutcomeDetailLines({
                action: "opened",
                branchName,
                baseBranch,
                prUrl: prResult.prUrl,
                prNumber: newPrStatus.number,
                targetRepo,
              }),
            },
          );

          // If we had to fall back from draft, append a visible note
          const finalText = (prResult.warnings && prResult.warnings.length > 0
            ? `${outcomeLine}\n\n\u26a0\ufe0f ${prResult.warnings.join("; ")}`
            : outcomeLine) + summaryShownNote(params.summary);

          return { content: [{ type: "text", text: finalText }], meta: { success: true, state: "created", outcomeNotified: true } } satisfies AgentPrExecuteResult;
        } else {
          return { content: [{ type: "text", text: `❌ Failed to create PR: ${prResult.error ?? "unknown error"}` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
        }
      }
    },
  };
}
