import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeAgentLaunchTool } from "../src/tools/agent-launch";
import { setPluginConfig } from "../src/config";
import { setSessionManager } from "../src/singletons";

describe("agent_launch tool defaults", () => {
  beforeEach(() => {
    setPluginConfig({});
    setSessionManager(null);
  });

  it("uses plugin Codex model and reasoningEffort defaults when no model is provided", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      defaultHarness: "codex",
      harnesses: {
        codex: {
          defaultModel: "gpt-5.3-codex",
          allowedModels: ["gpt-5.3-codex", "gpt-5.4"],
          reasoningEffort: "high",
          approvalPolicy: "on-request",
        },
      },
    });

    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-1",
          name: "codex-defaults",
          model: config.model,
          codexApprovalPolicy: config.codexApprovalPolicy,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "Ship it" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.harness, "codex");
    assert.equal(spawnConfig?.model, "gpt-5.3-codex");
    assert.equal(spawnConfig?.reasoningEffort, "high");
    assert.equal(spawnConfig?.codexApprovalPolicy, "on-request");
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Harness: codex/);
    assert.match(text, /Permission mode: plan/);
    assert.match(text, /Plan approval: ask/);
    assert.match(text, /Worktree strategy: ask/);
    assert.match(text, /Model: gpt-5\.3-codex/);
    assert.match(text, /Codex approval policy: on-request/);
  });

  it("prefers an explicit model while keeping the plugin Codex approval policy", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      defaultHarness: "codex",
      harnesses: {
        codex: {
          defaultModel: "gpt-5.3-codex",
          allowedModels: ["gpt-5.3-codex", "gpt-5.4"],
          reasoningEffort: "high",
          approvalPolicy: "never",
        },
      },
    });

    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-2",
          name: "codex-explicit",
          model: config.model,
          codexApprovalPolicy: config.codexApprovalPolicy,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    await tool.execute("tool-id", { prompt: "Ship it", model: "gpt-5.4" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.model, "gpt-5.4");
    assert.equal(spawnConfig?.reasoningEffort, "high");
    assert.equal(spawnConfig?.codexApprovalPolicy, "never");
  });

  it("passes the resolved permission mode into spawn when the caller omits permission_mode", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      permissionMode: "bypassPermissions",
    });

    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-permission-mode",
          name: "resolved-permission-mode",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    await tool.execute("tool-id", { prompt: "Inspect only" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.permissionMode, "bypassPermissions");
  });

  it("captures Telegram group chat and topic metadata from tool context", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-3",
          name: "telegram-topic",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({
      workspaceDir: "/tmp",
      messageChannel: "telegram",
      chatId: "-1003863755361",
      messageThreadId: 28,
    } as any);
    await tool.execute("tool-id", { prompt: "Ping the topic" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.originChannel, "telegram|-1003863755361");
    assert.equal(spawnConfig?.originThreadId, 28);
  });

  it("falls back to an explicit system route when the tool context has no chat metadata", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-system-route",
          name: "system-route",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" } as any);
    const result = await tool.execute("tool-id", { prompt: "Launch without explicit chat metadata" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal((spawnConfig?.route as { provider?: string } | undefined)?.provider, "system");
    assert.equal((spawnConfig?.route as { target?: string } | undefined)?.target, "system");
    assert.match((result.content[0] as { text: string }).text, /Session launched successfully/);
  });

  it("clears persisted Codex resume state before spawn", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolve: () => undefined,
      getPersistedSession: () => ({ harness: "codex" }),
      resolveHarnessSessionId: (id: string) => `resolved-${id}`,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-4",
          name: "codex-restart",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", {
      prompt: "Continue after restart",
      harness: "codex",
      resume_session_id: "old-thread",
      fork_session: true,
    });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.resumeSessionId, undefined);
    assert.equal(spawnConfig?.forkSession, false);
    assert.match((result.content[0] as { text: string }).text, /historical Codex state cleared/);
  });

  it("keeps active Codex resume state before spawn", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolve: () => ({ harnessSessionId: "resolved-old-thread" }),
      getPersistedSession: () => ({ harness: "codex" }),
      resolveHarnessSessionId: (id: string) => `resolved-${id}`,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-5",
          name: "codex-live",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    await tool.execute("tool-id", {
      prompt: "Continue active session",
      harness: "codex",
      resume_session_id: "old-thread",
    });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.resumeSessionId, "resolved-old-thread");
  });

  it("reuses the original OpenClaw session ID when resuming a stopped session without fork", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolve: () => undefined,
      getPersistedSession: () => ({
        sessionId: "sess-stable",
        harnessSessionId: "resolved-old-thread",
        name: "stable-session",
        status: "killed",
        lifecycle: "terminal",
        killReason: "shutdown",
        backendRef: { kind: "codex-app-server", conversationId: "resolved-old-thread" },
      }),
      resolveHarnessSessionId: (id: string) => `resolved-${id}`,
      resolveBackendConversationId: (id: string) => `resolved-${id}`,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-stable",
          name: "stable-session",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", {
      prompt: "Continue stable session",
      harness: "codex",
      resume_session_id: "old-thread",
    });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.sessionIdOverride, "sess-stable");
    assert.equal(spawnConfig?.resumeSessionId, "resolved-old-thread");
    assert.match((result.content[0] as { text: string }).text, /ID: sess-stable/);
  });

  it("rejects non-fork resume attempts for completed sessions", async () => {
    setSessionManager({
      resolve: () => undefined,
      getPersistedSession: () => ({
        sessionId: "sess-done",
        harnessSessionId: "resolved-old-thread",
        name: "done-session",
        status: "completed",
        lifecycle: "terminal",
        killReason: "done",
        backendRef: { kind: "codex-app-server", conversationId: "resolved-old-thread" },
      }),
      resolveHarnessSessionId: (id: string) => `resolved-${id}`,
      resolveBackendConversationId: (id: string) => `resolved-${id}`,
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", {
      prompt: "Continue closed session",
      harness: "codex",
      resume_session_id: "old-thread",
    });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Resume unavailable/);
    assert.match(text, /completed/);
    assert.match(text, /fork_session=true/);
  });

  it("forwards per-session plan_approval override to spawn", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setPluginConfig({
      planApproval: "delegate",
    });

    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-6",
          name: "session-plan-approval",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    await tool.execute("tool-id", {
      prompt: "Ship it",
      plan_approval: "ask",
    });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.planApproval, "ask");
  });

  it("uses Workdir from the prompt when no explicit workdir parameter is provided", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    const repoDir = mkdtempSync(join(tmpdir(), "agent-launch-workdir-"));
    try {
      setSessionManager({
        resolveHarnessSessionId: (id: string) => id,
        spawn(config: Record<string, unknown>) {
          spawnConfig = config;
          return {
            id: "sess-workdir",
            name: "prompt-workdir",
            model: config.model,
          };
        },
      } as any);

      const tool = makeAgentLaunchTool({ workspaceDir: "/tmp/orchestrator-workspace" });
      await tool.execute("tool-id", {
        prompt: `Workdir: ${repoDir}\nRepo: ${repoDir}\n\nInvestigate the bug.`,
      });

      assert.ok(spawnConfig, "spawn should be called");
      assert.equal(spawnConfig?.workdir, repoDir);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not scan ordinary prompt body text for workdir metadata", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    const repoDir = mkdtempSync(join(tmpdir(), "agent-launch-body-workdir-"));
    const fallbackDir = mkdtempSync(join(tmpdir(), "agent-launch-fallback-workdir-"));
    try {
      setSessionManager({
        resolveHarnessSessionId: (id: string) => id,
        spawn(config: Record<string, unknown>) {
          spawnConfig = config;
          return {
            id: "sess-body-workdir",
            name: "body-workdir",
            model: config.model,
          };
        },
      } as any);

      const tool = makeAgentLaunchTool({ workspaceDir: fallbackDir });
      await tool.execute("tool-id", {
        prompt: `Investigate the bug.\n\nThe notes say Repo: ${repoDir} but that should not be parsed as launch metadata.`,
      });

      assert.ok(spawnConfig, "spawn should be called");
      assert.equal(spawnConfig?.workdir, fallbackDir);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(fallbackDir, { recursive: true, force: true });
    }
  });

  it("blocks a fresh launch when a linked resumable session already exists", async () => {
    let spawnCalled = false;

    setSessionManager({
      list: () => [],
      listPersistedSessions: () => [{
        sessionId: "sess-resume",
        harnessSessionId: "h-resume",
        name: "existing-linked",
        prompt: "old prompt",
        workdir: "/tmp",
        status: "killed",
        lifecycle: "suspended",
        costUsd: 0,
        originSessionKey: "agent:main:telegram:group:123:topic:42",
        resumable: true,
      }],
      spawn() {
        spawnCalled = true;
        return { id: "should-not-spawn", name: "bad" };
      },
    } as any);

    const tool = makeAgentLaunchTool({
      workspaceDir: "/tmp",
      sessionKey: "agent:main:telegram:group:123:topic:42",
      messageChannel: "telegram",
      chatId: "123",
      messageThreadId: 42,
    } as any);
    const result = await tool.execute("tool-id", { prompt: "Continue the work" });
    const text = (result.content[0] as { text: string }).text;

    assert.equal(spawnCalled, false);
    assert.match(text, /Resume-first protection blocked a fresh launch/);
    assert.match(text, /agent_respond\(session='sess-resume'/);
    assert.match(text, /force_new_session=true/);
  });

  it("allows an explicit force_new_session override for linked resumable sessions", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      list: () => [],
      listPersistedSessions: () => [{
        sessionId: "sess-resume",
        harnessSessionId: "h-resume",
        name: "existing-linked",
        prompt: "old prompt",
        workdir: "/tmp",
        status: "killed",
        lifecycle: "suspended",
        costUsd: 0,
        originSessionKey: "agent:main:telegram:group:123:topic:42",
        resumable: true,
      }],
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-7",
          name: "forced-new",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({
      workspaceDir: "/tmp",
      sessionKey: "agent:main:telegram:group:123:topic:42",
      messageChannel: "telegram",
      chatId: "123",
      messageThreadId: 42,
    } as any);
    const result = await tool.execute("tool-id", {
      prompt: "New independent task",
      force_new_session: true,
    });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.prompt, "New independent task");
    assert.match((result.content[0] as { text: string }).text, /Force new session: true/);
  });
});

