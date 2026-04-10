import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session";
import { registerHarness } from "../src/harness/index";
import { createFakeHarness, makeSessionConfig, tick } from "./helpers";
import type { FakeHarness } from "./helpers";
import type { AgentHarness, HarnessLaunchOptions, HarnessSession } from "../src/harness/types";
import { setPluginConfig } from "../src/config";

// ---------------------------------------------------------------------------
// Register fake harness once (before any tests)
// ---------------------------------------------------------------------------

let fakeHarness: FakeHarness;

before(() => {
  fakeHarness = createFakeHarness("test-harness", { initialPromptConsumptionPaused: true });
  registerHarness(fakeHarness);
});

/**
 * Helper: start a session, send init, wait for running, and return it.
 * The caller MUST call session.kill() when done to clean up timers.
 */
async function startSession(config: Partial<import("../src/types").SessionConfig> = {}): Promise<Session> {
  fakeHarness.setPromptConsumptionPaused(true);
  const session = new Session(makeSessionConfig({ harness: "test-harness", ...config }), "test");
  await session.start();
  fakeHarness.pushMessage({ type: "init", session_id: `sess-${session.id}` });
  await tick(50);
  return session;
}

// ---------------------------------------------------------------------------
// consumeMessages via fake harness
// ---------------------------------------------------------------------------

describe("Session consumeMessages — init message", () => {
  it("transitions to running and records harnessSessionId on init message", async () => {
    const session = new Session(makeSessionConfig({ harness: "test-harness" }), "test");
    await session.start();
    fakeHarness.pushMessage({ type: "init", session_id: "session-abc" });
    await tick(50);
    assert.equal(session.status, "running");
    assert.equal(session.harnessSessionId, "session-abc");
    session.kill("user"); // cleanup
  });
});

describe("Session consumeMessages — text message", () => {
  it("adds text to output buffer and emits output event", async () => {
    const session = await startSession();
    const outputs: string[] = [];
    session.on("output", (_s: any, text: string) => { outputs.push(text); });

    fakeHarness.pushMessage({ type: "text", text: "Hello world" });
    await tick(50);

    assert.deepEqual(session.getOutput().filter(l => l === "Hello world"), ["Hello world"]);
    assert.ok(outputs.includes("Hello world"));
    session.kill("user"); // cleanup
  });
});

describe("Session consumeMessages — tool_use message", () => {
  it("emits toolUse event", async () => {
    const session = await startSession();
    const toolUses: Array<{ name: string; input: any }> = [];
    session.on("toolUse", (_s: any, name: string, input: any) => {
      toolUses.push({ name, input });
    });

    fakeHarness.pushMessage({ type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } });
    await tick(50);

    assert.ok(toolUses.some(t => t.name === "Read"));
    session.kill("user"); // cleanup
  });

  it("sets pendingPlanApproval on ExitPlanMode tool", async () => {
    const session = await startSession();
    fakeHarness.pushMessage({ type: "tool_use", name: "ExitPlanMode", input: {} });
    await tick(50);

    assert.equal(session.pendingPlanApproval, true);
    session.kill("user"); // cleanup
  });

  it("sets lastTurnHadQuestion on AskUserQuestion tool", async () => {
    const session = await startSession({ multiTurn: true });
    const turnEndEvents: boolean[] = [];
    session.on("turnEnd", (_s: any, hadQuestion: boolean) => { turnEndEvents.push(hadQuestion); });

    fakeHarness.pushMessage({ type: "tool_use", name: "AskUserQuestion", input: {} });
    await tick(50);
    // Send a result to trigger turnEnd
    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 100, total_cost_usd: 0.01, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);

    assert.ok(turnEndEvents.includes(true), "turnEnd should fire with hadQuestion=true");
    session.kill("user"); // cleanup
  });

  it("keeps explicit worktree questions pending for user input", async () => {
    const session = await startSession({
      multiTurn: true,
      permissionMode: "default",
      worktreeStrategy: "ask",
    });

    fakeHarness.pushMessage({
      type: "tool_use",
      name: "AskUserQuestion",
      input: { text: "Would you like me to merge this branch or open a PR?" },
    });
    await tick(20);
    fakeHarness.setPromptConsumptionPaused(false);
    await tick(20);
    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 100, total_cost_usd: 0.01, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);

    assert.equal(session.status, "running");
    assert.equal(session.lifecycle, "awaiting_user_input");
    assert.equal(session.pendingPlanApproval, false);
    session.kill("user");
  });
});

