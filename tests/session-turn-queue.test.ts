import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session";
import { registerHarness } from "../src/harness/index";
import type { AgentHarness, HarnessLaunchOptions, HarnessMessage, HarnessSession } from "../src/harness/types";
import type { ThreadAction } from "../src/types";
import { makeSessionConfig, tick } from "./helpers";

/**
 * Turn-sequential harness shaped like the Codex / OpenCode prompt loops: one
 * `run_started` per pulled prompt, and the next prompt is pulled right after a
 * turn finishes, before Session has applied that turn's `run_completed`.
 */
function createSequentialHarness(name: string) {
  const turns: string[] = [];
  let finishCurrent: (() => void) | undefined;
  const harness: AgentHarness & {
    turns: string[];
    finishTurn: () => void;
    turnRunning: () => boolean;
  } = {
    name,
    backendKind: "codex-app-server",
    supportedPermissionModes: ["default", "plan", "bypassPermissions"],
    capabilities: { nativePendingInput: true, nativePlanArtifacts: true, threadActions: ["compact", "review"] },
    turns,
    finishTurn() {
      const finish = finishCurrent;
      finishCurrent = undefined;
      finish?.();
    },
    turnRunning: () => finishCurrent !== undefined,
    buildUserMessage(text: string) {
      return { type: "user", text };
    },
    buildThreadActionMessage(action: ThreadAction) {
      return { type: "action", action };
    },
    launch(options: HarnessLaunchOptions): HarnessSession {
      const events: HarnessMessage[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      const emit = (event: HarnessMessage) => {
        events.push(event);
        wake?.();
        wake = undefined;
      };
      const prompt = options.prompt as AsyncIterable<{ type: string; text?: string; action?: ThreadAction }>;
      const iterator = prompt[Symbol.asyncIterator]();
      void (async () => {
        emit({ type: "backend_ref", ref: { kind: "codex-app-server", conversationId: "thread-1" } });
        let next = iterator.next();
        while (!closed) {
          const pulled = await next;
          if (pulled.done) break;
          if (pulled.value.text?.startsWith("answer:")) {
            // Consumed as a pending-input answer: no turn starts.
            turns.push(pulled.value.text);
            emit({ type: "prompt_settled" });
            next = iterator.next();
            continue;
          }
          turns.push(pulled.value.type === "action" ? `action:${pulled.value.action?.kind}` : pulled.value.text ?? "");
          emit({ type: "run_started" });
          await new Promise<void>((resolve) => { finishCurrent = resolve; });
          // Pull the next prompt before reporting completion, as the real loops can.
          next = iterator.next();
          emit({
            type: "run_completed",
            data: {
              success: true,
              outcome: "completed",
              outcomeAuthoritative: true,
              duration_ms: 1,
              total_cost_usd: 0,
              num_turns: turns.length,
              session_id: "thread-1",
            },
          });
        }
      })();
      const messages: AsyncIterable<HarnessMessage> = {
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            while (events.length > 0) yield events.shift()!;
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        },
      };
      return {
        messages,
        async close() {
          closed = true;
          wake?.();
        },
      };
    },
  };
  return harness;
}

describe("follow-ups queued behind a running turn (turn-sequential harness)", () => {
  let harness: ReturnType<typeof createSequentialHarness>;

  before(() => {
    harness = createSequentialHarness("sequential-harness");
    registerHarness(harness);
  });

  async function startRunningSession(): Promise<Session> {
    harness.turns.length = 0;
    const session = new Session(makeSessionConfig({
      harness: "sequential-harness",
      permissionMode: "bypassPermissions",
      prompt: "first task",
    }), "queued-followup");
    await session.start();
    await tick(20);
    assert.equal(session.status, "running");
    assert.deepEqual(harness.turns, ["first task"]);
    return session;
  }

  it("runs a follow-up sent during a turn instead of completing the session", async () => {
    const session = await startRunningSession();
    try {
      assert.equal(await session.sendMessage("follow-up task"), "queued");

      harness.finishTurn();
      await tick(20);
      assert.equal(session.status, "running", "the queued follow-up must keep the session alive");
      assert.deepEqual(harness.turns, ["first task", "follow-up task"]);

      harness.finishTurn();
      await tick(20);
      assert.equal(session.status, "completed");
    } finally {
      if (session.status === "running") session.kill("user");
    }
  });

  it("does not wait for a turn from a prompt the harness settled without one", async () => {
    const session = await startRunningSession();
    try {
      await session.sendMessage("answer: yes");
      harness.finishTurn();
      await tick(50);
      assert.deepEqual(harness.turns, ["first task", "answer: yes"]);
      assert.equal(session.status, "completed", "a settled prompt must not hold the session open");
    } finally {
      if (session.status === "running") session.kill("user");
    }
  });

  it("runs a thread action queued during a turn before the session completes", async () => {
    const session = await startRunningSession();
    try {
      session.requestThreadAction({ kind: "review", target: { type: "uncommittedChanges" } });

      harness.finishTurn();
      await tick(20);
      assert.equal(session.status, "running");
      assert.deepEqual(harness.turns, ["first task", "action:review"]);

      harness.finishTurn();
      await tick(20);
      assert.equal(session.status, "completed");
      assert.throws(
        () => session.requestThreadAction({ kind: "compact" }),
        /Session is not running \(status: completed\)/,
      );
    } finally {
      if (session.status === "running") session.kill("user");
    }
  });
});
