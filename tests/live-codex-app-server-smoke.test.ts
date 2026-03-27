import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getHarness } from "../src/harness";
import type { HarnessMessage } from "../src/harness/types";

const RUN_LIVE = process.env.OPENCLAW_RUN_LIVE_CODEX_SMOKE === "1";
const RUN_LIVE_WORKTREE = process.env.OPENCLAW_RUN_LIVE_CODEX_WORKTREE_SMOKE === "1";
const RUN_LIVE_RELEASE = process.env.OPENCLAW_RUN_LIVE_CODEX_RELEASE_SMOKE === "1";
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

  it("reuses a native Codex worktree ref when explicitly enabled", { skip: !RUN_LIVE_WORKTREE, timeout: LIVE_TIMEOUT_MS }, async () => {
    const codex = getHarness("codex");

    const first = codex.launch({
      prompt: "Reply with the exact word WORKTREE and then stop.",
      cwd: process.cwd(),
      worktreeStrategy: "ask",
      originalWorkdir: process.cwd(),
    });
    const firstMessages = await collectUntilCompleted(first.messages);
    const backendRefs = firstMessages.filter((message): message is Extract<HarnessMessage, { type: "backend_ref" }> => message.type === "backend_ref");
    const worktreeRef = backendRefs.find((message) => Boolean(message.ref.worktreePath || message.ref.worktreeId));
    const firstResult = firstMessages.find((message) => message.type === "run_completed");

    assert.ok(firstResult && firstResult.type === "run_completed");
    assert.equal(firstResult?.data.success, true);
    assert.ok(worktreeRef, "expected a backend_ref with native Codex worktree metadata");

    const resumed = codex.launch({
      prompt: "Reply with the exact word REUSED and then stop.",
      cwd: process.cwd(),
      resumeSessionId: worktreeRef.ref.conversationId,
      backendRef: worktreeRef.ref,
      worktreeStrategy: "ask",
      originalWorkdir: process.cwd(),
    });
    const resumedMessages = await collectUntilCompleted(resumed.messages);
    const resumedRef = resumedMessages.find((message): message is Extract<HarnessMessage, { type: "backend_ref" }> => message.type === "backend_ref");
    const resumedResult = resumedMessages.find((message) => message.type === "run_completed");

    assert.ok(resumedRef);
    assert.ok(resumedResult && resumedResult.type === "run_completed");
    assert.equal(resumedResult?.data.success, true);
    assert.equal(resumedRef.ref.conversationId, worktreeRef.ref.conversationId);
    if (worktreeRef.ref.worktreeId) {
      assert.equal(resumedRef.ref.worktreeId, worktreeRef.ref.worktreeId);
    }
  });

  it("covers a release-oriented launch/resume/plan/worktree flow when explicitly enabled", { skip: !RUN_LIVE_RELEASE, timeout: LIVE_TIMEOUT_MS }, async () => {
    const codex = getHarness("codex");

    const planned = codex.launch({
      prompt: "Present a short two-step plan in markdown and then stop.",
      cwd: process.cwd(),
      permissionMode: "plan",
    });
    const plannedMessages = await collectUntilCompleted(planned.messages);
    const plannedRef = plannedMessages.find((message): message is Extract<HarnessMessage, { type: "backend_ref" }> => message.type === "backend_ref");
    const plannedArtifact = plannedMessages.find((message): message is Extract<HarnessMessage, { type: "plan_artifact" }> => message.type === "plan_artifact");

    assert.ok(plannedRef);
    assert.ok(plannedArtifact, "expected a structured plan artifact");

    const resumed = codex.launch({
      prompt: "Reply with the exact word RELEASE and then stop.",
      cwd: process.cwd(),
      resumeSessionId: plannedRef.ref.conversationId,
      backendRef: plannedRef.ref,
    });
    const resumedMessages = await collectUntilCompleted(resumed.messages);
    const resumedResult = resumedMessages.find((message) => message.type === "run_completed");
    assert.ok(resumedResult && resumedResult.type === "run_completed");
    assert.equal(resumedResult.data.success, true);

    const worktree = codex.launch({
      prompt: "Reply with the exact word WORKTREE-RELEASE and then stop.",
      cwd: process.cwd(),
      worktreeStrategy: "ask",
      originalWorkdir: process.cwd(),
    });
    const worktreeMessages = await collectUntilCompleted(worktree.messages);
    const worktreeRef = worktreeMessages.find((message): message is Extract<HarnessMessage, { type: "backend_ref" }> => (
      message.type === "backend_ref" && Boolean(message.ref.worktreeId || message.ref.worktreePath)
    ));
    assert.ok(worktreeRef, "expected native worktree metadata during release smoke");
  });
});
