import { sessionManager } from "./singletons";
import { executeRespond } from "./actions/respond";
import { makeAgentMergeTool } from "./tools/agent-merge";
import { makeAgentPrTool } from "./tools/agent-pr";
import { makeAgentOutputTool } from "./tools/agent-output";
import { CALLBACK_NAMESPACE } from "./interactive-constants";
import type {
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveDiscordHandlerResult,
  PluginInteractiveTelegramHandlerContext,
  PluginInteractiveTelegramHandlerResult,
} from "../api";
import type { PersistedSessionInfo, SessionActionKind, SessionActionToken } from "./types";

type InteractiveChannel = "telegram" | "discord";
type InteractiveCallbackContext = PluginInteractiveTelegramHandlerContext | PluginInteractiveDiscordHandlerContext;
type InteractiveHandlerResult = PluginInteractiveTelegramHandlerResult | PluginInteractiveDiscordHandlerResult;

type PlanDecisionTarget = Pick<
  PersistedSessionInfo,
  "approvalState" | "name" | "pendingPlanApproval" | "planDecisionVersion" | "actionablePlanDecisionVersion"
>;

type InteractiveResponder = {
  editMessage?: (message: { text: string; buttons?: [] }) => Promise<void>;
  clearButtons?: () => Promise<void>;
  clearComponents?: (message?: { text?: string }) => Promise<void>;
  acknowledge?: () => Promise<void>;
};

function parsePayload(payload: string): string | null {
  const tokenId = payload.trim().replace(new RegExp(`^${CALLBACK_NAMESPACE}:`), "");
  return tokenId ? tokenId : null;
}

async function resolveWorktreePrompt(
  ctx: InteractiveCallbackContext,
  text: string,
): Promise<void> {
  const responder = ctx.respond as InteractiveResponder;
  try {
    if (ctx.channel === "telegram" && typeof responder.editMessage === "function") {
      await responder.editMessage({ text, buttons: [] });
      return;
    }
    if (typeof responder.clearComponents === "function") {
      await responder.clearComponents({ text });
      return;
    }
    if (typeof responder.editMessage === "function") {
      await responder.editMessage({ text });
      await clearInteractiveState(ctx);
      return;
    }
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    if (!/message is not modified/i.test(errText)) {
      console.warn(`[callback-handler] Failed to edit worktree prompt: ${errText}`);
    }
  }
  await clearInteractiveState(ctx);
}

/** Extract text from a tool execute result content array. */
function toolResultText(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as { content: unknown[] }).content)
  ) {
    const first = (result as { content: Array<{ text?: unknown }> }).content[0];
    return typeof first?.text === "string" ? first.text : "(done)";
  }
  return "(done)";
}

function isPlanDecisionAction(kind: SessionActionKind): boolean {
  return kind === "plan-approve" || kind === "plan-request-changes" || kind === "plan-reject";
}

function validatePlanDecisionToken(
  token: SessionActionToken,
  session: PlanDecisionTarget | undefined,
): string | undefined {
  if (!isPlanDecisionAction(token.kind)) return undefined;
  if (!session) return "This plan decision is stale because the session is no longer available.";

  if (
    token.planDecisionVersion != null &&
    (session.actionablePlanDecisionVersion ?? session.planDecisionVersion) != null &&
    token.planDecisionVersion !== (session.actionablePlanDecisionVersion ?? session.planDecisionVersion)
  ) {
    return "This plan decision is stale because a newer plan review state already exists.";
  }

  if (!session.pendingPlanApproval) {
    return "This plan is no longer awaiting approval.";
  }

  if (token.kind === "plan-approve" && session.approvalState === "changes_requested" && !session.pendingPlanApproval) {
    return "Changes were already requested for this plan. Wait for the revised plan before approving.";
  }

  if (token.kind === "plan-request-changes" && session.approvalState === "changes_requested") {
    return "Changes were already requested for this plan. Send your feedback to the agent instead.";
  }

  return undefined;
}

function getPayload(ctx: InteractiveCallbackContext): string {
  const callbackPayload = "callback" in ctx ? ctx.callback?.payload : undefined;
  const interactionPayload = "interaction" in ctx ? ctx.interaction?.payload : undefined;
  return callbackPayload ?? interactionPayload ?? "";
}

function isDiscordEmptyMessageError(err: unknown): boolean {
  const errText = err instanceof Error ? err.message : String(err);
  return /empty message/i.test(errText);
}

