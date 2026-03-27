import { existsSync } from "fs";
import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import { formatLaunchSummaryFromSession, type LaunchSummarySessionLike } from "../launch-summary";
import {
  getDefaultHarnessName,
  pluginConfig,
  resolveAllowedModelsForHarness,
  resolveApprovalPolicyForHarness,
  resolveDefaultModelForHarness,
  resolveReasoningEffortForHarness,
} from "../config";
import type { OpenClawPluginToolContext, PersistedSessionInfo } from "../types";
import {
  extractPromptDeclaredWorkdir,
  resolveAgentLaunchRequest,
  type AgentLaunchParams,
} from "./agent-launch-resolution";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAgentLaunchParams(value: unknown): value is AgentLaunchParams {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.prompt === "string";
}


function hasFormatLaunchResult(value: unknown): value is {
  formatLaunchResult: (config: {
    prompt: string;
    workdir: string;
    harness: string;
    permissionMode: "default" | "plan" | "bypassPermissions";
    planApproval: "ask" | "delegate" | "approve";
    forceNewSession?: boolean;
    resumeSessionId?: string;
    forkSession?: boolean;
    clearedPersistedCodexResume?: boolean;
  }, session: LaunchSummarySessionLike) => string;
} {
  return !!value
    && typeof value === "object"
    && typeof (value as { formatLaunchResult?: unknown }).formatLaunchResult === "function";
}

/**
 * Checks if a model identifier is allowed based on case-insensitive substring matching.
 * Returns true if allowedModels is empty/undefined, or if any allowed pattern matches the model.
 *
 * @param model - The model identifier to check (e.g., "anthropic/claude-sonnet-4-6")
 * @param allowedModels - Array of allowed patterns (e.g., ["sonnet", "opus"])
 * @returns true if model is allowed, false otherwise
 */
function isModelAllowed(model: string | undefined, allowedModels: string[] | undefined): boolean {
  // No restrictions if allowedModels is not configured or empty
  if (!allowedModels || allowedModels.length === 0) {
    return true;
  }

  // Reject if model is undefined/null when there are restrictions
  if (!model) {
    return false;
  }

  const modelLower = model.toLowerCase();
  return allowedModels.some(pattern => modelLower.includes(pattern.toLowerCase()));
}

