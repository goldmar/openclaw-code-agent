import "./test-env";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setGitHubCliAvailabilityForTests } from "../src/worktree-repo";
import type { Session } from "../src/session";
import { waitUntil } from "./harness-backends";
import { DISCORD_THREAD, sessionsIndexPath, startFullStack, TELEGRAM_TOPIC, type FullStack, type SentButton } from "./fullstack-fixture";

/**
 * End-to-end paths that had no coverage: failed worktree actions, the
 * auto-merge conflict resolver, the snooze and reminder cycle, the resume /
 * restart / view-output buttons, and the goal loop. All run through the real
 * plugin entry on the fake host, with the Codex fake backend.
 */

let stack: FullStack | undefined;

before(() => setGitHubCliAvailabilityForTests(false));
after(() => setGitHubCliAvailabilityForTests(undefined));

afterEach(async () => {
  await stack?.dispose();
  stack = undefined;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "oca-fullstack-gaps-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "init");
  return repo;
}

function commit(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content);
  git(dir, "add", file);
  git(dir, "commit", "-m", message);
}

/**
 * A worktree session whose branch edits README.md while main gets a
 * conflicting README.md commit, so merging the branch hits a rebase conflict.
 */
async function finishConflictingSession(
  s: FullStack,
  strategy: "ask" | "auto-merge",
): Promise<{ repo: string; session: Session }> {
  const repo = createRepo();
  await s.sm.setRepoPolicy(repo, "never-pr");
  const session = await s.launch({ workdir: repo, worktreeStrategy: strategy });
  const worktree = session.worktreePath!;
  assert.ok(worktree && worktree !== repo, "the session runs in its own worktree");
  commit(worktree, "README.md", "hello from the branch\n", "branch edit");
  commit(worktree, "feature.txt", "feature\n", "add feature");
  commit(repo, "README.md", "hello from main\n", "main edit");
  await s.backend.endTurn("Edited README.md and added feature.txt.");
  return { repo, session };
}

function buttonIn(message: { buttons: SentButton[] }, label: string): SentButton {
  const button = message.buttons.find((candidate) => candidate.label === label);
  assert.ok(button, `a "${label}" button among ${message.buttons.map((candidate) => candidate.label).join(", ")}`);
  return button;
}

describe("failed worktree actions", () => {
  for (const surface of [TELEGRAM_TOPIC, DISCORD_THREAD]) {
    it(`re-offers fresh controls after a failed Merge on ${surface.channel}, and the retry merges`, async () => {
      const s = stack = await startFullStack({ backend: "codex", surface });
      const { repo, session } = await finishConflictingSession(s, "ask");
      const merge = await s.waitForButton("Merge");
      const prompt = s.messages().find((message) => message.buttons.some((button) => button.payload === merge.payload))!;

      const failed = await s.click(merge);
      assert.match(failed.replies.join("\n"), /Rebase conflicts/);
      assert.ok(failed.cleared > 0, "the spent controls are cleared");
      const retry = await s.waitForMessage(/still open/, prompt.index + 1);
      assert.equal(retry.to, surface.to);
      assert.equal(String(retry.threadId), String(surface.threadId));
      assert.deepEqual(retry.buttons.map((button) => button.label), ["Merge", "Later", "Discard"]);
      assert.notEqual(buttonIn(retry, "Merge").payload, merge.payload, "a fresh token");

      // The spent prompt's siblings were replaced too: only the new controls act.
      const oldLater = await s.click(buttonIn(prompt, "Later"));
      assert.match(oldLater.replies.join("\n"), /stale or has already been used/);
      assert.equal(s.sm.getPersistedSession(session.id)?.worktreeDecisionSnoozedUntil, undefined);

      // The user resolves the conflict (here: drops the conflicting main commit) and retries.
      git(repo, "reset", "--hard", "HEAD~1");
      const retried = await s.click(buttonIn(retry, "Merge"));
      assert.doesNotMatch(retried.replies.join("\n"), /stale/);
      await waitUntil(() => s.sm.getPersistedSession(session.id)?.worktreeLifecycle?.state === "merged", "merge recorded", 10_000);
      assert.ok(existsSync(join(repo, "feature.txt")), "branch merged into main");
      // A settled decision is never re-offered.
      assert.equal(await s.sm.reofferWorktreeDecision(session.id), false);
    });
  }
});

