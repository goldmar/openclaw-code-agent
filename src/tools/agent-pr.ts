import { assertBranchName, assertBranchOrRemoteTrackingRef, branchNameValidationError, localBranchRef } from "../worktree-ref-validation";
import { repoHookGitArgs } from "../git-hooks";
import { Type } from "../tool-parameter-schema";
import { runGit, withRepoLock } from "../git-exec";
import { existsSync } from "fs";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext, PersistedSessionInfo } from "../types";
import type { DiffSummary, PRBodyReadResult, PRStatus } from "../worktree";
import { getDiffSummary, createPR, pushBranch, isGitHubCLIAvailable, detectDefaultBranch, syncWorktreePR, syncWorktreePRByUrl, commentOnPR, resolveTargetRepo, formatWorktreeOutcomeLine, branchExists, isBranchAncestorOfBase, getBranchName, getCheckoutPathForBranch, getPRBody, updatePRBody, updatePRTitle, fetchRemoteBranchRef } from "../worktree";
import { buildPrMetadata, createRuntimePrMetadataProvider, formatPrBody, isOcaFallbackPrBody, isOcaGeneratedPrBody, isOcaGeneratedPrTitle } from "../worktree-pr-metadata";
import type { PrMetadata, PrMetadataProvider } from "../worktree-pr-metadata";
import { buildMergedPatch, buildPrOpenPatch } from "../worktree-session-patches";
import { getPersistedTargetMutationRefs, refuseHookChangesWithoutUser, resolveWorktreeToolTarget, summaryOwnership, withOutcomeSummary } from "./worktree-tool-context";
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
      | "created";
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
  return forceNew === true && prStatus?.exists === true && prStatus.state !== "open";
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
}): Promise<ExistingTargetPrBranchResolution> {
  return withRepoLock(args.repoDir, () => resolveExistingTargetPrUpdateBranchLocked(args));
}

async function resolveExistingTargetPrUpdateBranchLocked(args: {
  repoDir: string;
  sourceBranch: string;
  targetPrStatus: PRStatus;
}): Promise<ExistingTargetPrBranchResolution> {
  const { repoDir, sourceBranch, targetPrStatus } = args;
  await assertBranchName(sourceBranch);
  if (!targetPrStatus.exists || targetPrStatus.state !== "open" || !targetPrStatus.headRefName) {
    return { success: false, error: "Target PR is not an open PR with a resolvable head branch." };
  }

  const targetBranch = targetPrStatus.headRefName;
  await assertBranchName(targetBranch);
  const remoteTargetRef = await fetchRemoteBranchRef(repoDir, targetBranch);
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
}): Promise<PRStatus | undefined> {
  const parentBranch = await getBranchName(args.repoDir);
  if (!parentBranch || parentBranch !== args.expectedParentBranch || parentBranch === args.worktreeBranch || parentBranch === args.baseBranch) return undefined;
  const status = await syncWorktreePR(args.repoDir, parentBranch, args.targetRepo);
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
      ? [`Pushed ${args.commits} new commits (+${args.insertions ?? 0}/-${args.deletions ?? 0}).`]
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
    return `⚠️  PR metadata refresh failed: ${result.reason}`;
  }
  return undefined;
}

