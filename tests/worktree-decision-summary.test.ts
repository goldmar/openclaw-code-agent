import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorktreeDecisionWorkSummary,
  createRuntimeWorktreeDecisionSummaryProvider,
} from "../src/worktree-decision-summary";
import { setPluginRuntime } from "../src/runtime-store";

const diffSummary = {
  commits: 1,
  filesChanged: 2,
  insertions: 24,
  deletions: 5,
  changedFiles: [
    "src/session-worktree-message-service.ts",
    "tests/session-manager-worktree.test.ts",
  ],
  commitMessages: [
    { hash: "abc1234", message: "Improve worktree decision summary", author: "Codex" },
  ],
};

describe("worktree decision work summaries", () => {
  it("uses a valid LLM-generated summary with evidence from output, commits, and files", async () => {
    const result = await buildWorktreeDecisionWorkSummary({
      sessionName: "fix-worktree-decision-ux",
      prompt: "Fix the worktree decision prompt so humans can choose safely. SECRET_TOKEN=abc123",
      diffSummary,
      outputPreview: "Implemented better worktree prompts.\nVerified focused tests.",
      provider: {
        async generateWorktreeDecisionSummary(evidence) {
          assert.equal(evidence.sessionName, "fix-worktree-decision-ux");
          assert.match(evidence.objective ?? "", /Fix the worktree decision prompt/);
          assert.doesNotMatch(evidence.objective ?? "", /SECRET_TOKEN/);
          assert.deepEqual(evidence.stats, {
            commits: 1,
            filesChanged: 2,
            insertions: 24,
            deletions: 5,
          });
          assert.deepEqual(evidence.changedFiles, diffSummary.changedFiles);
          assert.deepEqual(evidence.commitSubjects, ["Improve worktree decision summary"]);
          assert.match(evidence.outputPreview ?? "", /Implemented better worktree prompts/);
          return {
            summary: [
              "Explains the completed worktree changes in a concise decision prompt.",
              "Adds regression coverage for summary generation and button cleanup.",
            ],
          };
        },
      },
    });

    assert.equal(result.source, "llm");
    assert.deepEqual(result.lines, [
      "Explains the completed worktree changes in a concise decision prompt.",
      "Adds regression coverage for summary generation and button cleanup.",
    ]);
  });

  it("falls back to deterministic diff and commit prose when the provider fails", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };

    try {
      const result = await buildWorktreeDecisionWorkSummary({
        sessionName: "fallback-summary",
        diffSummary,
        provider: {
          async generateWorktreeDecisionSummary() {
            throw new Error("model unavailable");
          },
        },
      });

      assert.equal(result.source, "fallback");
      assert.match(result.lines.join("\n"), /Touches `src\/session-worktree-message-service\.ts`, `tests\/session-manager-worktree\.test\.ts`/);
      assert.match(result.lines.join("\n"), /Recent work: Improve worktree decision summary/);
      assert.match(warnings[0], /LLM summary provider failed: model unavailable/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("adapts OpenClaw runtime summary hooks when available", async () => {
    try {
      setPluginRuntime({
        worktreeDecisionSummary: {
          async generateWorktreeDecisionSummary() {
            return { summary: ["Runtime-generated work summary."] };
          },
        },
      });

      const provider = createRuntimeWorktreeDecisionSummaryProvider();
      assert.ok(provider);
      const result = await buildWorktreeDecisionWorkSummary({
        sessionName: "runtime-summary",
        diffSummary,
        provider,
      });

      assert.equal(result.source, "llm");
      assert.deepEqual(result.lines, ["Runtime-generated work summary."]);
    } finally {
      setPluginRuntime(undefined);
    }
  });
});
