import { removeWorktree, deleteBranch } from "./worktree";
import { formatDuration, truncateText } from "./format";
import {
  buildCompletedPayload,
  buildFailedPayload,
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
      isAlreadyMerged: (harnessSessionId: string | undefined) => boolean;
    },
  ) {}

  handleTurnEnd(session: Session, hadQuestion: boolean): void {
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
      console.info(
        `[SessionManager] Early startup failure for "${session.name}" — auto-cleaning worktree ` +
        `(cost=$${session.costUsd.toFixed(2)}, duration=${session.duration}ms)`,
      );

      if (repoDir) {
        removeWorktree(repoDir, session.worktreePath);
      }

      if (repoDir && branchName) {
        deleteBranch(repoDir, branchName);
      }

      if (session.harnessSessionId) {
        this.deps.updatePersistedSession(session.harnessSessionId, {
          worktreePath: undefined,
          worktreeBranch: undefined,
        });
      }

      worktreeAutoCleaned = true;
    }

    const nonTrivialWorktreeStrategy = session.worktreeStrategy &&
      session.worktreeStrategy !== "off" && session.worktreeStrategy !== "manual";
    if (!worktreeAutoCleaned && session.worktreePath && session.originalWorkdir) {
      const repoDir = this.deps.resolveWorktreeRepoDir(session.originalWorkdir, session.worktreePath);
      if (worktreeResult.worktreeRemoved) {
        console.info(
          `[SessionManager] Worktree already removed for "${session.name}" during strategy handling.`,
        );
      } else if (nonTrivialWorktreeStrategy) {
        console.info(
          `[SessionManager] Keeping worktree alive for "${session.name}" (strategy=${session.worktreeStrategy}) — will be cleaned up on explicit resolution.`,
        );
      } else if (repoDir) {
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

    const preview =
      (!session.pendingPlanApproval && session.pendingInputState?.promptText)
        ? session.pendingInputState.promptText
        : this.deps.getOutputPreview(session);
    const planApprovalMode = session.pendingPlanApproval
      ? this.deps.resolvePlanApprovalMode(session)
      : undefined;
    const waitingButtons =
      session.pendingPlanApproval && planApprovalMode === "ask"
        ? this.deps.getPlanApprovalButtons(session.id, session)
        : (!session.pendingPlanApproval && session.pendingInputState?.options.length)
          ? this.deps.getQuestionButtons(
              session.id,
              session.pendingInputState.options.map((label) => ({ label })),
            )
        : undefined;
    const payload = buildWaitingForInputPayload({
      session,
      preview,
      originThreadLine: this.deps.originThreadLine(session),
      planApprovalMode,
      planApprovalButtons: waitingButtons,
      questionButtons: !session.pendingPlanApproval ? waitingButtons : undefined,
    });

    if (payload.label === "plan-approval" && planApprovalMode === "ask") {
      this.deps.dispatchSessionNotification(session, {
        label: payload.label,
        userMessage: payload.userMessage,
        notifyUser: "always",
        buttons: payload.buttons,
        wakeMessageOnNotifySuccess:
          `Plan approval buttons delivered to user. Wait for their button callback — do NOT approve or reject this plan yourself.`,
        wakeMessageOnNotifyFailed: payload.wakeMessage,
      });
      return;
    }

    this.deps.dispatchSessionNotification(session, {
      label: payload.label,
      userMessage: payload.userMessage,
      wakeMessage: payload.wakeMessage,
      notifyUser: "always",
      buttons: payload.buttons,
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
    const payload = buildCompletedPayload({
      session,
      originThreadLine: this.deps.originThreadLine(session),
      preview: this.deps.getOutputPreview(session),
    });
    this.deps.dispatchSessionNotification(session, {
      label: "completed",
      userMessage: payload.userMessage,
      wakeMessage: payload.wakeMessage,
      notifyUser: "always",
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
