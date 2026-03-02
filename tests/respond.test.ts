import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/session-manager";
import { setPluginConfig } from "../src/config";
import { createStubSession } from "./helpers";

import { executeRespond } from "../src/actions/respond";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStubSessionManager(sessions: Record<string, any> = {}): SessionManager {
  const sm = new SessionManager(5);
  for (const [id, session] of Object.entries(sessions)) {
    (sm as any).sessions.set(id, session);
  }
  // Stub deliverToTelegram to avoid needing notifications
  (sm as any).deliverToTelegram = () => {};
  return sm;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  setPluginConfig({});
});

describe("executeRespond — session not found", () => {
  it("returns error when session does not exist", async () => {
    const sm = createStubSessionManager();
    const result = await executeRespond(sm, { session: "nope", message: "hello" });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("not found"));
  });
});

describe("executeRespond — auto-resume", () => {
  it("auto-resumes a killed session with post-turn-idle reason", async () => {
    let spawnCalled = false;
    const session = createStubSession({
      status: "killed",
      killReason: "post-turn-idle",
      harnessSessionId: "harness-123",
      name: "old-session",
    });
    const sm = createStubSessionManager({ "test-id": session });
    // Override spawn to track the call and return a fake resumed session
    sm.spawn = (config: any) => {
      spawnCalled = true;
      assert.equal(config.resumeSessionId, "harness-123");
      assert.equal(config.multiTurn, true);
      return createStubSession({ name: "old-session", id: "new-id" });
    };
    const result = await executeRespond(sm, { session: "test-id", message: "continue" });
    assert.ok(spawnCalled, "spawn should have been called");
    assert.ok(result.text.includes("Auto-resumed"));
    assert.ok(result.text.includes("idle-kill"));
  });

  it("auto-resumes a completed session with done reason", async () => {
    const session = createStubSession({
      status: "completed",
      killReason: "done",
      harnessSessionId: "harness-456",
    });
    const sm = createStubSessionManager({ "test-id": session });
    sm.spawn = () => createStubSession({ name: "resumed", id: "new-id" });
    const result = await executeRespond(sm, { session: "test-id", message: "more work" });
    assert.ok(result.text.includes("Auto-resumed"));
    assert.ok(result.text.includes("completed"));
  });

  it("auto-resumes a failed session regardless of killReason", async () => {
    const session = createStubSession({
      status: "failed",
      killReason: "unknown",
      harnessSessionId: "harness-789",
    });
    const sm = createStubSessionManager({ "test-id": session });
    sm.spawn = () => createStubSession({ name: "resumed", id: "new-id" });
    const result = await executeRespond(sm, { session: "test-id", message: "retry" });
    assert.ok(result.text.includes("Auto-resumed"));
    assert.ok(result.text.includes("failed"));
  });

  it("does NOT auto-resume a killed session with user reason", async () => {
    const session = createStubSession({
      status: "killed",
      killReason: "user",
      harnessSessionId: "harness-111",
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "hello" });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("not running"));
  });

  it("does NOT auto-resume when harnessSessionId is missing", async () => {
    const session = createStubSession({
      status: "killed",
      killReason: "post-turn-idle",
      harnessSessionId: undefined,
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "hello" });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("not running"));
  });

  it("returns error when auto-resume spawn throws", async () => {
    const session = createStubSession({
      status: "killed",
      killReason: "post-turn-idle",
      harnessSessionId: "harness-err",
    });
    const sm = createStubSessionManager({ "test-id": session });
    sm.spawn = () => { throw new Error("spawn failed"); };
    const result = await executeRespond(sm, { session: "test-id", message: "continue" });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("Error auto-resuming"));
    assert.ok(result.text.includes("spawn failed"));
  });

  it("auto-resumes a killed session with idle-timeout reason", async () => {
    const session = createStubSession({
      status: "killed",
      killReason: "idle-timeout",
      harnessSessionId: "harness-idle",
    });
    const sm = createStubSessionManager({ "test-id": session });
    sm.spawn = () => createStubSession({ name: "resumed", id: "new-id" });
    const result = await executeRespond(sm, { session: "test-id", message: "wake up" });
    assert.ok(result.text.includes("Auto-resumed"));
    assert.ok(result.text.includes("idle-kill"));
  });
});

describe("executeRespond — non-running session", () => {
  it("returns error for starting session without auto-resume", async () => {
    const session = createStubSession({ status: "starting" });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "hello" });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("not running"));
    assert.ok(result.text.includes("starting"));
  });
});

