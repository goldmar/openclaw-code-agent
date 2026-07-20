import { removeWorktree, deleteBranch } from "./worktree";
import { formatDuration, truncateText } from "./format";
import { getPersistedMutationRefs, usesNativeBackendWorktree } from "./session-backend-ref";
import {
  buildCompletedPayload,
  buildFailedPayload,
  buildPlanApprovalFallbackText,
  buildTurnCompletePayload,
  buildWaitingForInputPayload,
  getStoppedStatusLabel,
} from "./session-notification-builder";
import { resolveNotificationRoute } from "./session-route";
import {
  buildPlanApprovalDeliveryFailureWake,
  buildPlanApprovalWakeText,
  hasProvablePlanReviewPrompt,
  isCurrentPendingPlanDecision,
} from "./session-plan-approval-delivery";
import type { Session } from "./session";
import type { PersistedSessionInfo, PlanApprovalMode, PlanArtifact } from "./types";
import type { PendingInputQuestion, PendingInputState } from "./types";
import type { NotificationButton } from "./session-interactions";
import type { SessionNotificationRequest } from "./wake-dispatcher";
import { existsSync, readFileSync } from "fs";
import {
  buildQuestionContextMicroSummary,
  type QuestionContextSummaryProvider,
} from "./question-context-summary";

type WorktreeStrategyResult = {
  notificationSent: boolean;
  worktreeRemoved: boolean;
};

type DispatchNotification = (session: Session, request: SessionNotificationRequest) => void;
const OPTION_DESCRIPTION_MAX_CHARS = 280;

function resolvePlanArtifactForPrompt(
  session: Pick<Session, "latestPlanArtifactVersion" | "latestPlanArtifact" | "planFilePath">,
  planDecisionVersion?: number,
): PlanArtifact | undefined {
  if (session.latestPlanArtifactVersion === planDecisionVersion && session.latestPlanArtifact) {
    return session.latestPlanArtifact;
  }

  const planPath = session.planFilePath?.trim();
  if (!planPath || !existsSync(planPath)) return undefined;

  try {
    const markdown = readFileSync(planPath, "utf-8").trim();
    if (!markdown) return undefined;
    return { markdown, steps: [] };
  } catch {
    return undefined;
  }
}

function buildActiveQuestionPrompt(args: {
  question: PendingInputQuestion;
  index: number;
  total: number;
  optionDescriptions: Array<{ label: string; description: string }>;
}): string {
  const title = [
    args.total > 1 ? `Question ${args.index + 1}` : undefined,
    args.question.header,
  ].filter(Boolean).join(" - ");
  const lines = [
    ...(title ? [title] : []),
    args.question.question,
  ];
  if (args.optionDescriptions.length > 0) {
    lines.push(
      "",
      "Options:",
      ...args.optionDescriptions.map((option) => `${option.label} - ${option.description}`),
    );
  }
  return lines.join("\n");
}

function buildInlineOptionDescriptions(question: PendingInputQuestion): Array<{ label: string; description: string }> {
  return question.options
    .map((option) => ({
      label: option.label,
      description: option.description?.trim() ?? "",
    }))
    .filter((option) => option.description && option.description.length <= OPTION_DESCRIPTION_MAX_CHARS);
}

function activePendingInputQuestionIdentity(state: PendingInputState | undefined): string | undefined {
  const activeQuestionIndex = state?.activeQuestionIndex ?? 0;
  return state?.questions?.[activeQuestionIndex]?.id
    ?? (state?.activeQuestionIndex != null ? `q${state.activeQuestionIndex}` : undefined);
}

function isCurrentPendingInputQuestion(
  session: Session,
  requestId: string,
  activeQuestionIdentity: string | undefined,
): boolean {
  const state = session.pendingInputState;
  return Boolean(
    state
    && state.requestId === requestId
    && activePendingInputQuestionIdentity(state) === activeQuestionIdentity,
  );
}

