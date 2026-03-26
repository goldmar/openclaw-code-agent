import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
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
    assert.match((result.content[0] as { text: string }).text, /Model: gpt-5\.3-codex/);
    assert.match((result.content[0] as { text: string }).text, /Codex approval policy: on-request/);
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
