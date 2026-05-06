import { Type, type TLiteral } from "@sinclair/typebox";
import { sessionManager } from "../singletons";
import { resolveSessionRoute } from "../config";
import { WORKTREE_STRATEGIES, WORKTREE_STRATEGY_SET } from "../types";
import type { OpenClawPluginToolContext, SessionRoute, WorktreeStrategy } from "../types";

function isWorktreeStrategy(value: unknown): value is WorktreeStrategy {
  return typeof value === "string" && WORKTREE_STRATEGY_SET.has(value as WorktreeStrategy);
}

const WORKTREE_STRATEGY_SCHEMA = Type.Union(
  WORKTREE_STRATEGIES.map((strategy) => Type.Literal(strategy)) as [
    TLiteral<WorktreeStrategy>,
    ...TLiteral<WorktreeStrategy>[],
  ],
  { description: "Optional worktree strategy for the planning session. Use auto-pr when the follow-up should branch and open/update a PR after approved implementation." },
);

interface AgentSendPlanOfferParams {
  offer_id: string;
  offer_text: string;
  plan_prompt: string;
  plan_workdir: string;
  plan_worktree_strategy?: WorktreeStrategy;
  plan_name?: string;
  target_channel?: string;
  target_thread_id?: string | number;
  target_session_key?: string;
}

function isAgentSendPlanOfferParams(value: unknown): value is AgentSendPlanOfferParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.offer_id === "string"
    && typeof params.offer_text === "string"
    && typeof params.plan_prompt === "string"
    && typeof params.plan_workdir === "string"
    && (params.plan_worktree_strategy == null || isWorktreeStrategy(params.plan_worktree_strategy))
    && (params.plan_name == null || typeof params.plan_name === "string")
    && (params.target_channel == null || typeof params.target_channel === "string")
    && (params.target_thread_id == null || typeof params.target_thread_id === "string" || typeof params.target_thread_id === "number")
    && (params.target_session_key == null || typeof params.target_session_key === "string");
}

function resolveRoute(ctx: OpenClawPluginToolContext, params: Pick<AgentSendPlanOfferParams, "target_channel" | "target_session_key" | "target_thread_id">): SessionRoute | undefined {
  const route = resolveSessionRoute(ctx, params.target_channel, params.target_session_key);
  if (!route) return undefined;
  if (params.target_thread_id != null) {
    route.threadId = String(params.target_thread_id);
  }
  return route;
}

export async function executePlanOffer(
  ctx: OpenClawPluginToolContext,
  params: AgentSendPlanOfferParams,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!sessionManager) {
    return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
  }
  const route = resolveRoute(ctx, params);
  if (!route?.provider || !route.target) {
    return { content: [{ type: "text", text: "Error: Could not resolve a direct delivery route for the plan offer." }] };
  }

  sessionManager.sendPlanOffer({
    offerId: params.offer_id,
    route,
    text: params.offer_text,
    planName: params.plan_name ?? params.offer_id,
    planPrompt: params.plan_prompt,
    planWorkdir: params.plan_workdir,
    planWorktreeStrategy: params.plan_worktree_strategy,
  });

  return {
    content: [{
      type: "text",
      text: `Interactive plan offer queued for ${route.provider}|${route.target}${route.threadId ? `#${route.threadId}` : ""}.`,
    }],
  };
}

export function makeAgentSendPlanOfferTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "agent_send_plan_offer",
    description:
      "Post a user-facing message to the current or explicit chat route with human-gated Start Plan and Dismiss inline buttons. Use this when an external workflow wants the user to open a plan-only code-agent session from the message.",
    parameters: Type.Object({
      offer_id: Type.String({ description: "Stable offer identifier, for example 'plugin-readiness-v2026.5.5'." }),
      offer_text: Type.String({ description: "Final user-facing text to deliver." }),
      plan_prompt: Type.String({ description: "Prompt to seed into the plan-only session when the user clicks Start Plan." }),
      plan_workdir: Type.String({ description: "Working directory for the planning session." }),
      plan_worktree_strategy: Type.Optional(WORKTREE_STRATEGY_SCHEMA),
      plan_name: Type.Optional(Type.String({ description: "Optional explicit session name for the planning session." })),
      target_channel: Type.Optional(Type.String({ description: "Optional explicit route like 'telegram|-1003863755361'." })),
      target_thread_id: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Optional explicit topic/thread id." })),
      target_session_key: Type.Optional(Type.String({ description: "Optional explicit session key for wake routing." })),
    }),
    async execute(_id: string, params: unknown) {
      if (!isAgentSendPlanOfferParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { offer_id, offer_text, plan_prompt, plan_workdir }." }] };
      }
      return executePlanOffer(ctx, params);
    },
  };
}