/** Register the `agent_launch` tool factory. */
export function makeAgentLaunchTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "agent_launch",
    description:
      "Launch a coding agent session in background to execute a development task. Sessions are multi-turn — they stay open for follow-up messages via agent_respond. Supports resuming previous sessions. Returns a session ID and name for tracking.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The task prompt to execute" }),
      name: Type.Optional(
        Type.String({ description: "Short human-readable name for the session (kebab-case, e.g. 'fix-auth'). Auto-generated from prompt if omitted." }),
      ),
      workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
      model: Type.Optional(Type.String({ description: "Model name to use" })),
      system_prompt: Type.Optional(Type.String({ description: "Additional system prompt" })),
      allowed_tools: Type.Optional(Type.Array(Type.String(), { description: "List of allowed tools" })),
      resume_session_id: Type.Optional(
        Type.String({ description: "Session reference to continue or fork from. Prefer the plugin session ID shown by agent_launch or agent_sessions; persisted backend conversation IDs also resolve when available." }),
      ),
      fork_session: Type.Optional(
        Type.Boolean({ description: "When resuming, fork to a new session instead of continuing the existing one. Use with resume_session_id." }),
      ),
      force_new_session: Type.Optional(
        Type.Boolean({ description: "Bypass resume-first protection and start a brand-new linked session even when a resumable or active linked session already exists." }),
      ),
      permission_mode: Type.Optional(
        Type.Union(
          [Type.Literal("default"), Type.Literal("plan"), Type.Literal("bypassPermissions")],
          { description: "Permission mode: 'default' (standard prompts), 'plan' (present plan first, wait for approval), 'bypassPermissions' (fully autonomous execution). Defaults to plugin config ('plan' by default)." },
        ),
      ),
      plan_approval: Type.Optional(
        Type.Union(
          [Type.Literal("ask"), Type.Literal("delegate"), Type.Literal("approve")],
          { description: "Plan approval policy for this session: 'ask' (show Approve/Reject/Revise buttons), 'delegate' (orchestrator decides), 'approve' (auto-approve). Overrides the plugin-level planApproval setting." },
        ),
      ),
      harness: Type.Optional(
        Type.String({ description: "Agent harness to use (e.g. 'claude-code'). Defaults to 'claude-code'." }),
      ),
      worktree_strategy: Type.Optional(
        Type.Union(
          [Type.Literal("off"), Type.Literal("manual"), Type.Literal("ask"), Type.Literal("delegate"), Type.Literal("auto-merge"), Type.Literal("auto-pr")],
          { description: "Worktree strategy: 'off' (no worktree), 'manual' (create worktree but no auto merge-back), 'ask' (prompt user with Merge/PR/Decide later/Dismiss buttons), 'delegate' (orchestrator decides), 'auto-merge' (merge automatically), 'auto-pr' (open/update a PR automatically). Defaults to the plugin config when unset." },
        ),
      ),
      worktree_base_branch: Type.Optional(
        Type.String({ description: "Base branch for worktree merge/PR operations (default: auto-detected or 'main')" }),
      ),
      worktree_pr_target_repo: Type.Optional(
        Type.String({ description: "Target repository for cross-repo PRs (e.g. 'openai/codex' for fork-to-upstream workflow). If not set, auto-detected from 'upstream' remote or defaults to 'origin'." }),
      ),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentLaunchParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected at least { prompt }." }] };
      }

      // Guard: agentId is NOT a valid parameter for agent_launch. It belongs to sessions_spawn (OpenClaw sub-agents).
      // If present in params, it was passed by mistake — log a warning and ignore it.
      // See docs/internal/COMMON-MISTAKES.md for the full explanation.
      if (params.agentId) {
        console.warn(`[agent_launch] ⚠️ agentId="${params.agentId}" was passed as a parameter — this is WRONG. agentId is only for sessions_spawn (OpenClaw sub-agents), not agent_launch (CC sessions). The field is being ignored. ctx.agentId="${ctx.agentId}" will be used for origin routing instead.`);
      }

      try {
        const resolution = resolveAgentLaunchRequest(params, ctx, sessionManager as any);
        if (resolution.kind !== "resolved") {
          return { content: [{ type: "text", text: resolution.text }] };
        }
        const {
          workdir,
          harness,
          resolvedModel,
          permissionMode,
          planApproval,
          originChannel,
          originThreadId,
          originSessionKey,
          route,
          resumeSessionId,
          resolvedResumeId,
          clearedPersistedCodexResume,
          reasoningEffort,
        } = resolution;

        const session = sessionManager.spawn({
          prompt: params.prompt,
          name: params.name,
          workdir,
          model: resolvedModel,
          reasoningEffort,
          systemPrompt: params.system_prompt,
          allowedTools: params.allowed_tools,
          resumeSessionId,
          // Bug 3 fix: always pass the original resolved session ID for worktree inheritance,
          // even when resumeSessionId was cleared by decideResumeSessionId (e.g. Codex harness).
          resumeWorktreeFrom: resolvedResumeId,
          forkSession: resumeSessionId ? params.fork_session : false,
          multiTurn: true,
          permissionMode: params.permission_mode,
          planApproval: params.plan_approval,
          codexApprovalPolicy: harness === "codex"
            ? (resolveApprovalPolicyForHarness(harness) ?? pluginConfig.codexApprovalPolicy)
            : undefined,
          originChannel,
          originThreadId,
          originAgentId: ctx.agentId || undefined,
          originSessionKey,
          route,
          harness,
          worktreeStrategy: params.worktree_strategy,
          worktreeBaseBranch: params.worktree_base_branch,
          worktreePrTargetRepo: params.worktree_pr_target_repo,
        });

        const launchText = hasFormatLaunchResult(sessionManager)
          ? sessionManager.formatLaunchResult({
              prompt: params.prompt,
              workdir,
              harness,
              permissionMode: permissionMode ?? pluginConfig.permissionMode,
              planApproval,
              forceNewSession: params.force_new_session,
              resumeSessionId: params.resume_session_id,
              forkSession: params.fork_session,
              clearedPersistedCodexResume,
            }, session)
          : formatLaunchSummaryFromSession({
              prompt: params.prompt,
              workdir,
              harness,
              permissionMode: permissionMode ?? pluginConfig.permissionMode,
              planApproval,
              resumeSessionId: params.resume_session_id,
              forkSession: params.fork_session,
              forceNewSession: params.force_new_session,
              clearedPersistedCodexResume,
            }, {
              id: session.id,
              name: session.name,
              model: session.model,
              reasoningEffort: session.reasoningEffort ?? resolveReasoningEffortForHarness(harness),
              worktreeStrategy: session.worktreeStrategy ?? params.worktree_strategy ?? pluginConfig.defaultWorktreeStrategy ?? "off",
              worktreePath: session.worktreePath,
              originalWorkdir: session.originalWorkdir,
              codexApprovalPolicy: session.codexApprovalPolicy
                ?? (harness === "codex" ? (resolveApprovalPolicyForHarness(harness) ?? pluginConfig.codexApprovalPolicy) : undefined),
            });

        return {
          content: [{
            type: "text",
            text: launchText,
          }],
        };
      } catch (err: unknown) {
        const message = errorMessage(err);
        const hint = message.includes("Max sessions") ? "" : "\n\nUse agent_sessions to see active sessions and their status.";
        return { content: [{ type: "text", text: `Error launching session: ${message}${hint}` }] };
      }
    },
  };
}
