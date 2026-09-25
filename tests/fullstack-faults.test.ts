import "./test-env";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeLlmTimeoutsMs } from "../src/runtime-llm";
import { sessionStoreStorageInternals } from "../src/session-store-storage";
import { setGitHubCliAvailabilityForTests } from "../src/worktree-repo";
import type { LlmCompleteParams } from "./fake-host";
import { BACKEND_NAMES, waitUntil, type OpenCodeBackend } from "./harness-backends";
import { sessionsIndexPath, startFullStack, type FullStack, type SentButton } from "./fullstack-fixture";

/**
 * Fault injection through the real plugin entry: a Gateway restart after any
 * save, saves that throw, a failing or hung host model, backends that die in
 * the middle of a turn, and a Gateway stop while a button action runs.
 */

let stack: FullStack | undefined;
const originalSaveJsonFile = sessionStoreStorageInternals.saveJsonFile;

before(() => setGitHubCliAvailabilityForTests(false));
after(() => setGitHubCliAvailabilityForTests(undefined));

afterEach(async () => {
  sessionStoreStorageInternals.saveJsonFile = originalSaveJsonFile;
  await stack?.dispose();
  stack = undefined;
});

const COLOR = { id: "color", question: "Which color?", options: ["Red", "Green", "Blue"] };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "oca-fullstack-faults-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "init");
  return repo;
}

function buttonIn(message: { buttons: SentButton[] }, label: string): SentButton {
  const button = message.buttons.find((candidate) => candidate.label === label);
  assert.ok(button, `a "${label}" button among ${message.buttons.map((candidate) => candidate.label).join(", ")}`);
  return button;
}

type IndexToken = { id: string; sessionId: string; kind: string; consumedAt?: number; expiresAt?: number; planDecisionVersion?: number };
type IndexRow = {
  sessionId: string;
  status?: string;
  pendingPlanApproval?: boolean;
  actionablePlanDecisionVersion?: number;
  pendingWorktreeDecisionSince?: string;
  worktreeLifecycle?: { state?: string };
};
type IndexFile = { sessions: IndexRow[]; actionTokens: IndexToken[] };

const WORKTREE_DECISION_KINDS = new Set(["worktree-merge", "worktree-decide-later", "worktree-dismiss", "worktree-create-pr", "worktree-update-pr"]);
const RESOLVED_LIFECYCLE = new Set(["merged", "released", "dismissed", "no_change"]);
/** Replies of a click that acted. A consumed button must never produce one. */
const ACTED = /Pending input request submitted|Snoozed 24h|✅ Discarded|Repo policy saved|^▶️/m;

