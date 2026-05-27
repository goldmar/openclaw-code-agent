import { Type } from "../tool-schema";
import { existsSync } from "fs";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";
import type { DiffSummary } from "../worktree";
import { getDiffSummary, createPR, pushBranch, isGitHubCLIAvailable, detectDefaultBranch, syncWorktreePR, commentOnPR, resolveTargetRepo, formatWorktreeOutcomeLine } from "../worktree";
import { resolveWorktreeToolTarget } from "./worktree-tool-context";

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

export interface PrMetadataEvidence {
  sessionName: string;
  objective?: string;
  stats?: {
    commits: number;
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  changedFiles: string[];
  commitSubjects: string[];
  validation: string[];
  notes: string[];
}

export interface PrMetadata {
  title: string;
  summary: string[];
  changes: string[];
  validation: string[];
  notes: string[];
}

export interface PrMetadataProvider {
  generatePrMetadata(evidence: PrMetadataEvidence): Promise<unknown>;
}

export type PrMetadataResult =
  | { ok: true; metadata: PrMetadata; evidence: PrMetadataEvidence }
  | { ok: false; error: string; evidence: PrMetadataEvidence };

const OPAQUE_TOKEN_MIN_LENGTH = 32;

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

function normalizePrText(value: string | undefined, options: { preserveBlankLines?: boolean } = { preserveBlankLines: true }): string | undefined {
  const text = value
    ?.replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .reduce<string[]>((acc, line) => {
      if (!line) {
        if (options.preserveBlankLines && acc[acc.length - 1] !== "") acc.push(line);
        return acc;
      }
      acc.push(line);
      return acc;
    }, [])
    .join(options.preserveBlankLines ? "\n" : " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  return text || undefined;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|pwd|credential|credentials|authorization|auth)[A-Za-z0-9_-]*\b\s*[:=]\s*["']?[^"'\s,;)]+/gi, "[redacted credential]")
    .replace(/\b(?:api key|token|secret|password|credential|credentials)\s+\[redacted credential\]/gi, "[redacted credential]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g, "[redacted token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted token]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted token]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[redacted token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted token]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted token]")
    .replace(/\bhttps?:\/\/\S+/gi, "[redacted link]")
    .replace(/\b[A-Z]:\\(?:Users|Documents and Settings)\\[^\s`'")]+/gi, "[redacted path]")
    .replace(/(?:^|[\s(])\/(?:home|Users|var|etc|private|tmp)\/[^\s`'").]+/g, (match) => `${match.startsWith(" ") || match.startsWith("(") ? match[0] : ""}[redacted path]`)
    .replace(new RegExp(`\\b[A-Za-z0-9_-]{${OPAQUE_TOKEN_MIN_LENGTH},}\\b`, "g"), "[redacted token]");
}

function containsSensitiveText(value: string): boolean {
  return /\b[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|pwd|credential|credentials|authorization|auth)[A-Za-z0-9_-]*\b\s*[:=]\s*["']?[^"'\s,;)]+/i.test(value)
    || /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/.test(value)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)
    || /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/.test(value)
    || /\bhttps?:\/\/\S+/i.test(value)
    || /\b[A-Z]:\\(?:Users|Documents and Settings)\\[^\s`'")]+/i.test(value)
    || /(?:^|[\s(])\/(?:home|Users|var|etc|private|tmp)\/[^\s`'").]+/.test(value)
    || new RegExp(`\\b[A-Za-z0-9_-]{${OPAQUE_TOKEN_MIN_LENGTH},}\\b`).test(value);
}

function buildSafeObjective(prompt: string | undefined): string | undefined {
  const normalized = normalizePrText(prompt);
  if (!normalized) return undefined;
  const firstSentence = normalized.match(/^[^.!?]+[.!?]/)?.[0] ?? normalized;
  const redacted = redactSensitiveText(firstSentence).replace(/\s+/g, " ").trim();
  return redacted ? truncateText(redacted, 180) : undefined;
}

function formatCommitSubjects(diffSummary: DiffSummary | undefined, limit: number): string[] {
  return diffSummary?.commitMessages
    .map((commit) => commit.message.trim())
    .filter(Boolean)
    .slice(0, limit) ?? [];
}

function defaultValidation(): string[] {
  return ["Not recorded by agent_pr. Review CI/checks and session output before merging."];
}

function defaultNotes(): string[] {
  return [
    "Generated PR metadata omits full task prompts and redacts sensitive-looking prompt details.",
    "Review touched areas for behavior, security, and privacy impact.",
  ];
}

function buildPrMetadataEvidence(args: {
  sessionName: string;
  prompt?: string;
  diffSummary?: DiffSummary;
}): PrMetadataEvidence {
  const objective = buildSafeObjective(args.prompt);
  const diffSummary = args.diffSummary;
  return {
    sessionName: args.sessionName,
    objective,
    stats: diffSummary
      ? {
          commits: diffSummary.commits,
          filesChanged: diffSummary.filesChanged,
          insertions: diffSummary.insertions,
          deletions: diffSummary.deletions,
        }
      : undefined,
    changedFiles: diffSummary?.changedFiles ?? [],
    commitSubjects: formatCommitSubjects(diffSummary, 5),
    validation: defaultValidation(),
    notes: defaultNotes(),
  };
}

function isStringArray(value: unknown, maxItems: number, maxItemLength: number): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= maxItems
    && value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= maxItemLength);
}

