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
        throw new Error("launchTask should not be called for invalid /goal input");
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
    setGoalController({
      async launchTask(config: Record<string, unknown>) {
        launchConfig = config;
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
      sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
      deliveryContext: {
        channel: "telegram",
        to: "-1003863755361",
        accountId: "bot1",
        threadId: 13832,
      },
    });

    assert.ok(launchConfig, "launchTask should be called");
    assert.equal(launchConfig?.harness, "codex");
    assert.equal(launchConfig?.model, "gpt-5.5");
    assert.equal(launchConfig?.reasoningEffort, "high");
    assert.equal(launchConfig?.loopMode, "verifier");
    assert.equal(launchConfig?.originChannel, "telegram|bot1|-1003863755361");
    assert.deepEqual(launchConfig?.verifierCommands, [{ label: "check-1", command: "pnpm test" }]);
    assert.match(result?.text ?? "", /Goal task launched\./);
    assert.match(result?.text ?? "", /Dir: \/tmp/);
    assert.match(result?.text ?? "", /Verifiers:/);
  });
});
