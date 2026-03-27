import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentLaunchRequest } from "../src/tools/agent-launch-resolution";
import { setPluginConfig } from "../src/config";

describe("resolveAgentLaunchRequest", () => {
  beforeEach(() => {
    setPluginConfig({});
  });

  it("uses explicit prompt workdir metadata when no workdir parameter is provided", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "launch-resolution-"));
    try {
      const result = resolveAgentLaunchRequest(
        { prompt: `Workdir: ${repoDir}\nRepo: ${repoDir}\n\nInspect the issue.` },
        { workspaceDir: "/tmp/workspace" },
        {},
      );

      assert.equal(result.kind, "resolved");
      if (result.kind === "resolved") {
        assert.equal(result.workdir, repoDir);
      }
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("blocks fresh launch when a linked active session already exists", () => {
    const result = resolveAgentLaunchRequest(
      { prompt: "Continue work" },
      {
        workspaceDir: "/tmp",
        messageChannel: "telegram",
        chatId: "123",
      },
      {
        list: () => [{
          id: "sess-1",
          name: "linked",
          status: "running",
          workdir: "/tmp",
          originChannel: "telegram|123",
        }],
        listPersistedSessions: () => [],
      },
    );

    assert.equal(result.kind, "blocked");
    if (result.kind === "blocked") {
      assert.match(result.text, /Resume-first protection blocked a fresh launch/);
      assert.match(result.text, /agent_respond/);
    }
  });

  it("prefers canonical backend conversation ids for resume resolution", () => {
    const result = resolveAgentLaunchRequest(
      {
        prompt: "Continue work",
        resume_session_id: "session-ref",
      },
      { workspaceDir: "/tmp" },
      {
        resolveBackendConversationId: (ref) => ref === "session-ref" ? "backend-thread-1" : undefined,
        getPersistedSession: () => ({ harness: "codex", backendRef: { kind: "codex-app-server", conversationId: "backend-thread-1" } }),
      },
    );

    assert.equal(result.kind, "resolved");
    if (result.kind === "resolved") {
      assert.equal(result.resumeSessionId, "backend-thread-1");
      assert.equal(result.resolvedResumeId, "backend-thread-1");
      assert.equal(result.clearedPersistedCodexResume, false);
    }
  });
});
