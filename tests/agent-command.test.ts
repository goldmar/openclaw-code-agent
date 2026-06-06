import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerAgentCommand } from "../src/commands/agent";
import { setPluginConfig } from "../src/config";
import { setSessionManager } from "../src/singletons";

type AgentCommandHandler = (ctx: Record<string, unknown>) => { text: string };

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

  it("uses the shared launch resolver for routing and policy defaults", () => {
    let spawnConfig: Record<string, unknown> | undefined;
    let spawnOptions: Record<string, unknown> | undefined;
    setSessionManager({
      list: () => [],
      listPersistedSessions: () => [],
      spawn(config: Record<string, unknown>, options?: Record<string, unknown>) {
        spawnConfig = config;
        spawnOptions = options;
        return {
          id: "sess-agent-command",
          name: config.name,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          worktreeStrategy: "delegate",
        };
      },
      formatLaunchResult(config: Record<string, unknown>, session: Record<string, unknown>) {
        return `launched ${session.name} with ${config.permissionMode}/${config.planApproval}`;
      },
    } as any);

    const handler = captureAgentCommand();
    const result = handler({
      args: '--name "agent command" Fix the auth bug',
      workspaceDir: "/tmp",
      sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
      deliveryContext: {
        channel: "telegram",
        to: "-1003863755361",
        accountId: "bot1",
        threadId: 13832,
      },
    });

    assert.equal(result.text, "launched agent command with plan/delegate");
    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.permissionMode, "plan");
    assert.equal(spawnConfig?.planApproval, "delegate");
    assert.equal(spawnConfig?.originChannel, "telegram|bot1|-1003863755361");
    assert.equal(spawnConfig?.originThreadId, 13832);
    assert.equal((spawnConfig?.route as { accountId?: string } | undefined)?.accountId, "bot1");
    assert.deepEqual(spawnOptions, { notifyLaunch: false });
  });

  it("applies resume-first protection for linked chat sessions", () => {
    let spawnCalled = false;
    setSessionManager({
      list: () => [{
        id: "sess-linked",
        name: "linked",
        status: "running",
        workdir: "/tmp",
        originChannel: "telegram|123",
      }],
      listPersistedSessions: () => [],
      spawn() {
        spawnCalled = true;
        throw new Error("spawn should not be called");
      },
    } as any);

    const handler = captureAgentCommand();
    const result = handler({
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
