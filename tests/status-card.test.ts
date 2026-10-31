import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StatusCards, approvedPlanCard } from "../src/status-card";
import { SessionNotificationService } from "../src/session-notifications";
import { opsDigestInternals, enqueueHeldWork } from "../src/ops-digest";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const plan = "📋 [A] Plan v1 ready for approval\n\nImplement the reviewed plan.";
const approvedSession = { id: "a", name: "A", approvalState: "approved", pendingPlanApproval: false, planDecisionVersion: 2 } as any;
const approvalNow = new Date("2026-10-31T16:40:00Z");

describe("approved plan cards", () => {
  it("keeps the original plan and approval time, including Pacific winter time", async () => {
    const cards = new StatusCards(() => approvalNow);
    const edits: string[] = [];
    cards.register("a", async (text) => { edits.push(text); }, plan);
    assert.deepEqual(await Promise.all([cards.approve("a", 1), cards.approve("a", 1)]), [true, true]);
    assert.deepEqual(edits, [plan + "\n\n👍 Approved 09:40 PT"]);
    assert.match(approvedPlanCard(plan, new Date("2026-12-01T17:40:00Z")), /Approved 09:40 PT$/);
  });

  it("keeps an orchestrator's approval rationale beneath the timestamp", async () => {
    const cards = new StatusCards(() => approvalNow);
    const edits: string[] = [];
    cards.register("a", async (text) => { edits.push(text); }, plan);
    assert.equal(await cards.approve("a", 1, undefined, "👍 [A] Plan approved\nWhy: The checks cover this change."), true);
    assert.equal(edits[0], plan + "\n\n👍 Approved 09:40 PT\nWhy: The checks cover this change.");
  });

  it("trims a long plan body and preserves its header and complete footer", () => {
    const longPlan = plan + "😀".repeat(2500);
    const card = approvedPlanCard(longPlan, approvalNow);
    assert.ok(card.length <= 4096);
    assert.ok(card.startsWith(plan));
    assert.match(card, /…\n\n👍 Approved 09:40 PT$/);
    assert.equal(card.isWellFormed(), true);
  });

  for (const scenario of ["restart", "split plan", "missing message id", "orchestrator", "another chat", "failed edit", "held edit", "newer live plan", "unrelated decision"]) {
    it(`sends the existing standalone approval for ${scenario}`, async () => {
      const cards = new StatusCards();
      const edits: string[] = [];
      if (["failed edit", "held edit"].includes(scenario)) {
        cards.register("a", async (text) => { edits.push(text); throw new Error("edit unconfirmed"); }, plan);
        if (scenario === "held edit") assert.equal(await cards.approve("a", 1), false);
      } else if (scenario === "split plan") {
        cards.register("a", async () => assert.fail("split plan cannot be edited"), "📋 [A] Plan v1 ready for approval (2/2):\nplan");
      } else if (scenario === "newer live plan") {
        cards.register("a", async () => assert.fail("newer plan must keep its buttons"), plan.replace("v1", "v2"));
      } else if (scenario === "unrelated decision") {
        cards.register("a", async () => assert.fail("merge question must keep its buttons"), "Merge this branch?");
      }
      const requests: any[] = [];
      const service = new SessionNotificationService({ statusCards: cards,
        dispatchSessionNotification: (_s: unknown, r: unknown) => requests.push(r) } as any, () => {});
      service.dispatch(approvedSession, { label: "plan-approved", userMessage: "👍 [A] Plan approved", notifyUser: "always" });
      await flush();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].notifyUser, "always");
      assert.equal(requests[0].userMessage, "👍 [A] Plan approved");
      assert.equal(edits.length, ["failed edit", "held edit"].includes(scenario) ? 1 : 0);
    });
  }

  it("invalidates an old card when a replacement send has no usable identity", async () => {
    const { WakeDispatcher } = await import("../src/wake-dispatcher");
    const dispatcher = new WakeDispatcher({ directNotifications: { send: async () => {} } });
    dispatcher.statusCards.register("a", async () => assert.fail("an old card cannot acknowledge the replacement"), plan);
    await new Promise<void>((resolve) => dispatcher.dispatchSessionNotification({ id: "a", route: {
      provider: "telegram", target: "synthetic", sessionKey: "synthetic-owner" } } as any, {
      label: "plan-request", userMessage: plan.replace("v1", "v2"), notifyUser: "always",
      buttons: [[{ label: "Approve", callbackData: "synthetic-token" }]],
      hooks: { onNotifySucceeded: () => resolve() },
    }));
    assert.equal(await dispatcher.statusCards.approve("a", 1), false);
  });

  it("leaves the approved card untouched on delegate handoff and preserves outcomes", async () => {
    const cards = new StatusCards(() => approvalNow);
    const edits: string[] = [];
    cards.register("a", async (text) => { edits.push(text); }, plan);
    const requests: any[] = [];
    const service = new SessionNotificationService({ statusCards: cards,
      dispatchSessionNotification: (_s: unknown, r: unknown) => requests.push(r) } as any, () => {});
    service.dispatch(approvedSession, { label: "plan-approved", userMessage: "👍 [A] Plan approved", notifyUser: "always" });
    await flush();
    service.dispatch(approvedSession, { label: "worktree-delegate", wakeMessage: "merge policy handoff", notifyUser: "never" });
    service.dispatch(approvedSession, { label: "failed", userMessage: "failure", notifyUser: "always" });
    service.dispatch(approvedSession, { label: "completed", userMessage: "terminal", notifyUser: "always" });
    await flush();
    assert.deepEqual(edits, [plan + "\n\n👍 Approved 09:40 PT"]);
    assert.equal(requests[0].notifyUser, "never");
    assert.match(requests[1].wakeMessage, /merge policy handoff/);
    assert.equal(requests[2].userMessage, "failure");
    assert.equal(requests[3].userMessage, "terminal");
  });

  it("queues an identifiable weekly overview with a private identity key", async () => {
    const original = opsDigestInternals.execFile;
    const calls: any[] = [];
    opsDigestInternals.execFile = ((...args: any[]) => { calls.push(args); args[3](null, "ops-digest: queued\n"); }) as any;
    try {
      assert.equal(await enqueueHeldWork("private-owner", "session-id", false, undefined,
        { name: "notification-demo", branch: "agent/demo", age: "8 days" }), "queued");
      const args = calls[0][1];
      assert.ok(!JSON.stringify(calls).includes("private-owner"));
      assert.match(args[args.indexOf("--key") + 1], /^[a-f0-9]{64}$/);
      assert.equal(args[args.indexOf("--summary") + 1], "⏰ [notification-demo] Branch `agent/demo` still waits for your decision (8 days at queue time). Review /agent_status notification-demo.");
      assert.ok(args.includes("--weekly"));
    } finally { opsDigestInternals.execFile = original; }
  });

  it("keeps 3h and 24h reminders as messages even with a working digest helper", async () => {
    const { SessionReminderService } = await import("../src/session-reminder-service");
    const start = Date.parse("2026-10-20T00:00:00Z"), hour = 3600_000;
    const row: any = { sessionId: "held", name: "notification-demo", status: "completed",
      lifecycle: "awaiting_worktree_decision", worktreeState: "pending_decision", worktreeBranch: "agent/demo",
      pendingWorktreeDecisionSince: new Date(start).toISOString() };
    const messages: any[] = [], queued: any[] = [];
    const reminders = new SessionReminderService(() => ({}) as any,
      (_s, r) => { messages.push(r); r.hooks?.onNotifySucceeded?.(); },
      (_ref, patch) => { Object.assign(row, patch); return true; }, async () => undefined);
    const original = opsDigestInternals.execFile;
    opsDigestInternals.execFile = ((...args: any[]) => { queued.push(args[1]); args[3](null, "ops-digest: queued\n"); }) as any;
    try {
      assert.equal(await reminders.sendReminderIfDue(row, start + 3 * hour), true);
      assert.equal(await reminders.sendReminderIfDue(row, start + 6 * hour), false);
      assert.equal(await reminders.sendReminderIfDue(row, start + 27 * hour), true);
      assert.deepEqual(messages.map((r) => r.userMessage), [
        "⏰ [notification-demo] Branch `agent/demo` still waits for your decision (3h).",
        "⏰ [notification-demo] Branch `agent/demo` still waits for your decision (27h).",
      ]);
      assert.ok(messages.every((r) => r.notifyUser === "always" && r.requireDirectUserNotification));
      assert.deepEqual(queued, []);
      assert.equal(await reminders.sendReminderIfDue(row, start + (27 + 7 * 24) * hour), true);
      assert.equal(messages.length, 2);
      assert.match(queued[0][queued[0].indexOf("--summary") + 1], /notification-demo.*agent\/demo.*8 days.*agent_status notification-demo/);
      assert.equal(row.worktreeReminderCount, 3);
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
    worktreeReminderCount: 2, lastWorktreeReminderAt: new Date(now - 8 * 86400_000).toISOString(),
    pendingWorktreeDecisionSince: new Date(now - 10 * 86400_000).toISOString() };
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
  const cards = new StatusCards(() => approvalNow);
  const edits: string[] = [];
  cards.register("ux-demo", async (text) => { edits.push(text); }, original.userMessages[0]);
  const requests: any[] = [];
  const service = new SessionNotificationService({ statusCards: cards,
    dispatchSessionNotification: (_s: unknown, r: unknown) => requests.push(r) } as any, () => {});
  const session = { ...approvedSession, id: "ux-demo", name } as any;
  service.dispatch(session, { label: "plan-approved", userMessage: approval, notifyUser: "always" });
  service.dispatch(session, { label: "decision-button-pressed", wakeMessage: "The user approved the plan.", notifyUser: "never" });
  service.dispatch(session, { label: "worktree-delegate", wakeMessage: "Continue delegated follow-through.", notifyUser: "never" });
  await flush();
  assert.deepEqual(edits, [original.userMessages[0] + "\n\n👍 Approved 09:40 PT"]);
  assert.ok(requests.every((r) => r.notifyUser === "never"));
  console.log("OCA_UX_FIXTURE_JSON=" + JSON.stringify({ fixture: name, originalCards: original.userMessages,
    buttons: ["Approve", "Revise", "Reject"], beforeSeparateApprovalMessage: approval,
    afterApprovalCard: edits[0], afterDelegateCard: edits[0], separateAcknowledgementsAfter: 0 }));
});
