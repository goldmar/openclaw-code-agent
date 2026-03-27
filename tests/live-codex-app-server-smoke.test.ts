import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getHarness } from "../src/harness";
import type { HarnessMessage } from "../src/harness/types";

const RUN_LIVE = process.env.OPENCLAW_RUN_LIVE_CODEX_SMOKE === "1";
const LIVE_TIMEOUT_MS = 120_000;

async function collectUntilCompleted(
  messages: AsyncIterable<HarnessMessage>,
  timeoutMs = LIVE_TIMEOUT_MS,
): Promise<HarnessMessage[]> {
  const seen: HarnessMessage[] = [];
  const iterator = messages[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("live Codex smoke timed out")), remaining);
        timer.unref?.();
      }),
    ]);
    if (next.done) break;
    seen.push(next.value);
    if (next.value.type === "run_completed") break;
  }

  return seen;
}

describe("live Codex App Server smoke", () => {
  it("launches and resumes a real Codex App Server session when explicitly enabled", { skip: !RUN_LIVE, timeout: LIVE_TIMEOUT_MS }, async () => {
    const codex = getHarness("codex");

    const first = codex.launch({
      prompt: "Reply with the exact word READY and then stop.",
      cwd: process.cwd(),
    });
    const firstMessages = await collectUntilCompleted(first.messages);
    const backendRef = firstMessages.find((message) => message.type === "backend_ref");
    const firstResult = firstMessages.find((message) => message.type === "run_completed");

    assert.ok(backendRef && backendRef.type === "backend_ref");
    assert.ok(firstResult && firstResult.type === "run_completed");
    assert.equal(firstResult?.data.success, true);

    const resumed = codex.launch({
      prompt: "Reply with the exact word RESUMED and then stop.",
      cwd: process.cwd(),
      resumeSessionId: backendRef.ref.conversationId,
      backendRef: backendRef.ref,
    });
    const resumedMessages = await collectUntilCompleted(resumed.messages);
    const resumedResult = resumedMessages.find((message) => message.type === "run_completed");

    assert.ok(resumedResult && resumedResult.type === "run_completed");
    assert.equal(resumedResult?.data.success, true);
    assert.equal(resumedResult?.data.session_id, backendRef.ref.conversationId);
  });
});
