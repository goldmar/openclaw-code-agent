import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeHarness, CLAUDE_PLAN_MODE_INSTRUCTIONS, planFileWrittenByTool, resolveClaudeRewindPoint, trustedPlanFilePath } from "../src/harness/claude-code";
import { setPluginConfig } from "../src/config";
import { resolveAgentLaunchRequest } from "../src/tools/agent-launch-resolution";
import type { HarnessMessage } from "../src/harness/types";

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options?: { signal?: AbortSignal; requestId?: string; toolUseID?: string },
) => Promise<any>;

function createQueryHandle(messages: unknown[], extras: Record<string, unknown> = {}) {
  const permissionModes: string[] = [];
  const streamedInputs: SDKUserMessage[][] = [];
  let interrupted = false;
  let release: (() => void) | undefined;
  const gate = extras.holdUntilReleased
    ? new Promise<void>((resolve) => { release = resolve; })
    : Promise.resolve();

  const handle = {
    async *[Symbol.asyncIterator](): AsyncIterable<unknown> {
      for (const message of messages) {
        yield message;
      }
      await gate;
    },
    async setPermissionMode(mode: string): Promise<void> {
      permissionModes.push(mode);
    },
    async streamInput(input: AsyncIterable<SDKUserMessage>): Promise<void> {
      const batch: SDKUserMessage[] = [];
      for await (const message of input) {
        batch.push(message);
      }
      streamedInputs.push(batch);
    },
    async interrupt(): Promise<void> {
      interrupted = true;
    },
    ...extras,
  };

  return {
    handle,
    permissionModes,
    streamedInputs,
    wasInterrupted: () => interrupted,
    release: () => release?.(),
  };
}

function harnessWith(handle: unknown, seen?: (options: Record<string, unknown>) => void, deps: Record<string, unknown> = {}) {
  return new ClaudeCodeHarness({
    startup: async ({ options }) => {
      seen?.(options as Record<string, unknown>);
      return { query: () => handle as any, close: () => {} };
    },
    getSessionInfo: async (sessionId: string) => ({ sessionId, summary: "", lastModified: 0 }),
    ...deps,
  });
}

async function collectMessages(
  session: { messages: AsyncIterable<HarnessMessage> },
): Promise<HarnessMessage[]> {
  const out: HarnessMessage[] = [];
  for await (const message of session.messages) {
    out.push(message);
    if (message.type === "run_completed") break;
  }
  return out;
}

async function collectAll(session: { messages: AsyncIterable<HarnessMessage> }): Promise<HarnessMessage[]> {
  const out: HarnessMessage[] = [];
  for await (const message of session.messages) out.push(message);
  return out;
}

function completions(messages: HarnessMessage[]) {
  return messages.filter((message): message is Extract<HarnessMessage, { type: "run_completed" }> => message.type === "run_completed");
}

const OK_RESULT = { type: "result", subtype: "success", session_id: "claude-1", duration_ms: 0, total_cost_usd: 0, num_turns: 1, result: "done" };

async function launchForCanUseTool(permissionMode: string, extraOptions: Record<string, unknown> = {}, sdkMessages: unknown[] = []) {
  const startupOptions = Promise.withResolvers<Record<string, unknown>>();
  const query = createQueryHandle(sdkMessages, { holdUntilReleased: true });
  const harness = harnessWith(query.handle, (options) => startupOptions.resolve(options));
  const session = harness.launch({
    prompt: "plan it",
    cwd: "/tmp/project",
    permissionMode,
    canUseTool: async (_toolName, input) => ({ behavior: "allow", updatedInput: input }),
    ...extraOptions,
  });
  const options = await startupOptions.promise;
  const messages: HarnessMessage[] = [];
  const pump = (async () => {
    for await (const message of session.messages) messages.push(message);
  })();
  return {
    session,
    canUseTool: options.canUseTool as CanUseToolFn,
    messages,
    finish: async () => { query.release(); await pump; },
  };
}

