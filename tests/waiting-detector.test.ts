import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksLikeWaitingForUser } from "../src/waiting-detector";

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
});
