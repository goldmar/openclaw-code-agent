import "./test-env";
/**
 * End-to-end plan mode test — reproduces the bug where
 * agent_respond(approve=true) returns "session has no pending plan approval"
 * even though the session shows phase = "awaiting-plan-approval".
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session";
import { registerHarness } from "../src/harness/index";
import { createFakeHarness, makeSessionConfig, tick } from "./helpers";
import { executeRespond } from "../src/actions/respond";
import { SessionManager } from "../src/session-manager";
import { setPluginConfig } from "../src/config";
import type { FakeHarness } from "./helpers";

let fakeHarness: FakeHarness;

before(() => {
  fakeHarness = createFakeHarness("plan-e2e-harness", { nativePlanDecisions: true });
  registerHarness(fakeHarness);
  setPluginConfig({});
});

async function startSession(config: Partial<import("../src/types").SessionConfig> = {}): Promise<Session> {
  const session = new Session(makeSessionConfig({ harness: "plan-e2e-harness", ...config }), "plan-test");
  await session.start();
  fakeHarness.pushMessage({ type: "init", session_id: `sess-${session.id}` });
  await tick(50);
  return session;
}

/** Simulate Claude's ExitPlanMode being held in canUseTool as a native plan request. */
async function raiseNativePlanRequest(markdown = "1. Change the function\n2. Add tests"): Promise<void> {
  fakeHarness.nativePlanRequestPending = true;
  fakeHarness.pushMessage({
    type: "plan_approval_requested",
    request: { requestId: `plan-${Date.now()}`, artifact: { steps: [], markdown } },
  });
  await tick(20);
}

function createStubSessionManager(sessions: Record<string, any> = {}): SessionManager {
  const sm = new SessionManager(5);
  for (const [id, session] of Object.entries(sessions)) {
    (sm as any).sessions.set(id, session);
  }
  (sm as any).notifySession = () => {};
  return sm;
}

// ---------------------------------------------------------------------------
// Test: Full plan mode flow — ExitPlanMode → pendingPlanApproval → approve
// ---------------------------------------------------------------------------

