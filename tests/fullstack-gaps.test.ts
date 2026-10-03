import "./test-env";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setGitHubCliAvailabilityForTests } from "../src/worktree-repo";
import type { Session } from "../src/session";
import { wakeDeliveryExecutorInternals } from "../src/wake-delivery-executor";
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
      // One message: the failure and the still-open decision with fresh buttons.
      assert.deepEqual(failed.replies, []);
      assert.ok(failed.cleared > 0, "the spent controls are cleared");
      const retry = await s.waitForMessage(/still open/, prompt.index + 1);
      assert.match(retry.text, /^❌ \[[\w-]+\] Merge failed: rebase of `[^`]+` onto `[^`]+` hit conflicts; resolve them manually in `[^`]+`\. The decision for `[^`]+` is still open\.( \|[^\n]*)?$/);
      assert.equal(retry.to, surface.to);
      assert.equal(String(retry.threadId), String(surface.threadId));
      assert.deepEqual(retry.buttons.map((button) => button.label), ["Merge", "Later", "Discard"]);
      assert.notEqual(buttonIn(retry, "Merge").payload, merge.payload, "a fresh token");

      // The spent prompt's siblings were replaced too: only the new controls act.
      const oldLater = await s.click(buttonIn(prompt, "Later"));
      assert.match(oldLater.replies.join("\n"), /expired or was already used/);
      assert.equal(s.sm.getPersistedSession(session.id)?.worktreeDecisionSnoozedUntil, undefined);

      // The user resolves the conflict (here: drops the conflicting main commit) and retries.
      git(repo, "reset", "--hard", "HEAD~1");
      const retried = await s.click(buttonIn(retry, "Merge"));
      assert.doesNotMatch(retried.replies.join("\n"), /stale/);
      await waitUntil(() => s.sm.getPersistedSession(session.id)?.worktreeLifecycle?.state === "merged", "merge recorded", 10_000);
      assert.ok(existsSync(join(repo, "feature.txt")), "branch merged into main");
      // A settled decision is never re-offered.
      assert.equal(await s.sm.reofferWorktreeDecision(session.id, "Merge failed: test."), false);
    });
  }
});

