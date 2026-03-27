import { sessionManager } from "./singletons";
import { executeRespond } from "./actions/respond";
import { makeAgentMergeTool } from "./tools/agent-merge";
import { makeAgentPrTool } from "./tools/agent-pr";
import { makeAgentOutputTool } from "./tools/agent-output";
import { CALLBACK_NAMESPACE } from "./interactive-constants";
import type { PersistedSessionInfo, SessionActionKind, SessionActionToken } from "./types";

/**
 * Minimal Telegram callback handler context (mirrors OpenClaw's
 * PluginInteractiveTelegramHandlerContext — no import from OpenClaw internals needed).
 */
interface TelegramCallbackContext {
  auth: { isAuthorizedSender: boolean };
  callback: { payload: string };
  respond: {
    reply: (params: { text: string }) => Promise<void>;
    clearButtons: () => Promise<void>;
    editMessage?: (params: { text: string; buttons?: Array<Array<{ label: string; callbackData: string }>> }) => Promise<void>;
  };
}

type InteractiveChannel = "telegram" | "discord";

type PlanDecisionTarget = Pick<
  PersistedSessionInfo,
  "approvalState" | "name" | "pendingPlanApproval" | "planDecisionVersion"
>;

function parsePayload(payload: string): string | null {
  const tokenId = payload.trim().replace(new RegExp(`^${CALLBACK_NAMESPACE}:`), "");
  return tokenId ? tokenId : null;
}

