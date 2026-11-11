import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTaskOutcomeReport } from "../src/session-task-outcome";
import { SessionActionTokenStore } from "../src/session-action-token-store";
import { SessionInteractionService } from "../src/session-interactions";

function reviewedButtons(extra: { worktreePrUrl?: string } = {}) {
  return {
    ...extra, status: "completed", createdAt: 1,
    taskOutcome: createTaskOutcomeReport({ executionCycle: 1, task: "completed", repositories: [],
      checks: [{ name: "Callback-layout review", scope: "button unit fixture", required: true,
        status: "passed", stage: "review", evidence: "fixture:layout-review", source: "reviewed_receipt" }],
      blockers: [], remainingWork: [], summary: "Reviewed completed fixture task." }, { source: "orchestrator" }),
  };
}

function labels(rows: Array<Array<{ label: string; url?: string }>>): string[][] {
  return rows.map((row) => row.map((button) => button.url ? `${button.label} (link)` : button.label));
}

describe("worktree decision buttons (N47, N48)", () => {
  const service = (gh: boolean) => new SessionInteractionService(new SessionActionTokenStore(() => {}, 60_000), () => gh);

  it("mints no integration controls from execution completion without reviewed task evidence", async () => {
    const store = new SessionActionTokenStore(() => {}, 60_000);
    const interactions = new SessionInteractionService(store, () => true);
    assert.deepEqual(await interactions.getWorktreeDecisionButtons("s", { status: "completed", createdAt: 1 }), []);
    assert.equal(store.listActiveActionTokens().length, 0);
  });

  it("uses one fixed layout: land the branch on the first row, Later and Discard on the second", async () => {
    // 4.x moved Later and Discard between rows depending on PR and GitHub CLI state.
    assert.deepEqual(labels(await service(true).getWorktreeDecisionButtons("s", reviewedButtons())), [["Merge", "Open PR"], ["Later", "Discard"]]);
    assert.deepEqual(labels(await service(false).getWorktreeDecisionButtons("s", reviewedButtons())), [["Merge"], ["Later", "Discard"]]);
    assert.deepEqual(labels(await service(true).getWorktreeDecisionButtons("s", reviewedButtons(), { merge: false, pr: true })), [["Open PR"], ["Later", "Discard"]]);
  });

  it("offers Sync PR and a View PR link once a PR exists", async () => {
    const rows = await service(true).getWorktreeDecisionButtons("s", reviewedButtons({ worktreePrUrl: "https://github.com/example/repo/pull/9" }));
    assert.deepEqual(labels(rows), [["Merge", "Sync PR", "View PR (link)"], ["Later", "Discard"]]);
    const view = rows[0]!.find((button) => button.label === "View PR")!;
    assert.equal(view.url, "https://github.com/example/repo/pull/9");
    assert.equal(view.callbackData, "", "a link button mints no action token");
  });

  it("offers New PR instead of Open PR / Sync PR once the PR was closed without merging", async () => {
    const store = new SessionActionTokenStore(() => {}, 60_000);
    const interactions = new SessionInteractionService(store, () => true);
    const rows = await interactions.getWorktreeDecisionButtons("s", reviewedButtons({ worktreePrUrl: "https://github.com/example/repo/pull/9" }), { merge: true, pr: true }, { newPr: true });
    assert.deepEqual(labels(rows), [["Merge", "New PR", "View PR (link)"], ["Later", "Discard"]]);
    const token = store.getActionToken(rows[0]!.find((button) => button.label === "New PR")!.callbackData);
    assert.equal(token?.kind, "worktree-create-pr");
    assert.equal(token?.prForceNew, true, "the button opens a fresh PR");
    // Without GitHub CLI there is no PR action to offer.
    assert.deepEqual(labels(await service(false).getWorktreeDecisionButtons("s", reviewedButtons(), { merge: true, pr: true }, { newPr: true })), [["Merge"], ["Later", "Discard"]]);
    // Other prompts mint plain PR tokens.
    const plain = await interactions.getWorktreeDecisionButtons("s", reviewedButtons());
    assert.equal(store.getActionToken(plain[0]!.find((button) => button.label === "Open PR")!.callbackData)?.prForceNew, undefined);
  });
});
