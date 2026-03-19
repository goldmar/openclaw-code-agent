import { existsSync } from "fs";
import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
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
  resolveReasoningEffortForHarness,
  resolveToolChannel,
} from "../config";
import { decideResumeSessionId } from "../resume-policy";
import type { OpenClawPluginToolContext } from "../types";

interface AgentLaunchParams {
  prompt: string;
  name?: string;
  workdir?: string;
  model?: string;
  system_prompt?: string;
  allowed_tools?: string[];
  resume_session_id?: string;
  fork_session?: boolean;
  multi_turn_disabled?: boolean;
  permission_mode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  harness?: string;
  worktree?: boolean;
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
      "Launch a coding agent session in background to execute a development task. Sessions are multi-turn by default — they stay open for follow-up messages via agent_respond. Set multi_turn_disabled: true for fire-and-forget sessions. Supports resuming previous sessions. Returns a session ID and name for tracking.",
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
        Type.String({ description: "Session ID to resume (from a previous session's harnessSessionId). Continues the conversation from where it left off." }),
      ),
      fork_session: Type.Optional(
        Type.Boolean({ description: "When resuming, fork to a new session instead of continuing the existing one. Use with resume_session_id." }),
      ),
      multi_turn_disabled: Type.Optional(
        Type.Boolean({ description: "Disable multi-turn mode. By default sessions stay open for follow-up messages. Set to true for fire-and-forget sessions." }),
      ),
      permission_mode: Type.Optional(
        Type.Union(
          [Type.Literal("default"), Type.Literal("plan"), Type.Literal("acceptEdits"), Type.Literal("bypassPermissions")],
          { description: "Permission mode for the session. This is the plugin's orchestration mode, not the Codex SDK approval policy. Defaults to plugin config (plan by default)." },
        ),
      ),
      harness: Type.Optional(
        Type.String({ description: "Agent harness to use (e.g. 'claude-code'). Defaults to 'claude-code'." }),
      ),
      worktree: Type.Optional(
        Type.Boolean({ description: "Control git worktree behavior. true=auto-create worktree, false=skip. Defaults to auto-detect (creates worktree if workdir is a git repo with a remote)." }),
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

      const workdir = params.workdir || ctx.workspaceDir || pluginConfig.defaultWorkdir || process.cwd();

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
            ? { harnessSessionId: activeResumeSession.harnessSessionId }
            : undefined,
          persistedSession: persistedResumeSession
            ? { harness: persistedResumeSession.harness }
            : undefined,
        });

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

        const session = sessionManager.spawn({
          prompt: params.prompt,
          name: params.name,
          workdir,
          model: resolvedModel,
          reasoningEffort: resolveReasoningEffortForHarness(harness),
          systemPrompt: params.system_prompt,
          allowedTools: params.allowed_tools,
          resumeSessionId,
          forkSession: resumeSessionId ? params.fork_session : false,
          multiTurn: !params.multi_turn_disabled,
          permissionMode: params.permission_mode,
          codexApprovalPolicy: harness === "codex"
            ? (resolveApprovalPolicyForHarness(harness) ?? pluginConfig.codexApprovalPolicy)
            : undefined,
          originChannel,
          originThreadId: parseThreadIdFromSessionKey(originSessionKey) ?? resolveOriginThreadId(ctx),
          originAgentId: ctx.agentId || undefined,
          originSessionKey,
          harness,
          worktree: params.worktree,
        });

        const promptSummary = params.prompt.length > 80 ? params.prompt.slice(0, 80) + "..." : params.prompt;
        const details = [
          `Session launched successfully.`,
          `  Name: ${session.name}`,
          `  ID: ${session.id}`,
          `  Dir: ${workdir}`,
          `  Model: ${session.model ?? "default"}`,
          `  Prompt: "${promptSummary}"`,
        ];
        if (harness === "codex") {
          details.push(`  Codex approval policy: ${session.codexApprovalPolicy ?? resolveApprovalPolicyForHarness(harness) ?? pluginConfig.codexApprovalPolicy}`);
        }
        if (params.resume_session_id) {
          details.push(`  Resume: ${params.resume_session_id}${params.fork_session ? " (forked)" : ""}`);
          if (clearedPersistedCodexResume) {
            details.push(`  Thread state: historical Codex state cleared; starting a fresh thread.`);
          }
        }
        details.push(params.multi_turn_disabled
          ? `  Mode: single-turn (fire-and-forget)`
          : `  Mode: multi-turn (use agent_respond to send follow-up messages)`);
        details.push(``, `Use agent_sessions to check status, agent_output to see output.`);

        return { content: [{ type: "text", text: details.join("\n") }] };
      } catch (err: unknown) {
        const message = errorMessage(err);
        const hint = message.includes("Max sessions") ? "" : "\n\nUse agent_sessions to see active sessions and their status.";
        return { content: [{ type: "text", text: `Error launching session: ${message}${hint}` }] };
      }
    },
  };
}
