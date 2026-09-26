import "./test-env";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAcquireSessionStoreLock } from "../src/session-store-storage";
import { setGitHubCliAvailabilityForTests } from "../src/worktree-repo";
import type { DurableSendParams, DurableSendResult } from "./fake-host";
import { BACKEND_NAMES, waitUntil, type BackendName, type PlanDecisionOutcome } from "./harness-backends";
import {
  DISCORD_THREAD,
  sessionsIndexPath,
  startFullStack,
  TELEGRAM_TOPIC,
  type FullStack,
  type FullStackOptions,
} from "./fullstack-fixture";

/**
 * The #491 question, plan-approval and worktree-decision flows, run through the
 * real plugin entry: notifications leave through the real WakeDispatcher, route
 * resolver and durable-send transport, and buttons come back through the
 * interactive handler the plugin registered on the host.
 */

let stack: FullStack | undefined;

before(() => setGitHubCliAvailabilityForTests(false));
after(() => setGitHubCliAvailabilityForTests(undefined));

afterEach(async () => {
  await stack?.dispose();
  stack = undefined;
});

const COLOR = { id: "color", question: "Which color?", options: ["Red", "Green", "Blue"] };
const PLAN = "1. Add the migration\n2. Update the model\n3. Add tests";

async function start(name: BackendName, options: Omit<FullStackOptions, "backend"> = {}): Promise<FullStack> {
  stack = await startFullStack({ backend: name, ...options });
  return stack;
}

function failedSend(params: DurableSendParams): DurableSendResult {
  return { status: "failed", error: new Error(`fake ${params.channel}: chat not found`), stage: "platform_send" } as DurableSendResult;
}

/** A host that renders text but refuses any message with buttons. */
function refuseButtons(params: DurableSendParams): DurableSendResult {
  if (params.payloads.some((payload) => payload.presentation)) {
    return { status: "failed", error: new Error("fake telegram: BUTTON_DATA_INVALID"), stage: "platform_send" } as DurableSendResult;
  }
  return {
    status: "sent",
    results: params.payloads.map((_, index) => ({ channel: params.channel, messageId: `text-${index}` })),
  } as DurableSendResult;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "oca-fullstack-repo-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "init");
  return repo;
}

async function expectImplementationStarted(s: FullStack, decision: Promise<PlanDecisionOutcome> | undefined, turnsBefore: number): Promise<void> {
  if (s.backend.name === "claude-code") {
    assert.equal((await decision)?.kind, "approve");
    return;
  }
  await waitUntil(() => s.backend.turns.length > turnsBefore, "implementation turn");
  assert.equal(s.backend.turns.at(-1)?.planMode, false);
}