async function clearInteractiveState(ctx: InteractiveCallbackContext): Promise<void> {
  const responder = ctx.respond as InteractiveResponder;
  if (ctx.channel === "telegram" && typeof responder.clearButtons === "function") {
    await responder.clearButtons();
    return;
  }
  if (typeof responder.clearComponents === "function") {
    try {
      await responder.clearComponents();
      return;
    } catch (err) {
      if (!isDiscordEmptyMessageError(err)) {
        throw err;
      }
      if (typeof responder.acknowledge === "function") {
        await responder.acknowledge();
        return;
      }
      console.warn("[callback-handler] clearComponents failed with empty-message error and no acknowledge fallback available");
    }
  }
  if (typeof responder.clearButtons === "function") {
    await responder.clearButtons();
  }
}

async function replyText(ctx: InteractiveCallbackContext, text: string): Promise<void> {
  if (ctx.channel === "telegram") {
    await ctx.respond.reply({ text });
    return;
  }
  await ctx.respond.reply({ text, ephemeral: true });
}

/**
 * Create the Telegram interactive handler registration for button callbacks.
 *
 * Register via: `api.registerInteractiveHandler(createCallbackHandler())`
 *
 * Flow:
 * 1. Check sender authorization.
 * 2. Treat payload as an opaque action token.
 * 3. Answer callback (clear buttons / remove spinner) immediately.
 * 4. Execute action programmatically.
 * 5. Reply with result in the same Telegram thread.
 *
 * Alice never sees raw callback_data strings.
 */