describe("restart from every saved store snapshot", () => {
  it("keeps pending prompts, never re-runs a used button, and leaves no orphan worktree state", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const snapshots: string[] = [];
    sessionStoreStorageInternals.saveJsonFile = (path, payload) => {
      originalSaveJsonFile(path, payload);
      if (path === sessionsIndexPath()) snapshots.push(JSON.stringify(payload));
    };

    // One session through all three flows: a question, a plan approval, and a worktree decision.
    const repo = createRepo();
    await s.sm.setRepoPolicy(repo, "never-pr");
    const session = await s.launch({ workdir: repo, worktreeStrategy: "ask", permissionMode: "plan", planApproval: "ask" });
    const answered = s.backend.ask([COLOR]);
    await s.click(await s.waitForButton("Green"));
    await answered;
    s.backend.proposePlan("1. Add feature.txt");
    await waitUntil(() => session.pendingPlanApproval === true, "pending plan");
    const turnsBeforeApproval = s.backend.turns.length;
    await s.click(await s.waitForButton("Approve"));
    await waitUntil(() => s.backend.turns.length > turnsBeforeApproval, "implementation turn");
    const worktree = session.worktreePath!;
    writeFileSync(join(worktree, "feature.txt"), "feature\n");
    git(worktree, "add", "feature.txt");
    git(worktree, "commit", "-m", "add feature");
    await s.backend.endTurn("Added feature.txt.");
    await s.click(await s.waitForButton("Merge"));
    await waitUntil(() => s.sm.getPersistedSession(session.id)?.worktreeLifecycle?.state === "merged", "merge recorded", 10_000);
    await s.sm.whenStorePersisted();
    sessionStoreStorageInternals.saveJsonFile = originalSaveJsonFile;
    assert.ok(snapshots.length >= 10, `expected a save per step, got ${snapshots.length}`);

    const mainHead = git(repo, "rev-parse", "main");
    const clicked = new Set<string>();
    for (const [index, snapshot] of snapshots.entries()) {
      const label = `snapshot ${index + 1}/${snapshots.length}`;
      const saved = JSON.parse(snapshot) as IndexFile;
      await s.restartFromIndex(snapshot);
      const turnsBefore = s.backend.turns.length;

      for (const row of saved.sessions) {
        const loaded = s.sm.getPersistedSession(row.sessionId);
        assert.ok(loaded, `${label}: session ${row.sessionId} survives the restart`);
        // A plan waiting for approval stays pending, and so does its version.
        if (row.pendingPlanApproval) {
          assert.equal(loaded.pendingPlanApproval, true, `${label}: pending plan kept`);
          assert.equal(loaded.actionablePlanDecisionVersion, row.actionablePlanDecisionVersion, `${label}: plan version kept`);
        }
        // An open worktree decision stays open and still has a live button to decide it.
        const lifecycle = row.worktreeLifecycle?.state;
        if (row.pendingWorktreeDecisionSince && !RESOLVED_LIFECYCLE.has(lifecycle ?? "")) {
          assert.ok(loaded.pendingWorktreeDecisionSince, `${label}: pending worktree decision kept`);
          const live = saved.actionTokens.filter((token) => token.sessionId === row.sessionId
            && WORKTREE_DECISION_KINDS.has(token.kind) && token.consumedAt == null);
          if (live.length > 0) {
            assert.ok(live.some((token) => s.sm.getActionToken(token.id)), `${label}: a live worktree button survives`);
          }
        }
        // No orphan worktree state: a resolved decision keeps no pending marker.
        if (RESOLVED_LIFECYCLE.has(lifecycle ?? "")) {
          assert.equal(loaded.pendingWorktreeDecisionSince, undefined, `${label}: resolved decision has no pending marker`);
        }
      }

      // Every unused button of a stopped session is still usable after the restart.
      for (const token of saved.actionTokens) {
        if (token.consumedAt != null || (token.expiresAt != null && token.expiresAt <= Date.now())) continue;
        if (token.kind === "question-answer") continue; // bound to the backend request the restart ended
        assert.ok(s.sm.getActionToken(token.id), `${label}: live ${token.kind} button survives the restart`);
      }

      // A button already used before the restart never acts again. Each one is
      // clicked in the first snapshot that records its use (the restart right
      // after the click), where a lost consumption would show.
      for (const token of saved.actionTokens.filter((candidate) => candidate.consumedAt != null && !clicked.has(candidate.id))) {
        clicked.add(token.id);
        const click = await s.click(token.id);
        assert.doesNotMatch(click.replies.join("\n"), ACTED, `${label}: used ${token.kind} button acted again`);
      }
      assert.equal(git(repo, "rev-parse", "main"), mainHead, `${label}: no second merge`);
      assert.equal(s.backend.turns.length, turnsBefore, `${label}: no backend turn from a used button`);
    }

    // After the last snapshot, only the merged session's record remains and no worktree is left behind.
    const worktrees = git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "));
    assert.equal(worktrees.length, 1, `only the main checkout remains: ${worktrees.join(", ")}`);
  });
});

describe("saves that fail", () => {
  it("acts exactly once when the save after a click throws, once the retried save lands", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const session = await s.launch();
    assert.ok(s.sm.kill(session.id, "idle-timeout"));
    const suspended = await s.waitForMessage(/Suspended after idle timeout/);
    await s.sm.whenStorePersisted();
    let failures = 1;
    sessionStoreStorageInternals.saveJsonFile = (path, payload) => {
      if (failures > 0 && path === sessionsIndexPath()) {
        failures -= 1;
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      originalSaveJsonFile(path, payload);
    };
    const view = buttonIn(suspended, "View output");
    const click = await s.click(view);
    assert.equal(failures, 0, "the save after the click failed once");
    assert.equal(click.replies.length, 1);
    assert.doesNotMatch(click.replies[0]!, /stale/);
    const disk = JSON.parse(readFileSync(sessionsIndexPath(), "utf-8")) as IndexFile;
    assert.equal(typeof disk.actionTokens.find((token) => token.id === view.payload)?.consumedAt, "number", "the retried save persisted the consumption");
    const again = await s.click(view);
    assert.match(again.replies.join("\n"), /stale or has already been used/);
  });

  it("keeps changes in memory while every save fails and writes them when the Gateway stops", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const session = await s.launch();
    await s.sm.whenStorePersisted();
    let failing = true;
    sessionStoreStorageInternals.saveJsonFile = (path, payload) => {
      if (failing && path === sessionsIndexPath()) throw new Error("EIO: i/o error");
      originalSaveJsonFile(path, payload);
    };
    assert.ok(s.sm.kill(session.id, "user"));
    await waitUntil(() => s.sm.getPersistedSession(session.id)?.status === "killed", "kill recorded in memory");
    const onDisk = (): IndexFile => JSON.parse(readFileSync(sessionsIndexPath(), "utf-8")) as IndexFile;
    assert.notEqual(onDisk().sessions.find((row) => row.sessionId === session.id)?.status, "killed", "not on disk yet");
    failing = false;
    await s.host.stopServices();
    assert.equal(onDisk().sessions.find((row) => row.sessionId === session.id)?.status, "killed", "flushed at shutdown");
  });
});