function buildTurnCycleKey(session: Pick<Session, "startedAt" | "result">): string {
  return [
    session.startedAt ?? "unknown-started-at",
    session.result?.session_id ?? "unknown-backend-session",
    session.result?.num_turns ?? 0,
  ].join(":");
}

function buildTerminalCycleKey(
  session: Pick<Session, "status" | "startedAt" | "result" | "killReason">,
): string {
  return [
    session.status,
    session.startedAt ?? "unknown-started-at",
    session.result?.session_id ?? "unknown-backend-session",
    session.result?.num_turns ?? 0,
    session.killReason ?? "unknown",
  ].join(":");
}

export class SessionLifecycleService {
  constructor(
    private readonly deps: {
      persistSession: (session: Session) => void;
      clearWaitingTimestamp: (sessionId: string) => void;
      handleWorktreeStrategy: (session: Session) => Promise<WorktreeStrategyResult>;
      resolveWorktreeRepoDir: (repoDir: string | undefined, worktreePath?: string) => string | undefined;
      updatePersistedSession: (ref: string, patch: Partial<PersistedSessionInfo>) => boolean;
      dispatchSessionNotification: DispatchNotification;
      notifySession: (session: Session, text: string, label?: string, idempotencyKey?: string) => void;
      clearRetryTimersForSession: (sessionId: string) => void;
      hasTurnCompleteWakeMarker: (sessionId: string) => boolean;
      shouldEmitTurnCompleteWake: (session: Session) => boolean;
      shouldEmitTerminalWake: (session: Session) => boolean;
      resolvePlanApprovalMode: (session: Session | PersistedSessionInfo) => PlanApprovalMode;
      getPlanApprovalButtons: (sessionId: string, session?: {
        worktreePrUrl?: string;
        isExplicitlyResumable?: boolean;
        planDecisionVersion?: number;
        actionablePlanDecisionVersion?: number;
      }) => NotificationButton[][];
      getResumeButtons: (sessionId: string, session: {
        worktreePrUrl?: string;
        isExplicitlyResumable?: boolean;
        planDecisionVersion?: number;
      }) => NotificationButton[][];
      getQuestionButtons: (
        sessionId: string,
        options: Array<{ label: string }>,
        context?: { requestId?: string; questionId?: string },
      ) => NotificationButton[][] | undefined;
      extractLastOutputLine: (session: Session) => string | undefined;
      getOutputPreview: (session: Session, maxChars?: number) => string;
      originThreadLine: (session: Session) => string;
      debounceWaitingEvent: (sessionId: string, identityKey?: string) => boolean;
      isAlreadyMerged: (ref: string | undefined) => boolean;
      questionContextSummaryProvider?: QuestionContextSummaryProvider;
    },
  ) {}

  private dispatchPlanApprovalFallback(session: Session, planDecisionVersion: number | undefined, summary: string): void {
    const now = new Date().toISOString();
    this.deps.dispatchSessionNotification(session, {
      label: "plan-approval-fallback",
      idempotencyKey: `plan-approval:${session.id}:v${planDecisionVersion ?? "unknown"}:fallback`,
      userMessage: buildPlanApprovalFallbackText({ session, summary }),
      notifyUser: "always",
      shouldDispatch: () => isCurrentPendingPlanDecision(session, planDecisionVersion),
      hooks: {
        onNotifyStarted: () => {
          this.deps.updatePersistedSession(session.id, {
            approvalPromptRequiredVersion: planDecisionVersion,
            approvalPromptVersion: planDecisionVersion,
            approvalPromptStatus: "sending",
            approvalPromptTransport: "direct-message",
            approvalPromptMessageKind: "explicit_fallback_text",
            approvalPromptLastAttemptAt: now,
          });
        },
        onNotifySucceeded: () => {
          this.deps.updatePersistedSession(session.id, {
            approvalPromptRequiredVersion: planDecisionVersion,
            approvalPromptVersion: planDecisionVersion,
            approvalPromptStatus: "fallback_delivered",
            approvalPromptTransport: "direct-message",
            approvalPromptMessageKind: "explicit_fallback_text",
            approvalPromptLastAttemptAt: now,
            approvalPromptDeliveredAt: new Date().toISOString(),
            approvalPromptFailedAt: undefined,
          });
        },
        onNotifyFailed: () => {
          this.deps.updatePersistedSession(session.id, {
            approvalPromptRequiredVersion: planDecisionVersion,
            approvalPromptVersion: planDecisionVersion,
            approvalPromptStatus: "failed",
            approvalPromptTransport: "direct-message",
            approvalPromptMessageKind: "explicit_fallback_text",
            approvalPromptLastAttemptAt: now,
            approvalPromptFailedAt: new Date().toISOString(),
          });
        },
      },
      wakeMessageOnNotifySuccess: buildPlanApprovalWakeText(session, planDecisionVersion, true),
      wakeMessageOnNotifyFailed: buildPlanApprovalDeliveryFailureWake({
        session,
        planDecisionVersion,
        originThreadLine: this.deps.originThreadLine(session),
      }),
    });
  }

