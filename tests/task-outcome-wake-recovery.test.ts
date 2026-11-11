import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionNotificationService } from "../src/session-notifications";
import { createTaskOutcomeReport } from "../src/session-task-outcome";
import { StatusCards } from "../src/status-card";
import type { PersistedSessionInfo } from "../src/types";
import type { SessionNotificationRequest, WakeDispatcher } from "../src/wake-dispatcher";

function fixture(state: PersistedSessionInfo["completionWakeSubmissionState"] = "not_submitted") {
  const originalMessage = "✅ [legacy-task] Completed. Offer Merge / PR / Later / Discard.";
  const row: PersistedSessionInfo = {
    sessionId: "legacy-task", harnessSessionId: "legacy-backend", name: "legacy-task",
    prompt: "Complete the requested task and checks.", workdir: "/nonexistent/legacy-task", costUsd: 0,
    status: "completed", createdAt: 100, completedAt: 200,
    route: { provider: "telegram", target: "synthetic", threadId: "42", sessionKey: "agent:fixture:telegram:group:synthetic:topic:42" },
    completionWakeSummaryRequired: true, completionWakeRunId: "retained-run",
    completionWakeOutcomeKey: "terminal:legacy-task:100", completionWakeSubmissionState: state,
    completionWakeRoutedReply: true, completionWakeMessage: originalMessage,
    completionWakeSummaryFact: { required: true, producer: "terminal", outcomeKey: "terminal:legacy-task:100" },
  };
  const requests: SessionNotificationRequest[] = [];
  const dispatcher: Pick<WakeDispatcher, "dispatchSessionNotification" | "dispose" | "statusCards"> = {
    statusCards: new StatusCards(),
    dispatchSessionNotification: (_session, request) => { requests.push(request); },
    dispose: () => {},
  };
  const restart = () => new SessionNotificationService(
    // Only notification dispatch and status-card methods are used here.
    dispatcher as WakeDispatcher,
    (_ref, patch) => { Object.assign(row, patch); },
    { getPersistedSession: () => row },
  );
  return { row, requests, restart, originalMessage };
}

function report(row: PersistedSessionInfo, task: "completed" | "blocked") {
  row.taskOutcome = createTaskOutcomeReport({
    executionCycle: 100, task,
    repositories: [{ workdir: "/nonexistent/legacy-task", head: "a".repeat(40) }],
    checks: [{ name: "Required lint", scope: "task", required: true, status: task === "blocked" ? "not_run" : "passed",
      stage: "file analysis", evidence: "fixture:lint-receipt", source: "reviewed_receipt" }],
    blockers: task === "blocked" ? ["Required lint did not run"] : [],
    remainingWork: task === "blocked" ? ["Complete verification"] : [], summary: "Recorded historical task evidence.",
  }, { source: "orchestrator" });
}

