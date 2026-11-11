import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTaskOutcomeReport, executionCycle, hasVerifiedTaskOutcome, isTaskOutcomeCurrent,
  normalizeTaskOutcomeReport, parseTaskOutcomeInput, taskVerification, validateTaskOutcomeSnapshot,
  type TaskOutcomeInput, type TaskOutcomeSession,
} from "../src/session-task-outcome";
import { normalizePersistedEntry } from "../src/session-store-normalization";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "oca-task-outcome-"));
  roots.push(dir);
  return dir;
}
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}
function repository(): { workdir: string; head: string } {
  const workdir = directory();
  git(workdir, ["init", "-q"]);
  writeFileSync(join(workdir, "file.txt"), "initial\n");
  git(workdir, ["add", "--", "file.txt"]);
  git(workdir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]);
  return { workdir, head: git(workdir, ["rev-parse", "HEAD"]) };
}
function input(overrides: Partial<TaskOutcomeInput> = {}): TaskOutcomeInput {
  return {
    executionCycle: 100, task: "completed", checks: [{ name: "Focused tests", scope: "task acceptance",
      required: true, status: "passed", stage: "test execution", evidence: "receipt:test-run", source: "reviewed_receipt", exitCode: 0 }],
    repositories: [], blockers: [], remainingWork: [], summary: "Implemented and verified the requested change.", ...overrides,
  };
}
function completed(outcome: TaskOutcomeInput = input()): TaskOutcomeSession {
  return { status: "completed", startedAt: 100,
    taskOutcome: createTaskOutcomeReport(outcome, { source: "orchestrator", sessionKey: "agent:reviewer" }) };
}

describe("structured task outcome evidence", () => {
  it("never equates execution completion, commits or completion prose with task success", () => {
    assert.equal(hasVerifiedTaskOutcome({ status: "completed", startedAt: 100 }), false);
    const successful = completed();
    assert.equal(hasVerifiedTaskOutcome(successful), true);
    assert.equal(hasVerifiedTaskOutcome({ ...successful, status: "running" }), false);
    assert.equal(hasVerifiedTaskOutcome({ ...successful, status: "failed" }), false);
    assert.equal(hasVerifiedTaskOutcome({ ...successful, pendingPlanApproval: true }), false);
  });

  it("records passing core checks separately from timed-out prerequisites and unrun analysis", () => {
    const report = input({ task: "blocked", blockers: ["Telegram declarations timed out", "Required independent preservation remains unresolved"],
      remainingWork: ["Run Telegram lint after its prerequisites finish", "Preserve the nested repository independently"],
      checks: [
        { name: "Core tests", scope: "core", required: true, status: "passed", stage: "70 tests", evidence: "receipt:core-tests", source: "reviewed_receipt", exitCode: 0 },
        { name: "Core lint", scope: "core", required: true, status: "passed", stage: "analysis", evidence: "receipt:core-lint", source: "reviewed_receipt", exitCode: 0 },
        { name: "Telegram declarations", scope: "telegram", required: true, status: "timed_out", stage: "prerequisite", evidence: "receipt:timeout", source: "reviewed_receipt" },
        { name: "Telegram lint", scope: "telegram", required: true, status: "not_run", stage: "file analysis", evidence: "receipt:prerequisite-timeout", source: "reviewed_receipt" },
      ] });
    assert.equal(parseTaskOutcomeInput(report).ok, true);
    assert.equal(taskVerification(report.checks), "blocked");
    assert.equal(hasVerifiedTaskOutcome(completed(report)), false);
    assert.equal(parseTaskOutcomeInput({ ...report, task: "completed" }).ok, false);
  });

  it("requires a reviewed acceptance check even for a no-change or research task", () => {
    assert.equal(parseTaskOutcomeInput(input({ checks: [] })).ok, false);
    assert.equal(parseTaskOutcomeInput(input({ checks: [{ ...input().checks[0], required: false }] })).ok, false);
    const review = input({ checks: [{ name: "Test applicability", scope: "documentation only",
      required: true, status: "not_applicable", stage: "scope review", evidence: "Reviewed diff: no executable change; links checked", source: "reviewed_receipt" }] });
    assert.equal(parseTaskOutcomeInput(review).ok, true);
    assert.equal(hasVerifiedTaskOutcome(completed(review)), true);
  });

  it("rejects malformed receipts, contradictory results and caller-supplied verification authority", () => {
    for (const value of [
      { ...input(), verification: "passed" },
      { ...input(), reviewer: { source: "goal_controller" } },
      input({ checks: [{ ...input().checks[0], exitCode: 1 }] }),
      input({ checks: [{ ...input().checks[0], evidence: "" }] }),
      input({ blockers: ["A required check remains blocked"] }),
      input({ remainingWork: ["Finish acceptance"] }),
      input({ executionCycle: Number.NaN }),
      input({ checks: [{ ...input().checks[0], status: "failed", exitCode: 0 }] }),
    ]) assert.equal(parseTaskOutcomeInput(value).ok, false);
  });

  it("retains honest failed and unrun outcomes without turning them into success", () => {
    for (const status of ["failed", "timed_out", "not_run"] as const) {
      const report = input({ task: "incomplete", remainingWork: ["Resolve required verification"],
        checks: [{ ...input().checks[0], status, exitCode: status === "failed" ? 2 : undefined }] });
      assert.equal(parseTaskOutcomeInput(report).ok, true);
      assert.equal(hasVerifiedTaskOutcome(completed(report)), false);
    }
  });

  it("drops malformed restored evidence and leaves legacy execution status unverified", () => {
    const report = createTaskOutcomeReport(input(), { source: "orchestrator" });
    assert.deepEqual(normalizeTaskOutcomeReport(report), report);
    assert.equal(normalizeTaskOutcomeReport({ ...report, verification: "failed" }), undefined);
    assert.equal(normalizeTaskOutcomeReport({ ...report, reviewedAt: "unknown" }), undefined);
    const persisted = normalizePersistedEntry({ harnessSessionId: "backend", sessionId: "session", name: "task", prompt: "work",
      workdir: "/nonexistent/task", status: "completed", createdAt: 100, costUsd: 0,
      route: { provider: "telegram", target: "12345", sessionKey: "agent:reviewer" }, taskOutcome: report });
    assert.ok(persisted);
    assert.equal(hasVerifiedTaskOutcome(persisted), true);
    assert.equal(hasVerifiedTaskOutcome({ ...persisted, taskOutcome: undefined }), false);
  });

  it("does not reuse the earlier execution's success after resume", () => {
    const session = completed();
    assert.equal(executionCycle(session), 100);
    assert.equal(executionCycle({ createdAt: 200 }), 200);
    assert.equal(hasVerifiedTaskOutcome({ ...session, startedAt: 200 }), false);
    const renewed = completed(input({ executionCycle: 200 }));
    renewed.startedAt = 200;
    assert.equal(hasVerifiedTaskOutcome(renewed), true);
  });
});

