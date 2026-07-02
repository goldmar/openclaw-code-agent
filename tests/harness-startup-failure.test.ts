import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isHarnessStartupFailureOutput,
  summarizeHarnessStartupFailure,
} from "../src/harness-startup-failure";

describe("harness startup failure classification", () => {
  it("detects auth and startup credential failures", () => {
    const failures = [
      "Failed to authenticate. API Error: 401 Invalid bearer token",
      "401 Unauthorized",
      "Authentication failed: invalid API key",
      "Authorization error while starting OpenCode harness",
    ];

    for (const failure of failures) {
      assert.equal(isHarnessStartupFailureOutput(failure), true, failure);
    }
  });

  it("does not classify ordinary successful output as startup failure", () => {
    assert.equal(
      isHarnessStartupFailureOutput("Authentication handling was documented and tests passed."),
      false,
    );
  });

  it("summarizes the matching failure line from mixed output", () => {
    assert.equal(
      summarizeHarnessStartupFailure([
        "Starting claude-code",
        "Failed to authenticate. API Error: 401 Invalid bearer token",
      ].join("\n")),
      "Failed to authenticate. API Error: 401 Invalid bearer token",
    );
  });
});