describe("executeRespond — auto-respond safety cap", () => {
  it("resets autoRespondCount when userInitiated is true", async () => {
    const session = createStubSession({ autoRespondCount: 5 });
    const sm = createStubSessionManager({ "test-id": session });
    await executeRespond(sm, { session: "test-id", message: "hello", userInitiated: true });
    assert.equal(session.autoRespondCount, 0);
  });

  it("increments autoRespondCount when userInitiated is false", async () => {
    const session = createStubSession({ autoRespondCount: 0 });
    const sm = createStubSessionManager({ "test-id": session });
    await executeRespond(sm, { session: "test-id", message: "hello" });
    assert.equal(session.autoRespondCount, 1);
  });

  it("blocks when autoRespondCount >= maxAutoResponds and userInitiated is false", async () => {
    setPluginConfig({ maxAutoResponds: 3 });
    const session = createStubSession({ autoRespondCount: 3 });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "hello" });
    assert.ok(result.text.includes("Auto-respond limit reached"));
    assert.ok(result.text.includes("3/3"));
  });

  it("allows message when userInitiated resets counter past limit", async () => {
    setPluginConfig({ maxAutoResponds: 3 });
    const session = createStubSession({ autoRespondCount: 5 });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "hello", userInitiated: true });
    assert.ok(!result.isError, "should not be an error");
    assert.ok(result.text.includes("Message sent"));
  });
});

describe("executeRespond — plan approval", () => {
  it("calls switchPermissionMode when approve=true and pendingPlanApproval=true with simple message", async () => {
    let modeSwitched: string | undefined;
    const session = createStubSession({
      pendingPlanApproval: true,
      switchPermissionMode(mode: string) { modeSwitched = mode; },
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "Go ahead", approve: true });
    assert.equal(modeSwitched, "bypassPermissions");
    assert.ok(result.text.includes("Message sent"));
  });

  it("rejects approve+revise when message contains revision keywords", async () => {
    const session = createStubSession({ pendingPlanApproval: true });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, {
      session: "test-id",
      message: "change the database schema",
      approve: true,
    });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("Cannot approve and revise"));
  });

  it("rejects approve+revise when message is long (>= 100 chars)", async () => {
    const session = createStubSession({ pendingPlanApproval: true });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, {
      session: "test-id",
      message: "A".repeat(100),
      approve: true,
    });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("Cannot approve and revise"));
  });

  it("adds approval warning when approve=true but no pending plan", async () => {
    const session = createStubSession({ pendingPlanApproval: false });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Go ahead",
      approve: true,
    });
    assert.ok(result.text.includes("approve=true was set but"));
  });

  it("adds info note when pendingPlanApproval=true but approve not set", async () => {
    const session = createStubSession({ pendingPlanApproval: true });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "feedback here" });
    assert.ok(result.text.includes("sending as revision feedback"));
  });

  it("detects revision keywords case-insensitively", async () => {
    const session = createStubSession({ pendingPlanApproval: true });
    const sm = createStubSessionManager({ "test-id": session });

    for (const msg of ["REPLACE the header", "Don't do X", "Update layout"]) {
      const result = await executeRespond(sm, {
        session: "test-id",
        message: msg,
        approve: true,
      });
      assert.equal(result.isError, true, `Should reject: "${msg}"`);
    }
  });

  it("allows short approval without revision keywords", async () => {
    let modeSwitched = false;
    const session = createStubSession({
      pendingPlanApproval: true,
      switchPermissionMode() { modeSwitched = true; },
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, {
      session: "test-id",
      message: "Looks good, proceed!",
      approve: true,
    });
    assert.ok(modeSwitched, "should have switched mode");
    assert.ok(!result.isError, "should succeed");
  });
});