describe("failed worktree actions when the retry prompt cannot be delivered", () => {
  it("keeps the original sibling buttons usable", async () => {
    const s = stack = await startFullStack({
      backend: "codex",
      // The host refuses the replacement prompt only.
      sendResult: (params) => (params.payloads.some((payload) => /still open/.test(payload.text ?? ""))
        ? { status: "failed", error: new Error("fake telegram: chat not found"), stage: "platform_send" } as never
        : { status: "sent", results: params.payloads.map((_, index) => ({ channel: params.channel, messageId: `m-${index}` })) } as never),
    });
    const { session } = await finishConflictingSession(s, "ask");
    const merge = await s.waitForButton("Merge");
    const prompt = s.messages().find((message) => message.buttons.some((button) => button.payload === merge.payload))!;
    const failed = await s.click(merge);
    assert.match(failed.replies.join("\n"), /^❌ \[[\w-]+\] Merge failed: rebase of `[^`]+` onto `[^`]+` hit conflicts; resolve them manually in `[^`]+`\.$/);
    assert.equal(failed.cleared, 0, "the original controls stay while no replacement arrived");
    const later = await s.click(buttonIn(prompt, "Later"));
    assert.match(later.replies.join("\n"), /Reminder snoozed 24h/);
    assert.ok(s.sm.getPersistedSession(session.id)?.worktreeDecisionSnoozedUntil);
  });
});

describe("overlapping worktree retries", () => {
  it("never lets an older retry prompt retire the buttons of a newer one", async () => {
    // The host holds the first retry prompt back until the test releases it.
    const held = Promise.withResolvers<void>();
    let retries = 0;
    const s = stack = await startFullStack({
      backend: "codex",
      sendResult: async (params) => {
        if (params.payloads.some((payload) => /still open/.test(payload.text ?? ""))) {
          retries += 1;
          if (retries === 1) await held.promise;
        }
        return { status: "sent", results: params.payloads.map((_, index) => ({ channel: params.channel, messageId: `m-${index}` })) } as never;
      },
    });
    const { session } = await finishConflictingSession(s, "ask");
    const original = await s.waitForButton("Merge");
    await s.sm.whenStorePersisted();
    const first = s.sm.reofferWorktreeDecision(session.id, "Merge failed: test.");
    await waitUntil(() => retries === 1, "first retry prompt in flight");
    // A second failed action re-offers again while the first is still being delivered.
    const second = s.sm.reofferWorktreeDecision(session.id, "Merge failed: test.");
    held.resolve();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    const prompts = s.messages().filter((message) => /still open/.test(message.text));
    assert.equal(prompts.length, 2);
    const [older, newer] = prompts;
    assert.ok(s.sm.getActionToken(buttonIn(newer!, "Merge").payload), "the newest prompt keeps working buttons");
    assert.equal(s.sm.getActionToken(buttonIn(older!, "Merge").payload), undefined, "the older retry prompt was superseded");
    assert.equal(s.sm.getActionToken(original.payload), undefined, "the original controls were retired");
  });
});

describe("a worktree retry prompt whose delivery outcome stays unknown", () => {
  type RetryRequest = { label?: string; buttons?: Array<Array<{ callbackData: string; url?: string }>>; hooks?: { onNotifyAmbiguous?: () => void } };

  /** Hold the retry prompt's dispatch back and hand its request to the test. */
  function captureRetry(s: FullStack): { request: () => RetryRequest | undefined } {
    const notifications = (s.sm as unknown as { notifications: { dispatch: (session: unknown, request: RetryRequest) => void } }).notifications;
    const dispatch = notifications.dispatch.bind(notifications);
    let captured: RetryRequest | undefined;
    notifications.dispatch = (session, request) => {
      if (request.label === "worktree-decision-retry") captured = request;
      else dispatch(session, request);
    };
    return { request: () => captured };
  }
  const freshTokens = (request: RetryRequest): string[] => (request.buttons ?? []).flat().filter((button) => !button.url).map((button) => button.callbackData);

  it("reports it as not delivered within the wait and keeps both button sets", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const { session } = await finishConflictingSession(s, "ask");
    const original = await s.waitForButton("Merge");
    await s.sm.whenStorePersisted();
    const retry = captureRetry(s);

    const lateResults: boolean[] = [];
    const reoffer = s.sm.reofferWorktreeDecision(session.id, "Merge failed: test.", { onLateResult: (delivered) => { lateResults.push(delivered); } });
    await waitUntil(() => Boolean(retry.request()), "the retry prompt dispatch");
    // The direct send timed out: nobody knows whether the prompt arrived.
    retry.request()!.hooks!.onNotifyAmbiguous!();

    // Not "delivered": the caller sends its plain failure line (no silence).
    assert.equal(await reoffer, false);
    assert.deepEqual(lateResults, [], "the result came within the wait");
    // The prompt may have arrived: its buttons stay valid, and so do the older ones.
    const fresh = freshTokens(retry.request()!);
    assert.ok(fresh.length > 0);
    for (const tokenId of fresh) assert.ok(s.sm.getActionToken(tokenId), "a fresh button stays usable");
    assert.ok(s.sm.getActionToken(original.payload), "the original controls stay usable");
    // The entry is settled: a later delivered retry retires the older controls.
    const reoffers = (s.sm as unknown as { worktreeReoffers: Map<string, Map<number, { inFlight: boolean }>> }).worktreeReoffers.get(session.id);
    assert.deepEqual([...(reoffers?.values() ?? [])].map((entry) => entry.inFlight), [false]);
  });

  it("answers a pending prompt whose outcome never arrives with the late failure, once", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const { session } = await finishConflictingSession(s, "ask");
    await s.waitForButton("Merge");
    await s.sm.whenStorePersisted();
    // The dispatch is swallowed: no success, failure or unknown outcome is ever
    // reported (the plugin stopped mid-send, or the decision closed meanwhile).
    const retry = captureRetry(s);
    s.sm.userDeliveryResultWaitMs = 20;
    s.sm.reofferLateFallbackMs = 80;

    const lateResults: boolean[] = [];
    assert.equal(await s.sm.reofferWorktreeDecision(session.id, "Merge failed: test.", { onLateResult: (delivered) => { lateResults.push(delivered); } }), "pending");
    assert.deepEqual(lateResults, []);
    await waitUntil(() => lateResults.length > 0, "the bounded fallback");
    assert.deepEqual(lateResults, [false]);
    const reoffers = (s.sm as unknown as { worktreeReoffers: Map<string, Map<number, { inFlight: boolean }>> }).worktreeReoffers.get(session.id);
    assert.deepEqual([...(reoffers?.values() ?? [])].map((entry) => entry.inFlight), [false], "the entry is settled");
    // An outcome that still arrives afterwards is not reported a second time.
    (retry.request()!.hooks as { onNotifySucceeded?: () => void }).onNotifySucceeded?.();
    assert.deepEqual(lateResults, [false]);
  });

  it("cancels the fallback when the outcome arrives, and on dispose", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const { session } = await finishConflictingSession(s, "ask");
    await s.waitForButton("Merge");
    await s.sm.whenStorePersisted();
    const retry = captureRetry(s);
    s.sm.userDeliveryResultWaitMs = 20;
    s.sm.reofferLateFallbackMs = 60_000;
    const timers = (s.sm as unknown as { reofferLateFallbackTimers: Set<unknown> }).reofferLateFallbackTimers;

    const lateResults: boolean[] = [];
    assert.equal(await s.sm.reofferWorktreeDecision(session.id, "Merge failed: test.", { onLateResult: (delivered) => { lateResults.push(delivered); } }), "pending");
    assert.equal(timers.size, 1);
    (retry.request()!.hooks as { onNotifySucceeded?: () => void }).onNotifySucceeded?.();
    assert.deepEqual(lateResults, [true]);
    assert.equal(timers.size, 0, "the outcome cancels the fallback");

    assert.equal(await s.sm.reofferWorktreeDecision(session.id, "Merge failed: test.", { onLateResult: (delivered) => { lateResults.push(delivered); } }), "pending");
    assert.equal(timers.size, 1);
    s.sm.dispose();
    assert.equal(timers.size, 0, "dispose clears the fallback");
  });

  it("sends the plain failure line when the real direct send times out (dispatcher and executor chain)", async () => {
    const held = Promise.withResolvers<void>();
    const originalTimeout = wakeDeliveryExecutorInternals.promiseTimeoutMs;
    try {
      const s = stack = await startFullStack({
        backend: "codex",
        // The host never answers the retry prompt's send.
        sendResult: async (params) => {
          if (params.payloads.some((payload) => /still open/.test(payload.text ?? ""))) await held.promise;
          return { status: "sent", results: params.payloads.map((_, index) => ({ channel: params.channel, messageId: `m-${index}` })) } as never;
        },
      });
      const { session } = await finishConflictingSession(s, "ask");
      const merge = await s.waitForButton("Merge");
      await s.sm.whenStorePersisted();
      s.sm.userDeliveryResultWaitMs = 30;
      wakeDeliveryExecutorInternals.promiseTimeoutMs = 150;

      const click = await s.click(merge);
      // Still in delivery after the bounded wait: the button sends nothing yet.
      assert.deepEqual(click.replies, []);
      // The send times out: its outcome is unknown, so the user gets the plain line.
      await waitUntil(() => click.replies.length > 0, "the late failure line");
      assert.equal(click.replies.length, 1);
      assert.match(click.replies[0]!, /^❌ \[[\w-]+\] Merge failed: rebase of `[^`]+` onto `[^`]+` hit conflicts; resolve them manually in `[^`]+`\.$/);
      const reoffers = (s.sm as unknown as { worktreeReoffers: Map<string, Map<number, { tokens: Set<string>; inFlight: boolean }>> }).worktreeReoffers.get(session.id);
      const entries = [...(reoffers?.values() ?? [])];
      assert.deepEqual(entries.map((entry) => entry.inFlight), [false]);
      for (const tokenId of entries[0]!.tokens) assert.ok(s.sm.getActionToken(tokenId), "the prompt's buttons stay valid in case it did arrive");
    } finally {
      wakeDeliveryExecutorInternals.promiseTimeoutMs = originalTimeout;
      held.resolve();
    }
  });

  it("reports a late unknown outcome as a late failure, once", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const { session } = await finishConflictingSession(s, "ask");
    await s.waitForButton("Merge");
    await s.sm.whenStorePersisted();
    const retry = captureRetry(s);
    s.sm.userDeliveryResultWaitMs = 20;

    const lateResults: boolean[] = [];
    const reoffer = s.sm.reofferWorktreeDecision(session.id, "Merge failed: test.", { onLateResult: (delivered) => { lateResults.push(delivered); } });
    // The bounded wait ends first: the button sends nothing yet.
    assert.equal(await reoffer, "pending");
    assert.deepEqual(lateResults, []);

    // The send then ends without a known outcome: the caller is told to send its plain line.
    retry.request()!.hooks!.onNotifyAmbiguous!();
    assert.deepEqual(lateResults, [false]);
    for (const tokenId of freshTokens(retry.request()!)) assert.ok(s.sm.getActionToken(tokenId), "a fresh button stays usable");
  });
});

