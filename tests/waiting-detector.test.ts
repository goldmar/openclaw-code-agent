import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikePlanApprovalRequest,
  looksLikePlanOnlyPrompt,
  looksLikePlanOutput,
  looksLikeWaitingForUser,
} from "../src/waiting-detector";

describe("looksLikeWaitingForUser", () => {
  it("matches explicit approval prompts", () => {
    assert.equal(looksLikeWaitingForUser("Shall I proceed with implementation now?"), true);
    assert.equal(looksLikeWaitingForUser("Please confirm and I'll run the migration."), true);
    assert.equal(looksLikeWaitingForUser("Do you want me to continue?"), true);
  });

  it("matches question ending with action verb", () => {
    assert.equal(looksLikeWaitingForUser("Can I merge this now?"), true);
    assert.equal(looksLikeWaitingForUser("Should I deploy this?"), true);
  });

  it("rejects rhetorical/status questions", () => {
    assert.equal(looksLikeWaitingForUser("Why this failed was a missing env var."), false);
    assert.equal(looksLikeWaitingForUser("How can I help further?"), false);
    assert.equal(looksLikeWaitingForUser("Any questions?"), false);
  });

  it("rejects non-question status text", () => {
    assert.equal(looksLikeWaitingForUser("Applied all requested changes and tests are green."), false);
  });

  it("matches additional approval phrasings", () => {
    assert.equal(looksLikeWaitingForUser("Would you like me to proceed with the migration?"), true);
    assert.equal(looksLikeWaitingForUser("Should I go ahead and merge this now?"), true);
  });

  it("rejects bare questions without action intent", () => {
    assert.equal(looksLikeWaitingForUser("Is there anything else?"), false);
    assert.equal(looksLikeWaitingForUser("What should we do next?"), false);
    assert.equal(looksLikeWaitingForUser("Would you like a summary?"), false);
  });

  it("normalizes whitespace and casing", () => {
    assert.equal(looksLikeWaitingForUser("  SHOULD   I   CONTINUE? "), true);
  });

  it("detects plan-only prompts", () => {
    assert.equal(looksLikePlanOnlyPrompt("Plan only and stop. Do not implement yet."), true);
    assert.equal(looksLikePlanOnlyPrompt("Fix the bug and ship it."), false);
  });

  it("detects structured plan output", () => {
    const plan = [
      "Here is the implementation plan:",
      "1. Inspect src/session-manager.ts for the no-change cleanup path.",
      "2. Add a soft-plan approval state for bypass sessions.",
      "3. Update tests and the orchestration skill guidance.",
    ].join("\n");
    assert.equal(looksLikePlanOutput(plan), true);
    assert.equal(looksLikePlanOutput("I fixed the bug and tests are passing."), false);
  });

  it("detects plan outputs that also ask for approval", () => {
    const plan = [
      "Proposed plan:",
      "- Inspect the session state machine.",
      "- Add a pending approval flag for soft plans.",
      "",
      "Should I continue with implementation?",
    ].join("\n");
    assert.equal(looksLikePlanApprovalRequest(plan), true);
  });
});
