import "./test-env";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { setPluginConfig } from "../src/config";
import { registerGoalCommand } from "../src/commands/goal";
import { setGoalController } from "../src/singletons";
import { nativeTopicCommand, textTopicCommand } from "./command-contexts";

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

    assert.equal(result?.text, "❌ --verify commands must not be empty.");
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
          route: config.route,
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
      ...nativeTopicCommand({ topic: 13832 }),
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
    const ctx = { args: '--verify "pnpm test" ship the feature', workspaceDir: "/tmp", ...nativeTopicCommand({ topic: 42 }) };

    // In the task's own chat the controller's notice is the reply (not posted).
    setGoalController({
      async launchTask(_config: unknown, reply: { text?: string; posted?: boolean; taskName?: string }) {
        Object.assign(reply, { text: "❌ [ship-the-feature] Goal task failed\n\nFailed to start the goal task: no harness", posted: false, taskName: "ship-the-feature" });
        throw new Error("no harness");
      },
    } as any);
    assert.equal((await handler?.(ctx))?.text, "❌ [ship-the-feature] Goal task failed\n\nFailed to start the goal task: no harness");

    // From another chat the notice was posted to the task's chat: a short line here.
    setGoalController({
      async launchTask(_config: unknown, reply: { text?: string; posted?: boolean; taskName?: string }) {
        Object.assign(reply, { text: "❌ [ship-the-feature] Goal task failed\n\nFailed to start the goal task: no harness", posted: true, taskName: "ship-the-feature" });
        throw new Error("no harness");
      },
    } as any);
    assert.equal((await handler?.(ctx))?.text, "❌ [ship-the-feature] Goal task did not start.");

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
    // Not the task's chat: a short line; the full notice goes to the task's chat.
    assert.equal(
      result?.text,
      "🎯 [goal-command-agent-channel] Goal task started.\n\nFollow it with /agent_goal status goal-command-agent-channel; stop it with /agent_goal stop goal-command-agent-channel.",
    );
  });

  // The host's PluginCommandContext shape (see ./command-contexts).
  const TOPIC_COMMAND = nativeTopicCommand({ topic: 42 });

  function goalHandler(): (ctx: any) => Promise<{ text: string }> {
    let handler: ((ctx: any) => Promise<{ text: string }>) | undefined;
    registerGoalCommand({
      registerCommand(command: { handler: typeof handler }) {
        handler = command.handler;
      },
    });
    assert.ok(handler, "expected /agent_goal handler");
    return handler;
  }

  it("stores the command's bot account in a goal task launched from a Telegram topic", async () => {
    setPluginConfig({ defaultHarness: "codex", harnesses: { codex: { defaultModel: "gpt-5.5", allowedModels: ["gpt-5.5"] } } });
    let launchConfig: Record<string, unknown> | undefined;
    setGoalController({
      async launchTask(config: Record<string, unknown>, reply: { sameChat: (task: unknown) => boolean; text?: string }) {
        launchConfig = config;
        reply.text = "🎯 [topic-goal] Goal task started\n\nGoal:\nship it";
        return { id: "goal-topic-1", name: "topic-goal", route: config.route };
      },
    } as any);

    const result = await goalHandler()({ ...TOPIC_COMMAND, args: "--workdir /tmp ship it" });

    assert.equal(launchConfig?.originChannel, "telegram|bot1|-1001234567890");
    assert.deepEqual(launchConfig?.route, {
      provider: "telegram",
      accountId: "bot1",
      target: "-1001234567890",
      threadId: "42",
      sessionKey: TOPIC_COMMAND.sessionKey,
    });
    // The task's own chat: the full notice is the one reply.
    assert.equal(
      result.text,
      "🎯 [topic-goal] Goal task started\n\nGoal:\nship it\n\nFollow it with /agent_goal status topic-goal; stop it with /agent_goal stop topic-goal.",
    );
  });

  it("answers launch, stop and edit from another chat with a short line", async () => {
    setPluginConfig({ defaultHarness: "codex", harnesses: { codex: { defaultModel: "gpt-5.5", allowedModels: ["gpt-5.5"] } } });
    const task = {
      id: "goal-topic-2",
      name: "topic-goal",
      status: "running",
      route: { provider: "telegram", accountId: "bot1", target: "-1001234567890", threadId: "42" },
    };
    const sameChat: boolean[] = [];
    setGoalController({
      async launchTask(_config: unknown, reply: { sameChat: (task: unknown) => boolean; text?: string }) {
        sameChat.push(reply.sameChat(task));
        reply.text = "🎯 [topic-goal] Goal task started\n\nGoal:\nship it";
        return task;
      },
      stopTask(_ref: string, reply: { sameChat: (task: unknown) => boolean; text?: string }) {
        sameChat.push(reply.sameChat(task));
        reply.text = "⛔ [topic-goal] Goal task stopped | $0.25 | 1m1s\n\nStopped by user.";
        return { action: "stopped", task };
      },
      editTask(_ref: string, _goal: string, reply: { sameChat: (task: unknown) => boolean; text?: string }) {
        sameChat.push(reply.sameChat(task));
        reply.text = "✏️ [topic-goal] Goal task edited\n\nGoal:\nship it faster";
        return { action: "updated", task, previousGoal: "ship it" };
      },
    } as any);
    const handler = goalHandler();
    // Another topic of the same group, and the same topic through another bot account.
    const otherTopic = { ...TOPIC_COMMAND, messageThreadId: 7, sessionKey: "agent:main:telegram:group:-1001234567890:topic:7" };
    const otherBot = { ...TOPIC_COMMAND, accountId: "bot2" };

    assert.equal(
      (await handler({ ...otherTopic, args: "--workdir /tmp ship it" })).text,
      "🎯 [topic-goal] Goal task started.\n\nFollow it with /agent_goal status topic-goal; stop it with /agent_goal stop topic-goal.",
    );
    assert.equal((await handler({ ...otherTopic, args: "stop topic-goal" })).text, "⛔ [topic-goal] Stopped.");
    assert.equal((await handler({ ...otherBot, args: "edit topic-goal ship it faster" })).text, "✏️ [topic-goal] Goal task edited.");
    assert.deepEqual(sameChat, [false, false, false]);

    // In the task's own topic the notice itself is the reply.
    assert.equal((await handler({ ...TOPIC_COMMAND, args: "stop topic-goal" })).text, "⛔ [topic-goal] Goal task stopped | $0.25 | 1m1s\n\nStopped by user.");
    assert.equal((await handler({ ...TOPIC_COMMAND, args: "edit topic-goal ship it faster" })).text, "✏️ [topic-goal] Goal task edited\n\nGoal:\nship it faster");
    assert.deepEqual(sameChat.slice(3), [true, true]);

    // A text command in the task's topic (`to` carries the topic) is the same chat;
    // one whose `to` and thread disagree, or a direct-messages topic, is not.
    assert.equal((await handler({ ...textTopicCommand({ topic: 42 }), args: "stop topic-goal" })).text, "⛔ [topic-goal] Goal task stopped | $0.25 | 1m1s\n\nStopped by user.");
    assert.equal((await handler({ ...textTopicCommand({ topic: 42 }), messageThreadId: 7, args: "stop topic-goal" })).text, "⛔ [topic-goal] Stopped.");
    assert.equal((await handler({ ...textTopicCommand({ topic: 7 }), args: "stop topic-goal" })).text, "⛔ [topic-goal] Stopped.");
    assert.deepEqual(sameChat.slice(5), [true, false, false]);
  });

  it("words a goal status for the user in stop and edit replies", async () => {
    const task = { id: "goal-w", name: "waiting-goal", status: "awaiting_verifier_confirmation" };
    setGoalController({
      stopTask: () => ({ action: "already_terminal", task: { ...task, status: "stopped" } }),
      editTask: () => ({ action: "not_editable", task }),
    } as any);
    const handler = goalHandler();
    assert.equal((await handler({ args: "stop waiting-goal" })).text, "ℹ️ [waiting-goal] Already stopped; nothing to stop.");
    assert.equal((await handler({ args: "edit waiting-goal ship it" })).text, "ℹ️ [waiting-goal] Already waiting for your confirmation; nothing to edit.");
  });
});