describe("ClaudeCodeHarness", () => {
  it("passes the omitted Claude model as the native opus alias to the SDK", async () => {
    setPluginConfig({});
    const launch = resolveAgentLaunchRequest(
      { prompt: "check default" },
      { workspaceDir: "/tmp", oneShotCliRun: true } as any,
      {},
    );
    assert.equal(launch.kind, "resolved");
    if (launch.kind !== "resolved") return;

    let sdkOptions: Record<string, unknown> | undefined;
    const { handle } = createQueryHandle([OK_RESULT]);
    const harness = harnessWith(handle, (options) => { sdkOptions = options; });
    await collectMessages(harness.launch({ prompt: "check default", cwd: "/tmp", model: launch.resolvedModel }));
    assert.equal(sdkOptions?.model, "opus");
  });

  it("configures plan-mode instructions, session-state events, and no injected MCP servers", async () => {
    let sdkOptions: Record<string, any> | undefined;
    const { handle } = createQueryHandle([OK_RESULT]);
    const harness = harnessWith(handle, (options) => { sdkOptions = options; });
    await collectMessages(harness.launch({ prompt: "plan", cwd: "/tmp/project", permissionMode: "plan" }));

    assert.equal(sdkOptions?.planModeInstructions, CLAUDE_PLAN_MODE_INSTRUCTIONS);
    assert.equal(sdkOptions?.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, "1");
    assert.equal(sdkOptions?.env?.CLAUDE_CODE_STARTUP_FAILURE_RESULTS, "1");
    assert.equal(Object.hasOwn(sdkOptions ?? {}, "mcpServers"), false, "user MCP servers load through Claude settings");
    assert.equal(typeof sdkOptions?.canUseTool, "function");
    assert.equal(Object.hasOwn(sdkOptions ?? {}, "projectConfigRoot"), false);
  });

  it("loads project config from the original checkout for worktree sessions", async () => {
    let sdkOptions: Record<string, any> | undefined;
    const { handle } = createQueryHandle([OK_RESULT]);
    const harness = harnessWith(handle, (options) => { sdkOptions = options; });
    await collectMessages(harness.launch({
      prompt: "work",
      cwd: "/repo/.worktrees/agent-x",
      originalWorkdir: "/repo",
      worktreeStrategy: "ask",
    }));
    assert.equal(sdkOptions?.projectConfigRoot, "/repo");
    assert.equal(sdkOptions?.cwd, "/repo/.worktrees/agent-x");
  });

  it("treats Claude AskUserQuestion questions[] as a formal multi-question contract", async () => {
    const startupOptions = Promise.withResolvers<Record<string, unknown>>();
    const { handle } = createQueryHandle([
      { type: "result", subtype: "success", session_id: "claude-questions", duration_ms: 0, total_cost_usd: 0, num_turns: 1, result: "done" },
    ]);
    const harness = harnessWith(handle, (options) => startupOptions.resolve(options));

    const session = harness.launch({
      prompt: "ask",
      cwd: "/tmp/project",
      canUseTool: async () => ({ behavior: "allow" as const, updatedInput: {} }),
    });
    const options = await startupOptions.promise;
    const canUseTool = options.canUseTool as CanUseToolFn;

    await canUseTool("AskUserQuestion", {
      questions: [{
        id: "policy_source",
        header: "Policy",
        question: "Which policy source should I use?",
        options: [
          {
            label: "Plugin store",
            value: "plugin_store",
            description: "Shared policy controlled by plugin config.",
          },
          { label: "Local override", preview: "Only this session." },
        ],
      }, {
        id: "scope",
        header: "Scope",
        question: "How broad should the rollout be?",
        multiSelect: true,
        options: [
          { label: "Canary", description: "Start with a small cohort." },
          { label: "Everyone", description: "Roll out to all users." },
        ],
      }],
    }, { signal: new AbortController().signal, requestId: "req-ask", toolUseID: "tool-ask" });

    const messages = await collectMessages(session);
    const pending = messages.find((message) => message.type === "pending_input") as Extract<HarnessMessage, { type: "pending_input" }> | undefined;

    assert.equal(pending?.state.kind, "question");
    assert.equal(pending?.state.activeQuestionIndex, 0);
    assert.deepEqual(pending?.state.options, ["Plugin store", "Local override"]);
    assert.equal(pending?.state.questions?.length, 2);
    assert.equal(pending?.state.questions?.[0]?.id, "policy_source");
    assert.equal(pending?.state.questions?.[0]?.options[0]?.value, "plugin_store");
    assert.equal(pending?.state.questions?.[0]?.options[0]?.description, "Shared policy controlled by plugin config.");
    assert.equal(pending?.state.questions?.[0]?.options[1]?.description, "Only this session.");
    assert.equal(pending?.state.questions?.[1]?.question, "How broad should the rollout be?");
    assert.equal(pending?.state.questions?.[1]?.multiSelect, true);
    assert.equal(pending?.state.questions?.[1]?.allowsFreeText, true);
    assert.match(pending?.state.promptText ?? "", /Question 1 - Policy/);
    assert.doesNotMatch(pending?.state.promptText ?? "", /Question 2 - Scope/);
    assert.ok(messages.some((message) => message.type === "pending_input_resolved"));
  });

  it("answers AskUserQuestion through submitPendingInputText/Option (numbers, labels, multi-select, free text)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      // The session's question service never answers here (no button press) and
      // later times out: the direct answer must win and the timeout stay handled.
      const serviceTimeout = (): Promise<never> => new Promise((_, reject) => {
        setTimeout(() => reject(new Error("AskUserQuestion timed out")), 150);
      });
      const { session, canUseTool, messages, finish } = await launchForCanUseTool("default", {
        canUseTool: serviceTimeout,
      });
      const questions = [{
        id: "policy_source",
        question: "Which policy source should I use?",
        options: [{ label: "Plugin store" }, { label: "Local override" }],
      }, {
        id: "scope",
        question: "How broad should the rollout be?",
        multiSelect: true,
        options: [{ label: "Canary" }, { label: "Everyone" }, { label: "Staff" }],
      }, {
        id: "note",
        question: "Anything else?",
        options: [{ label: "No" }],
      }];
      const decision = canUseTool("AskUserQuestion", { questions }, { signal: new AbortController().signal, requestId: "r", toolUseID: "t" });
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      const first = messages.find((message) => message.type === "pending_input") as Extract<HarnessMessage, { type: "pending_input" }>;
      assert.equal(first.state.allowsFreeText, true, "agent_respond text replies must reach the harness");

      // Stale context is refused; option index answers the first question.
      assert.equal(await session.submitPendingInputOption?.(0, { requestId: "other" }), false);
      assert.equal(await session.submitPendingInputOption?.(1, { requestId: first.state.requestId }), true);
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      const second = messages.filter((message) => message.type === "pending_input").at(-1) as Extract<HarnessMessage, { type: "pending_input" }>;
      assert.equal(second.state.activeQuestionIndex, 1);
      assert.deepEqual(second.state.options, ["Canary", "Everyone", "Staff"]);
      // Multi-select: numbers and case-insensitive labels, comma separated.
      assert.equal(await session.submitPendingInputText?.("1, everyone"), true);
      // Free text that matches no option is passed through as the answer.
      assert.equal(await session.submitPendingInputText?.("Ship it on Friday"), true);

      assert.deepEqual(await decision, {
        behavior: "allow",
        updatedInput: {
          questions,
          answers: {
            "Which policy source should I use?": "Local override",
            "How broad should the rollout be?": "Canary, Everyone",
            "Anything else?": "Ship it on Friday",
          },
        },
      });
      assert.equal(await session.submitPendingInputText?.("late"), false);
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      assert.ok(messages.some((message) => message.type === "pending_input_resolved"));
      // Let the service-side timeout fire after the direct answer won.
      await new Promise<void>((resolve) => { setTimeout(resolve, 200); });
      assert.deepEqual(unhandled, []);
      await finish();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("maps a single-select text reply by option number and by label", async () => {
    const { session, canUseTool, finish } = await launchForCanUseTool("default", {
      canUseTool: () => new Promise(() => {}),
    });
    const questions = [{ question: "Pick one", options: [{ label: "Alpha" }, { label: "Beta" }] }];
    const byNumber = canUseTool("AskUserQuestion", { questions }, { signal: new AbortController().signal, requestId: "r1", toolUseID: "t1" });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(await session.submitPendingInputText?.("2"), true);
    assert.deepEqual((await byNumber).updatedInput.answers, { "Pick one": "Beta" });
    const byLabel = canUseTool("AskUserQuestion", { questions }, { signal: new AbortController().signal, requestId: "r2", toolUseID: "t2" });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(await session.submitPendingInputText?.("alpha"), true);
    assert.deepEqual((await byLabel).updatedInput.answers, { "Pick one": "Alpha" });
    await finish();
  });

  it("reports only a fork's own usage when given the parent's baseline", async () => {
    const modelUsage = (inputTokens: number, outputTokens: number, costUSD: number) => ({
      "claude-sonnet-5": { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD, contextWindow: 200000, maxOutputTokens: 32000 },
    });
    const { handle } = createQueryHandle([
      // Claude Code restores the resumed transcript's cumulative usage.
      { ...OK_RESULT, session_id: "claude-fork", total_cost_usd: 1.25, modelUsage: modelUsage(1_100, 900, 1.25) },
    ]);
    const messages = await collectAll(harnessWith(handle).launch({
      prompt: "x",
      cwd: "/tmp",
      resumeSessionId: "claude-parent",
      forkSession: true,
      forkBaselineUsage: { costUsd: 1, models: [{ model: "claude-sonnet-5", costUsd: 1, inputTokens: 1_000, outputTokens: 800 }] },
    }));
    const done = completions(messages)[0];
    assert.equal(done?.data.total_cost_usd, 0.25);
    assert.deepEqual(done?.data.usage?.models?.map((entry) => [entry.model, entry.costUsd, entry.inputTokens, entry.outputTokens]), [
      ["claude-sonnet-5", 0.25, 100, 100],
    ]);
  });

  it("omits the per-model breakdown when only the parent's total cost is known", async () => {
    const { handle } = createQueryHandle([
      {
        ...OK_RESULT,
        session_id: "claude-fork",
        total_cost_usd: 1.25,
        modelUsage: {
          "claude-sonnet-5": { inputTokens: 1_100, outputTokens: 900, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 1.25, contextWindow: 200000, maxOutputTokens: 32000 },
        },
      },
    ]);
    const messages = await collectAll(harnessWith(handle).launch({
      prompt: "x",
      cwd: "/tmp",
      resumeSessionId: "claude-parent",
      forkSession: true,
      forkBaselineUsage: { costUsd: 1 },
    }));
    const done = completions(messages)[0];
    assert.equal(done?.data.total_cost_usd, 0.25);
    assert.equal(done?.data.usage?.models, undefined, "parent tokens must not be attributed to the fork");
  });

  it("ignores an interrupt that fails because the query already shut down", async () => {
    const { handle } = createQueryHandle([OK_RESULT], {
      async interrupt(): Promise<void> { throw new Error("Operation aborted"); },
    });
    const session = harnessWith(handle).launch({ prompt: "x", cwd: "/tmp" });
    await collectAll(session);
    await assert.doesNotReject(async () => await session.interrupt?.());
  });

  it("pre-warms Claude Code with the public startup() WarmQuery", async () => {
    const calls = { startup: 0 };
    let promptSeen: string | AsyncIterable<SDKUserMessage> | undefined;
    let optionsSeen: Record<string, unknown> | undefined;
    const { handle } = createQueryHandle([
      { type: "system", subtype: "init", session_id: "claude-session-1" },
      { type: "assistant", message: { content: [{ type: "text", text: "Ready" }] } },
      { type: "result", subtype: "success", session_id: "claude-session-1", duration_ms: 12, total_cost_usd: 0.1, num_turns: 1, result: "done" },
    ]);
    const harness = new ClaudeCodeHarness({
      startup: async ({ options }) => {
        calls.startup += 1;
        optionsSeen = options as Record<string, unknown>;
        return {
          query(prompt) {
            promptSeen = prompt;
            return handle as any;
          },
          close() {},
        };
      },
    });

    const messages = await collectMessages(harness.launch({
      prompt: "ship it",
      cwd: "/tmp/project",
      permissionMode: "plan",
    }));

    assert.equal(calls.startup, 1);
    assert.equal(promptSeen, "ship it");
    assert.equal(optionsSeen?.cwd, "/tmp/project");
    assert.equal(optionsSeen?.permissionMode, "plan");
    assert.equal(messages.some((message) => message.type === "backend_ref"), true);
    assert.equal(messages.at(-1)?.type, "run_completed");
  });

  it("preserves the pre-0.3.267 custom system prompt snapshot behavior", async () => {
    let optionsSeen: Record<string, unknown> | undefined;
    const { handle } = createQueryHandle([OK_RESULT]);
    const harness = harnessWith(handle, (options) => { optionsSeen = options; });

    await collectMessages(harness.launch({
      prompt: "follow the custom prompt",
      cwd: "/tmp/project",
      systemPrompt: "custom system prompt",
    }));

    assert.deepEqual(optionsSeen?.systemPrompt, {
      type: "custom",
      prompt: "custom system prompt",
      snapshot: false,
    });
  });

  it("keeps plan-mode writes denied when the SDK routes them through canUseTool", async () => {
    const { session, canUseTool, finish } = await launchForCanUseTool("plan");

    const denied = await canUseTool("Write", { file_path: "/tmp/project/output.txt" });
    assert.equal(denied.behavior, "deny");
    assert.match(denied.message, /Plan mode is active/);

    await session.setPermissionMode?.("bypassPermissions");
    assert.deepEqual(await canUseTool("Write", { file_path: "/tmp/project/output.txt" }), {
      behavior: "allow",
      updatedInput: { file_path: "/tmp/project/output.txt" },
    });
    await finish();
  });

  it("holds ExitPlanMode as a native plan request and approves it with a session mode switch", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "oca-claude-config-"));
    mkdirSync(join(configDir, "plans"));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const planPath = join(configDir, "plans", "p.md");
    const { session, canUseTool, messages, finish } = await launchForCanUseTool("plan");
    const input = { plan: "# Plan\n1. Edit src/a.ts", planFilePath: planPath };
    const decision = canUseTool("ExitPlanMode", input, {
      signal: new AbortController().signal,
      requestId: "req-plan-1",
      toolUseID: "tool-plan-1",
    });
    await new Promise((resolve) => setImmediate(resolve));

    const request = messages.find((message) => message.type === "plan_approval_requested");
    assert.ok(request && request.type === "plan_approval_requested");
    assert.equal(request.request.requestId, "req-plan-1");
    assert.equal(request.request.artifact.markdown, "# Plan\n1. Edit src/a.ts");
    assert.equal(request.request.planFilePath, planPath);

    assert.equal(await session.resolvePlanDecision?.({ kind: "approve", permissionMode: "bypassPermissions" }), true);
    assert.deepEqual(await decision, {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
    });
    assert.equal(await session.resolvePlanDecision?.({ kind: "approve", permissionMode: "bypassPermissions" }), false);

    // After approval the harness leaves plan mode, so tools are allowed again.
    assert.equal((await canUseTool("Write", { file_path: "a" })).behavior, "allow");
    await finish();
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("falls back to the plan file this session wrote when ExitPlanMode carries no plan", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "oca-claude-config-"));
    const project = mkdtempSync(join(tmpdir(), "oca-claude-project-"));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      mkdirSync(join(configDir, "plans"));
      const ownPlan = join(configDir, "plans", "own.md");
      writeFileSync(ownPlan, "# Own plan");
      assert.equal(planFileWrittenByTool("Write", { file_path: ownPlan }, [project]), realpathSync(ownPlan));
      assert.equal(planFileWrittenByTool("Read", { file_path: ownPlan }, [project]), undefined);
      assert.equal(planFileWrittenByTool("Write", { file_path: join(project, "notes.md") }, [project]), undefined);

      const { canUseTool, messages, finish } = await launchForCanUseTool("plan", { cwd: project }, [
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: ownPlan, content: "# Own plan" } }] } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
      ]);
      // A concurrent session writes a newer plan into the shared plans directory.
      writeFileSync(join(configDir, "plans", "other-session.md"), "# Someone else's plan");
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      void canUseTool("ExitPlanMode", {}, {
        signal: new AbortController().signal, requestId: "req-fallback", toolUseID: "tool-fallback",
      });
      await new Promise((resolve) => setImmediate(resolve));
      const request = messages.find((message) => message.type === "plan_approval_requested");
      assert.ok(request && request.type === "plan_approval_requested");
      assert.equal(request.request.artifact.markdown, "# Own plan");
      await finish();
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      rmSync(configDir, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("does not fall back to an older plan file when the plan revision write failed", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "oca-claude-config-"));
    const project = mkdtempSync(join(tmpdir(), "oca-claude-project-"));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      mkdirSync(join(configDir, "plans"));
      const plan = join(configDir, "plans", "plan.md");
      writeFileSync(plan, "# Stale plan v1");
      const { canUseTool, messages, finish } = await launchForCanUseTool("plan", { cwd: project }, [
        { type: "assistant", message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: plan, content: "# v1" } }] } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "w2", name: "Edit", input: { file_path: plan, old_string: "v1", new_string: "v2" } }] } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "w2", content: "String not found", is_error: true }] } },
      ]);
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      void canUseTool("ExitPlanMode", {}, {
        signal: new AbortController().signal, requestId: "req-failed-write", toolUseID: "tool-failed-write",
      });
      await new Promise((resolve) => setImmediate(resolve));
      const request = messages.find((message) => message.type === "plan_approval_requested");
      assert.ok(request && request.type === "plan_approval_requested");
      assert.equal(request.request.artifact.markdown, "", "a failed revision must not surface the stale plan");
      await finish();
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      rmSync(configDir, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("only reads and publishes plan files inside Claude plans directories", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "oca-claude-config-"));
    const project = mkdtempSync(join(tmpdir(), "oca-claude-project-"));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    try {
      mkdirSync(join(configDir, "plans"));
      mkdirSync(join(project, ".claude", "plans"), { recursive: true });
      writeFileSync(join(configDir, "plans", "user.md"), "# User plan");
      writeFileSync(join(project, ".claude", "plans", "project.md"), "# Project plan");
      writeFileSync(join(project, "secret.md"), "TOKEN=abc");
      symlinkSync(join(project, "secret.md"), join(configDir, "plans", "escape.md"));

      assert.ok(trustedPlanFilePath(join(configDir, "plans", "user.md"), [project]));
      assert.ok(trustedPlanFilePath(join(project, ".claude", "plans", "project.md"), [project]));
      assert.equal(trustedPlanFilePath(join(project, "secret.md"), [project]), undefined);
      assert.equal(trustedPlanFilePath(join(configDir, "plans", "escape.md"), [project]), undefined, "symlinks cannot escape");
      assert.equal(trustedPlanFilePath(join(configDir, "plans", "..", "settings.md"), [project]), undefined);
      assert.equal(trustedPlanFilePath("/etc/passwd", [project]), undefined);
      assert.equal(trustedPlanFilePath("plans/p.md", [project]), undefined, "relative paths are rejected");

      const { canUseTool, messages, session, finish } = await launchForCanUseTool("plan", { cwd: project });
      void canUseTool("ExitPlanMode", { plan: "", planFilePath: join(project, "secret.md") }, {
        signal: new AbortController().signal, requestId: "req-untrusted", toolUseID: "tool-untrusted",
      });
      await new Promise((resolve) => setImmediate(resolve));
      const untrusted = messages.find((message) => message.type === "plan_approval_requested");
      assert.ok(untrusted && untrusted.type === "plan_approval_requested");
      assert.equal(untrusted.request.artifact.markdown, "", "untrusted file contents are never read");
      assert.equal(untrusted.request.planFilePath, undefined);

      await session.resolvePlanDecision?.({ kind: "revise", feedback: "again" });
      void canUseTool("ExitPlanMode", { plan: "", planFilePath: join(project, ".claude", "plans", "project.md") }, {
        signal: new AbortController().signal, requestId: "req-trusted", toolUseID: "tool-trusted",
      });
      await new Promise((resolve) => setImmediate(resolve));
      const trusted = messages.filter((message) => message.type === "plan_approval_requested").at(-1);
      assert.ok(trusted && trusted.type === "plan_approval_requested");
      assert.equal(trusted.request.artifact.markdown, "# Project plan");
      await finish();
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      rmSync(configDir, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("returns plan revision feedback as the ExitPlanMode denial", async () => {
    const { session, canUseTool, finish } = await launchForCanUseTool("plan");
    const decision = canUseTool("ExitPlanMode", { plan: "draft" }, {
      signal: new AbortController().signal,
      requestId: "req-plan-2",
      toolUseID: "tool-plan-2",
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await session.resolvePlanDecision?.({ kind: "revise", feedback: "Add a rollback step." }), true);
    const result = await decision;
    assert.equal(result.behavior, "deny");
    assert.match(result.message, /requested changes/);
    assert.match(result.message, /User feedback:\nAdd a rollback step\./);
    assert.match(result.message, /call ExitPlanMode again/);
    assert.equal(result.interrupt, undefined);
    await finish();
  });

  it("cancels a held plan request when the SDK aborts the permission prompt", async () => {
    const { session, canUseTool, finish } = await launchForCanUseTool("plan");
    const abort = new AbortController();
    const decision = canUseTool("ExitPlanMode", { plan: "draft" }, { signal: abort.signal, requestId: "req-plan-3", toolUseID: "tool-plan-3" });
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    const result = await decision;
    assert.equal(result.behavior, "deny");
    assert.equal(result.interrupt, true);
    assert.equal(await session.resolvePlanDecision?.({ kind: "revise", feedback: "late" }), false);
    await finish();
  });

  it("allows ExitPlanMode immediately outside plan mode", async () => {
    const { canUseTool, messages, finish } = await launchForCanUseTool("bypassPermissions");
    const result = await canUseTool("ExitPlanMode", { plan: "x" }, { signal: new AbortController().signal, requestId: "r", toolUseID: "t" });
    assert.equal(result.behavior, "allow");
    assert.equal(messages.some((message) => message.type === "plan_approval_requested"), false);
    await finish();
  });

  it("passes configured reasoning effort to Claude Code without inventing a default", async () => {
    const seenOptions: Record<string, unknown>[] = [];
    const { handle } = createQueryHandle([OK_RESULT]);
    await collectMessages(harnessWith(handle, (options) => seenOptions.push(options)).launch({
      prompt: "think harder",
      cwd: "/tmp/project",
      reasoningEffort: "xhigh",
    }));
    assert.equal(seenOptions[0]?.effort, "xhigh");

    const { handle: defaultHandle } = createQueryHandle([OK_RESULT]);
    await collectMessages(harnessWith(defaultHandle, (options) => seenOptions.push(options)).launch({
      prompt: "use default effort",
      cwd: "/tmp/project",
    }));
    assert.equal(Object.hasOwn(seenOptions[1] ?? {}, "effort"), false);
  });

  it("reports the effort Claude Code applies from system/init", async () => {
    const { handle } = createQueryHandle([
      { type: "system", subtype: "init", session_id: "claude-effort", model: "claude-opus-5-5", effort: "high" },
      OK_RESULT,
    ]);
    const messages = await collectAll(harnessWith(handle).launch({ prompt: "x", cwd: "/tmp", model: "opus", reasoningEffort: "max" }));
    const info = messages.find((message) => message.type === "backend_info");
    assert.ok(info && info.type === "backend_info");
    assert.deepEqual(info.info, { model: "claude-opus-5-5", reasoningEffort: "high", reasoningEffortSupported: false });
  });

  it("falls back to supportedModels() effort levels when init omits the effort", async () => {
    const { handle } = createQueryHandle([
      { type: "system", subtype: "init", session_id: "claude-effort", model: "claude-haiku-4-5-20251001" },
      OK_RESULT,
    ], {
      supportedModels: async () => [
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
        { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "" },
      ],
    });
    const messages = await collectAll(harnessWith(handle).launch({ prompt: "x", cwd: "/tmp", model: "haiku", reasoningEffort: "low" }));
    const info = messages.find((message) => message.type === "backend_info");
    assert.ok(info && info.type === "backend_info");
    assert.equal(info.info.model, "claude-haiku-4-5-20251001");
    assert.equal(info.info.reasoningEffortSupported, undefined, "no effort data means no claim either way");

    const { handle: opusHandle } = createQueryHandle([
      { type: "system", subtype: "init", session_id: "claude-effort", model: "claude-opus-5-5" },
      OK_RESULT,
    ], {
      supportedModels: async () => [
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "", supportedEffortLevels: ["low", "medium", "high"] },
      ],
    });
    const opusMessages = await collectAll(harnessWith(opusHandle).launch({ prompt: "x", cwd: "/tmp", model: "opus", reasoningEffort: "max" }));
    const opusInfo = opusMessages.find((message) => message.type === "backend_info");
    assert.ok(opusInfo && opusInfo.type === "backend_info");
    assert.equal(opusInfo.info.reasoningEffortSupported, false);
  });

  it("validates resume targets with getSessionInfo() and preserves the backend ref", async () => {
    const seenOptions: Record<string, unknown>[] = [];
    const lookedUp: string[] = [];
    const { handle } = createQueryHandle([
      { type: "system", subtype: "init", session_id: "claude-resume-session" },
      { type: "result", subtype: "success", session_id: "claude-resume-session", duration_ms: 0, total_cost_usd: 0, num_turns: 1, result: "resumed" },
    ]);
    const harness = harnessWith(handle, (options) => seenOptions.push(options), {
      getSessionInfo: async (sessionId: string) => {
        lookedUp.push(sessionId);
        return { sessionId, summary: "", lastModified: 0 };
      },
    });

    const messages = await collectMessages(harness.launch({
      prompt: "continue",
      cwd: "/tmp/project",
      resumeSessionId: "claude-resume-session",
    }));

    assert.deepEqual(lookedUp, ["claude-resume-session"]);
    assert.equal(seenOptions[0]?.resume, "claude-resume-session");
    assert.equal(seenOptions[0]?.forkSession, false);
    const ref = messages.find((message) => message.type === "backend_ref");
    assert.equal(ref?.type, "backend_ref");
    assert.equal(ref?.ref.conversationId, "claude-resume-session");
  });

  it("fails a resume clearly when the Claude transcript no longer exists", async () => {
    let started = false;
    const harness = new ClaudeCodeHarness({
      startup: async () => {
        started = true;
        throw new Error("should not start");
      },
      getSessionInfo: async () => undefined,
    });
    const messages = await collectMessages(harness.launch({ prompt: "continue", cwd: "/tmp", resumeSessionId: "gone" }));
    const [completion] = completions(messages);
    assert.equal(started, false);
    assert.equal(completion?.data.success, false);
    assert.match(completion?.data.result ?? "", /Claude Code session gone was not found/);
  });

  it("waits for startup() before forwarding control calls to the query handle", async () => {
    let resolveStartup: ((value: { query: () => any; close: () => void }) => void) | undefined;
    const { handle, permissionModes, streamedInputs, wasInterrupted } = createQueryHandle([OK_RESULT]);
    const harness = new ClaudeCodeHarness({
      startup: async () => await new Promise((resolve) => {
        resolveStartup = resolve;
      }),
    });
    const session = harness.launch({
      prompt: "warm start",
      cwd: "/tmp/project",
    });

    const permissionPromise = session.setPermissionMode?.("plan");
    const streamPromise = session.streamInput?.((async function* oneMessage() {
      const message: SDKUserMessage = {
        type: "user",
        message: { role: "user", content: "continue" },
        parent_tool_use_id: null,
      };
      yield message;
    })());
    const interruptPromise = session.interrupt?.();

    resolveStartup?.({ query: () => handle as any, close: () => {} });

    await Promise.all([
      permissionPromise,
      streamPromise,
      interruptPromise,
      collectMessages(session),
    ]);

    assert.deepEqual(permissionModes, ["plan"]);
    assert.equal(streamedInputs.length, 1);
    assert.equal(streamedInputs[0]?.[0]?.type, "user");
    assert.equal(wasInterrupted(), true);
  });

  it("maps Claude error result messages from errors[] when result is absent", async () => {
    const { handle } = createQueryHandle([
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "claude-session-3",
        duration_ms: 9,
        total_cost_usd: 0,
        num_turns: 1,
        is_error: true,
        errors: ["Tool execution failed", "Bash exited with status 1"],
      },
    ]);
    const messages = await collectMessages(harnessWith(handle).launch({ prompt: "break it", cwd: "/tmp/project" }));
    const [result] = completions(messages);

    assert.equal(result?.data.success, false);
    assert.equal(result?.data.outcome, "failed");
    assert.equal(result?.data.outcomeAuthoritative, true);
    assert.equal(result?.data.result, "Tool execution failed\nBash exited with status 1");
  });

  it("fails success-subtype results that carry is_error and reports the assistant error code", async () => {
    const { handle } = createQueryHandle([
      { type: "system", subtype: "init", session_id: "claude-auth" },
      {
        type: "assistant",
        error: "authentication_failed",
        message: { content: [{ type: "text", text: "Invalid API key · Please run /login" }] },
      },
      { type: "result", subtype: "success", is_error: true, session_id: "claude-auth", duration_ms: 1, total_cost_usd: 0, num_turns: 1, result: "Invalid API key · Please run /login" },
    ]);
    const [result] = completions(await collectMessages(harnessWith(handle).launch({ prompt: "x", cwd: "/tmp" })));
    assert.equal(result?.data.success, false);
    assert.equal(result?.data.outcome, "failed");
    assert.equal(result?.data.errorCode, "authentication_failed");
  });

  it("reports startup_failure_reason as the structured error code", async () => {
    const { handle } = createQueryHandle([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "claude-startup",
        duration_ms: 0,
        total_cost_usd: 0,
        num_turns: 0,
        errors: ["Working directory is unavailable"],
        startup_failure_reason: "cwd_unavailable",
      },
    ]);
    const [result] = completions(await collectMessages(harnessWith(handle).launch({ prompt: "x", cwd: "/missing" })));
    assert.equal(result?.data.outcome, "failed");
    assert.equal(result?.data.errorCode, "cwd_unavailable");
  });

  it("maps aborted terminal reasons to an interrupted turn", async () => {
    const { handle } = createQueryHandle([
      { type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools", session_id: "claude-int", duration_ms: 1, total_cost_usd: 0, num_turns: 3, errors: [] },
    ]);
    const [result] = completions(await collectMessages(harnessWith(handle).launch({ prompt: "x", cwd: "/tmp" })));
    assert.equal(result?.data.outcome, "interrupted");
    assert.equal(result?.data.success, false);
    assert.equal(result?.data.errorCode, undefined);
  });

  it("defers results while queued user turns remain and reports per-model cost", async () => {
    const { handle } = createQueryHandle([
      { type: "result", subtype: "success", session_id: "claude-q", duration_ms: 5, total_cost_usd: 0.1, num_turns: 1, result: "first", queued_turn_count: 1 },
      {
        type: "result",
        subtype: "success",
        session_id: "claude-q",
        duration_ms: 9,
        total_cost_usd: 0.3,
        num_turns: 1,
        result: "second",
        queued_turn_count: 0,
        modelUsage: {
          "claude-opus-5-5": { inputTokens: 10, outputTokens: 20, thinkingTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 50, webSearchRequests: 0, costUSD: 0.25, contextWindow: 200000, maxOutputTokens: 32000, canonicalModel: "claude-opus-5-5", costBasis: "list" },
          "claude-haiku-4-5-20251001": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.05, contextWindow: 200000, maxOutputTokens: 32000 },
        },
      },
    ]);
    const messages = await collectAll(harnessWith(handle).launch({ prompt: "x", cwd: "/tmp" }));
    const done = completions(messages);
    assert.equal(done.length, 1);
    assert.equal(done[0]?.data.result, "second");
    assert.equal(done[0]?.data.total_cost_usd, 0.3);
    assert.deepEqual(done[0]?.data.usage?.models?.map((entry) => [entry.model, entry.costUsd, entry.costBasis]), [
      ["claude-opus-5-5", 0.25, "list"],
      ["claude-haiku-4-5-20251001", 0.05, undefined],
    ]);
    assert.equal(done[0]?.data.usage?.models?.[0]?.reasoningTokens, 5);
    assert.equal(done[0]?.data.usage?.models?.[0]?.cacheReadTokens, 100);
  });

  it("skips coalesced background-task results but keeps human-origin empty results", async () => {
    const { handle } = createQueryHandle([
      { type: "result", subtype: "success", session_id: "claude-bg", duration_ms: 1, total_cost_usd: 0, num_turns: 0, result: "", origin: { kind: "task-notification" } },
      { type: "assistant", message: { content: [{ type: "text", text: "Final answer" }] } },
      { type: "result", subtype: "success", session_id: "claude-bg", duration_ms: 20, total_cost_usd: 0.2, num_turns: 2, result: "Final answer" },
    ]);
    const done = completions(await collectAll(harnessWith(handle).launch({ prompt: "finish", cwd: "/tmp/project" })));
    assert.equal(done.length, 1);
    assert.equal(done[0]?.data.result, "Final answer");
    assert.equal(done[0]?.data.num_turns, 2);

    const { handle: emptyHandle } = createQueryHandle([
      { type: "result", subtype: "success", session_id: "claude-empty", duration_ms: 1, total_cost_usd: 0, num_turns: 0, result: "" },
    ]);
    const emptyDone = completions(await collectAll(harnessWith(emptyHandle).launch({ prompt: "/compact", cwd: "/tmp" })));
    assert.equal(emptyDone.length, 1);
    assert.equal(emptyDone[0]?.data.num_turns, 0);
  });

  it("completes with a skipped result when it is the only SDK result", async () => {
    const { handle } = createQueryHandle([
      { type: "result", subtype: "success", session_id: "claude-only", duration_ms: 1, total_cost_usd: 0, num_turns: 0, result: "", origin: { kind: "task-notification" } },
    ]);
    const done = completions(await collectAll(harnessWith(handle).launch({ prompt: "finish", cwd: "/tmp/project" })));
    assert.equal(done.length, 1);
    assert.equal(done[0]?.data.num_turns, 0);
  });

  it("publishes background-task counts and context usage", async () => {
    const { handle } = createQueryHandle([
      { type: "system", subtype: "background_tasks_changed", tasks: [
        { task_id: "a", task_type: "local_bash", description: "dev server" },
        { task_id: "b", task_type: "watcher", description: "watch", ambient: true },
      ] },
      { type: "system", subtype: "session_state_changed", state: "running" },
      { type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "t", message: "denied" },
      OK_RESULT,
    ], {
      // Resolves after the stream has ended: must still reach consumers.
      getContextUsage: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { totalTokens: 42000, maxTokens: 200000 };
      },
    });
    const messages = await collectAll(harnessWith(handle).launch({ prompt: "x", cwd: "/tmp" }));
    const usage = messages.filter((message) => message.type === "usage_updated").map((message) => message.type === "usage_updated" ? message.usage : undefined);
    assert.deepEqual(usage[0], { backgroundTasks: 1 });
    assert.ok(usage.some((entry) => entry?.contextTokens === 42000 && entry.contextWindow === 200000));
    assert.equal(completions(messages)[0]?.data.usage?.backgroundTasks, 1);
    assert.ok(messages.filter((message) => message.type === "activity").length >= 2);
  });

  it("turns tool, subagent and hook progress into throttled activity heartbeats (B14)", async () => {
    const { handle } = createQueryHandle([
      { type: "tool_progress", tool_use_id: "t1", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 30 },
      { type: "tool_progress", tool_use_id: "t1", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 31 },
      { type: "system", subtype: "task_progress", task_id: "a", description: "subagent" },
      OK_RESULT,
    ]);
    const messages = await collectAll(harnessWith(handle).launch({ prompt: "x", cwd: "/tmp" }));
    const activity = messages.filter((message) => message.type === "activity");
    assert.equal(activity.length, 1, "several progress messages within the interval make one heartbeat");
  });

  it("builds user messages without a session id", () => {
    const message = new ClaudeCodeHarness().buildUserMessage("hello", "claude-session");
    assert.deepEqual(message, {
      type: "user",
      message: { role: "user", content: "hello" },
      parent_tool_use_id: null,
    });
  });
});

