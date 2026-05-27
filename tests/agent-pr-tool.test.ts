import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrMetadata, buildPrOutcomeDetailLines, formatPrBody } from "../src/tools/agent-pr";

describe("agent_pr outcome detail lines", () => {
  it("builds factual PR opened details for summary wakes", () => {
    assert.deepEqual(
      buildPrOutcomeDetailLines({
        action: "opened",
        branchName: "agent/summary-hook",
        baseBranch: "main",
        prUrl: "https://github.com/goldmar/openclaw-code-agent/pull/127",
        prNumber: 127,
        targetRepo: "goldmar/openclaw-code-agent",
      }),
      [
        "Opened PR for branch agent/summary-hook into main.",
        "PR URL: https://github.com/goldmar/openclaw-code-agent/pull/127.",
        "PR number: #127.",
        "Target repository: goldmar/openclaw-code-agent.",
      ],
    );
  });

  it("builds factual PR updated details with pushed commit stats", () => {
    assert.deepEqual(
      buildPrOutcomeDetailLines({
        action: "updated",
        branchName: "agent/summary-hook",
        baseBranch: "main",
        prUrl: "https://github.com/goldmar/openclaw-code-agent/pull/127",
        prNumber: 127,
        commits: 2,
        insertions: 14,
        deletions: 3,
      }),
      [
        "Updated PR for branch agent/summary-hook into main.",
        "PR URL: https://github.com/goldmar/openclaw-code-agent/pull/127.",
        "PR number: #127.",
        "Pushed 2 new commits (+14/-3).",
      ],
    );
  });
});