describe("Session consumeMessages — result message (single-turn)", () => {
  it("transitions to completed on successful result in single-turn mode", async () => {
    const session = await startSession({ multiTurn: false });
    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 200, total_cost_usd: 0.05, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);

    assert.equal(session.status, "completed");
    assert.ok(session.completedAt);
    // No kill needed — completed already cleans up
  });

  it("transitions to failed on error result", async () => {
    const session = await startSession({ multiTurn: false });
    fakeHarness.pushMessage({
      type: "result",
      data: { success: false, duration_ms: 100, total_cost_usd: 0.01, num_turns: 1, session_id: session.harnessSessionId!, result: "error happened" },
    });
    await tick(50);

    assert.equal(session.status, "failed");
    // No kill needed — failed already cleans up
  });
});

describe("Session consumeMessages — result message (multi-turn)", () => {
  it("completes with done when no pending messages exist after successful turn", async () => {
    const session = await startSession({ multiTurn: true, permissionMode: "bypassPermissions" });
    const turnEndEvents: boolean[] = [];
    session.on("turnEnd", (_s: any, hadQuestion: boolean) => { turnEndEvents.push(hadQuestion); });

    fakeHarness.setPromptConsumptionPaused(false);
    await tick(50);

    fakeHarness.pushMessage({ type: "text", text: "did something" });
    await tick(50);
    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 100, total_cost_usd: 0.01, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);

    assert.ok(turnEndEvents.includes(false), "turnEnd should fire with hadQuestion=false");
    assert.equal(session.status, "completed", "session should complete with done reason after turn completes without needing input");
    assert.equal(session.killReason, "done");
  });

  it("stays running when a follow-up sendMessage() is queued during an active turn", async () => {
    const session = await startSession({ multiTurn: true, permissionMode: "bypassPermissions" });
    const turnEndEvents: boolean[] = [];
    session.on("turnEnd", (_s: any, hadQuestion: boolean) => { turnEndEvents.push(hadQuestion); });

    // Pause prompt consumption immediately so queued follow-ups stay pending.
    fakeHarness.setPromptConsumptionPaused(true);
    await session.sendMessage("follow-up while active");

    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 100, total_cost_usd: 0.01, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);

    assert.equal(session.status, "running", "session should remain running while queued messages are pending");
    assert.equal(session.killReason, "unknown");
    assert.equal(turnEndEvents.includes(false), false, "turnEnd(false) should not fire while pending queue exists");

    session.kill("user"); // cleanup
  });

  it("fires done-complete only after all queued follow-up messages are consumed", async () => {
    const session = await startSession({ multiTurn: true, permissionMode: "bypassPermissions" });

    fakeHarness.setPromptConsumptionPaused(true);
    await session.sendMessage("queued-1");
    await session.sendMessage("queued-2");
    await session.sendMessage("queued-3");

    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 100, total_cost_usd: 0.01, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);
    assert.equal(session.status, "running", "session should not kill while queued follow-ups remain");

    fakeHarness.setPromptConsumptionPaused(false);
    await tick(50);

    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 100, total_cost_usd: 0.01, num_turns: 2, session_id: session.harnessSessionId! },
    });
    await tick(50);

    assert.equal(session.status, "completed", "session should complete with done only after queued messages are drained");
    assert.equal(session.killReason, "done");
  });

  it("keeps the session running when a Codex-style interrupted turn completes after redirect", async () => {
    const session = await startSession({ multiTurn: true, permissionMode: "bypassPermissions" });
    const turnEndEvents: boolean[] = [];
    session.on("turnEnd", (_s: any, hadQuestion: boolean) => { turnEndEvents.push(hadQuestion); });

    fakeHarness.setPromptConsumptionPaused(true);
    await session.sendMessage("redirect target");

    fakeHarness.pushMessage({
      type: "result",
      data: {
        success: false,
        outcome: "interrupted",
        duration_ms: 100,
        total_cost_usd: 0.01,
        num_turns: 1,
        session_id: session.harnessSessionId!,
      },
    });
    await tick(50);

    assert.equal(session.status, "running");
    assert.equal(session.result?.subtype, "interrupted");
    assert.equal(session.result?.is_error, false);
    assert.equal(turnEndEvents.length, 0, "interrupted redirect should not emit turnEnd notifications");

    session.kill("user");
  });

  it("emits turnEnd(true) for user-question turns even when follow-up messages are queued", async () => {
    const session = await startSession({ multiTurn: true, permissionMode: "bypassPermissions" });
    const turnEndEvents: boolean[] = [];
    session.on("turnEnd", (_s: any, hadQuestion: boolean) => { turnEndEvents.push(hadQuestion); });

    fakeHarness.setPromptConsumptionPaused(true);
    await session.sendMessage("queued-follow-up");

    fakeHarness.pushMessage({ type: "tool_use", name: "AskUserQuestion", input: { question: "Proceed?" } });
    await tick(20);
    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 100, total_cost_usd: 0.01, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);

    assert.equal(session.status, "running", "session should stay running with queued follow-up");
    assert.ok(turnEndEvents.includes(true), "question turns should still signal waiting-for-input");

    session.kill("user");
  });

  it("emits turnEnd with hadQuestion=true in plan mode (plan approval fallback)", async () => {
    const session = await startSession({ multiTurn: true, permissionMode: "plan" });
    const turnEndEvents: boolean[] = [];
    session.on("turnEnd", (_s: any, hadQuestion: boolean) => { turnEndEvents.push(hadQuestion); });

    fakeHarness.pushMessage({ type: "text", text: "here is my plan" });
    await tick(50);
    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 100, total_cost_usd: 0.01, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);

    assert.ok(turnEndEvents.includes(true), "turnEnd should fire with hadQuestion=true in plan mode");
    assert.equal(session.pendingPlanApproval, true, "pendingPlanApproval should be set via fallback");
    assert.equal(session.status, "running", "session should stay running in multi-turn mode");
    session.kill("user"); // cleanup
  });

  it("records costUsd from result", async () => {
    const session = await startSession({ multiTurn: false });
    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 100, total_cost_usd: 1.23, num_turns: 3, session_id: session.harnessSessionId! },
    });
    await tick(50);

    assert.equal(session.costUsd, 1.23);
    // Completed — no kill needed
  });

  it("keeps session alive when heartbeat activity messages arrive during idle gaps", async () => {
    setPluginConfig({ idleTimeoutMinutes: 0.001, sessionGcAgeMinutes: 1440 });
    const session = await startSession({ multiTurn: true, permissionMode: "bypassPermissions" });

    for (let i = 0; i < 4; i++) {
      fakeHarness.pushMessage({ type: "activity" });
      await tick(30);
    }

    assert.equal(session.status, "running", "heartbeat should prevent idle timeout");
    await tick(90);
    assert.equal(session.status, "killed", "without heartbeat, idle timeout should trigger");
    assert.equal(session.killReason, "idle-timeout");

    setPluginConfig({ idleTimeoutMinutes: 15, sessionGcAgeMinutes: 1440 });
  });
});