describe("agent_launch allowedModels validation", () => {
  beforeEach(() => {
    setPluginConfig({});
    setSessionManager(null);
  });

  it("allows model when allowedModels is not configured", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      harnesses: {
        "claude-code": {
          defaultModel: "sonnet",
          allowedModels: undefined,
        },
      },
    });
    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "test", model: "anthropic/claude-opus-4-6" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "anthropic/claude-opus-4-6");
    assert.match((result.content[0] as { text: string }).text, /Session launched successfully/);
  });

  it("allows model when allowedModels is empty array", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      harnesses: {
        "claude-code": {
          defaultModel: "sonnet",
          allowedModels: [],
        },
      },
    });
    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "test", model: "anthropic/claude-opus-4-6" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "anthropic/claude-opus-4-6");
    assert.match((result.content[0] as { text: string }).text, /Session launched successfully/);
  });

  it("allows explicit model matching allowedModels pattern (case-insensitive)", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({ harnesses: { "claude-code": { allowedModels: ["sonnet", "opus"] } } });
    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "test", model: "anthropic/claude-SONNET-4-6" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "anthropic/claude-SONNET-4-6");
    assert.match((result.content[0] as { text: string }).text, /Session launched successfully/);
  });

  it("allows explicit model with substring match", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({ harnesses: { "claude-code": { allowedModels: ["sonnet"] } } });
    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "test", model: "claude-sonnet-4-6" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "claude-sonnet-4-6");
    assert.match((result.content[0] as { text: string }).text, /Session launched successfully/);
  });

  it("blocks explicit model not in allowedModels", async () => {
    setPluginConfig({ harnesses: { "claude-code": { allowedModels: ["sonnet"] } } });
    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "test", model: "anthropic/claude-opus-4-6" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Error: Model "anthropic\/claude-opus-4-6" is not allowed/);
    assert.match(text, /Permitted models: sonnet/);
  });

  it("blocks explicit model with multiple allowedModels shown", async () => {
    setPluginConfig({ harnesses: { "claude-code": { allowedModels: ["sonnet", "opus", "haiku"] } } });
    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "test", model: "gpt-4" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Error: Model "gpt-4" is not allowed/);
    assert.match(text, /Permitted models: sonnet, opus, haiku/);
  });

  it("blocks default model not in allowedModels with config error", async () => {
    setPluginConfig({
      harnesses: {
        "claude-code": {
          defaultModel: "anthropic/claude-opus-4-6",
          allowedModels: ["sonnet", "haiku"],
        },
      },
    });
    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "test" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Error: Default model "anthropic\/claude-opus-4-6" is not in allowedModels \(sonnet, haiku\)\. Update your plugin config to set a compatible defaultModel\./);
  });

  it("allows launch when default model is in allowedModels", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      harnesses: {
        "claude-code": {
          defaultModel: "anthropic/claude-sonnet-4-6",
          allowedModels: ["sonnet", "haiku"],
        },
      },
    });
    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "test" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Session launched successfully/);
    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "anthropic/claude-sonnet-4-6");
  });

  it("handles codex harness model resolution with allowedModels", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      harnesses: {
        codex: {
          defaultModel: "anthropic/claude-opus-4-6",
          allowedModels: ["opus"],
        },
      },
    });
    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "test", harness: "codex" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Session launched successfully/);
    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "anthropic/claude-opus-4-6");
  });

  it("blocks codex harness model when not allowed", async () => {
    setPluginConfig({
      harnesses: {
        codex: {
          defaultModel: "anthropic/claude-opus-4-6",
          allowedModels: ["haiku"],
        },
      },
    });
    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "test", harness: "codex" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Error: Default model "anthropic\/claude-opus-4-6" is not in allowedModels \(haiku\)\. Update your plugin config to set a compatible defaultModel\./);
  });

  it("blocks undefined default model with allowedModels", async () => {
    setPluginConfig({
      harnesses: {
        "claude-code": {
          defaultModel: "haiku",
          allowedModels: ["sonnet"],
        },
      },
    });
    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "test" });

    const text = (result.content[0] as { text: string }).text;
    // mismatched default should trigger error
    assert.match(text, /Error: Default model "haiku" is not in allowedModels \(sonnet\)\. Update your plugin config to set a compatible defaultModel\./);
  });

  it("case-insensitive matching works both ways", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({ harnesses: { "claude-code": { allowedModels: ["SONNET"] } } });
    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "test", model: "claude-sonnet-4-6" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Session launched successfully/);
    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "claude-sonnet-4-6");
  });

  it("partial pattern matching works", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({ harnesses: { "claude-code": { allowedModels: ["claude-son"] } } });
    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "test", model: "anthropic/claude-sonnet-4-6" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Session launched successfully/);
    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "anthropic/claude-sonnet-4-6");
  });
});