describe("ClaudeCodeHarness rewind (N23)", () => {
  const user = (uuid: string, content: unknown, parent: string | null = null) => ({ type: "user" as const, uuid, session_id: "s", message: { role: "user", content }, parent_tool_use_id: parent, parent_agent_id: null });
  const assistant = (uuid: string) => ({ type: "assistant" as const, uuid, session_id: "s", message: { role: "assistant", content: [] }, parent_tool_use_id: null, parent_agent_id: null });
  const transcript = [
    user("u1", "first task"),
    assistant("a1"),
    user("r1", [{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
    assistant("a1b"),
    user("u2", [{ type: "text", text: "second task" }]),
    assistant("a2"),
    user("sub", "subagent prompt", "toolu_task"),
    user("u3", "third task"),
    assistant("a3"),
  ];

  it("resumes at the last entry before the prompt of the N-th last turn", () => {
    assert.equal(resolveClaudeRewindPoint(transcript, 1), "a2");
    assert.equal(resolveClaudeRewindPoint(transcript, 2), "a1b", "tool results and subagent messages are not turn prompts");
    assert.throws(() => resolveClaudeRewindPoint(transcript, 3), /would drop the whole Claude Code session/);
    assert.throws(() => resolveClaudeRewindPoint(transcript, 4), /only has 3 turn\(s\)/);
  });

  it("passes resumeSessionAt to the SDK when a resumed launch rewinds", async () => {
    let seenOptions: Record<string, unknown> | undefined;
    const query = createQueryHandle([OK_RESULT]);
    const harness = harnessWith(query.handle, (options) => { seenOptions = options; }, {
      getSessionMessages: async (sessionId: string) => {
        assert.equal(sessionId, "claude-old");
        return transcript;
      },
    });
    await collectMessages(harness.launch({ prompt: "redo", cwd: "/tmp/project", resumeSessionId: "claude-old", forkSession: true, rewindTurns: 1 }));
    assert.equal(seenOptions?.resume, "claude-old");
    assert.equal(seenOptions?.forkSession, true);
    assert.equal(seenOptions?.resumeSessionAt, "a2");
  });
});
