import "./test-env";
import { before, after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeGitHub, git, type FakeGitHub } from "./fake-github";
import { startFullStack, type FullStack } from "./fullstack-fixture";
import { resolveOwningPr } from "../src/worktree-owning-pr";
import { resolveWorktreeLifecycle } from "../src/worktree-lifecycle-resolver";
import type { WorktreeStrategy } from "../src/types";

let github: FakeGitHub;
let stack: FullStack | undefined;
let sequence = 0;
before(() => { github = createFakeGitHub(); });
after(() => { github.dispose(); });
afterEach(async () => { await stack?.dispose(); stack = undefined; github.resetState(); });

function commit(dir: string, file: string): string {
  writeFileSync(join(dir, file), `${file}\n`);
  git(dir, "add", file);
  git(dir, "commit", "-m", `add ${file}`);
  return git(dir, "rev-parse", "HEAD");
}

async function fixture(strategy: WorktreeStrategy = "ask") {
  const s = stack = await startFullStack({ backend: "codex" });
  await s.sm.setRepoPolicy(github.repoDir, "pr-allowed");
  const name = `tracked-owner-${++sequence}`;
  const session = await s.launch({ name, workdir: github.repoDir, worktreeStrategy: strategy });
  const branch = session.worktreeBranch!;
  const head = `dependency/existing-${sequence}`;
  const first = commit(session.worktreePath!, "first.txt");
  git(session.worktreePath!, "push", "origin", `HEAD:refs/heads/${head}`);
  git(github.repoDir, "branch", "--set-upstream-to", `origin/${head}`, branch);
  const pr = github.seedPr({ headRefName: head, headRefOid: first, isDraft: true });
  const resolve = () => resolveOwningPr({ repoDir: github.repoDir, worktreeBranch: branch, baseBranch: "main" });
  assert.equal(git(github.repoDir, "branch", "--show-current"), "main");
  assert.equal(s.sm.getPersistedSession(session.id)?.worktreePrUrl, undefined);
  return { s, session, branch, head, first, pr, resolve };
}