describe("auto-merge conflicts", () => {
  it("starts a conflict resolver session on a real rebase conflict and merges once it finishes", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const turnsBefore = s.backend.turns.length;
    const { repo, session } = await finishConflictingSession(s, "auto-merge");
    await s.waitForMessage(/Auto-merge hit a rebase conflict\. Started resolver session/);
    await waitUntil(() => s.backend.turns.length > turnsBefore + 1, "the resolver's first turn");
    const resolver = s.sm.list("all").find((candidate) => candidate.autoMergeParentSessionId === session.id);
    assert.ok(resolver, "a resolver session linked to the parent");
    assert.equal(resolver.workdir, session.worktreePath, "the resolver works in the conflicting worktree");
    assert.match(s.backend.turns.at(-1)?.text ?? "", /conflict/i);

    // The resolver settles the conflict, then finishes its turn.
    git(repo, "reset", "--hard", "HEAD~1");
    await s.backend.endTurn("Resolved the conflict.");
    await waitUntil(() => resolver.status === "completed", "resolver completed");
    await waitUntil(
      () => s.sm.getPersistedSession(session.id)?.worktreeLifecycle?.state === "merged",
      "parent branch merged after the resolver finished",
      10_000,
    );
    assert.ok(existsSync(join(repo, "feature.txt")));
    await s.waitForMessage(/Merged: agent\/codex-fullstack → main/);
  });

  it("only logs when a resolver finishes after its parent session is gone", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const workdir = mkdtempSync(join(tmpdir(), "oca-orphan-resolver-"));
    const sendsBefore = s.host.durableSends.length;
    const turnsBefore = s.backend.turns.length;
    const resolver = await s.sm.launchSession({
      prompt: "Resolve the conflict",
      workdir,
      name: "orphan-resolver",
      harness: "codex",
      permissionMode: "bypassPermissions",
      multiTurn: true,
      worktreeStrategy: "off",
      autoMergeParentSessionId: "no-such-parent",
      route: { provider: "telegram", accountId: "bot", target: TELEGRAM_TOPIC.to, threadId: "42", sessionKey: TELEGRAM_TOPIC.sessionKey },
    }, { notifyLaunch: false });
    await s.backend.waitForTurns(turnsBefore + 1);
    await waitUntil(() => resolver.status === "running", "resolver running");
    await s.backend.endTurn("Done.");
    await waitUntil(() => resolver.status === "completed", "resolver completed");
    await waitUntil(() => s.host.logs.some((entry) => /original session no-such-parent could not be found/.test(entry.message)), "orphan warning");
    assert.equal(s.sm.getPersistedSession(resolver.id)?.status, "completed");
    assert.equal(s.host.durableSends.length, sendsBefore, "nothing is sent for an orphaned resolver");
  });
});

describe("snooze and reminders", () => {
  it("snoozes the decision for 24h from Later and reminds with fresh buttons once the snooze ends", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const repo = createRepo();
    await s.sm.setRepoPolicy(repo, "never-pr");
    const session = await s.launch({ workdir: repo, worktreeStrategy: "ask" });
    commit(session.worktreePath!, "feature.txt", "feature\n", "add feature");
    await s.backend.endTurn("Added feature.txt.");
    const later = await s.waitForButton("Later");
    const click = await s.click(later);
    assert.match(click.replies.join("\n"), /Snoozed 24h/);
    const snoozedUntil = Date.parse(s.sm.getPersistedSession(session.id)?.worktreeDecisionSnoozedUntil ?? "");
    assert.ok(Math.abs(snoozedUntil - (Date.now() + 24 * 60 * 60 * 1000)) < 60_000, "snoozed for 24h");

    // The agent-facing snooze also tells the user.
    const sendsBeforeSnooze = s.host.durableSends.length;
    assert.match(s.sm.snoozeWorktreeDecision(session.id), /Reminder snoozed 24h/);
    await s.waitForMessage(/Reminder snoozed 24h/, sendsBeforeSnooze);

    // A day later: the snooze has ended and the reminder is due.
    const hour = 60 * 60 * 1000;
    const sendsBefore = s.host.durableSends.length;
    s.sm.updatePersistedSession(session.id, {
      pendingWorktreeDecisionSince: new Date(Date.now() - 26 * hour).toISOString(),
      lastWorktreeReminderAt: new Date(Date.now() - 25 * hour).toISOString(),
      worktreeDecisionSnoozedUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    const reminder = await s.waitForMessage(/Reminder: branch .* is still waiting for a merge decision/, sendsBefore);
    await s.click(buttonIn(reminder, "Merge"));
    await waitUntil(() => existsSync(join(repo, "feature.txt")), "merged from the reminder");
  });
});

describe("session buttons", () => {
  it("resumes a suspended session from Resume and shows its output from View output", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const session = await s.launch();
    const turnsBefore = s.backend.turns.length;
    assert.ok(s.sm.kill(session.id, "idle-timeout"));
    const suspended = await s.waitForMessage(/Suspended after idle timeout/);
    assert.deepEqual(suspended.buttons.map((button) => button.label), ["Resume", "View output"]);

    const output = await s.click(buttonIn(suspended, "View output"));
    assert.match(output.replies.join("\n"), /codex-fullstack|Working|output/i);

    const resume = await s.click(buttonIn(suspended, "Resume"));
    assert.match(resume.replies.join("\n"), /^▶️/);
    await waitUntil(() => s.backend.turns.length > turnsBefore, "resumed turn");
    assert.match(s.backend.turns.at(-1)?.text ?? "", /Continue where you left off/);
    const again = await s.click(buttonIn(suspended, "Resume"));
    assert.match(again.replies.join("\n"), /stale or has already been used/);
  });

  it("resumes from a Restart button a 4.x store left behind", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const session = await s.launch();
    assert.ok(s.sm.kill(session.id, "idle-timeout"));
    await s.waitForMessage(/Suspended after idle timeout/);
    await s.sm.whenStorePersisted();
    await s.host.stopServices();
    const index = JSON.parse(readFileSync(sessionsIndexPath(), "utf-8")) as { actionTokens: unknown[] };
    index.actionTokens.push({
      id: "legacy-restart-token",
      sessionId: session.id,
      kind: "session-restart",
      label: "Restart",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    writeFileSync(sessionsIndexPath(), JSON.stringify(index));
    await s.host.startServices({});
    const turnsBefore = s.backend.turns.length;
    const restart = await s.click("legacy-restart-token");
    assert.match(restart.replies.join("\n"), /^▶️/);
    await waitUntil(() => s.backend.turns.length > turnsBefore, "restarted turn");
  });

  it("answers a button whose action this build does not know with a clear reply", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const session = await s.launch();
    assert.ok(s.sm.kill(session.id, "idle-timeout"));
    const suspended = await s.waitForMessage(/Suspended after idle timeout/);
    const button = buttonIn(suspended, "View output");
    // A token minted by a newer build, whose action kind this build lacks.
    const token = s.sm.getActionToken(button.payload) as { kind: string } | undefined;
    assert.ok(token);
    token.kind = "future-action";
    const click = await s.click(button);
    assert.deepEqual(click.replies, ["⚠️ Unknown callback action."]);
  });

  it("keeps plugin-update buttons across a Gateway restart", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const dismiss = s.sm.makePluginActionButton("plugin-update", "plugin-update-dismiss", "Dismiss", {
      pluginUpdateVersion: "9.9.9",
      route: { provider: "telegram", target: TELEGRAM_TOPIC.to, threadId: "42" },
    });
    await s.sm.whenStorePersisted();
    await s.restartGateway();
    const click = await s.click(dismiss.callbackData);
    assert.doesNotMatch(click.replies.join("\n"), /stale/);
    assert.match(click.replies.join("\n"), /Dismissed/);
  });
});

