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
import type { Session } from "./session";
import type { PersistedSessionInfo, PlanApprovalMode } from "./types";
import type { NotificationButton } from "./session-interactions";
import type { SessionNotificationRequest } from "./wake-dispatcher";

type WorktreeStrategyResult = {
  notificationSent: boolean;
  worktreeRemoved: boolean;
};

type DispatchNotification = (session: Session, request: SessionNotificationRequest) => void;

function hasProvablePlanReviewPrompt(session: Pick<Session, "approvalPromptRequiredVersion" | "approvalPromptStatus">, planDecisionVersion?: number): boolean {
  return planDecisionVersion != null
    && session.approvalPromptRequiredVersion === planDecisionVersion
    && (session.approvalPromptStatus === "delivered" || session.approvalPromptStatus === "fallback_delivered");
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
      notifySession: (session: Session, text: string, label?: string) => void;
      clearRetryTimersForSession: (sessionId: string) => void;
      hasTurnCompleteWakeMarker: (sessionId: string) => boolean;
      shouldEmitTurnCompleteWake: (session: Session) => boolean;
      shouldEmitTerminalWake: (session: Session) => boolean;
      resolvePlanApprovalMode: (session: Session | PersistedSessionInfo) => PlanApprovalMode;
      getPlanApprovalButtons: (sessionId: string, session?: {
        worktreePrUrl?: string;
        isExplicitlyResumable?: boolean;
        planDecisionVersion?: number;
      }) => NotificationButton[][];
      getResumeButtons: (sessionId: string, session: {
        worktreePrUrl?: string;
        isExplicitlyResumable?: boolean;
        planDecisionVersion?: number;
      }) => NotificationButton[][];
      getQuestionButtons: (
        sessionId: string,
        options: Array<{ label: string }>,
      ) => NotificationButton[][] | undefined;
      extractLastOutputLine: (session: Session) => string | undefined;
      getOutputPreview: (session: Session, maxChars?: number) => string;
      originThreadLine: (session: Session) => string;
      debounceWaitingEvent: (sessionId: string) => boolean;
      isAlreadyMerged: (ref: string | undefined) => boolean;
    },
  ) {}

  private buildPlanApprovalWakeText(session: Session, planDecisionVersion?: number, explicitFallback: boolean = false): string {
    return [
      explicitFallback
        ? `Plan review fallback text delivered to the user because interactive buttons could not be delivered.`
        : `Plan approval buttons delivered to the user.`,
      `Session: ${session.name} | ID: ${session.id} | Plan v${planDecisionVersion ?? "?"}`,
      `Wait for their ${explicitFallback ? "explicit reply" : "button callback"} — do NOT approve or reject this plan yourself.`,
    ].join("\n");
  }

  private buildPlanApprovalDeliveryFailureWake(session: Session, planDecisionVersion?: number): string {
    return [
      `[PLAN APPROVAL DELIVERY FAILED] The plugin could not deliver the canonical plan review buttons or the explicit fallback text to the user.`,
      `Name: ${session.name} | ID: ${session.id} | Plan v${planDecisionVersion ?? "?"}`,
      this.deps.originThreadLine(session),
      ``,
      `No user-visible actionable review prompt is confirmed for this plan version.`,
      `Intervene manually before assuming the user saw the plan review request.`,
    ].join("\n");
  }

  private dispatchPlanApprovalFallback(session: Session, planDecisionVersion: number | undefined, summary: string): void {
    const now = new Date().toISOString();
    this.deps.dispatchSessionNotification(session, {
      label: "plan-approval-fallback",
      userMessage: buildPlanApprovalFallbackText({ session, summary }),
      notifyUser: "always",
      hooks: {
        onNotifyStarted: () => {
          this.deps.updatePersistedSession(session.id, {
            approvalPromptRequiredVersion: planDecisionVersion,
            approvalPromptVersion: planDecisionVersion,
            approvalPromptStatus: "sending",
            approvalPromptTransport: "direct-telegram",
            approvalPromptMessageKind: "explicit_fallback_text",
            approvalPromptLastAttemptAt: now,
          });
        },
        onNotifySucceeded: () => {
          this.deps.updatePersistedSession(session.id, {
            approvalPromptRequiredVersion: planDecisionVersion,
            approvalPromptVersion: planDecisionVersion,
            approvalPromptStatus: "fallback_delivered",
            approvalPromptTransport: "direct-telegram",
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
            approvalPromptTransport: "direct-telegram",
            approvalPromptMessageKind: "explicit_fallback_text",
            approvalPromptLastAttemptAt: now,
            approvalPromptFailedAt: new Date().toISOString(),
          });
        },
      },
      wakeMessageOnNotifySuccess: this.buildPlanApprovalWakeText(session, planDecisionVersion, true),
      wakeMessageOnNotifyFailed: this.buildPlanApprovalDeliveryFailureWake(session, planDecisionVersion),
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

  handleTurnEnd(session: Session, hadQuestion: boolean): void {
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
      this.emitWaitingForInput(session);
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

    if (session.killReason === "done") {
      if (worktreeResult.notificationSent) return;
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

  emitWaitingForInput(session: Session): void {
    if (!this.deps.debounceWaitingEvent(session.id)) return;

    const planApprovalMode = session.pendingPlanApproval
      ? this.deps.resolvePlanApprovalMode(session)
      : undefined;
    const planDecisionVersion = session.actionablePlanDecisionVersion ?? session.planDecisionVersion;
    const promptAlreadyProven =
      session.pendingPlanApproval
      && planApprovalMode === "ask"
      && hasProvablePlanReviewPrompt(session, planDecisionVersion);
    const preview =
      (!session.pendingPlanApproval && session.pendingInputState?.promptText)
        ? session.pendingInputState.promptText
        : this.deps.getOutputPreview(
            session,
            session.pendingPlanApproval && planApprovalMode !== "delegate"
              ? Number.POSITIVE_INFINITY
              : undefined,
          );
    const waitingButtons =
      session.pendingPlanApproval && planApprovalMode === "ask" && !promptAlreadyProven
        ? this.deps.getPlanApprovalButtons(session.id, {
          ...session,
          planDecisionVersion,
        })
        : (!session.pendingPlanApproval && session.pendingInputState?.options.length)
          ? this.deps.getQuestionButtons(
              session.id,
              session.pendingInputState.options.map((label) => ({ label })),
            )
        : undefined;
    const matchingPlanArtifact = session.latestPlanArtifactVersion === planDecisionVersion
      ? session.latestPlanArtifact
      : undefined;
    const payload = buildWaitingForInputPayload({
      session,
      preview,
      planArtifact: matchingPlanArtifact,
      originThreadLine: this.deps.originThreadLine(session),
      planApprovalMode,
      planApprovalButtons: waitingButtons,
      questionButtons: !session.pendingPlanApproval ? waitingButtons : undefined,
    });
    const planReviewSummary = payload.planReviewSummary ?? preview;

    if (payload.label === "plan-approval" && planApprovalMode === "ask") {
      this.deps.dispatchSessionNotification(session, {
        label: payload.label,
        userMessage: payload.userMessage,
        notifyUser: "always",
        buttons: payload.buttons,
        hooks: {
          onNotifyStarted: () => {
            this.deps.updatePersistedSession(session.id, {
              approvalPromptRequiredVersion: planDecisionVersion,
              approvalPromptVersion: planDecisionVersion,
              approvalPromptStatus: "sending",
              approvalPromptTransport: "direct-telegram",
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
              approvalPromptTransport: "direct-telegram",
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
              approvalPromptTransport: "direct-telegram",
              approvalPromptMessageKind: "canonical_buttons",
              approvalPromptFailedAt: new Date().toISOString(),
            });
          },
        },
        onUserNotifyFailed: () => this.dispatchPlanApprovalFallback(session, planDecisionVersion, planReviewSummary),
        wakeMessageOnNotifySuccess: this.buildPlanApprovalWakeText(session, planDecisionVersion),
      });
      return;
    }

    if (payload.label === "plan-approval") {
      this.deps.dispatchSessionNotification(session, {
        label: payload.label,
        userMessage: payload.userMessage,
        wakeMessage: payload.wakeMessage,
        notifyUser: "never",
        buttons: payload.buttons,
      });
      return;
    }

    this.deps.dispatchSessionNotification(session, {
      label: payload.label,
      userMessage: payload.userMessage,
      notifyUser: "always",
      buttons: payload.buttons,
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
      userMessage: payload.userMessage,
      wakeMessage: payload.wakeMessage,
      notifyUser: "always",
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
    const payload = buildCompletedPayload({
      session,
      originThreadLine: this.deps.originThreadLine(session),
      preview,
    });
    let canonicalStatusDelivered: boolean | undefined;
    this.deps.dispatchSessionNotification(session, {
      label: "completed",
      userMessage: payload.userMessage,
      notifyUser: "always",
      wakeMessageOnNotifySuccess: payload.wakeMessageOnNotifySuccess,
      wakeMessageOnNotifyFailed: payload.wakeMessageOnNotifyFailed,
      hooks: {
        onNotifySucceeded: () => {
          canonicalStatusDelivered = true;
          this.logCompletionWakeDiagnostic({
            session,
            event: "completion_notify_succeeded",
            canonicalStatusDelivered,
            followupSummaryRequired: payload.followupContract.requiresShortFactualSummary,
          });
        },
        onNotifyFailed: () => {
          canonicalStatusDelivered = false;
          this.logCompletionWakeDiagnostic({
            session,
            event: "completion_notify_failed",
            canonicalStatusDelivered,
            followupSummaryRequired: payload.followupContract.requiresShortFactualSummary,
          });
        },
        onWakeSucceeded: () => {
          this.logCompletionWakeDiagnostic({
            session,
            event: "completion_wake_succeeded",
            canonicalStatusDelivered,
            followupSummaryRequired: payload.followupContract.requiresShortFactualSummary,
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
      userMessage: payload.userMessage,
      wakeMessage: payload.wakeMessage,
      notifyUser: "always",
      buttons: payload.buttons,
    });
  }
}
