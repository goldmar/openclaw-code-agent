import "./test-env";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerAgentCommand } from "../src/commands/agent";
import { setPluginConfig } from "../src/config";
import { setSessionManager } from "../src/singletons";

type AgentCommandHandler = (ctx: Record<string, unknown>) => Promise<{ text?: string; suppressReply?: boolean }>;

// The host's PluginCommandContext: top-level `channel`, `to`, `accountId`,
// `messageThreadId`, `senderId` and `sessionKey`; no `deliveryContext`.
const TOPIC_COMMAND = {
  channel: "telegram",
  to: "telegram:-1001234567890",
  accountId: "bot1",
  messageThreadId: 42,
  senderId: "1234",
  sessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
};
const TOPIC_ROUTE = {
  provider: "telegram",
  accountId: "bot1",
  target: "-1001234567890",
  threadId: "42",
  sessionKey: TOPIC_COMMAND.sessionKey,
};

function captureAgentCommand(): AgentCommandHandler {
  let handler: AgentCommandHandler | undefined;
  registerAgentCommand({
    registerCommand(command: { handler: AgentCommandHandler }) {
      handler = command.handler;
    },
  });
  assert.ok(handler, "expected /agent handler");
  return handler;
}

describe("agent command", () => {
  beforeEach(() => {
    setPluginConfig({});
    setSessionManager(null);
  });

  it("reports a session whose harness failed during startup instead of saying Launched", async () => {
    setSessionManager({
      list: (): never[] => [],
      listPersistedSessions: (): never[] => [],
      launchSession(config: Record<string, unknown>) {
        return { id: "sess-failed", name: config.name, model: config.model, status: "failed", error: "model_not_found" };
      },
    } as any);
    const result = await captureAgentCommand()({
      args: "--name broken --model sonnet --harness claude-code Fix it",
      workspaceDir: "/tmp",
      sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
      deliveryContext: { channel: "telegram", to: "-1001234567890", accountId: "bot1", threadId: 13832 },
    });
    assert.equal(result.text, "❌ [broken] Did not start: model_not_found\nFix the problem and run /agent again.");
  });

  it("stores the command's bot account in the route of a session launched from a Telegram topic or DM", async () => {
    const configs: Record<string, unknown>[] = [];
    setSessionManager({
      list: (): never[] => [],
      listPersistedSessions: (): never[] => [],
      launchSession(config: Record<string, unknown>) {
        configs.push(config);
        return { id: "sess-topic", name: config.name, model: config.model, status: "starting", route: config.route };
      },
    } as any);
    const handler = captureAgentCommand();

    const launched = await handler({ ...TOPIC_COMMAND, args: "--name topic --workdir /tmp --model sonnet --harness claude-code Fix it" });
    assert.match(launched.text ?? "", /^🚀 \[topic\] Launched \| \/tmp \| /);
    assert.equal(configs[0]?.originChannel, "telegram|bot1|-1001234567890");
    assert.equal(configs[0]?.originThreadId, 42);
    assert.deepEqual(configs[0]?.route, TOPIC_ROUTE);

    // A DM with the default scope: every DM shares `agent:<id>:main`.
    await handler({
      channel: "telegram",
      to: "telegram:1234",
      accountId: "default",
      senderId: "1234",
      sessionKey: "agent:main:main",
      args: "--name dm --workdir /tmp --model sonnet --harness claude-code Fix it",
    });
    assert.equal(configs[1]?.originChannel, "telegram|default|1234");
    assert.deepEqual(configs[1]?.route, { provider: "telegram", accountId: "default", target: "1234", threadId: undefined, sessionKey: "agent:main:main" });
  });

  it("sends no reply when a launch fails at startup in its own chat: the Failed notice is the one message", async () => {
    const failed = (extra: Record<string, unknown> = {}) => ({
      list: (): never[] => [],
      listPersistedSessions: (): never[] => [],
      launchSession(config: Record<string, unknown>) {
        return { id: "sess-failed", name: config.name, model: config.model, status: "failed", error: "model_not_found", route: config.route, ...extra };
      },
    });
    const args = "--name broken --workdir /tmp --model sonnet --harness claude-code Fix it";

    setSessionManager(failed() as any);
    assert.deepEqual(await captureAgentCommand()({ ...TOPIC_COMMAND, args }), { suppressReply: true });

    // Stopped while starting: the `⛔ [name] Stopped by …` notice is the one message.
    setSessionManager(failed({ status: "killed", error: undefined }) as any);
    assert.deepEqual(await captureAgentCommand()({ ...TOPIC_COMMAND, args }), { suppressReply: true });

    // An /agent_kill reply already replaced that notice: nothing else follows, so this reply stays.
    setSessionManager(failed({ status: "killed", error: undefined, stopNoticeReplaced: true }) as any);
    assert.deepEqual(await captureAgentCommand()({ ...TOPIC_COMMAND, args }), {
      text: "❌ [broken] Did not start.\nFix the problem and run /agent again.",
    });

    // The notice goes to another chat (here: another topic): both messages are kept.
    setSessionManager(failed({ route: { ...TOPIC_ROUTE, threadId: "7" } }) as any);
    assert.deepEqual(await captureAgentCommand()({ ...TOPIC_COMMAND, args }), {
      text: "❌ [broken] Did not start: model_not_found\nFix the problem and run /agent again.",
    });

    // Outside Telegram the command's chat is never recognised.
    setSessionManager(failed() as any);
    const discord = await captureAgentCommand()({
      channel: "discord",
      to: "slash:1234",
      accountId: "default",
      senderId: "1234",
      sessionKey: "agent:main:discord:channel:1400000000000000002",
      args,
    });
    assert.equal(discord.text, "❌ [broken] Did not start: model_not_found\nFix the problem and run /agent again.");
  });

  it("names a stopped or suspended linked session in the user's words", async () => {
    const blockedBy = async (session: Record<string, unknown>) => {
      setSessionManager({
        list: () => [{ id: "sess-linked", name: "linked", workdir: "/tmp", originSessionKey: TOPIC_COMMAND.sessionKey, isExplicitlyResumable: true, ...session }],
        listPersistedSessions: (): never[] => [],
        launchSession() { throw new Error("spawn should not be called"); },
      } as any);
      return (await captureAgentCommand()({ ...TOPIC_COMMAND, args: "--workdir /tmp Continue work" })).text ?? "";
    };

    assert.match(await blockedBy({ status: "killed", lifecycle: "terminal" }), /^❌ \[linked\] Not launched: this chat already has a session for this directory \(stopped\)\.\n/);
    assert.match(await blockedBy({ status: "killed", lifecycle: "suspended" }), /for this directory \(suspended\)\.\n/);
    assert.match(await blockedBy({ status: "completed", lifecycle: "terminal" }), /for this directory \(completed\)\.\n/);
  });

  it("uses the shared launch resolver for routing and policy defaults", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    let launchOptions: { notifyLaunch?: boolean } | undefined;
    setSessionManager({
      list: (): never[] => [],
      listPersistedSessions: (): never[] => [],
      launchSession(config: Record<string, unknown>, options?: { notifyLaunch?: boolean }) {
        spawnConfig = config;
        launchOptions = options;
        return {
          id: "sess-agent-command",
          name: config.name,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          worktreeStrategy: "delegate",
        };
      },
    } as any);

    const handler = captureAgentCommand();
    const result = await handler({
      args: '--name "agent command" --model sonnet --harness claude-code Fix the auth bug',
      workspaceDir: "/tmp",
      sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
      deliveryContext: {
        channel: "telegram",
        to: "-1001234567890",
        accountId: "bot1",
        threadId: 13832,
      },
    });

    // One message (N45): the reply is the launch line, with no separate 🚀 notice.
    assert.equal(result.text, "🚀 [agent command] Launched | /tmp | sonnet\nFollow it with /agent_output agent command or /agent_sessions.");
    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.prompt, "Fix the auth bug");
    assert.equal(spawnConfig?.model, "sonnet");
    assert.equal(spawnConfig?.harness, "claude-code");
    assert.equal(launchOptions?.notifyLaunch, false);
    assert.equal(spawnConfig?.permissionMode, "plan");
    assert.equal(spawnConfig?.planApproval, "delegate");
    assert.equal(spawnConfig?.originChannel, "telegram|bot1|-1001234567890");
    assert.equal(spawnConfig?.originThreadId, 13832);
    assert.equal((spawnConfig?.route as { accountId?: string } | undefined)?.accountId, "bot1");
  });

  it("applies resume-first protection for linked chat sessions", async () => {
    let spawnCalled = false;
    setSessionManager({
      list: () => [{
        id: "sess-linked",
        name: "linked",
        status: "running",
        workdir: "/tmp",
        originChannel: "telegram|123",
      }],
      listPersistedSessions: (): never[] => [],
      launchSession() {
        spawnCalled = true;
        throw new Error("spawn should not be called");
      },
    } as any);

    const handler = captureAgentCommand();
    const result = await handler({
      args: "Continue work",
      workspaceDir: "/tmp",
      messageChannel: "telegram",
      chatId: "123",
    });

    assert.equal(spawnCalled, false);
    // In user terms: no ids, no tool syntax (the tool keeps its resume-first text).
    assert.equal(
      result.text,
      "❌ [linked] Not launched: this chat already has a session for this directory (running).\nContinue it with /agent_respond linked <message>, or stop it with /agent_kill linked.",
    );
  });
});
