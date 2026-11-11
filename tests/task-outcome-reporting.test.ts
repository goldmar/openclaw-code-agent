import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/session-manager";
import type { Session } from "../src/session";
import type { SessionNotificationRequest } from "../src/wake-dispatcher";
import { hasVerifiedTaskOutcome, type TaskOutcomeInput } from "../src/session-task-outcome";
import { createStubSession } from "./helpers";
import { getSessionOutputText, getSessionsListingText } from "../src/application/session-view";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "oca-task-report-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("-c", "user.name=Tester", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "task change");
  const sm = new SessionManager(5, 50, { store: { indexPath: join(dir, ".git", "sessions.json") } });
  const session: Session = createStubSession({ id: "report-task", name: "report-task", status: "completed",
    lifecycle: "terminal", startedAt: 100, completedAt: 200, duration: 100, costUsd: 0, prompt: "Complete the requested change",
    workdir: dir, worktreeStrategy: "manual", getOutput: () => ["Harness exited zero; work may remain."],
    noteOutcomeSeen: () => false });
  // The fake session replaces only the harness execution boundary; report
  // validation, state synchronization, presentation and orchestration are real.
  const internals = sm as unknown as { sessions: Map<string, Session>; handleWorktreeStrategy: (s: Session) => Promise<{ notificationSent: boolean; worktreeRemoved: boolean }>;
    dispatchSessionNotification: (session: Session, request: SessionNotificationRequest) => void };
  internals.sessions.set(session.id, session);
  const notifications: SessionNotificationRequest[] = [];
  internals.dispatchSessionNotification = (_session, request) => { notifications.push(request); };
  let strategies = 0;
  internals.handleWorktreeStrategy = async () => { strategies++; return { notificationSent: false, worktreeRemoved: false }; };
  cleanups.push(() => { sm.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const input = (): TaskOutcomeInput => ({ executionCycle: 100, task: "completed",
    repositories: [{ workdir: dir, head: git("rev-parse", "HEAD") }],
    checks: [{ name: "Focused checks", scope: "requested task", required: true, status: "passed", stage: "analysis",
      evidence: "receipt:focused-checks", source: "reviewed_receipt", exitCode: 0 }],
    blockers: [], remainingWork: [], summary: "Requested changes and checks were reviewed." });
  return { sm, session, notifications, input, git, strategies: () => strategies };
}

describe("reviewed task outcome reporting", () => {
  it("keeps committed but blocked work out of completion and integration", async () => {
    const f = fixture();
    const blocked: TaskOutcomeInput = { ...f.input(), task: "blocked", checks: [
      { ...f.input().checks[0], name: "Core tests", scope: "core", stage: "70 tests passed" },
      { ...f.input().checks[0], name: "Core lint", scope: "core" },
      { ...f.input().checks[0], name: "Telegram declarations", scope: "telegram", status: "timed_out", stage: "prerequisite", exitCode: 124 },
      { ...f.input().checks[0], name: "Telegram lint", scope: "telegram", status: "not_run", stage: "file analysis", exitCode: undefined },
    ], blockers: ["Telegram lint analysis never ran", "Independent preservation remains unresolved"],
    remainingWork: ["Finish verification and preservation"], summary: "Core checks passed; the task remains blocked." };
    assert.match(await f.sm.reportTaskOutcome(f.session.id, blocked, { source: "orchestrator" }), /recorded: blocked; verification blocked/);
    assert.equal(f.strategies(), 0);
    assert.equal(hasVerifiedTaskOutcome(f.session), false);
    assert.equal(f.notifications.length, 1);
    assert.doesNotMatch(f.notifications[0].userMessage!, /✅|Finished on|Merge|Discard/);
    assert.match(f.notifications[0].userMessage!, /Independent preservation/);
    assert.equal(f.notifications[0].completionWakeSummaryRequired, false);
    assert.match(getSessionOutputText(f.sm, f.session.id, { full: true }), /Task: blocked \| Verification: blocked/);
    assert.doesNotMatch(getSessionsListingText(f.sm), /✅/);
    assert.match(await f.sm.requestWorktreeDecisionFromUser(f.session.id, "Please merge"), /completion and verification are not established/);
  });

  it("announces reviewed success once and then permits policy-governed follow-through", async () => {
    const f = fixture();
    assert.match(await f.sm.reportTaskOutcome(f.session.id, f.input(), { source: "orchestrator", sessionKey: "agent:reviewer" }), /recorded: completed/);
    assert.equal(hasVerifiedTaskOutcome(f.session), true);
    assert.equal(f.notifications.length, 1);
    assert.match(f.notifications[0].userMessage!, /^✅ \[report-task\] Completed/);
    assert.equal(f.notifications[0].wakeMessageOnNotifySuccess, undefined);
    assert.equal(f.strategies(), 1);
    assert.match(await f.sm.reportTaskOutcome(f.session.id, f.input(), { source: "orchestrator" }), /already recorded/);
    assert.equal(f.notifications.length, 1);
    assert.equal(f.strategies(), 1);
  });

  it("rejects stale cycles, stale heads, aliases and contradictory success", async () => {
    const f = fixture();
    assert.match(await f.sm.reportTaskOutcome("report-task-name", f.input(), { source: "orchestrator" }), /exact OCA session ID/);
    assert.match(await f.sm.reportTaskOutcome(f.session.id, { ...f.input(), executionCycle: 99 }, { source: "orchestrator" }), /different execution cycle/);
    const old = f.input();
    f.git("-c", "user.name=Tester", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "new task work");
    assert.match(await f.sm.reportTaskOutcome(f.session.id, old, { source: "orchestrator" }), /head changed/);
    assert.match(await f.sm.reportTaskOutcome(f.session.id, { ...f.input(), blockers: ["A check remains blocked"] }, { source: "orchestrator" }), /no blockers/);
    assert.equal(f.notifications.length, 0);
    assert.equal(f.strategies(), 0);
  });

  it("supports resumption and successful revalidation without reusing the old cycle", async () => {
    const f = fixture();
    await f.sm.reportTaskOutcome(f.session.id, { ...f.input(), task: "incomplete", remainingWork: ["Finish checks"] }, { source: "orchestrator" });
    f.session.startedAt = 300;
    assert.equal(hasVerifiedTaskOutcome(f.session), false);
    assert.match(await f.sm.reportTaskOutcome(f.session.id, f.input(), { source: "orchestrator" }), /different execution cycle/);
    await f.sm.reportTaskOutcome(f.session.id, { ...f.input(), executionCycle: 300 }, { source: "orchestrator" });
    assert.equal(f.strategies(), 1);
    assert.equal(f.notifications.filter((request) => request.userMessage?.startsWith("✅")).length, 1);
  });

  it("does not claim conflict resolution when its resolver merely stopped", async () => {
    const f = fixture();
    f.session.autoMergeParentSessionId = "parent-task";
    const parent: Session = createStubSession({ id: "parent-task", name: "parent-task", status: "completed",
      startedAt: 50, workdir: f.session.workdir, costUsd: 0, duration: 100, getOutput: (): string[] => [] });
    const internals = f.sm as unknown as { sessions: Map<string, Session>; handleAutoMergeResolverTerminal: (session: Session) => Promise<void> };
    internals.sessions.set(parent.id, parent);
    await internals.handleAutoMergeResolverTerminal(f.session);
    assert.equal(f.strategies(), 0);
    assert.ok(f.notifications.some((notice) => /resolution is unverified/.test(notice.userMessage ?? "")));
    assert.ok(f.notifications.every((notice) => !/Conflict resolved|✅/.test(notice.userMessage ?? "")));
  });

  it("records OCA verifier provenance only through the owning goal controller", async () => {
    const f = fixture();
    const input = { ...f.input(), checks: f.input().checks.map((check) => ({ ...check, source: "oca_verifier" as const })) };
    assert.match(await f.sm.reportTaskOutcome(f.session.id, input, { source: "orchestrator" }), /provenance belongs to the goal controller/);
    assert.equal(f.notifications.length, 0);
    await f.sm.reportTaskOutcome(f.session.id, input, { source: "goal_controller" });
    assert.equal(f.session.taskOutcome?.reviewer.source, "goal_controller");
    assert.equal(f.notifications.length, 0, "the goal controller owns its success notice");
  });
});