// ---------------------------------------------------------------------------
// Output buffer overflow
// ---------------------------------------------------------------------------

describe("Session output buffer overflow", () => {
  it("caps output buffer at 2000 lines", async () => {
    const session = await startSession();

    for (let i = 0; i < 2010; i++) {
      fakeHarness.pushMessage({ type: "text", text: i === 2009 ? `line-${i}` : `line-${i}\n` });
    }
    await tick(200);

    const output = session.getOutput();
    assert.equal(output.length, 2000);
    // Oldest lines should be evicted — first entry should be line-10
    assert.equal(output[0], "line-10");
    assert.equal(output[1999], "line-2009");
    session.kill("user"); // cleanup
  });
});

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

describe("Session.sendMessage()", () => {
  it("throws when session is not running", async () => {
    const session = new Session(makeSessionConfig({ harness: "test-harness" }), "test");
    // Session is in "starting" state, hasn't received init
    await assert.rejects(
      () => session.sendMessage("hello"),
      /Session is not running/,
    );
    // No timers started — no cleanup needed
  });

  it("injects plan approval prefix when pendingModeSwitch is set", async () => {
    const session = await startSession({ multiTurn: true });
    const pushedMessages: any[] = [];

    // Capture messages pushed to the stream
    const origBuildUserMessage = fakeHarness.buildUserMessage;
    fakeHarness.buildUserMessage = (text: string, sessionId: string) => {
      pushedMessages.push({ text, sessionId });
      return origBuildUserMessage(text, sessionId);
    };

    session.switchPermissionMode("bypassPermissions");
    session.pendingPlanApproval = true;
    await session.sendMessage("Approved. Go ahead.");

    assert.ok(pushedMessages.length > 0, "message should be pushed");
    assert.ok(
      pushedMessages[0].text.includes("[SYSTEM: The user has approved your plan"),
      "should inject approval prefix",
    );
    assert.equal(session.pendingPlanApproval, false, "pendingPlanApproval should be cleared");

    // Restore + cleanup
    fakeHarness.buildUserMessage = origBuildUserMessage;
    session.kill("user");
  });

  it("injects revision prefix when pendingPlanApproval is true and no mode switch", async () => {
    const session = await startSession({ multiTurn: true });
    const pushedMessages: any[] = [];

    const origBuildUserMessage = fakeHarness.buildUserMessage;
    fakeHarness.buildUserMessage = (text: string, sessionId: string) => {
      pushedMessages.push({ text, sessionId });
      return origBuildUserMessage(text, sessionId);
    };

    session.pendingPlanApproval = true;
    await session.sendMessage("change the approach");

    assert.ok(pushedMessages.length > 0);
    assert.ok(
      pushedMessages[0].text.includes("[SYSTEM: The user wants changes"),
      "should inject revision prefix",
    );
    // pendingPlanApproval should remain true on the revision path
    assert.equal(session.pendingPlanApproval, true);

    fakeHarness.buildUserMessage = origBuildUserMessage;
    session.kill("user"); // cleanup
  });
});

