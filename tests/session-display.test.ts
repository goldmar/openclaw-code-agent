import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatHarnessModelLabel, formatHarnessModelSuffix } from "../src/session-display";

describe("session display formatting", () => {
  it("formats harness and model together", () => {
    assert.equal(
      formatHarnessModelLabel({ harness: "codex", model: "gpt-5.5" }),
      "codex | gpt-5.5",
    );
    assert.equal(
      formatHarnessModelSuffix({ harness: "opencode", model: "gpt-5.5" }),
      " | opencode | gpt-5.5",
    );
  });

  it("makes provider defaults explicit when the harness is known", () => {
    assert.equal(formatHarnessModelLabel({ harness: "opencode" }), "opencode | default");
  });

  it("keeps provider slashes inside model IDs", () => {
    assert.equal(
      formatHarnessModelLabel({ harness: "opencode", model: "xai/grok-build-0.1" }),
      "opencode | xai/grok-build-0.1",
    );
  });

  it("prefers the backend's own effort-support report for Claude Code", () => {
    // Static tables would show max for opus; the backend said it was downgraded.
    assert.equal(
      formatHarnessModelLabel({ harness: "claude-code", model: "opus", reasoningEffort: "max", reasoningEffortSupported: false }),
      "claude-code | opus",
    );
    // Unknown to the static table, but the backend confirmed support.
    assert.equal(
      formatHarnessModelLabel({ harness: "claude-code", model: "claude-fable-5-1", reasoningEffort: "high", reasoningEffortSupported: true }),
      "claude-code | claude-fable-5-1 | reasoning: high",
    );
    // Without a backend report the static capability fallback still applies.
    assert.equal(
      formatHarnessModelLabel({ harness: "claude-code", model: "opus", reasoningEffort: "high" }),
      "claude-code | opus | reasoning: high",
    );
  });
});
