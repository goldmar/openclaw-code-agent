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
});
