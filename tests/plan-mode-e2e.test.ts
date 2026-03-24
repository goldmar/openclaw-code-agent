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
  fakeHarness = createFakeHarness("plan-e2e-harness");
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
    assert.equal(session.phase, "planning");

    // Simulate Claude presenting the plan with text
    fakeHarness.pushMessage({ type: "text", text: "Here is my plan..." });
    await tick(20);

    // Simulate Claude calling ExitPlanMode
    fakeHarness.pushMessage({ type: "tool_use", name: "ExitPlanMode", input: {} });
    await tick(20);

    assert.equal(session.pendingPlanApproval, true, "pendingPlanApproval should be true after ExitPlanMode");
    assert.equal(session.phase, "awaiting-plan-approval");

    // Simulate turn ending with result
    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 5000, total_cost_usd: 0.1, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);

    // After result, pendingPlanApproval should STILL be true
    assert.equal(session.pendingPlanApproval, true, "pendingPlanApproval should survive the result message");
    assert.equal(session.phase, "awaiting-plan-approval");
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
    assert.ok(result.text.includes("Message sent"), `Should say message sent: ${result.text}`);

    session.kill("user"); // cleanup
  });

  it("plan flow: text messages do NOT reset pendingPlanApproval", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    // Set pendingPlanApproval via ExitPlanMode
    fakeHarness.pushMessage({ type: "tool_use", name: "ExitPlanMode", input: {} });
    await tick(20);
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
    assert.equal(session.phase, "awaiting-plan-approval");

    session.kill("user");
  });

  it("plan flow: AskUserQuestion in plan mode sets pendingPlanApproval", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    fakeHarness.pushMessage({ type: "tool_use", name: "AskUserQuestion", input: { question: "Approve plan?" } });
    await tick(20);

    assert.equal(session.pendingPlanApproval, true, "AskUserQuestion in plan mode should set pendingPlanApproval");
    assert.equal(session.phase, "awaiting-plan-approval");

    session.kill("user");
  });

  it("plan flow: approve clears pendingPlanApproval and switches mode", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    // Set up plan approval state
    fakeHarness.pushMessage({ type: "tool_use", name: "ExitPlanMode", input: {} });
    await tick(20);

    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 5000, total_cost_usd: 0.1, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);

    assert.equal(session.pendingPlanApproval, true);

    // Trigger approve flow
    session.switchPermissionMode("bypassPermissions");
    await session.sendMessage("Approved. Go ahead.");

    assert.equal(session.pendingPlanApproval, false, "pendingPlanApproval should be cleared after approval");
    assert.equal(session.currentPermissionMode, "bypassPermissions", "mode should switch to bypassPermissions");

    session.kill("user");
  });

  it("plan flow: revision feedback keeps pendingPlanApproval true", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    // Set up plan approval state
    fakeHarness.pushMessage({ type: "tool_use", name: "ExitPlanMode", input: {} });
    await tick(20);

    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 5000, total_cost_usd: 0.1, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);

    assert.equal(session.pendingPlanApproval, true);

    // Send revision (no mode switch)
    await session.sendMessage("Please change the approach to X");

    assert.equal(session.pendingPlanApproval, true, "pendingPlanApproval should remain true for revisions");
    assert.equal(session.currentPermissionMode, "plan", "mode should stay plan for revisions");

    session.kill("user");
  });

  it("plan flow: ignores late plan-approval signals after approval", async () => {
    const session = await startSession({ permissionMode: "plan", multiTurn: true });

    fakeHarness.pushMessage({ type: "tool_use", name: "ExitPlanMode", input: {} });
    await tick(20);
    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 5000, total_cost_usd: 0.1, num_turns: 1, session_id: session.harnessSessionId! },
    });
    await tick(50);

    session.switchPermissionMode("bypassPermissions");
    await session.sendMessage("Approved. Go ahead.");
    assert.equal(session.pendingPlanApproval, false);
    assert.equal(session.currentPermissionMode, "bypassPermissions");

    fakeHarness.pushMessage({ type: "tool_use", name: "ExitPlanMode", input: {} });
    await tick(20);

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
  it("tryAutoResume forwards approve=true as bypassPermissions + system prefix when session was in plan mode", async () => {
    // Simulate a dead session that was in awaiting-plan-approval when killed.
    const deadPersistedSession = {
      sessionId: "dead-id",
      harnessSessionId: "harness-dead-123",
      name: "plan-merge-robustness",
      prompt: "Write a plan for X",
      workdir: "/tmp",
      status: "killed" as const,
      killReason: "idle-timeout" as const,
      currentPermissionMode: "plan" as const,
      costUsd: 0.05,
      harness: "plan-e2e-harness",
    };

    let capturedResumeConfig: import("../src/types").SessionConfig | undefined;

    // Build a stub SessionManager that:
    //  - resolve() returns null (session is dead)
    //  - getPersistedSession() returns the dead session
    //  - spawnAndAwaitRunning() captures the config and returns a fake running session
    const sm = {
      resolve: (_ref: string) => null,
      getPersistedSession: (_ref: string) => deadPersistedSession,
      notifySession: () => {},
      spawnAndAwaitRunning: async (config: import("../src/types").SessionConfig) => {
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
    assert.ok(result.text.includes("Auto-resumed"), `Should say auto-resumed: ${result.text}`);

    assert.ok(capturedResumeConfig, "spawnAndAwaitRunning should have been called");
    assert.equal(
      capturedResumeConfig!.permissionMode,
      "bypassPermissions",
      "Resumed session must use bypassPermissions, not plan",
    );
    assert.ok(
      capturedResumeConfig!.prompt?.includes("[SYSTEM: The user has approved your plan."),
      `Prompt must contain approval system prefix, got: ${capturedResumeConfig!.prompt}`,
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
      name: "normal-session",
      prompt: "Do some work",
      workdir: "/tmp",
      status: "killed" as const,
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
      spawnAndAwaitRunning: async (config: import("../src/types").SessionConfig) => {
        capturedResumeConfig = config;
        return { id: "new-id", name: "normal-session", status: "running" };
      },
    } as unknown as import("../src/session-manager").SessionManager;

    await executeRespond(sm, {
      session: "dead-default",
      message: "Continue please.",
      approve: true,
    });

    assert.ok(capturedResumeConfig, "spawnAndAwaitRunning should have been called");
    assert.equal(
      capturedResumeConfig!.permissionMode,
      "default",
      "Non-plan session should keep its original permissionMode",
    );
    assert.ok(
      !capturedResumeConfig!.prompt?.includes("[SYSTEM: The user has approved your plan."),
      "Non-plan session should not get the approval prefix",
    );
  });

  it("tryAutoResume with approve=true rejects revision keywords even for dead plan session", async () => {
    const deadPlanSession = {
      sessionId: "dead-plan-2",
      harnessSessionId: "harness-plan-789",
      name: "plan-session-2",
      prompt: "Write a plan",
      workdir: "/tmp",
      status: "killed" as const,
      killReason: "idle-timeout" as const,
      currentPermissionMode: "plan" as const,
      costUsd: 0.01,
      harness: "plan-e2e-harness",
    };

    const sm = {
      resolve: (_ref: string) => null,
      getPersistedSession: (_ref: string) => deadPlanSession,
      notifySession: () => {},
      spawnAndAwaitRunning: async () => ({ id: "new", name: "plan-session-2", status: "running" }),
    } as unknown as import("../src/session-manager").SessionManager;

    const result = await executeRespond(sm, {
      session: "dead-plan-2",
      message: "Please change the approach and add more steps before approving.",
      approve: true,
    });

    assert.equal(result.isError, true, "Should reject approve+revision in same call");
    assert.ok(result.text.includes("Cannot approve and revise"), `Should explain the error: ${result.text}`);
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
    fakeHarness.pushMessage({ type: "tool_use", name: "ExitPlanMode", input: {} });
    await tick(10);
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
