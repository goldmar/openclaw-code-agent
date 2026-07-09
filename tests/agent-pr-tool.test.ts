import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrCompletionWakeOutcomeKey, buildPrMetadata, buildPrOutcomeDetailLines, createRuntimePrMetadataProvider, formatPrBody, isOcaGeneratedPrBody, isOcaGeneratedPrTitle, normalizeForceNewReplacementPrStatus, refreshOpenPrMetadata, resolveExistingTargetPrUpdateBranch, resolveExistingTargetPrUpdateSourceBranch, shouldIgnoreClosedTargetPrForForceNew } from "../src/tools/agent-pr";
import { setPluginRuntime } from "../src/runtime-store";
import { getPRBody } from "../src/worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function initRepo(prefix: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), prefix));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "OpenClaw Tests");
  git(repoDir, "config", "user.email", "tests@example.com");
  writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");
  return repoDir;
}

function initRepoWithOrigin(prefix: string): { repoDir: string; remoteDir: string } {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  const remoteDir = join(rootDir, "remote.git");
  const repoDir = join(rootDir, "repo");
  mkdirSync(repoDir);
  execFileSync("git", ["init", "--bare", remoteDir], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "OpenClaw Tests");
  git(repoDir, "config", "user.email", "tests@example.com");
  git(repoDir, "remote", "add", "origin", remoteDir);
  writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");
  git(repoDir, "push", "-u", "origin", "main");
  return { repoDir, remoteDir };
}

function withFakeGh(script: string, run: (binDir: string) => Promise<void> | void): Promise<void> | void {
  const binDir = mkdtempSync(join(tmpdir(), "openclaw-fake-gh-"));
  const ghPath = join(binDir, "gh");
  const previousPath = process.env.PATH;
  writeFileSync(ghPath, script, "utf-8");
  chmodSync(ghPath, 0o755);
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  const cleanup = () => {
    process.env.PATH = previousPath;
    rmSync(binDir, { recursive: true, force: true });
  };
  try {
    const result = run(binDir);
    if (result && typeof result.then === "function") {
      return result.finally(cleanup);
    }
    cleanup();
    return undefined;
  } catch (err) {
    cleanup();
    throw err;
  }
}

describe("agent_pr outcome detail lines", () => {
  it("builds factual PR opened details for summary wakes", () => {
    assert.deepEqual(
      buildPrOutcomeDetailLines({
        action: "opened",
        branchName: "agent/summary-hook",
        baseBranch: "main",
        prUrl: "https://github.com/goldmar/openclaw-code-agent/pull/127",
        prNumber: 127,
        targetRepo: "goldmar/openclaw-code-agent",
      }),
      [
        "Opened PR for branch agent/summary-hook into main.",
        "PR URL: https://github.com/goldmar/openclaw-code-agent/pull/127.",
        "PR number: #127.",
        "Target repository: goldmar/openclaw-code-agent.",
      ],
    );
  });

  it("builds factual PR updated details with pushed commit stats", () => {
    assert.deepEqual(
      buildPrOutcomeDetailLines({
        action: "updated",
        branchName: "agent/summary-hook",
        baseBranch: "main",
        prUrl: "https://github.com/goldmar/openclaw-code-agent/pull/127",
        prNumber: 127,
        commits: 2,
        insertions: 14,
        deletions: 3,
      }),
      [
        "Updated PR for branch agent/summary-hook into main.",
        "PR URL: https://github.com/goldmar/openclaw-code-agent/pull/127.",
        "PR number: #127.",
        "Pushed 2 new commits (+14/-3).",
      ],
    );
  });

  it("builds stable PR update follow-up outcome keys from material commit evidence", () => {
    const baseArgs = {
      action: "updated" as const,
      branchName: "agent/summary-hook",
      prUrl: "https://github.com/goldmar/openclaw-code-agent/pull/127",
      prNumber: 127,
      targetRepo: "goldmar/openclaw-code-agent",
    };

    const firstKey = buildPrCompletionWakeOutcomeKey({
      ...baseArgs,
      diffSummary: {
        commits: 1,
        filesChanged: 2,
        insertions: 14,
        deletions: 3,
        changedFiles: ["src/a.ts"],
        commitMessages: [{ hash: "abc1234", message: "Update summary", author: "Codex" }],
      },
    });
    const duplicateKey = buildPrCompletionWakeOutcomeKey({
      ...baseArgs,
      diffSummary: {
        commits: 1,
        filesChanged: 2,
        insertions: 14,
        deletions: 3,
        changedFiles: ["src/a.ts"],
        commitMessages: [{ hash: "abc1234", message: "Reworded rendered text", author: "Codex" }],
      },
    });
    const laterKey = buildPrCompletionWakeOutcomeKey({
      ...baseArgs,
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 5,
        deletions: 0,
        changedFiles: ["src/b.ts"],
        commitMessages: [{ hash: "def5678", message: "Follow-up update", author: "Codex" }],
      },
    });

    assert.equal(firstKey, duplicateKey);
    assert.notEqual(firstKey, laterKey);
  });
});

