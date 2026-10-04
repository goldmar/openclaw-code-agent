import "./test-env";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../src/session";
import { SessionWorktreeActionService, type PlannedWorktreeAction } from "../src/session-worktree-action-service";
import { SessionWorktreeController } from "../src/session-worktree-controller";
import { createWorktree, getBranchName } from "../src/worktree";
import { buildMergedPatch } from "../src/worktree-session-patches";
import { createFakeGitHub, git, type FakeGitHub } from "./fake-github";
import { startFullStack, type FullStack, type SentButton, type SentMessage } from "./fullstack-fixture";
import { waitUntil } from "./harness-backends";

/**
 * Commits made after a session's PR was opened (or its branch was merged) must
 * not end with a plain `✅`: the worktree is "resolved" only while the branch
 * has nothing new.
 */

let github: FakeGitHub;
let stack: FullStack | undefined;

before(() => {
  github = createFakeGitHub();
});

after(() => {
  github.dispose();
});

afterEach(async () => {
  await stack?.dispose();
  stack = undefined;
  github.resetState();
});

function commit(dir: string, file: string, content: string, message: string): string {
  writeFileSync(join(dir, file), content);
  git(dir, "add", file);
  git(dir, "commit", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

function buttonIn(message: { buttons: SentButton[] }, label: string): SentButton {
  const button = message.buttons.find((candidate) => candidate.label === label);
  assert.ok(button, `a "${label}" button among ${message.buttons.map((candidate) => candidate.label).join(", ")}`);
  return button;
}

/** Messages about this session, oldest first. */
function about(s: FullStack, name: string): SentMessage[] {
  return s.messages().filter((message) => message.text.includes(`[${name}]`));
}

const completionLines = (s: FullStack, name: string): string[] =>
  about(s, name).map((message) => message.text.split("\n")[0]!).filter((line) => line.startsWith(`✅ [${name}] Completed`));

/** A running worktree session with the commit `add one`, for which `agent_pr` was called mid-run. */
async function sessionWithMidRunPr(
  s: FullStack,
  name: string,
  strategy: "ask" | "delegate" | "manual",
): Promise<{ session: Session; branch: string; prUrl: string }> {
  await s.sm.setRepoPolicy(github.repoDir, "pr-allowed");
  const session = await s.launch({ workdir: github.repoDir, worktreeStrategy: strategy, name });
  const branch = session.worktreeBranch!;
  commit(session.worktreePath!, `${name}-one.txt`, "one\n", "add one");

  await s.runTool("agent_pr", { session: session.id });
  await s.waitForMessage(new RegExp(`^ℹ️ \\[${name}\\] PR opened: `));
  const prUrl = github.readState().prs.at(-1)!.url;
  assert.equal(github.remoteHead(branch), git(github.repoDir, "rev-parse", branch), "the PR has the first commit");
  assert.equal(session.status, "running");
  return { session, branch, prUrl };
}

describe("commits after a mid-run PR (fullstack, real git, fake gh)", () => {
  it("ask: the completion is the 🔀 prompt with Sync PR, and Sync PR pushes the commit and carries the ✅", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const { session, branch, prUrl } = await sessionWithMidRunPr(s, "pr-run", "ask");

    const second = commit(session.worktreePath!, "pr-run-two.txt", "two\n", "add two");
    await s.backend.endTurn("Added both files.");

    const prompt = await s.waitForMessage(/^🔀 \[pr-run\] Finished on /);
    assert.match(prompt.text.split("\n")[0]!, /: 1 commit, 1 file, \+1\/-0/, "counts what the PR does not have");
    assert.match(prompt.text, /made after the PR was opened and are not in it yet/);
    assert.match(prompt.text, /add two/);
    assert.doesNotMatch(prompt.text, /add one/);
    const labels = prompt.buttons.map((button) => button.label);
    for (const label of ["Sync PR", "View PR", "Later", "Discard"]) assert.ok(labels.includes(label), labels.join(", "));
    assert.equal(labels.includes("Open PR"), false);
    assert.deepEqual(completionLines(s, "pr-run"), [], "the prompt replaces the completion line");
    assert.notEqual(github.remoteHead(branch), second, "not pushed before the user decides");

    await s.click(buttonIn(prompt, "Sync PR"));
    const outcome = await s.waitForMessage(/^✅ \[pr-run\] Completed — PR updated: /, prompt.index + 1);

    assert.ok(outcome.text.includes(prUrl), outcome.text);
    assert.equal(github.remoteHead(branch), second, "add two was pushed");
    assert.equal(github.readState().comments.length, 1, "the PR got its update comment");
    assert.equal(github.ghCalls("create").length, 1, "no second PR");
    assert.equal(completionLines(s, "pr-run").length, 1, "exactly one completion line for the cycle");
  });

  it("ask: nothing committed after the mid-run PR ends with the plain ✅ and no prompt", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    await sessionWithMidRunPr(s, "pr-synced", "ask");

    await s.backend.endTurn("Added the file.");
    const done = await s.waitForMessage(/^✅ \[pr-synced\] Completed/);

    assert.doesNotMatch(done.text, /not in the PR/);
    assert.equal(done.text.split("\n").length, 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(about(s, "pr-synced").some((message) => message.text.startsWith("🔀")), false);
    assert.equal(completionLines(s, "pr-synced").length, 1);
  });

  it("delegate: the orchestrator is woken about the commits the PR lacks, and the user gets one ✅", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const { session, branch, prUrl } = await sessionWithMidRunPr(s, "pr-delegate", "delegate");
    const wakesBefore = s.wakes.length;

    const second = commit(session.worktreePath!, "pr-delegate-two.txt", "two\n", "add two");
    await s.backend.endTurn("Added both files.");

    await waitUntil(() => s.wakes.slice(wakesBefore).some((wake) => /\[pr-delegate\] Finished on /.test(wake.message)), "the delegate wake");
    const wake = s.wakes.slice(wakesBefore).find((candidate) => /\[pr-delegate\] Finished on /.test(candidate.message))!;
    assert.match(wake.message, /: 1 commit, 1 file, \+1\/-0 not yet in its PR\./);
    assert.ok(wake.message.includes(`Open PR: ${prUrl}`), wake.message);
    assert.match(wake.message, /agent_pr\(session='pr-delegate'/);
    await s.waitForMessage(/^✅ \[pr-delegate\] Completed/);
    assert.equal(about(s, "pr-delegate").some((message) => message.text.startsWith("🔀")), false, "no buttons under delegate");
    assert.equal(completionLines(s, "pr-delegate").length, 1);

    // The orchestrator syncs the PR: a milestone, not a second completion.
    await s.runTool("agent_pr", { session: session.id });
    await s.waitForMessage(/^ℹ️ \[pr-delegate\] PR updated: /);
    assert.equal(github.remoteHead(branch), second);
    assert.equal(completionLines(s, "pr-delegate").length, 1);
  });

  it("manual: the ✅ says how many commits the PR does not have", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const { session, branch, prUrl } = await sessionWithMidRunPr(s, "pr-manual", "manual");

    commit(session.worktreePath!, "pr-manual-two.txt", "two\n", "add two");
    commit(session.worktreePath!, "pr-manual-three.txt", "three\n", "add three");
    await s.backend.endTurn("Added the files.");

    const done = await s.waitForMessage(/^✅ \[pr-manual\] Completed/);
    assert.deepEqual(done.text.split("\n").slice(1), [`⚠️ 2 commits on \`${branch}\` are not in the PR: ${prUrl}`]);
    assert.equal(completionLines(s, "pr-manual").length, 1);
  });
});