function promptLeakFragments(prompt: string | undefined, allowedObjective: string | undefined): string[] {
  const normalized = normalizePrText(prompt);
  if (!normalized) return [];
  const allowed = allowedObjective?.toLowerCase();
  return normalized
    .split(/[.!?\n]/)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= 24)
    .filter((fragment) => !allowed || fragment.toLowerCase() !== allowed.replace(/[.!?]$/, ""))
    .map((fragment) => fragment.toLowerCase());
}

function includesPromptLeak(value: string, prompt: string | undefined, evidence: PrMetadataEvidence): boolean {
  const lower = value.toLowerCase();
  return promptLeakFragments(prompt, evidence.objective).some((fragment) => lower.includes(fragment));
}

function mentionsUnknownFile(value: string, evidence: PrMetadataEvidence): boolean {
  const knownFiles = new Set(evidence.changedFiles);
  const pathMatches = value.match(/\b(?:[\w.-]+\/)+[\w.-]+\b/g) ?? [];
  if (pathMatches.some((file) => /\.[A-Za-z0-9]+$/.test(file) && !knownFiles.has(file))) return true;

  const knownRootFiles = new Set(evidence.changedFiles.filter((file) => !file.includes("/")));
  if (knownRootFiles.size === 0) return false;

  const knownRootExtensions = new Set(
    [...knownRootFiles]
      .map((file) => file.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase())
      .filter((extension): extension is string => Boolean(extension)),
  );
  const rootFilePattern = String.raw`[A-Za-z0-9][\w.-]*\.([A-Za-z0-9]+)`;
  const quotedRootFileMentions = value.matchAll(new RegExp(`[\\\`"'](${rootFilePattern})[\\\`"']`, "g"));
  for (const match of quotedRootFileMentions) {
    const file = match[1];
    const extension = match[2]?.toLowerCase();
    if (extension !== undefined && knownRootExtensions.has(extension) && !knownRootFiles.has(file)) return true;
  }

  const contextualRootFileMentions = value.matchAll(new RegExp(String.raw`\b(?:file|files|path|paths|changed|changes|updated?|updates?|modified?|modifies|touched?|touches|added?|adds?|removed?|removes?|deleted?|deletes?)\s+(?:the\s+)?(${rootFilePattern})\b`, "gi"));
  return [...contextualRootFileMentions].some((match) => {
    const file = match[1];
    const extension = match[2]?.toLowerCase();
    return extension !== undefined
      && knownRootExtensions.has(extension)
      && !knownRootFiles.has(file);
  });
}