describe("auto-merge conflicts", () => {
  it("starts a conflict resolver session on a real rebase conflict and merges once it finishes", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const turnsBefore = s.backend.turns.length;
    const { repo, session } = await finishConflictingSession(s, "auto-merge");
    await s.waitForMessage(/Completed — merge conflict[^\n]*\nResolver session [\w-]+ is fixing it; the merge is retried automatically when it succeeds\./);
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
    await s.waitForMessage(/^ℹ️ \[[\w-]+\] Merged: `agent\/codex-fullstack` → `main`/);
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
    assert.match(click.replies.join("\n"), /Reminder snoozed 24h/);
    const snoozedUntil = Date.parse(s.sm.getPersistedSession(session.id)?.worktreeDecisionSnoozedUntil ?? "");
    assert.ok(Math.abs(snoozedUntil - (Date.now() + 24 * 60 * 60 * 1000)) < 60_000, "snoozed for 24h");

    // The agent-facing snooze also tells the user.
    const sendsBeforeSnooze = s.host.durableSends.length;
    assert.match(s.sm.snoozeWorktreeDecision(session.id), /Reminder snoozed 24h/);
    await s.waitForMessage(/Reminder snoozed 24h/, sendsBeforeSnooze);

    // Finish the preceding day's Git-backed schedule work before moving the
    // fixture timestamps forward. Keep the real reminder delivery deadline.
    await (s.sm as unknown as { maintenance: { whenIdle(): Promise<void> } }).maintenance.whenIdle();

    // A day later: the snooze has ended and the reminder is due.
    const hour = 60 * 60 * 1000;
    const sendsBefore = s.host.durableSends.length;
    s.sm.updatePersistedSession(session.id, {
      pendingWorktreeDecisionSince: new Date(Date.now() - 26 * hour).toISOString(),
      lastWorktreeReminderAt: new Date(Date.now() - 25 * hour).toISOString(),
      worktreeDecisionSnoozedUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    const reminder = await s.waitForMessage(/^⏰ \[[\w-]+\] Branch `.*` still waits for your decision/, sendsBefore);
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
    // N47: View output can be pressed again and leaves Resume usable.
    const outputAgain = await s.click(buttonIn(suspended, "View output"));
    assert.doesNotMatch(outputAgain.replies.join("\n"), /expired/);

    const resume = await s.click(buttonIn(suspended, "Resume"));
    // One answer: the ▶️ Resumed notice, no extra reply.
    assert.deepEqual(resume.replies, []);
    await s.waitForMessage(/^▶️ \[[\w-]+\] Resumed/);
    await waitUntil(() => s.backend.turns.length > turnsBefore, "resumed turn");
    assert.match(s.backend.turns.at(-1)?.text ?? "", /Continue where you left off/);
    const again = await s.click(buttonIn(suspended, "Resume"));
    assert.match(again.replies.join("\n"), /expired or was already used/);
  });

  it("keeps the launch system prompt (without the worktree preamble) across a Resume", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const repo = createRepo();
    await s.sm.setRepoPolicy(repo, "never-pr");
    const worktreeSession = await s.launch({ workdir: repo, worktreeStrategy: "manual", systemPrompt: "Marker ZEBRA-41.", name: "sys-worktree" });
    const worktreeEffective = (worktreeSession as unknown as { systemPrompt?: string }).systemPrompt ?? "";
    assert.ok(worktreeEffective.length > "Marker ZEBRA-41.".length, "the worktree preamble is appended for the harness");
    await s.sm.whenStorePersisted();
    assert.equal(s.sm.getPersistedSession(worktreeSession.id)?.launchSystemPrompt, "Marker ZEBRA-41.", "only the launch prompt is persisted");
    // The fake backend reuses one thread id: stop this session before the next one.
    assert.ok(s.sm.kill(worktreeSession.id, "user"));
    await waitUntil(() => worktreeSession.status !== "running", "first session stopped");

    const session = await s.launch({ systemPrompt: "Marker ZEBRA-42.", name: "sys-resume" });
    assert.ok(s.sm.kill(session.id, "idle-timeout"));
    const suspended = await s.waitForMessage(/Suspended after idle timeout/);
    const turnsBefore = s.backend.turns.length;
    const clicked = await s.click(buttonIn(suspended, "Resume"));
    assert.deepEqual(clicked.replies, []);
    await s.waitForMessage(/^▶️ \[[\w-]+\] Resumed/);
    await waitUntil(() => s.backend.turns.length > turnsBefore, "resumed turn");
    const resumed = s.sm.resolve(session.id)!;
    assert.equal(resumed.launchSystemPrompt, "Marker ZEBRA-42.");
    const effective = (resumed as unknown as { systemPrompt?: string }).systemPrompt ?? "";
    assert.match(effective, /^Marker ZEBRA-42\./, "the resumed harness gets the launch system prompt");
    assert.equal(effective.match(/Marker ZEBRA-42\./g)?.length, 1);
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
    assert.deepEqual(restart.replies, []);
    await s.waitForMessage(/^▶️ \[[\w-]+\] (Resumed|Relaunched fresh)/);
    await waitUntil(() => s.backend.turns.length > turnsBefore, "restarted turn");
  });

  it("answers a button whose action this build does not know with a clear reply", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const session = await s.launch();
    assert.ok(s.sm.kill(session.id, "idle-timeout"));
    const suspended = await s.waitForMessage(/Suspended after idle timeout/);
    const button = buttonIn(suspended, "Resume");
    // A token minted by a newer build, whose action kind this build lacks.
    const token = s.sm.getActionToken(button.payload) as { kind: string } | undefined;
    assert.ok(token);
    token.kind = "future-action";
    const click = await s.click(button);
    assert.deepEqual(click.replies, ["⚠️ This button is not supported by the running version of the code agent."]);
  });

  it("keeps plugin-update buttons across a Gateway restart", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const dismiss = s.sm.makePluginActionButton("plugin-update", "plugin-update-dismiss", "Skip this version", {
      pluginUpdateVersion: "9.9.9",
      route: { provider: "telegram", target: TELEGRAM_TOPIC.to, threadId: "42" },
    });
    await s.sm.whenStorePersisted();
    await s.restartGateway();
    const click = await s.click(dismiss.callbackData);
    assert.doesNotMatch(click.replies.join("\n"), /stale/);
    assert.match(click.replies.join("\n"), /Skipped/);
  });
});