describe("commits after a merge (fullstack, real git, fake gh)", () => {
  // Commit times have one-second resolution: the new commit is clearly after the merge.
  const afterTheMerge = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2_100));

  it("auto-merge: commits made after the branch was merged are merged at completion, with one ✅", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    await s.sm.setRepoPolicy(github.repoDir, "never-pr");
    try {
      const session = await s.launch({ workdir: github.repoDir, worktreeStrategy: "auto-merge", name: "merge-again" });
      const branch = session.worktreeBranch!;
      commit(session.worktreePath!, "merge-again-one.txt", "one\n", "add one");
      // The branch is merged while the session runs, and the worktree is kept.
      git(github.repoDir, "merge", "-q", "--no-ff", "-m", "merge the first commit", branch);
      const mergedAt = new Date().toISOString();
      assert.equal(s.sm.updatePersistedSession(session.id, {
        ...buildMergedPatch({ worktreeBaseBranch: "main" }, { mergedAt, resolvedAt: mergedAt, updatedAt: mergedAt }),
        worktreeDisposition: "merged",
      }), true);

      await afterTheMerge();
      commit(session.worktreePath!, "merge-again-two.txt", "two\n", "add two");
      await s.backend.endTurn("Added both files.");

      await s.waitForMessage(/^✅ \[merge-again\] Completed — Merged: /);
      assert.equal(git(github.repoDir, "show", "main:merge-again-two.txt"), "two", "the commit made after the merge is on main");
      const persisted = s.sm.getPersistedSession(session.id);
      assert.equal(persisted?.worktreeLifecycle?.state, "merged");
      assert.equal(persisted?.worktreeMerged, true);
      assert.deepEqual(completionLines(s, "merge-again").length, 1, "exactly one completion line for the cycle");
      assert.equal(about(s, "merge-again").some((message) => message.text.startsWith("🔀")), false);
    } finally {
      git(github.repoDir, "reset", "-q", "--hard", "origin/main");
    }
  });

  it("auto-pr: commits made after the PR was merged get a new PR, with one ✅", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    await s.sm.setRepoPolicy(github.repoDir, "pr-allowed");
    const session = await s.launch({ workdir: github.repoDir, worktreeStrategy: "auto-pr", name: "pr-again" });
    const branch = session.worktreeBranch!;
    commit(session.worktreePath!, "pr-again-one.txt", "one\n", "add one");
    await s.runTool("agent_pr", { session: session.id });
    await s.waitForMessage(/^ℹ️ \[pr-again\] PR opened: /);
    const first = github.readState().prs.at(-1)!;
    assert.equal(s.sm.getPersistedSession(session.id)?.worktreePrHeadBranch, branch, "the pushed branch is recorded as the PR's head");

    // The PR is merged on GitHub, and the session learns it while it runs.
    github.updateState((state) => {
      state.prs.find((pr) => pr.number === first.number)!.state = "MERGED";
    });
    assert.match(await s.runTool("agent_pr", { session: session.id }), /PR was already merged/);
    assert.equal(s.sm.getPersistedSession(session.id)?.worktreeLifecycle?.state, "merged");

    await afterTheMerge();
    const second = commit(session.worktreePath!, "pr-again-two.txt", "two\n", "add two");
    await s.backend.endTurn("Added both files.");

    const done = await s.waitForMessage(/^✅ \[pr-again\] Completed — PR opened: /);
    const latest = github.readState().prs.at(-1)!;
    assert.notEqual(latest.number, first.number, "a new PR, not the merged one");
    assert.equal(latest.state, "OPEN");
    assert.ok(done.text.includes(latest.url), done.text);
    assert.equal(github.remoteHead(branch), second, "add two was pushed");
    assert.equal(github.ghCalls("create").length, 2);
    const persisted = s.sm.getPersistedSession(session.id);
    assert.equal(persisted?.worktreeLifecycle?.state, "pr_open");
    assert.equal(persisted?.worktreePrUrl, latest.url);
    assert.equal(persisted?.worktreeMerged, undefined, "not stamped merged after the new commit");
    assert.equal(completionLines(s, "pr-again").length, 1, "exactly one completion line for the cycle");

    // Nothing new since: the merged PR settles the call as before.
    github.updateState((state) => {
      state.prs.find((pr) => pr.number === latest.number)!.state = "MERGED";
    });
    assert.match(await s.runTool("agent_pr", { session: session.id }), /PR was already merged/);
    assert.equal(github.ghCalls("create").length, 2);
  });
});

