import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideResumeSessionId } from "../src/resume-policy";

describe("decideResumeSessionId()", () => {
  it("keeps persisted Codex App Server sessions resumable", () => {
    const decision = decideResumeSessionId({
      requestedResumeSessionId: "thread-app-server",
      persistedSession: {
        harness: "codex",
        backendRef: { kind: "codex-app-server" },
      },
    });

    assert.equal(decision.resumeSessionId, "thread-app-server");
    assert.equal(decision.clearedPersistedCodexResume, false);
  });

  it("still clears legacy persisted Codex SDK sessions", () => {
    const decision = decideResumeSessionId({
      requestedResumeSessionId: "thread-sdk",
      persistedSession: {
        harness: "codex",
      },
    });

    assert.equal(decision.resumeSessionId, undefined);
    assert.equal(decision.clearedPersistedCodexResume, true);
  });
});
