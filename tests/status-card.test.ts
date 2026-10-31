import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatusCards } from "../src/status-card";
import { SessionNotificationService } from "../src/session-notifications";
import { opsDigestInternals, enqueueHeldWork } from "../src/ops-digest";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("coalesced status cards", () => {
  it("serializes edits and holds an unknown edit without a new acknowledgement", async () => {
    const cards = new StatusCards();
    const edits: string[] = [];
    cards.register("a", async (text) => { edits.push(text); if (text === "unknown") throw new Error("lost ack"); });
    cards.update("a", "approved"); cards.update("a", "unknown"); cards.update("a", "delegate");
    await flush();
    assert.deepEqual(edits, ["approved", "unknown"]);
    assert.equal(cards.update("missing", "ignored"), false);
  });

  it("edits transitions while preserving delegation and separate outcomes", async () => {
    const cards = new StatusCards();
    const edits: string[] = [];
    cards.register("a", async (text) => { edits.push(text); });
    const dispatched: any[] = [];
    const service = new SessionNotificationService({ statusCards: cards,
      dispatchSessionNotification: (_s: unknown, r: unknown) => dispatched.push(r) } as any, () => {});
    const session = { id: "a", name: "A", route: { provider: "telegram", target: "fake" } } as any;
    service.dispatch(session, { label: "plan-approved", userMessage: "approved", notifyUser: "always" });
    service.dispatch(session, { label: "worktree-delegate", wakeMessage: "merge policy handoff", notifyUser: "never" });
    service.dispatch(session, { label: "failed", userMessage: "failure", notifyUser: "always" });
    service.dispatch(session, { label: "completed", userMessage: "terminal", notifyUser: "always" });
    await flush();
    assert.equal(edits.length, 2);
    assert.equal(dispatched[0].notifyUser, "never");
    assert.match(dispatched[1].wakeMessage, /merge policy handoff/);
    assert.equal(dispatched[2].notifyUser, "always");
    assert.equal(dispatched[3].userMessage, "terminal");
  });

  it("queues content-free held-work summaries and distinguishes admission from delivery", async () => {
    const original = opsDigestInternals.execFile;
    const calls: any[] = [];
    opsDigestInternals.execFile = ((...args: any[]) => { calls.push(args); args[3](null, "ops-digest: queued\n"); }) as any;
    try {
      assert.equal(await enqueueHeldWork("private-owner", "private-session"), "queued");
      assert.ok(!JSON.stringify(calls).includes("private-owner"));
      assert.ok(!JSON.stringify(calls).includes("private-session"));
    } finally { opsDigestInternals.execFile = original; }
  });
});

it("keeps decision context from calling stopped work active", async () => {
  const cards = new StatusCards();
  const edits: string[] = [];
  cards.register("stopped", async (text) => { edits.push(text); });
  const requests: any[] = [];
  const service = new SessionNotificationService({ statusCards: cards,
    dispatchSessionNotification: (_s: unknown, r: unknown) => requests.push(r) } as any, () => {});
  service.dispatch({ id: "stopped", name: "Stopped" } as any,
    { label: "decision-button-pressed", wakeMessage: "The user rejected the plan.", notifyUser: "never" });
  await flush();
  assert.deepEqual(edits, []);
  assert.match(requests[0].wakeMessage, /rejected/);
});

it("retains digest cleanup across cleared reminder fields and an uncertain removal", async () => {
  const { SessionReminderService } = await import("../src/session-reminder-service");
  const { normalizePersistedEntry } = await import("../src/session-store-normalization");
  const row: any = { sessionId: "resolved-digest", harnessSessionId: "resolved-thread", name: "resolved-digest",
    prompt: "p", workdir: "/tmp", status: "completed", createdAt: 1, completedAt: 2, costUsd: 0,
    lifecycle: "terminal", worktreeMerged: true, worktreeDigestKey: "a".repeat(64),
    route: { provider: "telegram", target: "synthetic" } };
  const restored = normalizePersistedEntry(row)!;
  assert.equal(restored.worktreeDigestKey, row.worktreeDigestKey);
  const reminders = new SessionReminderService(() => ({}) as any, () => assert.fail("resolved work cannot notify"),
    (_ref, patch) => { Object.assign(restored, patch); return true; }, async () => undefined);
  const original = opsDigestInternals.execFile;
  let healthy = false;
  let attempts = 0;
  opsDigestInternals.execFile = ((...args: any[]) => {
    attempts++;
    args[3](healthy ? null : new Error("unknown removal"), healthy ? "ops-digest: resolved\n" : "");
  }) as any;
  try {
    assert.equal(await reminders.getNextReminderAt(restored), 0);
    assert.equal(await reminders.clearResolvedReminderState(restored), false);
    assert.equal(restored.worktreeDigestKey, "a".repeat(64));
    assert.equal(await reminders.getNextReminderAt(restored), 0);
    healthy = true;
    assert.equal(await reminders.clearResolvedReminderState(restored), true);
    assert.equal(restored.worktreeDigestKey, undefined);
    assert.equal(await reminders.getNextReminderAt(restored), undefined);
    assert.equal(attempts, 2);
  } finally { opsDigestInternals.execFile = original; }
});