describe("planner: a resolved worktree with new commits is not resolved", () => {
  let counter = 0;

  async function fixture(strategy: string, state: "pr_open" | "merged"): Promise<{ session: Session; branch: string; worktreePath: string; plan: () => Promise<PlannedWorktreeAction> }> {
    counter += 1;
    const worktreePath = await createWorktree(github.repoDir, `planner-${counter}`);
    const branch = (await getBranchName(worktreePath))!;
    commit(worktreePath, `planner-${counter}.txt`, "one\n", "add one");
    const merged = { value: state === "merged" };
    // Commit times have one-second resolution: the merge is clearly after the commit.
    if (state === "merged") await new Promise((resolve) => setTimeout(resolve, 1_100));
    const session = {
      id: `s-planner-${counter}`,
      name: `planner-${counter}`,
      status: "completed",
      phase: "done",
      worktreePath,
      worktreeBranch: branch,
      worktreeBaseBranch: "main",
      worktreeStrategy: strategy,
      worktreeState: state,
      worktreePrUrl: state === "pr_open" ? "https://github.com/acme/widget/pull/7" : undefined,
      // Recorded when the branch was merged.
      worktreeMergedAt: state === "merged" ? new Date().toISOString() : undefined,
      originalWorkdir: github.repoDir,
      harnessSessionId: `h-planner-${counter}`,
    } as unknown as Session;
    const controller = new SessionWorktreeController();
    const service = new SessionWorktreeActionService({
      shouldRunWorktreeStrategy: () => true,
      isAlreadyMerged: () => merged.value,
      resolveWorktreeRepoDir: () => github.repoDir,
      getWorktreeCompletionState: (repoDir, path, branchName, baseBranch) => controller.getCompletionState(repoDir, path, branchName, baseBranch),
      isPrAvailable: () => true,
      resolveRepoPolicy: () => ({ policy: "pr-allowed", source: "stored", provider: "github", prAvailable: true }),
    });
    return { session, branch, worktreePath, plan: () => service.plan(session) };
  }

  it("pr_open: pushed head equals the branch → still resolved; one more commit → a decision counting only that commit", async () => {
    const f = await fixture("ask", "pr_open");
    git(github.repoDir, "push", "origin", `${f.branch}:${f.branch}`);
    assert.equal((await f.plan()).kind, "skip");

    commit(f.worktreePath, "second.txt", "two\n", "add two");
    const action = await f.plan();
    assert.equal(action.kind, "decision");
    if (action.kind !== "decision") return;
    assert.equal(action.strategy, "ask");
    assert.equal(action.reopenedFrom, "pr_open");
    assert.equal(action.diffSummary.commits, 1);
    assert.deepEqual(action.diffSummary.commitMessages.map((entry) => entry.message), ["add two"]);
  });

  it("pr_open: a branch that was never pushed from here is unknown, which counts as new (against the base)", async () => {
    const f = await fixture("ask", "pr_open");
    const action = await f.plan();
    assert.equal(action.kind, "decision");
    if (action.kind !== "decision") return;
    assert.equal(action.reopenedFrom, "pr_open");
    assert.equal(action.diffSummary.commits, 1);
  });

  it("pr_open on another branch's PR: the branch is compared with the PR's head, which is what was pushed", async () => {
    // A follow-up session of an existing PR: agent_pr pushes the PR's head
    // branch, never the session's own, which has no tracking ref.
    const f = await fixture("ask", "pr_open");
    const head = `${f.branch}-pr-head`;
    git(github.repoDir, "branch", head, f.branch);
    git(github.repoDir, "push", "origin", `${head}:${head}`);
    (f.session as { worktreePrHeadBranch?: string }).worktreePrHeadBranch = head;
    assert.equal((await f.plan()).kind, "skip", "nothing the PR does not have: no prompt");

    commit(f.worktreePath, "follow-up.txt", "two\n", "add two");
    const action = await f.plan();
    assert.equal(action.kind, "decision");
    if (action.kind !== "decision") return;
    assert.equal(action.reopenedFrom, "pr_open");
    assert.equal(action.diffSummary.commits, 1);
    assert.deepEqual(action.diffSummary.commitMessages.map((entry) => entry.message), ["add two"]);
  });

  it("pr_open by strategy: delegate decides, auto-merge becomes the prompt, manual and off only note it, auto-pr is unchanged", async () => {
    const plan = async (strategy: string): Promise<PlannedWorktreeAction> => {
      const f = await fixture(strategy, "pr_open");
      git(github.repoDir, "push", "origin", `${f.branch}:${f.branch}`);
      commit(f.worktreePath, `more-${strategy}.txt`, "two\n", "add two");
      return await f.plan();
    };
    const delegate = await plan("delegate");
    assert.equal(delegate.kind === "decision" && delegate.strategy, "delegate");
    const autoMerge = await plan("auto-merge");
    assert.equal(autoMerge.kind === "decision" && autoMerge.strategy, "ask", "merging past an open PR is the user's call");
    const autoPr = await plan("auto-pr");
    assert.equal(autoPr.kind === "decision" && autoPr.strategy, "auto-pr");
    assert.equal(autoPr.kind === "decision" && autoPr.reopenedFrom, undefined);
    for (const strategy of ["manual", "off"]) {
      const quiet = await plan(strategy);
      assert.equal(quiet.kind, "skip");
      assert.match(quiet.kind === "skip" ? quiet.result.completionNote ?? "" : "", /^⚠️ 1 commit on `[^`]+` is not in the PR: https:\/\/github\.com\/acme\/widget\/pull\/7$/);
    }
  });

  it("merged: nothing new stays resolved; a commit after the merge is a decision again", async () => {
    const f = await fixture("ask", "merged");
    git(github.repoDir, "merge", "-q", "--no-ff", "-m", "merge planner branch", f.branch);
    try {
      assert.equal((await f.plan()).kind, "skip");

      // Commit times have one-second resolution: the new commit is clearly after the merge.
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      commit(f.worktreePath, "after-merge.txt", "more\n", "add after merge");
      const action = await f.plan();
      assert.equal(action.kind, "decision");
      if (action.kind !== "decision") return;
      assert.equal(action.reopenedFrom, "merged");
      assert.equal(action.diffSummary.commits, 1);

      // A PR merged on GitHub leaves the local base behind: a branch that is only
      // ahead of the local base, with nothing committed since, stays resolved.
      const remoteMerged = await fixture("ask", "merged");
      assert.equal((await remoteMerged.plan()).kind, "skip");
    } finally {
      git(github.repoDir, "reset", "-q", "--hard", "origin/main");
    }
  });

  it("a resolved session whose worktree is gone stays resolved", async () => {
    const f = await fixture("ask", "pr_open");
    (f.session as { worktreePath?: string }).worktreePath = join(f.worktreePath, "gone");
    assert.equal((await f.plan()).kind, "skip");
  });
});
