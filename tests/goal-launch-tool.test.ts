import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { setPluginConfig } from "../src/config";
import { setGoalController, setSessionManager } from "../src/singletons";
import { makeGoalLaunchTool } from "../src/tools/goal-launch";

describe("goal_launch tool", () => {
  beforeEach(() => {
    setPluginConfig({});
    setSessionManager(null);
    setGoalController(null);
  });

  it("uses harness-scoped defaults and origin routing when launching a goal task", async () => {
    let launchConfig: Record<string, unknown> | undefined;

    setPluginConfig({
      defaultHarness: "codex",
      harnesses: {
        codex: {
          defaultModel: "gpt-5.4",
          allowedModels: ["gpt-5.4"],
          reasoningEffort: "high",
        },
      },
    });

    setGoalController({
      async launchTask(config: Record<string, unknown>) {
        launchConfig = config;
        return {
          id: "goal-1",
          name: "goal-auth",
          workdir: config.workdir,
          sessionId: "sess-1",
          sessionName: "goal-auth",
          maxIterations: config.maxIterations ?? 8,
          loopMode: config.loopMode ?? "verifier",
          completionPromise: config.completionPromise,
        };
      },
    } as any);

    const tool = makeGoalLaunchTool({
      workspaceDir: "/tmp",
      sessionKey: "agent:main:discord:channel:123456789",
      messageChannel: "discord",
      chatId: "123456789",
    } as any);

    const result = await tool.execute("tool-id", {
      goal: "Make tests pass",
      verifier_commands: ["npm test", "npm run lint"],
      max_iterations: 5,
    });

    assert.ok(launchConfig, "launchTask should be called");
    assert.equal(launchConfig?.harness, "codex");
    assert.equal(launchConfig?.model, "gpt-5.4");
    assert.equal(launchConfig?.reasoningEffort, "high");
    assert.equal(launchConfig?.permissionMode, "bypassPermissions");
    assert.equal(launchConfig?.originChannel, "discord|123456789");
    assert.equal(launchConfig?.originSessionKey, "agent:main:discord:channel:123456789");
    assert.deepEqual(launchConfig?.verifierCommands, [
      { label: "check-1", command: "npm test" },
      { label: "check-2", command: "npm run lint" },
    ]);

    assert.match((result.content[0] as { text: string }).text, /Goal task launched successfully/);
    assert.match((result.content[0] as { text: string }).text, /Harness: codex/);
    assert.match((result.content[0] as { text: string }).text, /Max iterations: 5/);
  });

  it("uses deliveryContext routing on the current SDK surface", async () => {
    let launchConfig: Record<string, unknown> | undefined;

    setPluginConfig({
      defaultHarness: "codex",
      harnesses: {
        codex: {
          defaultModel: "gpt-5.4",
          allowedModels: ["gpt-5.4", "gpt-5.4-pro"],
          reasoningEffort: "high",
        },
      },
    });

    setGoalController({
      async launchTask(config: Record<string, unknown>) {
        launchConfig = config;
        return {
          id: "goal-2",
          name: "goal-routing",
          workdir: config.workdir,
          sessionId: "sess-2",
          sessionName: "goal-routing",
          maxIterations: config.maxIterations ?? 8,
          loopMode: config.loopMode ?? "ralph",
          completionPromise: config.completionPromise,
        };
      },
    } as any);

    const tool = makeGoalLaunchTool({
      workspaceDir: "/tmp",
      sessionKey: "agent:main:discord:channel:123456789",
      deliveryContext: {
        channel: "discord",
        to: "123456789",
        accountId: "acct-1",
        threadId: "thread-7",
      },
    } as any);

    await tool.execute("tool-id", {
      goal: "Keep routing stable",
      completion_promise: "DONE",
    });

    assert.ok(launchConfig, "launchTask should be called");
    assert.equal(launchConfig?.originChannel, "discord|acct-1|123456789");
    assert.equal(launchConfig?.originThreadId, "thread-7");
    assert.equal((launchConfig?.route as { accountId?: string } | undefined)?.accountId, "acct-1");
  });
});