  private logCompletionWakeDiagnostic(args: {
    session: Pick<Session, "id" | "name">;
    event: string;
    canonicalStatusDelivered?: boolean;
    followupSummaryRequired: boolean;
  }): void {
    console.info(JSON.stringify({
      event: args.event,
      sessionId: args.session.id,
      sessionName: args.session.name,
      canonicalStatusDelivered: args.canonicalStatusDelivered,
      requestedShortFactualSummary: args.followupSummaryRequired,
      completionKind: "terminal",
    }));
  }

  private shouldRequestCompletionFollowup(
    session: Pick<Session, "originChannel" | "originThreadId" | "originSessionKey" | "route">,
  ): boolean {
    const originSessionKey = session.originSessionKey?.trim();
    if (originSessionKey?.startsWith("agent:main:cron:")) {
      return false;
    }

    return Boolean(resolveNotificationRoute(session));
  }

  async handleTurnEnd(session: Session, hadQuestion: boolean): Promise<void> {
    if (session.status !== "running") {
      console.info(
        `[SessionManager] Suppressing turn-end wake for session ${session.id} ` +
        `(status=${session.status}) — terminal notification owns the completion path.`,
      );
      return;
    }

    if (session.goalTaskId) {
      return;
    }

    if (hadQuestion || session.pendingPlanApproval) {
      await this.emitWaitingForInput(session);
      return;
    }

    if (session.worktreeStrategy === "ask" || session.worktreeStrategy === "delegate") {
      console.info(
        `[SessionManager] Suppressing turn-complete wake for session ${session.id} ` +
        `(worktreeStrategy=${session.worktreeStrategy}) — worktree notification will follow.`,
      );
      return;
    }

    if (!this.deps.shouldEmitTurnCompleteWake(session)) return;
    this.emitTurnComplete(session);
  }