// ---------------------------------------------------------------------------
// switchPermissionMode
// ---------------------------------------------------------------------------

describe("Session.switchPermissionMode()", () => {
  it("stores mode in pendingModeSwitch", () => {
    const session = new Session(makeSessionConfig({ harness: "test-harness" }), "test");
    session.switchPermissionMode("bypassPermissions");
    assert.equal((session as any).pendingModeSwitch, "bypassPermissions");
    // No start() called — no cleanup needed
  });

  it("next sendMessage attempts the permission switch via harness", async () => {
    const session = await startSession({ multiTurn: true });

    fakeHarness.lastSetPermissionMode = undefined;
    session.switchPermissionMode("bypassPermissions");
    await session.sendMessage("go");
    await tick(50);

    assert.equal(fakeHarness.lastSetPermissionMode, "bypassPermissions");
    assert.equal(session.currentPermissionMode, "bypassPermissions");
    session.kill("user"); // cleanup
  });

  it("throws and preserves pending plan approval when permission switch fails", async () => {
    const session = await startSession({ multiTurn: true });
    session.switchPermissionMode("bypassPermissions");
    session.pendingPlanApproval = true;

    const harnessHandle = (session as any).harnessHandle as { setPermissionMode?: (mode: string) => Promise<void> };
    harnessHandle.setPermissionMode = async () => {
      throw new Error("mode switch failed");
    };

    await assert.rejects(
      () => session.sendMessage("Approved. Go ahead."),
      /Failed to switch permission mode to bypassPermissions: mode switch failed/,
    );
    assert.equal(session.pendingPlanApproval, true, "approval state should remain pending on failed mode switch");
    assert.equal((session as any).pendingModeSwitch, "bypassPermissions", "mode switch should remain queued for retry");
    session.kill("user"); // cleanup
  });
});

// ---------------------------------------------------------------------------
// autoRespond counter
// ---------------------------------------------------------------------------

