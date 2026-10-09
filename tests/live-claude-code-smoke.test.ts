import "./test-env";
import { it } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHarness } from "../src/harness";
import type { HarnessMessage, HarnessSession } from "../src/harness/types";

const runLive = process.env.OPENCLAW_RUN_LIVE_CLAUDE_SMOKE === "1";

function snapshotScratchTree(root: string) {
  const entries: Record<string, { mode: bigint; mtimeNs: bigint; ctimeNs: bigint; contents?: string }> = {};
  const visit = (relative: string) => {
    const path = join(root, relative);
    const metadata = lstatSync(path, { bigint: true });
    entries[relative] = { mode: metadata.mode, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs,
      ...(metadata.isFile() ? { contents: readFileSync(path).toString("hex") }
        : metadata.isSymbolicLink() ? { contents: readlinkSync(path) } : {}) };
    if (metadata.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(relative, name));
    }
  };
  visit("");
  return entries;
}

async function terminal(session: HarnessSession, stopForPlanReview = false): Promise<HarnessMessage[]> {
  const messages: HarnessMessage[] = [];
  for await (const message of session.messages) {
    messages.push(message);
    if (stopForPlanReview && message.type === "plan_approval_requested") return messages;
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
      mkdirSync(join(cwd, "notes"));
      writeFileSync(join(cwd, "notes", "existing.txt"), "BEFORE_APPROVAL\n");
      const beforeApproval = snapshotScratchTree(cwd);
      const harness = getHarness("claude-code");
      const model = process.env.OPENCLAW_CLAUDE_SMOKE_MODEL?.trim() || "opus";
      const planning = harness.launch({ cwd, model, reasoningEffort: "low", permissionMode: "plan",
        prompt: "Create live-claude-receipt.txt with exactly CLAUDE_COMPAT_OK followed by a newline and replace notes/existing.txt with exactly APPROVED_CHANGE followed by a newline, then stop." });
      sessions.push(planning);
      const messages = await terminal(planning, true);
      assert.deepEqual(snapshotScratchTree(cwd), beforeApproval, "plan mode must leave the entire scratch tree unchanged");
      const backend = messages.find((message): message is Extract<HarnessMessage, { type: "backend_ref" }> => message.type === "backend_ref");
      assert.ok(backend, "native conversation identity is required for resume");
      await planning.close?.();
      assert.deepEqual(snapshotScratchTree(cwd), beforeApproval, "no late writes may occur before approval and resume");
      const execution = harness.launch({ cwd, model, reasoningEffort: "low", permissionMode: "bypassPermissions",
        resumeSessionId: backend.ref.conversationId,
        prompt: "The scratch plan is approved. Write live-claude-receipt.txt with exactly CLAUDE_COMPAT_OK followed by a newline and replace notes/existing.txt with exactly APPROVED_CHANGE followed by a newline, then stop." });
      sessions.push(execution);
      await terminal(execution);
      assert.equal(readFileSync(join(cwd, "live-claude-receipt.txt"), "utf8"), "CLAUDE_COMPAT_OK\n");
      assert.equal(readFileSync(join(cwd, "notes", "existing.txt"), "utf8"), "APPROVED_CHANGE\n");
      assert.deepEqual(Object.keys(snapshotScratchTree(cwd)).sort(),
        ["", "live-claude-receipt.txt", "notes", join("notes", "existing.txt")].sort(),
        "the approved change must not create unrelated scratch files");
    } finally {
      clearTimeout(watchdog);
      await Promise.allSettled(sessions.map((session) => session.close?.()));
      rmSync(cwd, { recursive: true, force: true });
    }
  });
