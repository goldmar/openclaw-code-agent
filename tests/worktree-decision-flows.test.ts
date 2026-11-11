import "./test-env";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPluginConfig } from "../src/config";
import { setGitHubCliAvailabilityForTests } from "../src/worktree-repo";
import { BACKEND_NAMES, waitUntil, type BackendName } from "./harness-backends";
import { reviewedTaskInput } from "./task-outcome-fixture";
import {
  buttonNamed,
  clickButton,
  startInteractionFixture,
  TEST_ROUTE,
  type InteractionFixture,
} from "./user-interaction-fixture";

let fixture: InteractionFixture | undefined;

// No `gh` on the test host: decision prompts offer Merge / Later / Discard.
before(() => setGitHubCliAvailabilityForTests(false));
after(() => setGitHubCliAvailabilityForTests(undefined));

afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  setPluginConfig({});
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "oca-worktree-flow-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "init");
  return repo;
}

/** Run a session in a worktree of `repo` that commits one file, then let it finish. */
async function finishSessionWithChange(
  name: BackendName,
  repo: string,
  strategy: "ask" | "delegate",
): Promise<InteractionFixture> {
  const created = await startInteractionFixture(name, {
    config: { workdir: repo, worktreeStrategy: strategy, multiTurn: false },
    beforeLaunch: async (sm) => { await sm.setRepoPolicy(repo, "never-pr"); },
  });
  fixture = created;
  const worktree = created.session.worktreePath;
  assert.ok(worktree && worktree !== repo, "the session runs in its own worktree");
  writeFileSync(join(worktree, "feature.txt"), "feature\n");
  git(worktree, "add", "feature.txt");
  git(worktree, "commit", "-m", "add feature");
  await created.backend.endTurn("Added feature.txt.");
  await waitUntil(() => created.session.status === "completed", "session completed");
  const report = await created.sm.reportTaskOutcome(created.session.id, reviewedTaskInput(created.session), { source: "orchestrator" });
  assert.doesNotMatch(report, /^Error:/);
  return created;
}

/** Record the merge / PR outcome lines the user would see (the fixture drops them). */
function captureOutcomeLines(f: InteractionFixture): string[] {
  const lines: string[] = [];
  (f.sm as unknown as { notifications: { notifyWorktreeOutcome: (session: unknown, line: string) => void } })
    .notifications.notifyWorktreeOutcome = (_session, line) => { lines.push(line); };
  return lines;
}

const userCheckmarks = (f: InteractionFixture): string[] => f.notifications
  .map((entry) => entry.request.userMessage ?? "")
  .filter((text) => text.startsWith("✅"));

async function decisionButtons(label: string) {
  const f = fixture!;
  await waitUntil(() => f.buttons(label).length > 0, `${label} buttons`);
  return f.buttons(label);
}

