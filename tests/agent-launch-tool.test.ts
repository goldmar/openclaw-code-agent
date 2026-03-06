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
});
