import { autoUpdateService, goalController, sessionManager } from "./singletons";
import { executeRespond, rejectPlanDecision, requestPlanDecisionChanges } from "./actions/respond";
import { makeAgentMergeTool } from "./tools/agent-merge";
import { makeAgentPrTool } from "./tools/agent-pr";
import { makeAgentOutputTool } from "./tools/agent-output";
import { USER_BUTTON_TOOL_CALL_ID } from "./tools/worktree-tool-context";
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
import { resolveCurrentPlanDecisionVersion, tokenMatchesAppliedPlanApproval } from "./plan-decision-state";
import { createLogger } from "./logger";
import { pluginConfig } from "./config";
import { SERVICE_NOT_RUNNING } from "./commands/args";
import { userGoalStatusWord } from "./application/session-control";
import { processShared } from "./process-runtime";
import { callbackMatchesTokenRoute, type CallbackConversation } from "./callback-route-binding";
import { alreadyResolvedReply } from "./session-worktree-decision-service";

const log = createLogger("callback-handler");

function updateServiceUnavailableText(): string {
  return pluginConfig.autoUpdate
    ? "⚠️ Code Agent update service is not running."
    : "⚠️ Code Agent self-update is disabled (plugin config `autoUpdate: false`).";
}

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

// Process-wide: every plugin registry's handler shares one set of in-flight locks.
const inFlightQuestionAnswers = processShared("callback-question-answer-locks.v1", () => new Set<string>());
// Worktrees with a decision (merge, PR, snooze, discard) currently being carried out.
const inFlightWorktreeDecisions = processShared("callback-worktree-decision-locks.v1", () => new Set<string>());
const retryableQuestionAnswerFailureMessage =
  "Could not submit that answer. The question prompt is still active; try again or reply with the answer.";

/**
 * The first line of a tool or action text for the user: without its marker or
 * `Error:`, without sentences that instruct the orchestrator (`agent_…`
 * calls) and without session ids.
 */
function plainReason(text: string): string {
  return text.split("\n")[0]!
    .replace(/^\s*(?:Error:|❌|⚠️)\s*/u, "")
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => !/\bagent_[a-z_]+/u.test(sentence))
    .join(" ")
    .replace(/ \[[\w-]+\]/gu, "")
    .trim();
}

/**
 * A real failure of a button action: `❌ [name] <reason>` (the name once).
 * Benign answers (expired, already answered or resolved, being processed)
 * stay `⚠️`.
 */
function failureReply(sessionName: string | undefined, reason: string): string {
  const prefix = sessionName ? `[${sessionName}] ` : "";
  const text = plainReason(reason);
  return `❌ ${prefix}${(prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text) || "The action failed."}`;
}

/** `agent_pr(force_new=true)` refused: the branch's PR is open or merged. */
const FORCE_NEW_REFUSED_PATTERN = /^⚠️ Cannot create new PR: A PR already exists for .+ \((?:open|merged)\)\./u;

/** `agent_pr`'s answer when the branch's PR was closed without merging. */
const CLOSED_PR_PATTERN = /A PR exists but was closed without merging: (\S+)/u;

