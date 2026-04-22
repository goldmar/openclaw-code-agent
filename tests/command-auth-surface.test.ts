import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerAgentCommand } from "../src/commands/agent";
import { registerAgentKillCommand } from "../src/commands/agent-kill";
import { registerAgentOutputCommand } from "../src/commands/agent-output";
import { registerAgentRespondCommand } from "../src/commands/agent-respond";
import { registerAgentSessionsCommand } from "../src/commands/agent-sessions";
import { registerAgentStatsCommand } from "../src/commands/agent-stats";
import { registerGoalCommand } from "../src/commands/goal";
import { registerGoalStatusCommand } from "../src/commands/goal-status";
import { registerGoalStopCommand } from "../src/commands/goal-stop";

interface RegisteredCommand {
  name: string;
  requireAuth: boolean;
}

function captureCommand(
  register: (api: { registerCommand(command: RegisteredCommand): void }) => void,
): RegisteredCommand {
  let captured: RegisteredCommand | undefined;
  register({
    registerCommand(command) {
      captured = command;
    },
  });
  assert.ok(captured, "expected command registration");
  return captured;
}

describe("chat command auth surface", () => {
  it("keeps every registered chat command auth-required", () => {
    const commands = [
      captureCommand(registerAgentCommand),
      captureCommand(registerAgentKillCommand),
      captureCommand(registerAgentOutputCommand),
      captureCommand(registerAgentRespondCommand),
      captureCommand(registerAgentSessionsCommand),
      captureCommand(registerAgentStatsCommand),
      captureCommand(registerGoalCommand),
      captureCommand(registerGoalStatusCommand),
      captureCommand(registerGoalStopCommand),
    ];

    assert.deepEqual(
      commands.map((command) => [command.name, command.requireAuth]),
      [
        ["agent", true],
        ["agent_kill", true],
        ["agent_output", true],
        ["agent_respond", true],
        ["agent_sessions", true],
        ["agent_stats", true],
        ["goal", true],
        ["goal_status", true],
        ["goal_stop", true],
      ],
    );
  });
});
