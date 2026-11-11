import { execFileSync } from "node:child_process";
import { createTaskOutcomeReport, executionCycle, type TaskOutcomeInput, type TaskOutcomeReport, type TaskOutcomeSession } from "../src/session-task-outcome";

/** Explicit reviewed evidence for a positive fixture; never installed globally. */
export function reviewedTaskInput(session: TaskOutcomeSession): TaskOutcomeInput {
  const workdir = session.worktreePath ?? session.workdir ?? session.originalWorkdir;
  if (!workdir) throw new Error("A reviewed task fixture needs its actual checkout.");
  const root = execFileSync("git", ["-C", workdir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const head = execFileSync("git", ["-C", workdir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const cycle = executionCycle(session) || 1;
  return {
    executionCycle: cycle, task: "completed", repositories: [{ workdir: root, head }],
    checks: [{ name: "Fixture acceptance", scope: "requested fixture change", required: true,
      status: "passed", stage: "review", evidence: "fixture:reviewed-acceptance", source: "reviewed_receipt" }],
    blockers: [], remainingWork: [], summary: "Reviewed fixture task and verification receipts.",
  };
}

export function reviewedTaskFixture<T extends TaskOutcomeSession>(session: T): T & { startedAt: number; taskOutcome: TaskOutcomeReport } {
  const input = reviewedTaskInput(session);
  if (session.status === undefined) session.status = "completed";
  return Object.assign(session, {
    startedAt: input.executionCycle,
    createdAt: input.executionCycle,
    taskOutcome: createTaskOutcomeReport(input, { source: "orchestrator", sessionKey: "agent:fixture-reviewer" }),
  });
}
