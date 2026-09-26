import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SessionActionTokenStore } from "../src/session-action-token-store";
import { SessionInteractionService } from "../src/session-interactions";

function labels(rows: Array<Array<{ label: string; url?: string }>>): string[][] {
  return rows.map((row) => row.map((button) => button.url ? `${button.label} (link)` : button.label));
}

describe("worktree decision buttons (N47, N48)", () => {
  const service = (gh: boolean) => new SessionInteractionService(new SessionActionTokenStore(() => {}), () => gh);

  it("uses one fixed layout: land the branch on the first row, Later and Discard on the second", async () => {
    // 4.x moved Later and Discard between rows depending on PR and GitHub CLI state.
    assert.deepEqual(labels(await service(true).getWorktreeDecisionButtons("s", {})), [["Merge", "Open PR"], ["Later", "Discard"]]);
    assert.deepEqual(labels(await service(false).getWorktreeDecisionButtons("s", {})), [["Merge"], ["Later", "Discard"]]);
    assert.deepEqual(labels(await service(true).getWorktreeDecisionButtons("s", {}, { merge: false, pr: true })), [["Open PR"], ["Later", "Discard"]]);
  });

  it("offers Sync PR and a View PR link once a PR exists", async () => {
    const rows = await service(true).getWorktreeDecisionButtons("s", { worktreePrUrl: "https://github.com/example/repo/pull/9" });
    assert.deepEqual(labels(rows), [["Merge", "Sync PR", "View PR (link)"], ["Later", "Discard"]]);
    const view = rows[0]!.find((button) => button.label === "View PR")!;
    assert.equal(view.url, "https://github.com/example/repo/pull/9");
    assert.equal(view.callbackData, "", "a link button mints no action token");
  });
});
