import { Type } from "../tool-schema";
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext, PersistedSessionInfo } from "../types";
import type { DiffSummary, PRStatus } from "../worktree";
import { getDiffSummary, createPR, pushBranch, isGitHubCLIAvailable, detectDefaultBranch, syncWorktreePR, syncWorktreePRByUrl, commentOnPR, resolveTargetRepo, formatWorktreeOutcomeLine, branchExists, isBranchAncestorOfBase, getBranchName, getPRBody, updatePRBody } from "../worktree";
import { buildPrMetadata, createRuntimePrMetadataProvider, formatPrBody, isOcaGeneratedPrBody } from "../worktree-pr-metadata";
import type { PrMetadata, PrMetadataProvider } from "../worktree-pr-metadata";
import { buildMergedPatch, buildPrOpenPatch } from "../worktree-session-patches";
import { getPersistedTargetMutationRefs, resolveWorktreeToolTarget } from "./worktree-tool-context";

export { buildPrMetadata, createRuntimePrMetadataProvider, formatPrBody, isOcaGeneratedPrBody } from "../worktree-pr-metadata";
export type { PrMetadata, PrMetadataEvidence, PrMetadataProvider, PrMetadataResult } from "../worktree-pr-metadata";

interface AgentPrParams {
  session: string;
  title?: string;
  body?: string;
  update_body?: boolean;
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

function fetchRemoteBranch(repoDir: string, branch: string, remote = "origin"): string | undefined {
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  try {
    execFileSync(
      "git",
      ["-C", repoDir, "fetch", remote, `${branch}:${remoteRef}`],
      { timeout: 30_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    execFileSync(
      "git",
      ["-C", repoDir, "rev-parse", "--verify", remoteRef],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return remoteRef;
  } catch {
    return undefined;
  }
}

function getWorktreePathForBranch(repoDir: string, branch: string): string | undefined {
  try {
    const result = execFileSync(
      "git",
      ["-C", repoDir, "worktree", "list", "--porcelain"],
      { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    let worktreePath: string | undefined;
    for (const line of result.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length);
        continue;
      }
      if (line === `branch refs/heads/${branch}`) {
        return worktreePath;
      }
      if (line === "") {
        worktreePath = undefined;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function moveBranchFastForward(repoDir: string, targetBranch: string, sourceRef: string): ExistingTargetPrBranchResolution {
  try {
    const targetWorktreePath = getWorktreePathForBranch(repoDir, targetBranch);
    if (targetWorktreePath) {
      execFileSync(
        "git",
        ["-C", targetWorktreePath, "merge", "--ff-only", sourceRef],
        { timeout: 30_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      return { success: true, branchName: targetBranch, alreadyRepresented: false };
    }

    const currentBranch = getBranchName(repoDir);
    if (currentBranch === targetBranch) {
      execFileSync(
        "git",
        ["-C", repoDir, "merge", "--ff-only", sourceRef],
        { timeout: 30_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
    } else {
      execFileSync(
        "git",
        ["-C", repoDir, "branch", "-f", targetBranch, sourceRef],
        { timeout: 10_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
    }
    return { success: true, branchName: targetBranch, alreadyRepresented: false };
  } catch (err) {
    return {
      success: false,
      error: `Failed to fast-forward existing PR branch ${targetBranch} from ${sourceRef}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function resolveExistingTargetPrUpdateBranch(args: {
  repoDir: string;
  sourceBranch: string;
  targetPrStatus: PRStatus;
}): ExistingTargetPrBranchResolution {
  const { repoDir, sourceBranch, targetPrStatus } = args;
  if (!targetPrStatus.exists || targetPrStatus.state !== "open" || !targetPrStatus.headRefName) {
    return { success: false, error: "Target PR is not an open PR with a resolvable head branch." };
  }

  const targetBranch = targetPrStatus.headRefName;
  if (targetBranch === sourceBranch) {
    return { success: true, branchName: sourceBranch, alreadyRepresented: false };
  }
  const remoteTargetRef = fetchRemoteBranch(repoDir, targetBranch);
  const authoritativeTargetRef = remoteTargetRef ?? targetBranch;
  if (!branchExists(repoDir, targetBranch) && !remoteTargetRef) {
    return { success: false, error: `Target PR branch ${targetBranch} is not available locally. Fetch it before updating the PR.` };
  }
  if (isBranchAncestorOfBase(repoDir, sourceBranch, authoritativeTargetRef)) {
    if (remoteTargetRef && !isBranchAncestorOfBase(repoDir, remoteTargetRef, targetBranch)) {
      const synced = moveBranchFastForward(repoDir, targetBranch, remoteTargetRef);
      if ("error" in synced) return synced;
    }
    return { success: true, branchName: targetBranch, alreadyRepresented: true };
  }
  if (!isBranchAncestorOfBase(repoDir, authoritativeTargetRef, sourceBranch)) {
    return {
      success: false,
      error: `Refusing to create a sibling PR: target PR branch ${targetBranch} and follow-up branch ${sourceBranch} have diverged. Reconcile them manually, then run agent_pr again.`,
    };
  }

  return moveBranchFastForward(repoDir, targetBranch, sourceBranch);
}

export function resolveExistingTargetPrUpdateSourceBranch(args: {
  repoDir: string;
  fallbackBranch: string;
  targetPrStatus: PRStatus;
}): string {
  const targetBranch = args.targetPrStatus.headRefName;
  if (!targetBranch || targetBranch === args.fallbackBranch) {
    return args.fallbackBranch;
  }

  const currentBranch = getBranchName(args.repoDir);
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

type BodyRefreshResult =
  | { status: "updated"; reason: "explicit" | "generated" | "forced" }
  | { status: "skipped"; reason: "missing-pr-identity" | "human-edited" | "empty-body" | "unchanged" }
  | { status: "failed"; reason: string };

async function refreshOpenPrBody(args: {
  repoDir: string;
  prStatus: PRStatus;
  targetRepo?: string;
  sessionName: string;
  branchName?: string;
  prompt?: string;
  diffSummary?: DiffSummary;
  explicitBody?: string;
  forceRefresh: boolean;
  metadataProvider?: PrMetadataProvider;
}): Promise<BodyRefreshResult> {
  const prIdentity = args.prStatus.number ?? args.prStatus.url;
  if (!prIdentity) return { status: "skipped", reason: "missing-pr-identity" };

  if (args.explicitBody !== undefined) {
    const updated = updatePRBody(args.repoDir, prIdentity, args.explicitBody, args.targetRepo);
    return updated
      ? { status: "updated", reason: "explicit" }
      : { status: "failed", reason: "failed to update explicit PR body" };
  }

  const currentBody = getPRBody(args.repoDir, prIdentity, args.targetRepo);
  if (!currentBody) return { status: "skipped", reason: "empty-body" };

  const replaceable = args.forceRefresh || isOcaGeneratedPrBody(currentBody);
  if (!replaceable) return { status: "skipped", reason: "human-edited" };

  const metadataResult = await buildPrMetadata({
    sessionName: args.sessionName,
    branchName: args.branchName,
    prompt: args.prompt,
    diffSummary: args.diffSummary,
    provider: args.metadataProvider,
  });
  if (metadataResult.ok === false) {
    return { status: "failed", reason: metadataResult.error };
  }

  const nextBody = formatPrBody({
    sessionName: args.sessionName,
    metadata: metadataResult.metadata,
    diffSummary: args.diffSummary,
  });
  if (nextBody.trim() === currentBody.trim()) return { status: "skipped", reason: "unchanged" };

  const updated = updatePRBody(args.repoDir, prIdentity, nextBody, args.targetRepo);
  if (!updated) return { status: "failed", reason: "failed to update generated PR body" };
  return { status: "updated", reason: args.forceRefresh ? "forced" : "generated" };
}

function formatBodyRefreshLine(result: BodyRefreshResult): string | undefined {
  if (result.status === "updated") {
    return result.reason === "explicit"
      ? "📝 Replaced PR body with the explicitly provided body."
      : "📝 Refreshed PR body from current OpenClaw metadata.";
  }
  if (result.status === "failed") {
    return `⚠️  PR body refresh skipped: ${result.reason}`;
  }
  return undefined;
}

/** Register the `agent_pr` tool factory. */
export function makeAgentPrTool(_ctx?: OpenClawPluginToolContext, options: { metadataProvider?: PrMetadataProvider } = {}) {
  return {
    name: "agent_pr",
    description: "Create or update a GitHub PR for a worktree branch. Handles full PR lifecycle: creates new PRs, updates existing open PRs with comments, and handles merged/closed PRs. Pushes the branch, syncs PR state, and persists metadata.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to create/update PR for" }),
      title: Type.Optional(Type.String({ description: "PR title (default: auto-generated from session name)" })),
      body: Type.Optional(Type.String({ description: "PR body (default: auto-generated from commit summary). For existing open PRs, passing body explicitly replaces the PR body." })),
      update_body: Type.Optional(Type.Boolean({ description: "For existing open PRs, refresh the PR body when true. Default: only refresh bodies that are clearly OpenClaw-generated/fallback, or when body is explicitly provided." })),
      base_branch: Type.Optional(Type.String({ description: "Base branch for the PR (default: detected from repo)" })),
      force_new: Type.Optional(Type.Boolean({ description: "Force creation of a new PR even if one exists (default: false)" })),
      target_repo: Type.Optional(Type.String({ description: "Target repository for cross-repo PRs (e.g. 'openai/codex'). Auto-detected from 'upstream' remote if not set." })),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }
      if (!isAgentPrParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { session, title?, body?, update_body?, base_branch?, force_new? }." }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }

      // Check if gh CLI is available
      if (!isGitHubCLIAvailable()) {
        return { content: [{ type: "text", text: "Error: GitHub CLI (gh) is not available. Install it and authenticate to create PRs." }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }

      // Resolve session (active or persisted)
      const target = resolveWorktreeToolTarget(sessionManager, params.session);
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
        console.info(`[agent_pr] Worktree directory ${worktreePath} no longer exists; proceeding with branch "${branchName}" via originalWorkdir (${originalWorkdir})`);
      }

      const baseBranch = params.base_branch ?? detectDefaultBranch(originalWorkdir);
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
          sessionManager.updatePersistedSession(mutationRef, patch);
        }
      };

      // Resolve target repository for cross-repo PRs
      const targetRepo = resolveTargetRepo(originalWorkdir, params.target_repo ?? persistedSession?.worktreePrTargetRepo);
      const explicitTargetPrUrl = persistedSession?.worktreePrUrl ?? targetSession?.worktreePrUrl;
      const explicitTargetPrStatus = explicitTargetPrUrl
        ? syncWorktreePRByUrl(originalWorkdir, explicitTargetPrUrl, targetRepo)
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
      const effectiveTargetPrStatus = forceNewIgnoresClosedTargetPr ? undefined : explicitTargetPrStatus;
      if (effectiveTargetPrStatus?.exists && effectiveTargetPrStatus.state === "open") {
        const sourceBranch = resolveExistingTargetPrUpdateSourceBranch({
          repoDir: originalWorkdir,
          fallbackBranch: branchName,
          targetPrStatus: effectiveTargetPrStatus,
        });
        const branchResolution = resolveExistingTargetPrUpdateBranch({
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
      }
      const repoPolicy = sessionManager.resolveRepoPolicy(originalWorkdir);
      const existingPrBeforePush = normalizeForceNewReplacementPrStatus(
        effectiveTargetPrStatus?.exists
          ? effectiveTargetPrStatus
          : syncWorktreePR(originalWorkdir, branchName, targetRepo),
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
      if (shouldPushBranch && !pushBranch(originalWorkdir, branchName)) {
        return { content: [{ type: "text", text: `❌ Failed to push ${branchName} — cannot create/update PR` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }

      // Sync PR state from GitHub
      const prStatus = normalizeForceNewReplacementPrStatus(
        effectiveTargetPrUrl
          ? syncWorktreePRByUrl(originalWorkdir, effectiveTargetPrUrl, targetRepo)
          : syncWorktreePR(originalWorkdir, branchName, targetRepo),
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
        const diffSummary = getDiffSummary(originalWorkdir, branchName, baseBranch);
        const bodyRefresh = await refreshOpenPrBody({
          repoDir: originalWorkdir,
          prStatus,
          targetRepo,
          sessionName,
          branchName,
          prompt: target.prompt,
          diffSummary,
          explicitBody: params.body,
          forceRefresh: params.update_body === true,
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

          const commented = commentOnPR(originalWorkdir, prStatus.number!, commentBody, targetRepo);

          if (commented) {
            // Update persisted metadata
            persistPrOpen({ prUrl: prStatus.url, prNumber: prStatus.number, targetRepo });
            const updateOutcomeLine = formatWorktreeOutcomeLine({
              kind: "pr-updated",
              branch: branchName,
              prUrl: prStatus.url,
              filesChanged: diffSummary.filesChanged,
              insertions: diffSummary.insertions,
              deletions: diffSummary.deletions,
            });
            sessionManager.notifyWorktreeOutcome(
              target.notificationTarget!,
              updateOutcomeLine,
              {
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
                  formatBodyRefreshLine(bodyRefresh),
                ].filter(Boolean).join("\n"),
              }],
              meta: { success: true, state: "pr_updated" },
            } satisfies AgentPrExecuteResult;
          } else {
            const bodyRefreshLine = formatBodyRefreshLine(bodyRefresh);
            return {
              content: [{
                type: "text",
                text: `⚠️  Pushed to ${prStatus.url} but failed to add comment.\n\n` +
                      `${diffSummary.commits} new commits (+${diffSummary.insertions} / -${diffSummary.deletions})` +
                      `${bodyRefreshLine ? `\n${bodyRefreshLine}` : ""}`
              }],
              meta: { success: true, state: "pr_open" },
            } satisfies AgentPrExecuteResult;
          }
        } else {
          // No new commits
          persistPrOpen({ prUrl: prStatus.url, prNumber: prStatus.number, targetRepo });
          const bodyRefreshLine = formatBodyRefreshLine(bodyRefresh);
          return {
            content: [{
              type: "text",
              text: `ℹ️  PR already exists and is up to date: ${prStatus.url}\n\n` +
                    `No new commits to push.` +
                    `${bodyRefreshLine ? `\n${bodyRefreshLine}` : ""}`
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
          sessionManager.updatePersistedSession(mutationRef, mergedPatch);
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
          ? getDiffSummary(originalWorkdir, branchName, baseBranch)
          : undefined;
        let generatedMetadata: PrMetadata | undefined;
        if (!params.title || !params.body) {
          const metadataResult = await buildPrMetadata({
            sessionName,
            branchName,
            prompt: target.prompt,
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
        const prResult = createPR(originalWorkdir, branchName, baseBranch, prTitle, prBody, targetRepo, { draft: true });

        if (prResult.success && prResult.prUrl) {
          // Sync again to get PR number
          const newPrStatus = syncWorktreePR(originalWorkdir, branchName, targetRepo);

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
            branch: branchName,
            targetRepo,
            prUrl: prResult.prUrl,
          });
          sessionManager.notifyWorktreeOutcome(
            target.notificationTarget!,
            outcomeLine,
            {
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
