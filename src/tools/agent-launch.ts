import { existsSync } from "fs";
import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import { pluginConfig, resolveOriginChannel, resolveAgentChannel, parseThreadIdFromSessionKey, resolveToolChannel } from "../config";
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
  notify_on_turn_end?: boolean;
  permission_mode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  harness?: string;
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
      notify_on_turn_end: Type.Optional(
        Type.Boolean({ description: "Send wake notifications at every turn end. Defaults to true." }),
      ),
      permission_mode: Type.Optional(
        Type.Union(
          [Type.Literal("default"), Type.Literal("plan"), Type.Literal("acceptEdits"), Type.Literal("bypassPermissions")],
          { description: "Permission mode for the session. Defaults to plugin config (plan by default)." },
        ),
      ),
      harness: Type.Optional(
        Type.String({ description: "Agent harness to use (e.g. 'claude-code'). Defaults to 'claude-code'." }),
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
        const harness = params.harness ?? pluginConfig.defaultHarness;
        const defaultModel = harness === "codex"
          ? (pluginConfig.model ?? pluginConfig.defaultModel)
          : pluginConfig.defaultModel;

        // Resolve resume_session_id
        let resolvedResumeId = params.resume_session_id;
        if (resolvedResumeId) {
          const resolved = sessionManager.resolveHarnessSessionId(resolvedResumeId);
          if (!resolved) {
            return { content: [{ type: "text", text: `Error: Could not resolve resume_session_id "${resolvedResumeId}" to a session ID. Use agent_sessions to list available sessions.` }] };
          }
          resolvedResumeId = resolved;
        }

        // Resolve origin channel
        const ctxChannel = resolveToolChannel(ctx);
        const originChannel = resolveOriginChannel({ id: _id }, ctxChannel || resolveAgentChannel(workdir));

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
          model: params.model ?? defaultModel,
          reasoningEffort: pluginConfig.reasoningEffort,
          systemPrompt: params.system_prompt,
          allowedTools: params.allowed_tools,
          resumeSessionId: resolvedResumeId,
          forkSession: params.fork_session,
          multiTurn: !params.multi_turn_disabled,
          notifyOnTurnEnd: params.notify_on_turn_end ?? true,
          permissionMode: params.permission_mode,
          originChannel,
          originThreadId: parseThreadIdFromSessionKey(originSessionKey),
          originAgentId: ctx.agentId || undefined,
          originSessionKey,
          harness,
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
        if (params.resume_session_id) {
          details.push(`  Resume: ${params.resume_session_id}${params.fork_session ? " (forked)" : ""}`);
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
