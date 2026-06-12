import { sessionManager } from "./singletons";
import { executeRespond, rejectPlanDecision, requestPlanDecisionChanges } from "./actions/respond";
import { makeAgentMergeTool } from "./tools/agent-merge";
import { makeAgentPrTool } from "./tools/agent-pr";
import { makeAgentOutputTool } from "./tools/agent-output";
import { hashDiagnosticToken, logButtonDiagnostic } from "./button-diagnostics";
import { CALLBACK_NAMESPACE } from "./interactive-constants";
import type {
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveDiscordHandlerResult,
  PluginInteractiveTelegramHandlerContext,
  PluginInteractiveTelegramHandlerResult,
} from "../api";
import type { PersistedSessionInfo, SessionActionKind, SessionActionToken } from "./types";
import { getRepoPolicyOption, validateRepoPolicyForPrAvailability } from "./repo-policy";

type InteractiveChannel = "telegram" | "discord";
type InteractiveCallbackContext = PluginInteractiveTelegramHandlerContext | PluginInteractiveDiscordHandlerContext;
type InteractiveHandlerResult = PluginInteractiveTelegramHandlerResult | PluginInteractiveDiscordHandlerResult;
type CallbackHandlerDependencies = {
  makeAgentMergeTool?: typeof makeAgentMergeTool;
  makeAgentPrTool?: typeof makeAgentPrTool;
};

type PlanDecisionTarget = Pick<
  PersistedSessionInfo,
  | "approvalState"
  | "name"
  | "pendingPlanApproval"
  | "planDecisionVersion"
  | "actionablePlanDecisionVersion"
  | "approvalPromptRequiredVersion"
  | "approvalPromptVersion"
  | "canonicalPlanPromptVersion"
>;

type InteractiveResponder = {
  editMessage?: (message: { text: string; buttons?: [] }) => Promise<void>;
  editButtons?: (message: { buttons: [] }) => Promise<void>;
  clearButtons?: () => Promise<void>;
  clearComponents?: (message?: { text?: string }) => Promise<void>;
  acknowledge?: () => Promise<void>;
};

function parsePayload(payload: string): string | null {
  const tokenId = payload.trim().replace(new RegExp(`^${CALLBACK_NAMESPACE}:`), "");
  return tokenId ? tokenId : null;
}

