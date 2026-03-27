import type { HarnessMessage, HarnessResult } from "./harness";
import type {
  PendingInputState,
  PermissionMode,
  SessionBackendRef,
} from "./types";

type ApplyState = {
  pendingPlanApproval: boolean;
  currentPermissionMode: PermissionMode;
  permissionMode: PermissionMode;
  planModeApproved: boolean;
  pendingInputState?: PendingInputState;
};

type SessionHarnessEventApplierDeps = {
  clearStartupTimer: () => void;
  assignBackendRef: (ref: SessionBackendRef) => void;
  noteRunStarted: (runId: string) => void;
  transitionRunning: () => void;
  noteTextDelta: (text: string, pendingPlanApproval: boolean) => void;
  noteToolCall: (args: {
    name: string;
    input: unknown;
    currentPermissionMode: PermissionMode;
    permissionMode: PermissionMode;
    planModeApproved: boolean;
  }) => void;
  setPendingInputState: (state: PendingInputState | undefined) => void;
  notePendingInput: () => void;
  clearResolvedPendingInput: (
    requestId: string | undefined,
    currentState?: PendingInputState,
  ) => PendingInputState | undefined;
  notePlanArtifact: (artifact: HarnessMessage & { type: "plan_artifact" }) => void;
  noteSettingsChanged: (args: {
    oldMode: PermissionMode;
    permissionMode?: string;
    planModeApproved: boolean;
  }) => PermissionMode | undefined;
  setCurrentPermissionMode: (mode: PermissionMode) => void;
  handleRunCompleted: (data: HarnessResult) => void;
};

/**
 * Canonical harness-event dispatcher for Session runtime.
 * Keeps per-message branching out of Session itself.
 */
export class SessionHarnessEventApplier {
  constructor(private readonly deps: SessionHarnessEventApplierDeps) {}

  applyMessage(msg: HarnessMessage, state: ApplyState): void {
    if (msg.type === "backend_ref") {
      this.deps.clearStartupTimer();
      this.deps.assignBackendRef({ ...msg.ref });
      this.deps.transitionRunning();
      return;
    }

    if (msg.type === "run_started") {
      if (msg.runId) this.deps.noteRunStarted(msg.runId);
      return;
    }

    if (msg.type === "text_delta") {
      this.deps.noteTextDelta(msg.text, state.pendingPlanApproval);
      return;
    }

    if (msg.type === "tool_call") {
      this.deps.noteToolCall({
        name: msg.name,
        input: msg.input,
        currentPermissionMode: state.currentPermissionMode,
        permissionMode: state.permissionMode,
        planModeApproved: state.planModeApproved,
      });
      return;
    }

    if (msg.type === "pending_input") {
      this.deps.setPendingInputState(msg.state);
      this.deps.notePendingInput();
      return;
    }

    if (msg.type === "pending_input_resolved") {
      this.deps.setPendingInputState(
        this.deps.clearResolvedPendingInput(msg.requestId, state.pendingInputState),
      );
      return;
    }

    if (msg.type === "plan_artifact") {
      this.deps.notePlanArtifact(msg);
      return;
    }

    if (msg.type === "settings_changed") {
      const nextMode = this.deps.noteSettingsChanged({
        oldMode: state.currentPermissionMode,
        permissionMode: msg.permissionMode,
        planModeApproved: state.planModeApproved,
      });
      if (nextMode) {
        this.deps.setCurrentPermissionMode(nextMode);
      }
      return;
    }

    if (msg.type === "run_completed") {
      this.deps.handleRunCompleted(msg.data);
      return;
    }

    if (msg.type === "activity") {
      return;
    }
  }
}
