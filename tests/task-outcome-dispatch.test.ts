import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/session-manager";
import type { Session } from "../src/session";
import type { SessionLifecycleService } from "../src/session-lifecycle-service";
import type { SessionStore } from "../src/session-store";
import type { PersistedSessionInfo } from "../src/types";
import type { TaskOutcomeInput } from "../src/session-task-outcome";
import type { SessionNotificationRequest } from "../src/wake-dispatcher";
import { createStubSession } from "./helpers";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function fixture(persistedOnly: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "oca-task-dispatch-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("-c", "user.name=Fixture User", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "task change");
  const sm = new SessionManager(5, 50, { store: { indexPath: join(dir, ".git", "sessions.json") } });
  const row: PersistedSessionInfo = {
    sessionId: "dispatch-task", harnessSessionId: "dispatch-backend", name: "dispatch-task",
    backendRef: { kind: "claude-code", conversationId: "dispatch-backend" },
    prompt: "Finish the task and required checks.", workdir: dir, status: "completed",
    createdAt: 100, completedAt: 200, costUsd: 0, lifecycle: "terminal", runtimeState: "stopped",
    worktreeStrategy: "manual", route: { provider: "telegram", target: "synthetic" },
  };
  const target: Session = createStubSession({ id: "dispatch-task", name: row.name,
    status: "completed", lifecycle: "terminal", startedAt: 100, completedAt: 200, duration: 100,
    costUsd: 0, prompt: row.prompt, workdir: dir, worktreeStrategy: "manual",
    harnessSessionId: "dispatch-backend", getOutput: (): string[] => [], noteOutcomeSeen: () => false,
  });
  // Explicit harness/store fixture boundary; report acceptance and dispatch
  // predicates below are the real production implementations.
  const internals = sm as unknown as { sessions: Map<string, Session>; store: SessionStore; lifecycle: SessionLifecycleService;
    dispatchSessionNotification: (session: Session, request: SessionNotificationRequest) => void };
  internals.store.persisted.set(row.harnessSessionId, row);
  internals.store.idIndex.set(row.sessionId!, row.harnessSessionId);
  if (!persistedOnly) internals.sessions.set(target.id, target);
  const notices: SessionNotificationRequest[] = [];
  internals.dispatchSessionNotification = (_session, request) => { notices.push(request); };
  cleanup.push(() => { sm.dispose(); rmSync(dir, { recursive: true, force: true }); });
  const input: TaskOutcomeInput = {
    executionCycle: 100, task: "completed", repositories: [{ workdir: dir, head: git("rev-parse", "HEAD") }],
    checks: [{ name: "Required checks", scope: "requested task", required: true,
      status: "passed", stage: "analysis", evidence: "fixture:required-checks", source: "reviewed_receipt", exitCode: 0 }],
    blockers: [], remainingWork: [], summary: "The requested task and required checks were reviewed.",
  };
  return { sm, row, target, internals, input, notices };
}

describe("terminal dispatch remains bound to the reviewed outcome", () => {
  for (const persistedOnly of [false, true]) {
    const mode = persistedOnly ? "persisted-only" : "live";
    it(`drops a queued success after a same-cycle blocked correction (${mode})`, async () => {
      const f = fixture(persistedOnly);
      await f.sm.reportTaskOutcome("dispatch-task", f.input, { source: "orchestrator" });
      const success = f.notices.find((notice) => notice.userMessage?.startsWith("✅"));
      assert.ok(success);
      assert.equal(success.shouldDispatch?.(), true);
      await f.sm.reportTaskOutcome("dispatch-task", {
        ...f.input, task: "blocked", blockers: ["A required check remains unresolved"], remainingWork: ["Finish verification"],
        checks: [{ ...f.input.checks[0], status: "not_run", exitCode: undefined }],
        summary: "The task remains blocked by verification.",
      }, { source: "orchestrator" });
      assert.equal(success.shouldDispatch?.(), false, "the obsolete success must not reach transport");
      const blocked = f.notices.at(-1)!;
      assert.match(blocked.userMessage!, /task blocked/);
      assert.equal(blocked.shouldDispatch?.(), true);
    });

    it(`drops a queued unverified notice and review wake after same-cycle success (${mode})`, async () => {
      const f = fixture(persistedOnly);
      // A routing proxy has its own object identity when no runtime Session is
      // loaded; the authoritative row must still invalidate its old payload.
      const initial = persistedOnly
        ? Object.assign(f.target, { route: f.row.route })
        : f.target;
      f.internals.lifecycle.emitCompleted(initial);
      const unverified = f.notices[0]!;
      assert.match(unverified.userMessage!, /completion unverified/);
      assert.equal(unverified.shouldDispatch?.(), true);
      await f.sm.reportTaskOutcome("dispatch-task", f.input, { source: "orchestrator" });
      assert.equal(unverified.shouldDispatch?.(), false, "the old review request must not be delivered after success");
      const success = f.notices.at(-1)!;
      assert.match(success.userMessage!, /^✅/);
      assert.equal(success.shouldDispatch?.(), true);
    });
  }
});