describe("executeRespond — Lobster token handling", () => {
  it("consumes token and returns early on approval", async () => {
    let resumedToken: string | undefined;
    let resumedApprove: boolean | undefined;
    const session = createStubSession({
      pendingPlanApproval: true,
      lobsterResumeToken: "tok-123",
    });
    const sm = createStubSessionManager({ "test-id": session });
    (sm as any).resumeLobsterApproval = async (token: string, approve: boolean) => {
      resumedToken = token;
      resumedApprove = approve;
    };
    const result = await executeRespond(sm, { session: "test-id", message: "Go ahead", approve: true });
    assert.equal(resumedToken, "tok-123");
    assert.equal(resumedApprove, true);
    assert.equal(session.lobsterResumeToken, undefined, "token should be consumed");
    assert.ok(result.text.includes("Lobster workflow resuming"));
  });

  it("consumes token, cancels Lobster, and falls through on rejection", async () => {
    let cancelledToken: string | undefined;
    let cancelledApprove: boolean | undefined;
    let messageSent: string | undefined;
    const session = createStubSession({
      pendingPlanApproval: true,
      lobsterResumeToken: "tok-456",
      sendMessage: async (text: string) => { messageSent = text; },
    });
    const sm = createStubSessionManager({ "test-id": session });
    (sm as any).resumeLobsterApproval = async (token: string, approve: boolean) => {
      cancelledToken = token;
      cancelledApprove = approve;
    };
    const result = await executeRespond(sm, { session: "test-id", message: "Add error handling" });
    assert.equal(cancelledToken, "tok-456");
    assert.equal(cancelledApprove, false);
    assert.equal(session.lobsterResumeToken, undefined, "token should be consumed");
    // Should fall through to normal handling (message sent)
    assert.ok(messageSent !== undefined, "message should be sent via normal flow");
    assert.ok(result.text.includes("Message sent"));
  });

  it("no token — normal flow (re-entry prevention)", async () => {
    let modeSwitched: string | undefined;
    const session = createStubSession({
      pendingPlanApproval: true,
      lobsterResumeToken: undefined,
      switchPermissionMode(mode: string) { modeSwitched = mode; },
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "Approved. Go ahead.", approve: true });
    // Without token, should go through normal approval path
    assert.equal(modeSwitched, "bypassPermissions");
    assert.ok(result.text.includes("Message sent"));
  });

  it("falls back to direct mode switch when Lobster resume fails", async () => {
    let modeSwitched: string | undefined;
    let messageSent: string | undefined;
    const session = createStubSession({
      pendingPlanApproval: true,
      lobsterResumeToken: "tok-fail",
      switchPermissionMode(mode: string) { modeSwitched = mode; },
      sendMessage: async (text: string) => { messageSent = text; },
    });
    const sm = createStubSessionManager({ "test-id": session });
    (sm as any).resumeLobsterApproval = async () => {
      throw new Error("Lobster unavailable");
    };
    const result = await executeRespond(sm, { session: "test-id", message: "Go ahead", approve: true });
    // Returns early with Lobster message (fallback is async)
    assert.ok(result.text.includes("Lobster workflow resuming"));
    assert.equal(session.lobsterResumeToken, undefined, "token should be consumed");
    // Wait for the async fallback to execute
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(modeSwitched, "bypassPermissions", "fallback should switch mode");
  });
});

describe("executeRespond — interrupt", () => {
  it("calls session.interrupt() when interrupt=true", async () => {
    let interrupted = false;
    const session = createStubSession({
      interrupt: async () => { interrupted = true; },
    });
    const sm = createStubSessionManager({ "test-id": session });
    await executeRespond(sm, { session: "test-id", message: "stop", interrupt: true });
    assert.ok(interrupted, "interrupt should have been called");
  });

  it("does not call interrupt when interrupt is false", async () => {
    let interrupted = false;
    const session = createStubSession({
      interrupt: async () => { interrupted = true; },
    });
    const sm = createStubSessionManager({ "test-id": session });
    await executeRespond(sm, { session: "test-id", message: "hello", interrupt: false });
    assert.ok(!interrupted, "interrupt should not have been called");
  });
});

describe("executeRespond — error handling", () => {
  it("returns error when sendMessage throws", async () => {
    const session = createStubSession({
      sendMessage: async () => { throw new Error("send failed"); },
    });
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "hello" });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("Error sending message"));
    assert.ok(result.text.includes("send failed"));
  });

  it("returns success text with message summary after successful send", async () => {
    const session = createStubSession();
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "do something important" });
    assert.ok(!result.isError);
    assert.ok(result.text.includes("Message sent"));
    assert.ok(result.text.includes("do something important"));
  });
});

describe("executeRespond — message formatting", () => {
  it("truncates message summary to 80 chars", async () => {
    const longMessage = "x".repeat(200);
    const session = createStubSession();
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: longMessage });
    // The message in the response should be truncated (80 chars + ...)
    assert.ok(result.text.includes("..."));
  });

  it("includes interrupt indicator in response text", async () => {
    const session = createStubSession();
    const sm = createStubSessionManager({ "test-id": session });
    const result = await executeRespond(sm, { session: "test-id", message: "stop", interrupt: true });
    assert.ok(result.text.includes("interrupted"));
  });
});

describe("executeRespond — resolve by name", () => {
  it("resolves session by name via sm.resolve()", async () => {
    const session = createStubSession({ name: "my-session", id: "abc" });
    const sm = createStubSessionManager({ abc: session });
    const result = await executeRespond(sm, { session: "my-session", message: "hello" });
    assert.ok(result.text.includes("Message sent"));
    assert.ok(result.text.includes("my-session"));
  });
});
