import { existsSync } from "fs";
import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import { formatLaunchSummaryFromSession, type LaunchSummarySessionLike } from "../launch-summary";
import {
  getDefaultHarnessName,
  parseThreadIdFromSessionKey,
  pluginConfig,
  resolveAgentChannel,
  resolveAllowedModelsForHarness,
  resolveApprovalPolicyForHarness,
  resolveDefaultModelForHarness,
  resolveOriginChannel,
  resolveOriginThreadId,
  resolveSessionRoute,
  resolveReasoningEffortForHarness,
  resolveToolChannel,
} from "../config";
import { decideResumeSessionId } from "../resume-policy";
import type { OpenClawPluginToolContext, PersistedSessionInfo } from "../types";

interface AgentLaunchParams {
  prompt: string;
  name?: string;
  workdir?: string;
  model?: string;
  system_prompt?: string;
  allowed_tools?: string[];
  resume_session_id?: string;
  fork_session?: boolean;
  force_new_session?: boolean;
  permission_mode?: "default" | "plan" | "bypassPermissions";
  plan_approval?: "ask" | "delegate" | "approve";
  harness?: string;
  worktree_strategy?: "off" | "manual" | "ask" | "delegate" | "auto-merge" | "auto-pr";
  worktree_base_branch?: string;
  worktree_pr_target_repo?: string;
  agentId?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAgentLaunchParams(value: unknown): value is AgentLaunchParams {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.prompt === "string";
}

function normalizeThreadId(value: unknown): string | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function stripOptionalQuotes(value: string): string {
  return value.trim().replace(/^['"`](.*)['"`]$/s, "$1").trim();
}

// Launch metadata protocol: only parse an explicit top-of-prompt header block.
// This is not free-form prompt inference and must never scan arbitrary body text.
function extractPromptDeclaredWorkdir(prompt: string): string | undefined {
  const headerBlock = prompt
    .split(/\n\s*\n/, 1)[0]
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean) ?? [];

  if (headerBlock.length === 0) return undefined;

  for (const line of headerBlock) {
    const match = line.match(/^(Workdir|Repo):\s*(.+)$/);
    const candidate = stripOptionalQuotes(match?.[2] ?? "");
    if (candidate.startsWith("/") && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

interface LinkedSessionMatch {
  ref: string;
  name: string;
  status: string;
  lifecycle?: string;
  resumable: boolean;
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

function routeMatchesSession(
  session: {
    workdir?: string;
    originSessionKey?: string;
    originChannel?: string;
    originThreadId?: string | number;
  },
  route: {
    workdir: string;
    originSessionKey?: string;
    originChannel?: string;
    originThreadId?: string | number;
  },
): boolean {
  if (session.workdir !== route.workdir) return false;
  if (route.originSessionKey && session.originSessionKey) {
    return session.originSessionKey === route.originSessionKey;
  }
  if (!route.originChannel || !session.originChannel) return false;
  return session.originChannel === route.originChannel
    && normalizeThreadId(session.originThreadId) === normalizeThreadId(route.originThreadId);
}

function summarizeLinkedSessions(matches: LinkedSessionMatch[]): string {
  return matches
    .slice(0, 3)
    .map((match) => `  - ${match.name} [${match.ref}] | status=${match.status}${match.lifecycle ? ` | lifecycle=${match.lifecycle}` : ""}`)
    .join("\n");
}

function findLinkedSessionMatches(
  sessions: {
    list: (filter?: "all") => Array<{
      id: string;
      name: string;
      status: string;
      lifecycle?: string;
      isExplicitlyResumable?: boolean;
      workdir: string;
      originSessionKey?: string;
      originChannel?: string;
      originThreadId?: string | number;
    }>;
    listPersistedSessions: () => PersistedSessionInfo[];
  },
  route: {
    workdir: string;
    originSessionKey?: string;
    originChannel?: string;
    originThreadId?: string | number;
  },
): { resumable: LinkedSessionMatch[]; active: LinkedSessionMatch[] } {
  const resumable: LinkedSessionMatch[] = [];
  const active: LinkedSessionMatch[] = [];
  const seen = new Set<string>();

  for (const session of sessions.list("all")) {
    if (!routeMatchesSession(session, route)) continue;
    const key = session.id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (session.isExplicitlyResumable) {
      resumable.push({
        ref: session.id,
        name: session.name,
        status: session.status,
        lifecycle: session.lifecycle,
        resumable: true,
      });
      continue;
    }
    if (session.status === "starting" || session.status === "running") {
      active.push({
        ref: session.id,
        name: session.name,
        status: session.status,
        lifecycle: session.lifecycle,
        resumable: false,
      });
    }
  }

  for (const session of sessions.listPersistedSessions()) {
    if (!session.resumable) continue;
    if (!routeMatchesSession(session, route)) continue;
    const ref = session.sessionId ?? session.harnessSessionId;
    const key = session.harnessSessionId;
    if (seen.has(key)) continue;
    seen.add(key);
    resumable.push({
      ref,
      name: session.name,
      status: session.status,
      lifecycle: session.lifecycle,
      resumable: true,
    });
  }

  return { resumable, active };
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

      const workdir = params.workdir
        || extractPromptDeclaredWorkdir(params.prompt)
        || ctx.workspaceDir
        || pluginConfig.defaultWorkdir
        || process.cwd();

      if (!existsSync(workdir)) {
        return { content: [{ type: "text", text: `Error: Working directory does not exist: ${workdir}` }] };
      }

      try {
        const harness = params.harness ?? getDefaultHarnessName();
        const defaultModel = resolveDefaultModelForHarness(harness);

        // Resolve the actual model that will be used
        const resolvedModel = params.model ?? defaultModel;
        const wasExplicitModel = params.model !== undefined;
        if (!resolvedModel) {
          return {
            content: [{
              type: "text",
              text: `Error: No default model configured for harness "${harness}". Set plugins.entries["openclaw-code-agent"].config.harnesses.${harness}.defaultModel or pass model explicitly.`,
            }]
          };
        }

        // Enforce allowedModels restrictions
        const allowedModels = resolveAllowedModelsForHarness(harness);
        if (allowedModels && allowedModels.length > 0) {
          if (!isModelAllowed(resolvedModel, allowedModels)) {
            // Hard error for both explicit and default models
            const errorMsg = wasExplicitModel
              ? `Error: Model "${resolvedModel}" is not allowed. Permitted models: ${allowedModels.join(", ")}`
              : `Error: Default model "${resolvedModel || "undefined"}" is not in allowedModels (${allowedModels.join(", ")}). Update your plugin config to set a compatible defaultModel.`;
            return {
              content: [{
                type: "text",
                text: errorMsg
              }]
            };
          }
        }

        // Resolve origin channel
        const ctxChannel = resolveToolChannel(ctx);
        const originChannel = resolveOriginChannel(ctx, ctxChannel || resolveAgentChannel(workdir));

        // Resolve origin session key — prefer ctx.sessionKey (set by the framework),
        // but reconstruct from available fields if missing.
        let originSessionKey = ctx.sessionKey || undefined;
        if (!originSessionKey && ctx.agentId) {
          // ctx.sessionKey not populated — reconstruct from available context fields.
          // Format: "agent:{agentId}:{channel}:{chatType}:{chatId}:topic:{threadId}"
          // We can't reconstruct the full key without chat info, but log the gap for debugging.
          console.warn(`[agent_launch] ctx.sessionKey is not populated. ctx fields: agentId=${ctx.agentId}, messageChannel=${ctx.messageChannel}, agentAccountId=${ctx.agentAccountId}, workspaceDir=${ctx.workspaceDir}`);
        }

        if (!params.resume_session_id && !params.force_new_session) {
          const linked = findLinkedSessionMatches({
            list: typeof sessionManager.list === "function"
              ? sessionManager.list.bind(sessionManager)
              : () => [],
            listPersistedSessions: typeof sessionManager.listPersistedSessions === "function"
              ? sessionManager.listPersistedSessions.bind(sessionManager)
              : () => [],
          }, {
            workdir,
            originSessionKey,
            originChannel,
            originThreadId: parseThreadIdFromSessionKey(originSessionKey) ?? resolveOriginThreadId(ctx),
          });
          if (linked.resumable.length > 0 || linked.active.length > 0) {
            const resumableText = linked.resumable.length > 0
              ? [
                `Linked resumable session(s) already exist for this thread/workdir:`,
                summarizeLinkedSessions(linked.resumable),
                ``,
                `Resume the latest one with:`,
                `  agent_respond(session='${linked.resumable[0].ref}', message='<next instruction>')`,
                `Fork from it with:`,
                `  agent_launch(prompt='<new task>', resume_session_id='${linked.resumable[0].ref}', fork_session=true)`,
              ].join("\n")
              : "";
            const activeText = linked.active.length > 0
              ? [
                linked.resumable.length > 0 ? `Linked active session(s):` : `Linked active session(s) already exist for this thread/workdir:`,
                summarizeLinkedSessions(linked.active),
                ``,
                `Send a follow-up instead of launching a duplicate:`,
                `  agent_respond(session='${linked.active[0].ref}', message='<next instruction>')`,
              ].join("\n")
              : "";
            const parts = [
              `Resume-first protection blocked a fresh launch.`,
              ``,
              resumableText,
              activeText,
              [
                `If you intentionally want a brand-new independent session here, call:`,
                `  agent_launch(prompt='<new task>', force_new_session=true)`,
              ].join("\n"),
            ].filter(Boolean);
            return { content: [{ type: "text", text: parts.join("\n\n") }] };
          }
        }

        // Resolve resume_session_id
        let resolvedResumeId = params.resume_session_id;
        const activeResumeSession = resolvedResumeId
          ? sessionManager.resolve(resolvedResumeId)
          : undefined;
        const persistedResumeSession = resolvedResumeId
          ? sessionManager.getPersistedSession(resolvedResumeId)
          : undefined;
        if (resolvedResumeId) {
          const resolved = sessionManager.resolveHarnessSessionId(resolvedResumeId);
          if (!resolved) {
            return { content: [{ type: "text", text: `Error: Could not resolve resume_session_id "${resolvedResumeId}" to a session ID. Use agent_sessions to list available sessions.` }] };
          }
          resolvedResumeId = resolved;
        }
        const { resumeSessionId, clearedPersistedCodexResume } = decideResumeSessionId({
          requestedResumeSessionId: resolvedResumeId,
          activeSession: activeResumeSession
            ? { harnessSessionId: activeResumeSession.backendConversationId ?? activeResumeSession.harnessSessionId }
            : undefined,
          persistedSession: persistedResumeSession
            ? { harness: persistedResumeSession.harness, backendRef: persistedResumeSession.backendRef }
            : undefined,
        });

        const session = sessionManager.spawn({
          prompt: params.prompt,
          name: params.name,
          workdir,
          model: resolvedModel,
          reasoningEffort: resolveReasoningEffortForHarness(harness),
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
          originThreadId: parseThreadIdFromSessionKey(originSessionKey) ?? resolveOriginThreadId(ctx),
          originAgentId: ctx.agentId || undefined,
          originSessionKey,
          route: resolveSessionRoute(ctx, originChannel, originSessionKey),
          harness,
          worktreeStrategy: params.worktree_strategy,
          worktreeBaseBranch: params.worktree_base_branch,
          worktreePrTargetRepo: params.worktree_pr_target_repo,
        });

        const permissionMode = params.permission_mode ?? pluginConfig.permissionMode;
        const planApproval = params.plan_approval ?? pluginConfig.planApproval;
        const launchText = hasFormatLaunchResult(sessionManager)
          ? sessionManager.formatLaunchResult({
              prompt: params.prompt,
              workdir,
              harness,
              permissionMode,
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
              permissionMode,
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
