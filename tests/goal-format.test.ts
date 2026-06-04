import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildGoalIterationSummary, buildGoalTaskRuntimeSnapshot, formatGoalTask } from "../src/goal-format";
import type { GoalTaskState } from "../src/types";

describe("goal-format", () => {
  it("captures runtime state and formats goal task output", () => {
    const task: GoalTaskState = {
      id: "goal-1",
      name: "fix-auth",
      goal: "Make auth checks pass.",
      workdir: "/tmp/project",
      status: "running",
      createdAt: 1,
      updatedAt: 2,
      iteration: 1,
      maxIterations: 4,
      sessionId: "sess-1",
      sessionName: "fix-auth",
      verifierCommands: [{ label: "check-1", command: "npm test" }],
      repeatedFailureCount: 0,
      lastVerifierSummary: "FAIL check-1 (exit 1, 100ms)",
      loopMode: "verifier",
    };

    const runtime = buildGoalTaskRuntimeSnapshot({
      phase: "implementing",
      isAwaitingInput: false,
      getOutput: () => ["", "running tests", "still working"],
    });

    assert.deepEqual(runtime, {
      phase: "implementing",
      awaitingInput: false,
      latestOutput: "running tests\nstill working",
    });

    const text = formatGoalTask(task, runtime);
    assert.match(text, /fix-auth \[goal-1\]/);
    assert.match(text, /Status: running/);
    assert.match(text, /Repair iteration: 1\/4/);
    assert.match(text, /Awaiting input: no/);
    assert.match(text, /FAIL check-1/);
    assert.match(text, /running tests/);
  });

  it("formats concise iteration summaries from prior output and verifier state", () => {
    const ralphSummary = buildGoalIterationSummary({
      completionPromise: "DONE",
      completionDetected: false,
      output: [
        "Readiness check ran; broker gate is still closed.",
        "No eligible paper intents appeared.",
        "Next iteration will watch for market data readiness.",
      ].join("\n"),
    });

    assert.equal(
      ralphSummary,
      [
        "Iteration summary:",
        "- Agent: Readiness check ran; broker gate is still closed.",
        "- Agent: No eligible paper intents appeared.",
        "- Agent: Next iteration will watch for market data readiness.",
      ].join("\n"),
    );

    const verifierSummary = buildGoalIterationSummary({
      output: "DONE",
      verifierSummary: "FAIL readiness (exit 1, 25ms)\nbroker gate stayed closed",
      completionPromise: "DONE",
      completionDetected: true,
    });

    assert.equal(
      verifierSummary,
      [
        "Iteration summary:",
        "- Completion was claimed, but the loop is continuing after verification.",
        "- Verifier: FAIL readiness (exit 1, 25ms)",
        "- Verifier: broker gate stayed closed",
      ].join("\n"),
    );
  });

  it("omits iteration summaries when source material is unavailable", () => {
    assert.equal(buildGoalIterationSummary({ completionPromise: "DONE", completionDetected: false }), undefined);
  });
});
