import "./test-env";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/session";
import { registerHarness } from "../src/harness/index";
import { createFakeHarness, makeSessionConfig, tick } from "./helpers";
import type { FakeHarness } from "./helpers";
import type { AgentHarness, HarnessLaunchOptions, HarnessSession } from "../src/harness/types";
import { setPluginConfig } from "../src/config";
import { createWorktree, getBranchName } from "../src/worktree";
import { mapSessionTaskTerminalStatus } from "../src/session-task-lifecycle";

// ---------------------------------------------------------------------------
// Register fake harness once (before any tests)
// ---------------------------------------------------------------------------

let fakeHarness: FakeHarness;

before(() => {
  fakeHarness = createFakeHarness("test-harness", { initialPromptConsumptionPaused: true });
  registerHarness(fakeHarness);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

async function createRepoWithWorktree(name: string): { repoDir: string; worktreePath: string; branchName: string } {
  const repoDir = mkdtempSync(join(tmpdir(), `openclaw-session-${name}-`));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "Test User");
  git(repoDir, "config", "user.email", "test@example.com");
  writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");
  const worktreePath = await createWorktree(repoDir, name);
  const branchName = await getBranchName(worktreePath);
  assert.ok(branchName, "worktree branch should exist");
  return { repoDir, worktreePath, branchName };
}

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

  it("sets pendingPlanApproval when the backend raises a native plan-approval request", async () => {
    const session = await startSession({ multiTurn: true });
    const turnEndEvents: boolean[] = [];
    session.on("turnEnd", (_s: any, hadQuestion: boolean) => { turnEndEvents.push(hadQuestion); });
    fakeHarness.pushMessage({
      type: "plan_approval_requested",
      request: {
        requestId: "plan-1",
        artifact: { steps: [], markdown: "1. Do the thing" },
        planFilePath: "/tmp/plans/plan.md",
      },
    });
    await tick(50);

    assert.equal(session.pendingPlanApproval, true);
    assert.equal(session.planFilePath, "/tmp/plans/plan.md");
    assert.equal(session.latestPlanArtifact?.markdown, "1. Do the thing");
    assert.deepEqual(turnEndEvents, [true], "the waiting notification fires while the turn is held open");
    session.kill("user"); // cleanup
  });

  it("does not treat plan-shaped tool calls as plan-approval signals", async () => {
    const session = await startSession({ multiTurn: true, permissionMode: "bypassPermissions" });
    fakeHarness.pushMessage({ type: "tool_use", name: "ExitPlanMode", input: {} });
    fakeHarness.pushMessage({ type: "tool_use", name: "Write", input: { file_path: "/home/u/.claude/plans/p.md" } });
    await tick(50);

    assert.equal(session.pendingPlanApproval, false);
    assert.equal(session.planFilePath, undefined);
    session.kill("user"); // cleanup
  });

  it("sets lastTurnHadQuestion on structured pending input", async () => {
    const session = await startSession({ multiTurn: true });
    const turnEndEvents: boolean[] = [];
    session.on("turnEnd", (_s: any, hadQuestion: boolean) => { turnEndEvents.push(hadQuestion); });

    fakeHarness.pushMessage({ type: "pending_input", state: { requestId: "q-1", kind: "question", options: [] } });
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
      type: "pending_input",
      state: { requestId: "q-merge", kind: "question", promptText: "Would you like me to merge this branch or open a PR?", options: [] },
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

  it("classifies nominal auth completions as failed lifecycle", async () => {
    const session = await startSession({ multiTurn: false });
    const authFailure = "Failed to authenticate. API Error: 401 Invalid bearer token";

    fakeHarness.pushMessage({ type: "text", text: authFailure });
    fakeHarness.pushMessage({
      type: "result",
      data: {
        success: true,
        outcome: "completed",
        duration_ms: 5_000,
        total_cost_usd: 0,
        num_turns: 0,
        session_id: session.harnessSessionId!,
      },
    });
    await tick(50);

    assert.equal(session.status, "failed");
    assert.equal(session.result?.subtype, "error");
    assert.equal(session.result?.is_error, true);
    assert.equal(session.error, authFailure);
    assert.equal(mapSessionTaskTerminalStatus(session), "failed");
    // No kill needed — failed already cleans up
  });

  it("trusts backends that classify outcomes themselves over the text heuristic", async () => {
    const session = await startSession({ multiTurn: false });
    fakeHarness.pushMessage({ type: "text", text: "Failed to authenticate. API Error: 401 Invalid bearer token" });
    fakeHarness.pushMessage({
      type: "result",
      data: {
        success: true,
        outcome: "completed",
        outcomeAuthoritative: true,
        duration_ms: 5,
        total_cost_usd: 0.3,
        num_turns: 0,
        session_id: session.harnessSessionId!,
        usage: {
          models: [{ model: "claude-opus-5-5", costUsd: 0.3, inputTokens: 1, outputTokens: 2 }],
          backgroundTasks: 0,
        },
      },
    });
    await tick(50);

    assert.equal(session.status, "completed");
    assert.equal(session.costUsd, 0.3);
    assert.equal(session.usage?.models?.[0]?.model, "claude-opus-5-5");
  });

  it("shows the structured backend error code in the failure text", async () => {
    const session = await startSession({ multiTurn: false });
    fakeHarness.pushMessage({
      type: "result",
      data: {
        success: false,
        outcome: "failed",
        outcomeAuthoritative: true,
        errorCode: "authentication_failed",
        duration_ms: 5,
        total_cost_usd: 0,
        num_turns: 0,
        result: "Invalid API key",
        session_id: session.harnessSessionId!,
      },
    });
    await tick(50);

    assert.equal(session.status, "failed");
    assert.equal(session.error, "Invalid API key (error code: authentication_failed)");
  });

  it("reports a bare backend error code when the failure has no text", async () => {
    const session = await startSession({ multiTurn: false });
    fakeHarness.pushMessage({
      type: "result",
      data: {
        success: false,
        outcome: "failed",
        outcomeAuthoritative: true,
        errorCode: "cwd_unavailable",
        duration_ms: 5,
        total_cost_usd: 0,
        num_turns: 0,
        session_id: session.harnessSessionId!,
      },
    });
    await tick(50);

    assert.equal(session.status, "failed");
    assert.equal(session.error, "Backend error: cwd_unavailable");
  });

  it("keeps a multi-turn session running while background tasks outlive the turn", async () => {
    const session = await startSession({ multiTurn: true, permissionMode: "bypassPermissions" });
    fakeHarness.setPromptConsumptionPaused(false);
    await tick(10);
    const result = (numTurns: number) => ({
      type: "result" as const,
      data: { success: true, duration_ms: 5, total_cost_usd: 0, num_turns: numTurns, session_id: session.harnessSessionId! },
    });
    fakeHarness.pushMessage({ type: "usage_updated", usage: { backgroundTasks: 1 } });
    fakeHarness.pushMessage(result(1));
    await tick(50);
    assert.equal(session.status, "running", "live background tasks keep the session open");

    // The tasks finish and Claude Code reports them in a new turn.
    fakeHarness.pushMessage({ type: "usage_updated", usage: { backgroundTasks: 0 } });
    fakeHarness.pushMessage({ type: "run_started" });
    fakeHarness.pushMessage({ type: "text", text: "Background build finished." });
    fakeHarness.pushMessage(result(2));
    await tick(50);
    assert.equal(session.status, "completed");
  });

  it("finishes a held turn when background tasks end without a report turn", async (t) => {
    const session = await startSession({ multiTurn: true, permissionMode: "bypassPermissions" });
    fakeHarness.setPromptConsumptionPaused(false);
    await tick(10);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      fakeHarness.pushMessage({ type: "usage_updated", usage: { backgroundTasks: 2 } });
      fakeHarness.pushMessage({
        type: "result",
        data: { success: true, duration_ms: 5, total_cost_usd: 0, num_turns: 1, session_id: session.harnessSessionId! },
      });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(session.status, "running");

      fakeHarness.pushMessage({ type: "usage_updated", usage: { backgroundTasks: 0 } });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(session.status, "running", "waits for a possible report turn");
      t.mock.timers.tick(5_000);
      assert.equal(session.status, "completed");
    } finally {
      t.mock.timers.reset();
      if (session.status === "running") session.kill("user");
    }
  });

  it("separates output after a tool call and across turns without doubling blank lines", async () => {
    const session = await startSession({ multiTurn: true, permissionMode: "bypassPermissions" });
    fakeHarness.pushMessage({ type: "text", text: "First message." });
    fakeHarness.pushMessage({ type: "tool_use", name: "Bash", input: { command: "ls" } });
    fakeHarness.pushMessage({ type: "text", text: "Second " });
    fakeHarness.pushMessage({ type: "text", text: "message." });
    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 5, total_cost_usd: 0, num_turns: 1, session_id: session.harnessSessionId! },
    });
    fakeHarness.pushMessage({ type: "text", text: "Next turn." });
    fakeHarness.pushMessage({ type: "tool_use", name: "Bash", input: { command: "ls" } });
    fakeHarness.pushMessage({ type: "text", text: "\n\nAlready separated." });
    await tick(50);
    assert.equal(
      session.getOutput().join("\n"),
      "First message.\n\nSecond message.\n\nNext turn.\n\nAlready separated.",
    );
    session.kill("user");
  });

  it("signals a fully answered pending question so the button wait can be dropped", async () => {
    const session = await startSession({ multiTurn: true });
    fakeHarness.pushMessage({
      type: "pending_input",
      state: {
        requestId: "ask-7",
        kind: "question",
        options: ["A", "B"],
        allowsFreeText: true,
        questions: [
          { id: "q1", question: "First?", options: [{ label: "A" }, { label: "B" }] },
          { id: "q2", question: "Second?", options: [{ label: "A" }, { label: "B" }] },
        ],
        activeQuestionIndex: 0,
      },
    } as any);
    await tick(20);
    (session as any).harnessHandle.submitPendingInputText = async () => true;
    const answered: Array<string | undefined> = [];
    session.on("pendingInputAnswered", (_s: unknown, requestId: string | undefined) => { answered.push(requestId); });

    assert.equal(await session.submitPendingInputText("A"), true);
    assert.deepEqual(answered, [], "more questions remain");
    (session as any).pendingInputState = { ...(session as any).pendingInputState, activeQuestionIndex: 1 };
    assert.equal(await session.submitPendingInputText("B"), true);
    assert.deepEqual(answered, ["ask-7"]);
    session.kill("user");
  });

  it("treats an aborted interrupt during teardown as expected", async (t) => {
    const session = await startSession({ multiTurn: true });
    const warnings: string[] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
    (session as any).harnessHandle.interrupt = async () => { throw new Error("Operation aborted"); };
    session.kill("user");
    await tick(20);
    assert.equal(warnings.some((line) => line.includes("interrupt during teardown")), false);
  });

  it("merges usage snapshots and records backend model facts", async () => {
    const session = await startSession({ multiTurn: true });
    fakeHarness.pushMessage({ type: "usage_updated", usage: { backgroundTasks: 2 } });
    fakeHarness.pushMessage({ type: "usage_updated", usage: { contextTokens: 1000, contextWindow: 200000 } });
    fakeHarness.pushMessage({ type: "backend_info", info: { model: "claude-opus-5-5", reasoningEffortSupported: false } });
    await tick(50);

    assert.deepEqual(session.usage, { backgroundTasks: 2, contextTokens: 1000, contextWindow: 200000 });
    assert.equal(session.backendInfo?.model, "claude-opus-5-5");
    assert.equal(session.backendInfo?.reasoningEffortSupported, false);
    session.kill("user");
  });

  it("tracks the running cost from usage snapshots until the turn total replaces it", async () => {
    const session = await startSession({ multiTurn: true });
    fakeHarness.pushMessage({ type: "usage_updated", usage: { costUsd: 0.04, contextTokens: 900 } });
    await tick(50);
    assert.equal(session.costUsd, 0.04);
    assert.deepEqual(session.usage, { contextTokens: 900 }, "the running cost is not kept as a usage field");

    fakeHarness.pushMessage({ type: "usage_updated", usage: { costUsd: Number.NaN } });
    await tick(20);
    assert.equal(session.costUsd, 0.04, "non-finite costs are ignored");

    fakeHarness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 5, total_cost_usd: 0.05, num_turns: 1, session_id: session.harnessSessionId!, usage: { costUsd: 9 } },
    });
    await tick(50);
    assert.equal(session.costUsd, 0.05, "the turn total is authoritative");
    session.kill("user");
  });

  it("does not classify successful task output mentioning auth phrases as startup failure", async () => {
    const session = await startSession({ multiTurn: false });

    fakeHarness.pushMessage({
      type: "text",
      text: "Documented how to handle an invalid API key during setup.",
    });
    fakeHarness.pushMessage({
      type: "result",
      data: {
        success: true,
        outcome: "completed",
        duration_ms: 5_000,
        total_cost_usd: 0,
        num_turns: 1,
        result: "Documentation update complete: invalid API key handling is covered.",
        session_id: session.harnessSessionId!,
      },
    });
    await tick(50);

    assert.equal(session.status, "completed");
    assert.equal(session.result?.subtype, "success");
    assert.equal(session.result?.is_error, false);
    assert.equal(mapSessionTaskTerminalStatus(session), "succeeded");
    // No kill needed — completed already cleans up
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

  it("keeps a dirty worktree session running and queues a finalization prompt before completing", async () => {
    const { repoDir, worktreePath, branchName } = await createRepoWithWorktree("dirty-finalization");
    try {
      const session = await startSession({
        multiTurn: true,
        permissionMode: "bypassPermissions",
        workdir: worktreePath,
        worktreeStrategy: "delegate",
      });
      session.originalWorkdir = repoDir;
      session.worktreePath = worktreePath;
      session.worktreeBranch = branchName;

      fakeHarness.setPromptConsumptionPaused(false);
      await tick(50);

      writeFileSync(join(worktreePath, "README.md"), "base\nchanged\n", "utf-8");
      fakeHarness.pushMessage({
        type: "result",
        data: { success: true, duration_ms: 100, total_cost_usd: 0.01, num_turns: 1, session_id: session.harnessSessionId! },
      });
      await tick(50);

      assert.equal(session.status, "running");
      assert.equal(session.killReason, "unknown");

      session.kill("user");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
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

    fakeHarness.pushMessage({ type: "pending_input", state: { requestId: "q-proceed", kind: "question", promptText: "Proceed?", options: [] } });
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
    // 300 ms idle timeout with heartbeats every ~100 ms: the heartbeats span
    // longer than one timeout window, and the margins tolerate coarse timers.
    setPluginConfig({ idleTimeoutMinutes: 0.005, sessionGcAgeMinutes: 1440 });
    const session = await startSession({ multiTurn: true, permissionMode: "bypassPermissions" });

    for (let i = 0; i < 5; i++) {
      fakeHarness.pushMessage({ type: "activity" });
      await tick(100);
    }

    assert.equal(session.status, "running", "heartbeat should prevent idle timeout");
    await tick(600);
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

  it("closes the harness transport when a session is terminated", async () => {
    let closeCalls = 0;
    const closingHarness: AgentHarness = {
      name: "test-harness-close-on-terminal",
      backendKind: "codex-app-server",
      supportedPermissionModes: ["default", "plan", "bypassPermissions"],
      capabilities: {
        nativePendingInput: true,
        nativePlanArtifacts: true,
      },
      launch(): HarnessSession {
        async function* messages() {
          yield {
            type: "backend_ref",
            ref: { kind: "codex-app-server", conversationId: "writer-owned-thread" },
          } as const;
          await new Promise<void>(() => undefined);
        }
        return {
          messages: messages(),
          async close(): Promise<void> { closeCalls += 1; },
        };
      },
      buildUserMessage(text: string, sessionId: string): unknown {
        return { type: "user", text, session_id: sessionId };
      },
    };
    registerHarness(closingHarness);

    const session = new Session(makeSessionConfig({ harness: closingHarness.name }), "close-session");
    await session.start();
    await tick(20);
    session.kill("idle-timeout");
    await tick(20);

    assert.equal(closeCalls, 1);
    assert.equal(session.status, "killed");
  });

  it("exposes a teardown barrier until the harness releases its backend writer", async () => {
    let releaseClose!: () => void;
    const closeBarrier = new Promise<void>((resolve) => { releaseClose = resolve; });
    const closingHarness: AgentHarness = {
      name: "test-harness-writer-release-barrier",
      backendKind: "codex-app-server",
      supportedPermissionModes: ["default", "plan", "bypassPermissions"],
      capabilities: {
        nativePendingInput: true,
        nativePlanArtifacts: true,
      },
      launch(): HarnessSession {
        async function* messages() {
          yield { type: "run_started" } as const;
          await new Promise<void>(() => undefined);
        }
        return {
          messages: messages(),
          async close(): Promise<void> { await closeBarrier; },
        };
      },
      buildUserMessage(text: string, sessionId: string): unknown {
        return { type: "user", text, session_id: sessionId };
      },
    };
    registerHarness(closingHarness);

    const session = new Session(makeSessionConfig({ harness: closingHarness.name }), "writer-release-barrier");
    await session.start();
    await tick(20);
    session.kill("user");

    let released = false;
    void session.waitForTeardown().then(() => { released = true; });
    await tick(20);
    assert.equal(session.status, "killed");
    assert.equal(released, false);

    releaseClose();
    await session.waitForTeardown();
    assert.equal(released, true);
  });

  it("does not report implementation started when an approved recovery fails before backend startup", async () => {
    const activeWriterError = "codex app server rpc error (-32600): thread 01a0583d-acad-74f2-a02e-8402323f60d8 already has an active writer";
    const failingRecoveryHarness: AgentHarness = {
      name: "test-harness-active-writer-startup-failure",
      backendKind: "codex-app-server",
      supportedPermissionModes: ["default", "plan", "bypassPermissions"],
      capabilities: {
        nativePendingInput: true,
        nativePlanArtifacts: true,
      },
      launch(): HarnessSession {
        async function* messages() {
          yield {
            type: "run_completed",
            data: {
              success: false,
              duration_ms: 0,
              total_cost_usd: 0,
              num_turns: 0,
              result: activeWriterError,
              session_id: "01a0583d-acad-74f2-a02e-8402323f60d8",
            },
          } as const;
        }
        return { messages: messages() };
      },
      buildUserMessage(text: string, sessionId: string): unknown {
        return { type: "user", text, session_id: sessionId };
      },
    };
    registerHarness(failingRecoveryHarness);

    const session = new Session(makeSessionConfig({
      harness: failingRecoveryHarness.name,
      permissionMode: "bypassPermissions",
      requestedPermissionMode: "plan",
      approvalState: "approved",
      approvalExecutionState: "awaiting_plan_output",
      planModeApproved: true,
    }), "active-writer-recovery");
    await session.start();
    await tick(20);

    assert.equal(session.status, "failed");
    assert.equal(session.approvalState, "approved");
    assert.equal(session.approvalExecutionState, "awaiting_plan_output");
    assert.equal(session.result?.num_turns, 0);
    assert.equal(session.error ?? session.result?.result, activeWriterError);
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

// ---------------------------------------------------------------------------
// Steering and thread actions (Codex B10/B12/B13 session plumbing)
// ---------------------------------------------------------------------------

describe("Session steering and thread actions", () => {
  async function startWith(harness: FakeHarness, config: Partial<import("../src/types").SessionConfig> = {}): Promise<Session> {
    registerHarness(harness);
    const session = new Session(makeSessionConfig({ harness: harness.name, multiTurn: true, permissionMode: "bypassPermissions", ...config }), "steer");
    await session.start();
    harness.pushMessage({ type: "init", session_id: `sess-${session.id}` });
    await tick(20);
    return session;
  }

  it("steers a follow-up into the running turn instead of queueing it", async () => {
    const harness = createFakeHarness("steer-harness-accepts");
    harness.steerResult = true;
    const session = await startWith(harness);
    try {
      const delivery = await session.sendMessage("also cover the edge case");
      assert.equal(delivery, "steered");
      assert.deepEqual(harness.steerCalls, ["also cover the edge case"]);
      assert.equal(harness.consumedPrompts.length, 1, "only the initial prompt reached the prompt stream");
    } finally {
      session.kill("user");
    }
  });

  it("queues the follow-up when the harness declines to steer", async () => {
    const harness = createFakeHarness("steer-harness-declines");
    harness.steerResult = false;
    const session = await startWith(harness);
    try {
      assert.equal(await session.sendMessage("queue me"), "queued");
      assert.deepEqual(harness.steerCalls, ["queue me"]);
      await tick(20);
      assert.equal(harness.consumedPrompts.length, 2);
    } finally {
      session.kill("user");
    }
  });

  it("never steers plan-decision messages", async () => {
    const harness = createFakeHarness("steer-harness-plan");
    harness.steerResult = true;
    const session = await startWith(harness, { permissionMode: "plan" });
    try {
      session.pendingPlanApproval = true;
      assert.equal(await session.sendMessage("revise step 2"), "queued");
      assert.deepEqual(harness.steerCalls, []);
    } finally {
      session.kill("user");
    }
  });

  it("queues thread actions through the prompt stream only for harnesses that support them", async () => {
    const plain = createFakeHarness("thread-action-unsupported");
    const plainSession = await startWith(plain);
    try {
      assert.throws(() => plainSession.requestThreadAction({ kind: "compact" }), /does not support the "compact" thread action/);
    } finally {
      plainSession.kill("user");
    }

    const capable = createFakeHarness("thread-action-supported");
    Object.assign(capable, {
      capabilities: { ...capable.capabilities, threadActions: ["compact", "review"] },
      buildThreadActionMessage: (action: unknown) => ({ type: "control", action }),
    });
    const session = await startWith(capable);
    try {
      session.requestThreadAction({ kind: "review", target: { type: "baseBranch", branch: "main" } });
      await tick(20);
      assert.deepEqual(capable.consumedPrompts.at(-1), { type: "control", action: { kind: "review", target: { type: "baseBranch", branch: "main" } } });
    } finally {
      session.kill("user");
    }
    assert.throws(() => session.requestThreadAction({ kind: "compact" }), /Session is not running/);
  });
});