it("persists unknown queue admission as independent cleanup intent", async () => {
  const { SessionReminderService } = await import("../src/session-reminder-service");
  const now = Date.now();
  const row: any = { sessionId: "queue-intent", name: "queue-intent", status: "completed",
    lifecycle: "awaiting_worktree_decision", worktreeState: "pending_decision",
    pendingWorktreeDecisionSince: new Date(now - 4 * 3600_000).toISOString() };
  const reminders = new SessionReminderService(() => ({}) as any,
    () => assert.fail("unknown queue admission cannot fall back to a standalone message"),
    (_ref, patch) => { Object.assign(row, patch); return true; }, async () => undefined);
  const original = opsDigestInternals.execFile;
  opsDigestInternals.execFile = ((...args: any[]) => args[3](new Error("unknown queue ack"), "")) as any;
  try {
    assert.equal(await reminders.sendReminderIfDue(row, now), false);
    assert.match(row.worktreeDigestKey, /^[a-f0-9]{64}$/);
  } finally { opsDigestInternals.execFile = original; }
});

it("retains cleanup intent during persisted-session eviction", async () => {
  const { SessionStore } = await import("../src/session-store");
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const store = new SessionStore({ env: {}, indexPath: join(mkdtempSync(join(tmpdir(), "digest-journal-")), "sessions.json") });
  const row: any = { sessionId: "digest-retained", harnessSessionId: "digest-retained",
    name: "digest-retained", status: "completed", completedAt: 1, worktreeDigestKey: "b".repeat(64) };
  store.persisted.set(row.sessionId, row);
  assert.deepEqual(store.evictOldestPersisted(0), []);
  assert.equal(store.persisted.size, 1);
});

it("renders the synthetic Telegram UX review examples from production formatters", async () => {
  const { formatPlanApprovedLine } = await import("../src/actions/respond");
  const { buildPlanApprovalPromptContent } = await import("../src/plan-review-summary");
  const name = "notification-demo";
  const original = buildPlanApprovalPromptContent({ sessionName: name, actionableVersion: 1, hasButtons: true,
    preview: "Objective: Reduce duplicate acknowledgements.\nApproach: Edit the existing approval card.\nFiles: notification delivery.\nVerification: Focused regressions.\nExternal effects: No deployment.\nRollback: Revert the source change." });
  const approval = formatPlanApprovedLine(name);
  const cards = new StatusCards();
  const edits: string[] = [];
  cards.register("ux-demo", async (text) => { edits.push(text); });
  const requests: any[] = [];
  const service = new SessionNotificationService({ statusCards: cards,
    dispatchSessionNotification: (_s: unknown, r: unknown) => requests.push(r) } as any, () => {});
  const session = { id: "ux-demo", name } as any;
  service.dispatch(session, { label: "plan-approved", userMessage: approval, notifyUser: "always" });
  service.dispatch(session, { label: "decision-button-pressed", wakeMessage: "The user approved the plan.", notifyUser: "never" });
  service.dispatch(session, { label: "worktree-delegate", wakeMessage: "Continue delegated follow-through.", notifyUser: "never" });
  await flush();
  assert.deepEqual(edits, [approval, `[${name}] Worktree ready; delegated follow-through in progress.`]);
  assert.ok(requests.every((r) => r.notifyUser === "never"));
  console.log("OCA_UX_FIXTURE_JSON=" + JSON.stringify({ fixture: name, originalCards: original.userMessages,
    buttons: ["Approve", "Revise", "Reject"], beforeSeparateApprovalMessage: approval,
    afterApprovalCard: edits[0], afterDelegateCard: edits[1], separateAcknowledgementsAfter: 0 }));
});