describe("goal loop", () => {
  function goalWorkdir(): string {
    return mkdtempSync(join(tmpdir(), "oca-goal-loop-"));
  }

  async function launchGoal(s: FullStack, workdir: string, extra: Record<string, unknown> = {}) {
    const turnsBefore = s.backend.turns.length;
    const text = await s.runTool("agent_goal_launch", {
      goal: "Create done.txt",
      verifier_commands: ["test -f done.txt"],
      workdir,
      name: "goal-loop",
      harness: "codex",
      max_iterations: 3,
      ...extra,
    });
    assert.doesNotMatch(text, /^Error/, text);
    await s.backend.waitForTurns(turnsBefore + 1);
    await waitUntil(() => s.gc.listTasks().length === 1, "goal task stored");
    return s.gc.listTasks()[0]!;
  }

  it("runs the verifier, resumes with a repair prompt, and succeeds once the verifier passes", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const workdir = goalWorkdir();
    const task = await launchGoal(s, workdir);
    const turnsBefore = s.backend.turns.length;
    await s.backend.endTurn("Tried something.");
    await waitUntil(() => s.backend.turns.length > turnsBefore, "repair turn");
    assert.match(s.backend.turns.at(-1)?.text ?? "", /The external verifier did not pass/);
    assert.equal(s.gc.getTask(task.id)?.iteration, 1);
    await s.waitForMessage(/Repair iteration started after verifier failure/);

    writeFileSync(join(workdir, "done.txt"), "done\n");
    await s.backend.endTurn("Created done.txt.");
    await waitUntil(() => s.gc.getTask(task.id)?.status === "succeeded", "goal succeeded");
    await s.waitForMessage(/Goal task succeeded/);
  });

  it("resumes the goal after an idle timeout", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const task = await launchGoal(s, goalWorkdir());
    const first = s.gc.getTask(task.id)!.sessionId!;
    const turnsBefore = s.backend.turns.length;
    assert.ok(s.sm.kill(first, "idle-timeout"));
    await waitUntil(() => s.backend.turns.length > turnsBefore, "resumed goal turn");
    await waitUntil(() => s.gc.getTask(task.id)?.sessionId !== first, "goal follows the resumed session");
    assert.equal(s.gc.getTask(task.id)?.status, "running");
    await s.waitForMessage(/Goal task resumed after idle timeout/);
  });

  it("fails the goal when the session waits for a user answer it cannot give itself", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const task = await launchGoal(s, goalWorkdir());
    void s.backend.ask([{ id: "db", question: "Which database do you prefer?", options: ["Postgres", "MySQL"] }]);
    await waitUntil(() => s.gc.getTask(task.id)?.status === "failed", "goal failed");
    assert.match(s.gc.getTask(task.id)?.failureReason ?? "", /waiting for user input and cannot continue autonomously/);
    await s.waitForMessage(/Goal task failed/);
  });
});
