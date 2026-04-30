import { Type } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import { resolveSessionRoute } from "../config";
import { WORKTREE_STRATEGY_SET } from "../types";
import type { OpenClawPluginToolContext, SessionRoute, WorktreeStrategy } from "../types";

function isWorktreeStrategy(value: unknown): value is WorktreeStrategy {
  return typeof value === "string" && WORKTREE_STRATEGY_SET.has(value as WorktreeStrategy);
}

interface AgentSendMonitorReportParams {
  report_id: string;
  report_text: string;
  plan_prompt: string;
  plan_workdir: string;
  plan_worktree_strategy?: WorktreeStrategy;
  plan_name?: string;
  target_channel?: string;
  target_thread_id?: string | number;
  target_session_key?: string;
}

function isAgentSendMonitorReportParams(value: unknown): value is AgentSendMonitorReportParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.report_id === "string"
    && typeof params.report_text === "string"
    && typeof params.plan_prompt === "string"
    && typeof params.plan_workdir === "string"
    && (params.plan_worktree_strategy == null || isWorktreeStrategy(params.plan_worktree_strategy))
    && (params.plan_name == null || typeof params.plan_name === "string")
    && (params.target_channel == null || typeof params.target_channel === "string")
    && (params.target_thread_id == null || typeof params.target_thread_id === "string" || typeof params.target_thread_id === "number")
    && (params.target_session_key == null || typeof params.target_session_key === "string");
}

function resolveRoute(ctx: OpenClawPluginToolContext, params: AgentSendMonitorReportParams): SessionRoute | undefined {
  const route = resolveSessionRoute(ctx, params.target_channel, params.target_session_key);
  if (!route) return undefined;
  if (params.target_thread_id != null) {
    route.threadId = String(params.target_thread_id);
  }
  return route;
}

export function makeAgentSendMonitorReportTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "agent_send_monitor_report",
    description:
      "Post a monitor report to the current or explicit chat route with human-gated inline buttons. Use this for release reports that should offer a Start Plan action directly in Telegram.",
    parameters: Type.Object({
      report_id: Type.String({ description: "Stable report identifier, for example 'openclaw-release-v2026.3.31'." }),
      report_text: Type.String({ description: "Final user-facing report text to deliver." }),
      plan_prompt: Type.String({ description: "Prompt to seed into the plan-only session when the user clicks Start Plan." }),
      plan_workdir: Type.String({ description: "Working directory for the planning session." }),
      plan_worktree_strategy: Type.Optional(Type.Union([
        Type.Literal("off"),
        Type.Literal("manual"),
        Type.Literal("ask"),
        Type.Literal("delegate"),
        Type.Literal("auto-merge"),
        Type.Literal("auto-pr"),
      ], { description: "Optional worktree strategy for the planning session. Use auto-pr for monitor follow-up that should branch and open/update a PR after approved implementation." })),
      plan_name: Type.Optional(Type.String({ description: "Optional explicit session name for the planning session." })),
      target_channel: Type.Optional(Type.String({ description: "Optional explicit route like 'telegram|-1003863755361'." })),
      target_thread_id: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Optional explicit topic/thread id." })),
      target_session_key: Type.Optional(Type.String({ description: "Optional explicit session key for wake routing." })),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentSendMonitorReportParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { report_id, report_text, plan_prompt, plan_workdir }." }] };
      }
      const route = resolveRoute(ctx, params);
      if (!route?.provider || !route.target) {
        return { content: [{ type: "text", text: "Error: Could not resolve a direct delivery route for the monitor report." }] };
      }

      sessionManager.sendMonitorReport({
        reportId: params.report_id,
        route,
        text: params.report_text,
        planName: params.plan_name ?? params.report_id,
        planPrompt: params.plan_prompt,
        planWorkdir: params.plan_workdir,
        planWorktreeStrategy: params.plan_worktree_strategy,
      });

      return {
        content: [{
          type: "text",
          text: `Interactive monitor report queued for ${route.provider}|${route.target}${route.threadId ? `#${route.threadId}` : ""}.`,
        }],
      };
    },
  };
}