describe("Plan mode E2E: ExitPlanMode flow", () => {
  it("plan flow: ExitPlanMode sets pendingPlanApproval, which is readable for approve", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    assert.equal(session.currentPermissionMode, "plan");
    assert.equal(session.pendingPlanApproval, false);
    assert.equal(session.phase, "active");

    // Simulate Claude presenting the plan with text
    fakeHarness.pushMessage({ type: "text", text: "Here is my plan..." });
    await tick(20);

    // Simulate Claude calling ExitPlanMode (held open in canUseTool)
    await raiseNativePlanRequest();

    assert.equal(session.pendingPlanApproval, true, "pendingPlanApproval should be true after ExitPlanMode");
    assert.equal(session.phase, "awaiting_plan_decision");
    assert.equal(session.status, "running");

    // Now simulate agent_respond(approve=true) through executeRespond
    const sm = createStubSessionManager({ [session.id]: session });
    const result = await executeRespond(sm, {
      session: session.id,
      message: "Approved. Go ahead.",
      approve: true,
    });

    assert.ok(!result.isError, `Should not be an error, got: ${result.text}`);
    assert.ok(!result.text.includes("no pending plan approval"), `Should not say no pending plan: ${result.text}`);
    assert.ok(result.text.includes("Plan approved for session"), `Should confirm plan approval: ${result.text}`);
    assert.deepEqual(fakeHarness.planDecisions.at(-1), { kind: "approve", permissionMode: "bypassPermissions" });

    session.kill("user"); // cleanup
  });

  it("plan flow: text messages do NOT reset pendingPlanApproval", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    // Set pendingPlanApproval via ExitPlanMode
    await raiseNativePlanRequest();
    assert.equal(session.pendingPlanApproval, true);

    // Send a text message — should NOT reset pendingPlanApproval
    fakeHarness.pushMessage({ type: "text", text: "Some additional text after plan" });
    await tick(20);
    assert.equal(session.pendingPlanApproval, true, "text should not reset pendingPlanApproval");

    session.kill("user");
  });

  it("plan flow: result in plan mode sets pendingPlanApproval via fallback (no ExitPlanMode)", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    // Don't send ExitPlanMode — just send text and result
    fakeHarness.pushMessage({ type: "text", text: "Here is my plan..." });
    await tick(20);

    assert.equal(session.pendingPlanApproval, false, "no plan approval yet");

    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 5000, total_cost_usd: 0.1, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);

    // The fallback should set pendingPlanApproval
    assert.equal(session.pendingPlanApproval, true, "fallback should set pendingPlanApproval on result in plan mode");
    assert.equal(session.phase, "awaiting_plan_decision");

    session.kill("user");
  });

  it("plan flow: approve clears pendingPlanApproval and switches mode", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    // Set up plan approval state
    await raiseNativePlanRequest();
    assert.equal(session.pendingPlanApproval, true);

    // Trigger approve flow
    session.switchPermissionMode("bypassPermissions");
    await session.sendMessage("Approved. Go ahead.");

    assert.equal(session.pendingPlanApproval, false, "pendingPlanApproval should be cleared after approval");
    assert.equal(session.currentPermissionMode, "bypassPermissions", "mode should switch to bypassPermissions");
    assert.deepEqual(fakeHarness.planDecisions.at(-1), { kind: "approve", permissionMode: "bypassPermissions" });

    session.kill("user");
  });

  it("plan flow: a native harness without setPermissionMode gets the plain approval text", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });
    await raiseNativePlanRequest();
    // The native plan request is gone (for example the backend dropped it) and the
    // handle cannot switch modes: approval falls through to a plain follow-up message.
    fakeHarness.nativePlanRequestPending = false;
    (session as any).harnessHandle.setPermissionMode = undefined;

    session.switchPermissionMode("bypassPermissions");
    await session.sendMessage("Approved. Go ahead.");
    await tick(20);

    assert.equal(session.pendingPlanApproval, false);
    const sent = fakeHarness.consumedPrompts.at(-1) as { text?: string } | undefined;
    assert.equal(sent?.text, "Approved. Go ahead.");
    assert.doesNotMatch(sent?.text ?? "", /\[SYSTEM:/);

    session.kill("user");
  });

  it("plan flow: revision feedback keeps pendingPlanApproval true", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    // Set up plan approval state
    await raiseNativePlanRequest();
    assert.equal(session.pendingPlanApproval, true);

    // Send revision (no mode switch)
    await session.sendMessage("Please change the approach to X");

    assert.equal(session.pendingPlanApproval, true, "pendingPlanApproval should remain true for revisions");
    assert.equal(session.currentPermissionMode, "plan", "mode should stay plan for revisions");
    assert.deepEqual(fakeHarness.planDecisions.at(-1), { kind: "revise", feedback: "Please change the approach to X" });

    session.kill("user");
  });

  it("plan flow: ignores late plan-approval signals after approval", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    await raiseNativePlanRequest();

    session.switchPermissionMode("bypassPermissions");
    await session.sendMessage("Approved. Go ahead.");
    assert.equal(session.pendingPlanApproval, false);
    assert.equal(session.currentPermissionMode, "bypassPermissions");

    await raiseNativePlanRequest();

    assert.equal(session.pendingPlanApproval, false, "late plan signals should be ignored after approval");
    assert.equal(session.currentPermissionMode, "bypassPermissions");

    session.kill("user");
  });
});

// ---------------------------------------------------------------------------
// Test: permission_mode_change event flow
// ---------------------------------------------------------------------------

describe("Plan mode E2E: permission_mode_change flow", () => {
  it("permission_mode_change from plan→default sets pendingPlanApproval", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    fakeHarness.pushMessage({ type: "permission_mode_change", mode: "default" });
    await tick(20);

    assert.equal(session.pendingPlanApproval, true);
    assert.equal(session.currentPermissionMode, "default");

    session.kill("user");
  });
});

// ---------------------------------------------------------------------------
// Test: approve=true forwarded through tryAutoResume to dead plan-mode session
// ---------------------------------------------------------------------------

