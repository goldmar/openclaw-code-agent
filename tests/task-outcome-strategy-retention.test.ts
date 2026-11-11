import "./test-env";
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRepoLock } from "../src/git-exec";
import { getDiffSummary, mergeBranch, pushBranch } from "../src/worktree-merge";
import { createPR, updatePRBody, updatePRTitle, commentOnPR } from "../src/worktree-pr";
import { setGitHubCliAvailabilityForTests } from "../src/worktree-repo";
import { SessionWorktreeStrategyService } from "../src/session-worktree-strategy-service";
import { SessionWorktreeMessageService } from "../src/session-worktree-message-service";
import { Session } from "../src/session";
import { SessionManager } from "../src/session-manager";
import { setSessionManager } from "../src/singletons";
import { makeAgentMergeTool } from "../src/tools/agent-merge";
import { createStubSession } from "./helpers";
import { reviewedTaskFixture, reviewedTaskInput } from "./task-outcome-fixture";
import { createTaskOutcomeReport } from "../src/session-task-outcome";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: TestContext, change = false) {
  const root = mkdtempSync(join(tmpdir(), "oca-strategy-ticket-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture User");
  git("config", "user.email", "fixture@example.com");
  git("commit", "--allow-empty", "-qm", "base");
  git("worktree", "add", "-b", "agent/task", worktree, "main");
  if (change) {
    writeFileSync(join(worktree, "task.txt"), "verified task\n");
    execFileSync("git", ["-C", worktree, "add", "task.txt"]);
    execFileSync("git", ["-C", worktree, "commit", "-qm", "task"]);
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo, worktree, git };
}

describe("integration effects retain their task admission", () => {
  it("preserves a clean checkout resumed while implicit cleanup waits for the repository lock", async (t) => {
    const f = fixture(t);
    const session = reviewedTaskFixture(createStubSession({ status: "completed", startedAt: 1,
      workdir: f.worktree, originalWorkdir: f.repo, worktreePath: f.worktree, worktreeBranch: "agent/task" }) as Session);
    const locked = deferred(), release = deferred(), checked = deferred();
    const patches: unknown[] = [], notices: unknown[] = [];
    let current: "completed" | "running" = "completed";
    let reads = 0;
    const service = new SessionWorktreeStrategyService({
      shouldRunWorktreeStrategy: () => true, isAlreadyMerged: () => false,
      resolveWorktreeRepoDir: () => f.repo, getWorktreeCompletionState: () => "no-change",
      updatePersistedSession: (_ref, patch) => { patches.push(patch); return true; },
      dispatchSessionNotification: (_session, request) => { notices.push(request); },
      getCurrentSessionStatus: () => { if (++reads === 2) checked.resolve(); return current; },
      getOutputPreview: () => "", originThreadLine: () => "", getWorktreeDecisionButtons: () => undefined,
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "unused" }),
      worktreeMessages: new SessionWorktreeMessageService(), enqueueMerge: async (_repo, fn) => fn(),
      mergeBranch, spawnConflictResolver: async () => ({ id: "unused", name: "unused" }),
      runAutoPr: async () => ({ success: true, notificationSent: false }),
    });
    const lock = withRepoLock(f.repo, async () => { locked.resolve(); await release.promise; });
    await locked.promise;
    const cleanup = service["handleNoChange"](session, f.repo, f.worktree, "agent/task");
    try {
      await checked.promise;
      // Let the cleanup continuation enqueue behind the deliberately held lock.
      await Promise.resolve();
      current = "running";
      release.resolve();
      assert.deepEqual(await cleanup, { notificationSent: false, worktreeRemoved: false });
      assert.equal(existsSync(f.worktree), true);
      assert.equal(session.worktreePath, f.worktree);
      assert.deepEqual(patches, []);
      assert.deepEqual(notices, []);
    } finally { release.resolve(); await lock; }
  });

  it("refuses a queued merge after its execution resumes, before changing the base", async (t) => {
    const f = fixture(t, true), locked = deferred(), release = deferred();
    const before = f.git("rev-parse", "main");
    let current = true;
    const lock = withRepoLock(f.repo, async () => { locked.resolve(); await release.promise; });
    await locked.promise;
    const pending = mergeBranch(f.repo, "agent/task", "main", "merge", f.worktree, {
      refresh: async () => current, isCurrent: () => current,
    });
    current = false;
    release.resolve();
    try {
      const result = await pending;
      assert.equal(result.success, false);
      assert.equal(result.code, "task_not_ready");
      assert.equal(f.git("rev-parse", "main"), before);
      assert.equal(existsSync(join(f.repo, "task.txt")), false);
      assert.equal(existsSync(join(f.worktree, "task.txt")), true);
    } finally { release.resolve(); await lock; }
  });

  it("checks the synchronous ticket after the final awaited push refresh", async (t) => {
    const f = fixture(t, true);
    const remote = join(f.root, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: ["ignore", "pipe", "pipe"] });
    f.git("remote", "add", "origin", remote);
    let current = true;
    assert.equal(await pushBranch(f.repo, "agent/task", "origin", {
      refresh: async () => { current = false; return true; }, isCurrent: () => current,
    }), false);
    assert.equal(execFileSync("git", ["-C", remote, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).trim(), "");
  });

  it("continues an admitted delegated callback merge through its own rebase and local-remote push", async (t) => {
    const f = fixture(t, true);
    const remote = join(f.root, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: ["ignore", "pipe", "pipe"] });
    f.git("remote", "add", "origin", remote);
    writeFileSync(join(f.repo, "upstream.txt"), "new base\n");
    f.git("add", "upstream.txt"); f.git("commit", "-qm", "advance main");
    const sm = new SessionManager(2, 5, { store: { indexPath: join(f.root, "sessions.json") } });
    const session = new Session({ prompt: "Complete task", workdir: f.worktree, permissionMode: "bypassPermissions", worktreeStrategy: "delegate",
      route: { provider: "telegram", target: "12345", sessionKey: "agent:fixture-reviewer" } }, "rebase-push");
    Object.assign(session, { originalWorkdir: f.repo, worktreePath: f.worktree, worktreeBranch: "agent/task", worktreeBaseBranch: "main",
      harnessSessionId: "backend-task", backendRef: { kind: "claude-code", conversationId: "backend-task" } });
    session.transition("running"); session.transition("completed");
    session.taskOutcome = createTaskOutcomeReport(reviewedTaskInput(session), { source: "orchestrator" });
    const oldHead = session.taskOutcome!.repositories[0].head;
    sm["sessions"].set(session.id, session);
    sm["store"].persistTerminal(session);
    sm.notifyWorktreeOutcome = () => {};
    setSessionManager(sm);
    t.after(() => { setSessionManager(null); sm.dispose(); });
    await sm.setRepoPolicy(f.repo, "never-pr");
    const result = await makeAgentMergeTool().execute("callback", { ocaSessionId: session.id, push: true, delete_branch: false });
    assert.equal("meta" in result && result.meta?.success, true);
    assert.notEqual(f.git("rev-parse", "agent/task"), oldHead, "the admitted integration rebased its own source");
    assert.equal(execFileSync("git", ["-C", remote, "rev-parse", "main"], { encoding: "utf8" }).trim(), f.git("rev-parse", "main"));
    assert.equal(existsSync(join(f.repo, "task.txt")), true);
  });

  it("retires the worktree after an automatic merge rebased its own reported head", async (t) => {
    const f = fixture(t, true);
    writeFileSync(join(f.repo, "upstream.txt"), "new base\n");
    f.git("add", "upstream.txt"); f.git("commit", "-qm", "advance main");
    const session = reviewedTaskFixture(createStubSession({ name: "auto-merge-rebase", status: "completed", startedAt: 1,
      workdir: f.worktree, originalWorkdir: f.repo, worktreePath: f.worktree, worktreeBranch: "agent/task" }) as Session);
    const oldHead = session.taskOutcome.repositories[0].head;
    const notices: Array<{ label?: string }> = [];
    const service = new SessionWorktreeStrategyService({
      shouldRunWorktreeStrategy: () => true, isAlreadyMerged: () => false,
      resolveWorktreeRepoDir: () => f.repo, getWorktreeCompletionState: () => "has-commits",
      updatePersistedSession: () => true,
      dispatchSessionNotification: (_session, request) => { notices.push(request); },
      getOutputPreview: () => "", originThreadLine: () => "", getWorktreeDecisionButtons: () => undefined,
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "unused" }),
      worktreeMessages: new SessionWorktreeMessageService(), enqueueMerge: async (_repo, fn) => fn(),
      mergeBranch, spawnConflictResolver: async () => ({ id: "unused", name: "unused" }),
      runAutoPr: async () => ({ success: true, notificationSent: false }),
    });
    const result = await service["handleAutoMergeStrategy"](session, f.repo, f.worktree, "agent/task", "main",
      (await getDiffSummary(f.repo, "agent/task", "main"))!);
    assert.notEqual(f.git("rev-parse", "main"), oldHead, "the merge landed a rebased head on main");
    assert.equal(f.git("rev-list", "--merges", "main"), "", "the task commit was rebased, not merged");
    assert.equal(f.git("rev-list", "--count", "main"), "3", "base, advanced base and the rebased task commit");
    assert.equal(existsSync(join(f.repo, "task.txt")), true, "the merge landed");
    assert.deepEqual(result, { notificationSent: true, worktreeRemoved: true });
    assert.equal(existsSync(f.worktree), false, "the merged worktree is retired");
    assert.equal(f.git("branch", "--list", "agent/task"), "", "the merged branch is deleted");
    assert.equal(session.worktreePath, undefined);
    assert.deepEqual(notices.map((notice) => notice.label), ["worktree-merge-success"]);
  });

  it("keeps a worktree and branch that gained a commit after the automatic merge", async (t) => {
    const f = fixture(t, true);
    writeFileSync(join(f.repo, "upstream.txt"), "new base\n");
    f.git("add", "upstream.txt"); f.git("commit", "-qm", "advance main");
    const session = reviewedTaskFixture(createStubSession({ name: "auto-merge-late-commit", status: "completed", startedAt: 1,
      workdir: f.worktree, originalWorkdir: f.repo, worktreePath: f.worktree, worktreeBranch: "agent/task" }) as Session);
    const service = new SessionWorktreeStrategyService({
      shouldRunWorktreeStrategy: () => true, isAlreadyMerged: () => false,
      resolveWorktreeRepoDir: () => f.repo, getWorktreeCompletionState: () => "has-commits",
      updatePersistedSession: () => true, dispatchSessionNotification: () => {},
      getOutputPreview: () => "", originThreadLine: () => "", getWorktreeDecisionButtons: () => undefined,
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "unused" }),
      worktreeMessages: new SessionWorktreeMessageService(), enqueueMerge: async (_repo, fn) => fn(),
      // Another writer commits cleanly after the merge released the repository lock.
      mergeBranch: async (...args: Parameters<typeof mergeBranch>) => {
        const result = await mergeBranch(...args);
        writeFileSync(join(f.worktree, "later.txt"), "not merged\n");
        execFileSync("git", ["-C", f.worktree, "add", "later.txt"]);
        execFileSync("git", ["-C", f.worktree, "commit", "-qm", "later work"]);
        return result;
      },
      spawnConflictResolver: async () => ({ id: "unused", name: "unused" }),
      runAutoPr: async () => ({ success: true, notificationSent: false }),
    });
    const result = await service["handleAutoMergeStrategy"](session, f.repo, f.worktree, "agent/task", "main",
      (await getDiffSummary(f.repo, "agent/task", "main"))!);
    assert.equal(existsSync(join(f.repo, "task.txt")), true, "the merge landed");
    assert.equal(result.worktreeRemoved, false);
    assert.equal(existsSync(join(f.worktree, "later.txt")), true, "the later commit's checkout is kept");
    assert.equal(f.git("log", "-1", "--format=%s", "agent/task"), "later work", "the branch with unmerged work is kept");
  });

  it("reports an unreadable change summary as retryable without deciding anything", async (t) => {
    const f = fixture(t, true);
    const session = reviewedTaskFixture(createStubSession({ name: "diff-unreadable", status: "completed", startedAt: 1,
      workdir: f.worktree, originalWorkdir: f.repo, worktreePath: f.worktree, worktreeBranch: "agent/task",
      worktreeBaseBranch: "missing-base", worktreeStrategy: "auto-merge" }) as Session);
    const patches: unknown[] = [], notices: unknown[] = [];
    const service = new SessionWorktreeStrategyService({
      shouldRunWorktreeStrategy: () => true, isAlreadyMerged: () => false,
      resolveWorktreeRepoDir: () => f.repo, getWorktreeCompletionState: () => "has-commits",
      updatePersistedSession: (_ref, patch) => { patches.push(patch); return true; },
      dispatchSessionNotification: (_session, request) => { notices.push(request); },
      getOutputPreview: () => "", originThreadLine: () => "", getWorktreeDecisionButtons: () => undefined,
      makeOpenPrButton: () => ({ label: "Open PR", callbackData: "unused" }),
      worktreeMessages: new SessionWorktreeMessageService(), enqueueMerge: async (_repo, fn) => fn(),
      mergeBranch, spawnConflictResolver: async () => ({ id: "unused", name: "unused" }),
      runAutoPr: async () => ({ success: true, notificationSent: false }),
    });
    const result = await service.handleWorktreeStrategy(session);
    assert.equal(result.retryable, true);
    assert.equal(result.notificationSent, false);
    assert.equal(result.worktreeRemoved, false);
    assert.match(result.completionNote ?? "", /change summary for `agent\/task` against `missing-base` could not be read.*resubmitting the same outcome report/);
    assert.deepEqual(patches, []);
    assert.deepEqual(notices, []);
    assert.equal(existsSync(f.worktree), true);
  });

  it("retains the applied merge fact when ownership changes before stash restoration", async (t) => {
    const f = fixture(t, true);
    writeFileSync(join(f.repo, "local.txt"), "base\n");
    f.git("add", "local.txt"); f.git("commit", "-qm", "local base");
    execFileSync("git", ["-C", f.worktree, "rebase", "main"], { stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(join(f.repo, "local.txt"), "preserve dirty base\n");
    const result = await mergeBranch(f.repo, "agent/task", "main", "merge", f.worktree, {
      refresh: async () => true, isCurrent: () => !existsSync(join(f.repo, "task.txt")),
    });
    assert.equal(result.success, true);
    assert.equal(result.localMerged, true);
    assert.equal(result.code, "task_not_ready");
    assert.equal(existsSync(join(f.repo, "task.txt")), true, "the merge actually landed");
    assert.notEqual(f.git("stash", "list"), "", "the original changes remain recoverable");
    assert.equal(existsSync(f.worktree), true);
  });

  it("refuses PR creation after argument preparation if the task ticket changed", async (t) => {
    const f = fixture(t, true);
    f.git("remote", "add", "origin", "git@github.com:example/repo.git");
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    const marker = join(f.root, "gh-ran");
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected PR effect');\nprocess.exit(1);\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const original = process.env.PATH;
    process.env.PATH = `${bin}:${original ?? ""}`;
    setGitHubCliAvailabilityForTests(true);
    t.after(() => { process.env.PATH = original; setGitHubCliAvailabilityForTests(undefined); });
    let current = true;
    const result = await createPR(f.repo, "agent/task", "main", "Task", "Reviewed task.", "example/repo", {
      draft: true, mutationGuard: { refresh: async () => { current = false; return true; }, isCurrent: () => current },
    });
    assert.equal(result.success, false);
    assert.equal(result.code, "task_not_ready");
    assert.equal(existsSync(marker), false);
  });

  for (const operation of [updatePRBody, updatePRTitle, commentOnPR]) {
    it(`refuses ${operation.name} after its awaited task refresh`, async (t) => {
      const f = fixture(t);
      const bin = join(f.root, "bin"); mkdirSync(bin);
      const marker = join(f.root, "gh-ran");
      writeFileSync(join(bin, "gh"), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected PR effect');\nprocess.exit(1);\n`);
      chmodSync(join(bin, "gh"), 0o755);
      const original = process.env.PATH;
      process.env.PATH = `${bin}:${original ?? ""}`;
      setGitHubCliAvailabilityForTests(true);
      t.after(() => { process.env.PATH = original; setGitHubCliAvailabilityForTests(undefined); });
      let current = true;
      assert.equal(await operation(f.repo, 1, "Reviewed metadata", "example/repo", {
        refresh: async () => { current = false; return true; }, isCurrent: () => current,
      }), false);
      assert.equal(existsSync(marker), false);
    });
  }
});