describe("Session autoRespond counter", () => {
  it("starts at zero", () => {
    const session = new Session(makeSessionConfig({ harness: "test-harness" }), "test");
    assert.equal(session.autoRespondCount, 0);
  });

  it("incrementAutoRespond increases counter", () => {
    const session = new Session(makeSessionConfig({ harness: "test-harness" }), "test");
    session.incrementAutoRespond();
    session.incrementAutoRespond();
    assert.equal(session.autoRespondCount, 2);
  });

  it("resetAutoRespond sets counter to zero", () => {
    const session = new Session(makeSessionConfig({ harness: "test-harness" }), "test");
    session.incrementAutoRespond();
    session.incrementAutoRespond();
    session.incrementAutoRespond();
    session.resetAutoRespond();
    assert.equal(session.autoRespondCount, 0);
  });
});

// ---------------------------------------------------------------------------
// kill / complete teardown
// ---------------------------------------------------------------------------

describe("Session.kill() teardown", () => {
  it("sets completedAt", async () => {
    const session = await startSession();
    session.kill("user");
    assert.ok(session.completedAt, "completedAt should be set");
    assert.equal(session.status, "killed");
  });

  it("aborts the abort controller", async () => {
    const session = await startSession();
    assert.equal((session as any).abortController.signal.aborted, false);
    session.kill("user");
    assert.equal((session as any).abortController.signal.aborted, true);
  });

  it("clears all timers", async () => {
    const session = await startSession();
    session.kill("user");
    assert.equal((session as any).timers.size, 0, "all timers should be cleared after teardown");
  });

  it("does not fail terminal transition when harness interrupt rejects", async () => {
    const rejectingHarness: AgentHarness = {
      name: "test-harness-reject-interrupt",
      backendKind: "claude-code",
      supportedPermissionModes: ["default", "plan", "bypassPermissions"],
      capabilities: {
        nativePendingInput: false,
        nativePlanArtifacts: false,
        worktrees: "plugin-managed",
      },
      launch(_options: HarnessLaunchOptions): HarnessSession {
        async function* messages() {
          yield {
            type: "backend_ref",
            ref: {
              kind: "claude-code",
              conversationId: "reject-int-1",
            },
          } as const;
        }
        return {
          messages: messages(),
          async interrupt(): Promise<void> {
            throw new Error("interrupt failed");
          },
        };
      },
      buildUserMessage(text: string, sessionId: string): unknown {
        return { type: "user", text, session_id: sessionId };
      },
    };
    registerHarness(rejectingHarness);

    const session = new Session(makeSessionConfig({ harness: rejectingHarness.name }), "reject-int-session");
    await session.start();
    await tick(20);

    const warn = console.warn;
    try {
      console.warn = () => {};
      session.kill("user");
      await tick(20);
    } finally {
      console.warn = warn;
    }
    assert.equal(session.status, "killed");
    assert.equal(session.killReason, "user");
  });
});

describe("Session.complete() teardown", () => {
  it("sets completedAt and transitions to completed", async () => {
    const session = await startSession();
    session.complete("done");
    assert.ok(session.completedAt);
    assert.equal(session.status, "completed");
    assert.equal(session.killReason, "done");
  });
});

// ---------------------------------------------------------------------------
// interrupt
// ---------------------------------------------------------------------------

describe("Session.interrupt()", () => {
  it("calls interrupt on the harness handle", async () => {
    const session = await startSession();
    fakeHarness.interruptCalled = false;
    await session.interrupt();
    assert.ok(fakeHarness.interruptCalled, "interrupt should be called on harness handle");
    session.kill("user"); // cleanup
  });
});

// ---------------------------------------------------------------------------
// result records session data
// ---------------------------------------------------------------------------

describe("Session result recording", () => {
  it("records result data from result message", async () => {
    const session = await startSession({ multiTurn: false });
    fakeHarness.pushMessage({
      type: "result",
      data: {
        success: true,
        duration_ms: 5000,
        total_cost_usd: 0.42,
        num_turns: 3,
        result: "all done",
        session_id: session.harnessSessionId!,
      },
    });
    await tick(50);

    assert.ok(session.result);
    assert.equal(session.result!.subtype, "success");
    assert.equal(session.result!.duration_ms, 5000);
    assert.equal(session.result!.total_cost_usd, 0.42);
    assert.equal(session.result!.num_turns, 3);
    assert.equal(session.result!.result, "all done");
    assert.equal(session.result!.session_id, session.harnessSessionId);
    assert.equal(session.result!.is_error, false);
    // Completed — no kill needed
  });
});
