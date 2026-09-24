import { Type } from "../tool-parameter-schema";
import { sessionManager } from "../singletons";
import type { Session } from "../session";
import type { OpenClawPluginToolContext, ThreadAction } from "../types";

type ReviewTargetParam = "uncommitted" | "base_branch" | "commit" | "custom";

interface AgentSessionActionParams {
  session: string;
  action: "compact" | "review";
  review_target?: ReviewTargetParam;
  base_branch?: string;
  commit_sha?: string;
  instructions?: string;
}

const REVIEW_TARGETS: readonly ReviewTargetParam[] = ["uncommitted", "base_branch", "commit", "custom"];

function isParams(value: unknown): value is AgentSessionActionParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  if (typeof params.session !== "string" || !params.session.trim()) return false;
  if (params.action !== "compact" && params.action !== "review") return false;
  if (params.review_target !== undefined && !REVIEW_TARGETS.includes(params.review_target as ReviewTargetParam)) return false;
  for (const key of ["base_branch", "commit_sha", "instructions"] as const) {
    if (params[key] !== undefined && typeof params[key] !== "string") return false;
  }
  return true;
}

type ReviewSession = Pick<Session, "worktreeBranch" | "worktreeBaseBranch" | "worktreeParentBranch">;

/** Resolve the review target, defaulting worktree sessions to their branch diff. */
export function resolveReviewTarget(
  params: Omit<AgentSessionActionParams, "session" | "action">,
  session: ReviewSession,
): { kind: "ok"; action: ThreadAction } | { kind: "error"; error: string } {
  const defaultBase = session.worktreeBranch
    ? (session.worktreeBaseBranch ?? session.worktreeParentBranch)
    : undefined;
  const target = params.review_target
    ?? (params.base_branch?.trim() ? "base_branch" : params.commit_sha?.trim() ? "commit" : params.instructions?.trim() ? "custom" : undefined)
    ?? (defaultBase ? "base_branch" : "uncommitted");
  switch (target) {
    case "uncommitted":
      return { kind: "ok", action: { kind: "review", target: { type: "uncommittedChanges" } } };
    case "base_branch": {
      const branch = params.base_branch?.trim() || defaultBase;
      if (!branch) return { kind: "error", error: "review_target 'base_branch' requires base_branch (the session has no worktree base branch)." };
      return { kind: "ok", action: { kind: "review", target: { type: "baseBranch", branch } } };
    }
    case "commit": {
      const sha = params.commit_sha?.trim();
      if (!sha) return { kind: "error", error: "review_target 'commit' requires commit_sha." };
      return { kind: "ok", action: { kind: "review", target: { type: "commit", sha } } };
    }
    case "custom": {
      const instructions = params.instructions?.trim();
      if (!instructions) return { kind: "error", error: "review_target 'custom' requires instructions." };
      return { kind: "ok", action: { kind: "review", target: { type: "custom", instructions } } };
    }
  }
}

function describeAction(action: ThreadAction): string {
  if (action.kind === "compact") return "Context compaction";
  switch (action.target.type) {
    case "uncommittedChanges": return "Code review of uncommitted changes";
    case "baseBranch": return `Code review against ${action.target.branch}`;
    case "commit": return `Code review of commit ${action.target.sha}`;
    case "custom": return "Custom code review";
  }
}

/** Register the `agent_session_action` tool factory. */
export function makeAgentSessionActionTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_session_action",
    description:
      "Run a backend thread action on a running coding agent session (currently Codex only). 'compact' summarizes the conversation to free context. 'review' runs Codex's built-in code reviewer inline in the session; findings arrive like a normal turn (use agent_output). Worktree sessions default to reviewing the branch against its base. Actions queue behind a running turn.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID (must be running)" }),
      action: Type.Union([Type.Literal("compact"), Type.Literal("review")], { description: "Thread action to run" }),
      review_target: Type.Optional(Type.Union(
        [Type.Literal("uncommitted"), Type.Literal("base_branch"), Type.Literal("commit"), Type.Literal("custom")],
        { description: "What to review (review only). Defaults to base_branch for worktree sessions, otherwise uncommitted." },
      )),
      base_branch: Type.Optional(Type.String({ description: "Branch to diff against for review_target 'base_branch'" })),
      commit_sha: Type.Optional(Type.String({ description: "Commit to review for review_target 'commit'" })),
      instructions: Type.Optional(Type.String({ description: "Reviewer instructions for review_target 'custom'" })),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { session, action: 'compact' | 'review', review_target?, base_branch?, commit_sha?, instructions? }." }] };
      }
      const session = sessionManager.resolve(params.session);
      if (!session) {
        return { content: [{ type: "text", text: `Error: Session "${params.session}" is not active. Resume it with agent_respond first.` }] };
      }
      let action: ThreadAction = { kind: "compact" };
      if (params.action === "review") {
        const resolved = resolveReviewTarget(params, session);
        if (resolved.kind === "error") return { content: [{ type: "text", text: `Error: ${resolved.error}` }] };
        action = resolved.action;
      }
      try {
        session.requestThreadAction(action);
      } catch (err: unknown) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
      return {
        content: [{
          type: "text",
          text: `${describeAction(action)} queued for session ${session.name} [${session.id}]. Use agent_output to see the result.`,
        }],
      };
    },
  };
}