/** Register the `agent_pr` tool factory. */
export function makeAgentPrTool(_ctx?: OpenClawPluginToolContext, options: { metadataProvider?: PrMetadataProvider } = {}) {
  return {
    name: "agent_pr",
    description: "Push a worktree branch and open a GitHub PR, or update the session's open PR (push plus a comment listing new commits). Posts the outcome to the user.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID" }),
      title: Type.Optional(Type.String({ description: "Default: generated" })),
      body: Type.Optional(Type.String({ description: "Default: generated. On an open PR, replaces the body." })),
      update_metadata: Type.Optional(Type.Boolean({ description: "Open PR: regenerate title and body (default: only OCA-generated ones)" })),
      base_branch: Type.Optional(Type.String({ description: "Default: detected" })),
      force_new: Type.Optional(Type.Boolean({ description: "Fail instead of updating an existing PR" })),
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

      // Check if gh CLI is available
      if (!(await isGitHubCLIAvailable())) {
        return { content: [{ type: "text", text: "Error: GitHub CLI (gh) is not available. Install it and authenticate to create PRs." }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }

      // Resolve session (active or persisted)
      const target = resolveWorktreeToolTarget(sm, params.session);
      const targetSession = target.activeSession;
      const persistedSession = target.persistedSession;

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

      const baseBranch = params.base_branch ?? await detectDefaultBranch(originalWorkdir);
      const hookRefusal = await refuseHookChangesWithoutUser({
        sessionManager: sm,
        toolCallId: _id,
        sessionRef: params.session,
        repoDir: originalWorkdir,
        branchName,
        baseBranch,
        action: "pr",
      });
      if (hookRefusal) {
        return { content: [{ type: "text", text: hookRefusal }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }
      const metadataProvider = options.metadataProvider ?? createRuntimePrMetadataProvider();
      const persistPrOpen = (args: {
        prUrl: string;
        prNumber?: number;
        targetRepo?: string;
        disposition?: "pr-opened";
      }) => {
        const patch = buildPrOpenPatch(
          {
            worktreeBaseBranch: persistedSession?.worktreeBaseBranch ?? targetSession?.worktreeBaseBranch ?? baseBranch,
            worktreePrTargetRepo: persistedSession?.worktreePrTargetRepo ?? targetSession?.worktreePrTargetRepo,
            worktreePushRemote: persistedSession?.worktreePushRemote ?? targetSession?.worktreePushRemote,
          },
          {
            prUrl: args.prUrl,
            prNumber: args.prNumber,
            baseBranch,
            targetRepo: args.targetRepo,
            disposition: args.disposition,
          },
        );
        for (const mutationRef of getPersistedTargetMutationRefs(target)) {
          sm.updatePersistedSession(mutationRef, patch);
        }
      };

      // Resolve target repository for cross-repo PRs
      const targetRepo = await resolveTargetRepo(originalWorkdir, params.target_repo ?? persistedSession?.worktreePrTargetRepo);
      const explicitTargetPrUrl = persistedSession?.worktreePrUrl ?? targetSession?.worktreePrUrl;
      const explicitTargetPrStatus = explicitTargetPrUrl
        ? await syncWorktreePRByUrl(originalWorkdir, explicitTargetPrUrl, targetRepo)
        : undefined;
      if (explicitTargetPrUrl && !explicitTargetPrStatus?.exists) {
        return {
          content: [{
            type: "text",
            text: `Error: Session is associated with ${explicitTargetPrUrl}, but that PR could not be resolved. Refusing to create a sibling PR from ${branchName}.`,
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
          })
        : undefined;
      const effectiveTargetPrStatus = forceNewIgnoresClosedTargetPr
        ? undefined
        : (explicitTargetPrStatus ?? discoveredTargetPrStatus);
      const resolvedTargetPrUrl = effectiveTargetPrUrl ?? discoveredTargetPrStatus?.url;
      let targetBranchAlreadyRepresented = false;
      if (effectiveTargetPrStatus?.exists && effectiveTargetPrStatus.state === "open") {
        const sourceBranch = await resolveExistingTargetPrUpdateSourceBranch({
          repoDir: originalWorkdir,
          fallbackBranch: branchName,
          targetPrStatus: effectiveTargetPrStatus,
        });
        const branchResolution = await resolveExistingTargetPrUpdateBranch({
          repoDir: originalWorkdir,
          sourceBranch,
          targetPrStatus: effectiveTargetPrStatus,
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
      const repoPolicy = await sm.resolveRepoPolicy(originalWorkdir);
      const existingPrBeforePush = normalizeForceNewReplacementPrStatus(
        effectiveTargetPrStatus?.exists
          ? effectiveTargetPrStatus
          : await syncWorktreePR(originalWorkdir, branchName, targetRepo),
        explicitTargetPrStatus,
        { forceNewIgnoresClosedTargetPr },
      );
      const updatingExistingOpenPr = existingPrBeforePush.exists && existingPrBeforePush.state === "open";
      if (repoPolicy?.policy === "never-pr" && !updatingExistingOpenPr) {
        return { content: [{ type: "text", text: `Error: Repo policy forbids PR creation for ${repoPolicy.identity?.repoRoot ?? originalWorkdir}.` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }
      if (repoPolicy && !repoPolicy.prAvailable) {
        return { content: [{ type: "text", text: `Error: PR automation is unavailable for ${repoPolicy.identity?.repoRoot ?? originalWorkdir}. Provider: ${repoPolicy.provider}.` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }

      // Push branch first for open PR updates and new PR creation.
      const shouldPushBranch = !effectiveTargetPrStatus || effectiveTargetPrStatus.state === "open";
      if (shouldPushBranch && !targetBranchAlreadyRepresented && !(await pushBranch(originalWorkdir, branchName))) {
        return { content: [{ type: "text", text: `❌ Failed to push ${branchName} — cannot create/update PR` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }

      // Sync PR state from GitHub
      const prStatus = normalizeForceNewReplacementPrStatus(
        resolvedTargetPrUrl
          ? await syncWorktreePRByUrl(originalWorkdir, resolvedTargetPrUrl, targetRepo)
          : await syncWorktreePR(originalWorkdir, branchName, targetRepo),
        explicitTargetPrStatus,
        { forceNewIgnoresClosedTargetPr },
      );

      // Handle force_new parameter
      if (params.force_new && prStatus.exists) {
        return {
          content: [{
            type: "text",
            text: `⚠️  Cannot create new PR: A PR already exists for ${branchName} (${prStatus.state}).\n\n` +
                  `Existing PR: ${prStatus.url}\n\n` +
                  `To create a new PR, you must first close/merge the existing PR manually or use a different branch.`
          }],
          meta: { success: false, state: "error" },
        } satisfies AgentPrExecuteResult;
      }

      // PR Lifecycle Handling
      if (prStatus.exists && prStatus.state === "open") {
        // Case: Open PR exists
        const diffSummary = await getDiffSummary(originalWorkdir, branchName, baseBranch);
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
          const moreCommits = diffSummary.commits > 5 ? `\n...and ${diffSummary.commits - 5} more commits` : "";

          const commentBody = [
            `🔄 **New commits pushed**`,
            ``,
            `${diffSummary.commits} new commits (+${diffSummary.insertions} / -${diffSummary.deletions})`,
            ``,
            `### Latest commits:`,
            commitList + moreCommits,
            ``,
            `---`,
            `🤖 [openclaw-code-agent](https://github.com/goldmar/openclaw-code-agent)`,
          ].join("\n");

          const commented = await commentOnPR(originalWorkdir, prStatus.number!, commentBody, targetRepo);

          if (commented) {
            // Update persisted metadata
            persistPrOpen({ prUrl: prStatus.url, prNumber: prStatus.number, targetRepo });
            const updateOutcomeLine = formatWorktreeOutcomeLine({
              kind: "pr-updated",
              sessionName,
              branch: branchName,
              prUrl: prStatus.url,
              filesChanged: diffSummary.filesChanged,
              insertions: diffSummary.insertions,
              deletions: diffSummary.deletions,
            });
            sm.notifyWorktreeOutcome(
              target.notificationTarget!,
              withOutcomeSummary(updateOutcomeLine, params.summary),
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
                  baseBranch,
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
                  `${updateOutcomeLine}`,
                  ``,
                  `📝 Added comment detailing ${diffSummary.commits} new commits (+${diffSummary.insertions} / -${diffSummary.deletions})`,
                  formatMetadataRefreshLine(metadataRefresh),
                ].filter(Boolean).join("\n"),
              }],
              meta: { success: true, state: "pr_updated" },
            } satisfies AgentPrExecuteResult;
          } else {
            const metadataRefreshLine = formatMetadataRefreshLine(metadataRefresh);
            return {
              content: [{
                type: "text",
                text: `⚠️  Pushed to ${prStatus.url} but failed to add comment.\n\n` +
                      `${diffSummary.commits} new commits (+${diffSummary.insertions} / -${diffSummary.deletions})` +
                      `${metadataRefreshLine ? `\n${metadataRefreshLine}` : ""}`
              }],
              meta: { success: true, state: "pr_open" },
            } satisfies AgentPrExecuteResult;
          }
        } else {
          // No new commits
          persistPrOpen({ prUrl: prStatus.url, prNumber: prStatus.number, targetRepo });
          const metadataRefreshLine = formatMetadataRefreshLine(metadataRefresh);
          return {
            content: [{
              type: "text",
              text: `ℹ️  PR already exists and is up to date: ${prStatus.url}\n\n` +
                    `No new commits to push.` +
                    `${metadataRefreshLine ? `\n${metadataRefreshLine}` : ""}`
            }],
            meta: { success: true, state: "pr_open" },
          } satisfies AgentPrExecuteResult;
        }
      } else if (prStatus.exists && prStatus.state === "merged") {
        // Case: PR was merged
        const mergedPatch: Partial<PersistedSessionInfo> = {
          ...buildMergedPatch({
            worktreeBaseBranch: persistedSession?.worktreeBaseBranch ?? targetSession?.worktreeBaseBranch ?? baseBranch,
            worktreePrTargetRepo: persistedSession?.worktreePrTargetRepo ?? targetSession?.worktreePrTargetRepo,
            worktreePushRemote: persistedSession?.worktreePushRemote ?? targetSession?.worktreePushRemote,
          }, {
            resolutionSource: "agent_pr",
            clearResolverSessionId: true,
          }),
          worktreePrUrl: prStatus.url,
          worktreePrNumber: prStatus.number,
          worktreeDisposition: "merged",
          worktreeDecisionSnoozedUntil: undefined,
        };
        for (const mutationRef of getPersistedTargetMutationRefs(target)) {
          sm.updatePersistedSession(mutationRef, mergedPatch);
        }
        return {
          content: [{
            type: "text",
            text: `✅ PR was already merged: ${prStatus.url}\n\n` +
                  `The worktree branch ${branchName} can be cleaned up with agent_merge(delete_branch=true).`
          }],
          meta: { success: true, state: "merged" },
        } satisfies AgentPrExecuteResult;
      } else if (prStatus.exists && prStatus.state === "closed") {
        // Case: PR was closed without merging — ask user what to do
        return {
          content: [{
            type: "text",
            text: `⚠️  A PR exists but was closed without merging: ${prStatus.url}\n\n` +
                  `What would you like to do?\n\n` +
                  `1. Reopen the closed PR manually on GitHub, then call agent_pr() again to update it\n` +
                  `2. Close and delete the branch with agent_merge(delete_branch=true), then start a new session/worktree\n` +
                  `3. Manually delete the closed PR on GitHub, then call agent_pr(force_new=true) to create a fresh PR\n\n` +
                  `(This tool cannot automatically reopen or recreate PRs to avoid unintended actions.)`
          }],
          meta: { success: false, state: "closed" },
        } satisfies AgentPrExecuteResult;
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
        const prResult = await createPR(originalWorkdir, branchName, baseBranch, prTitle, prBody, targetRepo, { draft: true });

        if (prResult.success && prResult.prUrl) {
          // Sync again to get PR number
          const newPrStatus = await syncWorktreePR(originalWorkdir, branchName, targetRepo);

          // Persist PR URL and number
          persistPrOpen({
            prUrl: prResult.prUrl,
            prNumber: newPrStatus.number,
            targetRepo,
            disposition: "pr-opened",
          });

          // Notify via unified outcome pipeline
          const outcomeLine = formatWorktreeOutcomeLine({
            kind: "pr-opened",
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
          const finalText = prResult.warnings && prResult.warnings.length > 0
            ? `${outcomeLine}\n\n\u26a0\ufe0f  ${prResult.warnings.join("; ")}`
            : outcomeLine;

          return { content: [{ type: "text", text: finalText }], meta: { success: true, state: "created" } } satisfies AgentPrExecuteResult;
        } else {
          return { content: [{ type: "text", text: `❌ Failed to create PR: ${prResult.error ?? "unknown error"}` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
        }
      }
    },
  };
}
