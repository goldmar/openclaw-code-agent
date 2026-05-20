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

  it("uses deliveryContext when resolving linked-session routing", () => {
    const result = resolveAgentLaunchRequest(
      { prompt: "Continue work" },
      {
        workspaceDir: "/tmp",
        sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
        deliveryContext: {
          channel: "telegram",
          to: "-1003863755361",
          accountId: "bot1",
          threadId: 13832,
        },
      } as any,
      {
        list: () => [{
          id: "sess-1",
          name: "linked",
          status: "running",
          workdir: "/tmp",
          originChannel: "telegram|bot1|-1003863755361",
          originThreadId: "13832",
        }],
        listPersistedSessions: () => [],
      },
    );

    assert.equal(result.kind, "blocked");
  });

  it("accepts gpt-5.5-pro under the built-in Codex allowlist", () => {
    const result = resolveAgentLaunchRequest(
      {
        prompt: "Use the pro model",
        harness: "codex",
        model: "gpt-5.5-pro",
      },
      { workspaceDir: "/tmp" } as any,
      {},
    );

    assert.equal(result.kind, "resolved");
    if (result.kind === "resolved") {
      assert.equal(result.resolvedModel, "gpt-5.5-pro");
    }
  });

  it("resolves Codex fastMode from harness config only for Codex", () => {
    setPluginConfig({
      harnesses: {
        codex: { fastMode: true },
        "claude-code": { fastMode: true } as any,
      },
    });

    const codex = resolveAgentLaunchRequest(
      { prompt: "Use Codex fast mode", harness: "codex" },
      { workspaceDir: "/tmp" } as any,
      {},
    );
    const claude = resolveAgentLaunchRequest(
      { prompt: "Use Claude", harness: "claude-code" },
      { workspaceDir: "/tmp" } as any,
      {},
    );

    assert.equal(codex.kind, "resolved");
    if (codex.kind === "resolved") {
      assert.equal(codex.fastMode, true);
    }
    assert.equal(claude.kind, "resolved");
    if (claude.kind === "resolved") {
      assert.equal(claude.fastMode, undefined);
    }
  });

  it("rejects a Codex default model outside the configured harness allowlist", () => {
    setPluginConfig({
      harnesses: {
        codex: {
          defaultModel: "gpt-5.4",
          allowedModels: ["gpt-5.5"],
        },
      },
    });

    const result = resolveAgentLaunchRequest(
      {
        prompt: "Use the configured Codex default",
        harness: "codex",
      },
      { workspaceDir: "/tmp" } as any,
      {},
    );

    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.match(result.text, /Default model "gpt-5\.4" is not in allowedModels/);
      assert.match(result.text, /compatible defaultModel/);
    }
  });

  it("accepts canonical Claude Code models through substring harness restrictions", () => {
    const result = resolveAgentLaunchRequest(
      {
        prompt: "Use Claude Code",
        harness: "claude-code",
        model: "anthropic/claude-opus-4-7",
      },
      { workspaceDir: "/tmp" } as any,
      {},
    );

    assert.equal(result.kind, "resolved");
    if (result.kind === "resolved") {
      assert.equal(result.resolvedModel, "anthropic/claude-opus-4-7");
      assert.equal(result.permissionMode, "plan");
      assert.equal(result.planApproval, "delegate");
    }
  });

  it("applies per-launch plan approval overrides without changing worktree policy", () => {
    setPluginConfig({
      permissionMode: "plan",
      planApproval: "delegate",
      defaultWorktreeStrategy: "delegate",
    });

    const result = resolveAgentLaunchRequest(
      {
        prompt: "Plan this work",
        plan_approval: "ask",
        permission_mode: "default",
      },
      { workspaceDir: "/tmp" } as any,
      {},
    );

    assert.equal(result.kind, "resolved");
    if (result.kind === "resolved") {
      assert.equal(result.permissionMode, "default");
      assert.equal(result.planApproval, "ask");
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