function sanitizeMetadataText(value: string): string {
  return redactSensitiveText(value).replace(/\s+/g, " ").trim();
}

function validateGeneratedPrMetadata(
  value: unknown,
  evidence: PrMetadataEvidence,
  prompt: string | undefined,
): PrMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.title !== "string" || raw.title.trim().length === 0 || raw.title.length > 90) return undefined;
  if (!isStringArray(raw.summary, 5, 180)) return undefined;
  if (!isStringArray(raw.changes, 10, 160)) return undefined;
  if (!isStringArray(raw.validation, 5, 160)) return undefined;
  if (!isStringArray(raw.notes, 5, 180)) return undefined;

  const rawText = [
    raw.title,
    ...raw.summary,
    ...raw.changes,
    ...raw.validation,
    ...raw.notes,
  ];
  if (rawText.some((item) => containsSensitiveText(item) || includesPromptLeak(item, prompt, evidence))) return undefined;

  const metadata: PrMetadata = {
    title: sanitizeMetadataText(raw.title),
    summary: raw.summary.map(sanitizeMetadataText),
    changes: raw.changes.map(sanitizeMetadataText),
    validation: raw.validation.map(sanitizeMetadataText),
    notes: raw.notes.map(sanitizeMetadataText),
  };

  const allText = [
    metadata.title,
    ...metadata.summary,
    ...metadata.changes,
    ...metadata.validation,
    ...metadata.notes,
  ];

  if (allText.some((item) => !item || containsSensitiveText(item) || includesPromptLeak(item, prompt, evidence))) return undefined;
  if (allText.some((item) => mentionsUnknownFile(item, evidence))) return undefined;
  return metadata;
}

