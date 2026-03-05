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
      defaultModel: "sonnet",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-1",
          name: "codex-defaults",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    const result = await tool.execute("tool-id", { prompt: "Ship it" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.harness, "codex");
    assert.equal(spawnConfig?.model, "gpt-5.3-codex");
    assert.equal(spawnConfig?.reasoningEffort, "high");
    assert.match((result.content[0] as { text: string }).text, /Model: gpt-5\.3-codex/);
  });

  it("prefers an explicit model over plugin Codex model", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      defaultHarness: "codex",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    setSessionManager({
      resolveHarnessSessionId: (id: string) => id,
      spawn(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-2",
          name: "codex-explicit",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp" });
    await tool.execute("tool-id", { prompt: "Ship it", model: "gpt-5.4" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.model, "gpt-5.4");
    assert.equal(spawnConfig?.reasoningEffort, "high");
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
});
