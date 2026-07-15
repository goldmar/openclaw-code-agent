import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionTurnRuntime } from "../src/session-turn-runtime";

describe("SessionTurnRuntime", () => {
  it("emits one waiting turn-end when pending input arrives", () => {
    const events: string[] = [];
    const runtime = new SessionTurnRuntime({
      appendOutput: () => {},
      emitOutput: () => {},
      emitToolUse: () => {},
      emitTurnEnd: (hadQuestion) => { events.push(hadQuestion ? "question" : "done"); },
      markPendingPlanApproval: () => {},
      markAwaitingUserInput: () => {},
      applyInputRequested: () => {},
      completeTurn: () => {},
      setPlanFilePath: () => {},
      setLatestPlanArtifact: () => {},
    });

    runtime.notePendingInput();
    runtime.notePendingInput();

    assert.deepEqual(events, ["question"]);
  });

  it("emits a fresh waiting turn-end for each distinct question in one request", () => {
    const events: string[] = [];
    const runtime = new SessionTurnRuntime({
      appendOutput: () => {}, emitOutput: () => {}, emitToolUse: () => {},
      emitTurnEnd: () => { events.push("question"); }, markPendingPlanApproval: () => {},
      markAwaitingUserInput: () => {}, applyInputRequested: () => {}, completeTurn: () => {},
      setPlanFilePath: () => {}, setLatestPlanArtifact: () => {},
    });
    const questions = [
      { id: "fast_path_scope", question: "Fast path?", options: [] },
      { id: "think_default", question: "Think default?", options: [] },
    ];

    runtime.notePendingInput({ requestId: "req-1", kind: "question", promptText: "Fast path?", options: [], questions, activeQuestionIndex: 0 });
    runtime.notePendingInput({ requestId: "req-1", kind: "question", promptText: "Fast path?", options: [], questions, activeQuestionIndex: 0 });
    runtime.notePendingInput({ requestId: "req-1", kind: "question", promptText: "Think default?", options: [], questions, activeQuestionIndex: 1 });

    assert.deepEqual(events, ["question", "question"]);
  });

  it("marks pending plan approval when a plan-mode tool call requests it", () => {
    const planRequests: string[] = [];
    const toolCalls: string[] = [];
    const runtime = new SessionTurnRuntime({
      appendOutput: () => {},
      emitOutput: () => {},
      emitToolUse: (name) => { toolCalls.push(name); },
      emitTurnEnd: () => {},
      markPendingPlanApproval: (context) => { planRequests.push(context); },
      markAwaitingUserInput: () => {},
      applyInputRequested: () => {},
      completeTurn: () => {},
      setPlanFilePath: () => {},
      setLatestPlanArtifact: () => {},
    });

    runtime.noteToolCall({
      name: "ExitPlanMode",
      input: {},
      currentPermissionMode: "plan",
      permissionMode: "plan",
      planModeApproved: false,
    });

    assert.deepEqual(planRequests, ["plan-mode"]);
    assert.deepEqual(toolCalls, ["ExitPlanMode"]);
  });

  it("completes a successful turn when no input is needed and no messages remain queued", () => {
    const events: string[] = [];
    const runtime = new SessionTurnRuntime({
      appendOutput: () => {},
      emitOutput: () => {},
      emitToolUse: () => {},
      emitTurnEnd: (hadQuestion) => { events.push(hadQuestion ? "question" : "done"); },
      markPendingPlanApproval: () => {},
      markAwaitingUserInput: () => {},
      applyInputRequested: () => {},
      completeTurn: () => { events.push("complete"); },
      setPlanFilePath: () => {},
      setLatestPlanArtifact: () => {},
    });

    runtime.finishSuccessfulTurn({
      currentPermissionMode: "default",
      permissionMode: "default",
      pendingPlanApproval: false,
      planModeApproved: false,
      pendingInputState: undefined,
      hasPendingMessages: false,
    });

    assert.deepEqual(events, ["complete", "done"]);
  });

  it("queues worktree finalization instead of completing a dirty worktree turn", () => {
    const events: string[] = [];
    const runtime = new SessionTurnRuntime({
      appendOutput: () => {},
      emitOutput: () => {},
      emitToolUse: () => {},
      emitTurnEnd: (hadQuestion) => { events.push(hadQuestion ? "question" : "done"); },
      markPendingPlanApproval: () => {},
      markAwaitingUserInput: () => {},
      applyInputRequested: () => {},
      completeTurn: () => { events.push("complete"); },
      queueWorktreeFinalizationPrompt: () => {
        events.push("queue-worktree-finalization");
        return true;
      },
      setPlanFilePath: () => {},
      setLatestPlanArtifact: () => {},
    });

    runtime.finishSuccessfulTurn({
      currentPermissionMode: "default",
      permissionMode: "default",
      pendingPlanApproval: false,
      planModeApproved: false,
      pendingInputState: undefined,
      hasPendingMessages: false,
    });

    assert.deepEqual(events, ["queue-worktree-finalization"]);
  });
});