for (const name of BACKEND_NAMES) {
  describe(`${name}: full-stack flows`, () => {
    it("delivers a question with buttons to the Telegram topic and answers it from a button", async () => {
      const s = await start(name);
      const session = await s.launch();
      const answered = s.backend.ask([COLOR]);
      const green = await s.waitForButton("Green");
      const prompt = s.messages().find((message) => message.buttons.some((button) => button.label === "Green"))!;
      assert.equal(prompt.channel, "telegram");
      assert.equal(prompt.to, TELEGRAM_TOPIC.to);
      assert.equal(String(prompt.threadId), String(TELEGRAM_TOPIC.threadId));
      assert.equal(prompt.accountId, TELEGRAM_TOPIC.accountId);
      assert.match(prompt.text, /Which color\?/);
      assert.deepEqual(prompt.buttons.map((button) => button.label), ["Red", "Green", "Blue"]);
      // One prompt per question for every harness (B20: Claude used to post two).
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(s.messages().filter((message) => /Which color\?/.test(message.text)).length, 1);

      const click = await s.click(green);
      assert.deepEqual(click.replies, [`✅ [${session.name}] Answer sent: Green.`]);
      assert.deepEqual(await answered, { kind: "answered", answers: { "Which color?": ["Green"] } });
      await waitUntil(() => !session.pendingInputState, "question cleared");

      const late = await s.click(prompt.buttons.find((button) => button.label === "Red")!);
      assert.match(late.replies.join("\n"), /already answered or replaced|expired/);
    });

    it("asks for plan approval in a Discord thread and implements after the Approve button", async () => {
      const s = await start(name, { surface: DISCORD_THREAD });
      const session = await s.launch({ permissionMode: "plan", planApproval: "ask" });
      const decision = s.backend.proposePlan(PLAN);
      await waitUntil(() => session.pendingPlanApproval === true, "pending plan approval");
      const turnsBefore = s.backend.turns.length;
      const approve = await s.waitForButton("Approve");
      const prompt = s.messages().find((message) => message.buttons.some((button) => button.payload === approve.payload))!;
      assert.equal(prompt.channel, "discord");
      assert.equal(prompt.to, DISCORD_THREAD.to);
      assert.equal(String(prompt.threadId), String(DISCORD_THREAD.threadId));
      assert.deepEqual(prompt.buttons.map((button) => button.label), ["Approve", "Revise", "Reject"]);

      await s.click(approve);
      await expectImplementationStarted(s, decision, turnsBefore);
      const stale = await s.click(prompt.buttons.find((button) => button.label === "Reject")!);
      assert.match(stale.replies.join("\n"), /already approved|stale|no longer/i);
      assert.notEqual(session.status, "killed", "a stale Reject does not stop the approved session");
    });

    it("offers the worktree decision on Telegram and merges from the Merge button", async () => {
      const s = await start(name);
      const repo = createRepo();
      await s.sm.setRepoPolicy(repo, "never-pr");
      const session = await s.launch({ workdir: repo, worktreeStrategy: "ask" });
      const worktree = session.worktreePath!;
      assert.ok(worktree && worktree !== repo, "the session runs in its own worktree");
      writeFileSync(join(worktree, "feature.txt"), "feature\n");
      git(worktree, "add", "feature.txt");
      git(worktree, "commit", "-m", "add feature");
      await s.backend.endTurn("Added feature.txt.");

      const merge = await s.waitForButton("Merge");
      const prompt = s.messages().find((message) => message.buttons.some((button) => button.payload === merge.payload))!;
      assert.equal(prompt.to, TELEGRAM_TOPIC.to);
      assert.deepEqual(prompt.buttons.map((button) => button.label), ["Merge", "Later", "Discard"]);
      // The host has no model (every runtime.llm call fails): the prompt carries
      // the deterministic summary (from the session output or its commits).
      assert.ok(s.host.llmCalls.some((call) => call.purpose === "openclaw-code-agent.worktree-decision-summary"));
      // N40: the prompt names the session; the summary lines follow the headline.
      assert.match(prompt.text, /^🔀 \[[\w-]+\] Finished on `agent\/[\w-]+` → `main`: 1 commit, 1 file, \+1\/-0/);
      assert.match(prompt.text, /\n- (?:Added|Adds) feature/);
      assert.match(prompt.text, /Discard deletes the branch and its changes for good\.$/);
      await s.click(merge);
      await waitUntil(() => s.sm.getPersistedSession(session.id)?.worktreeLifecycle?.state === "merged", "merge recorded", 10_000);
      assert.ok(existsSync(join(repo, "feature.txt")), "branch merged into main");
      await s.waitForMessage(/Merged|merged/, prompt.index + 1);
    });

    it("falls back to a plain-text plan prompt when the host refuses buttons", async () => {
      const s = await start(name, { sendResult: refuseButtons });
      const session = await s.launch({ permissionMode: "plan", planApproval: "delegate" });
      const decision = s.backend.proposePlan(PLAN);
      await waitUntil(() => session.pendingPlanApproval === true, "pending plan approval");
      await waitUntil(() => s.wakes.some((wake) => /You review it \(planApproval: delegate\)/.test(wake.message)), "delegated review wake");
      const turnsBefore = s.backend.turns.length;

      // The orchestrator hands the review to the user; the host refuses the buttons.
      const handedOver = await s.runTool("agent_escalate", { session: session.id, kind: "plan", summary: "Touches the schema; please confirm." });
      assert.match(handedOver, /Canonical plan approval prompt queued/);
      const fallback = await s.waitForMessage(/buttons could not be delivered/);
      assert.equal(fallback.buttons.length, 0);
      assert.match(fallback.text, /Reply "approve"/);
      await waitUntil(() => s.sm.getPersistedSession(session.id)?.approvalPromptStatus === "fallback_delivered", "fallback recorded");
      assert.equal(s.sm.getPersistedSession(session.id)?.approvalPromptMessageKind, "explicit_fallback_text");

      // The user answers in plain text, through the chat command.
      const reply = await s.host.runCommand("agent_respond", { args: `${session.id} approve` });
      assert.doesNotMatch(reply.text ?? "", /^Error/, reply.text);
      await expectImplementationStarted(s, decision, turnsBefore);
    });

    it("wakes the orchestrator when the question cannot be delivered, and uses a system event for plain notices", async () => {
      const s = await start(name, { sendResult: failedSend });
      const session = await s.launch();
      // The launch notice (text only) falls back to a system event for the origin session.
      await waitUntil(() => s.host.systemEvents.some((event) => /Launched/.test(event.text)), "launch notice system event");
      assert.equal(s.host.systemEvents.find((event) => /Launched/.test(event.text))?.options.sessionKey, TELEGRAM_TOPIC.sessionKey);

      void s.backend.ask([COLOR]);
      await waitUntil(() => session.pendingInputState?.kind === "question", "pending question");
      // Buttons are never flattened into a text-only fallback; the orchestrator is woken instead.
      await waitUntil(() => s.wakes.some((wake) => /Which color\?/.test(wake.message)), "question fallback wake");
      assert.equal(s.host.systemEvents.some((event) => /Which color\?/.test(event.text)), false);
      assert.equal(session.pendingInputState?.kind, "question", "the question stays pending for a text answer");
    });

    it("never shows buttons whose prompt was answered while their tokens were being persisted", async () => {
      const s = await start(name);
      const session = await s.launch();
      const sendsBefore = s.host.durableSends.length;
      // Another writer holds the session index: the question's tokens cannot be saved yet.
      const lock = tryAcquireSessionStoreLock(sessionsIndexPath());
      assert.ok(typeof lock === "object", "the test holds the index lock");
      let answered: ReturnType<typeof s.backend.ask> | undefined;
      try {
        answered = s.backend.ask([COLOR]);
        await waitUntil(() => session.pendingInputState?.kind === "question", "pending question");
        const reply = await s.host.runCommand("agent_respond", { args: `${session.id} Blue` });
        assert.doesNotMatch(reply.text ?? "", /^Error/, reply.text);
      } finally {
        lock.release();
      }
      assert.deepEqual(await answered, { kind: "answered", answers: { "Which color?": ["Blue"] } });
      await s.sm.whenStorePersisted();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const shown = s.messages().filter((message) => message.index >= sendsBefore && message.buttons.length > 0);
      assert.deepEqual(shown, [], "the obsolete question buttons were skipped, not sent");
    });
  });
}
