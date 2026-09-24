import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessResumeCandidate } from "../src/session-resume";
import type { PersistedSessionInfo, SessionBackendRef } from "../src/types";

function completedSession(harness: string, backendRef: SessionBackendRef): PersistedSessionInfo {
  return {
    sessionId: `${harness}-session`,
    harnessSessionId: backendRef.conversationId ?? `${harness}-thread`,
    harness,
    backendRef,
    name: `${harness}-completed`,
    prompt: "continue",
    workdir: "/repo",
    status: "completed",
    killReason: "done",
    costUsd: 0,
  };
}

describe("assessResumeCandidate()", () => {
  it("keeps completed Codex App Server sessions resumable", () => {
    const assessment = assessResumeCandidate(completedSession("codex", {
      kind: "codex-app-server",
      conversationId: "thread-codex",
    }));

    assert.equal(assessment.kind, "resume");
    if (assessment.kind === "resume") {
      assert.equal(assessment.resumeSessionId, "thread-codex");
    }
  });

  it("keeps completed OpenCode server sessions resumable", () => {
    const assessment = assessResumeCandidate(completedSession("opencode", {
      kind: "opencode-server",
      conversationId: "ses_opencode",
    }));

    assert.equal(assessment.kind, "resume");
    if (assessment.kind === "resume") {
      assert.equal(assessment.resumeSessionId, "ses_opencode");
    }
  });

  it("resumes completed Claude Code sessions (transcripts are validated at launch)", () => {
    const assessment = assessResumeCandidate(completedSession("claude-code", {
      kind: "claude-code",
      conversationId: "claude-thread",
    }));

    assert.equal(assessment.kind, "resume");
    if (assessment.kind === "resume") {
      assert.equal(assessment.resumeSessionId, "claude-thread");
    }
  });
});
