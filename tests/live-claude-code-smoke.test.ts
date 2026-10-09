import "./test-env";
import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHarness } from "../src/harness";
import type { HarnessMessage, HarnessSession } from "../src/harness/types";

const runLive = process.env.OPENCLAW_RUN_LIVE_CLAUDE_SMOKE === "1";

async function terminal(session: HarnessSession): Promise<HarnessMessage[]> {
  const messages: HarnessMessage[] = [];
  for await (const message of session.messages) {
    messages.push(message);
    if (message.type === "run_completed") {
      assert.equal(message.data.success, true, "require a successful native Claude terminal result");
      return messages;
    }
  }
  throw new Error("Claude closed without a terminal result");
}

it("live Claude plans without a repository write, then resumes to execute an approved scratch change",
  { skip: !runLive, timeout: 240_000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "oca-live-claude-"));
    const sessions: HarnessSession[] = [];
    const watchdog = setTimeout(() => {
      for (const session of sessions) void session.close?.().catch(() => {});
    }, 220_000);
    try {
      const harness = getHarness("claude-code");
      const model = process.env.OPENCLAW_CLAUDE_SMOKE_MODEL?.trim() || "opus";
      const planning = harness.launch({ cwd, model, reasoningEffort: "low", permissionMode: "plan",
        prompt: "Outline two steps to create live-claude-receipt.txt containing CLAUDE_COMPAT_OK. Reply with the outline only; do not write files, call ExitPlanMode, or ask questions." });
      sessions.push(planning);
      const messages = await terminal(planning);
      assert.equal(existsSync(join(cwd, "live-claude-receipt.txt")), false);
      const backend = messages.find((message): message is Extract<HarnessMessage, { type: "backend_ref" }> => message.type === "backend_ref");
      assert.ok(backend, "native conversation identity is required for resume");
      await planning.close?.();
      const execution = harness.launch({ cwd, model, reasoningEffort: "low", permissionMode: "bypassPermissions",
        resumeSessionId: backend.ref.conversationId,
        prompt: "The scratch plan is approved. Write live-claude-receipt.txt with exactly CLAUDE_COMPAT_OK followed by a newline, then stop." });
      sessions.push(execution);
      await terminal(execution);
      assert.equal(readFileSync(join(cwd, "live-claude-receipt.txt"), "utf8"), "CLAUDE_COMPAT_OK\n");
    } finally {
      clearTimeout(watchdog);
      await Promise.allSettled(sessions.map((session) => session.close?.()));
      rmSync(cwd, { recursive: true, force: true });
    }
  });