/** The reason a merge / PR / discard button failed, for the user (see `plainReason`). */
function userFacingFailureReason(toolText: string): string {
  // The detail of a rebase conflict is on the following lines, with the checkout to resolve it in.
  const rebase = /Rebase of (\S+) onto (\S+) hit conflicts/u.exec(toolText);
  if (rebase) {
    const checkout = /^\s*cd (\S.*)$/mu.exec(toolText)?.[1]?.trim();
    return `rebase of \`${rebase[1]}\` onto \`${rebase[2]}\` hit conflicts; resolve them manually${checkout ? ` in \`${checkout}\`` : ""}`;
  }
  const closedPr = CLOSED_PR_PATTERN.exec(toolText);
  if (closedPr) return `the earlier PR was closed without merging: ${closedPr[1]}`;
  return plainReason(toolText)
    .replace(/^(?:Merge (?:blocked|failed)|Not merged|No PR opened|Failed to create PR)(?:: |\.?$)/u, "")
    .replace(/^Failed to /u, "could not ")
    .replace(/[.:\s]+$/u, "") || "unknown error";
}
const planDecisionInFlight = processShared(
  "callback-plan-decision-locks.v1",
  () => new Map<string, { operation: Promise<unknown>; tokenId?: string }>(),
);

const ownedElsewhereMessage =
  "⚠️ This session is running in another OpenClaw Code Agent runtime. Use the buttons from its latest message.";

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
    "Your earlier question was interrupted by an OpenClaw Gateway restart. The user has now answered it; treat the selection below as the answer and continue without asking it again.",
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
    log.warn(`[callback-handler] Prior plan decision callback failed while another callback was waiting: ${errText}`);
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
      log.warn(`[callback-handler] Failed to clear Telegram worktree prompt buttons: ${errText}`);
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
      log.warn(`[callback-handler] Failed to clear Discord worktree components: ${errText}`);
    }
  }

  if (!alreadyAcknowledged && typeof responder.acknowledge === "function") {
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

/** The tool already sent the user an outcome notice; otherwise the button shows the tool text. */
function toolResultOutcomeNotified(result: unknown): boolean {
  if (!result || typeof result !== "object" || !("meta" in result)) return false;
  return (result as { meta?: { outcomeNotified?: unknown } }).meta?.outcomeNotified === true;
}

/**
 * After a failed worktree action the clicked token is spent (it is consumed
 * before acting). Re-offer the still-open decision with fresh buttons and clear
 * the spent controls, so a retry is not answered with "stale".
 */
async function reofferWorktreeDecisionAfterFailure(
  ctx: InteractiveCallbackContext,
  sessionId: string,
  sessionName: string,
  callbackAcknowledged: boolean,
  action: "Merge" | "PR" | "Discard",
  toolText: string,
): Promise<void> {
  // The PR action found its PR closed without merging: the prompt offers New PR.
  const closedPr = action === "PR" && CLOSED_PR_PATTERN.test(toolText);
  // One message: the failure and the still-open decision with its fresh buttons.
  // A reason that ends in a URL gets no period after it.
  const reason = userFacingFailureReason(toolText);
  // A merge that was refused (policy, uncommitted changes) is blocked, not failed.
  const verb = /^\s*(?:❌\s*)?Merge blocked/u.test(toolText) ? "blocked" : "failed";
  const failure = `${action} ${verb}: ${reason}${/https?:\/\/\S+$/u.test(reason) ? "" : "."}`;
  const plainReply = `❌ [${sessionName}] ${failure}`;
  let reoffered: boolean | "pending" = false;
  try {
    reoffered = (await sessionManager?.reofferWorktreeDecision?.(sessionId, failure, {
      closedPr,
      // A slow delivery ends after this handler answered: finish what it would have done.
      onLateResult: (delivered) => {
        void (delivered ? clearWorktreeDecisionButtons(ctx, callbackAcknowledged) : replyText(ctx, plainReply))
          .catch((err: unknown) => {
            log.warn(`[callback-handler] Could not finish a late worktree re-offer: ${err instanceof Error ? err.message : String(err)}`);
          });
      },
    })) ?? false;
  } catch (err) {
    log.warn(`[callback-handler] Could not re-offer the worktree decision after a failed action: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Still being delivered: that prompt is the answer, so nothing is sent now.
  if (reoffered === "pending") return;
  if (reoffered) await clearWorktreeDecisionButtons(ctx, callbackAcknowledged);
  // Nothing was re-offered (the decision is closed, or the prompt was not delivered).
  else await replyText(ctx, plainReply);
}

function isPlanDecisionAction(kind: SessionActionKind): boolean {
  return kind === "plan-approve" || kind === "plan-request-changes" || kind === "plan-reject";
}

/** Decision buttons whose press makes the prompt's queued next-turn note stale. */
const DECISION_NOTE_LABELS: Partial<Record<SessionActionKind, { button: string; subject: string }>> = {
  "plan-approve": { button: "Approve", subject: "plan" },
  "plan-reject": { button: "Reject", subject: "plan" },
  "worktree-merge": { button: "Merge", subject: "branch" },
  "worktree-create-pr": { button: "Open PR", subject: "branch" },
  "worktree-update-pr": { button: "Sync PR", subject: "branch" },
  "worktree-decide-later": { button: "Later", subject: "branch" },
  "worktree-dismiss": { button: "Discard", subject: "branch" },
};

/**
 * Next-turn notes queued with a decision prompt ("Plan v2 is with the user",
 * "the user has Merge / Later / Discard buttons") cannot be withdrawn from the
 * host queue: after a decision button, queue a note that they no longer apply.
 * Revise queues its own note (the next message is the change).
 */
function queueDecisionPressedNote(
  // The service may have stopped while the button ran (Gateway shutdown).
  sm: { queueOrchestratorContext?: (ref: string, label: string, text: string, idempotencyKey?: string) => boolean } | null | undefined,
  kind: SessionActionKind,
  sessionId: string,
  sessionName: string,
  tokenId: string,
): void {
  const decided = DECISION_NOTE_LABELS[kind];
  if (!decided) return;
  sm?.queueOrchestratorContext?.(
    sessionId,
    "decision-button-pressed",
    `[${sessionName}] The user pressed ${decided.button} for the ${decided.subject}; earlier notes about that pending decision no longer apply.`,
    `decision-button-pressed:${sessionId}:${tokenId}`,
  );
}

const WORKTREE_DECISION_ACTIONS: ReadonlySet<SessionActionKind> = new Set([
  "worktree-merge",
  "worktree-create-pr",
  "worktree-update-pr",
  "worktree-decide-later",
  "worktree-dismiss",
]);

