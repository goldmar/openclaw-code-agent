import { Type } from "@sinclair/typebox";
import type { OpenClawPluginToolContext } from "../types";
import {
  executePlanOffer,
  isAgentSendMonitorReportParams,
  monitorReportToPlanOfferParams,
} from "./agent-send-plan-offer";

export function makeAgentSendMonitorReportTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "agent_send_monitor_report",
    description:
      "Compatibility alias for agent_send_plan_offer. Posts a user-facing message with Start Plan and Dismiss inline buttons that launch a plan-only code-agent session.",
    parameters: Type.Object({
      report_id: Type.String({ description: "Stable report identifier." }),
      report_text: Type.String({ description: "Final user-facing text to deliver." }),
      plan_prompt: Type.String({ description: "Prompt to seed into the plan-only session when the user clicks Start Plan." }),
      plan_workdir: Type.String({ description: "Working directory for the planning session." }),
      plan_worktree_strategy: Type.Optional(Type.Union([
        Type.Literal("off"),
        Type.Literal("manual"),
        Type.Literal("ask"),
        Type.Literal("delegate"),
        Type.Literal("auto-merge"),
        Type.Literal("auto-pr"),
      ], { description: "Optional worktree strategy for the planning session." })),
      plan_name: Type.Optional(Type.String({ description: "Optional explicit session name for the planning session." })),
      target_channel: Type.Optional(Type.String({ description: "Optional explicit route like 'telegram|-1003863755361'." })),
      target_thread_id: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Optional explicit topic/thread id." })),
      target_session_key: Type.Optional(Type.String({ description: "Optional explicit session key for wake routing." })),
    }),
    async execute(_id: string, params: unknown) {
      if (!isAgentSendMonitorReportParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { report_id, report_text, plan_prompt, plan_workdir }." }] };
      }
      const result = await executePlanOffer(ctx, monitorReportToPlanOfferParams(params));
      const text = result.content[0]?.text.replace("plan offer", "monitor report") ?? "";
      return { content: [{ type: "text", text }] };
    },
  };
}
