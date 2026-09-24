import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHarness } from "../src/harness";
import type { HarnessMessage, HarnessSession } from "../src/harness/types";
import { MessageStream } from "../src/session-message-stream";

const RUN_LIVE = process.env.OPENCLAW_RUN_LIVE_CODEX_SMOKE === "1";
const RUN_LIVE_RELEASE = process.env.OPENCLAW_RUN_LIVE_CODEX_RELEASE_SMOKE === "1";
const LIVE_TIMEOUT_MS = 180_000;
// Cheapest current catalog model by default; override for other accounts.
const LIVE_MODEL = process.env.OPENCLAW_CODEX_SMOKE_MODEL?.trim() || "gpt-6-luna";

async function nextUntil(
  iterator: AsyncIterator<HarnessMessage>,
  seen: HarnessMessage[],
  predicate: (message: HarnessMessage) => boolean,
  timeoutMs = LIVE_TIMEOUT_MS,
): Promise<HarnessMessage | undefined> {
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
    if (next.done) return undefined;
    seen.push(next.value);
    if (predicate(next.value)) return next.value;
  }
  throw new Error("live Codex smoke timed out");
}

async function collectUntilCompleted(messages: AsyncIterable<HarnessMessage>): Promise<HarnessMessage[]> {
  const seen: HarnessMessage[] = [];
  await nextUntil(messages[Symbol.asyncIterator](), seen, (message) => message.type === "run_completed");
  return seen;
}

function textOf(messages: HarnessMessage[]): string {
  return messages
    .filter((message): message is Extract<HarnessMessage, { type: "text_delta" }> => message.type === "text_delta")
    .map((message) => message.text)
    .join("");
}

function completed(messages: HarnessMessage[]): Extract<HarnessMessage, { type: "run_completed" }> | undefined {
  return messages.findLast((message): message is Extract<HarnessMessage, { type: "run_completed" }> => message.type === "run_completed");
}

describe("live Codex App Server smoke", () => {
  it("applies developer instructions, then resumes the thread", { skip: !RUN_LIVE, timeout: LIVE_TIMEOUT_MS }, async () => {
    const codex = getHarness("codex");
    const cwd = mkdtempSync(join(tmpdir(), "oca-live-codex-"));
    try {
      const first = codex.launch({
        prompt: "Say hello in one short sentence.",
        cwd,
        model: LIVE_MODEL,
        reasoningEffort: "low",
        systemPrompt: "Reply to every user message with exactly the single word PINEAPPLE and nothing else.",
      });
      const firstMessages = await collectUntilCompleted(first.messages);
      const backendRef = firstMessages.find((message) => message.type === "backend_ref");
      assert.ok(backendRef && backendRef.type === "backend_ref");
      assert.equal(completed(firstMessages)?.data.success, true);
      // Regression for A1: thread-level developer instructions must reach the model.
      assert.match(textOf(firstMessages), /PINEAPPLE/);

      const resumed = codex.launch({
        prompt: "Reply with the exact word RESUMED and then stop.",
        cwd,
        model: LIVE_MODEL,
        reasoningEffort: "low",
        resumeSessionId: backendRef.ref.conversationId,
      });
      const resumedMessages = await collectUntilCompleted(resumed.messages);
      assert.equal(completed(resumedMessages)?.data.success, true);
      assert.equal(completed(resumedMessages)?.data.session_id, backendRef.ref.conversationId);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("steers a running turn, compacts, and forks before the last turn", { skip: !RUN_LIVE, timeout: LIVE_TIMEOUT_MS * 2 }, async () => {
    const codex = getHarness("codex");
    const cwd = mkdtempSync(join(tmpdir(), "oca-live-codex-"));
    const stream = new MessageStream();
    let session: HarnessSession | undefined;
    try {
      stream.push(codex.buildUserMessage("Count from 1 to 40, one number per line, then say DONE.", ""));
      session = codex.launch({ prompt: stream, cwd, model: LIVE_MODEL, reasoningEffort: "low" });
      const iterator = session.messages[Symbol.asyncIterator]();
      const seen: HarnessMessage[] = [];
      await nextUntil(iterator, seen, (message) => message.type === "text_delta");
      const steered = await session.steer?.("Stop counting immediately and reply with the single word STEERED.");
      await nextUntil(iterator, seen, (message) => message.type === "run_completed");
      if (steered) assert.match(textOf(seen), /STEERED/);

      stream.push(codex.buildThreadActionMessage!({ kind: "compact" }));
      const afterCompact: HarnessMessage[] = [];
      await nextUntil(iterator, afterCompact, (message) => message.type === "run_completed");
      assert.equal(completed(afterCompact)?.data.success, true);
      assert.match(textOf(afterCompact), /compacted/);
      const threadId = seen.find((message): message is Extract<HarnessMessage, { type: "backend_ref" }> => message.type === "backend_ref")!.ref.conversationId;
      stream.end();
      await session.close?.();

      const forked = codex.launch({
        prompt: "Reply with the exact word FORKED.",
        cwd,
        model: LIVE_MODEL,
        reasoningEffort: "low",
        resumeSessionId: threadId,
        forkSession: true,
        rewindTurns: 1,
      });
      const forkMessages = await collectUntilCompleted(forked.messages);
      assert.equal(completed(forkMessages)?.data.success, true);
      assert.notEqual(completed(forkMessages)?.data.session_id, threadId);
    } finally {
      stream.end();
      await session?.close?.();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("produces a structured plan artifact and resumes after it", { skip: !RUN_LIVE_RELEASE, timeout: LIVE_TIMEOUT_MS }, async () => {
    const codex = getHarness("codex");
    const cwd = mkdtempSync(join(tmpdir(), "oca-live-codex-"));
    try {
      const planned = codex.launch({
        prompt: "Propose a short two-step plan for creating hello.txt. Do not ask questions; present the final plan now.",
        cwd,
        model: LIVE_MODEL,
        reasoningEffort: "low",
        permissionMode: "plan",
      });
      const plannedMessages = await collectUntilCompleted(planned.messages);
      const plannedRef = plannedMessages.find((message): message is Extract<HarnessMessage, { type: "backend_ref" }> => message.type === "backend_ref");
      const plannedArtifact = plannedMessages.find((message) => message.type === "plan_artifact");
      assert.ok(plannedRef);
      assert.ok(plannedArtifact, "expected a structured plan artifact");

      const resumed = codex.launch({
        prompt: "Reply with the exact word RELEASE and then stop.",
        cwd,
        model: LIVE_MODEL,
        reasoningEffort: "low",
        resumeSessionId: plannedRef.ref.conversationId,
      });
      const resumedMessages = await collectUntilCompleted(resumed.messages);
      assert.equal(completed(resumedMessages)?.data.success, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