describe("Plan mode E2E: approve=true on idle-killed plan session (double-approval bug)", () => {
  it("tryAutoResume forwards approve=true as bypassPermissions + approval message when session was in plan mode", async () => {
    // Simulate a dead session that was in awaiting-plan-approval when killed.
    const deadPersistedSession = {
      sessionId: "dead-id",
      harnessSessionId: "harness-dead-123",
      backendRef: { kind: "claude-code" as const, conversationId: "harness-dead-123" },
      name: "plan-merge-robustness",
      prompt: "Write a plan for X",
      workdir: "/tmp",
      status: "killed" as const,
      lifecycle: "suspended" as const,
      resumable: true,
      killReason: "idle-timeout" as const,
      currentPermissionMode: "plan" as const,
      costUsd: 0.05,
      harness: "plan-e2e-harness",
    };

    let capturedResumeConfig: import("../src/types").SessionConfig | undefined;

    // Build a stub SessionManager that:
    //  - resolve() returns null (session is dead)
    //  - getPersistedSession() returns the dead session
    //  - launchAndAwaitRunning() captures the config and returns a fake running session
    const sm = {
      resolve: (_ref: string) => null,
      getPersistedSession: (_ref: string) => deadPersistedSession,
      notifySession: () => {},
      launchAndAwaitRunning: async (config: import("../src/types").SessionConfig) => {
        capturedResumeConfig = config;
        return {
          id: "new-session-id",
          name: "plan-merge-robustness",
          status: "running",
        };
      },
    } as unknown as import("../src/session-manager").SessionManager;

    const result = await executeRespond(sm, {
      session: "dead-id",
      message: "Approved. Go ahead.",
      approve: true,
    });

    assert.ok(!result.isError, `Should not be an error: ${result.text}`);
    assert.ok(result.text.includes("Plan approved for session"), `Should confirm plan approval on resume: ${result.text}`);
    assert.ok(
      result.text.includes("Session resumed in bypassPermissions mode"),
      `Should confirm resumed bypassPermissions mode: ${result.text}`,
    );

    assert.ok(capturedResumeConfig, "launchAndAwaitRunning should have been called");
    assert.equal(
      capturedResumeConfig!.permissionMode,
      "bypassPermissions",
      "Resumed session must use bypassPermissions, not plan",
    );
    assert.ok(
      capturedResumeConfig!.prompt?.includes("The user approved your plan"),
      `Prompt must contain the approval message, got: ${capturedResumeConfig!.prompt}`,
    );
    assert.ok(
      capturedResumeConfig!.prompt?.includes("Approved. Go ahead."),
      "Prompt must contain original user message",
    );
  });

  it("tryAutoResume with approve=true on a non-plan dead session does NOT inject bypassPermissions", async () => {
    const deadDefaultSession = {
      sessionId: "dead-default",
      harnessSessionId: "harness-default-456",
      backendRef: { kind: "claude-code" as const, conversationId: "harness-default-456" },
      name: "normal-session",
      prompt: "Do some work",
      workdir: "/tmp",
      status: "killed" as const,
      lifecycle: "suspended" as const,
      resumable: true,
      killReason: "idle-timeout" as const,
      currentPermissionMode: "default" as const,
      costUsd: 0.02,
      harness: "plan-e2e-harness",
    };

    let capturedResumeConfig: import("../src/types").SessionConfig | undefined;

    const sm = {
      resolve: (_ref: string) => null,
      getPersistedSession: (_ref: string) => deadDefaultSession,
      notifySession: () => {},
      launchAndAwaitRunning: async (config: import("../src/types").SessionConfig) => {
        capturedResumeConfig = config;
        return { id: "new-id", name: "normal-session", status: "running" };
      },
    } as unknown as import("../src/session-manager").SessionManager;

    await executeRespond(sm, {
      session: "dead-default",
      message: "Continue please.",
      approve: true,
    });

    assert.ok(capturedResumeConfig, "launchAndAwaitRunning should have been called");
    assert.equal(
      capturedResumeConfig!.permissionMode,
      "default",
      "Non-plan session should keep its original permissionMode",
    );
    assert.ok(
      !capturedResumeConfig!.prompt?.includes("The user approved your plan"),
      "Non-plan session should not get the approval prefix",
    );
  });

  it("tryAutoResume with approve=true forwards the approval message deterministically for dead plan sessions", async () => {
    const deadPlanSession = {
      sessionId: "dead-plan-2",
      harnessSessionId: "harness-plan-789",
      backendRef: { kind: "claude-code" as const, conversationId: "harness-plan-789" },
      name: "plan-session-2",
      prompt: "Write a plan",
      workdir: "/tmp",
      status: "killed" as const,
      lifecycle: "suspended" as const,
      resumable: true,
      killReason: "idle-timeout" as const,
      currentPermissionMode: "plan" as const,
      costUsd: 0.01,
      harness: "plan-e2e-harness",
    };

    let capturedConfig: any;

    const sm = {
      resolve: (_ref: string) => null,
      getPersistedSession: (_ref: string) => deadPlanSession,
      notifySession: () => {},
      launchAndAwaitRunning: async (config: any) => {
        capturedConfig = config;
        return { id: "new", name: "plan-session-2", status: "running" };
      },
    } as unknown as import("../src/session-manager").SessionManager;

    const result = await executeRespond(sm, {
      session: "dead-plan-2",
      message: "Please change the approach and add more steps before approving.",
      approve: true,
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.text.includes("Plan approved for session"), `Should confirm plan approval deterministically: ${result.text}`);
    assert.ok(
      result.text.includes("Session resumed in bypassPermissions mode"),
      `Should confirm resumed bypassPermissions mode: ${result.text}`,
    );
    assert.equal(capturedConfig.permissionMode, "bypassPermissions");
    assert.match(capturedConfig.prompt, /The user approved your plan/i);
    assert.match(capturedConfig.prompt, /Please change the approach and add more steps before approving\./);
  });
});

// ---------------------------------------------------------------------------
// Regression: Codex plan mode sets pendingPlanApproval after first turn
// ---------------------------------------------------------------------------

describe("Plan mode E2E: Codex plan turn sets pendingPlanApproval", () => {
  it("Codex session in plan mode: currentPermissionMode='plan', sets pendingPlanApproval on result", async () => {
    // Use the fake harness but start a session with permissionMode="plan".
    // The key assertion is that when the first turn's result arrives, the
    // currentPermissionMode=="plan" path sets pendingPlanApproval=true — this
    // is the same path that fires for Codex plan sessions.
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    assert.equal(session.currentPermissionMode, "plan",
      "plan-mode session must start with currentPermissionMode='plan'");
    assert.equal(session.phase, "active");
    assert.equal(session.pendingPlanApproval, false);

    // Simulate the Codex first-turn plan: some text output followed by the turn result
    fakeHarness.pushMessage({ type: "text", text: "I'll start by reading the file..." });
    await tick(20);
    fakeHarness.pushMessage({ type: "text", text: "Here is my plan: ..." });
    await tick(20);

    // No ExitPlanMode — this is the Codex path (first-turn plan, no special tool)
    // Turn completes: the result handler should set pendingPlanApproval
    fakeHarness.pushMessage({
      type: "result",
      data: {
        success: true,
        duration_ms: 3000,
        total_cost_usd: 0.05,
        num_turns: 1,
        session_id: session.harnessSessionId!,
      },
    });
    await tick(50);

    assert.equal(session.pendingPlanApproval, true,
      "pendingPlanApproval must be set to true after first turn completes in plan mode");
    assert.equal(session.phase, "awaiting_plan_decision");
    assert.equal(session.status, "running",
      "session should remain running, waiting for user approval");

    // Simulate user approving → session switches to bypassPermissions
    session.switchPermissionMode("bypassPermissions");
    await session.sendMessage("Approved. Go ahead.");

    assert.equal(session.pendingPlanApproval, false, "approval clears pendingPlanApproval");
    assert.equal(session.currentPermissionMode, "bypassPermissions");

    session.kill("user");
  });
});

// ---------------------------------------------------------------------------
// Test: Simulate real-world delayed approve
// ---------------------------------------------------------------------------

describe("Plan mode E2E: delayed approval (race condition test)", () => {
  it("pendingPlanApproval survives multiple text messages after ExitPlanMode", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    // Claude presents plan
    fakeHarness.pushMessage({ type: "text", text: "Step 1: read the file" });
    await tick(10);
    fakeHarness.pushMessage({ type: "text", text: "Step 2: modify the function" });
    await tick(10);
    await raiseNativePlanRequest();
    // Text might come after ExitPlanMode
    fakeHarness.pushMessage({ type: "text", text: "I've submitted the plan for approval" });
    await tick(10);

    assert.equal(session.pendingPlanApproval, true, "should survive text after ExitPlanMode");

    // Result comes
    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 5000, total_cost_usd: 0.1, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);

    assert.equal(session.pendingPlanApproval, true, "should survive result");

    // Simulate delayed approval (like a real agent respond after 2s)
    await tick(200);
    assert.equal(session.pendingPlanApproval, true, "should survive delay");

    const sm = createStubSessionManager({ [session.id]: session });
    const result = await executeRespond(sm, {
      session: session.id,
      message: "Approved. Go ahead.",
      approve: true,
    });

    assert.ok(!result.isError, `approve should succeed: ${result.text}`);
    assert.ok(!result.text.includes("no pending plan"), "should not warn about no pending plan");

    session.kill("user");
  });
});

