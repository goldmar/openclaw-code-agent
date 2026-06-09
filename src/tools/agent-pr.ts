import { Type } from "../tool-schema";
import { existsSync } from "fs";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext, PersistedSessionInfo } from "../types";
import type { DiffSummary } from "../worktree";
import { getDiffSummary, createPR, pushBranch, isGitHubCLIAvailable, detectDefaultBranch, syncWorktreePR, commentOnPR, resolveTargetRepo, formatWorktreeOutcomeLine } from "../worktree";
import { buildPrMetadata, formatPrBody } from "../worktree-pr-metadata";
import type { PrMetadata, PrMetadataProvider } from "../worktree-pr-metadata";
import { buildMergedPatch, buildPrOpenPatch } from "../worktree-session-patches";
import { getPersistedTargetMutationRefs, resolveWorktreeToolTarget } from "./worktree-tool-context";

export { buildPrMetadata, formatPrBody } from "../worktree-pr-metadata";
export type { PrMetadata, PrMetadataEvidence, PrMetadataProvider, PrMetadataResult } from "../worktree-pr-metadata";

interface AgentPrParams {
  session: string;
  title?: string;
  body?: string;
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

/** Register the `agent_pr` tool factory. */
export function makeAgentPrTool(_ctx?: OpenClawPluginToolContext, options: { metadataProvider?: PrMetadataProvider } = {}) {
  return {
    name: "agent_pr",
    description: "Create or update a GitHub PR for a worktree branch. Handles full PR lifecycle: creates new PRs, updates existing open PRs with comments, and handles merged/closed PRs. Pushes the branch, syncs PR state, and persists metadata.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to create/update PR for" }),
      title: Type.Optional(Type.String({ description: "PR title (default: auto-generated from session name)" })),
      body: Type.Optional(Type.String({ description: "PR body (default: auto-generated from commit summary)" })),
      base_branch: Type.Optional(Type.String({ description: "Base branch for the PR (default: detected from repo)" })),
      force_new: Type.Optional(Type.Boolean({ description: "Force creation of a new PR even if one exists (default: false)" })),
      target_repo: Type.Optional(Type.String({ description: "Target repository for cross-repo PRs (e.g. 'openai/codex'). Auto-detected from 'upstream' remote if not set." })),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }
      if (!isAgentPrParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { session, title?, body?, base_branch?, force_new? }." }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
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

      const { worktreePath, originalWorkdir, sessionName, branchName } = target;

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
      const repoPolicy = sessionManager.resolveRepoPolicy(originalWorkdir);
      if (repoPolicy?.policy === "never-pr") {
        return { content: [{ type: "text", text: `Error: Repo policy forbids PR creation for ${repoPolicy.identity?.repoRoot ?? originalWorkdir}.` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }
      if (repoPolicy && !repoPolicy.prAvailable) {
        return { content: [{ type: "text", text: `Error: PR automation is unavailable for ${repoPolicy.identity?.repoRoot ?? originalWorkdir}. Provider: ${repoPolicy.provider}.` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }
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

      // Push branch first (required for PR operations)
      if (!pushBranch(originalWorkdir, branchName)) {
        return { content: [{ type: "text", text: `❌ Failed to push ${branchName} — cannot create/update PR` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
      }

      // Sync PR state from GitHub
      const prStatus = syncWorktreePR(originalWorkdir, branchName, targetRepo);

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
                text: `${updateOutcomeLine}\n\n📝 Added comment detailing ${diffSummary.commits} new commits (+${diffSummary.insertions} / -${diffSummary.deletions})`
              }],
              meta: { success: true, state: "pr_updated" },
            } satisfies AgentPrExecuteResult;
          } else {
            return {
              content: [{
                type: "text",
                text: `⚠️  Pushed to ${prStatus.url} but failed to add comment.\n\n` +
                      `${diffSummary.commits} new commits (+${diffSummary.insertions} / -${diffSummary.deletions})`
              }],
              meta: { success: true, state: "pr_open" },
            } satisfies AgentPrExecuteResult;
          }
        } else {
          // No new commits
          persistPrOpen({ prUrl: prStatus.url, prNumber: prStatus.number, targetRepo });
          return {
            content: [{
              type: "text",
              text: `ℹ️  PR already exists and is up to date: ${prStatus.url}\n\n` +
                    `No new commits to push.`
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
            provider: options.metadataProvider,
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

              // Surface any warnings from createPR (e.g. fell back to non-draft)
              warnings: prResult.warnings,
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
