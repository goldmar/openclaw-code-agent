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

  noteToolCall(args: {
    name: string;
    input: unknown;
    currentPermissionMode: PermissionMode;
    permissionMode: PermissionMode;
    planModeApproved: boolean;
  }): void {
    const { name, input, currentPermissionMode, permissionMode, planModeApproved } = args;
    if (name === "Write") {
      const writeInput = input as Record<string, unknown>;
      if (typeof writeInput?.file_path === "string" && writeInput.file_path.includes("/.claude/plans/")) {
        this.deps.setPlanFilePath(writeInput.file_path);
      }
    }

    if (name === "AskUserQuestion") {
      this.lastTurnHadQuestion = true;
      this.deps.applyInputRequested();
      if ((currentPermissionMode === "plan" || permissionMode === "plan") && !planModeApproved) {
        this.deps.markPendingPlanApproval("plan-mode");
      }
    } else if ((name === "ExitPlanMode" || name === "set_permission_mode") && !planModeApproved) {
      this.lastTurnHadQuestion = true;
      this.deps.markPendingPlanApproval("plan-mode");
    }

    this.deps.emitToolUse(name, input);
  }

  notePendingInput(): void {
    this.lastTurnHadQuestion = true;
    this.deps.applyInputRequested();
    if (!this.waitingForInputFired) {
      this.waitingForInputFired = true;
      this.deps.emitTurnEnd(true);
    }
  }

  clearResolvedPendingInput(requestId: string | undefined, currentState?: PendingInputState): PendingInputState | undefined {
    if (!requestId || currentState?.requestId === requestId) {
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