export async function buildPrMetadata(args: {
  sessionName: string;
  prompt?: string;
  diffSummary?: DiffSummary;
  provider?: PrMetadataProvider;
}): Promise<PrMetadataResult> {
  const evidence = buildPrMetadataEvidence(args);
  if (!args.provider) {
    return {
      ok: false,
      error: "PR metadata generation requires an LLM metadata provider. Pass explicit title and body, or configure a provider before creating the PR.",
      evidence,
    };
  }

  try {
    const generated = await args.provider.generatePrMetadata(evidence);
    const metadata = validateGeneratedPrMetadata(generated, evidence, args.prompt);
    if (metadata) return { ok: true, metadata, evidence };
    return {
      ok: false,
      error: "LLM-generated PR metadata failed schema or safety validation. Pass explicit title/body or retry after correcting the provider output.",
      evidence,
    };
  } catch (err) {
    console.warn(`[agent_pr] PR metadata provider failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      ok: false,
      error: "PR metadata provider failed. Pass explicit title/body or retry after the provider is healthy.",
      evidence,
    };
  }
}

export function formatPrBody(args: {
  sessionName: string;
  metadata: PrMetadata;
  diffSummary?: DiffSummary;
}): string {
  const lines: string[] = [
    `OpenClaw Code Agent session: ${args.sessionName}`,
    ``,
    `## Summary`,
    ...args.metadata.summary.map((line) => `- ${line}`),
    ``,
    `## Changes`,
    ...args.metadata.changes.map((line) => `- ${line}`),
    ``,
  ];

  if (args.diffSummary) {
    const commitMessages = args.diffSummary.commitMessages
      .slice(0, 5)
      .map((c) => `- ${c.hash} ${c.message} (${c.author})`);
    const moreCommits = args.diffSummary.commits > 5 ? [`- ...and ${args.diffSummary.commits - 5} more`] : [];
    if (commitMessages.length > 0) {
      lines.push(`## Commits`, ...commitMessages, ...moreCommits, ``);
    }
  }

  lines.push(
    `## Validation`,
    ...args.metadata.validation.map((line) => `- ${line}`),
    ``,
    `## Notes / Risks`,
    ...args.metadata.notes.map((line) => `- ${line}`),
    ``,
  );

  lines.push(`---`, `Generated with [openclaw-code-agent](https://github.com/goldmar/openclaw-code-agent)`);
  return lines.join("\n");
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
      const persistedRef = target.persistedRef;

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
            if (persistedRef) {
              sessionManager.updatePersistedSession(persistedRef, {
                worktreePrUrl: prStatus.url,
                worktreePrNumber: prStatus.number,
                lifecycle: "terminal",
                worktreeState: "pr_open",
                pendingWorktreeDecisionSince: undefined,
                lastWorktreeReminderAt: undefined,
                worktreeLifecycle: {
                  state: "pr_open",
                  updatedAt: new Date().toISOString(),
                  baseBranch,
                  targetRepo,
                  pushRemote: persistedSession?.worktreePushRemote,
                },
              });
            }
            const updateOutcomeLine = formatWorktreeOutcomeLine({
              kind: "pr-updated",
              branch: branchName,
              prUrl: prStatus.url,
            });
            sessionManager.notifyWorktreeOutcome(
              target.notificationTarget!,
              updateOutcomeLine,
              {
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
          if (persistedRef) {
            sessionManager.updatePersistedSession(persistedRef, {
              worktreePrUrl: prStatus.url,
              worktreePrNumber: prStatus.number,
              lifecycle: "terminal",
              worktreeState: "pr_open",
              pendingWorktreeDecisionSince: undefined,
              lastWorktreeReminderAt: undefined,
              worktreeLifecycle: {
                state: "pr_open",
                updatedAt: new Date().toISOString(),
                baseBranch,
                targetRepo,
                pushRemote: persistedSession?.worktreePushRemote,
              },
            });
          }
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
        if (persistedRef) {
          sessionManager.updatePersistedSession(persistedRef, {
            worktreePrUrl: prStatus.url,
            worktreePrNumber: prStatus.number,
            worktreeMerged: true,
            worktreeMergedAt: new Date().toISOString(),
            lifecycle: "terminal",
            worktreeState: "merged",
            pendingWorktreeDecisionSince: undefined,
            lastWorktreeReminderAt: undefined,
            worktreeDisposition: "merged",
            worktreeLifecycle: {
              state: "merged",
              updatedAt: new Date().toISOString(),
              resolvedAt: new Date().toISOString(),
              resolutionSource: "agent_pr",
              baseBranch,
              targetRepo,
              pushRemote: persistedSession?.worktreePushRemote,
            },
          });
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
        const prResult = createPR(originalWorkdir, branchName, baseBranch, prTitle, prBody, targetRepo);

        if (prResult.success && prResult.prUrl) {
          // Sync again to get PR number
          const newPrStatus = syncWorktreePR(originalWorkdir, branchName, targetRepo);

          // Persist PR URL and number
          if (persistedRef) {
            sessionManager.updatePersistedSession(persistedRef, {
              worktreePrUrl: prResult.prUrl,
              worktreePrNumber: newPrStatus.number,
              lifecycle: "terminal",
              pendingWorktreeDecisionSince: undefined,
              lastWorktreeReminderAt: undefined,
              worktreeState: "pr_open",
              worktreeDisposition: "pr-opened",
              worktreeLifecycle: {
                state: "pr_open",
                updatedAt: new Date().toISOString(),
                baseBranch,
                targetRepo,
                pushRemote: persistedSession?.worktreePushRemote,
              },
            });
          }

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

          return { content: [{ type: "text", text: outcomeLine }], meta: { success: true, state: "created" } } satisfies AgentPrExecuteResult;
        } else {
          return { content: [{ type: "text", text: `❌ Failed to create PR: ${prResult.error ?? "unknown error"}` }], meta: { success: false, state: "error" } } satisfies AgentPrExecuteResult;
        }
      }
    },
  };
}