describe("current repository evidence", () => {
  it("requires the actual session checkout, not a sibling checkout with the same HEAD", async () => {
    const repo = repository();
    const sibling = repository();
    const session = { ...completed(input({ repositories: [sibling] })), worktreePath: repo.workdir };
    assert.match(await validateTaskOutcomeSnapshot(session, session.taskOutcome!) ?? "", /must include the session/);
  });

  it("invalidates successful evidence when a checkout changes, and allows revalidation", async () => {
    const repo = repository();
    const session = { ...completed(input({ repositories: [repo] })), worktreePath: repo.workdir };
    assert.equal(await isTaskOutcomeCurrent(session), true);
    writeFileSync(join(repo.workdir, "file.txt"), "updated\n");
    assert.equal(await isTaskOutcomeCurrent(session), false);
    git(repo.workdir, ["add", "--", "file.txt"]);
    git(repo.workdir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "updated"]);
    assert.equal(await isTaskOutcomeCurrent(session), false);
    session.taskOutcome = createTaskOutcomeReport(input({ repositories: [{ ...repo, head: git(repo.workdir, ["rev-parse", "HEAD"]) }] }), { source: "orchestrator" });
    assert.equal(await isTaskOutcomeCurrent(session), true);
  });

  it("accepts a blocked report with dirty committed work while withholding readiness", async () => {
    const repo = repository();
    const report = input({ task: "blocked", repositories: [repo], blockers: ["Required lint never ran"] });
    const session = { ...completed(report), worktreePath: repo.workdir };
    writeFileSync(join(repo.workdir, "file.txt"), "unfinished\n");
    assert.equal(await validateTaskOutcomeSnapshot(session, report), undefined);
    assert.equal(await isTaskOutcomeCurrent(session), false);
  });

  it("supports a reviewed non-git task but fails closed for a missing managed checkout", async () => {
    const session = { ...completed(), workdir: directory() };
    assert.equal(await validateTaskOutcomeSnapshot(session, session.taskOutcome!), undefined);
    assert.equal(await isTaskOutcomeCurrent(session), true);
    assert.equal(await isTaskOutcomeCurrent({ ...session, worktreePath: "/nonexistent/task" }), false);
    mkdirSync(join(session.workdir, ".git"));
    assert.equal(await isTaskOutcomeCurrent(session), false, "a broken task-local Git marker cannot become a successful research task");
  });

  it("accepts missing checkouts and historical heads as blockers without granting readiness", async () => {
    const report = input({ task: "blocked", blockers: ["The required checkout is missing"],
      repositories: [{ workdir: "/nonexistent/task", head: "a".repeat(40) }] });
    const session = { ...completed(report), worktreePath: "/nonexistent/task" };
    assert.equal(await validateTaskOutcomeSnapshot(session, report), undefined);
    assert.equal(await isTaskOutcomeCurrent(session), false);
    assert.match(await validateTaskOutcomeSnapshot(session, input({ repositories: report.repositories })) ?? "", /unknown or missing/);
    assert.match(await validateTaskOutcomeSnapshot({ ...session, startedAt: 200 }, report) ?? "", /different execution cycle/);
    assert.match(await validateTaskOutcomeSnapshot(session, { ...report, blockers: [], remainingWork: [] }) ?? "", /must describe/);
  });

  it("binds every additional required repository, including a separately preserved core checkout", async () => {
    const first = repository();
    const core = repository();
    const session = { ...completed(input({ repositories: [first, core] })), worktreePath: first.workdir };
    assert.equal(await isTaskOutcomeCurrent(session), true);
    writeFileSync(join(core.workdir, "file.txt"), "unfinished core\n");
    assert.equal(await isTaskOutcomeCurrent(session), false);
  });
});
