import { autoUpdateService, sessionManager } from "./singletons";
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
import { assessResumeCandidate } from "./session-resume";

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

const inFlightQuestionAnswers = new Set<string>();
const retryableQuestionAnswerFailureMessage =
  "⚠️ Could not submit that answer. The question prompt is still active; try again or reply with the answer.";
const planDecisionInFlight = new Map<string, { operation: Promise<unknown>; tokenId?: string }>();

function questionAnswerLockKey(token: SessionActionToken): string {
  return `${token.sessionId}:${token.pendingInputRequestId ?? token.id}`;
}

function resumableQuestionAnswerTarget(session: PersistedSessionInfo | undefined): boolean {
  return Boolean(session && session.status !== "running" && assessResumeCandidate(session).kind === "resume");
}

function recoveredQuestionAnswerMessage(token: SessionActionToken): string | undefined {
  if (!token.label?.trim()) return undefined;
  const questionLine = token.pendingInputQuestionId
    ? `Question ID: ${token.pendingInputQuestionId}`
    : "Question: the interrupted pending question";
  return [
    "[SYSTEM: The gateway restarted while a user question was pending. Treat the user's selection below as the answer to that interrupted question and continue without asking it again.]",
    "",
    questionLine,
    `Selected answer: ${token.label.trim()}`,
  ].join("\n");
}

async function waitForPlanDecisionOperation(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    console.warn(`[callback-handler] Prior plan decision callback failed while another callback was waiting: ${errText}`);
  }
}

async function withPlanDecisionLock<T>(
  key: string | undefined,
  tokenId: string | undefined,
  action: () => Promise<T> | T,
): Promise<T> {
  if (!key) return action();

  while (true) {
    const inFlight = planDecisionInFlight.get(key)?.operation;
    if (!inFlight) break;
    await waitForPlanDecisionOperation(inFlight);
  }

  const operation = Promise.resolve().then(action);
  planDecisionInFlight.set(key, { operation, tokenId });
  try {
    return await operation;
  } finally {
    if (planDecisionInFlight.get(key)?.operation === operation) {
      planDecisionInFlight.delete(key);
    }
  }
}

function parsePayload(payload: string): string | null {
  const tokenId = payload.trim().replace(new RegExp(`^${CALLBACK_NAMESPACE}:`), "");
  return tokenId ? tokenId : null;
}

