import "./test-env";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { setPluginConfig } from "../src/config";
import { registerGoalCommand } from "../src/commands/goal";
import { setGoalController } from "../src/singletons";

describe("goal command", () => {
  beforeEach(() => {
    setPluginConfig({});
    setGoalController({
      async launchTask() {
        throw new Error("launchTask should not be called for invalid /agent_goal input");
      },
    } as any);
  });

  it("rejects empty verifier commands", async () => {
    let handler: ((ctx: any) => Promise<{ text: string }> | { text: string }) | undefined;
    registerGoalCommand({
      registerCommand(command: { handler: typeof handler }) {
        handler = command.handler;
      },
    });

    const result = await handler?.({
      args: '--verify "" ship the feature',
    });

    assert.equal(result?.text, "Error: --verify commands must not be empty.");
  });

  it("uses shared launch resolution for verifier goals", async () => {
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
    let sameChat: boolean | undefined;
    setGoalController({
      async launchTask(config: Record<string, unknown>, reply: { sameChat: (task: unknown) => boolean; text?: string }) {
        launchConfig = config;
        sameChat = reply.sameChat(config);
        reply.text = "🎯 [goal-command] Goal task started\n\nGoal:\nship the feature";
        return {
          id: "goal-command-1",
          name: "goal-command",
          workdir: config.workdir,
          sessionId: "sess-goal-command",
          sessionName: "goal-command",
          maxIterations: config.maxIterations ?? 8,
          loopMode: config.loopMode,
          completionPromise: config.completionPromise,
        };
      },
    } as any);

    let handler: ((ctx: any) => Promise<{ text: string }> | { text: string }) | undefined;
    registerGoalCommand({
      registerCommand(command: { handler: typeof handler }) {
        handler = command.handler;
      },
    });

    const result = await handler?.({
      args: '--harness codex --max-iterations 3 --verify "pnpm test" ship the feature',
      workspaceDir: "/tmp",
      sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
      deliveryContext: {
        channel: "telegram",
        to: "-1001234567890",
        accountId: "bot1",
        threadId: 13832,
      },
    });

    assert.ok(launchConfig, "launchTask should be called");
    assert.equal(launchConfig?.harness, "codex");
    assert.equal(launchConfig?.model, "gpt-5.5");
    assert.equal(launchConfig?.reasoningEffort, "high");
    assert.equal(launchConfig?.loopMode, "verifier");
    assert.equal(launchConfig?.originChannel, "telegram|bot1|-1001234567890");
    assert.deepEqual(launchConfig?.verifierCommands, [{ label: "check-1", command: "pnpm test" }]);
    // One message: the task's start notice is the reply, without ids.
    assert.equal(sameChat, true, "typed in the chat the task reports to");
    assert.equal(
      result?.text,
      "🎯 [goal-command] Goal task started\n\nGoal:\nship the feature\n\nFollow it with /agent_goal status goal-command; stop it with /agent_goal stop goal-command.",
    );
  });

  it("reports a goal that failed to start once", async () => {
    setPluginConfig({ defaultHarness: "codex", harnesses: { codex: { defaultModel: "gpt-5.5", allowedModels: ["gpt-5.5"] } } });
    let handler: ((ctx: any) => Promise<{ text: string }> | { text: string }) | undefined;
    registerGoalCommand({
      registerCommand(command: { handler: typeof handler }) {
        handler = command.handler;
      },
    });
    const ctx = { args: '--verify "pnpm test" ship the feature', workspaceDir: "/tmp", deliveryContext: { channel: "telegram", to: "-1001234567890" } };

    setGoalController({
      async launchTask(_config: unknown, reply: { text?: string }) {
        reply.text = "❌ [ship-the-feature] Goal task failed\n\nFailed to start the goal task: no harness";
        throw new Error("no harness");
      },
    } as any);
    assert.equal((await handler?.(ctx))?.text, "❌ [ship-the-feature] Goal task failed\n\nFailed to start the goal task: no harness");

    setGoalController({ async launchTask() { throw new Error("no verifiers"); } } as any);
    assert.equal((await handler?.(ctx))?.text, "❌ Goal task did not start: no verifiers");
  });

  it("uses agentChannels for the requested workdir when the context lacks a direct route", async () => {
    let launchConfig: Record<string, unknown> | undefined;
    const workdir = process.cwd();

    setPluginConfig({
      defaultHarness: "codex",
      agentChannels: {
        [workdir]: "telegram|bot1|-1001234567890",
      },
      harnesses: {
        codex: {
          defaultModel: "gpt-5.5",
          allowedModels: ["gpt-5.5"],
        },
      },
    });
    let sameChat: boolean | undefined;
    setGoalController({
      async launchTask(config: Record<string, unknown>, reply: { sameChat: (task: unknown) => boolean }) {
        launchConfig = config;
        sameChat = reply.sameChat(config);
        return {
          id: "goal-command-2",
          name: "goal-command-agent-channel",
          workdir: config.workdir,
          sessionId: "sess-goal-command-2",
          sessionName: "goal-command-agent-channel",
          maxIterations: config.maxIterations ?? 8,
          loopMode: config.loopMode,
          completionPromise: config.completionPromise,
        };
      },
    } as any);

    let handler: ((ctx: any) => Promise<{ text: string }> | { text: string }) | undefined;
    registerGoalCommand({
      registerCommand(command: { handler: typeof handler }) {
        handler = command.handler;
      },
    });

    const result = await handler?.({
      args: `--workdir ${workdir} keep routing stable`,
    });

    assert.ok(launchConfig, "launchTask should be called");
    assert.equal(launchConfig?.originChannel, "telegram|bot1|-1001234567890");
    assert.equal((launchConfig?.route as { accountId?: string } | undefined)?.accountId, "bot1");
    // The command's own chat is unknown, so the notice still goes to the configured channel.
    assert.equal(sameChat, false);
    assert.match(result?.text ?? "", /^🎯 \[goal-command-agent-channel\] Goal task started\n\nFollow it with \/agent_goal status goal-command-agent-channel;/);
  });
});
