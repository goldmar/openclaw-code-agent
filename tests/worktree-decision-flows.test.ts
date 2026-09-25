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
  return created;
}

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
      const buttons = await decisionButtons("worktree-merge-ask");
      assert.deepEqual(buttons.map((button) => button.label), ["Merge", "Later", "Discard"]);

      const later = await clickButton(buttonNamed(buttons, "Later"));
      assert.match(later.replies.join("\n"), /Snoozed 24h/);

      await clickButton(buttonNamed(buttons, "Merge"));
      await waitUntil(() => existsSync(join(repo, "feature.txt")), "branch merged into main");
      assert.equal(f.sm.getPersistedSession(f.session.id)?.worktreeLifecycle?.state, "merged");

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
      assert.deepEqual(discard.replies, ["✅ Discarded"]);
      assert.equal(f.sm.getPersistedSession(f.session.id)?.worktreeLifecycle?.state, "dismissed");

      const stale = await clickButton(buttonNamed(buttons, "Merge"));
      assert.match(stale.replies.join("\n"), /already resolved \(discarded\)/);
      assert.equal(existsSync(join(repo, "feature.txt")), false, "nothing was merged");
    });

    it("delegates the decision to the orchestrator, which can hand it to the user with buttons", async () => {
      const repo = createRepo();
      const f = await finishSessionWithChange(name, repo, "delegate");
      const wake = await f.waitForNotification("worktree-delegate");
      assert.match(wake.request.wakeMessage ?? wake.request.wakeMessageOnNotifySuccess ?? "", /\[DELEGATED WORKTREE DECISION\]/);
      assert.equal(f.buttons("worktree-delegate").length, 0, "the user gets no buttons until the orchestrator asks");

      const before = f.notifications.length;
      const handedOver = await f.sm.requestWorktreeDecisionFromUser(f.session.id, "Adds feature.txt; low risk.");
      assert.doesNotMatch(handedOver, /^Error/, handedOver);
      await waitUntil(() => f.notifications.slice(before).some((entry) => (entry.request.buttons?.length ?? 0) > 0), "user decision buttons");
      const buttons = f.notifications.slice(before).find((entry) => (entry.request.buttons?.length ?? 0) > 0)!.request.buttons!.flat();
      await clickButton(buttonNamed(buttons, "Merge"));
      await waitUntil(() => existsSync(join(repo, "feature.txt")), "branch merged into main");
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
      assert.match(stale.replies.join("\n"), /stale or has already been used/);
      assert.equal((await f.sm.resolveRepoPolicy(repo)).policy, "manual", "the stale click changes nothing");
    });
  });
}