  async handleSessionTerminal(session: Session): Promise<void> {
    this.deps.persistSession(session);
    this.deps.clearWaitingTimestamp(session.id);
    if (session.goalTaskId) {
      this.deps.clearRetryTimersForSession(session.id);
      return;
    }

    let worktreeResult: WorktreeStrategyResult = {
      notificationSent: false,
      worktreeRemoved: false,
    };
    if (session.worktreePath && session.originalWorkdir) {
      worktreeResult = await this.deps.handleWorktreeStrategy(session);
    }

    let worktreeAutoCleaned = false;
    if (
      session.worktreePath &&
      session.originalWorkdir &&
      session.status === "failed" &&
      session.costUsd === 0 &&
      session.duration < 30_000
    ) {
      const repoDir = this.deps.resolveWorktreeRepoDir(session.originalWorkdir, session.worktreePath);
      const branchName = session.worktreeBranch;
      const nativeBackendWorktree = usesNativeBackendWorktree(session);
      console.info(
        `[SessionManager] Early startup failure for "${session.name}" — auto-cleaning worktree ` +
        `(cost=$${session.costUsd.toFixed(2)}, duration=${session.duration}ms)`,
      );

      let removedWorktree = false;
      if (repoDir && !nativeBackendWorktree) {
        removedWorktree = removeWorktree(repoDir, session.worktreePath);
      }

      if (repoDir && branchName && !nativeBackendWorktree && removedWorktree) {
        deleteBranch(repoDir, branchName);
      }

      if (removedWorktree) {
        for (const mutationRef of getPersistedMutationRefs(session)) {
          this.deps.updatePersistedSession(mutationRef, {
            worktreePath: undefined,
            worktreeBranch: undefined,
          });
        }
        worktreeAutoCleaned = true;
      }
    }

    const nonTrivialWorktreeStrategy = session.worktreeStrategy &&
      session.worktreeStrategy !== "off" && session.worktreeStrategy !== "manual";
    if (!worktreeAutoCleaned && session.worktreePath && session.originalWorkdir) {
      const repoDir = this.deps.resolveWorktreeRepoDir(session.originalWorkdir, session.worktreePath);
      const nativeBackendWorktree = usesNativeBackendWorktree(session);
      if (worktreeResult.worktreeRemoved) {
        console.info(
          `[SessionManager] Worktree already removed for "${session.name}" during strategy handling.`,
        );
      } else if (nonTrivialWorktreeStrategy) {
        console.info(
          `[SessionManager] Keeping worktree alive for "${session.name}" (strategy=${session.worktreeStrategy}) — will be cleaned up on explicit resolution.`,
        );
      } else if (repoDir && !nativeBackendWorktree) {
        removeWorktree(repoDir, session.worktreePath);
      }
    }

    if (worktreeResult.notificationSent) {
      console.info(
        `[SessionManager] Suppressing generic terminal notification for session ${session.id} ` +
        "because worktree strategy handling already sent the authoritative outcome notification.",
      );
      return;
    }

    if (session.killReason === "done") {
      if (this.deps.hasTurnCompleteWakeMarker(session.id)) return;
      if (!this.deps.shouldEmitTerminalWake(session)) return;
      this.emitCompleted(session);
      return;
    }

    if (session.status === "completed") {
      if (!this.deps.shouldEmitTerminalWake(session)) return;
      this.emitCompleted(session);
      return;
    }

    if (session.status === "failed") {
      if (!this.deps.shouldEmitTerminalWake(session)) return;
      const rawError = session.error
        || (session.result?.is_error && session.result.result)
        || session.result?.result
        || this.deps.extractLastOutputLine(session)
        || `Session failed with no error details (session=${session.id}, subtype=${session.result?.subtype ?? "none"}, turns=${session.result?.num_turns ?? 0})`;
      this.emitFailed(session, truncateText(rawError, 200), worktreeAutoCleaned);
      return;
    }

    const costStr = `$${(session.costUsd ?? 0).toFixed(2)}`;
    const duration = session.duration;
    if (session.killReason === "idle-timeout") {
      const planApprovalMode = session.pendingPlanApproval
        ? this.deps.resolvePlanApprovalMode(session)
        : undefined;
      if (session.pendingPlanApproval) {
        const actionableVersion = session.actionablePlanDecisionVersion ?? session.planDecisionVersion;
        const promptAlreadyProven = hasProvablePlanReviewPrompt(session, actionableVersion);
        if (planApprovalMode === "delegate") {
          this.deps.dispatchSessionNotification(session, {
            label: "plan-approval-timeout",
            idempotencyKey: `plan-approval-timeout:${session.id}:v${actionableVersion ?? "unknown"}:delegate`,
            wakeMessage: [
              `[DELEGATED PLAN APPROVAL REMINDER] Plan review is still pending after the session hit idle timeout.`,
              `Name: ${session.name} | ID: ${session.id}`,
              this.deps.originThreadLine(session),
              `The agent already produced a plan and is waiting for a delegated decision.`,
              `Review privately first. Approve directly with agent_respond(..., approve=true, approval_rationale='...') if the plan is clearly within scope and low risk.`,
              `Escalate only if needed via agent_request_plan_approval(summary='...').`,
              `If you approve directly, follow up with a short user-facing explanation; the plugin's thumbs-up line is only the minimal approval acknowledgment.`,
              `If a canonical approval prompt was already posted for this plan version, do not restate it in plain text.`,
            ].join("\n"),
            notifyUser: "never",
          });
          this.deps.clearRetryTimersForSession(session.id);
          return;
        }
        if (planApprovalMode === "ask" && promptAlreadyProven) {
          this.deps.dispatchSessionNotification(session, {
            label: "plan-approval-timeout",
            idempotencyKey: `plan-approval-timeout:${session.id}:v${actionableVersion ?? "unknown"}:already-delivered`,
            notifyUser: "never",
            wakeMessage: [
              `[PLAN APPROVAL REMINDER] The user already has an actionable plan review prompt for this plan version.`,
              `Name: ${session.name} | ID: ${session.id} | Plan v${actionableVersion ?? "?"}`,
              this.deps.originThreadLine(session),
              `Do NOT post another approval summary unless canonical delivery is known to be missing.`,
            ].join("\n"),
          });
          this.deps.clearRetryTimersForSession(session.id);
          return;
        }
        this.deps.dispatchSessionNotification(session, {
          label: "plan-approval-timeout",
          idempotencyKey: `plan-approval-timeout:${session.id}:v${actionableVersion ?? "unknown"}:user-prompt`,
          userMessage: [
            `📋 [${session.name}] Plan v${actionableVersion ?? "?"} still awaiting approval after idle timeout | ${costStr} | ${formatDuration(duration)}`,
            ``,
            `The agent already produced a plan and is waiting for your decision.`,
            `Approve resumes the session and starts implementation.`,
            `Revise resumes it in plan mode so it can update the plan first.`,
            `Reject keeps the session stopped.`,
          ].join("\n"),
          notifyUser: "always",
          buttons: planApprovalMode === "ask" && !promptAlreadyProven
            ? this.deps.getPlanApprovalButtons(session.id, {
              ...session,
              planDecisionVersion: actionableVersion,
            })
            : undefined,
        });
        this.deps.clearRetryTimersForSession(session.id);
        return;
      }
      this.deps.dispatchSessionNotification(session, {
        label: "suspended",
        idempotencyKey: `suspended:${session.id}:${session.killReason ?? "idle-timeout"}:${session.completedAt ?? "unknown"}`,
        userMessage: `💤 [${session.name}] Suspended after idle timeout | ${costStr} | ${formatDuration(duration)}`,
        notifyUser: "always",
        buttons: this.deps.getResumeButtons(session.id, session),
      });
      this.deps.clearRetryTimersForSession(session.id);
      return;
    }

    this.deps.notifySession(session, `⛔ [${session.name}] ${getStoppedStatusLabel(session.killReason)} | ${costStr} | ${formatDuration(duration)}`);
    this.deps.clearRetryTimersForSession(session.id);
  }

