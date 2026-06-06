import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { OpenCodeHarness } from "../src/harness/opencode";
import type { HarnessMessage } from "../src/harness/types";

const RUN_LIVE = process.env.OPENCLAW_RUN_LIVE_OPENCODE_SMOKE === "1";

async function collectUntilCompleted(session: { messages: AsyncIterable<HarnessMessage> }): Promise<HarnessMessage[]> {
  const messages: HarnessMessage[] = [];
  const deadline = Date.now() + 120_000;
  for await (const message of session.messages) {
    messages.push(message);
    if (message.type === "run_completed") return messages;
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for OpenCode live smoke completion.");
    }
  }
  return messages;
}

describe("OpenCode live server smoke", { skip: !RUN_LIVE }, () => {
  it("runs a trivial prompt through opencode serve", async () => {
    const version = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
    const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
    assert.ok(major > 1 || (major === 1 && minor >= 16), `expected opencode >= 1.16, got ${version}`);

    const harness = new OpenCodeHarness();
    const messages = await collectUntilCompleted(harness.launch({
      prompt: "Reply with exactly: OPENCLAW_OPENCODE_SMOKE",
      cwd: process.cwd(),
      permissionMode: "default",
    }));

    const result = messages.find((message) => message.type === "run_completed") as Extract<HarnessMessage, { type: "run_completed" }> | undefined;
    assert.equal(result?.data.success, true);
    assert.match(result?.data.result ?? messages.map((message) => message.type === "text_delta" ? message.text : "").join(""), /OPENCLAW_OPENCODE_SMOKE/);
  });
});
