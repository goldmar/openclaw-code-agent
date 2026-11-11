import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/session-manager";
import { SessionNotificationService } from "../src/session-notifications";
import { StatusCards } from "../src/status-card";
import type { Session } from "../src/session";
import type { SessionLifecycleService } from "../src/session-lifecycle-service";
import type { SessionStore } from "../src/session-store";
import type { PersistedSessionInfo } from "../src/types";
import type { SessionNotificationRequest, WakeDispatcher } from "../src/wake-dispatcher";
import { createStubSession } from "./helpers";
import { reviewedTaskInput } from "./task-outcome-fixture";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

describe("reviewed foreground completion after an uncertain review wake", () => {
  it("delivers the canonical success without resubmitting or erasing the admitted wake", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oca-summary-transition-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-b", "main");
    git("-c", "user.name=Fixture User", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "task change");
    const sm = new SessionManager(5, 50, { store: { indexPath: join(dir, ".git", "sessions.json") } });
    const row: PersistedSessionInfo = {
      sessionId: "summary-task", harnessSessionId: "summary-backend", name: "summary-task",
      backendRef: { kind: "claude-code", conversationId: "summary-backend" },
      prompt: "Finish the task and required checks.", workdir: dir, status: "completed",
      createdAt: 100, completedAt: 200, costUsd: 0, lifecycle: "terminal", runtimeState: "stopped",
      worktreeStrategy: "manual", route: { provider: "telegram", target: "synthetic" },
    };
    const session = createStubSession({ id: "summary-task", name: row.name, status: "completed",
      lifecycle: "terminal", startedAt: 100, completedAt: 200, duration: 100, costUsd: 0,
      prompt: row.prompt, workdir: dir, worktreeStrategy: "manual", harnessSessionId: "summary-backend",
      getOutput: (): string[] => [], noteOutcomeSeen: () => false,
    });
    // Keep production lifecycle, report acceptance and notification coordination;
    // replace only the transport with a deterministic admission boundary.
    const internals = sm as unknown as { sessions: Map<string, Session>; store: SessionStore;
      lifecycle: SessionLifecycleService; notifications: SessionNotificationService };
    internals.store.persisted.set(row.harnessSessionId, row);
    internals.store.idIndex.set(row.sessionId!, row.harnessSessionId);
    internals.sessions.set(session.id, session);
    const requests: SessionNotificationRequest[] = [];
    const dispatcher: Pick<WakeDispatcher, "dispatchSessionNotification" | "dispose" | "statusCards"> = {
      statusCards: new StatusCards(), dispose: () => {},
      dispatchSessionNotification: (_session, request) => { requests.push(request); },
    };
    internals.notifications.dispose();
    internals.notifications = new SessionNotificationService(dispatcher as WakeDispatcher,
      (ref, patch) => { sm.updatePersistedSession(ref, patch); }, { getPersistedSession: () => row });
    cleanup.push(() => { sm.dispose(); rmSync(dir, { recursive: true, force: true }); });

    internals.lifecycle.emitCompleted(session);
    assert.equal(requests.length, 1);
    const initial = requests[0]!;
    assert.match(initial.userMessage!, /completion unverified/);
    assert.equal(initial.completionWakeSummaryRequired, true);
    initial.hooks!.onNotifySucceeded!();
    initial.hooks!.onWakeStarted!();
    await initial.hooks!.onWakeAdmitted!("uncertain-review-run", true, initial.wakeMessageOnNotifySuccess);
    initial.hooks!.onWakeAmbiguous!("transport outcome unavailable");
    const custody = {
      runId: row.completionWakeRunId, outcomeKey: row.completionWakeOutcomeKey,
      message: row.completionWakeMessage, fact: structuredClone(row.completionWakeSummaryFact),
      routedReply: row.completionWakeRoutedReply, submissionState: row.completionWakeSubmissionState,
    };
    assert.equal(custody.submissionState, "unknown");

    const result = await sm.reportTaskOutcome(session.id, reviewedTaskInput(session), { source: "orchestrator" });
    assert.match(result, /^Task outcome recorded: completed; verification passed/);
    assert.equal(requests.length, 2, "the reviewed foreground notice survives the pending wake");
    const reviewed = requests[1]!;
    assert.match(reviewed.userMessage!, /^✅/);
    assert.equal(reviewed.notifyUser, "always");
    assert.equal(reviewed.shouldDispatch?.(), true);
    assert.equal(reviewed.completionWakeSummaryRequired, false);
    assert.equal(reviewed.admittedWakeRunId, undefined);
    assert.equal(reviewed.wakeMessage, undefined);
    assert.equal(reviewed.wakeMessageOnNotifySuccess, undefined);
    assert.equal(reviewed.wakeMessageOnNotifyFailed, undefined);
    reviewed.hooks!.onNotifySucceeded!();
    assert.equal(row.completionWakeSummaryRequired, true, "foreground delivery leaves uncertain custody unresolved");
    assert.deepEqual({ runId: row.completionWakeRunId, outcomeKey: row.completionWakeOutcomeKey,
      message: row.completionWakeMessage, fact: row.completionWakeSummaryFact,
      routedReply: row.completionWakeRoutedReply, submissionState: row.completionWakeSubmissionState }, custody);

    internals.notifications.recoverAdmittedCompletionWakes([row]);
    assert.equal(requests.length, 3);
    const observation = requests[2]!;
    assert.equal(observation.admittedWakeRunId, "uncertain-review-run");
    assert.equal(observation.retryUnsubmittedWake, false);
    assert.equal(observation.notifyUser, "never");
    assert.equal(observation.userMessage, undefined);
    assert.equal(observation.completionWakeOutcomeKey, custody.outcomeKey);
    assert.equal(row.completionWakeMessage, custody.message);
  });
});