  async emitWaitingForInput(session: Session): Promise<void> {
    const pendingInputQuestions = session.pendingInputState?.questions;
    const activePendingInputQuestion = pendingInputQuestions?.[
      session.pendingInputState?.activeQuestionIndex ?? 0
    ];
    // Snapshot notification key before async gap to avoid race when user answers during summary generation.
    const pendingInputRequestId = session.pendingInputState?.requestId;
    const pendingInputQuestionIdentity = activePendingInputQuestionIdentity(session.pendingInputState);
    const pendingInputNotificationKey = pendingInputRequestId
      ? [
          pendingInputRequestId,
          pendingInputQuestionIdentity,
        ].filter(Boolean).join(":")
      : undefined;
    const pendingInputDebounceKey = pendingInputNotificationKey
      ? `pending-input:${pendingInputNotificationKey}`
      : undefined;

    if (!this.deps.debounceWaitingEvent(session.id, pendingInputDebounceKey)) return;

    const planApprovalMode = session.pendingPlanApproval
      ? this.deps.resolvePlanApprovalMode(session)
      : undefined;
    const planDecisionVersion = session.actionablePlanDecisionVersion ?? session.planDecisionVersion;
    const promptAlreadyProven =
      session.pendingPlanApproval
      && planApprovalMode === "ask"
      && hasProvablePlanReviewPrompt(session, planDecisionVersion);
    const pendingInputPromptText = session.pendingInputState?.promptText?.trim() || undefined;
    const questionContextPreview = !session.pendingPlanApproval
      ? this.deps.getOutputPreview(session)
      : undefined;
    const preview =
      (!session.pendingPlanApproval && pendingInputPromptText)
        ? pendingInputPromptText
        : (!session.pendingPlanApproval && questionContextPreview !== undefined)
          ? questionContextPreview
          : this.deps.getOutputPreview(
            session,
            session.pendingPlanApproval && planApprovalMode !== "delegate"
              ? Number.POSITIVE_INFINITY
              : undefined,
          );
    const fallbackPendingInputButtonOptions =
      session.pendingInputState?.options.map((label) => ({ label })) ?? [];

    // Resolve which buttons (if any) to show for the current pending input.
    // Structured multi-question wizard: show per-question options only for simple single-select,
    // non-"Other", ≤6-option questions. Fall back to top-level options only for the classic
    // single-question no-structured-options case. Everything else uses no buttons (free-text or complex).
    const pendingInputButtonOptions: Array<{ label: string }> = (() => {
      if (!pendingInputQuestions || pendingInputQuestions.length === 0) {
        return fallbackPendingInputButtonOptions;
      }
      if (
        activePendingInputQuestion &&
        activePendingInputQuestion.options.length > 0 &&
        activePendingInputQuestion.options.length <= 6 &&
        !activePendingInputQuestion.options.some((o) => o.isOther) &&
        !activePendingInputQuestion.multiSelect
      ) {
        return activePendingInputQuestion.options;
      }
      if (
        pendingInputQuestions.length === 1 &&
        activePendingInputQuestion &&
        activePendingInputQuestion.options.length === 0
      ) {
        return fallbackPendingInputButtonOptions;
      }
      return [];
    })();
    const waitingButtons =
      session.pendingPlanApproval && planApprovalMode === "ask" && !promptAlreadyProven
        ? this.deps.getPlanApprovalButtons(session.id, {
          ...session,
          planDecisionVersion,
        })
        : (!session.pendingPlanApproval && pendingInputButtonOptions.length)
          ? this.deps.getQuestionButtons(
              session.id,
              pendingInputButtonOptions,
              {
                requestId: session.pendingInputState?.requestId,
                questionId: activePendingInputQuestion?.id,
              },
            )
        : undefined;
    const matchingPlanArtifact = resolvePlanArtifactForPrompt(session, planDecisionVersion);
    const optionDescriptionSummaries = activePendingInputQuestion
      ? buildInlineOptionDescriptions(activePendingInputQuestion)
      : [];
    const questionText = activePendingInputQuestion
      ? buildActiveQuestionPrompt({
          question: activePendingInputQuestion,
          index: session.pendingInputState?.activeQuestionIndex ?? 0,
          total: pendingInputQuestions?.length ?? 1,
          optionDescriptions: optionDescriptionSummaries,
        })
      : pendingInputPromptText;
    const questionContextSummary = !session.pendingPlanApproval && this.deps.questionContextSummaryProvider
      ? await buildQuestionContextMicroSummary({
          sessionName: session.name,
          question: questionText ?? preview,
          context: questionContextPreview,
          provider: this.deps.questionContextSummaryProvider,
        })
      : undefined;
    const payload = buildWaitingForInputPayload({
      session,
      preview,
      questionText: !session.pendingPlanApproval ? questionText : undefined,
      questionContextPreview,
      questionContextSummary,
      planArtifact: matchingPlanArtifact,
      originThreadLine: this.deps.originThreadLine(session),
      planApprovalMode,
      planApprovalButtons: waitingButtons,
      questionButtons: !session.pendingPlanApproval ? waitingButtons : undefined,
    });
    const planReviewSummary = payload.planReviewSummary ?? preview;

    if (payload.label === "plan-approval" && planApprovalMode === "ask" && promptAlreadyProven) {
      this.deps.dispatchSessionNotification(session, {
        label: payload.label,
        idempotencyKey: `plan-approval:${session.id}:v${planDecisionVersion ?? "unknown"}:canonical`,
        userMessage: payload.userMessage,
        userMessages: payload.userMessages,
        notifyUser: "never",
        buttons: payload.buttons,
        wakeMessage: payload.wakeMessage,
      });
      return;
    }

    if (payload.label === "plan-approval" && planApprovalMode === "ask") {
      this.deps.dispatchSessionNotification(session, {
        label: payload.label,
        idempotencyKey: `plan-approval:${session.id}:v${planDecisionVersion ?? "unknown"}:canonical`,
        userMessage: payload.userMessage,
        userMessages: payload.userMessages,
        notifyUser: "always",
        buttons: payload.buttons,
        hooks: {
          onNotifyStarted: () => {
            this.deps.updatePersistedSession(session.id, {
              approvalPromptRequiredVersion: planDecisionVersion,
              approvalPromptVersion: planDecisionVersion,
              approvalPromptStatus: "sending",
              approvalPromptTransport: "direct-message",
              approvalPromptMessageKind: "canonical_buttons",
              approvalPromptLastAttemptAt: new Date().toISOString(),
            });
          },
          onNotifySucceeded: () => {
            this.deps.updatePersistedSession(session.id, {
              canonicalPlanPromptVersion: planDecisionVersion,
              approvalPromptRequiredVersion: planDecisionVersion,
              approvalPromptVersion: planDecisionVersion,
              approvalPromptStatus: "delivered",
              approvalPromptTransport: "direct-message",
              approvalPromptMessageKind: "canonical_buttons",
              approvalPromptDeliveredAt: new Date().toISOString(),
              approvalPromptFailedAt: undefined,
            });
          },
          onNotifyFailed: () => {
            this.deps.updatePersistedSession(session.id, {
              approvalPromptRequiredVersion: planDecisionVersion,
              approvalPromptVersion: planDecisionVersion,
              approvalPromptStatus: "failed",
              approvalPromptTransport: "direct-message",
              approvalPromptMessageKind: "canonical_buttons",
              approvalPromptFailedAt: new Date().toISOString(),
            });
          },
        },
        shouldDispatch: () => isCurrentPendingPlanDecision(session, planDecisionVersion),
        onUserNotifyFailed: () => this.dispatchPlanApprovalFallback(session, planDecisionVersion, planReviewSummary),
        wakeMessageOnNotifySuccess: buildPlanApprovalWakeText(session, planDecisionVersion),
      });
      return;
    }

    if (payload.label === "plan-approval") {
      this.deps.dispatchSessionNotification(session, {
        label: payload.label,
        idempotencyKey: `plan-approval:${session.id}:v${planDecisionVersion ?? "unknown"}:wake-only`,
        userMessage: payload.userMessage,
        wakeMessage: payload.wakeMessage,
        notifyUser: "never",
        buttons: payload.buttons,
      });
      return;
    }

    this.deps.dispatchSessionNotification(session, {
      label: payload.label,
      idempotencyKey: `waiting:${session.id}:${pendingInputNotificationKey ?? `${payload.label}:${payload.userMessage}`}`,
      userMessage: payload.userMessage,
      notifyUser: "always",
      buttons: payload.buttons,
      shouldDispatch: pendingInputRequestId
        ? () => isCurrentPendingInputQuestion(session, pendingInputRequestId, pendingInputQuestionIdentity)
        : undefined,
      wakeMessageOnNotifyFailed: payload.wakeMessage,
    });
  }

