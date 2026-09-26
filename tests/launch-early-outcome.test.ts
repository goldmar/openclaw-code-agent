import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { awaitLaunchEarlyOutcome } from "../src/tools/launch-early-outcome";

function fakeSession() {
  const emitter = new EventEmitter();
  const seen: string[] = [];
  const session = Object.assign(emitter, {
    id: "s1",
    name: "ux-fail",
    status: "running" as string,
    error: undefined as string | undefined,
    getOutput: () => ["There's an issue with the selected model."],
    noteOutcomeSeen: (reader: string) => { seen.push(reader); return true; },
  });
  return { session, seen };
}

describe("agent_launch early outcome", () => {
  it("reports a failure right after launch in the launch result and records it as read by the launching session", async () => {
    const { session, seen } = fakeSession();
    setTimeout(() => {
      session.status = "failed";
      session.error = "model_not_found";
      session.emit("statusChange", session, "failed");
    }, 20);
    const text = await awaitLaunchEarlyOutcome(session as any, "agent:main:telegram:direct:1", 2_000);
    assert.match(text ?? "", /\[ux-fail\] failed right after launch \(the user already sees the ❌ Failed notice\)\. Tell the user the cause/);
    assert.match(text ?? "", /model_not_found/);
    assert.deepEqual(seen, ["agent:main:telegram:direct:1"]);
  });

  it("leaves the deferred wake in place when there is no originating session key", async () => {
    const { session, seen } = fakeSession();
    session.status = "failed";
    session.error = "model_not_found";
    assert.equal(await awaitLaunchEarlyOutcome(session as any, undefined, 0), undefined);
    assert.deepEqual(seen, []);
  });

  it("leaves the deferred wake in place when the reader does not own the outcome", async () => {
    const { session, seen } = fakeSession();
    session.status = "completed";
    session.noteOutcomeSeen = (reader: string) => { seen.push(reader); return false; };
    assert.equal(await awaitLaunchEarlyOutcome(session as any, "another-session", 0), undefined);
    assert.deepEqual(seen, ["another-session"]);
  });

  it("returns at once when the agent starts working, and adds nothing", async () => {
    const { session, seen } = fakeSession();
    const started = Date.now();
    setTimeout(() => session.emit("toolUse", session), 20);
    assert.equal(await awaitLaunchEarlyOutcome(session as any, "k", 2_000), undefined);
    assert.ok(Date.now() - started < 1_000);
    assert.deepEqual(seen, []);
  });

  it("gives up after the wait while the session is still running", async () => {
    const { session } = fakeSession();
    assert.equal(await awaitLaunchEarlyOutcome(session as any, "k", 30), undefined);
    assert.equal(session.listenerCount("statusChange"), 0, "listeners are removed");
  });
});