describe("owning PR discovery through a differently named upstream", () => {
  it("completes up to date, persists linkage, and retains the worktree without a landing prompt", async () => {
    const f = await fixture("delegate");
    await f.s.backend.endTurn("Updated the existing dependency PR using git and gh.");
    const done = await f.s.waitForMessage(new RegExp(`^✅ \\[${f.session.name}\\] Completed — PR is up to date`));
    assert.ok(done.text.includes(f.pr.url));
    const row = f.s.sm.getPersistedSession(f.session.id)!;
    assert.equal(row.worktreePrUrl, f.pr.url);
    assert.equal(row.worktreePrHeadBranch, f.head);
    assert.equal(row.worktreePrBaseBranch, "main");
    assert.equal(row.worktreeState, "pr_open");
    assert.equal(existsSync(f.session.worktreePath!), true);
    assert.equal(github.ghCalls("create").length, 0);
    assert.equal(f.s.messages().some((message) => message.text.startsWith(`🔀 [${f.session.name}]`)), false);
    // A stale parent escalation still must not ask the user to land already-delivered work.
    f.s.sm.updatePersistedSession(f.session.id, { worktreeState: "pending_decision", pendingWorktreeDecisionSince: new Date().toISOString() });
    const reply = await f.s.runTool("agent_escalate", { ocaSessionId: f.session.id, kind: "worktree", summary: "Retain for later review." });
    assert.match(reply, /PR is up to date/);
    assert.equal(f.s.sm.getPersistedSession(f.session.id)?.worktreeState, "pr_open");
    assert.equal(f.s.sm.getPersistedSession(f.session.id)?.pendingWorktreeDecisionSince, undefined);
    assert.equal(f.s.messages().some((message) => message.buttons.some((button) => button.label === "Open PR")), false);
    const retained = await resolveWorktreeLifecycle({ ...row, worktreeLifecycle: { state: "released", updatedAt: new Date(0).toISOString() } }, { includePrSync: true });
    assert.equal(retained.preserve, true);
    assert.equal(retained.cleanupSafe, false);
  });

  it("ask offers Sync PR and pushes additional commits only to the existing head", async () => {
    const f = await fixture();
    const second = commit(f.session.worktreePath!, "second.txt");
    await f.s.backend.endTurn("Added a follow-up commit.");
    const prompt = await f.s.waitForMessage(new RegExp(`^🔀 \\[${f.session.name}\\]`));
    assert.ok(prompt.buttons.some((button) => button.label === "Sync PR"));
    assert.equal(prompt.buttons.some((button) => button.label === "Open PR"), false);
    assert.notEqual(github.remoteHead(f.head), second);
    await f.s.click(prompt.buttons.find((button) => button.label === "Sync PR")!);
    await f.s.waitForMessage(new RegExp(`^✅ \\[${f.session.name}\\] Completed — PR updated`));
    assert.equal(github.remoteHead(f.head), second);
    assert.equal(github.remoteHead(f.branch), "");
    assert.equal(github.ghCalls("create").length, 0);
    assert.equal(f.s.sm.getPersistedSession(f.session.id)?.worktreePrUrl, f.pr.url);
  });

  it("auto-pr syncs the owning head without creating a sibling", async () => {
    const f = await fixture("auto-pr");
    const second = commit(f.session.worktreePath!, "second.txt");
    await f.s.backend.endTurn("Ready to sync.");
    await f.s.waitForMessage(new RegExp(`^✅ \\[${f.session.name}\\] Completed — PR updated`));
    assert.equal(github.remoteHead(f.head), second);
    assert.equal(github.ghCalls("create").length, 0);
  });

  it("manual reports unsynced commits without pushing", async () => {
    const f = await fixture("manual");
    const second = commit(f.session.worktreePath!, "second.txt");
    await f.s.backend.endTurn("One follow-up remains local.");
    const done = await f.s.waitForMessage(new RegExp(`^✅ \\[${f.session.name}\\] Completed`));
    assert.match(done.text, /1 commit.*not in the PR/);
    assert.notEqual(github.remoteHead(f.head), second);
    assert.equal(github.ghCalls("create").length, 0);
  });

  it("agent_pr reuses an already-updated owner even with no recorded URL", async () => {
    const f = await fixture();
    assert.match(await f.s.runTool("agent_pr", { ocaSessionId: f.session.id }), /PR is up to date/);
    assert.equal(f.s.sm.getPersistedSession(f.session.id)?.worktreePrUrl, f.pr.url);
    assert.equal(github.ghCalls("create").length, 0);
    assert.equal(github.ghCalls("edit").length, 0);
    assert.equal(existsSync(f.session.worktreePath!), true);
  });

  it("force_new cannot bypass an unrecorded owning PR", async () => {
    const f = await fixture();
    assert.match(await f.s.runTool("agent_pr", { ocaSessionId: f.session.id, force_new: true }), /Cannot create new PR/);
    assert.equal(github.ghCalls("create").length, 0);
  });

  it("ambiguity blocks completion and creation", async () => {
    const f = await fixture();
    github.seedPr({ headRefName: f.branch });
    assert.equal((await f.resolve()).kind, "blocked");
    assert.match(await f.s.runTool("agent_pr", { ocaSessionId: f.session.id }), /Refusing to create a sibling PR/);
    await f.s.backend.endTurn("Ownership needs inspection.");
    const done = await f.s.waitForMessage(new RegExp(`^⚠️ \\[${f.session.name}\\] Completed — owning PR could not be verified`));
    assert.equal(done.buttons.length, 0);
    assert.equal(github.ghCalls("create").length, 0);
    assert.equal(existsSync(f.session.worktreePath!), true);
  });

  it("wrong-repository metadata and head repositories fail closed", async () => {
    const f = await fixture();
    const foreign = github.seedPr({ headRefName: f.head, repo: "other/project" });
    f.s.sm.updatePersistedSession(f.session.id, { worktreePrUrl: foreign.url });
    assert.match(await f.s.runTool("agent_pr", { ocaSessionId: f.session.id }), /Refusing to create a sibling PR/);
    github.updateState((state) => { state.prs.find((pr) => pr.number === f.pr.number)!.headRepo = "acme/unrelated"; });
    assert.equal((await f.resolve()).kind, "blocked");
    assert.equal(github.ghCalls("create").length, 0);
  });

  it("lookup failures retain work and never become absence", async () => {
    const f = await fixture();
    github.updateState((state) => { state.failures.list = "lookup unavailable"; });
    assert.equal((await f.resolve()).kind, "blocked");
    assert.match(await f.s.runTool("agent_pr", { ocaSessionId: f.session.id }), /Refusing to create a sibling PR/);
    const retained = await resolveWorktreeLifecycle({ workdir: github.repoDir, worktreeBranch: f.branch, worktreePath: f.session.worktreePath,
      worktreeBaseBranch: "main", worktreeLifecycle: { state: "released", updatedAt: new Date(0).toISOString() } });
    assert.equal(retained.cleanupSafe, false);
    assert.equal(retained.preserve, true);
    github.updateState((state) => { state.failures.list = undefined; state.failures.view = true; });
    f.s.sm.updatePersistedSession(f.session.id, { worktreePrUrl: f.pr.url });
    assert.match(await f.s.runTool("agent_pr", { ocaSessionId: f.session.id }), /Refusing to create a sibling PR/);
    assert.equal(github.ghCalls("create").length, 0);
  });

  it("rejects an upstream in a different repository", async () => {
    const f = await fixture();
    git(github.repoDir, "remote", "add", "foreign", "git@github.com:other/widget.git");
    try {
      git(github.repoDir, "config", `branch.${f.branch}.remote`, "foreign");
      assert.equal((await f.resolve()).kind, "blocked");
      assert.match(await f.s.runTool("agent_pr", { ocaSessionId: f.session.id }), /Refusing to create a sibling PR/);
      assert.equal(github.ghCalls("create").length, 0);
    } finally { git(github.repoDir, "remote", "remove", "foreign"); }
  });

  it("a landing-base upstream preserves genuine new PR creation", async () => {
    const f = await fixture();
    github.resetState();
    git(github.repoDir, "branch", "--set-upstream-to", "origin/main", f.branch);
    assert.equal((await f.resolve()).kind, "none");
    assert.match(await f.s.runTool("agent_pr", { ocaSessionId: f.session.id }), /PR opened/);
    assert.equal(github.ghCalls("create").length, 1);
  });

  it("uncommitted changes still require a commit decision even when the PR has every commit", async () => {
    const f = await fixture();
    writeFileSync(join(f.session.worktreePath!, "pending.txt"), "not committed\n");
    await f.s.backend.endTurn("Uncommitted work remains.");
    // Multi-turn sessions first get the existing finalization instruction. If the
    // backend still finishes dirty, owning-PR settlement must preserve the commit decision.
    await f.s.backend.waitForTurns(2);
    assert.match(f.s.backend.turns[1]!.text, /worktree still has uncommitted changes/);
    await f.s.backend.endTurn("Unable to commit the remaining file.");
    const prompt = await f.s.waitForMessage(new RegExp(`\\[${f.session.name}\\].*uncommitted`, "i"));
    assert.ok(prompt.buttons.some((button) => button.label === "Commit changes"));
    assert.equal(github.ghCalls("create").length, 0);
    assert.equal(existsSync(join(f.session.worktreePath!, "pending.txt")), true);
  });
});
