import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { setPluginConfig } from "../src/config";
import { setGoalController, setSessionManager } from "../src/singletons";
import { makeGoalLaunchTool } from "../src/tools/goal-launch";

describe("agent_goal_launch tool", () => {
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
          defaultModel: "gpt-5.5",
          allowedModels: ["gpt-5.5"],
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
    assert.equal(launchConfig?.model, "gpt-5.5");
    assert.equal(launchConfig?.reasoningEffort, "high");
    assert.equal(launchConfig?.permissionMode, "bypassPermissions");
    assert.equal(launchConfig?.originChannel, "discord|123456789");
    assert.equal(launchConfig?.originSessionKey, "agent:main:discord:channel:123456789");
    assert.deepEqual(launchConfig?.verifierCommands, [
      { label: "check-1", command: "npm test" },
      { label: "check-2", command: "npm run lint" },
    ]);

    assert.match((result.content[0] as { text: string }).text, /Goal task launched\./);
    assert.match((result.content[0] as { text: string }).text, /Harness: codex/);
    assert.match((result.content[0] as { text: string }).text, /Max controller iterations: 5/);
    assert.match((result.content[0] as { text: string }).text, /internal agent review passes are reported in the completion summary/);
  });

  it("uses deliveryContext routing on the current SDK surface", async () => {
    let launchConfig: Record<string, unknown> | undefined;

    setPluginConfig({
      defaultHarness: "codex",
      harnesses: {
        codex: {
          defaultModel: "gpt-5.5",
          allowedModels: ["gpt-5.5", "gpt-5.5-pro"],
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

  it("normalizes provider-prefixed Codex model ids before launching a goal task", async () => {
    let launchConfig: Record<string, unknown> | undefined;

    setPluginConfig({
      defaultHarness: "codex",
      harnesses: {
        codex: {
          defaultModel: "gpt-5.5",
          allowedModels: ["gpt-5.5"],
        },
      },
    });

    setGoalController({
      async launchTask(config: Record<string, unknown>) {
        launchConfig = config;
        return {
          id: "goal-codex-model",
          name: "goal-codex-model",
          workdir: config.workdir,
          sessionId: "sess-codex-model",
          sessionName: "goal-codex-model",
          maxIterations: config.maxIterations ?? 8,
          loopMode: config.loopMode ?? "ralph",
          completionPromise: config.completionPromise,
        };
      },
    } as any);

    const tool = makeGoalLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true } as any);

    const result = await tool.execute("tool-id", {
      goal: "Keep Codex model ids canonical",
      model: "openai/gpt-5.5",
    });

    assert.ok(launchConfig, "launchTask should be called");
    assert.equal(launchConfig?.model, "gpt-5.5");
    assert.match((result.content[0] as { text: string }).text, /Model: gpt-5\.5/);
  });

  it("uses agentChannels for the requested workdir when the context lacks a direct route", async () => {
    let launchConfig: Record<string, unknown> | undefined;
    const workdir = process.cwd();

    setPluginConfig({
      defaultHarness: "codex",
      agentChannels: {
        [workdir]: "discord|agent-1|target-1",
      },
      harnesses: {
        codex: {
          defaultModel: "gpt-5.5",
          allowedModels: ["gpt-5.5"],
        },
      },
    });

    setGoalController({
      async launchTask(config: Record<string, unknown>) {
        launchConfig = config;
        return {
          id: "goal-4",
          name: "goal-agent-channel",
          workdir: config.workdir,
          sessionId: "sess-4",
          sessionName: "goal-agent-channel",
          maxIterations: config.maxIterations ?? 8,
          loopMode: config.loopMode ?? "ralph",
          completionPromise: config.completionPromise,
        };
      },
    } as any);

    const tool = makeGoalLaunchTool({} as any);

    await tool.execute("tool-id", {
      goal: "Route through the workspace agent channel",
      workdir,
    });

    assert.ok(launchConfig, "launchTask should be called");
    assert.equal(launchConfig?.originChannel, "discord|agent-1|target-1");
    assert.equal((launchConfig?.route as { accountId?: string } | undefined)?.accountId, "agent-1");
  });

  it("fails closed for a route-less deferred plugin-tool bridge context", async () => {
    let launchCalled = false;
    setGoalController({
      async launchTask() {
        launchCalled = true;
        throw new Error("must not launch");
      },
    } as any);

    const tool = makeGoalLaunchTool({ config: {} } as any);
    const result = await tool.execute("nested-tool-id", {
      goal: "Run an asynchronous goal through the nested bridge",
      workdir: "/tmp",
    });

    assert.equal(launchCalled, false);
    assert.match(
      (result.content[0] as { text: string }).text,
      /did not provide a trustworthy lifecycle delivery route/,
    );
  });

  it("preserves an intentional cron/system launch", async () => {
    let launchConfig: Record<string, unknown> | undefined;
    setGoalController({
      async launchTask(config: Record<string, unknown>) {
        launchConfig = config;
        return {
          id: "goal-cron",
          name: "goal-cron",
          workdir: config.workdir,
          sessionId: "sess-cron",
          sessionName: "goal-cron",
          maxIterations: 8,
          loopMode: "ralph",
        };
      },
    } as any);

    const sessionKey = "agent:main:cron:nightly-verification";
    const tool = makeGoalLaunchTool({ workspaceDir: "/tmp", sessionKey } as any);
    await tool.execute("cron-tool-id", { goal: "Run nightly verification" });

    assert.equal((launchConfig?.route as { provider?: string })?.provider, "system");
    assert.equal((launchConfig?.route as { target?: string })?.target, "system");
    assert.equal(launchConfig?.originSessionKey, sessionKey);
  });

  it("allows experimental OpenCode goal tasks to use the OpenCode provider default model", async () => {
    let launchConfig: Record<string, unknown> | undefined;

    setPluginConfig({
      defaultHarness: "opencode",
    });

    setGoalController({
      async launchTask(config: Record<string, unknown>) {
        launchConfig = config;
        return {
          id: "goal-3",
          name: "goal-opencode",
          workdir: config.workdir,
          sessionId: "sess-3",
          sessionName: "goal-opencode",
          maxIterations: config.maxIterations ?? 8,
          loopMode: config.loopMode ?? "ralph",
          completionPromise: config.completionPromise,
        };
      },
    } as any);

    const tool = makeGoalLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true } as any);

    const result = await tool.execute("tool-id", {
      goal: "Keep going until DONE",
    });

    assert.ok(launchConfig, "launchTask should be called");
    assert.equal(launchConfig?.harness, "opencode");
    assert.equal(launchConfig?.model, undefined);
    assert.match((result.content[0] as { text: string }).text, /Harness: opencode/);
    assert.match((result.content[0] as { text: string }).text, /Model: default/);
  });
});