  emitTurnComplete(session: Session): void {
    console.info(
      `[SessionManager] turn-complete wake dispatching for session ${session.id} ` +
      `(turns=${session.result?.num_turns ?? 0}, strategy=${session.worktreeStrategy ?? "none"})`,
    );
    const payload = buildTurnCompletePayload({
      session,
      originThreadLine: this.deps.originThreadLine(session),
      preview: this.deps.getOutputPreview(session),
    });

    this.deps.dispatchSessionNotification(session, {
      label: "turn-complete",
      idempotencyKey: `turn-complete:${session.id}:${buildTurnCycleKey(session)}`,
      userMessage: payload.userMessage,
      wakeMessage: payload.wakeMessage,
      // Turn boundaries are internal lifecycle telemetry. The wake still lets
      // the orchestrator advance the workflow without another user push.
      notifyUser: "never",
      onUserNotifyFailed: () => {
        console.warn(
          `[SessionManager] turn-complete delivery failed for session ${session.id} — firing terminal notification as fallback`,
        );
        if (!this.deps.shouldEmitTerminalWake(session)) return;
        this.emitCompleted(session);
      },
    });
  }

  emitCompleted(session: Session): void {
    const preview = this.deps.getOutputPreview(session);
    const followupSummaryRequired = this.shouldRequestCompletionFollowup(session);
    const payload = buildCompletedPayload({
      session,
      originThreadLine: this.deps.originThreadLine(session),
      preview,
    });
    const terminalCycleKey = buildTerminalCycleKey(session);
    const terminalOutcomeKey = `terminal:${session.id}:${terminalCycleKey}`;
    let canonicalStatusDelivered: boolean | undefined;
    this.deps.dispatchSessionNotification(session, {
      label: "completed",
      idempotencyKey: `terminal-completed:${session.id}:${terminalCycleKey}`,
      userMessage: payload.userMessage,
      notifyUser: "always",
      completionSummary: {
        required: followupSummaryRequired,
        producer: "terminal",
        outcomeKey: terminalOutcomeKey,
      },
      completionWakeSummaryRequired: followupSummaryRequired,
      completionWakeOutcomeKey: terminalOutcomeKey,
      requireDirectUserNotification: true,
      wakeMessageOnNotifySuccess: followupSummaryRequired ? payload.wakeMessageOnNotifySuccess : undefined,
      wakeMessageOnNotifyFailed: followupSummaryRequired ? payload.wakeMessageOnNotifyFailed : undefined,
      hooks: {
        onNotifySucceeded: () => {
          canonicalStatusDelivered = true;
          this.logCompletionWakeDiagnostic({
            session,
            event: "completion_notify_succeeded",
            canonicalStatusDelivered,
            followupSummaryRequired,
          });
        },
        onNotifyFailed: () => {
          canonicalStatusDelivered = false;
          this.logCompletionWakeDiagnostic({
            session,
            event: "completion_notify_failed",
            canonicalStatusDelivered,
            followupSummaryRequired,
          });
        },
        onWakeSucceeded: () => {
          this.logCompletionWakeDiagnostic({
            session,
            event: "completion_wake_succeeded",
            canonicalStatusDelivered,
            followupSummaryRequired,
          });
        },
      },
    });
  }

  emitFailed(session: Session, errorSummary: string, worktreeAutoCleaned: boolean): void {
    const payload = buildFailedPayload({
      session,
      originThreadLine: this.deps.originThreadLine(session),
      errorSummary,
      preview: this.deps.getOutputPreview(session),
      worktreeAutoCleaned,
      failedButtons: this.deps.getResumeButtons(session.id, session),
    });
    this.deps.dispatchSessionNotification(session, {
      label: "failed",
      idempotencyKey: `terminal-failed:${session.id}:${buildTerminalCycleKey(session)}:${errorSummary}`,
      userMessage: payload.userMessage,
      wakeMessage: payload.wakeMessage,
      notifyUser: "always",
      buttons: payload.buttons,
    });
  }
}