function isNamespacedPayload(payload: string): boolean {
  return payload.trim().startsWith(`${CALLBACK_NAMESPACE}:`);
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

async function clearPlanDecisionButtons(
  ctx: InteractiveCallbackContext,
  alreadyAcknowledged = false,
): Promise<void> {
  await clearInteractiveState(ctx, {
    alreadyAcknowledged,
    forceTelegramMarkupEdit: ctx.channel === "telegram",
  });
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

function planDecisionLockKey(token: SessionActionToken): string | undefined {
  if (!isPlanDecisionAction(token.kind)) return undefined;
  return `${token.sessionId}:v${token.planDecisionVersion ?? "unknown"}`;
}

function planApprovalWasApplied(session: PlanDecisionTarget | undefined): boolean {
  if (!session) return false;
  return session.approvalState === "approved" || !session.pendingPlanApproval;
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

function firstMatchingString(predicate: (value: string) => boolean, ...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && predicate(value));
}

function firstNonBlankString(...values: unknown[]): string | undefined {
  return firstMatchingString((value) => value.trim().length > 0, ...values);
}

function firstNamespacedString(...values: unknown[]): string | undefined {
  return firstMatchingString(isNamespacedPayload, ...values);
}

function getPayload(ctx: InteractiveCallbackContext): string {
  const callbackNativePayload = "callback" in ctx
    ? firstNamespacedString(
        ctx.callback?.data,
        ctx.callback?.callback_data,
        ctx.callback?.callbackData,
      )
    : undefined;
  if (callbackNativePayload) return callbackNativePayload;

  const interaction = "interaction" in ctx ? ctx.interaction : undefined;
  const interactionNativePayload = firstNamespacedString(
    interaction?.data,
    interaction?.callback_data,
    interaction?.callbackData,
  );
  if (interactionNativePayload) return interactionNativePayload;

  const callbackPayload = "callback" in ctx
    ? firstNonBlankString(ctx.callback?.payload)
    : undefined;
  if (callbackPayload) return callbackPayload;

  const interactionPayload = firstNonBlankString(interaction?.payload);
  if (interactionPayload) return interactionPayload;

  const callbackNativeFallback = "callback" in ctx
    ? firstNonBlankString(
        ctx.callback?.data,
        ctx.callback?.callback_data,
        ctx.callback?.callbackData,
      )
    : undefined;
  return callbackNativeFallback ?? firstNonBlankString(
    interaction?.data,
    interaction?.callback_data,
    interaction?.callbackData,
  ) ?? "";
}

function collectErrorText(err: unknown, seen = new Set<unknown>()): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
  if (err instanceof Error) {
    return [
      err.name,
      err.message,
      collectErrorText((err as Error & { cause?: unknown }).cause, seen),
    ].filter(Boolean).join(" ");
  }
  if (typeof err !== "object") return String(err);
  if (seen.has(err)) return "";
  seen.add(err);

  const record = err as Record<string, unknown>;
  return [
    record.message,
    record.description,
    record.error,
    record.error_description,
    collectErrorText(record.cause, seen),
    collectErrorText(record.response, seen),
    collectErrorText(record.payload, seen),
  ].filter(Boolean).join(" ");
}

function isMessageNotModifiedError(err: unknown): boolean {
  return /message is not modified/i.test(collectErrorText(err));
}

function isDiscordEmptyMessageError(err: unknown): boolean {
  const errText = err instanceof Error ? err.message : String(err);
  return /empty message/i.test(errText);
}

async function clearTelegramButtons(responder: InteractiveResponder): Promise<void> {
  if (typeof responder.clearButtons !== "function") return;
  try {
    await responder.clearButtons();
  } catch (err) {
    if (isMessageNotModifiedError(err)) return;
    throw err;
  }
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
        await clearTelegramButtons(responder);
        return { textDelivered: true };
      } catch (err) {
        if (isMessageNotModifiedError(err)) {
          await clearTelegramButtons(responder);
          return { textDelivered: true };
        }
        const errText = err instanceof Error ? err.message : String(err);
        console.warn(`[callback-handler] Failed to edit Telegram worktree prompt before clearing buttons: ${errText}`);
      }
    }
    if (forceTelegramMarkupEdit && typeof responder.editButtons === "function") {
      try {
        await responder.editButtons({ buttons: [] });
        await clearTelegramButtons(responder);
        return { textDelivered: false };
      } catch (err) {
        if (isMessageNotModifiedError(err)) {
          await clearTelegramButtons(responder);
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
        await clearTelegramButtons(responder);
        return { textDelivered: false };
      } catch (err) {
        if (isMessageNotModifiedError(err)) {
          await clearTelegramButtons(responder);
          return { textDelivered: false };
        }
        const errText = err instanceof Error ? err.message : String(err);
        console.warn(`[callback-handler] Failed to edit Telegram message markup before clearing buttons: ${errText}`);
      }
    }
    await clearTelegramButtons(responder);
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

const planDecisionKindOrder: SessionActionKind[] = ["plan-approve", "plan-request-changes", "plan-reject"];

type ActionTokenLister = {
  listActiveActionTokens?: (kind?: SessionActionKind) => SessionActionToken[];
};

function planDecisionButtonLabel(kind: SessionActionKind): string {
  switch (kind) {
    case "plan-approve":
      return "Approve";
    case "plan-request-changes":
      return "Revise";
    case "plan-reject":
      return "Reject";
    default:
      return "Continue";
  }
}

function planDecisionButtonStyle(kind: SessionActionKind): "primary" | "secondary" | "danger" {
  switch (kind) {
    case "plan-approve":
      return "primary";
    case "plan-reject":
      return "danger";
    default:
      return "secondary";
  }
}

function planDecisionRetryButtons(
  manager: typeof sessionManager,
  currentToken: SessionActionToken,
): Array<Array<{ label: string; callbackData: string; style: "primary" | "secondary" | "danger" }>> | undefined {
  const tokenLister = manager as ActionTokenLister | null;
  const activeTokens = typeof tokenLister?.listActiveActionTokens === "function"
    ? planDecisionKindOrder.flatMap((kind) => tokenLister.listActiveActionTokens?.(kind) ?? [])
    : [currentToken];
  const matchingTokens = activeTokens
    .filter((candidate) =>
      isPlanDecisionAction(candidate.kind) &&
      candidate.sessionId === currentToken.sessionId &&
      (
        currentToken.planDecisionVersion == null ||
        candidate.planDecisionVersion == null ||
        candidate.planDecisionVersion === currentToken.planDecisionVersion
      )
    )
    .sort((a, b) => planDecisionKindOrder.indexOf(a.kind) - planDecisionKindOrder.indexOf(b.kind));

  const seenKinds = new Set<SessionActionKind>();
  const buttons = matchingTokens
    .filter((candidate) => {
      if (seenKinds.has(candidate.kind)) return false;
      seenKinds.add(candidate.kind);
      return true;
    })
    .map((candidate) => ({
      label: typeof candidate.label === "string" && candidate.label.trim()
        ? candidate.label
        : planDecisionButtonLabel(candidate.kind),
      callbackData: `${CALLBACK_NAMESPACE}:${candidate.id}`,
      style: planDecisionButtonStyle(candidate.kind),
    }));

  return buttons.length > 0 ? [buttons] : undefined;
}

async function replyPlanApprovalRetry(
  ctx: InteractiveCallbackContext,
  text: string,
  manager: typeof sessionManager,
  token: SessionActionToken,
): Promise<void> {
  if (ctx.channel !== "telegram") {
    await replyText(ctx, text);
    return;
  }

  const buttons = planDecisionRetryButtons(manager, token);
  await ctx.respond.reply({
    text: buttons
      ? `${text}\n\nApproval is still pending. Try again below.`
      : text,
    ...(buttons ? { buttons } : {}),
  });
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

      let token = sessionManager.getActionToken(tokenId);
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

      if (token.kind === "question-answer" && token.consumedAt != null) {
        await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
        await replyText(ctx, "⚠️ That question button is no longer active. Use the latest question prompt.");
        return { handled: true };
      }

      let sessionId = token.sessionId;
      let actionSession = sessionManager.resolve?.(sessionId) ?? sessionManager.getPersistedSession?.(sessionId);
      let actionSessionName = actionSession?.name ?? sessionId;
      let invalidPlanDecision = validatePlanDecisionToken(token, actionSession);
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
        if (isPlanDecisionAction(token.kind)) {
          await clearPlanDecisionButtons(ctx, callbackAcknowledged);
        } else {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
        }
        await replyText(ctx, `⚠️ ${invalidPlanDecision}`);
        return { handled: true };
      }

      if (token.kind === "question-answer") {
        if (token.optionIndex == null) {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
          await replyText(ctx, `⚠️ Invalid question-answer action.`);
          return { handled: true };
        }

        const answerLockKey = questionAnswerLockKey(token);
        if (inFlightQuestionAnswers.has(answerLockKey)) {
          await replyText(ctx, "⚠️ That answer is already being submitted. If the question remains active, try again.");
          return { handled: true };
        }

        inFlightQuestionAnswers.add(answerLockKey);
        let submitted = false;
        let forwardedToResumedSession = false;
        try {
          submitted = await sessionManager.resolvePendingInputOption(sessionId, token.optionIndex, {
            requestId: token.pendingInputRequestId,
            questionId: token.pendingInputQuestionId,
          });
          if (!submitted && !(sessionManager.canSubmitPendingInputOption?.(sessionId) ?? false)) {
            const persisted = sessionManager.getPersistedSession?.(sessionId);
            const recoveryMessage = recoveredQuestionAnswerMessage(token);
            if (recoveryMessage && resumableQuestionAnswerTarget(persisted)) {
              const result = await executeRespond(sessionManager, {
                session: sessionId,
                message: recoveryMessage,
                userInitiated: true,
              });
              submitted = !result.isError;
              forwardedToResumedSession = submitted;
            }
          }
        } catch (err) {
          const errText = err instanceof Error ? err.message : String(err);
          console.warn(`[callback-handler] Failed to submit question-answer callback: ${errText}`);
          await replyText(ctx, retryableQuestionAnswerFailureMessage);
          return { handled: true };
        } finally {
          inFlightQuestionAnswers.delete(answerLockKey);
        }

        if (!submitted) {
          await replyText(ctx, retryableQuestionAnswerFailureMessage);
          return { handled: true };
        }

        const consumedTokens = token.pendingInputRequestId
          ? sessionManager.consumeQuestionAnswerTokens(sessionId, token.pendingInputRequestId)
          : [];
        const consumedToken = consumedTokens.find((candidate) => candidate.id === tokenId)
          ?? sessionManager.consumeActionToken(tokenId);
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
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
          await replyText(ctx, forwardedToResumedSession
            ? `✅ Answer forwarded to the resumed session.`
            : `✅ Answer submitted.`);
          return { handled: true };
        }

        await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
        await replyText(ctx, forwardedToResumedSession
          ? `✅ Answer forwarded to the resumed session.`
          : `✅ Answer submitted.`);
        return { handled: true };
      }

      const decisionLockKey = planDecisionLockKey(token);
      if (decisionLockKey) {
        while (true) {
          const inFlight = planDecisionInFlight.get(decisionLockKey);
          if (!inFlight) break;

          if (inFlight.tokenId === tokenId) {
            await clearPlanDecisionButtons(ctx, callbackAcknowledged);
            await replyText(ctx, "⚠️ This plan decision is already being processed.");
            return { handled: true };
          }

          await waitForPlanDecisionOperation(inFlight.operation);
          const latestToken = sessionManager.getActionToken(tokenId);
          if (!latestToken) {
            await clearPlanDecisionButtons(ctx, callbackAcknowledged);
            if (ctx.channel !== "telegram") {
              await replyText(ctx, "⚠️ This action is stale or has already been used.");
            }
            return { handled: true };
          }

          sessionId = latestToken.sessionId;
          actionSession = sessionManager.resolve?.(sessionId) ?? sessionManager.getPersistedSession?.(sessionId);
          actionSessionName = actionSession?.name ?? sessionId;
          invalidPlanDecision = validatePlanDecisionToken(latestToken, actionSession);
          logButtonDiagnostic("callback_plan_validation_completed", {
            channel: ctx.channel,
            namespace: CALLBACK_NAMESPACE,
            tokenHash: hashDiagnosticToken(tokenId),
            actionKind: latestToken.kind,
            sessionId,
            sessionName: actionSessionName,
            planDecisionVersion: latestToken.planDecisionVersion,
            valid: !invalidPlanDecision,
            afterPlanDecisionLock: true,
          });

          if (invalidPlanDecision) {
            await clearPlanDecisionButtons(ctx, callbackAcknowledged);
            await replyText(ctx, `⚠️ ${invalidPlanDecision}`);
            return { handled: true };
          }

          token = latestToken;
        }
      }

      if (token.kind === "plan-approve") {
        const planToken = token;
        let promptCleared = false;
        const clearApprovalPrompt = async (force = false) => {
          if (promptCleared) return;
          if (!force && ctx.channel !== "telegram") return;
          await clearPlanDecisionButtons(ctx, callbackAcknowledged);
          promptCleared = true;
        };
        const result = await withPlanDecisionLock(decisionLockKey, tokenId, async () => {
          await clearApprovalPrompt();
          return executeRespond(sessionManager, {
            session: planToken.sessionId,
            message: "Approved. Go ahead.",
            approve: true,
            userInitiated: true,
          });
        });
        if (result.isError) {
          const latestSession = sessionManager.resolve?.(planToken.sessionId)
            ?? sessionManager.getPersistedSession?.(planToken.sessionId);
          const approvalApplied = planApprovalWasApplied(latestSession);
          if (approvalApplied) {
            const consumedToken = sessionManager.consumeActionToken(tokenId);
            logButtonDiagnostic("callback_token_consume_completed", {
              channel: ctx.channel,
              namespace: CALLBACK_NAMESPACE,
              tokenHash: hashDiagnosticToken(tokenId),
              consumed: Boolean(consumedToken),
              actionKind: consumedToken?.kind,
              sessionId: consumedToken?.sessionId ?? planToken.sessionId,
              planDecisionVersion: consumedToken?.planDecisionVersion,
              approvalAppliedAfterError: true,
            });
            await clearApprovalPrompt(true);
          }
          if (approvalApplied) {
            await replyText(ctx, `⚠️ ${result.text}`);
          } else {
            await replyPlanApprovalRetry(ctx, `⚠️ ${result.text}`, sessionManager, planToken);
          }
          return { handled: true };
        }

        const consumedToken = sessionManager.consumeActionToken(tokenId);
        logButtonDiagnostic("callback_token_consume_completed", {
          channel: ctx.channel,
          namespace: CALLBACK_NAMESPACE,
          tokenHash: hashDiagnosticToken(tokenId),
          consumed: Boolean(consumedToken),
          actionKind: consumedToken?.kind,
          sessionId: consumedToken?.sessionId ?? planToken.sessionId,
          planDecisionVersion: consumedToken?.planDecisionVersion,
        });
        if (!consumedToken) {
          await clearApprovalPrompt(true);
          if (ctx.channel !== "telegram") {
            await replyText(ctx, "⚠️ This action is stale or has already been used.");
          }
          return { handled: true };
        }

        await clearApprovalPrompt(true);
        return { handled: true };
      }

      if (token.kind === "plan-reject" || token.kind === "plan-request-changes") {
        return await withPlanDecisionLock(decisionLockKey, tokenId, async () => {
          const latestToken = sessionManager.getActionToken(tokenId);
          if (!latestToken) {
            await clearPlanDecisionButtons(ctx, callbackAcknowledged);
            if (ctx.channel !== "telegram") {
              await replyText(ctx, "⚠️ This action is stale or has already been used.");
            }
            return { handled: true };
          }

          sessionId = latestToken.sessionId;
          actionSession = sessionManager.resolve?.(sessionId) ?? sessionManager.getPersistedSession?.(sessionId);
          actionSessionName = actionSession?.name ?? sessionId;
          const latestInvalidPlanDecision = validatePlanDecisionToken(latestToken, actionSession);
          logButtonDiagnostic("callback_plan_validation_completed", {
            channel: ctx.channel,
            namespace: CALLBACK_NAMESPACE,
            tokenHash: hashDiagnosticToken(tokenId),
            actionKind: latestToken.kind,
            sessionId,
            sessionName: actionSessionName,
            planDecisionVersion: latestToken.planDecisionVersion,
            valid: !latestInvalidPlanDecision,
            afterPlanDecisionLock: true,
          });

          if (latestInvalidPlanDecision) {
            await clearPlanDecisionButtons(ctx, callbackAcknowledged);
            await replyText(ctx, `⚠️ ${latestInvalidPlanDecision}`);
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
            await clearPlanDecisionButtons(ctx, callbackAcknowledged);
            if (ctx.channel !== "telegram") {
              await replyText(ctx, "⚠️ This action is stale or has already been used.");
            }
            return { handled: true };
          }

          await clearPlanDecisionButtons(ctx, callbackAcknowledged);
          if (consumedToken.kind === "plan-reject") {
            const result = rejectPlanDecision(sessionManager, sessionId);
            await replyText(ctx, `❌ ${result.text}`);
          } else {
            const result = requestPlanDecisionChanges(sessionManager, sessionId);
            await replyText(ctx, `✏️ ${result.text}`);
          }
          return { handled: true };
        });
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
        case "plugin-update-install": {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged, forceTelegramMarkupEdit: true });
          if (!autoUpdateService) {
            await replyText(ctx, "⚠️ OCA update service is not running.");
            break;
          }
          try {
            const text = await autoUpdateService.installConfirmed(consumedToken.pluginUpdateVersion, {
              route: consumedToken.route,
            });
            await replyText(ctx, `✅ ${text}`);
          } catch (err) {
            await replyText(ctx, `⚠️ OCA update failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }

        case "plugin-update-restart": {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged, forceTelegramMarkupEdit: true });
          if (!autoUpdateService) {
            await replyText(ctx, "⚠️ OCA update service is not running.");
            break;
          }
          try {
            const text = await autoUpdateService.restartConfirmed(consumedToken.pluginUpdateVersion);
            await replyText(ctx, `▶️ ${text}`);
          } catch (err) {
            await replyText(ctx, `⚠️ Gateway restart failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }

        case "plugin-update-dismiss": {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged, forceTelegramMarkupEdit: true });
          const text = autoUpdateService
            ? autoUpdateService.dismiss(consumedToken.pluginUpdateVersion)
            : "Dismissed OCA update reminder.";
          await replyText(ctx, `✅ ${text}`);
          break;
        }

        case "plugin-update-remind-later": {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged, forceTelegramMarkupEdit: true });
          const text = autoUpdateService
            ? autoUpdateService.remindLater(consumedToken.pluginUpdateVersion)
            : "Will remind later about OCA update reminder.";
          await replyText(ctx, `✅ ${text}`);
          break;
        }

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
              resumedFromSessionName: consumedToken.launchResumedFromSessionName,
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
