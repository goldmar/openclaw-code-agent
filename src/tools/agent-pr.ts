import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";
import { getBranchName, getDiffSummary, createPR, pushBranch, isGitHubCLIAvailable, detectDefaultBranch, syncWorktreePR, commentOnPR } from "../worktree";

interface AgentPrParams {
  session: string;
  title?: string;
  body?: string;
  base_branch?: string;
  force_new?: boolean;
}

function isAgentPrParams(value: unknown): value is AgentPrParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.session === "string";
}

/** Register the `agent_pr` tool factory. */
export function makeAgentPrTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_pr",
    description: "Create or update a GitHub PR for a worktree branch. Handles full PR lifecycle: creates new PRs, updates existing open PRs with comments, and handles merged/closed PRs. Pushes the branch, syncs PR state, and persists metadata.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to create/update PR for" }),
      title: Type.Optional(Type.String({ description: "PR title (default: auto-generated from session name)" })),
      body: Type.Optional(Type.String({ description: "PR body (default: auto-generated from commit summary)" })),
      base_branch: Type.Optional(Type.String({ description: "Base branch for the PR (default: detected from repo)" })),
      force_new: Type.Optional(Type.Boolean({ description: "Force creation of a new PR even if one exists (default: false)" })),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentPrParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { session, title?, body?, base_branch?, force_new? }." }] };
      }

      // Check if gh CLI is available
      if (!isGitHubCLIAvailable()) {
        return { content: [{ type: "text", text: "Error: GitHub CLI (gh) is not available. Install it and authenticate to create PRs." }] };
      }

      // Resolve session (active or persisted)
      const targetSession = sessionManager.resolve(params.session);
      const persistedSession = sessionManager.getPersistedSession(params.session);

      if (!targetSession && !persistedSession) {
        return { content: [{ type: "text", text: `Error: Session "${params.session}" not found.` }] };
      }

      // Extract worktree info
      const worktreePath = targetSession?.worktreePath ?? persistedSession?.worktreePath;
      const originalWorkdir = targetSession?.originalWorkdir ?? persistedSession?.workdir;
      const sessionName = targetSession?.name ?? persistedSession?.name ?? params.session;

      if (!worktreePath || !originalWorkdir) {
        return { content: [{ type: "text", text: `Error: Session "${params.session}" does not have a worktree.` }] };
      }

      const branchName = getBranchName(worktreePath);
      if (!branchName) {
        return { content: [{ type: "text", text: `Error: Cannot determine branch name for worktree ${worktreePath}.` }] };
      }

      const baseBranch = params.base_branch ?? detectDefaultBranch(originalWorkdir);

      // Push branch first (required for PR operations)
      if (!pushBranch(originalWorkdir, branchName)) {
        return { content: [{ type: "text", text: `❌ Failed to push ${branchName} — cannot create/update PR` }] };
      }

      // Sync PR state from GitHub
      const prStatus = syncWorktreePR(originalWorkdir, branchName);

      // Handle force_new parameter
      if (params.force_new && prStatus.exists) {
        return {
          content: [{
            type: "text",
            text: `⚠️  Cannot create new PR: A PR already exists for ${branchName} (${prStatus.state}).\n\n` +
                  `Existing PR: ${prStatus.url}\n\n` +
                  `To create a new PR, you must first close/merge the existing PR manually or use a different branch.`
          }]
        };
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

          const commented = commentOnPR(originalWorkdir, prStatus.number!, commentBody);

          if (commented) {
            // Update persisted metadata
            if (persistedSession) {
              sessionManager.updatePersistedSession(persistedSession.harnessSessionId, {
                worktreePrUrl: prStatus.url,
                worktreePrNumber: prStatus.number,
              });
            }
            return {
              content: [{
                type: "text",
                text: `✅ PR updated with new commits: ${prStatus.url}\n\n` +
                      `📝 Added comment detailing ${diffSummary.commits} new commits (+${diffSummary.insertions} / -${diffSummary.deletions})`
              }]
            };
          } else {
            return {
              content: [{
                type: "text",
                text: `⚠️  Pushed to ${prStatus.url} but failed to add comment.\n\n` +
                      `${diffSummary.commits} new commits (+${diffSummary.insertions} / -${diffSummary.deletions})`
              }]
            };
          }
        } else {
          // No new commits
          if (persistedSession) {
            sessionManager.updatePersistedSession(persistedSession.harnessSessionId, {
              worktreePrUrl: prStatus.url,
              worktreePrNumber: prStatus.number,
            });
          }
          return {
            content: [{
              type: "text",
              text: `ℹ️  PR already exists and is up to date: ${prStatus.url}\n\n` +
                    `No new commits to push.`
            }]
          };
        }
      } else if (prStatus.exists && prStatus.state === "merged") {
        // Case: PR was merged
        if (persistedSession) {
          sessionManager.updatePersistedSession(persistedSession.harnessSessionId, {
            worktreePrUrl: prStatus.url,
            worktreePrNumber: prStatus.number,
          });
        }
        return {
          content: [{
            type: "text",
            text: `✅ PR was already merged: ${prStatus.url}\n\n` +
                  `The worktree branch ${branchName} can be cleaned up with agent_merge(delete_branch=true).`
          }]
        };
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
          }]
        };
      } else {
        // Case: No PR exists — create new PR
        const prTitle = params.title ?? `[openclaw-code-agent] ${sessionName}`;
        let prBody = params.body;

        if (!prBody) {
          const diffSummary = getDiffSummary(originalWorkdir, branchName, baseBranch);
          if (diffSummary) {
            const commitMessages = diffSummary.commitMessages
              .slice(0, 5)
              .map((c) => `• ${c.hash} ${c.message} (${c.author})`)
              .join("\n");
            const moreCommits = diffSummary.commits > 5 ? `\n...and ${diffSummary.commits - 5} more` : "";

            prBody = [
              `Automated changes from OpenClaw Code Agent session: ${sessionName}`,
              ``,
              `## Summary`,
              `${diffSummary.commits} commits, ${diffSummary.filesChanged} files changed (+${diffSummary.insertions} / -${diffSummary.deletions})`,
              ``,
              `## Commits`,
              commitMessages + moreCommits,
              ``,
              `---`,
              `🤖 Generated with [openclaw-code-agent](https://github.com/goldmar/openclaw-code-agent)`,
            ].join("\n");
          } else {
            prBody = `Automated changes from OpenClaw Code Agent session: ${sessionName}`;
          }
        }

        // Create PR
        const prResult = createPR(originalWorkdir, branchName, baseBranch, prTitle, prBody);

        if (prResult.success && prResult.prUrl) {
          // Sync again to get PR number
          const newPrStatus = syncWorktreePR(originalWorkdir, branchName);

          // Persist PR URL and number
          if (persistedSession) {
            sessionManager.updatePersistedSession(persistedSession.harnessSessionId, {
              worktreePrUrl: prResult.prUrl,
              worktreePrNumber: newPrStatus.number,
              pendingWorktreeDecisionSince: undefined,
              lastWorktreeReminderAt: undefined,
            });
          }

          return { content: [{ type: "text", text: `🔀 PR created: ${prResult.prUrl}` }] };
        } else {
          return { content: [{ type: "text", text: `❌ Failed to create PR: ${prResult.error ?? "unknown error"}` }] };
        }
      }
    },
  };
}