describe("agent_pr generated PR metadata", () => {
  it("uses valid LLM metadata for generated worktree PR content", async () => {
    const diffSummary = {
      commits: 2,
      filesChanged: 3,
      insertions: 42,
      deletions: 7,
      changedFiles: [
        "src/tools/agent-pr.ts",
        "src/tools/worktree-tool-context.ts",
        "tests/agent-pr-tool.test.ts",
      ],
      commitMessages: [
        { hash: "abc1234", message: "Build task-specific PR bodies", author: "Codex" },
        { hash: "def5678", message: "Add PR body regression tests", author: "Codex" },
      ],
    };

    const result = await buildPrMetadata({
      sessionName: "fix-generic-pr-description",
      prompt: "Investigate why worktree PR descriptions are generic and implement a focused fix.\n\nKeep the change narrow.",
      diffSummary,
      provider: {
        async generatePrMetadata(evidence) {
          return {
            title: "Build task-specific PR bodies",
            summary: [
              evidence.objective ? `Objective: ${evidence.objective}` : "Improve generated PR metadata.",
              "Scope: 2 commits, 3 files changed (+42 / -7)",
            ],
            changes: evidence.changedFiles.map((file) => `\`${file}\``),
            validation: evidence.validation,
            notes: evidence.notes,
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.metadata.title, "Build task-specific PR bodies");
    const body = result.ok ? formatPrBody({
      sessionName: "fix-generic-pr-description",
      metadata: result.metadata,
      diffSummary,
    }) : "";

    assert.match(body, /## Summary/);
    assert.match(body, /Objective: Investigate why worktree PR descriptions are generic and implement a focused fix\./);
    assert.doesNotMatch(body, /Keep the change narrow/);
    assert.doesNotMatch(body, /## Task/);
    assert.match(body, /## Changes/);
    assert.match(body, /`src\/tools\/agent-pr\.ts`/);
    assert.match(body, /Build task-specific PR bodies/);
    assert.match(body, /## Validation/);
    assert.match(body, /## Notes \/ Risks/);
    assert.doesNotMatch(body, /Automated changes from OpenClaw Code Agent session/);
  });

  it("fails explicitly when generated metadata is requested without a provider", async () => {
    const result = await buildPrMetadata({
      sessionName: "missing-provider",
      prompt: "Write useful PR metadata.",
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 4,
        deletions: 0,
        changedFiles: ["README.md"],
        commitMessages: [{ hash: "abc1234", message: "Document metadata behavior", author: "Codex" }],
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /requires an LLM metadata provider/);
    assert.equal("metadata" in result, false);
  });

  it("does not send raw prompt secrets or private paths to the metadata provider", async () => {
    const prompt = [
      "Rotate deployment token SECRET_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz for /home/openclaw/private/repo.",
      "Private docs: https://private.example.test/runbook",
      "Do not reveal this internal implementation instruction.",
      "x".repeat(500),
    ].join("\n\n");
    let evidenceText = "";

    const result = await buildPrMetadata({
      sessionName: "private-input",
      prompt,
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 5,
        deletions: 2,
        changedFiles: ["src/tools/agent-pr.ts"],
        commitMessages: [{ hash: "abc1234", message: "Avoid raw prompt exposure", author: "Codex" }],
      },
      provider: {
        async generatePrMetadata(evidence) {
          evidenceText = JSON.stringify(evidence);
          return {
            title: "Avoid raw prompt exposure",
            summary: evidence.objective ? [`Objective: ${evidence.objective}`] : ["Review metadata generation."],
            changes: ["`src/tools/agent-pr.ts`"],
            validation: evidence.validation,
            notes: evidence.notes,
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.doesNotMatch(evidenceText, /SECRET_TOKEN/);
    assert.doesNotMatch(evidenceText, /ghp_1234567890abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(evidenceText, /\/home\/openclaw\/private\/repo/);
    assert.doesNotMatch(evidenceText, /private\.example\.test/);
    assert.doesNotMatch(evidenceText, /Do not reveal this internal implementation instruction/);
    assert.doesNotMatch(evidenceText, new RegExp("x{100}"));
    assert.match(evidenceText, /\[redacted credential\]/);
    assert.match(evidenceText, /\[redacted path\]/);
  });

  it("fails explicitly when LLM metadata is invalid, unsafe, or references files outside the evidence", async () => {
    const diffSummary = {
      commits: 1,
      filesChanged: 1,
      insertions: 8,
      deletions: 1,
      changedFiles: ["src/tools/agent-pr.ts"],
      commitMessages: [{ hash: "abc1234", message: "Harden PR metadata generation", author: "Codex" }],
    };

    const cases: unknown[] = [
      { title: "", summary: [], changes: [], validation: [], notes: [] },
      {
        title: "Leak ghp_1234567890abcdefghijklmnopqrstuvwxyz",
        summary: ["Looks fine"],
        changes: ["`src/tools/agent-pr.ts`"],
        validation: ["Not recorded by agent_pr. Review CI/checks and session output before merging."],
        notes: ["No notes"],
      },
      {
        title: "Invented file",
        summary: ["Looks fine"],
        changes: ["`src/does-not-exist.ts`"],
        validation: ["Not recorded by agent_pr. Review CI/checks and session output before merging."],
        notes: ["No notes"],
      },
      {
        title: "Opaque token",
        summary: ["Token abcdefghijklmnopqrstuvwxyzABCDEF12345678 was emitted."],
        changes: ["`src/tools/agent-pr.ts`"],
        validation: ["Not recorded by agent_pr. Review CI/checks and session output before merging."],
        notes: ["No notes"],
      },
    ];

    for (const generated of cases) {
      const result = await buildPrMetadata({
        sessionName: "invalid-output-session",
        prompt: "Harden generated PR metadata. SECRET_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz",
        diffSummary,
        provider: { async generatePrMetadata() { return generated; } },
      });

      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, /failed schema or safety validation/);
      assert.equal("metadata" in result, false);
    }
  });

  it("does not reject ordinary JS/TS command mentions in safe model output", async () => {
    const result = await buildPrMetadata({
      sessionName: "command-mentions",
      prompt: "Describe package metadata updates.",
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 8,
        deletions: 1,
        changedFiles: ["package.json"],
        commitMessages: [{ hash: "abc1234", message: "Update package metadata", author: "Codex" }],
      },
      provider: {
        async generatePrMetadata() {
          return {
            title: "Update package metadata",
            summary: ["Updates npm package metadata for the plugin."],
            changes: ["`package.json`"],
            validation: ["Review CI checks before merging."],
            notes: ["No pnpm command was run by metadata generation."],
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.metadata.title, "Update package metadata");
  });

  it("rejects hallucinated root-level changed file names", async () => {
    const result = await buildPrMetadata({
      sessionName: "root-file-hallucination",
      prompt: "Summarize root-level documentation changes.",
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 6,
        deletions: 2,
        changedFiles: ["README.md"],
        commitMessages: [{ hash: "abc1234", message: "Update README metadata", author: "Codex" }],
      },
      provider: {
        async generatePrMetadata() {
          return {
            title: "Update documentation metadata",
            summary: ["Updates the root-level documentation summary."],
            changes: ["`CHANGELOG.md`"],
            validation: ["Review CI checks before merging."],
            notes: ["No notes"],
          };
        },
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /failed schema or safety validation/);
  });

  it("does not reject ordinary root-like technology names", async () => {
    const result = await buildPrMetadata({
      sessionName: "ordinary-root-like-names",
      prompt: "Describe package metadata updates.",
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 8,
        deletions: 1,
        changedFiles: ["package.json"],
        commitMessages: [{ hash: "abc1234", message: "Update package metadata", author: "Codex" }],
      },
      provider: {
        async generatePrMetadata() {
          return {
            title: "Update package metadata",
            summary: ["Keeps Node.js package metadata current."],
            changes: ["`package.json`"],
            validation: ["Review CI checks before merging."],
            notes: ["No pnpm command was run by metadata generation."],
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.metadata.summary.includes("Keeps Node.js package metadata current."), true);
  });

  it("allows model output to mention files beyond the first ten changed files", async () => {
    const changedFiles = Array.from({ length: 12 }, (_, index) => `src/file-${index + 1}.ts`);
    const result = await buildPrMetadata({
      sessionName: "large-change",
      prompt: "Summarize a larger change set.",
      diffSummary: {
        commits: 1,
        filesChanged: changedFiles.length,
        insertions: 48,
        deletions: 12,
        changedFiles,
        commitMessages: [{ hash: "abc1234", message: "Update src/file-12.ts metadata", author: "Codex" }],
      },
      provider: {
        async generatePrMetadata(evidence) {
          assert.equal(evidence.changedFiles.includes("src/file-12.ts"), true);
          return {
            title: "Update large change metadata",
            summary: ["Updates metadata across a larger file set."],
            changes: ["`src/file-12.ts`"],
            validation: ["Review CI checks before merging."],
            notes: ["Mentions a changed file beyond the first ten evidence entries."],
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.metadata.changes.includes("`src/file-12.ts`"), true);
  });
});