// ---------------------------------------------------------------------------
// Native plan decisions (Claude ExitPlanMode held in canUseTool)
// ---------------------------------------------------------------------------

describe("Plan mode E2E: native plan decisions", () => {
  function capturePushedMessages(): { texts: string[]; restore: () => void } {
    const texts: string[] = [];
    const original = fakeHarness.buildUserMessage;
    fakeHarness.buildUserMessage = (text: string, sessionId: string) => {
      texts.push(text);
      return original(text, sessionId);
    };
    return { texts, restore: () => { fakeHarness.buildUserMessage = original; } };
  }

  it("delivers a bare approval only as the native permission result", async () => {
    fakeHarness.lastSetPermissionMode = undefined;
    const session = await startSession({ permissionMode: "plan", multiTurn: true });
    await raiseNativePlanRequest();
    const pushed = capturePushedMessages();
    try {
      session.switchPermissionMode("bypassPermissions");
      await session.sendMessage("Approved. Go ahead.");
      assert.deepEqual(pushed.texts, [], "the approval phrase is not replayed as a user turn");
      assert.equal(session.planModeApproved, true);
      assert.equal(fakeHarness.lastSetPermissionMode, undefined, "native approval sets the mode inside the permission result");
    } finally {
      pushed.restore();
      session.kill("user");
    }
  });

  it("forwards extra approval instructions without prompt-level framing", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });
    await raiseNativePlanRequest();
    const pushed = capturePushedMessages();
    try {
      session.switchPermissionMode("bypassPermissions");
      await session.sendMessage("Approved, but keep the public API unchanged.");
      assert.deepEqual(pushed.texts, ["Approved, but keep the public API unchanged."]);
    } finally {
      pushed.restore();
      session.kill("user");
    }
  });

  it("sends revision feedback as the native denial instead of a new user turn", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });
    await raiseNativePlanRequest();
    const pushed = capturePushedMessages();
    try {
      await session.sendMessage("Split step 2 into two commits.");
      assert.deepEqual(pushed.texts, []);
      assert.equal(session.approvalState, "changes_requested");
      assert.deepEqual(fakeHarness.planDecisions.at(-1), { kind: "revise", feedback: "Split step 2 into two commits." });
    } finally {
      pushed.restore();
      session.kill("user");
    }
  });

  it("falls back to a mode switch plus the plain message when no native request is pending", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });
    fakeHarness.pushMessage({ type: "text", text: "Here is my plan" });
    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 10, total_cost_usd: 0, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);
    assert.equal(session.pendingPlanApproval, true);
    fakeHarness.nativePlanRequestPending = false;
    const pushed = capturePushedMessages();
    try {
      session.switchPermissionMode("bypassPermissions");
      await session.sendMessage("Approved. Go ahead.");
      assert.equal(fakeHarness.lastSetPermissionMode, "bypassPermissions");
      assert.deepEqual(pushed.texts, ["Approved. Go ahead."], "native-decision backends get no [SYSTEM] prefix");
      assert.equal(session.pendingPlanApproval, false);
    } finally {
      pushed.restore();
      session.kill("user");
    }
  });
});