describe("recovered completion wakes preserve custody and truthful task semantics", () => {
  it("upgrades a proven unsubmitted legacy success into a review wake without changing custody", () => {
    const f = fixture();
    const fact = structuredClone(f.row.completionWakeSummaryFact);
    f.restart().recoverAdmittedCompletionWakes([f.row]);
    assert.equal(f.requests.length, 1);
    const request = f.requests[0]!;
    assert.equal(request.retryUnsubmittedWake, true);
    assert.equal(request.admittedWakeRunId, "retained-run");
    assert.equal(request.completionWakeOutcomeKey, "terminal:legacy-task:100");
    assert.equal(request.notifyUser, "never");
    assert.equal(request.userMessage, undefined);
    assert.equal(request.buttons, undefined);
    assert.match(request.wakeMessage!.split("\n")[0]!, /Execution ended — task completion unverified/);
    assert.match(request.wakeMessage!, /For an ordinary task, submit agent_report_outcome/);
    assert.match(request.wakeMessage!, /Do not repeat historical success wording or offer merge/);
    assert.match(request.wakeMessage!, /historical unsubmitted wake tail/);
    assert.ok(request.wakeMessage!.includes(f.originalMessage), "old wording is fenced historical data, not an instruction");
    assert.equal(f.row.completionWakeMessage, f.originalMessage, "preparation alone never rewrites an admission journal");
    assert.deepEqual(f.row.completionWakeSummaryFact, fact);
    request.hooks!.onWakeAdmitted!("retained-run", true, request.wakeMessage);
    assert.equal(f.row.completionWakeRunId, "retained-run");
    assert.equal(f.row.completionWakeMessage, request.wakeMessage, "the actual unsubmitted intent is journaled before retry");
    assert.deepEqual(f.row.completionWakeSummaryFact, fact);
  });

  it("retains structured blockers in the repaired follow-up", () => {
    const f = fixture();
    report(f.row, "blocked");
    f.restart().recoverAdmittedCompletionWakes([f.row]);
    const text = f.requests[0]!.wakeMessage!;
    assert.match(text.split("\n")[0]!, /task completion unverified/);
    assert.match(text, /"recordedTask":"blocked"/);
    assert.match(text, /Required lint did not run/);
    assert.match(text, /Complete verification/);
    assert.equal(f.row.taskOutcome!.task, "blocked");
  });

  it("does not trust a saved positive report without fresh checkout revalidation", () => {
    const f = fixture();
    report(f.row, "completed");
    f.restart().recoverAdmittedCompletionWakes([f.row]);
    assert.match(f.requests[0]!.wakeMessage!.split("\n")[0]!, /task completion unverified/);
    assert.match(f.requests[0]!.wakeMessage!, /current repository heads, required check receipts/);
    assert.equal(f.requests[0]!.buttons, undefined);
  });

  for (const state of ["unknown", undefined] as const) {
    it(`observes ${state ?? "legacy unknown"} admission without resubmitting or rewriting its message`, () => {
      const f = fixture(state);
      // An omitted submission-state field is legacy ambiguous custody.
      if (state === undefined) f.row.completionWakeSubmissionState = undefined;
      report(f.row, "blocked");
      f.restart().recoverAdmittedCompletionWakes([f.row]);
      const request = f.requests[0]!;
      assert.equal(request.retryUnsubmittedWake, false);
      assert.equal(request.admittedWakeRunId, "retained-run");
      assert.equal(request.wakeMessage, "Observe the previously admitted completion follow-up.");
      assert.equal(request.notifyUser, "never");
      assert.equal(request.userMessage, undefined);
      assert.equal(f.row.completionWakeMessage, f.originalMessage);
      assert.equal(f.row.completionWakeSubmissionState, state);
      assert.equal(f.row.completionWakeSummaryRequired, true);
    });
  }

  it("preserves stopped execution and outstanding approval facts", () => {
    const f = fixture();
    f.row.status = "killed";
    f.row.pendingPlanApproval = true;
    f.row.approvalState = "pending";
    f.restart().recoverAdmittedCompletionWakes([f.row]);
    const text = f.requests[0]!.wakeMessage!;
    assert.match(text, /"executionStatus":"killed"/);
    assert.match(text, /"pendingPlanApproval":true/);
    assert.match(text, /Preserve approval requests, failures, stopped\/suspended status/);
    assert.equal(f.row.pendingPlanApproval, true);
    assert.equal(f.row.status, "killed");
  });

  it("bounds historical context across repeated proven non-submissions", () => {
    const f = fixture();
    for (let attempt = 0; attempt < 8; attempt++) {
      f.restart().recoverAdmittedCompletionWakes([f.row]);
      const request = f.requests.at(-1)!;
      assert.ok(request.wakeMessage!.length < 8_000);
      request.hooks!.onWakeAdmitted!("retained-run", true, request.wakeMessage);
      request.hooks!.onWakeAdmissionRejected!("retained-run");
      assert.equal(f.row.completionWakeSubmissionState, "not_submitted");
    }
  });
});
