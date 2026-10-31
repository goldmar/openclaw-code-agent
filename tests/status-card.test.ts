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
