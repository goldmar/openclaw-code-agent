import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getFreshSessionOutputText, getFreshSessionsListingText, getSessionOutputText, getSessionsListingText,
} from "../src/application/session-view";
import { createTaskOutcomeReport } from "../src/session-task-outcome";
import type { Session } from "../src/session";
import type { SessionManager } from "../src/session-manager";
import { createStubSession } from "./helpers";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function fixture() {
  const workdir = mkdtempSync(join(tmpdir(), "oca-outcome-view-"));
  git(workdir, "init", "-b", "main");
  git(workdir, "config", "user.name", "Test");
  git(workdir, "config", "user.email", "test@example.com");
  git(workdir, "commit", "--allow-empty", "-qm", "initial");
  const session = createStubSession({ id: "freshness-task", name: "freshness-task", status: "completed",
    startedAt: 1700000000000, duration: 1000, costUsd: 0, prompt: "Review the requested task", workdir, originalWorkdir: workdir, worktreePath: workdir,
    worktreeBranch: "main", worktreeStrategy: "ask", lifecycle: "awaiting_worktree_decision",
    worktreeState: "pending_decision", worktreeLifecycle: { state: "pending_decision", updatedAt: new Date().toISOString() },
    phase: "awaiting_worktree_decision", outputBuffer: ["Task output"], getOutput: () => ["Task output"],
  }) as Session;
  session.taskOutcome = createTaskOutcomeReport({ executionCycle: session.startedAt, task: "completed",
    checks: [{ name: "tests", scope: "task", required: true, status: "passed", stage: "analysis complete",
      evidence: "reviewed passing receipt", source: "reviewed_receipt", exitCode: 0 }],
    repositories: [{ workdir, head: git(workdir, "rev-parse", "HEAD") }],
    blockers: [], remainingWork: [], summary: "Requested work passed its required checks.",
  }, { source: "orchestrator" });
  // The view only reads these four manager methods; no runtime or provider is started.
  const manager = {
    resolve: (ref: string) => ref === session.id ? session : undefined,
    getPersistedSession: (): undefined => undefined,
    list: () => [session], listPersistedSessions: (): never[] => [],
  } as unknown as SessionManager;
  return { workdir, session, manager, cleanup: () => rmSync(workdir, { recursive: true, force: true }) };
}

describe("task outcome presentation freshness", () => {
  it("requires fresh repository proof before showing success or integration instructions", async () => {
    const { manager, session, cleanup } = fixture();
    try {
      const historical = getSessionsListingText(manager);
      assert.doesNotMatch(historical, /✅|Merge \/|Open PR \/|agent_merge/);
      assert.match(historical, /last reviewed task completed; verification freshness unverified/);
      const historicalOutput = getSessionOutputText(manager, session.id);
      assert.match(historicalOutput, /Last reviewed task: completed \| Verification freshness: unverified/);
      assert.match(historicalOutput, /task success is not established/);
      assert.match(await getFreshSessionsListingText(manager), /^✅/);
      assert.match(await getFreshSessionsListingText(manager, "waiting"), /Merge \/ Open PR \/ Later \/ Discard/);
      assert.match(await getFreshSessionOutputText(manager, session.id), /Task: completed \| Verification: passed/);
    } finally { cleanup(); }
  });

  for (const change of ["dirty", "new-head"] as const) {
    it(`withholds success and integration instructions after ${change} work`, async () => {
      const { workdir, manager, session, cleanup } = fixture();
      try {
        assert.match(await getFreshSessionsListingText(manager), /^✅/);
        if (change === "dirty") writeFileSync(join(workdir, "unfinished.txt"), "unfinished\n");
        else git(workdir, "commit", "--allow-empty", "-qm", "later work");
        const listing = await getFreshSessionsListingText(manager);
        assert.doesNotMatch(listing, /✅/);
        assert.match(listing, /verification freshness unverified/);
        assert.equal(await getFreshSessionsListingText(manager, "waiting"), "Nothing is waiting for a decision or an answer.");
        const output = await getFreshSessionOutputText(manager, session.id);
        assert.match(output, /Verification freshness: unverified/);
        assert.match(output, /task success is not established/);
        assert.doesNotMatch(output, /Task: completed \| Verification: passed/);
      } finally { cleanup(); }
    });
  }
});
