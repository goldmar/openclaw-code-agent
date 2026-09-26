import "./test-env";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerAgentCommand } from "../src/commands/agent";
import { setPluginConfig } from "../src/config";
import { setSessionManager } from "../src/singletons";

type AgentCommandHandler = (ctx: Record<string, unknown>) => Promise<{ text: string }>;

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
    assert.equal(result.text, "🚀 [agent command] Launched | /tmp | sonnet\nFollow it with /agent_output agent command or /agent_status.");
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
    assert.match(result.text, /Resume-first protection blocked a fresh launch/);
    assert.match(result.text, /agent_respond/);
  });
});
