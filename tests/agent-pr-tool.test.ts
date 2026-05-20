import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrOutcomeDetailLines } from "../src/tools/agent-pr";

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