describe("agent_pr existing target PR branch resolution", () => {
  it("fast-forwards the original PR branch from a follow-up helper branch", () => {
    const repoDir = initRepo("openclaw-agent-pr-target-");
    try {
      git(repoDir, "checkout", "-b", "agent/codex-telegram-proof-tests");
      writeFileSync(join(repoDir, "proof.txt"), "original\n", "utf-8");
      git(repoDir, "add", "proof.txt");
      git(repoDir, "commit", "-m", "Original proof work");

      git(repoDir, "checkout", "-b", "agent/fix-pr-322-feedback");
      writeFileSync(join(repoDir, "feedback.txt"), "review fix\n", "utf-8");
      git(repoDir, "add", "feedback.txt");
      git(repoDir, "commit", "-m", "Address PR feedback");
      const helperHead = git(repoDir, "rev-parse", "agent/fix-pr-322-feedback");
      git(repoDir, "checkout", "agent/codex-telegram-proof-tests");

      const result = resolveExistingTargetPrUpdateBranch({
        repoDir,
        sourceBranch: "agent/fix-pr-322-feedback",
        targetPrStatus: {
          exists: true,
          state: "open",
          url: "https://github.com/goldmar/openclaw-code-agent/pull/322",
          number: 322,
          headRefName: "agent/codex-telegram-proof-tests",
          baseRefName: "main",
        },
      });

      assert.deepEqual(result, {
        success: true,
        branchName: "agent/codex-telegram-proof-tests",
        alreadyRepresented: false,
      });
      assert.equal(git(repoDir, "rev-parse", "agent/codex-telegram-proof-tests"), helperHead);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("uses the original PR branch when it already contains follow-up helper work", () => {
    const repoDir = initRepo("openclaw-agent-pr-represented-");
    try {
      git(repoDir, "checkout", "-b", "agent/codex-telegram-proof-tests");
      writeFileSync(join(repoDir, "proof.txt"), "original\n", "utf-8");
      git(repoDir, "add", "proof.txt");
      git(repoDir, "commit", "-m", "Original proof work");

      git(repoDir, "checkout", "-b", "agent/fix-pr-322-feedback");
      writeFileSync(join(repoDir, "feedback.txt"), "review fix\n", "utf-8");
      git(repoDir, "add", "feedback.txt");
      git(repoDir, "commit", "-m", "Address PR feedback");
      const helperHead = git(repoDir, "rev-parse", "agent/fix-pr-322-feedback");

      git(repoDir, "checkout", "agent/codex-telegram-proof-tests");
      git(repoDir, "merge", "--ff-only", "agent/fix-pr-322-feedback");

      const result = resolveExistingTargetPrUpdateBranch({
        repoDir,
        sourceBranch: "agent/fix-pr-322-feedback",
        targetPrStatus: {
          exists: true,
          state: "open",
          url: "https://github.com/goldmar/openclaw-code-agent/pull/322",
          number: 322,
          headRefName: "agent/codex-telegram-proof-tests",
          baseRefName: "main",
        },
      });

      assert.deepEqual(result, {
        success: true,
        branchName: "agent/codex-telegram-proof-tests",
        alreadyRepresented: true,
      });
      assert.equal(git(repoDir, "rev-parse", "agent/codex-telegram-proof-tests"), helperHead);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("prefers the checked-out PR head over a stale internal worktree branch", () => {
    const repoDir = initRepo("openclaw-agent-pr-current-head-");
    try {
      git(repoDir, "checkout", "-b", "agent/task-flow-lifecycle-hooks");
      writeFileSync(join(repoDir, "real.txt"), "real PR update\n", "utf-8");
      git(repoDir, "add", "real.txt");
      git(repoDir, "commit", "-m", "Update existing PR branch");

      git(repoDir, "checkout", "main");
      git(repoDir, "checkout", "-b", "agent/pr-98910-taskflow-ci-codex");
      writeFileSync(join(repoDir, "internal.txt"), "stale helper work\n", "utf-8");
      git(repoDir, "add", "internal.txt");
      git(repoDir, "commit", "-m", "Stale internal helper branch");

      git(repoDir, "checkout", "agent/task-flow-lifecycle-hooks");

      const targetPrStatus = {
        exists: true,
        state: "open" as const,
        url: "https://github.com/openclaw/openclaw/pull/98910",
        number: 98910,
        headRefName: "agent/task-flow-lifecycle-hooks",
        baseRefName: "main",
      };
      const sourceBranch = resolveExistingTargetPrUpdateSourceBranch({
        repoDir,
        fallbackBranch: "agent/pr-98910-taskflow-ci-codex",
        targetPrStatus,
      });
      const result = resolveExistingTargetPrUpdateBranch({
        repoDir,
        sourceBranch,
        targetPrStatus,
      });

      assert.equal(sourceBranch, "agent/task-flow-lifecycle-hooks");
      assert.deepEqual(result, {
        success: true,
        branchName: "agent/task-flow-lifecycle-hooks",
        alreadyRepresented: false,
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("fast-forwards a target PR branch that is checked out in another linked worktree", () => {
    const repoDir = initRepo("openclaw-agent-pr-linked-worktree-");
    const linkedWorktreePath = `${repoDir}-target-worktree`;
    try {
      git(repoDir, "checkout", "-b", "agent/codex-telegram-proof-tests");
      writeFileSync(join(repoDir, "proof.txt"), "original\n", "utf-8");
      git(repoDir, "add", "proof.txt");
      git(repoDir, "commit", "-m", "Original proof work");
      git(repoDir, "checkout", "main");
      git(repoDir, "worktree", "add", linkedWorktreePath, "agent/codex-telegram-proof-tests");

      git(repoDir, "checkout", "-b", "agent/fix-pr-322-feedback", "agent/codex-telegram-proof-tests");
      writeFileSync(join(repoDir, "feedback.txt"), "review fix\n", "utf-8");
      git(repoDir, "add", "feedback.txt");
      git(repoDir, "commit", "-m", "Address PR feedback");
      const helperHead = git(repoDir, "rev-parse", "agent/fix-pr-322-feedback");

      const result = resolveExistingTargetPrUpdateBranch({
        repoDir,
        sourceBranch: "agent/fix-pr-322-feedback",
        targetPrStatus: {
          exists: true,
          state: "open",
          url: "https://github.com/goldmar/openclaw-code-agent/pull/322",
          number: 322,
          headRefName: "agent/codex-telegram-proof-tests",
          baseRefName: "main",
        },
      });

      assert.deepEqual(result, {
        success: true,
        branchName: "agent/codex-telegram-proof-tests",
        alreadyRepresented: false,
      });
      assert.equal(git(linkedWorktreePath, "rev-parse", "HEAD"), helperHead);
      assert.equal(git(repoDir, "rev-parse", "agent/codex-telegram-proof-tests"), helperHead);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(linkedWorktreePath, { recursive: true, force: true });
    }
  });

  it("rejects helper updates that omit commits from the remote PR branch", () => {
    const { repoDir, remoteDir } = initRepoWithOrigin("openclaw-agent-pr-stale-remote-");
    const rootDir = join(repoDir, "..");
    const cloneDir = join(rootDir, "remote-update");
    try {
      git(repoDir, "checkout", "-b", "agent/codex-telegram-proof-tests");
      writeFileSync(join(repoDir, "proof.txt"), "original\n", "utf-8");
      git(repoDir, "add", "proof.txt");
      git(repoDir, "commit", "-m", "Original proof work");
      git(repoDir, "push", "-u", "origin", "agent/codex-telegram-proof-tests");

      git(repoDir, "checkout", "-b", "agent/fix-pr-322-feedback");
      writeFileSync(join(repoDir, "feedback.txt"), "review fix\n", "utf-8");
      git(repoDir, "add", "feedback.txt");
      git(repoDir, "commit", "-m", "Address PR feedback");

      execFileSync("git", ["clone", remoteDir, cloneDir], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      git(cloneDir, "config", "user.name", "OpenClaw Tests");
      git(cloneDir, "config", "user.email", "tests@example.com");
      git(cloneDir, "checkout", "agent/codex-telegram-proof-tests");
      writeFileSync(join(cloneDir, "remote-only.txt"), "remote update\n", "utf-8");
      git(cloneDir, "add", "remote-only.txt");
      git(cloneDir, "commit", "-m", "Remote PR branch update");
      git(cloneDir, "push", "origin", "agent/codex-telegram-proof-tests");

      const result = resolveExistingTargetPrUpdateBranch({
        repoDir,
        sourceBranch: "agent/fix-pr-322-feedback",
        targetPrStatus: {
          exists: true,
          state: "open",
          url: "https://github.com/goldmar/openclaw-code-agent/pull/322",
          number: 322,
          headRefName: "agent/codex-telegram-proof-tests",
          baseRefName: "main",
        },
      });

      assert.equal(result.success, false);
      assert.match("error" in result ? result.error : "", /diverged/);
      assert.notEqual(
        git(repoDir, "rev-parse", "agent/codex-telegram-proof-tests"),
        git(repoDir, "rev-parse", "agent/fix-pr-322-feedback"),
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("ignores closed or merged persisted target PR metadata only for force_new", () => {
    assert.equal(
      shouldIgnoreClosedTargetPrForForceNew(true, {
        exists: true,
        state: "closed",
        url: "https://github.com/goldmar/openclaw-code-agent/pull/322",
      }),
      true,
    );
    assert.equal(
      shouldIgnoreClosedTargetPrForForceNew(true, {
        exists: true,
        state: "merged",
        url: "https://github.com/goldmar/openclaw-code-agent/pull/322",
      }),
      true,
    );
    assert.equal(
      shouldIgnoreClosedTargetPrForForceNew(true, {
        exists: true,
        state: "open",
        url: "https://github.com/goldmar/openclaw-code-agent/pull/322",
      }),
      false,
    );
    assert.equal(
      shouldIgnoreClosedTargetPrForForceNew(false, {
        exists: true,
        state: "closed",
        url: "https://github.com/goldmar/openclaw-code-agent/pull/322",
      }),
      false,
    );
  });

  it("keeps the ignored closed target PR ignored when branch lookup finds it again", () => {
    const ignoredClosedPr = {
      exists: true,
      state: "closed" as const,
      url: "https://github.com/goldmar/openclaw-code-agent/pull/322",
      number: 322,
      headRefName: "agent/fix-pr-322-feedback",
      baseRefName: "main",
    };

    assert.deepEqual(
      normalizeForceNewReplacementPrStatus(
        { ...ignoredClosedPr },
        ignoredClosedPr,
        { forceNewIgnoresClosedTargetPr: true },
      ),
      { exists: false, state: "none" },
    );

    assert.deepEqual(
      normalizeForceNewReplacementPrStatus(
        {
          exists: true,
          state: "closed",
          url: "https://github.com/goldmar/openclaw-code-agent/pull/999",
          number: 999,
        },
        ignoredClosedPr,
        { forceNewIgnoresClosedTargetPr: true },
      ),
      {
        exists: true,
        state: "closed",
        url: "https://github.com/goldmar/openclaw-code-agent/pull/999",
        number: 999,
      },
    );

    assert.deepEqual(
      normalizeForceNewReplacementPrStatus(
        { ...ignoredClosedPr },
        ignoredClosedPr,
        { forceNewIgnoresClosedTargetPr: false },
      ),
      ignoredClosedPr,
    );
  });
});

describe("agent_pr generated PR metadata", () => {
  it("uses runtime PR metadata providers when agent_pr does not inject a test provider", async () => {
    setPluginRuntime({
      prMetadata: {
        async generatePrMetadata() {
          return {
            title: "Refresh generated PR body",
            summary: ["Refreshes generated PR descriptions from runtime metadata."],
            changes: ["`src/tools/agent-pr.ts`", "`src/worktree-pr-metadata.ts`", "`tests/agent-pr-tool.test.ts`"],
            validation: ["pnpm test:file tests/agent-pr-tool.test.ts"],
            notes: ["Does not expose raw prompts or private paths."],
          };
        },
      },
    });
    try {
      const provider = createRuntimePrMetadataProvider();
      assert.ok(provider);

      const result = await buildPrMetadata({
        sessionName: "runtime-pr-metadata",
        prompt: "Fix PR metadata generation. Do not leak /home/openclaw/private/path or SECRET_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz.",
        diffSummary: {
          commits: 1,
          filesChanged: 3,
          insertions: 20,
          deletions: 4,
          changedFiles: ["src/tools/agent-pr.ts", "src/worktree-pr-metadata.ts", "tests/agent-pr-tool.test.ts"],
          commitMessages: [{ hash: "abc1234", message: "Wire runtime PR metadata", author: "Codex" }],
        },
        provider,
      });

      assert.equal(result.ok, true);
      assert.equal(result.ok && result.metadata.title, "Refresh generated PR body");
    } finally {
      setPluginRuntime(undefined);
    }
  });

  it("accepts JSON text from generic runtime metadata providers", async () => {
    setPluginRuntime({
      llm: {
        async generateText() {
          return JSON.stringify({
            title: "Use generic runtime metadata",
            summary: ["Parses JSON returned by a generic runtime text provider."],
            changes: ["`src/worktree-pr-metadata.ts`", "`tests/agent-pr-tool.test.ts`"],
            validation: ["pnpm test:file tests/agent-pr-tool.test.ts"],
            notes: ["Keeps provider output behind metadata validation."],
          });
        },
      },
    });
    try {
      const provider = createRuntimePrMetadataProvider();
      assert.ok(provider);
      const result = await buildPrMetadata({
        sessionName: "runtime-generic-provider",
        prompt: "Summarize runtime provider support.",
        diffSummary: {
          commits: 1,
          filesChanged: 2,
          insertions: 12,
          deletions: 1,
          changedFiles: ["src/worktree-pr-metadata.ts", "tests/agent-pr-tool.test.ts"],
          commitMessages: [{ hash: "abc1234", message: "Parse generic provider JSON", author: "Codex" }],
        },
        provider,
      });

      assert.equal(result.ok, true);
      assert.equal(result.ok && result.metadata.title, "Use generic runtime metadata");
    } finally {
      setPluginRuntime(undefined);
    }
  });

  it("marks only OpenClaw-generated or fallback PR bodies as replaceable by default", () => {
    const generated = formatPrBody({
      sessionName: "replaceable",
      metadata: {
        title: "Generated metadata",
        summary: ["Generated summary."],
        changes: ["`src/tools/agent-pr.ts`"],
        validation: ["Review CI checks before merging."],
        notes: ["Generated notes."],
      },
    });

    assert.equal(isOcaGeneratedPrBody(generated), true);
    assert.equal(
      isOcaGeneratedPrBody("## Summary\n- Deterministic fallback metadata generated because no LLM PR metadata provider is configured."),
      true,
    );
    assert.equal(isOcaGeneratedPrBody("Human-written description with project context and review notes."), false);
    assert.equal(isOcaGeneratedPrTitle("OpenClaw agent changes: missing provider"), true);
    assert.equal(isOcaGeneratedPrTitle("Human-written PR title"), false);
  });

  it("refreshes generated fallback PR title and body from current metadata", async () => {
    const currentBody = formatPrBody({
      sessionName: "fallback-metadata",
      metadata: {
        title: "OpenClaw agent changes: fallback metadata",
        summary: ["Deterministic fallback metadata generated because no LLM PR metadata provider is configured."],
        changes: ["`src/old.ts`"],
        validation: ["Review CI checks before merging."],
        notes: ["Generated notes."],
      },
    });
    const updates: { title?: string; body?: string } = {};

    const result = await refreshOpenPrMetadata({
      repoDir: "/repo",
      prStatus: {
        exists: true,
        state: "open",
        number: 42,
        title: "OpenClaw agent changes: fallback metadata",
      },
      sessionName: "fallback-metadata",
      branchName: "agent/fallback-metadata",
      prompt: "Refresh the generated pull request metadata.",
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 9,
        deletions: 1,
        changedFiles: ["src/tools/agent-pr.ts"],
        commitMessages: [{ hash: "abc1234", message: "Refresh generated PR metadata", author: "Codex" }],
      },
      forceRefresh: false,
      metadataProvider: {
        async generatePrMetadata() {
          return {
            title: "Refresh generated PR metadata",
            summary: ["Refreshes stale generated PR descriptions."],
            changes: ["`src/tools/agent-pr.ts`"],
            validation: ["Focused agent_pr metadata refresh tests passed."],
            notes: ["Preserves human-authored descriptions by default."],
          };
        },
      },
      operations: {
        getBody: () => ({ ok: true, body: currentBody }),
        updateBody: (_repo, _pr, body) => {
          updates.body = body;
          return true;
        },
        updateTitle: (_repo, _pr, title) => {
          updates.title = title;
          return true;
        },
      },
    });

    assert.deepEqual(result, { status: "updated", updatedTitle: true, updatedBody: true, reason: "generated" });
    assert.equal(updates.title, "Refresh generated PR metadata");
    assert.match(updates.body ?? "", /Refreshes stale generated PR descriptions/);
    assert.doesNotMatch(updates.body ?? "", /no LLM PR metadata provider/i);
  });

  it("preserves human-edited PR titles and bodies by default", async () => {
    let updateCalled = false;
    const result = await refreshOpenPrMetadata({
      repoDir: "/repo",
      prStatus: {
        exists: true,
        state: "open",
        number: 42,
        title: "Carefully edited release notes",
      },
      sessionName: "human-edited",
      prompt: "Refresh metadata.",
      forceRefresh: false,
      metadataProvider: {
        async generatePrMetadata() {
          throw new Error("provider should not be called for human-edited PR body");
        },
      },
      operations: {
        getBody: () => ({ ok: true, body: "Human-written description with product context and reviewer notes." }),
        updateBody: () => {
          updateCalled = true;
          return true;
        },
        updateTitle: () => {
          updateCalled = true;
          return true;
        },
      },
    });

    assert.deepEqual(result, { status: "skipped", reason: "human-edited" });
    assert.equal(updateCalled, false);
  });

  it("refreshes a fallback PR title even when the generated body is unchanged", async () => {
    const nextMetadata = {
      title: "Refresh generated PR metadata",
      summary: ["Refreshes stale generated PR descriptions."],
      changes: ["`src/tools/agent-pr.ts`"],
      validation: ["Focused agent_pr metadata refresh tests passed."],
      notes: ["Preserves human-authored descriptions by default."],
    };
    const unchangedBody = formatPrBody({
      sessionName: "fallback-title",
      metadata: nextMetadata,
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 9,
        deletions: 1,
        changedFiles: ["src/tools/agent-pr.ts"],
        commitMessages: [{ hash: "abc1234", message: "Refresh generated PR metadata", author: "Codex" }],
      },
    });
    const updates: { title?: string; body?: string } = {};

    const result = await refreshOpenPrMetadata({
      repoDir: "/repo",
      prStatus: {
        exists: true,
        state: "open",
        number: 42,
        title: "OpenClaw agent changes: fallback title",
      },
      sessionName: "fallback-title",
      prompt: "Refresh the generated pull request metadata.",
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 9,
        deletions: 1,
        changedFiles: ["src/tools/agent-pr.ts"],
        commitMessages: [{ hash: "abc1234", message: "Refresh generated PR metadata", author: "Codex" }],
      },
      forceRefresh: false,
      metadataProvider: {
        async generatePrMetadata() {
          return nextMetadata;
        },
      },
      operations: {
        getBody: () => ({ ok: true, body: unchangedBody }),
        updateBody: (_repo, _pr, body) => {
          updates.body = body;
          return true;
        },
        updateTitle: (_repo, _pr, title) => {
          updates.title = title;
          return true;
        },
      },
    });

    assert.deepEqual(result, { status: "updated", updatedTitle: true, updatedBody: false, reason: "generated" });
    assert.equal(updates.title, "Refresh generated PR metadata");
    assert.equal(updates.body, undefined);
  });

  it("forces generated PR metadata refresh for human-edited bodies only when requested", async () => {
    const updates: { title?: string; body?: string } = {};
    const result = await refreshOpenPrMetadata({
      repoDir: "/repo",
      prStatus: {
        exists: true,
        state: "open",
        number: 42,
        title: "Carefully edited release notes",
      },
      sessionName: "forced-refresh",
      prompt: "Refresh metadata.",
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 6,
        deletions: 1,
        changedFiles: ["src/tools/agent-pr.ts"],
        commitMessages: [{ hash: "abc1234", message: "Force metadata refresh", author: "Codex" }],
      },
      forceRefresh: true,
      metadataProvider: {
        async generatePrMetadata() {
          return {
            title: "Forced metadata refresh",
            summary: ["Refreshes metadata because the caller explicitly requested it."],
            changes: ["`src/tools/agent-pr.ts`"],
            validation: ["Focused agent_pr metadata refresh tests passed."],
            notes: ["This path intentionally overrides existing PR metadata."],
          };
        },
      },
      operations: {
        getBody: () => ({ ok: true, body: "Human-written description with product context and reviewer notes." }),
        updateBody: (_repo, _pr, body) => {
          updates.body = body;
          return true;
        },
        updateTitle: (_repo, _pr, title) => {
          updates.title = title;
          return true;
        },
      },
    });

    assert.deepEqual(result, { status: "updated", updatedTitle: true, updatedBody: true, reason: "forced" });
    assert.equal(updates.title, "Forced metadata refresh");
    assert.match(updates.body ?? "", /caller explicitly requested it/);
  });

  it("refreshes an empty existing PR body when metadata refresh is forced", async () => {
    const updates: { title?: string; body?: string } = {};
    const result = await refreshOpenPrMetadata({
      repoDir: "/repo",
      prStatus: {
        exists: true,
        state: "open",
        number: 42,
        title: "Carefully edited release notes",
      },
      sessionName: "blank-body-refresh",
      branchName: "agent/blank-body-refresh",
      forceRefresh: true,
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 3,
        deletions: 0,
        changedFiles: ["src/tools/agent-pr.ts"],
        commitMessages: [{ hash: "abc1234", message: "Refresh blank PR body", author: "Codex" }],
      },
      metadataProvider: {
        async generatePrMetadata() {
          return {
            title: "Refresh blank PR body",
            summary: ["Replaces a blank PR description when refresh is explicitly forced."],
            changes: ["`src/tools/agent-pr.ts`"],
            validation: ["Review CI checks before merging."],
            notes: ["Keeps explicit refresh behavior separate from default preservation."],
          };
        },
      },
      operations: {
        getBody: () => ({ ok: true, body: "" }),
        updateBody: (_repo, _pr, body) => {
          updates.body = body;
          return true;
        },
        updateTitle: (_repo, _pr, title) => {
          updates.title = title;
          return true;
        },
      },
    });

    assert.deepEqual(result, { status: "updated", updatedTitle: true, updatedBody: true, reason: "forced" });
    assert.equal(updates.title, "Refresh blank PR body");
    assert.match(updates.body ?? "", /Refresh blank PR body/);
    assert.match(updates.body ?? "", /Generated with \[openclaw-code-agent\]/);
  });

  it("surfaces PR body read failures separately from empty bodies", () => {
    withFakeGh(`#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gh version test"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo "transient GitHub failure" >&2
  exit 42
fi
exit 1
`, () => {
      const result = getPRBody(process.cwd(), 343, "goldmar/openclaw-code-agent");
      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, /Command failed|transient GitHub failure/);
    });
  });

  it("uses valid LLM metadata for generated worktree PR content", async () => {
    const diffSummary = {
      commits: 2,
      filesChanged: 3,
      insertions: 42,
      deletions: 7,
      changedFiles: [
        "src/tools/agent-pr.ts",
        "src/tools/worktree-tool-context.ts",
        "tests/agent-pr-tool.test.ts",
      ],
      commitMessages: [
        { hash: "abc1234", message: "Build task-specific PR bodies", author: "Codex" },
        { hash: "def5678", message: "Add PR body regression tests", author: "Codex" },
      ],
    };

    const result = await buildPrMetadata({
      sessionName: "fix-generic-pr-description",
      prompt: "Investigate why worktree PR descriptions are generic and implement a focused fix.\n\nKeep the change narrow.",
      diffSummary,
      provider: {
        async generatePrMetadata(evidence) {
          return {
            title: "Build task-specific PR bodies",
            summary: [
              evidence.objective ? `Objective: ${evidence.objective}` : "Improve generated PR metadata.",
              "Scope: 2 commits, 3 files changed (+42 / -7)",
            ],
            changes: evidence.changedFiles.map((file) => `\`${file}\``),
            validation: evidence.validation,
            notes: evidence.notes,
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.metadata.title, "Build task-specific PR bodies");
    const body = result.ok ? formatPrBody({
      sessionName: "fix-generic-pr-description",
      metadata: result.metadata,
      diffSummary,
    }) : "";

    assert.match(body, /## Summary/);
    assert.match(body, /Objective: Investigate why worktree PR descriptions are generic and implement a focused fix\./);
    assert.doesNotMatch(body, /Keep the change narrow/);
    assert.doesNotMatch(body, /## Task/);
    assert.match(body, /## Changes/);
    assert.match(body, /`src\/tools\/agent-pr\.ts`/);
    assert.match(body, /Build task-specific PR bodies/);
    assert.match(body, /## Validation/);
    assert.match(body, /## Notes \/ Risks/);
    assert.doesNotMatch(body, /Automated changes from OpenClaw Code Agent session/);
  });

  it("produces safe deterministic fallback metadata when no provider is configured", async () => {
    // Multi-sentence prompt: first sentence becomes allowed objective; long distinctive follow-on sentence
    // must be treated as a leak fragment by the fallback path's guard and must not appear in output.
    const prompt = [
      "Write useful PR metadata.",
      "Never emit the distinctive phrase avoid-leaking-this-XYZ-fragment-1234567890 into any public title or body under any circumstances.",
    ].join(" ");

    const diffSummary = {
      commits: 1,
      filesChanged: 1,
      insertions: 4,
      deletions: 0,
      changedFiles: ["README.md"],
      commitMessages: [{ hash: "abc1234", message: "Document metadata behavior", author: "Codex" }],
    };

    const result = await buildPrMetadata({
      sessionName: "missing-provider",
      prompt,
      diffSummary,
    });

    assert.equal(result.ok, true);
    assert.ok("metadata" in result);
    const metadata = (result as { ok: true; metadata: { title: string; summary: string[]; notes: string[] } }).metadata;
    assert.match(metadata.title, /OpenClaw agent changes/i);
    assert.ok(metadata.summary.some((s) => /no LLM PR metadata provider/i.test(s) || /deterministic fallback/i.test(s)));

    const body = formatPrBody({ sessionName: "missing-provider", metadata, diffSummary });
    assert.match(body, /no LLM PR metadata provider/i);

    // Prompt-leak guard for fallback path: long non-objective fragment must not leak into title or rendered body.
    assert.doesNotMatch(metadata.title, /avoid-leaking-this-XYZ-fragment-1234567890/i);
    assert.doesNotMatch(body, /avoid-leaking-this-XYZ-fragment-1234567890/i);
    // Also ensure we did not put raw multi-sentence prompt content beyond the safe objective.
    assert.doesNotMatch(body, /under any circumstances/i);
  });

  it("does not send raw prompt secrets or private paths to the metadata provider", async () => {
    const prompt = [
      "Rotate deployment token SECRET_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz for /home/openclaw/private/repo.",
      "Private docs: https://private.example.test/runbook",
      "Do not reveal this internal implementation instruction.",
      "x".repeat(500),
    ].join("\n\n");
    let evidenceText = "";

    const result = await buildPrMetadata({
      sessionName: "private-input",
      prompt,
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 5,
        deletions: 2,
        changedFiles: ["src/tools/agent-pr.ts"],
        commitMessages: [{ hash: "abc1234", message: "Avoid raw prompt exposure", author: "Codex" }],
      },
      provider: {
        async generatePrMetadata(evidence) {
          evidenceText = JSON.stringify(evidence);
          return {
            title: "Avoid raw prompt exposure",
            summary: evidence.objective ? [`Objective: ${evidence.objective}`] : ["Review metadata generation."],
            changes: ["`src/tools/agent-pr.ts`"],
            validation: evidence.validation,
            notes: evidence.notes,
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.doesNotMatch(evidenceText, /SECRET_TOKEN/);
    assert.doesNotMatch(evidenceText, /ghp_1234567890abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(evidenceText, /\/home\/openclaw\/private\/repo/);
    assert.doesNotMatch(evidenceText, /private\.example\.test/);
    assert.doesNotMatch(evidenceText, /Do not reveal this internal implementation instruction/);
    assert.doesNotMatch(evidenceText, new RegExp("x{100}"));
    assert.match(evidenceText, /\[redacted credential\]/);
    assert.match(evidenceText, /\[redacted path\]/);
  });

  it("redacts token-like commit subjects before sending metadata evidence to the provider", async () => {
    let evidenceCommitSubjects: string[] = [];

    const result = await buildPrMetadata({
      sessionName: "private-commit-subjects",
      prompt: "Summarize safe commit-subject evidence.",
      diffSummary: {
        commits: 3,
        filesChanged: 1,
        insertions: 7,
        deletions: 1,
        changedFiles: ["src/tools/agent-pr.ts"],
        commitMessages: [
          { hash: "abc1234", message: "Rotate deployment token SECRET_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz", author: "Codex" },
          { hash: "def5678", message: "Document generated metadata safety", author: "Codex" },
          { hash: "fed4321", message: "Remove leaked key sk-abcdefghijklmnopqrstuvwxyz123456", author: "Codex" },
        ],
      },
      provider: {
        async generatePrMetadata(evidence) {
          evidenceCommitSubjects = evidence.commitSubjects;
          return {
            title: "Redact commit metadata evidence",
            summary: ["Redacts sensitive commit subject details before metadata generation."],
            changes: ["`src/tools/agent-pr.ts`"],
            validation: evidence.validation,
            notes: evidence.notes,
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(evidenceCommitSubjects, [
      "Rotate deployment [redacted credential]",
      "Document generated metadata safety",
      "Remove leaked key [redacted token]",
    ]);
    const evidenceText = JSON.stringify(evidenceCommitSubjects);
    assert.doesNotMatch(evidenceText, /SECRET_TOKEN/);
    assert.doesNotMatch(evidenceText, /ghp_1234567890abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(evidenceText, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  });

  it("redacts token-like commit subjects in the rendered PR body commits block", () => {
    const body = formatPrBody({
      sessionName: "private-commit-body",
      metadata: {
        title: "Redact commit metadata evidence",
        summary: ["Redacts sensitive commit subject details before rendering."],
        changes: ["`src/tools/agent-pr.ts`"],
        validation: ["pnpm test:file tests/agent-pr-tool.test.ts"],
        notes: ["Keeps commit context while removing sensitive values."],
      },
      diffSummary: {
        commits: 3,
        filesChanged: 1,
        insertions: 7,
        deletions: 1,
        changedFiles: ["src/tools/agent-pr.ts"],
        commitMessages: [
          { hash: "abc1234", message: "Rotate deployment token SECRET_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz", author: "Codex" },
          { hash: "def5678", message: "Document generated metadata safety", author: "Codex" },
          { hash: "fed4321", message: "Remove leaked key sk-abcdefghijklmnopqrstuvwxyz123456", author: "Codex" },
        ],
      },
    });

    assert.match(body, /## Commits/);
    assert.match(body, /- abc1234 Rotate deployment \[redacted credential\] \(Codex\)/);
    assert.match(body, /- def5678 Document generated metadata safety \(Codex\)/);
    assert.match(body, /- fed4321 Remove leaked key \[redacted token\] \(Codex\)/);
    assert.doesNotMatch(body, /SECRET_TOKEN/);
    assert.doesNotMatch(body, /ghp_1234567890abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(body, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  });

  it("fails explicitly when LLM metadata is invalid, unsafe, or references files outside the evidence", async () => {
    const diffSummary = {
      commits: 1,
      filesChanged: 1,
      insertions: 8,
      deletions: 1,
      changedFiles: ["src/tools/agent-pr.ts"],
      commitMessages: [{ hash: "abc1234", message: "Harden PR metadata generation", author: "Codex" }],
    };

    const cases: unknown[] = [
      { title: "", summary: [], changes: [], validation: [], notes: [] },
      {
        title: "Leak ghp_1234567890abcdefghijklmnopqrstuvwxyz",
        summary: ["Looks fine"],
        changes: ["`src/tools/agent-pr.ts`"],
        validation: ["Not recorded by agent_pr. Review CI/checks and session output before merging."],
        notes: ["No notes"],
      },
      {
        title: "Invented file",
        summary: ["Looks fine"],
        changes: ["`src/does-not-exist.ts`"],
        validation: ["Not recorded by agent_pr. Review CI/checks and session output before merging."],
        notes: ["No notes"],
      },
      {
        title: "Opaque token",
        summary: ["Token abcdefghijklmnopqrstuvwxyzABCDEF12345678 was emitted."],
        changes: ["`src/tools/agent-pr.ts`"],
        validation: ["Not recorded by agent_pr. Review CI/checks and session output before merging."],
        notes: ["No notes"],
      },
    ];

    for (const generated of cases) {
      const result = await buildPrMetadata({
        sessionName: "invalid-output-session",
        prompt: "Harden generated PR metadata. SECRET_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz",
        diffSummary,
        provider: { async generatePrMetadata() { return generated; } },
      });

      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, /failed schema or safety validation/);
      assert.equal("metadata" in result, false);
    }
  });

  it("does not reject ordinary JS/TS command mentions in safe model output", async () => {
    const result = await buildPrMetadata({
      sessionName: "command-mentions",
      prompt: "Describe package metadata updates.",
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 8,
        deletions: 1,
        changedFiles: ["package.json"],
        commitMessages: [{ hash: "abc1234", message: "Update package metadata", author: "Codex" }],
      },
      provider: {
        async generatePrMetadata() {
          return {
            title: "Update package metadata",
            summary: ["Updates npm package metadata for the plugin."],
            changes: ["`package.json`"],
            validation: ["Review CI checks before merging."],
            notes: ["No pnpm command was run by metadata generation."],
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.metadata.title, "Update package metadata");
  });

  it("rejects hallucinated root-level changed file names", async () => {
    const result = await buildPrMetadata({
      sessionName: "root-file-hallucination",
      prompt: "Summarize root-level documentation changes.",
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 6,
        deletions: 2,
        changedFiles: ["README.md"],
        commitMessages: [{ hash: "abc1234", message: "Update README metadata", author: "Codex" }],
      },
      provider: {
        async generatePrMetadata() {
          return {
            title: "Update documentation metadata",
            summary: ["Updates the root-level documentation summary."],
            changes: ["`CHANGELOG.md`"],
            validation: ["Review CI checks before merging."],
            notes: ["No notes"],
          };
        },
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /failed schema or safety validation/);
  });

  it("rejects hallucinated root-level JS and TS file names", async () => {
    const diffSummary = {
      commits: 1,
      filesChanged: 2,
      insertions: 10,
      deletions: 2,
      changedFiles: ["index.js", "types.ts"],
      commitMessages: [{ hash: "abc1234", message: "Update root metadata", author: "Codex" }],
    };

    const cases: unknown[] = [
      {
        title: "Update root metadata",
        summary: ["Updates root package behavior."],
        changes: ["`config.js`"],
        validation: ["Review CI checks before merging."],
        notes: ["No notes"],
      },
      {
        title: "Update root metadata",
        summary: ["Updates root package behavior."],
        changes: ["Updated declarations.ts"],
        validation: ["Review CI checks before merging."],
        notes: ["No notes"],
      },
    ];

    for (const generated of cases) {
      const result = await buildPrMetadata({
        sessionName: "root-js-ts-hallucination",
        prompt: "Summarize root-level package changes.",
        diffSummary,
        provider: { async generatePrMetadata() { return generated; } },
      });

      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, /failed schema or safety validation/);
    }
  });

  it("does not reject ordinary root-like technology names", async () => {
    const result = await buildPrMetadata({
      sessionName: "ordinary-root-like-names",
      prompt: "Describe package metadata updates.",
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 8,
        deletions: 1,
        changedFiles: ["package.json"],
        commitMessages: [{ hash: "abc1234", message: "Update package metadata", author: "Codex" }],
      },
      provider: {
        async generatePrMetadata() {
          return {
            title: "Update package metadata",
            summary: ["Keeps Node.js package metadata current."],
            changes: ["`package.json`"],
            validation: ["Review CI checks before merging."],
            notes: ["No pnpm command was run by metadata generation."],
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.metadata.summary.includes("Keeps Node.js package metadata current."), true);
  });

  it("does not reject quoted root-like technology names", async () => {
    const result = await buildPrMetadata({
      sessionName: "quoted-root-like-names",
      prompt: "Describe package metadata updates.",
      diffSummary: {
        commits: 1,
        filesChanged: 1,
        insertions: 8,
        deletions: 1,
        changedFiles: ["package.json"],
        commitMessages: [{ hash: "abc1234", message: "Update package metadata", author: "Codex" }],
      },
      provider: {
        async generatePrMetadata() {
          return {
            title: "Update package metadata",
            summary: ["Keeps `Node.js` package metadata current."],
            changes: ["`package.json`"],
            validation: ["Review CI checks before merging."],
            notes: ["No `pnpm` command was run by metadata generation."],
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.metadata.summary.includes("Keeps `Node.js` package metadata current."), true);
  });

  it("does not reject dotted technology names when root files share their extensions", async () => {
    const result = await buildPrMetadata({
      sessionName: "dotted-technology-names-with-root-files",
      prompt: "Describe JavaScript package metadata updates.",
      diffSummary: {
        commits: 1,
        filesChanged: 3,
        insertions: 12,
        deletions: 3,
        changedFiles: ["index.js", "types.ts", "README.md"],
        commitMessages: [{ hash: "abc1234", message: "Update JavaScript package metadata", author: "Codex" }],
      },
      provider: {
        async generatePrMetadata() {
          return {
            title: "Update JavaScript package metadata",
            summary: ["Updates Node.js package metadata and documents `Next.js` support."],
            changes: ["`index.js`", "`types.ts`", "`README.md`"],
            validation: ["Review CI checks before merging."],
            notes: ["No `pnpm` command was run by metadata generation."],
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.metadata.summary.includes("Updates Node.js package metadata and documents `Next.js` support."), true);
  });

  it("rejects hallucinated dot-prefixed path mentions", async () => {
    const diffSummary = {
      commits: 1,
      filesChanged: 1,
      insertions: 8,
      deletions: 1,
      changedFiles: ["src/tools/agent-pr.ts"],
      commitMessages: [{ hash: "abc1234", message: "Harden metadata path checks", author: "Codex" }],
    };

    const cases: unknown[] = [
      {
        title: "Update workflow metadata",
        summary: ["Updates hidden workflow metadata."],
        changes: ["`src/tools/agent-pr.ts`", "`.github/workflows/ci.yml`"],
        validation: ["Review CI checks before merging."],
        notes: ["No notes"],
      },
      {
        title: "Update environment metadata",
        summary: ["Updates hidden environment metadata."],
        changes: ["Changed `.env` handling."],
        validation: ["Review CI checks before merging."],
        notes: ["No notes"],
      },
    ];

    for (const generated of cases) {
      const result = await buildPrMetadata({
        sessionName: "dot-path-hallucination",
        prompt: "Summarize metadata validation changes.",
        diffSummary,
        provider: { async generatePrMetadata() { return generated; } },
      });

      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, /failed schema or safety validation/);
    }
  });

  it("allows changed dot-prefixed files and dotted technology names", async () => {
    const result = await buildPrMetadata({
      sessionName: "dot-paths-and-tech-names",
      prompt: "Describe hidden path validation updates.",
      diffSummary: {
        commits: 1,
        filesChanged: 3,
        insertions: 20,
        deletions: 4,
        changedFiles: [
          ".github/workflows/ci.yml",
          ".env",
          "src/tools/agent-pr.ts",
        ],
        commitMessages: [{ hash: "abc1234", message: "Handle hidden path metadata", author: "Codex" }],
      },
      provider: {
        async generatePrMetadata() {
          return {
            title: "Handle hidden path metadata",
            summary: ["Keeps `.NET` and Node.js wording safe while checking hidden path mentions."],
            changes: ["`src/tools/agent-pr.ts`", "`.github/workflows/ci.yml`", "Changed `.env` validation."],
            validation: ["Review CI checks before merging."],
            notes: ["No pnpm command was run by metadata generation."],
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.metadata.changes.includes("`.github/workflows/ci.yml`"), true);
    assert.equal(result.ok && result.metadata.changes.includes("Changed `.env` validation."), true);
  });

  it("allows model output to mention files beyond the first ten changed files", async () => {
    const changedFiles = Array.from({ length: 12 }, (_, index) => `src/file-${index + 1}.ts`);
    const result = await buildPrMetadata({
      sessionName: "large-change",
      prompt: "Summarize a larger change set.",
      diffSummary: {
        commits: 1,
        filesChanged: changedFiles.length,
        insertions: 48,
        deletions: 12,
        changedFiles,
        commitMessages: [{ hash: "abc1234", message: "Update src/file-12.ts metadata", author: "Codex" }],
      },
      provider: {
        async generatePrMetadata(evidence) {
          assert.equal(evidence.changedFiles.includes("src/file-12.ts"), true);
          return {
            title: "Update large change metadata",
            summary: ["Updates metadata across a larger file set."],
            changes: ["`src/file-12.ts`"],
            validation: ["Review CI checks before merging."],
            notes: ["Mentions a changed file beyond the first ten evidence entries."],
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.metadata.changes.includes("`src/file-12.ts`"), true);
  });
});