/** How a worktree decision was already settled, or undefined while it is still open. */
function resolvedWorktreeDecision(session: PersistedSessionInfo | undefined): string | undefined {
  if (!session) return undefined;
  switch (session.worktreeLifecycle?.state) {
    case "merged":
    case "released":
      return "merged";
    case "dismissed":
      return "discarded";
    case "no_change":
      return "no changes to keep";
    default:
      if (session.worktreeMerged) return "merged";
      if (session.worktreeDismissedAt) return "discarded";
      return undefined;
  }
}

function planDecisionLockKey(token: SessionActionToken): string | undefined {
  if (!isPlanDecisionAction(token.kind)) return undefined;
  return `${token.sessionId}:v${token.planDecisionVersion ?? "unknown"}`;
}

function planApprovalWasApplied(session: PlanDecisionTarget | undefined): boolean {
  if (!session) return false;
  return session.approvalState === "approved" || !session.pendingPlanApproval;
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

/**
 * OpenClaw's interactive dispatcher splits the button data at the first `:`,
 * routes on the namespace, and hands the plugin the remainder as `payload`
 * (Telegram `ctx.callback`, Discord `ctx.interaction`). OCA buttons carry
 * `code-agent:<token id>`, so the payload is the action token id.
 */
function callbackConversation(ctx: InteractiveCallbackContext): CallbackConversation {
  return ctx.channel === "telegram"
    ? {
        channel: "telegram",
        conversationId: ctx.conversationId,
        parentConversationId: ctx.parentConversationId,
        chatId: ctx.callback?.chatId,
      }
    : {
        channel: "discord",
        conversationId: ctx.conversationId,
        parentConversationId: ctx.parentConversationId,
      };
}

function getPayload(ctx: InteractiveCallbackContext): string {
  const source = ctx.channel === "telegram" ? ctx.callback : ctx.interaction;
  return source?.payload?.trim() ?? "";
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
        log.warn(`[callback-handler] Failed to edit Telegram worktree prompt before clearing buttons: ${errText}`);
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
        log.warn(`[callback-handler] Failed to edit Telegram button markup before clearing buttons: ${errText}`);
      }
    }
    const callbackMessageText = ctx.callback?.messageText;
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
        log.warn(`[callback-handler] Failed to edit Telegram message markup before clearing buttons: ${errText}`);
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
          log.warn("[callback-handler] clearComponents failed with empty-message error and no acknowledge fallback available");
        }
      } else if (typeof text !== "string") {
        throw err;
      } else {
        const errText = err instanceof Error ? err.message : String(err);
        log.warn(`[callback-handler] clearComponents failed before text fallback: ${errText}`);
      }
    }
  }

  if (typeof text === "string" && typeof responder.editMessage === "function") {
    try {
      await responder.editMessage({ text });
    } catch (err) {
      if (isMessageNotModifiedError(err)) return { textDelivered: true };
      const errText = err instanceof Error ? err.message : String(err);
      log.warn(`[callback-handler] Failed to edit worktree prompt before clearing interactive state: ${errText}`);
      return { textDelivered: false };
    }
    return { textDelivered: true };
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
    log.warn(`[callback-handler] Failed to acknowledge callback before processing: ${errText}`);
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

/** Confirmation after a question-answer button (N41): names the session and the chosen option. */
function formatAnswerConfirmation(
  sessionName: string,
  token: Pick<SessionActionToken, "label">,
  state: { forwardedToResumedSession: boolean; moreInputRequired: boolean },
): string {
  const choice = typeof token.label === "string" && token.label.trim() ? `: ${token.label.trim()}` : "";
  if (state.forwardedToResumedSession) return `💬 [${sessionName}] Answer sent${choice}. The session resumed.`;
  if (state.moreInputRequired) return `💬 [${sessionName}] Answer sent${choice}. Next question below.`;
  return `💬 [${sessionName}] Answer sent${choice}.`;
}

const staleActionMessage = "⚠️ This button has expired or was already used.";

async function rejectStaleAction(
  ctx: InteractiveCallbackContext,
  clear: () => Promise<unknown>,
): Promise<void> {
  try {
    await clear();
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    log.warn(`[callback-handler] Failed to clear stale callback controls: ${errText}`);
  }
  try {
    await replyText(ctx, staleActionMessage);
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    log.warn(`[callback-handler] Failed to report stale callback: ${errText}`);
  }
}

async function clearUpdateActionButtons(
  ctx: InteractiveCallbackContext,
  alreadyAcknowledged: boolean,
): Promise<void> {
  try {
    await clearInteractiveState(ctx, {
      alreadyAcknowledged,
      forceTelegramMarkupEdit: true,
    });
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    log.warn(`[callback-handler] Failed to clear update action buttons; continuing approved action: ${errText}`);
  }
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
        await replyText(ctx, "🚫 Unauthorized.");
        return { handled: true };
      }

      const tokenId = getPayload(ctx);
      logButtonDiagnostic("callback_received", {
        channel: ctx.channel,
        namespace: CALLBACK_NAMESPACE,
        payloadByteLength: Buffer.byteLength(tokenId, "utf8"),
        tokenHash: hashDiagnosticToken(tokenId),
        isAuthorizedSender: ctx.auth.isAuthorizedSender,
      });
      if (!tokenId) {
        await replyText(ctx, "⚠️ This button is not recognized. Use the buttons on the latest message.");
        return { handled: true };
      }

      // Guard service initialization
      if (!sessionManager) {
        await replyText(ctx, SERVICE_NOT_RUNNING);
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
        // Debug-level and always on: which runtime and store revision missed, never the token value.
        log.debug(JSON.stringify({
          event: "callback_token_miss",
          channel: ctx.channel,
          namespace: CALLBACK_NAMESPACE,
          payloadByteLength: Buffer.byteLength(tokenId, "utf8"),
          ...(sessionManager.getStoreDiagnostics?.() ?? {}),
        }));
        await rejectStaleAction(ctx, () =>
          clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged }));
        return { handled: true };
      }

      // N2: a button acts only from the chat it was delivered to.
      if (!callbackMatchesTokenRoute(callbackConversation(ctx), token.route)) {
        logButtonDiagnostic("callback_route_mismatch", {
          channel: ctx.channel,
          namespace: CALLBACK_NAMESPACE,
          tokenHash: hashDiagnosticToken(tokenId),
          actionKind: token.kind,
          sessionId: token.sessionId,
        });
        log.warn(`[callback-handler] Refused a ${token.kind} callback from a chat other than the one its button was sent to.`);
        await replyText(ctx, "🚫 This button belongs to another chat.");
        return { handled: true };
      }

      if (sessionManager.isAdoptedActionToken?.(tokenId)) {
        log.debug(JSON.stringify({
          event: "callback_token_adopted_from_store",
          channel: ctx.channel,
          namespace: CALLBACK_NAMESPACE,
          actionKind: token.kind,
          ...(sessionManager.getStoreDiagnostics?.() ?? {}),
        }));
      }

      // Only the runtime that owns a live session acts on it: never resume or
      // answer a session another writer of the index reports as running.
      if (sessionManager.isSessionOwnedElsewhere?.(token.sessionId)) {
        log.debug(JSON.stringify({
          event: "callback_session_owned_elsewhere",
          channel: ctx.channel,
          namespace: CALLBACK_NAMESPACE,
          actionKind: token.kind,
          ...(sessionManager.getStoreDiagnostics?.() ?? {}),
        }));
        await replyText(ctx, ownedElsewhereMessage);
        return { handled: true };
      }

      if (token.kind === "question-answer" && token.consumedAt != null) {
        await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
        await replyText(ctx, "⚠️ This question was already answered or replaced.");
        return { handled: true };
      }

      let sessionId = token.sessionId;
      let actionSession = sessionManager.resolve?.(sessionId) ?? sessionManager.getPersistedSession?.(sessionId);
      let actionSessionName = actionSession?.name ?? sessionId;
      if (actionSession && tokenMatchesAppliedPlanApproval(token, actionSession)) {
        sessionManager.consumePlanDecisionTokens?.(sessionId, token.planDecisionVersion!);
        await clearPlanDecisionButtons(ctx, callbackAcknowledged);
        await replyText(ctx, `👍 [${actionSessionName}] Plan v${token.planDecisionVersion} was already approved; the session is resuming or running.`);
        return { handled: true };
      }
      // A benign reply about a known session names it.
      const benign = (text: string): string => `⚠️ ${actionSession ? `[${actionSessionName}] ` : ""}${text}`;
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
        await replyText(ctx, benign(invalidPlanDecision));
        return { handled: true };
      }

      if (token.kind === "question-answer") {
        if (token.optionIndex == null) {
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
          await replyText(ctx, `⚠️ Invalid question-answer action.`);
          return { handled: true };
        }

        // A button for a question the live session no longer shows (answered
        // another way, timed out, or cancelled) must not answer anything else.
        if (sessionManager.isQuestionAnswerTokenCurrent?.(
          sessionId,
          token.pendingInputRequestId,
          token.pendingInputQuestionId,
        ) === false) {
          if (token.pendingInputRequestId) {
            sessionManager.consumeQuestionAnswerTokens(sessionId, token.pendingInputRequestId, token.pendingInputQuestionId);
          }
          sessionManager.consumeActionToken(tokenId);
          await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
          await replyText(ctx, benign("This question was already answered or replaced."));
          return { handled: true };
        }

        const answerLockKey = questionAnswerLockKey(token);
        if (inFlightQuestionAnswers.has(answerLockKey)) {
          await replyText(ctx, benign("That answer is already being submitted. If the question remains active, try again."));
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
                // One message: the `💬 … Answer sent … The session resumed.`
                // confirmation below replaces the `▶️ [name] Resumed` notice.
                replyIsNotice: true,
              });
              submitted = !result.isError;
              forwardedToResumedSession = submitted;
            }
          }
        } catch (err) {
          const errText = err instanceof Error ? err.message : String(err);
          log.warn(`[callback-handler] Failed to submit question-answer callback: ${errText}`);
          await replyText(ctx, failureReply(actionSessionName, retryableQuestionAnswerFailureMessage));
          return { handled: true };
        } finally {
          inFlightQuestionAnswers.delete(answerLockKey);
        }

        if (!submitted) {
          await replyText(ctx, failureReply(actionSessionName, retryableQuestionAnswerFailureMessage));
          return { handled: true };
        }

        const consumedTokens = token.pendingInputRequestId
          ? sessionManager.consumeQuestionAnswerTokens(
              sessionId,
              token.pendingInputRequestId,
              token.pendingInputQuestionId,
            )
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
          const moreInputRequired = !forwardedToResumedSession
            && (sessionManager.pendingInputSubmissionRequiresMore?.(sessionId) ?? false);
          await replyText(ctx, formatAnswerConfirmation(actionSessionName, token, { forwardedToResumedSession, moreInputRequired }));
          return { handled: true };
        }

        await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
        const moreInputRequired = !forwardedToResumedSession
          && (sessionManager.pendingInputSubmissionRequiresMore?.(sessionId) ?? false);
        await replyText(ctx, formatAnswerConfirmation(actionSessionName, token, { forwardedToResumedSession, moreInputRequired }));
        return { handled: true };
      }

      const decisionLockKey = planDecisionLockKey(token);
      if (decisionLockKey) {
        while (true) {
          const inFlight = planDecisionInFlight.get(decisionLockKey);
          if (!inFlight) break;

          if (inFlight.tokenId === tokenId) {
            await clearPlanDecisionButtons(ctx, callbackAcknowledged);
            await replyText(ctx, benign("This plan decision is already being processed."));
            return { handled: true };
          }

          await waitForPlanDecisionOperation(inFlight.operation);
          const latestToken = sessionManager.getActionToken(tokenId);
          if (!latestToken) {
            await rejectStaleAction(ctx, () => clearPlanDecisionButtons(ctx, callbackAcknowledged));
            return { handled: true };
          }

          sessionId = latestToken.sessionId;
          actionSession = sessionManager.resolve?.(sessionId) ?? sessionManager.getPersistedSession?.(sessionId);
          actionSessionName = actionSession?.name ?? sessionId;
          if (actionSession && tokenMatchesAppliedPlanApproval(latestToken, actionSession)) {
            sessionManager.consumePlanDecisionTokens?.(sessionId, latestToken.planDecisionVersion!);
            await clearPlanDecisionButtons(ctx, callbackAcknowledged);
            await replyText(ctx, `👍 [${actionSessionName}] Plan v${latestToken.planDecisionVersion} was already approved; the session is resuming or running.`);
            return { handled: true };
          }
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
            await replyText(ctx, benign(invalidPlanDecision));
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
            userApproval: "button",
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
          const failure = result.userText ?? failureReply(actionSessionName, result.text);
          if (approvalApplied) {
            await replyText(ctx, failure);
          } else {
            await replyPlanApprovalRetry(ctx, failure, sessionManager, planToken);
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
          await rejectStaleAction(ctx, () => clearApprovalPrompt(true));
          return { handled: true };
        }

        await clearApprovalPrompt(true);
        queueDecisionPressedNote(sessionManager, "plan-approve", sessionId, actionSessionName, tokenId);
        return { handled: true };
      }

      if (token.kind === "plan-reject" || token.kind === "plan-request-changes") {
        return await withPlanDecisionLock(decisionLockKey, tokenId, async () => {
          const latestToken = sessionManager.getActionToken(tokenId);
          if (!latestToken) {
            await rejectStaleAction(ctx, () => clearPlanDecisionButtons(ctx, callbackAcknowledged));
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
            await replyText(ctx, benign(latestInvalidPlanDecision));
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
            await rejectStaleAction(ctx, () => clearPlanDecisionButtons(ctx, callbackAcknowledged));
            return { handled: true };
          }

          await clearPlanDecisionButtons(ctx, callbackAcknowledged);
          if (consumedToken.kind === "plan-reject") {
            const result = rejectPlanDecision(sessionManager, sessionId, { repliedToUser: true });
            await replyText(ctx, `⛔ ${result.text}`);
            queueDecisionPressedNote(sessionManager, "plan-reject", sessionId, actionSessionName, tokenId);
          } else {
            // Also queues the orchestrator note that the next message is the change (N35).
            const result = requestPlanDecisionChanges(sessionManager, sessionId);
            await replyText(ctx, result.userText ?? (result.isError ? failureReply(actionSessionName, result.text) : `✏️ ${result.text}`));
          }
          return { handled: true };
        });
      }

      // Merge, PR, Later, and Discard on one worktree must not run concurrently:
      // Discard could delete the branch a Merge is working on. A resume of a
      // session with a worktree (Commit changes) takes the same lock, so Discard
      // cannot remove the worktree while the resume starts.
      const resumesWorktree = (token.kind === "session-resume" || token.kind === "session-restart")
        && Boolean(actionSession?.worktreePath);
      const worktreeLockKey = WORKTREE_DECISION_ACTIONS.has(token.kind) || resumesWorktree ? sessionId : undefined;
      if (worktreeLockKey && inFlightWorktreeDecisions.has(worktreeLockKey)) {
        await replyText(ctx, `⚠️ [${actionSessionName}] Another decision for this worktree is still being processed. Try again when it finishes.`);
        return { handled: true };
      }
      if (worktreeLockKey) inFlightWorktreeDecisions.add(worktreeLockKey);
      try {
        // A button from a worktree prompt that was already settled (for example
        // Discard after Merge) must not act on the finished worktree.
        const settledWorktree = WORKTREE_DECISION_ACTIONS.has(token.kind)
          ? resolvedWorktreeDecision(sessionManager.getPersistedSession?.(sessionId))
          : undefined;
        if (settledWorktree) {
          sessionManager.consumeActionToken(tokenId);
          await clearWorktreeDecisionButtons(ctx, callbackAcknowledged);
          await replyText(ctx, alreadyResolvedReply(actionSessionName, settledWorktree));
          return { handled: true };
        }

        // Read-only buttons (N47): they keep the message's other buttons and stay
        // usable, so they are neither consumed nor cleared.
        if (token.kind === "view-output") {
          const result = await makeAgentOutputTool().execute("callback", { session: sessionId, lines: 50 });
          await replyText(ctx, toolResultText(result));
          return { handled: true };
        }
        if (token.kind === "worktree-view-pr") {
          // Older builds sent View PR as a callback; current prompts use a link button.
          const url = token.targetUrl ?? sessionManager.getPersistedSession?.(sessionId)?.worktreePrUrl;
          await replyText(ctx, url ? `ℹ️ ${actionSession?.name ? `[${actionSession.name}] ` : ""}PR: ${url}` : "⚠️ The PR link is no longer available.");
          return { handled: true };
        }

        let consumedToken = sessionManager.consumeActionToken(tokenId);
        const consumptionId = consumedToken?.consumptionId;
        // The consumption must be on disk before acting, so another writer of the
        // index cannot treat this button as unused. When another writer persisted
        // a consumption of the same button first, its click acts and this one is stale.
        if (consumedToken) {
          await sessionManager.whenStorePersisted?.();
          if (sessionManager.confirmActionTokenConsumption?.(tokenId, consumptionId) === false) consumedToken = undefined;
        }
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
          await rejectStaleAction(ctx, () => clearInteractiveState(ctx, {
            alreadyAcknowledged: callbackAcknowledged,
            forceTelegramMarkupEdit: token.kind === "plan-offer-start" || token.kind === "plan-offer-dismiss"
              || token.kind === "goal-verifiers-confirm" || token.kind === "goal-verifiers-decline",
          }));
          return { handled: true };
        }

        // Route action
        let worktreeDecisionSucceeded = false;
        switch (consumedToken.kind) {
          case "plugin-update-install": {
            await clearUpdateActionButtons(ctx, callbackAcknowledged);
            logButtonDiagnostic("callback_update_action_started", {
              channel: ctx.channel,
              tokenHash: hashDiagnosticToken(tokenId),
              actionKind: consumedToken.kind,
              approvedVersion: consumedToken.pluginUpdateVersion,
            });
            if (!autoUpdateService) {
              logButtonDiagnostic("callback_update_action_failed", {
                channel: ctx.channel,
                tokenHash: hashDiagnosticToken(tokenId),
                reason: pluginConfig.autoUpdate ? "service_unavailable" : "auto_update_disabled",
              });
              await replyText(ctx, updateServiceUnavailableText());
              break;
            }
            let text: string;
            try {
              text = await autoUpdateService.installConfirmed(consumedToken.pluginUpdateVersion, {
                route: consumedToken.route,
              });
            } catch (err) {
              logButtonDiagnostic("callback_update_action_failed", {
                channel: ctx.channel,
                tokenHash: hashDiagnosticToken(tokenId),
                reason: "install_failed",
              });
              await replyText(ctx, failureReply(undefined, `Code Agent update failed: ${err instanceof Error ? err.message : String(err)}`));
              break;
            }
            logButtonDiagnostic("callback_update_action_completed", {
              channel: ctx.channel,
              tokenHash: hashDiagnosticToken(tokenId),
              approvedVersion: consumedToken.pluginUpdateVersion,
            });
            // Empty: the restart prompt (`⬆️ Code Agent X is installed. Restart…?`) is the answer.
            if (!text) break;
            try {
              await replyText(ctx, `⬆️ ${text}`);
            } catch (err) {
              logButtonDiagnostic("callback_update_confirmation_failed", {
                channel: ctx.channel,
                tokenHash: hashDiagnosticToken(tokenId),
                reason: "reply_failed",
              });
              log.warn(`[callback-handler] Code Agent update succeeded, but the confirmation reply failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            break;
          }

          case "plugin-update-restart": {
            await clearUpdateActionButtons(ctx, callbackAcknowledged);
            if (!autoUpdateService) {
              await replyText(ctx, updateServiceUnavailableText());
              break;
            }
            try {
              const text = await autoUpdateService.restartConfirmed(consumedToken.pluginUpdateVersion);
              await replyText(ctx, `⬆️ ${text}`);
            } catch (err) {
              await replyText(ctx, failureReply(undefined, `Gateway restart failed: ${err instanceof Error ? err.message : String(err)}`));
            }
            break;
          }

          case "plugin-update-dismiss": {
            await clearUpdateActionButtons(ctx, callbackAcknowledged);
            const text = autoUpdateService
              ? autoUpdateService.dismiss(consumedToken.pluginUpdateVersion)
              : "Skipped this update.";
            await replyText(ctx, `⏭️ ${text}`);
            break;
          }

          case "plugin-update-remind-later": {
            await clearUpdateActionButtons(ctx, callbackAcknowledged);
            const text = autoUpdateService
              ? autoUpdateService.remindLater(consumedToken.pluginUpdateVersion)
              : "OK. The update will be offered again tomorrow.";
            await replyText(ctx, `⏭️ ${text}`);
            break;
          }

          case "worktree-merge": {
            const result = await makeMergeTool().execute(USER_BUTTON_TOOL_CALL_ID, { session: sessionId });
            const text = toolResultText(result);
            if (toolResultSucceeded(result)) {
              await clearWorktreeDecisionButtons(ctx, callbackAcknowledged);
              worktreeDecisionSucceeded = true;
              // Nothing was posted (already merged, …): the first line of the tool
              // text is the answer; the rest is for the orchestrator.
              if (!toolResultOutcomeNotified(result)) await replyText(ctx, text.split("\n")[0]!);
              break;
            }
            await reofferWorktreeDecisionAfterFailure(ctx, sessionId, actionSessionName, callbackAcknowledged, "Merge", text);
            break;
          }

          case "worktree-decide-later": {
            const result = sessionManager.snoozeWorktreeDecision(sessionId, { notifyUser: false });
            const succeeded = worktreeActionTextSucceeded(result);
            if (succeeded) {
              await clearWorktreeDecisionButtons(ctx, callbackAcknowledged);
              await replyText(ctx, result);
              worktreeDecisionSucceeded = true;
            } else {
              await replyText(ctx, failureReply(actionSessionName, result));
            }
            break;
          }

          case "worktree-dismiss": {
            const result = await sessionManager.dismissWorktree(sessionId);
            const succeeded = worktreeActionTextSucceeded(result);
            // Already discarded (a second Discard button): nothing is left to re-offer.
            // Read from the worktree state, not from the reply text.
            const alreadyDiscarded = !succeeded && (
              resolvedWorktreeDecision(sessionManager.getPersistedSession?.(sessionId)) === "discarded"
              || sessionManager.resolve?.(sessionId)?.worktreeState === "dismissed"
            );
            if (succeeded || alreadyDiscarded) await clearWorktreeDecisionButtons(ctx, callbackAcknowledged);
            if (succeeded) worktreeDecisionSucceeded = true;
            // On success the `🗑️ [name] Discarded: …` notice is the one answer.
            if (alreadyDiscarded) await replyText(ctx, result.startsWith("Error") ? failureReply(actionSessionName, result) : result);
            else if (!succeeded) await reofferWorktreeDecisionAfterFailure(ctx, sessionId, actionSessionName, callbackAcknowledged, "Discard", result);
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
            let result = await makePrTool().execute(USER_BUTTON_TOOL_CALL_ID, {
              session: sessionId,
              // The New PR button, offered after its PR was found closed without merging.
              ...(consumedToken.prForceNew ? { force_new: true } : {}),
            });
            // The PR was reopened or merged since New PR was offered: the press
            // is then a normal PR action (sync the open PR, or record the merge).
            if (consumedToken.prForceNew && !toolResultSucceeded(result) && FORCE_NEW_REFUSED_PATTERN.test(toolResultText(result))) {
              result = await makePrTool().execute(USER_BUTTON_TOOL_CALL_ID, { session: sessionId });
            }
            const text = toolResultText(result);
            if (toolResultSucceeded(result)) {
              await clearWorktreeDecisionButtons(ctx, callbackAcknowledged);
              worktreeDecisionSucceeded = true;
              // Nothing was posted (PR already merged or up to date): the first line
              // of the tool text is the answer; the rest is for the orchestrator.
              if (!toolResultOutcomeNotified(result)) await replyText(ctx, text.split("\n")[0]!);
              break;
            }
            await reofferWorktreeDecisionAfterFailure(ctx, sessionId, actionSessionName, callbackAcknowledged, "PR", text);
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
              session = await sessionManager.launchPlanOffer({
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
              await replyText(ctx, failureReply(consumedToken.launchName, `Planning session did not start: ${errText}`));
              break;
            }
            await clearInteractiveState(ctx, {
              alreadyAcknowledged: callbackAcknowledged,
              forceTelegramMarkupEdit: true,
            });
            // The launch posts `🚀 [name] Launched | …` to the offer's route, the
            // chat of this button. Without a route nothing is posted there.
            if (!consumedToken.route) await replyText(ctx, `🚀 [${session.name}] Planning session started`);
            break;
          }

          case "plan-offer-dismiss": {
            await clearInteractiveState(ctx, {
              alreadyAcknowledged: callbackAcknowledged,
              forceTelegramMarkupEdit: true,
            });
            await replyText(ctx, `⏭️ Plan offer dismissed.`);
            break;
          }

          case "goal-verifiers-confirm":
          case "goal-verifiers-decline": {
            await clearInteractiveState(ctx, {
              alreadyAcknowledged: callbackAcknowledged,
              forceTelegramMarkupEdit: true,
            });
            if (!goalController) {
              await replyText(ctx, SERVICE_NOT_RUNNING);
              break;
            }
            // The controller's notice is the one answer (`🎯 [task] Goal task started`,
            // `⛔ [task] Goal task stopped`, `❌ [task] Goal task failed`, each with
            // its reason); the button replies only when no notice is sent.
            try {
              const outcome = consumedToken.kind === "goal-verifiers-decline"
                ? goalController.declineVerifierCommands(sessionId)
                : await goalController.confirmVerifierCommands(sessionId);
              if (!outcome) await replyText(ctx, "⚠️ That goal task no longer exists.");
              else if (outcome.action === "not_waiting") {
                await replyText(ctx, `⚠️ [${outcome.task.name}] Goal task is no longer waiting for confirmation (${userGoalStatusWord(outcome.task.status)}).`);
              }
            } catch (err) {
              // A failed start is reported by `❌ [task] Goal task failed`.
              if (goalController.getTask?.(sessionId)?.status !== "failed") {
                await replyText(ctx, failureReply(goalController.getTask?.(sessionId)?.name, `Goal task did not start: ${err instanceof Error ? err.message : String(err)}`));
              }
            }
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
              const resolution = await sessionManager.resolveRepoPolicy(consumedToken.repoPolicyWorkdir);
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
            const record = await sessionManager.setRepoPolicy(consumedToken.repoPolicyWorkdir, consumedToken.repoPolicy);
            if (!record) {
              await clearInteractiveState(ctx, {
                alreadyAcknowledged: callbackAcknowledged,
                forceTelegramMarkupEdit: true,
              });
              await replyText(ctx, `⚠️ Could not resolve a git repository for ${consumedToken.repoPolicyWorkdir}.`);
              break;
            }
            sessionManager.clearRepoPolicyChoiceTokens(consumedToken.sessionId);

            try {
              await sessionManager.launchAfterRepoPolicyChoice({
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
                rewindTurns: consumedToken.launchRewindTurns,
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
            } catch (err) {
              const errText = err instanceof Error ? err.message : String(err);
              await clearInteractiveState(ctx, {
                alreadyAcknowledged: callbackAcknowledged,
                forceTelegramMarkupEdit: true,
              });
              await replyText(ctx, failureReply(consumedToken.launchName, `Repo policy saved, but the launch failed: ${errText}`));
              break;
            }

            await clearInteractiveState(ctx, {
              alreadyAcknowledged: callbackAcknowledged,
              forceTelegramMarkupEdit: true,
            });
            // The `🚀 [name] Launched | …` notice follows; the launch summary is for the orchestrator.
            await replyText(ctx, `🧭 Repo policy saved: ${getRepoPolicyOption(record.policy).title}.`);
            break;
          }

          case "session-restart":
          case "session-resume": {
            await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
            // A plain Resume on a session that already runs has nothing to do:
            // no "Continue where you left off." is sent to the agent. A button
            // with its own instruction (Commit changes) still delivers it.
            if (!consumedToken.launchPrompt && sessionManager.resolve?.(sessionId)?.status === "running") {
              await replyText(ctx, `ℹ️ [${actionSessionName}] Already running.`);
              break;
            }
            const result = await executeRespond(sessionManager, {
              session: sessionId,
              // A resume button may carry its own instruction (for example "commit your changes").
              message: consumedToken.launchPrompt ?? "Continue where you left off.",
              userInitiated: true,
            });
            // A resume already posts its own notice (`▶️ [name] Resumed | …`, `Relaunched fresh`, `👍 Plan approved`).
            if (result.isError) await replyText(ctx, result.userText ?? failureReply(actionSessionName, result.text));
            // Nothing resumed (the instruction went to a running session): say what happened.
            else if (!result.userNoticeSent) await replyText(ctx, result.userText ?? `▶️ [${actionSessionName}] Resumed.`);
            break;
          }

          default: {
            await clearInteractiveState(ctx, { alreadyAcknowledged: callbackAcknowledged });
            await replyText(ctx, `⚠️ This button is not supported by the running version of the code agent.`);
            break;
          }
        }

        if (worktreeDecisionSucceeded) {
          queueDecisionPressedNote(sessionManager, token.kind, sessionId, actionSessionName, tokenId);
        }

        return { handled: true };
      } finally {
        if (worktreeLockKey) inFlightWorktreeDecisions.delete(worktreeLockKey);
      }
    },
  };
}
