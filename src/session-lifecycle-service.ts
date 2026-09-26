import { fenceAgentOutput } from "./untrusted-output";
import { removeWorktree, deleteBranch, getCommitsAheadCount } from "./worktree";
import { formatDuration, truncateText } from "./format";
import { getPersistedMutationRefs } from "./session-backend-ref";
import {
  buildCompletedPayload,
  buildFailedPayload,
  buildPlanApprovalFallbackMessages,
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
import { createLogger } from "./logger";

const log = createLogger("session-lifecycle-service");

type WorktreeStrategyResult = {
  notificationSent: boolean;
  worktreeRemoved: boolean;
};

type DispatchNotification = (session: Session, request: SessionNotificationRequest) => void;
const OPTION_DESCRIPTION_MAX_CHARS = 280;

export function resolvePlanArtifactForPrompt(
  session: {
    latestPlanArtifactVersion?: number;
    latestPlanArtifact?: PlanArtifact;
    planFilePath?: string;
  },
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

export function buildActiveQuestionPrompt(args: {
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
  // Every option is numbered, so it can be answered by number, including a
  // multi-select question, which has no buttons.
  const descriptions = new Map(args.optionDescriptions.map((option) => [option.label, option.description]));
  if (args.question.options.length > 0) {
    lines.push(
      "",
      ...args.question.options.map((option, index) => {
        const description = descriptions.get(option.label);
        return `${index + 1}. ${option.label}${description ? ` - ${description}` : ""}`;
      }),
    );
    if (args.question.multiSelect) lines.push("", "Several answers allowed: reply with them, for example 1,3.");
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
      resolveWorktreeRepoDir: (repoDir: string | undefined, worktreePath?: string) => string | undefined | Promise<string | undefined>;
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

  /**
   * `manual` sessions keep their worktree for the user to merge. Record a current
   * `provisioned` lifecycle (with a real timestamp) so status views report the
   * kept worktree instead of synthesizing one from missing fields.
   */
  private recordManualWorktreeKept(session: Session): void {
    if (session.worktreeState !== "none" && session.worktreeState !== "provisioned") return;
    const now = new Date().toISOString();
    for (const mutationRef of getPersistedMutationRefs(session)) {
      this.deps.updatePersistedSession(mutationRef, {
        worktreeState: "provisioned",
        worktreeLifecycle: {
          state: "provisioned",
          updatedAt: now,
          ...(session.worktreeBaseBranch ? { baseBranch: session.worktreeBaseBranch } : {}),
          notes: ["manual strategy: worktree kept for manual follow-up"],
        },
      });
    }
  }

  private dispatchPlanApprovalFallback(session: Session, planDecisionVersion: number | undefined, summary: string): void {
    const now = new Date().toISOString();
    this.deps.dispatchSessionNotification(session, {
      label: "plan-approval-fallback",
      idempotencyKey: `plan-approval:${session.id}:v${planDecisionVersion ?? "unknown"}:fallback`,
      userMessages: buildPlanApprovalFallbackMessages({ session, summary }),
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
      wakeDelivery: "next-turn",
      wakeMessageOnNotifyFailed: buildPlanApprovalDeliveryFailureWake({
        session,
        planDecisionVersion,
        originThreadLine: this.deps.originThreadLine(session),
      }),
      failureWakeConfirmsNotificationDelivery: false,
    });
  }

  private logCompletionWakeDiagnostic(args: {
    session: Pick<Session, "id" | "name">;
    event: string;
    canonicalStatusDelivered?: boolean;
    followupSummaryRequired: boolean;
  }): void {
    log.info(JSON.stringify({
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
      log.info(
        `[SessionManager] Suppressing turn-end wake for session ${session.id} ` +
        `(status=${session.status}) — terminal notification owns the completion path.`,
      );
      return;
    }

    if (session.goalTaskId) {
      // Goal loops own their turn handling, except the plan gate of the first
      // iteration: its plan is decided like any other plan.
      if (session.pendingPlanApproval) await this.emitWaitingForInput(session);
      return;
    }

    if (hadQuestion || session.pendingPlanApproval) {
      await this.emitWaitingForInput(session);
      return;
    }

    if (session.worktreeStrategy === "ask" || session.worktreeStrategy === "delegate") {
      log.info(
        `[SessionManager] Suppressing turn-complete wake for session ${session.id} ` +
        `(worktreeStrategy=${session.worktreeStrategy}) — worktree notification will follow.`,
      );
      return;
    }

    if (!this.deps.shouldEmitTurnCompleteWake(session)) return;
    this.emitTurnComplete(session);
  }

  /** True unless the branch is proven to have no commits beyond its parent branch. */
  private async branchHasOwnCommits(repoDir: string, branchName: string, session: Session): Promise<boolean> {
    const parent = session.worktreeParentBranch ?? session.worktreeBaseBranch;
    if (!parent) return true;
    try {
      const ahead = await getCommitsAheadCount(repoDir, branchName, parent);
      return ahead === undefined || ahead > 0;
    } catch {
      return true;
    }
  }

  async handleSessionTerminal(session: Session): Promise<void> {
    this.deps.persistSession(session);
    this.deps.clearWaitingTimestamp(session.id);
    if (session.goalTaskId && !session.pendingPlanApproval) {
      this.deps.clearRetryTimersForSession(session.id);
      return;
    }

    // pendingPlanApproval is the deterministic gate. Lifecycle can lag behind
    // approval/rejection during persistence recovery and must not suppress a
    // real terminal worktree outcome after the decision has been resolved.
    if (session.pendingPlanApproval) {
      if (session.killReason === "idle-timeout" && session.pendingPlanApproval) {
        this.emitIdleTimeoutPlanApproval(session);
      } else {
        await this.emitWaitingForInput(session);
      }
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
      session.duration < 30_000 &&
      // Only a worktree this launch created: a resumed session's worktree and
      // branch hold earlier work (for example after a usage-limit or auth
      // failure on resume) and are never auto-cleaned.
      session.launchedFresh !== false
    ) {
      const repoDir = await this.deps.resolveWorktreeRepoDir(session.originalWorkdir, session.worktreePath);
      const branchName = session.worktreeBranch;
      log.info(
        `[SessionManager] Early startup failure for "${session.name}" — auto-cleaning worktree ` +
        `(cost=$${session.costUsd.toFixed(2)}, duration=${session.duration}ms)`,
      );

      let removedWorktree = false;
      if (repoDir) {
        removedWorktree = await removeWorktree(repoDir, session.worktreePath);
      }

      // Belt and braces: a branch with commits of its own is kept even then.
      if (repoDir && branchName && removedWorktree && !(await this.branchHasOwnCommits(repoDir, branchName, session))) {
        await deleteBranch(repoDir, branchName);
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

    // Every strategy except `off` keeps its worktree until an explicit resolution;
    // `manual` in particular exists so the user can merge the branch by hand.
    const keepsWorktree = Boolean(session.worktreeStrategy && session.worktreeStrategy !== "off");
    if (!worktreeAutoCleaned && session.worktreePath && session.originalWorkdir) {
      if (worktreeResult.worktreeRemoved) {
        log.info(
          `[SessionManager] Worktree already removed for "${session.name}" during strategy handling.`,
        );
      } else if (keepsWorktree) {
        log.info(
          `[SessionManager] Keeping worktree alive for "${session.name}" (strategy=${session.worktreeStrategy}) — will be cleaned up on explicit resolution.`,
        );
        if (session.worktreeStrategy === "manual") this.recordManualWorktreeKept(session);
      } else {
        const repoDir = await this.deps.resolveWorktreeRepoDir(session.originalWorkdir, session.worktreePath);
        if (repoDir) await removeWorktree(repoDir, session.worktreePath);
      }
    }

    if (worktreeResult.notificationSent) {
      log.info(
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
      if (session.pendingPlanApproval) {
        this.emitIdleTimeoutPlanApproval(session);
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

  private emitIdleTimeoutPlanApproval(session: Session): void {
    const planApprovalMode = this.deps.resolvePlanApprovalMode(session);
    const actionableVersion = session.actionablePlanDecisionVersion ?? session.planDecisionVersion;
    const promptAlreadyProven = hasProvablePlanReviewPrompt(session, actionableVersion);
    if (planApprovalMode === "delegate") {
      this.deps.dispatchSessionNotification(session, {
        label: "plan-approval-timeout",
        idempotencyKey: `plan-approval-timeout:${session.id}:v${actionableVersion ?? "unknown"}:delegate`,
        wakeMessage: [
          `[${session.name}] Reminder: plan v${actionableVersion ?? "?"} still waits for your review (the session was suspended while idle; approving resumes it). ID: ${session.id}`,
          ...(this.deps.originThreadLine(session) ? [this.deps.originThreadLine(session)] : []),
          `Approve with agent_respond(session='${session.id}', message='Approved. Go ahead.', approve=true, approval_rationale='<one line>') when it is in scope and low risk; otherwise agent_escalate(session='${session.id}', kind='plan', summary='<why>').`,
        ].join("\n"),
        notifyUser: "never",
      });
      return;
    }
    if (planApprovalMode === "ask" && promptAlreadyProven) {
      // The user already has an actionable prompt for this version and the
      // orchestrator has nothing to do: no wake (N37).
      return;
    }
    this.deps.dispatchSessionNotification(session, {
      label: "plan-approval-timeout",
      idempotencyKey: `plan-approval-timeout:${session.id}:v${actionableVersion ?? "unknown"}:user-prompt`,
      userMessage: [
        `📋 [${session.name}] Plan v${actionableVersion ?? "?"} still waiting for approval; the session is paused | $${(session.costUsd ?? 0).toFixed(2)} | ${formatDuration(session.duration)}`,
        `Approve resumes it and starts the work. Revise resumes it to update the plan. Reject keeps it stopped.`,
      ].join("\n"),
      notifyUser: "always",
      buttons: planApprovalMode === "ask" && !promptAlreadyProven
        ? this.deps.getPlanApprovalButtons(session.id, {
          ...session,
          planDecisionVersion: actionableVersion,
        })
        : undefined,
    });
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
    // Each plan version is its own decision: a quick revision must not be
    // swallowed as a repeat of the previous version's prompt.
    const waitingDebounceKey = session.pendingPlanApproval
      ? `plan-approval:v${session.actionablePlanDecisionVersion ?? session.planDecisionVersion ?? "unknown"}`
      : pendingInputNotificationKey
        ? `pending-input:${pendingInputNotificationKey}`
        : undefined;

    if (!this.deps.debounceWaitingEvent(session.id, waitingDebounceKey)) return;

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
        // The user already has the prompt; the orchestrator needs this only when they answer.
        wakeDelivery: "next-turn",
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
        wakeDelivery: "next-turn",
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
      // Context for the orchestrator's next turn, in case the user answers in chat (N37).
      wakeMessageOnNotifySuccess: buildQuestionShownWakeText(session, payload.userMessage),
      wakeDelivery: "next-turn",
      wakeMessageOnNotifyFailed: payload.wakeMessage,
    });
  }

  emitTurnComplete(session: Session): void {
    log.info(
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
      notifyUser: "always",
      onUserNotifyFailed: () => {
        log.warn(
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

/** Next-turn context after a question reached the user. */
function buildQuestionShownWakeText(session: Pick<Session, "id" | "name">, question: string | undefined): string {
  return [
    `[${session.name}] The user was shown the agent's question below; do not answer it yourself. If they answer in chat, forward it: agent_respond(session='${session.id}', message='<answer>', userInitiated=true).`,
    fenceAgentOutput(question ?? "", "question"),
  ].join("\n");
}