export function createCallbackHandler(channel: InteractiveChannel = "telegram") {
  return {
    channel,
    namespace: CALLBACK_NAMESPACE,
    handler: async (ctx: InteractiveCallbackContext): Promise<InteractiveHandlerResult> => {
      // Authorization check
      if (!ctx.auth.isAuthorizedSender) {
        await replyText(ctx, "⛔ Unauthorized.");
        return { handled: true };
      }

      const payload = getPayload(ctx);
      const tokenId = parsePayload(payload);
      if (!tokenId) {
        await replyText(ctx, `⚠️ Unrecognized callback payload: "${payload}".`);
        return { handled: true };
      }

      // Guard service initialization
      if (!sessionManager) {
        await replyText(ctx, "⚠️ Code agent service not running.");
        return { handled: true };
      }

      const token = sessionManager.getActionToken(tokenId);
      if (!token) {
        await replyText(ctx, "⚠️ This action is stale or has already been used.");
        return { handled: true };
      }

      const sessionId = token.sessionId;
      const actionSession = sessionManager.resolve?.(sessionId) ?? sessionManager.getPersistedSession?.(sessionId);
      const actionSessionName = actionSession?.name ?? sessionId;
      const invalidPlanDecision = validatePlanDecisionToken(token, actionSession);

      if (invalidPlanDecision) {
        await clearInteractiveState(ctx);
        await replyText(ctx, `⚠️ ${invalidPlanDecision}`);
        return { handled: true };
      }

      const consumedToken = sessionManager.consumeActionToken(tokenId);
      if (!consumedToken) {
        await replyText(ctx, "⚠️ This action is stale or has already been used.");
        return { handled: true };
      }

      // Route action
      switch (consumedToken.kind) {
        case "worktree-merge": {
          await resolveWorktreePrompt(ctx, `✅ Merge selected for [${actionSessionName}]`);
          const result = await makeAgentMergeTool().execute("callback", { session: sessionId });
          await replyText(ctx, toolResultText(result));
          break;
        }

        case "worktree-decide-later": {
          await resolveWorktreePrompt(ctx, `⏭️ Deferred for [${actionSessionName}]`);
          const result = sessionManager.snoozeWorktreeDecision(sessionId);
          await replyText(ctx, result.startsWith("Error") ? result : "⏭️ Snoozed 24h");
          break;
        }

        case "worktree-dismiss": {
          await resolveWorktreePrompt(ctx, `🗑️ Discarded for [${actionSessionName}]`);
          const result = await sessionManager.dismissWorktree(sessionId);
          await replyText(ctx, result.startsWith("Error") ? result : result);
          break;
        }

        case "worktree-create-pr":
        case "worktree-update-pr": {
          await resolveWorktreePrompt(
            ctx,
            token.kind === "worktree-update-pr"
              ? `📬 PR update selected for [${actionSessionName}]`
              : `📬 PR selected for [${actionSessionName}]`,
          );
          // Do NOT pre-clear pendingWorktreeDecisionSince here.
          // For the PR path the worktree directory must stay alive indefinitely so the
          // user can push follow-up commits for PR review.  The worktree directory was
          // already preserved by onSessionTerminal (which skips removeWorktree when
          // pendingWorktreeDecisionSince is set).  agent-pr.ts clears the flag itself
          // on success; if the PR creation fails the flag remains set so reminders
          // continue until the user tries again.
          const result = await makeAgentPrTool().execute("callback", { session: sessionId });
          await replyText(ctx, toolResultText(result));
          break;
        }

        case "worktree-view-pr": {
          await clearInteractiveState(ctx);
          const persisted = sessionManager.getPersistedSession?.(sessionId);
          const url = token.targetUrl ?? persisted?.worktreePrUrl;
          await replyText(ctx, url ? `PR: ${url}` : "⚠️ PR URL is no longer available.");
          break;
        }

        case "plan-approve": {
          await clearInteractiveState(ctx);
          sessionManager.clearPlanDecisionTokens(sessionId);
          const result = await executeRespond(sessionManager, {
            session: sessionId,
            message: "Approved. Go ahead.",
            approve: true,
            userInitiated: true,
          });
          if (result.isError) {
            await replyText(ctx, `⚠️ ${result.text}`);
          }
          break;
        }

        case "plan-reject": {
          await clearInteractiveState(ctx);
          sessionManager.clearPlanDecisionTokens(sessionId);
          const active = sessionManager.resolve(sessionId);
          if (active) {
            active.approvalState = "rejected";
            sessionManager.kill(active.id, "user");
            await replyText(ctx, `❌ Plan rejected for [${active.name}]. Session stopped.`);
          } else {
            const persisted = sessionManager.getPersistedSession?.(sessionId);
            if (persisted) {
              sessionManager.updatePersistedSession?.(sessionId, {
                approvalState: "rejected",
                lifecycle: "terminal",
                pendingPlanApproval: false,
                planApprovalContext: undefined,
                planDecisionVersion: (persisted.planDecisionVersion ?? 0) + 1,
              });
              await replyText(ctx, `❌ Plan rejected for [${persisted.name ?? actionSessionName}]. Session remains stopped.`);
            } else {
              await replyText(ctx, `❌ Plan rejected.`);
            }
          }
          break;
        }

        case "plan-request-changes": {
          await clearInteractiveState(ctx);
          const reviseSession = sessionManager.resolve?.(sessionId);
          const revisePersisted = sessionManager.getPersistedSession?.(sessionId);
          const reviseName = reviseSession?.name ?? revisePersisted?.name ?? sessionId;
          const planDecisionVersion = (reviseSession?.planDecisionVersion ?? revisePersisted?.planDecisionVersion ?? 0) + 1;
          sessionManager.clearPlanDecisionTokens(sessionId);
          sessionManager.updatePersistedSession(sessionId, {
            approvalState: "changes_requested",
            lifecycle: "awaiting_user_input",
            pendingPlanApproval: false,
            planDecisionVersion,
            actionablePlanDecisionVersion: undefined,
            canonicalPlanPromptVersion: undefined,
            approvalPromptRequiredVersion: undefined,
            approvalPromptVersion: undefined,
            approvalPromptStatus: "not_sent",
            approvalPromptTransport: "none",
            approvalPromptMessageKind: "none",
            approvalPromptLastAttemptAt: undefined,
            approvalPromptDeliveredAt: undefined,
            approvalPromptFailedAt: undefined,
          });
          await replyText(ctx, `✏️ Type your revision feedback for [${reviseName}] and I'll forward it to the agent.`);
          break;
        }

        case "monitor-start-plan": {
          await clearInteractiveState(ctx);
          if (!consumedToken.launchPrompt || !consumedToken.launchWorkdir) {
            await replyText(ctx, "⚠️ This release action is missing the plan launch context.");
            break;
          }
          const session = sessionManager.launchMonitorPlan({
            route: consumedToken.route,
            prompt: consumedToken.launchPrompt,
            workdir: consumedToken.launchWorkdir,
            name: consumedToken.launchName,
          });
          await replyText(ctx, `▶️ Planning session started: ${session.name} [${session.id}]`);
          break;
        }

        case "monitor-dismiss": {
          await clearInteractiveState(ctx);
          await replyText(ctx, `✅ Dismissed.`);
          break;
        }

        case "session-restart":
        case "session-resume": {
          await clearInteractiveState(ctx);
          const result = await executeRespond(sessionManager, {
            session: sessionId,
            message: "Continue where you left off.",
            userInitiated: true,
          });
          await replyText(ctx, result.isError ? `⚠️ ${result.text}` : `▶️ ${result.text}`);
          break;
        }

        case "view-output": {
          await clearInteractiveState(ctx);
          const result = await makeAgentOutputTool().execute("callback", { session: sessionId, lines: 50 });
          await replyText(ctx, toolResultText(result));
          break;
        }

        case "question-answer": {
          await clearInteractiveState(ctx);
          if (token.optionIndex == null) {
            await replyText(ctx, `⚠️ Invalid question-answer action.`);
            break;
          }
          await sessionManager.resolvePendingInputOption(sessionId, token.optionIndex);
          await replyText(ctx, `✅ Answer submitted.`);
          break;
        }

        default: {
          await clearInteractiveState(ctx);
          await replyText(ctx, `⚠️ Unknown callback action.`);
          break;
        }
      }

      return { handled: true };
    },
  };
}
