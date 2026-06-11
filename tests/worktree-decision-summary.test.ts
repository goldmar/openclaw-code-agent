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
      assert.deepEqual(result.lines, [
        "Improves worktree decision summary across `src/session-worktree-message-service.ts`, `tests/session-manager-worktree.test.ts`.",
      ]);
      assert.match(warnings[0], /LLM summary provider failed: model unavailable/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("turns conventional commit subjects into readable fallback bullets", async () => {
    const result = await buildWorktreeDecisionWorkSummary({
      sessionName: "rust-hello-small-change-opencode",
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 1,
        deletions: 0,
        changedFiles: ["src/main.rs"],
        commitMessages: [
          { hash: "468592f", message: "docs: add clarifying comment for multi-word name joining in parse_args", author: "Mark Goldenstein" },
        ],
      },
    });

    assert.equal(result.source, "fallback");
    assert.deepEqual(result.lines, [
      "Adds clarifying comment for multi-word name joining in parse_args in `src/main.rs`.",
    ]);
    assert.doesNotMatch(result.lines.join("\n"), /Recent work:/);
    assert.doesNotMatch(result.lines.join("\n"), /Touches `src\/main\.rs`/);
  });

  it("omits aggregate file context from multi-commit fallback bullets", async () => {
    const result = await buildWorktreeDecisionWorkSummary({
      sessionName: "multi-commit-summary",
      diffSummary: {
        commits: 2,
        filesChanged: 2,
        insertions: 12,
        deletions: 3,
        changedFiles: ["src/Login.tsx", "src/Logout.tsx"],
        commitMessages: [
          { hash: "abc1234", message: "feat: add login form", author: "Codex" },
          { hash: "def5678", message: "fix: fix logout overflow", author: "Codex" },
        ],
      },
    });

    assert.equal(result.source, "fallback");
    assert.deepEqual(result.lines, [
      "Adds login form.",
      "Fixes logout overflow.",
    ]);
  });

  it("capitalizes unknown commit verbs in fallback bullets", async () => {
    const result = await buildWorktreeDecisionWorkSummary({
      sessionName: "unknown-verb-summary",
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 4,
        deletions: 1,
        changedFiles: ["src/feature.ts"],
        commitMessages: [
          { hash: "abc1234", message: "teach summary builder new verbs", author: "Codex" },
        ],
      },
    });

    assert.equal(result.source, "fallback");
    assert.deepEqual(result.lines, [
      "Teach summary builder new verbs in `src/feature.ts`.",
    ]);
  });

  it("uses useful completion output before deterministic file prose when no provider is available", async () => {
    const result = await buildWorktreeDecisionWorkSummary({
      sessionName: "fallback-from-output",
      diffSummary,
      outputPreview: [
        "$ pnpm test:file tests/callback-handler.test.ts",
        "Implemented markup-only cleanup for successful worktree decision callbacks.",
        "Updated fallback summaries to reuse concise completion output when the model is unavailable.",
        "Verified focused callback and worktree decision summary regression tests.",
        "Implemented markup-only cleanup for successful worktree decision callbacks.",
      ].join("\n"),
    });

    assert.equal(result.source, "fallback");
    assert.deepEqual(result.lines, [
      "Implemented markup-only cleanup for successful worktree decision callbacks.",
      "Updated fallback summaries to reuse concise completion output when the model is unavailable.",
      "Verified focused callback and worktree decision summary regression tests.",
    ]);
    assert.doesNotMatch(result.lines.join("\n"), /Touches `src\/session-worktree-message-service\.ts`/);
  });

  it("ignores generic completion output lines while preserving concrete worktree summary lines", async () => {
    const result = await buildWorktreeDecisionWorkSummary({
      sessionName: "fallback-filters-noise",
      diffSummary,
      outputPreview: [
        "Build is ready now",
        "3 tests passed",
        "The callback now preserves the original worktree decision prompt text.",
        "Focused regression tests pass for worktree decision summaries.",
      ].join("\n"),
    });

    assert.equal(result.source, "fallback");
    assert.deepEqual(result.lines, [
      "The callback now preserves the original worktree decision prompt text.",
      "Focused regression tests pass for worktree decision summaries.",
    ]);
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
