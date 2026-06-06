import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatHarnessModelLabel, formatHarnessModelSuffix } from "../src/session-display";

describe("session display formatting", () => {
  it("formats harness and model together", () => {
    assert.equal(
      formatHarnessModelLabel({ harness: "codex", model: "gpt-5.5" }),
      "codex / gpt-5.5",
    );
    assert.equal(
      formatHarnessModelSuffix({ harness: "opencode", model: "gpt-5.5" }),
      " | opencode / gpt-5.5",
    );
  });

  it("makes provider defaults explicit when the harness is known", () => {
    assert.equal(formatHarnessModelLabel({ harness: "opencode" }), "opencode / default");
  });
});