for (const name of BACKEND_NAMES) {
  describe(`${name}: worktree decisions`, () => {
    it("asks the user and merges from the Merge button; later clicks on the same prompt are stale", async () => {
      const repo = createRepo();
      const f = await finishSessionWithChange(name, repo, "ask");
      const outcomes = captureOutcomeLines(f);
      const buttons = await decisionButtons("worktree-merge-ask");
      assert.deepEqual(buttons.map((button) => button.label), ["Merge", "Later", "Discard"]);
      // Task success was verified before integration became a decision.
      assert.equal(userCheckmarks(f).length, 1);

      const later = await clickButton(buttonNamed(buttons, "Later"));
      assert.match(later.replies.join("\n"), /Reminder snoozed 24h/);
      assert.equal(userCheckmarks(f).length, 1, "Later keeps the verified task's decision pending");
      assert.equal(outcomes.length, 0);

      await clickButton(buttonNamed(buttons, "Merge"));
      await waitUntil(() => existsSync(join(repo, "feature.txt")), "branch merged into main");
      assert.equal(f.sm.getPersistedSession(f.session.id)?.worktreeLifecycle?.state, "merged");
      // Integration is a separate milestone and cannot manufacture completion.
      assert.equal(outcomes.length, 1);
      assert.match(outcomes[0], new RegExp(`^ℹ️ \\[${name}-flow\\] Merged: `));
      assert.equal(userCheckmarks(f).length, 1);

      for (const label of ["Merge", "Discard"]) {
        const stale = await clickButton(buttonNamed(buttons, label));
        assert.match(stale.replies.join("\n"), /already resolved \(merged\)/, `${label} after merge`);
      }
      assert.ok(existsSync(join(repo, "feature.txt")), "a stale Discard does not undo the merge");
      assert.equal(f.sm.getPersistedSession(f.session.id)?.worktreeLifecycle?.state, "merged", "the merge record is kept");
    });

    it("discards from the Discard button and refuses a later Merge", async () => {
      const repo = createRepo();
      const f = await finishSessionWithChange(name, repo, "ask");
      const buttons = await decisionButtons("worktree-merge-ask");
      const discard = await clickButton(buttonNamed(buttons, "Discard"));
      assert.deepEqual(discard.replies, []);
      assert.equal(f.sm.getPersistedSession(f.session.id)?.worktreeLifecycle?.state, "dismissed");
      // Discard changes integration disposition, not the prior task verification.
      assert.equal(userCheckmarks(f).length, 1);

      const stale = await clickButton(buttonNamed(buttons, "Merge"));
      assert.match(stale.replies.join("\n"), /already resolved \(discarded\)/);
      assert.equal(existsSync(join(repo, "feature.txt")), false, "nothing was merged");

      // A repeated discard (a second Discard button, or the tool) is answered
      // with the standard reply: no ``branch `unknown` `` notice, nothing changed.
      const discardedAt = f.sm.getPersistedSession(f.session.id)?.worktreeDismissedAt;
      for (let press = 0; press < 2; press += 1) {
        assert.equal(
          await f.sm.dismissWorktree(f.session.id),
          `⚠️ [${f.session.name}] This decision was already resolved (discarded). Nothing was changed.`,
        );
      }
      assert.ok(discardedAt, "the first discard was recorded");
      assert.equal(f.sm.getPersistedSession(f.session.id)?.worktreeDismissedAt, discardedAt, "nothing was changed");
      assert.equal(f.notifications.some((entry) => /branch `unknown`/.test(entry.request.userMessage ?? "")), false);
    });

    it("preserves unfinished dirty work without integration or discard decisions", async () => {
      const repo = createRepo();
      const created = await startInteractionFixture(name, {
        config: { workdir: repo, worktreeStrategy: "ask", multiTurn: false },
        beforeLaunch: async (sm) => { await sm.setRepoPolicy(repo, "never-pr"); },
      });
      fixture = created;
      const worktree = created.session.worktreePath!;
      writeFileSync(join(worktree, "draft.txt"), "uncommitted\n");
      await created.backend.endTurn("Wrote draft.txt; acceptance remains incomplete.");
      const notice = await created.waitForNotification("task-unverified");
      assert.match(notice.request.userMessage ?? "", /completion unverified/);
      assert.deepEqual(userCheckmarks(created), []);
      assert.deepEqual(created.buttons("worktree-dirty-uncommitted"), []);
      assert.deepEqual(created.buttons("worktree-merge-ask"), []);
      const report = reviewedTaskInput(created.session);
      report.task = "incomplete";
      report.remainingWork = ["Finish and verify the draft"];
      const result = await created.sm.reportTaskOutcome(created.session.id, report, { source: "orchestrator" });
      assert.doesNotMatch(result, /^Error:/);
      assert.equal(existsSync(join(worktree, "draft.txt")), true);
      assert.equal(created.backend.turns.length, 1, "reporting an unfinished task starts no new execution");
      assert.deepEqual(created.backend.steers, []);
      assert.deepEqual(userCheckmarks(created), []);
      assert.equal(created.notifications.some((entry) => entry.request.buttons?.flat().some((button) => /Merge|PR|Discard|Later/.test(button.label))), false);
    });

    it("runs only one of two decisions clicked at the same time", async () => {
      const repo = createRepo();
      const f = await finishSessionWithChange(name, repo, "ask");
      const buttons = await decisionButtons("worktree-merge-ask");
      const [merge, discard] = await Promise.all([
        clickButton(buttonNamed(buttons, "Merge")),
        clickButton(buttonNamed(buttons, "Discard")),
      ]);
      assert.match(discard.replies.join("\n"), /still being processed/);
      assert.doesNotMatch(merge.replies.join("\n"), /still being processed/);
      await waitUntil(() => existsSync(join(repo, "feature.txt")), "branch merged into main");
      assert.equal(f.sm.getPersistedSession(f.session.id)?.worktreeLifecycle?.state, "merged");

      const late = await clickButton(buttonNamed(buttons, "Discard"));
      assert.match(late.replies.join("\n"), /already resolved \(merged\)/);
    });

    it("delegates the decision to the orchestrator, which can hand it to the user with buttons", async () => {
      const repo = createRepo();
      const f = await finishSessionWithChange(name, repo, "delegate");
      const wake = await f.waitForNotification("worktree-delegate");
      assert.match(wake.request.wakeMessage ?? wake.request.wakeMessageOnNotifySuccess ?? "", /You decide what happens to the branch \(worktree: delegate\)/);
      assert.equal(f.buttons("worktree-delegate").length, 0, "the user gets no buttons until the orchestrator asks");
      // The user gets the generic completion line; only the delegate notice wakes the orchestrator.
      const completed = await f.waitForNotification("completed");
      assert.match(completed.request.userMessage ?? "", new RegExp(`^✅ \\[${name}-flow\\] Completed`));
      assert.equal(completed.request.wakeMessage ?? completed.request.wakeMessageOnNotifySuccess ?? completed.request.wakeMessageOnNotifyFailed, undefined);
      assert.equal(f.notifications.filter((entry) => entry.request.label === "worktree-delegate").length, 1);
      const outcomes = captureOutcomeLines(f);

      const before = f.notifications.length;
      const handedOver = await f.sm.requestWorktreeDecisionFromUser(f.session.id, "Adds feature.txt; low risk.");
      assert.doesNotMatch(handedOver, /^Error/, handedOver);
      await waitUntil(() => f.notifications.slice(before).some((entry) => (entry.request.buttons?.length ?? 0) > 0), "user decision buttons");
      const buttons = f.notifications.slice(before).find((entry) => (entry.request.buttons?.length ?? 0) > 0)!.request.buttons!.flat();
      await clickButton(buttonNamed(buttons, "Merge"));
      await waitUntil(() => existsSync(join(repo, "feature.txt")), "branch merged into main");
      await waitUntil(() => outcomes.length > 0, "the merge outcome line");
      assert.match(outcomes[0], new RegExp(`^ℹ️ \\[${name}-flow\\] Merged: `));
      assert.equal(userCheckmarks(f).length, 1, "exactly one ✅ for the delegate session");
    });

    it("asks for a repo policy before launch and continues the launch from the Manual button", async () => {
      const repo = createRepo();
      const f = await startInteractionFixture(name);
      fixture = f;
      const turnsBefore = f.backend.turns.length;
      const prompt = await f.sm.requestRepoPolicyForLaunch({
        route: { ...TEST_ROUTE },
        prompt: "Make one small change",
        workdir: repo,
        harness: name,
        worktreeStrategy: "ask",
      });
      assert.match(prompt, /Repo policy choice prompt sent/);
      const buttons = await decisionButtons("repo-policy-choice");
      assert.deepEqual(buttons.map((button) => button.label), ["No PR", "Manual"]);

      const click = await clickButton(buttonNamed(buttons, "Manual"));
      assert.match(click.replies.join("\n"), /Repo policy saved/);
      assert.equal((await f.sm.resolveRepoPolicy(repo)).policy, "manual");
      await waitUntil(() => f.backend.turns.length > turnsBefore, "the stored launch starts on the backend");
      assert.equal(f.backend.turns.at(-1)?.text.includes("Make one small change"), true);

      const stale = await clickButton(buttonNamed(buttons, "No PR"));
      assert.match(stale.replies.join("\n"), /expired or was already used/);
      assert.equal((await f.sm.resolveRepoPolicy(repo)).policy, "manual", "the stale click changes nothing");
    });
  });
}