async function clearWorktreeDecisionButtons(
  ctx: InteractiveCallbackContext,
  alreadyAcknowledged = false,
): Promise<boolean> {
  if (ctx.channel === "telegram") {
    try {
      const result = await clearInteractiveState(ctx, { alreadyAcknowledged, forceTelegramMarkupEdit: true });
      return result.textDelivered;
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      console.warn(`[callback-handler] Failed to clear Telegram worktree prompt buttons: ${errText}`);
      return false;
    }
  }

  const responder = ctx.respond as InteractiveResponder;
  if (typeof responder.clearComponents === "function") {
    try {
      await responder.clearComponents();
      return false;
    } catch (err) {
      if (isMessageNotModifiedError(err)) return false;
      const errText = err instanceof Error ? err.message : String(err);
      console.warn(`[callback-handler] Failed to clear Discord worktree components: ${errText}`);
    }
  }

  if (typeof responder.clearButtons === "function") {
    try {
      await responder.clearButtons();
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      console.warn(`[callback-handler] Failed to clear Discord worktree buttons: ${errText}`);
    }
  } else if (!alreadyAcknowledged && typeof responder.acknowledge === "function") {
    await responder.acknowledge();
  }
  return false;
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

function toolResultSucceeded(result: unknown): boolean {
  if (result && typeof result === "object" && "meta" in result) {
    const meta = (result as { meta?: { success?: unknown } }).meta;
    if (typeof meta?.success === "boolean") return meta.success;
  }
  return worktreeActionTextSucceeded(toolResultText(result));
}

function worktreeActionTextSucceeded(text: string): boolean {
  return !/^\s*(?:Error\b:?|❌|⚠️)/.test(text);
}

function isPlanDecisionAction(kind: SessionActionKind): boolean {
  return kind === "plan-approve" || kind === "plan-request-changes" || kind === "plan-reject";
}

function latestDefinedVersion(...versions: Array<number | undefined>): number | undefined {
  let latest: number | undefined;
  for (const version of versions) {
    if (version == null) continue;
    latest = latest == null ? version : Math.max(latest, version);
  }
  return latest;
}

function resolveCurrentPlanDecisionVersion(session: PlanDecisionTarget): number | undefined {
  if (session.actionablePlanDecisionVersion != null) return session.actionablePlanDecisionVersion;

  const deliveryVersion = latestDefinedVersion(
    session.approvalPromptRequiredVersion,
    session.approvalPromptVersion,
  );
  if (deliveryVersion != null) return deliveryVersion;

  return session.canonicalPlanPromptVersion ?? session.planDecisionVersion;
}

function validatePlanDecisionToken(
  token: SessionActionToken,
  session: PlanDecisionTarget | undefined,
): string | undefined {
  if (!isPlanDecisionAction(token.kind)) return undefined;
  if (!session) return "This plan decision is stale because the session is no longer available.";

  const currentPlanDecisionVersion = resolveCurrentPlanDecisionVersion(session);

  if (
    token.planDecisionVersion != null &&
    currentPlanDecisionVersion != null &&
    token.planDecisionVersion !== currentPlanDecisionVersion
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
  const callbackPayload = "callback" in ctx
    ? (ctx.callback?.payload ?? ctx.callback?.data)
    : undefined;
  const interactionPayload = "interaction" in ctx ? ctx.interaction?.payload : undefined;
  return callbackPayload ?? interactionPayload ?? "";
}

function isMessageNotModifiedError(err: unknown): boolean {
  const errText = err instanceof Error ? err.message : String(err);
  return /message is not modified/i.test(errText);
}

function isDiscordEmptyMessageError(err: unknown): boolean {
  const errText = err instanceof Error ? err.message : String(err);
  return /empty message/i.test(errText);
}

async function clearInteractiveState(
  ctx: InteractiveCallbackContext,
  options: { text?: string; alreadyAcknowledged?: boolean; forceTelegramMarkupEdit?: boolean } = {},
): Promise<{ textDelivered: boolean }> {
  const responder = ctx.respond as InteractiveResponder;
  const { alreadyAcknowledged = false, forceTelegramMarkupEdit = false, text } = options;

  if (ctx.channel === "telegram") {
    if (typeof text === "string" && typeof responder.editMessage === "function") {
      try {
        await responder.editMessage({ text, buttons: [] });
        if (typeof responder.clearButtons === "function") {
          await responder.clearButtons();
        }
        return { textDelivered: true };
      } catch (err) {
        if (isMessageNotModifiedError(err)) {
          if (typeof responder.clearButtons === "function") {
            await responder.clearButtons();
          }
          return { textDelivered: true };
        }
        const errText = err instanceof Error ? err.message : String(err);
        console.warn(`[callback-handler] Failed to edit Telegram worktree prompt before clearing buttons: ${errText}`);
      }
    }
    if (forceTelegramMarkupEdit && typeof responder.editButtons === "function") {
      try {
        await responder.editButtons({ buttons: [] });
        if (typeof responder.clearButtons === "function") {
          await responder.clearButtons();
        }
        return { textDelivered: false };
      } catch (err) {
        if (isMessageNotModifiedError(err)) {
          if (typeof responder.clearButtons === "function") {
            await responder.clearButtons();
          }
          return { textDelivered: false };
        }
        const errText = err instanceof Error ? err.message : String(err);
        console.warn(`[callback-handler] Failed to edit Telegram button markup before clearing buttons: ${errText}`);
      }
    }
    const callbackMessageText = "callback" in ctx && typeof ctx.callback?.messageText === "string"
      ? ctx.callback.messageText
      : undefined;
    if (
      forceTelegramMarkupEdit
      && typeof callbackMessageText === "string"
      && typeof responder.editMessage === "function"
    ) {
      try {
        await responder.editMessage({ text: callbackMessageText, buttons: [] });
        if (typeof responder.clearButtons === "function") {
          await responder.clearButtons();
        }
        return { textDelivered: false };
      } catch (err) {
        if (isMessageNotModifiedError(err)) {
          if (typeof responder.clearButtons === "function") {
            await responder.clearButtons();
          }
          return { textDelivered: false };
        }
        const errText = err instanceof Error ? err.message : String(err);
        console.warn(`[callback-handler] Failed to edit Telegram message markup before clearing buttons: ${errText}`);
      }
    }
    if (typeof responder.clearButtons === "function") {
      await responder.clearButtons();
    }
    return { textDelivered: false };
  }

  if (typeof responder.clearComponents === "function") {
    try {
      await responder.clearComponents(typeof text === "string" ? { text } : undefined);
      return { textDelivered: typeof text === "string" };
    } catch (err) {
      if (isMessageNotModifiedError(err)) return { textDelivered: typeof text === "string" };

      if (isDiscordEmptyMessageError(err)) {
        if (typeof text !== "string" && alreadyAcknowledged) {
          return { textDelivered: false };
        }
        if (typeof text !== "string" && typeof responder.acknowledge === "function") {
          await responder.acknowledge();
          return { textDelivered: false };
        }
        if (typeof text !== "string" && typeof responder.acknowledge !== "function") {
          console.warn("[callback-handler] clearComponents failed with empty-message error and no acknowledge fallback available");
        }
      } else if (typeof text !== "string") {
        throw err;
      } else {
        const errText = err instanceof Error ? err.message : String(err);
        console.warn(`[callback-handler] clearComponents failed before text fallback: ${errText}`);
      }
    }
  }

  if (typeof text === "string" && typeof responder.editMessage === "function") {
    try {
      await responder.editMessage({ text });
    } catch (err) {
      if (isMessageNotModifiedError(err)) {
        if (typeof responder.clearButtons === "function") {
          await responder.clearButtons();
        }
        return { textDelivered: true };
      }
      const errText = err instanceof Error ? err.message : String(err);
      console.warn(`[callback-handler] Failed to edit worktree prompt before clearing interactive state: ${errText}`);
      if (typeof responder.clearButtons === "function") {
        await responder.clearButtons();
      }
      return { textDelivered: false };
    }

    if (typeof responder.clearButtons === "function") {
      await responder.clearButtons();
    }
    return { textDelivered: true };
  }

  if (typeof responder.clearButtons === "function") {
    await responder.clearButtons();
  }
  return { textDelivered: false };
}

async function acknowledgeCallback(ctx: InteractiveCallbackContext): Promise<boolean> {
  const responder = ctx.respond as InteractiveResponder;
  if (typeof responder.acknowledge !== "function") return false;

  try {
    await responder.acknowledge();
    return true;
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    console.warn(`[callback-handler] Failed to acknowledge callback before processing: ${errText}`);
    return false;
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
 * 1. Answer callback immediately to remove the Telegram spinner.
 * 2. Check sender authorization.
 * 3. Treat payload as an opaque action token.
 * 4. Clear terminal buttons before expensive action work.
 * 5. Execute action programmatically and reply with the result when needed.
 *
 * Alice never sees raw callback_data strings.
 */
export function createCallbackHandler(
  channel: InteractiveChannel = "telegram",
  dependencies: CallbackHandlerDependencies = {},
) {
  const makeMergeTool = dependencies.makeAgentMergeTool ?? makeAgentMergeTool;
  const makePrTool = dependencies.makeAgentPrTool ?? makeAgentPrTool;
  logButtonDiagnostic("callback_handler_registered", {
    channel,
    namespace: CALLBACK_NAMESPACE,
  });
  return {
    channel,
    namespace: CALLBACK_NAMESPACE,
    handler: async (ctx: InteractiveCallbackContext): Promise<InteractiveHandlerResult> => {
      const callbackAcknowledged = await acknowledgeCallback(ctx);

      // Authorization check
      if (!ctx.auth.isAuthorizedSender) {
        await replyText(ctx, "⛔ Unauthorized.");
        return { handled: true };
      }

      const payload = getPayload(ctx);
      const tokenId = parsePayload(payload);
      logButtonDiagnostic("callback_received", {
        channel: ctx.channel,
        namespace: CALLBACK_NAMESPACE,
        payloadByteLength: Buffer.byteLength(payload, "utf8"),
        tokenHash: hashDiagnosticToken(tokenId),
        isAuthorizedSender: ctx.auth.isAuthorizedSender,
      });
      if (!tokenId) {
        await replyText(ctx, "⚠️ Unrecognized callback payload.");
        return { handled: true };
      }

      // Guard service initialization
      if (!sessionManager) {
        await replyText(ctx, "⚠️ Code agent service not running.");
        return { handled: true };
      }

      const token = sessionManager.getActionToken(tokenId);
      logButtonDiagnostic("callback_token_lookup_completed", {
        channel: ctx.channel,
        namespace: CALLBACK_NAMESPACE,
        tokenHash: hashDiagnosticToken(tokenId),
        tokenFound: Boolean(token),
        actionKind: token?.kind,
        sessionId: token?.sessionId,
        planDecisionVersion: token?.planDecisionVersion,
      });
      if (!token) {
        await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
        if (ctx.channel !== "telegram") {
          await replyText(ctx, "⚠️ This action is stale or has already been used.");
        }
        return { handled: true };
      }

      const sessionId = token.sessionId;
      const actionSession = sessionManager.resolve?.(sessionId) ?? sessionManager.getPersistedSession?.(sessionId);
      const actionSessionName = actionSession?.name ?? sessionId;
      const invalidPlanDecision = validatePlanDecisionToken(token, actionSession);
      logButtonDiagnostic("callback_plan_validation_completed", {
        channel: ctx.channel,
        namespace: CALLBACK_NAMESPACE,
        tokenHash: hashDiagnosticToken(tokenId),
        actionKind: token.kind,
        sessionId,
        sessionName: actionSessionName,
        planDecisionVersion: token.planDecisionVersion,
        valid: !invalidPlanDecision,
      });

      if (invalidPlanDecision) {
        await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
        await replyText(ctx, `⚠️ ${invalidPlanDecision}`);
        return { handled: true };
      }

      const consumedToken = sessionManager.consumeActionToken(tokenId);
      logButtonDiagnostic("callback_token_consume_completed", {
        channel: ctx.channel,
        namespace: CALLBACK_NAMESPACE,
        tokenHash: hashDiagnosticToken(tokenId),
        consumed: Boolean(consumedToken),
        actionKind: consumedToken?.kind,
        sessionId: consumedToken?.sessionId,
        planDecisionVersion: consumedToken?.planDecisionVersion,
      });
      if (!consumedToken) {
        await clearInteractiveState(ctx, {
          alreadyAcknowledged: callbackAcknowledged,
          forceTelegramMarkupEdit: token.kind === "plan-offer-start" || token.kind === "plan-offer-dismiss",
        });
        if (ctx.channel !== "telegram") {
          await replyText(ctx, "⚠️ This action is stale or has already been used.");
        }
        return { handled: true };
      }

      // Route action
      switch (consumedToken.kind) {
        case "worktree-merge": {
          const result = await makeMergeTool().execute("callback", { session: sessionId });
          const text = toolResultText(result);
          if (toolResultSucceeded(result)) {
            await clearWorktreeDecisionButtons(ctx, callbackAcknowledged);
            break;
          }
          await replyText(ctx, text);
          break;
        }

        case "worktree-decide-later": {
          const result = sessionManager.snoozeWorktreeDecision(sessionId, { notifyUser: false });
          const succeeded = worktreeActionTextSucceeded(result);
          if (succeeded) {
            const confirmation = `⏭️ Snoozed 24h for [${actionSessionName}]`;
            await clearWorktreeDecisionButtons(ctx, callbackAcknowledged);
            await replyText(ctx, confirmation);
          } else {
            await replyText(ctx, result);
          }
          break;
        }

        case "worktree-dismiss": {
          const result = await sessionManager.dismissWorktree(sessionId);
          const succeeded = worktreeActionTextSucceeded(result);
          if (succeeded) {
            await clearWorktreeDecisionButtons(ctx, callbackAcknowledged);
          }
          await replyText(ctx, succeeded ? "✅ Discarded" : result);
          break;
        }

        case "worktree-create-pr":
        case "worktree-update-pr": {
          // Do NOT pre-clear pendingWorktreeDecisionSince here.
          // For the PR path the worktree directory must stay alive indefinitely so the
          // user can push follow-up commits for PR review.  The worktree directory was
          // already preserved by onSessionTerminal (which skips removeWorktree when
          // pendingWorktreeDecisionSince is set).  agent-pr.ts clears the flag itself
          // on success; if the PR creation fails the flag remains set so reminders
          // continue until the user tries again.
          const result = await makePrTool().execute("callback", { session: sessionId });
          const text = toolResultText(result);
          if (toolResultSucceeded(result)) {
            await clearWorktreeDecisionButtons(ctx, callbackAcknowledged);
            break;
          }
          await replyText(ctx, text);
          break;
        }

        case "worktree-view-pr": {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
          const persisted = sessionManager.getPersistedSession?.(sessionId);
          const url = token.targetUrl ?? persisted?.worktreePrUrl;
          await replyText(ctx, url ? `PR: ${url}` : "⚠️ PR URL is no longer available.");
          break;
        }

        case "plan-approve": {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
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
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
          const result = rejectPlanDecision(sessionManager, sessionId);
          await replyText(ctx, `❌ ${result.text}`);
          break;
        }

        case "plan-request-changes": {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
          const result = requestPlanDecisionChanges(sessionManager, sessionId);
          await replyText(ctx, `✏️ ${result.text}`);
          break;
        }

        case "plan-offer-start": {
          if (!consumedToken.launchPrompt || !consumedToken.launchWorkdir) {
            await clearInteractiveState(ctx, {
              alreadyAcknowledged: callbackAcknowledged,
              forceTelegramMarkupEdit: true,
            });
            await replyText(ctx, "⚠️ This action is missing the plan launch context.");
            break;
          }
          let session: { id: string; name: string };
          try {
            session = sessionManager.launchPlanOffer({
              route: consumedToken.route,
              prompt: consumedToken.launchPrompt,
              workdir: consumedToken.launchWorkdir,
              name: consumedToken.launchName,
              worktreeStrategy: consumedToken.launchWorktreeStrategy,
            });
          } catch (err) {
            const errText = err instanceof Error ? err.message : String(err);
            await clearInteractiveState(ctx, {
              alreadyAcknowledged: callbackAcknowledged,
              forceTelegramMarkupEdit: true,
            });
            await replyText(ctx, `⚠️ Failed to start planning session: ${errText}`);
            break;
          }
          await clearInteractiveState(ctx, {
            alreadyAcknowledged: callbackAcknowledged,
            forceTelegramMarkupEdit: true,
          });
          await replyText(ctx, `▶️ Planning session started: ${session.name} [${session.id}]`);
          break;
        }

        case "plan-offer-dismiss": {
          await clearInteractiveState(ctx, {
            alreadyAcknowledged: callbackAcknowledged,
            forceTelegramMarkupEdit: true,
          });
          await replyText(ctx, `✅ Dismissed.`);
          break;
        }

        case "repo-policy-set": {
          if (!consumedToken.repoPolicy || !consumedToken.repoPolicyWorkdir) {
            await clearInteractiveState(ctx, {
              alreadyAcknowledged: callbackAcknowledged,
              forceTelegramMarkupEdit: true,
            });
            await replyText(ctx, "⚠️ This action is missing the repo policy context.");
            break;
          }
          if (!consumedToken.launchPrompt || !consumedToken.launchWorkdir) {
            await clearInteractiveState(ctx, {
              alreadyAcknowledged: callbackAcknowledged,
              forceTelegramMarkupEdit: true,
            });
            await replyText(ctx, "⚠️ This action is missing the launch context.");
            break;
          }
          if (typeof sessionManager.resolveRepoPolicy === "function") {
            const resolution = sessionManager.resolveRepoPolicy(consumedToken.repoPolicyWorkdir);
            if (resolution.identity) {
              const validationError = validateRepoPolicyForPrAvailability(consumedToken.repoPolicy, resolution.prAvailable);
              if (validationError) {
                await clearInteractiveState(ctx, {
                  alreadyAcknowledged: callbackAcknowledged,
                  forceTelegramMarkupEdit: true,
                });
                await replyText(ctx, `⚠️ ${validationError}`);
                break;
              }
            }
          }
          const record = sessionManager.setRepoPolicy(consumedToken.repoPolicyWorkdir, consumedToken.repoPolicy);
          if (!record) {
            await clearInteractiveState(ctx, {
              alreadyAcknowledged: callbackAcknowledged,
              forceTelegramMarkupEdit: true,
            });
            await replyText(ctx, `⚠️ Could not resolve a git repository for ${consumedToken.repoPolicyWorkdir}.`);
            break;
          }
          sessionManager.clearRepoPolicyChoiceTokens(consumedToken.sessionId);

          let launchText: string;
          try {
            const result = sessionManager.launchAfterRepoPolicyChoice({
              route: consumedToken.route,
              prompt: consumedToken.launchPrompt,
              workdir: consumedToken.launchWorkdir,
              name: consumedToken.launchName,
              model: consumedToken.launchModel,
              reasoningEffort: consumedToken.launchReasoningEffort,
              fastMode: consumedToken.launchFastMode,
              systemPrompt: consumedToken.launchSystemPrompt,
              allowedTools: consumedToken.launchAllowedTools,
              resumeSessionId: consumedToken.launchResumeSessionId,
              resumeWorktreeFrom: consumedToken.launchResumeWorktreeFrom,
              sessionIdOverride: consumedToken.launchSessionIdOverride,
              clearedPersistedCodexResume: consumedToken.launchClearedPersistedCodexResume,
              forkSession: consumedToken.launchForkSession,
              forceNewSession: consumedToken.launchForceNewSession,
              permissionMode: consumedToken.launchPermissionMode,
              planApproval: consumedToken.launchPlanApproval,
              harness: consumedToken.launchHarness,
              worktreeStrategy: consumedToken.launchWorktreeStrategy,
              worktreeBaseBranch: consumedToken.launchWorktreeBaseBranch,
              worktreePrTargetRepo: consumedToken.launchWorktreePrTargetRepo,
              originAgentId: consumedToken.launchOriginAgentId,
            });
            launchText = result.text;
          } catch (err) {
            const errText = err instanceof Error ? err.message : String(err);
            await clearInteractiveState(ctx, {
              alreadyAcknowledged: callbackAcknowledged,
              forceTelegramMarkupEdit: true,
            });
            await replyText(ctx, `⚠️ Repo policy saved, but launch failed: ${errText}`);
            break;
          }

          await clearInteractiveState(ctx, {
            alreadyAcknowledged: callbackAcknowledged,
            forceTelegramMarkupEdit: true,
          });
          await replyText(ctx, [
            `✅ Repo policy saved: ${getRepoPolicyOption(record.policy).title}.`,
            ``,
            launchText,
          ].join("\n"));
          break;
        }

        case "session-restart":
        case "session-resume": {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
          const result = await executeRespond(sessionManager, {
            session: sessionId,
            message: "Continue where you left off.",
            userInitiated: true,
          });
          await replyText(ctx, result.isError ? `⚠️ ${result.text}` : `▶️ ${result.text}`);
          break;
        }

        case "view-output": {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
          const result = await makeAgentOutputTool().execute("callback", { session: sessionId, lines: 50 });
          await replyText(ctx, toolResultText(result));
          break;
        }

        case "question-answer": {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
          if (token.optionIndex == null) {
            await replyText(ctx, `⚠️ Invalid question-answer action.`);
            break;
          }
          const submitted = await sessionManager.resolvePendingInputOption(sessionId, token.optionIndex, {
            requestId: token.pendingInputRequestId,
            questionId: token.pendingInputQuestionId,
          });
          await replyText(ctx, submitted
            ? `✅ Answer submitted.`
            : `⚠️ That question button is no longer active. Use the latest question prompt.`);
          break;
        }

        default: {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
          await replyText(ctx, `⚠️ Unknown callback action.`);
          break;
        }
      }

      return { handled: true };
    },
  };
}
