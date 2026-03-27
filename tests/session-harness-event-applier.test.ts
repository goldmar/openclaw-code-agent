import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionHarnessEventApplier } from "../src/session-harness-event-applier";
import type { PendingInputState } from "../src/types";

describe("SessionHarnessEventApplier", () => {
  it("dispatches canonical runtime events without Session-specific branching", () => {
    const events: string[] = [];
    let pendingInputState: PendingInputState | undefined;
    let currentPermissionMode = "default";

    const applier = new SessionHarnessEventApplier({
      clearStartupTimer: () => { events.push("clear-startup"); },
      assignBackendRef: (ref) => { events.push(`backend:${ref.conversationId}`); },
      noteRunStarted: (runId) => { events.push(`run:${runId}`); },
      transitionRunning: () => { events.push("running"); },
      noteTextDelta: (text) => { events.push(`text:${text}`); },
      noteToolCall: ({ name }) => { events.push(`tool:${name}`); },
      setPendingInputState: (state) => {
        pendingInputState = state;
        events.push(state ? `pending:${state.requestId}` : "pending:cleared");
      },
      notePendingInput: () => { events.push("pending-noted"); },
      clearResolvedPendingInput: (requestId, currentState) => (
        currentState?.requestId === requestId ? undefined : currentState
      ),
      notePlanArtifact: ({ artifact, finalized }) => { events.push(`plan:${artifact.markdown}:${finalized}`); },
      noteSettingsChanged: ({ permissionMode }) => permissionMode as "default" | "plan" | undefined,
      setCurrentPermissionMode: (mode) => {
        currentPermissionMode = mode;
        events.push(`mode:${mode}`);
      },
      handleRunCompleted: (data) => { events.push(`done:${data.session_id}`); },
    });

    applier.applyMessage({ type: "backend_ref", ref: { kind: "claude-code", conversationId: "thread-1" } }, {
      pendingPlanApproval: false,
      currentPermissionMode: "default",
      permissionMode: "default",
      planModeApproved: false,
      pendingInputState,
    });
    applier.applyMessage({ type: "run_started", runId: "run-1" }, {
      pendingPlanApproval: false,
      currentPermissionMode: currentPermissionMode as "default" | "plan",
      permissionMode: "default",
      planModeApproved: false,
      pendingInputState,
    });
    applier.applyMessage({ type: "pending_input", state: { requestId: "req-1", kind: "text", prompt: "Need answer" } as PendingInputState }, {
      pendingPlanApproval: false,
      currentPermissionMode: currentPermissionMode as "default" | "plan",
      permissionMode: "default",
      planModeApproved: false,
      pendingInputState,
    });
    applier.applyMessage({ type: "pending_input_resolved", requestId: "req-1" }, {
      pendingPlanApproval: false,
      currentPermissionMode: currentPermissionMode as "default" | "plan",
      permissionMode: "default",
      planModeApproved: false,
      pendingInputState,
    });
    applier.applyMessage({ type: "settings_changed", permissionMode: "plan" }, {
      pendingPlanApproval: false,
      currentPermissionMode: currentPermissionMode as "default" | "plan",
      permissionMode: "default",
      planModeApproved: false,
      pendingInputState,
    });
    applier.applyMessage({ type: "run_completed", data: { success: true, duration_ms: 1, total_cost_usd: 0, num_turns: 1, session_id: "thread-1" } }, {
      pendingPlanApproval: false,
      currentPermissionMode: currentPermissionMode as "default" | "plan",
      permissionMode: "default",
      planModeApproved: false,
      pendingInputState,
    });

    assert.deepEqual(events, [
      "clear-startup",
      "backend:thread-1",
      "running",
      "run:run-1",
      "pending:req-1",
      "pending-noted",
      "pending:cleared",
      "mode:plan",
      "done:thread-1",
    ]);
    assert.equal(currentPermissionMode, "plan");
    assert.equal(pendingInputState, undefined);
  });
});
