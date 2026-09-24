import type {
  PendingInputState,
  PermissionMode,
  PlanApprovalContext,
  PlanArtifact,
} from "./types";

type TurnRuntimeDeps = {
  appendOutput: (text: string) => void;
  emitOutput: (text: string) => void;
  emitToolUse: (name: string, input: unknown) => void;
  emitTurnEnd: (hadQuestion: boolean) => void;
  markPendingPlanApproval: (context: PlanApprovalContext) => void;
  markAwaitingUserInput: () => void;
  applyInputRequested: () => void;
  completeTurn: () => void;
  queueWorktreeFinalizationPrompt?: () => boolean;
  setPlanFilePath: (path: string) => void;
  setLatestPlanArtifact: (artifact: PlanArtifact) => void;
};

/**
 * Owns per-turn runtime bookkeeping so Session can focus on lifecycle/state.
 */
export class SessionTurnRuntime {
  waitingForInputFired = false;
  lastTurnHadQuestion = false;
  turnInProgress = true;
  currentTurnText = "";
  currentTurnPlanArtifact?: PlanArtifact;
  private pendingInputNotificationIdentity?: string;

  constructor(private readonly deps: TurnRuntimeDeps) {}

  beginUserTurn(): void {
    this.waitingForInputFired = false;
    this.turnInProgress = true;
    this.currentTurnText = "";
    this.currentTurnPlanArtifact = undefined;
    this.lastTurnHadQuestion = false;
  }

  noteTextDelta(text: string, pendingPlanApproval: boolean): void {
    this.waitingForInputFired = false;
    if (!pendingPlanApproval) {
      this.lastTurnHadQuestion = false;
    }
    this.deps.appendOutput(text);
    this.currentTurnText += this.currentTurnText ? `\n${text}` : text;
    this.deps.emitOutput(text);
  }

  noteToolCall(args: { name: string; input: unknown }): void {
    this.deps.emitToolUse(args.name, args.input);
  }

  /**
   * A backend raised a native plan-approval request mid-turn (Claude
   * ExitPlanMode held in canUseTool). The turn stays open until the decision
   * resolves, so the waiting notification fires now rather than at turn end.
   */
  notePlanApprovalRequest(args: {
    artifact: PlanArtifact;
    planFilePath?: string;
    planModeApproved: boolean;
  }): void {
    if (args.planFilePath) this.deps.setPlanFilePath(args.planFilePath);
    this.notePlanArtifact(args.artifact, true);
    if (args.planModeApproved) return;
    this.lastTurnHadQuestion = true;
    this.deps.markPendingPlanApproval("plan-mode");
    if (!this.waitingForInputFired) {
      this.waitingForInputFired = true;
      this.deps.emitTurnEnd(true);
    }
  }

  notePendingInput(state?: PendingInputState): void {
    this.lastTurnHadQuestion = true;
    this.deps.applyInputRequested();
    const activeQuestionIndex = state?.activeQuestionIndex ?? 0;
    const activeQuestion = state?.questions?.[activeQuestionIndex];
    const identity = state?.requestId
      ? `${state.requestId}:${activeQuestion?.id ?? (state.activeQuestionIndex != null ? `q${state.activeQuestionIndex}` : "request")}`
      : undefined;
    if (!this.waitingForInputFired || (identity && identity !== this.pendingInputNotificationIdentity)) {
      this.waitingForInputFired = true;
      this.pendingInputNotificationIdentity = identity;
      this.deps.emitTurnEnd(true);
    }
  }

  clearResolvedPendingInput(requestId: string | undefined, currentState?: PendingInputState): PendingInputState | undefined {
    if (!requestId || currentState?.requestId === requestId) {
      this.pendingInputNotificationIdentity = undefined;
      return undefined;
    }
    return currentState;
  }

  notePlanArtifact(artifact: PlanArtifact, finalized: boolean): void {
    this.currentTurnPlanArtifact = artifact;
    this.deps.setLatestPlanArtifact(artifact);
    if (!finalized) return;
    const markdown = artifact.markdown.trim();
    if (!markdown || this.currentTurnText.trim() === markdown) return;
    this.deps.appendOutput(markdown);
    this.currentTurnText = markdown;
    this.deps.emitOutput(markdown);
  }

  noteSettingsChanged(args: {
    oldMode: PermissionMode;
    permissionMode?: string;
    planModeApproved: boolean;
  }): PermissionMode | undefined {
    const { oldMode, permissionMode, planModeApproved } = args;
    if (!permissionMode) return undefined;
    if (permissionMode !== "plan" && oldMode === "plan" && !planModeApproved) {
      this.deps.markPendingPlanApproval("plan-mode");
      this.lastTurnHadQuestion = true;
    }
    return permissionMode as PermissionMode;
  }

  finishSuccessfulTurn(args: {
    currentPermissionMode: PermissionMode;
    permissionMode: PermissionMode;
    pendingPlanApproval: boolean;
    planModeApproved: boolean;
    pendingInputState?: PendingInputState;
    hasPendingMessages: boolean;
  }): void {
    const {
      currentPermissionMode,
      permissionMode,
      pendingPlanApproval,
      planModeApproved,
      pendingInputState,
      hasPendingMessages,
    } = args;

    let pendingPlanApprovalNow = pendingPlanApproval;
    if ((currentPermissionMode === "plan" || permissionMode === "plan") && !pendingPlanApprovalNow && !planModeApproved) {
      this.deps.markPendingPlanApproval("plan-mode");
      pendingPlanApprovalNow = true;
    }

    const needsInput = pendingPlanApprovalNow || this.lastTurnHadQuestion || !!pendingInputState;
    this.turnInProgress = hasPendingMessages;
    if (needsInput && !this.waitingForInputFired) {
      this.waitingForInputFired = true;
      if (!pendingPlanApprovalNow) {
        this.deps.markAwaitingUserInput();
      }
      this.deps.emitTurnEnd(true);
    } else if (!hasPendingMessages && !needsInput) {
      if (this.deps.queueWorktreeFinalizationPrompt?.()) {
        this.turnInProgress = true;
        return;
      }
      this.deps.completeTurn();
      this.deps.emitTurnEnd(false);
    }
  }

  finishTerminalTurn(): void {
    this.turnInProgress = false;
  }

  finishInterruptedTurn(hasPendingMessages: boolean): void {
    this.turnInProgress = hasPendingMessages;
    this.waitingForInputFired = false;
    this.lastTurnHadQuestion = false;
    this.currentTurnText = "";
    this.currentTurnPlanArtifact = undefined;
  }

  resetAfterRun(): void {
    this.lastTurnHadQuestion = false;
    this.currentTurnText = "";
    this.currentTurnPlanArtifact = undefined;
  }
}