async function resolveWorktreePrompt(
  ctx: TelegramCallbackContext,
  text: string,
): Promise<void> {
  if (typeof ctx.respond.editMessage === "function") {
    try {
      await ctx.respond.editMessage({ text, buttons: [] });
      return;
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      if (!/message is not modified/i.test(errText)) {
        console.warn(`[callback-handler] Failed to edit worktree prompt: ${errText}`);
      }
    }
  }
  await ctx.respond.clearButtons();
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
    session.planDecisionVersion != null &&
    token.planDecisionVersion !== session.planDecisionVersion
  ) {
    return "This plan decision is stale because a newer plan review state already exists.";
  }

  if (!session.pendingPlanApproval) {
    return "This plan is no longer awaiting approval.";
  }

  if (token.kind === "plan-approve" && session.approvalState === "changes_requested") {
    return "Changes were already requested for this plan. Wait for the revised plan before approving.";
  }

  if (token.kind === "plan-request-changes" && session.approvalState === "changes_requested") {
    return "Changes were already requested for this plan. Send your feedback to the agent instead.";
  }

  return undefined;
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
    handler: async (ctx: TelegramCallbackContext): Promise<{ handled?: boolean } | void> => {
      // Authorization check
      if (!ctx.auth.isAuthorizedSender) {
        await ctx.respond.reply({ text: "⛔ Unauthorized." });
        return { handled: true };
      }

      const tokenId = parsePayload(ctx.callback.payload);
      if (!tokenId) {
        await ctx.respond.reply({
          text: `⚠️ Unrecognized callback payload: "${ctx.callback.payload}".`,
        });
        return { handled: true };
      }

      // Guard service initialization
      if (!sessionManager) {
        await ctx.respond.reply({ text: "⚠️ Code agent service not running." });
        return { handled: true };
      }

      const token = sessionManager.consumeActionToken(tokenId);
      if (!token) {
        await ctx.respond.reply({ text: "⚠️ This action is stale or has already been used." });
        return { handled: true };
      }

      const sessionId = token.sessionId;
      const actionSession = sessionManager.resolve?.(sessionId) ?? sessionManager.getPersistedSession?.(sessionId);
      const actionSessionName = actionSession?.name ?? sessionId;
      const invalidPlanDecision = validatePlanDecisionToken(token, actionSession);

      if (invalidPlanDecision) {
        await ctx.respond.clearButtons();
        await ctx.respond.reply({ text: `⚠️ ${invalidPlanDecision}` });
        return { handled: true };
      }

      // Route action
      switch (token.kind) {
        case "worktree-merge": {
          await resolveWorktreePrompt(ctx, `✅ Merge selected for [${actionSessionName}]`);
          const result = await makeAgentMergeTool().execute("callback", { session: sessionId });
          await ctx.respond.reply({ text: toolResultText(result) });
          break;
        }

        case "worktree-decide-later": {
          await resolveWorktreePrompt(ctx, `⏭️ Deferred for [${actionSessionName}]`);
          const result = sessionManager.snoozeWorktreeDecision(sessionId);
          await ctx.respond.reply({ text: result.startsWith("Error") ? result : "⏭️ Snoozed 24h" });
          break;
        }

        case "worktree-dismiss": {
          await resolveWorktreePrompt(ctx, `🗑️ Discarded for [${actionSessionName}]`);
          const result = await sessionManager.dismissWorktree(sessionId);
          await ctx.respond.reply({ text: result.startsWith("Error") ? result : result });
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
          await ctx.respond.reply({ text: toolResultText(result) });
          break;
        }

        case "worktree-view-pr": {
          await ctx.respond.clearButtons();
          const persisted = sessionManager.getPersistedSession?.(sessionId);
          const url = token.targetUrl ?? persisted?.worktreePrUrl;
          await ctx.respond.reply({ text: url ? `PR: ${url}` : "⚠️ PR URL is no longer available." });
          break;
        }

        case "plan-approve": {
          await ctx.respond.clearButtons();
          const result = await executeRespond(sessionManager, {
            session: sessionId,
            message: "Approved. Go ahead.",
            approve: true,
            userInitiated: true,
          });
          await ctx.respond.reply({ text: result.isError ? `⚠️ ${result.text}` : `👍 ${result.text}` });
          break;
        }

        case "plan-reject": {
          await ctx.respond.clearButtons();
          const active = sessionManager.resolve(sessionId);
          if (active) {
            active.approvalState = "rejected";
            sessionManager.kill(active.id, "user");
            await ctx.respond.reply({ text: `❌ Plan rejected for [${active.name}]. Session stopped.` });
          } else {
            await ctx.respond.reply({ text: `❌ Plan rejected.` });
          }
          break;
        }

        case "plan-request-changes": {
          await ctx.respond.clearButtons();
          const reviseSession = sessionManager.resolve?.(sessionId);
          const revisePersisted = sessionManager.getPersistedSession?.(sessionId);
          const reviseName = reviseSession?.name ?? revisePersisted?.name ?? sessionId;
          const planDecisionVersion = (reviseSession?.planDecisionVersion ?? revisePersisted?.planDecisionVersion ?? 0) + 1;
          sessionManager.updatePersistedSession(sessionId, {
            approvalState: "changes_requested",
            lifecycle: "awaiting_plan_decision",
            pendingPlanApproval: true,
            planDecisionVersion,
          });
          await ctx.respond.reply({
            text: `✏️ Type your revision feedback for [${reviseName}] and I'll forward it to the agent.`,
          });
          break;
        }

        case "session-restart":
        case "session-resume": {
          await ctx.respond.clearButtons();
          const result = await executeRespond(sessionManager, {
            session: sessionId,
            message: "Continue where you left off.",
            userInitiated: true,
          });
          await ctx.respond.reply({ text: result.isError ? `⚠️ ${result.text}` : `▶️ ${result.text}` });
          break;
        }

        case "view-output": {
          await ctx.respond.clearButtons();
          const result = await makeAgentOutputTool().execute("callback", { session: sessionId, lines: 50 });
          await ctx.respond.reply({ text: toolResultText(result) });
          break;
        }

        case "question-answer": {
          await ctx.respond.clearButtons();
          if (token.optionIndex == null) {
            await ctx.respond.reply({ text: `⚠️ Invalid question-answer action.` });
            break;
          }
          await sessionManager.resolvePendingInputOption(sessionId, token.optionIndex);
          await ctx.respond.reply({ text: `✅ Answer submitted.` });
          break;
        }

        default: {
          await ctx.respond.clearButtons();
          await ctx.respond.reply({
            text: `⚠️ Unknown callback action.`,
          });
          break;
        }
      }

      return { handled: true };
    },
  };
}