describe("goal loop", () => {
  function goalWorkdir(): string {
    return mkdtempSync(join(tmpdir(), "oca-goal-loop-"));
  }

  async function launchGoal(s: FullStack, workdir: string, extra: Record<string, unknown> = {}) {
    const turnsBefore = s.backend.turns.length;
    const text = await s.runTool("agent_goal", { action: "launch",
      goal: "Create done.txt",
      verifier_commands: ["test -f done.txt"],
      workdir,
      name: "goal-loop",
      harness: "codex",
      max_iterations: 3,
      // These tests cover the loop itself; the plan gate is covered below.
      permission_mode: "bypassPermissions",
      ...extra,
    });
    assert.doesNotMatch(text, /^Error/, text);
    // D3: orchestrator-supplied verifier commands wait for the user's confirmation.
    assert.match(text, /waiting for the user's confirmation/);
    const prompt = await s.waitForMessage(/\$ test -f done\.txt/);
    assert.equal(s.backend.turns.length, turnsBefore, "nothing runs before the confirmation");
    const run = prompt.buttons.find((button) => button.label === "Run these checks");
    assert.ok(run, "the confirmation prompt has a Run button");
    const sentBeforeRun = s.messages().length;
    const click = await s.click(run);
    // The `🎯 [task] Goal task started` notice is the one answer to the button.
    assert.deepEqual(click.replies, []);
    await s.waitForMessage(/^🎯 \[[\w-]+\] Goal task started/, sentBeforeRun);
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
    await s.waitForMessage(/^🔁 \[[\w-]+\] Repair started after verifier failure \(iteration 1\/\d+\)/);

    writeFileSync(join(workdir, "done.txt"), "done\n");
    await s.backend.endTurn("Created done.txt.");
    await waitUntil(() => s.gc.getTask(task.id)?.status === "succeeded", "goal succeeded");
    await s.waitForMessage(/Completed — goal succeeded/);
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

  it("cancels the goal when the user declines the verifier commands (D3)", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const turnsBefore = s.backend.turns.length;
    await s.runTool("agent_goal", { action: "launch", goal: "Create done.txt", verifier_commands: ["rm -rf /tmp/x"], workdir: goalWorkdir(), harness: "codex" });
    const prompt = await s.waitForMessage(/\$ rm -rf \/tmp\/x/);
    const cancel = prompt.buttons.find((button) => button.label === "Cancel");
    assert.ok(cancel);
    const sentBeforeCancel = s.messages().length;
    const click = await s.click(cancel);
    // The `⛔ [task] Goal task stopped` notice with its reason is the one answer.
    assert.deepEqual(click.replies, []);
    const stopped = await s.waitForMessage(/^⛔ \[[\w-]+\] Goal task stopped/, sentBeforeCancel);
    assert.match(stopped.text, /The user did not confirm the verifier commands\./);
    assert.equal(s.gc.listTasks()[0]?.status, "stopped");
    assert.equal(s.backend.turns.length, turnsBefore);
  });

  it("puts the first iteration's plan through the normal plan gate (D3)", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const workdir = goalWorkdir();
    const turnsBefore = s.backend.turns.length;
    await s.runTool("agent_goal", { action: "launch", goal: "Create done.txt", workdir, harness: "codex", goal_mode: "ralph" });
    await s.backend.waitForTurns(turnsBefore + 1);
    const task = s.gc.listTasks()[0]!;
    assert.equal(task.permissionMode, "plan");
    await s.backend.endTurn("Plan: create done.txt.");
    await waitUntil(() => s.gc.getTask(task.id)?.status === "waiting_for_plan_approval", "goal waits for the plan decision");
    assert.equal(s.backend.turns.length, turnsBefore + 1, "the loop does not approve its own plan");
  });

  for (const controllerSawSuspension of [true, false]) it(`stops the goal when its session, suspended while the plan waits, is stopped with agent_kill (${controllerSawSuspension ? "after" : "before"} the controller noticed the suspension)`, async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const workdir = goalWorkdir();
    const turnsBefore = s.backend.turns.length;
    await s.runTool("agent_goal", { action: "launch", goal: "Create done.txt", workdir, harness: "codex", goal_mode: "ralph" });
    await s.backend.waitForTurns(turnsBefore + 1);
    const task = s.gc.listTasks()[0]!;
    await s.backend.endTurn("Plan: create done.txt.");
    await waitUntil(() => s.gc.getTask(task.id)?.status === "waiting_for_plan_approval", "goal waits for the plan decision");
    s.gc.planDecisionRecheckMs = 50;
    const session = s.sm.resolve(s.gc.getTask(task.id)!.sessionId!)!;

    // The idle timeout suspends the session; its plan decision survives.
    session.kill("idle-timeout");
    await waitUntil(() => s.sm.getPersistedSession(session.id)?.status === "killed", "session suspended");
    await s.sm.whenStorePersisted();
    assert.equal(s.sm.getPersistedSession(session.id)?.pendingPlanApproval, true);
    // Its lifecycle stays "waiting for the plan decision", not "suspended".
    assert.equal(s.sm.resolve(session.id)?.lifecycle, "awaiting_plan_decision");
    if (controllerSawSuspension) {
      // The goal controller sees the suspension and waits for the plan decision.
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(s.gc.getTask(task.id)?.status, "waiting_for_plan_approval");
    }
    // Otherwise the stop lands first: the controller then finds the session
    // unloaded and reads how it ended from the stored row.

    assert.match(await s.runTool("agent_kill", { session: session.id }), /^⛔ \[[\w-]+\] Stopped \(it was not running\)\.$/);

    // The plan is rejected with the session, so nothing keeps waiting for it.
    const row = s.sm.getPersistedSession(session.id);
    assert.equal(row?.pendingPlanApproval, false);
    assert.equal(row?.approvalState, "rejected");
    assert.equal(row?.lifecycle, "terminal");
    assert.equal(s.sm.resolve(session.id), undefined);
    await waitUntil(() => ["stopped", "failed", "succeeded"].includes(s.gc.getTask(task.id)?.status ?? ""), "the goal task ends");
    assert.equal(s.gc.getTask(task.id)?.status, "stopped", s.gc.getTask(task.id)?.failureReason);
    assert.match(s.gc.getTask(task.id)?.failureReason ?? "", /plan was rejected/i);
    assert.equal(s.backend.turns.length, turnsBefore + 1, "nothing was resumed");
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