describe("host model faults", () => {
  async function finishWorktreeSession(s: FullStack): Promise<string> {
    const repo = createRepo();
    await s.sm.setRepoPolicy(repo, "never-pr");
    const session = await s.launch({ workdir: repo, worktreeStrategy: "ask" });
    writeFileSync(join(session.worktreePath!, "feature.txt"), "feature\n");
    git(session.worktreePath!, "add", "feature.txt");
    git(session.worktreePath!, "commit", "-m", "add feature");
    await s.backend.endTurn("Added feature.txt with the new flag.");
    return repo;
  }

  it("does not hold the worktree decision back when runtime.llm never answers", async () => {
    const s = stack = await startFullStack({
      backend: "codex",
      llmReplies: [(params: LlmCompleteParams) => new Promise<string>((_, reject) => {
        params.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })],
    });
    runtimeLlmTimeoutsMs.worktreeDecisionSummary = 100;
    await finishWorktreeSession(s);
    const merge = await s.waitForButton("Merge");
    assert.ok(merge);
    const call = s.host.llmCalls.find((candidate) => candidate.purpose === "openclaw-code-agent.worktree-decision-summary");
    assert.ok(call, "the summary was requested");
    assert.equal(call.signal?.aborted, true, "the hung completion was aborted");
  });
});

describe("backend dies in the middle of a turn", () => {
  for (const name of BACKEND_NAMES) {
    it(`${name}: fails the session and tells the user, with its output still available`, async () => {
      const s = stack = await startFullStack({ backend: name });
      const session = await s.launch();
      await s.backend.crashMidTurn();
      await waitUntil(() => session.status === "failed", `${name} session failed`);
      const failed = await s.waitForMessage(/Failed|failed|exited/);
      assert.equal(failed.to, s.surface.to);
      const view = failed.buttons.find((button) => button.label === "View output");
      if (view) {
        const click = await s.click(view);
        assert.equal(click.replies.length, 1);
      }
    });
  }

  it("opencode: finishes the turn after the event stream drops while the turn ends", async () => {
    const s = stack = await startFullStack({ backend: "opencode" });
    const session = await s.launch();
    const backend = s.backend as OpenCodeBackend;
    backend.dropEventStreams();
    // The turn ends while no stream is connected: its events are lost.
    await backend.endTurn("Finished while disconnected.");
    await waitUntil(() => session.status === "completed", "turn reconciled after the stream reconnected");
  });
});

describe("Gateway stop during a button action", () => {
  it("finishes or cleanly abandons a Merge that is running when the Gateway stops", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const repo = createRepo();
    await s.sm.setRepoPolicy(repo, "never-pr");
    const session = await s.launch({ workdir: repo, worktreeStrategy: "ask" });
    writeFileSync(join(session.worktreePath!, "feature.txt"), "feature\n");
    git(session.worktreePath!, "add", "feature.txt");
    git(session.worktreePath!, "commit", "-m", "add feature");
    await s.backend.endTurn("Added feature.txt.");
    const merge = await s.waitForButton("Merge");
    await s.sm.whenStorePersisted();
    const [click] = await Promise.all([s.click(merge), s.host.stopServices()]);
    await s.restartGateway();
    const record = s.sm.getPersistedSession(session.id);
    const merged = existsSync(join(repo, "feature.txt"));
    assert.equal(record?.worktreeLifecycle?.state === "merged", merged, "the record matches the repository");
    if (!merged) {
      // Not merged: the decision stays open and can still be made.
      assert.ok(record?.pendingWorktreeDecisionSince, `still pending (click said: ${click.replies.join(" | ")})`);
    }
    const again = await s.click(merge);
    assert.doesNotMatch(again.replies.join("\n"), /Merged/);
  });
});
