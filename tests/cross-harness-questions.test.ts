import "./test-env";
import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { setPluginConfig } from "../src/config";
import { executeRespond } from "../src/actions/respond";
import { resolvePendingInputAnswer } from "../src/pending-input-normalization";
import { BACKEND_NAMES, waitUntil, type BackendName, type QuestionSpec } from "./harness-backends";
import {
  buttonNamed,
  clickButton,
  startInteractionFixture,
  type InteractionFixture,
} from "./user-interaction-fixture";

let fixture: InteractionFixture | undefined;

afterEach(async () => {
  mock.timers.reset();
  await fixture?.dispose();
  fixture = undefined;
  setPluginConfig({});
});

const COLOR: QuestionSpec = { id: "color", question: "Which color?", options: ["Red", "Green", "Blue"] };
const SIZES: QuestionSpec = { id: "sizes", question: "Which sizes?", options: ["Small", "Medium", "Large"], multiSelect: true };
const NOTES: QuestionSpec = { id: "notes", question: "Anything else?", options: ["Nothing"], other: true };

/** Codex's request_user_input protocol has no multi-select questions. */
const MULTI_SELECT_BACKENDS = new Set<BackendName>(["claude-code", "opencode"]);

const QUESTION_LABELS = /^(?:ask-user-question|waiting)$/;

/** Raise a question and wait until the session shows it; `answered` settles with the backend's outcome. */
async function askAndWait(questions: QuestionSpec[]): Promise<{ answered: ReturnType<InteractionFixture["backend"]["ask"]> }> {
  const f = fixture!;
  const answered = f.backend.ask(questions);
  await waitUntil(() => f.session.pendingInputState?.kind === "question", "pending question");
  return { answered };
}

async function respond(message: string) {
  const f = fixture!;
  return await executeRespond(f.sm, { session: f.session.id, message, userInitiated: true });
}

/** Buttons of the latest question notification that carries buttons. */
async function questionButtons(after = 0) {
  const f = fixture!;
  await waitUntil(
    () => f.notifications.slice(after).some((entry) => QUESTION_LABELS.test(entry.request.label) && (entry.request.buttons?.length ?? 0) > 0),
    "question buttons",
  );
  const entry = [...f.notifications.slice(after)].reverse()
    .find((candidate) => QUESTION_LABELS.test(candidate.request.label) && (candidate.request.buttons?.length ?? 0) > 0)!;
  return entry.request.buttons!.flat();
}

describe("resolvePendingInputAnswer", () => {
  const question = { id: "q", question: "Pick", options: [{ label: "Red" }, { label: "Green" }, { label: "Blue" }] };

  it("selects options by number or label and keeps other text as a free-text answer", () => {
    assert.deepEqual(resolvePendingInputAnswer(question, "2"), { ok: true, answers: ["Green"] });
    assert.deepEqual(resolvePendingInputAnswer(question, " blue "), { ok: true, answers: ["Blue"] });
    assert.deepEqual(resolvePendingInputAnswer(question, "Teal, please"), { ok: true, answers: ["Teal, please"] });
  });

  it("prefers an exact option label over an option number", () => {
    const numeric = { id: "q", question: "Workers?", options: [{ label: "3" }, { label: "5" }, { label: "1" }] };
    assert.deepEqual(resolvePendingInputAnswer(numeric, "1"), { ok: true, answers: ["1"] });
  });

  it("rejects empty answers and option numbers outside the list", () => {
    assert.deepEqual(resolvePendingInputAnswer(question, "  "), { ok: false, error: "The answer is empty." });
    const outOfRange = resolvePendingInputAnswer(question, "7");
    assert.equal(outOfRange.ok, false);
    assert.match(outOfRange.ok ? "" : outOfRange.error, /"7" is not an option number\. Choose 1-3/);
    const multi = resolvePendingInputAnswer({ ...question, multiSelect: true }, "1, 9");
    assert.equal(multi.ok, false);
  });

  it("rejects free text when the question only accepts its options", () => {
    const strict = { ...question, allowsFreeText: false };
    const result = resolvePendingInputAnswer(strict, "Teal");
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /not one of the options/);
  });

  it("splits multi-select answers and removes duplicate picks", () => {
    assert.deepEqual(
      resolvePendingInputAnswer({ ...question, multiSelect: true }, "1, blue\n1"),
      { ok: true, answers: ["Red", "Blue"] },
    );
  });
});

for (const name of BACKEND_NAMES) {
  describe(`${name}: structured questions`, () => {
    it("answers a single-choice question by option number and by label via agent_respond", async () => {
      fixture = await startInteractionFixture(name);
      const { answered: byNumber } = await askAndWait([COLOR]);
      const numberResult = await respond("2");
      assert.equal(numberResult.isError, undefined, numberResult.text);
      assert.match(numberResult.text, /Pending input request submitted/);
      assert.deepEqual(await byNumber, { kind: "answered", answers: { "Which color?": ["Green"] } });
      await waitUntil(() => !fixture!.session.pendingInputState, "question cleared");

      const { answered: byLabel } = await askAndWait([COLOR]);
      assert.equal((await respond("blue")).isError, undefined);
      assert.deepEqual(await byLabel, { kind: "answered", answers: { "Which color?": ["Blue"] } });
    });

    if (MULTI_SELECT_BACKENDS.has(name)) {
      it("answers a multi-select question by option numbers and by labels", async () => {
        fixture = await startInteractionFixture(name);
        const { answered: byNumbers } = await askAndWait([SIZES]);
        assert.match(fixture.session.pendingInputState?.promptText ?? "", /one or more option numbers or labels/);
        assert.equal((await respond("1, 3")).isError, undefined);
        assert.deepEqual(await byNumbers, { kind: "answered", answers: { "Which sizes?": ["Small", "Large"] } });
        await waitUntil(() => !fixture!.session.pendingInputState, "question cleared");

        const { answered: byLabels } = await askAndWait([SIZES]);
        assert.equal((await respond("medium, Large")).isError, undefined);
        assert.deepEqual(await byLabels, { kind: "answered", answers: { "Which sizes?": ["Medium", "Large"] } });
      });
    } else {
      it("skips multi-select answers: the Codex request_user_input protocol has no multi-select questions", () => {});
    }

    it("sends a free-text answer to a question that offers \"other\"", async () => {
      fixture = await startInteractionFixture(name);
      const { answered: outcome } = await askAndWait([NOTES]);
      assert.equal((await respond("Ship it on Friday")).isError, undefined);
      assert.deepEqual(await outcome, { kind: "answered", answers: { "Anything else?": ["Ship it on Friday"] } });
    });

    it("walks several questions in one request and submits every answer once", async () => {
      fixture = await startInteractionFixture(name);
      const questions = MULTI_SELECT_BACKENDS.has(name) ? [COLOR, SIZES, NOTES] : [COLOR, NOTES];
      const { answered: outcome } = await askAndWait(questions);
      const firstId = fixture.session.pendingInputState?.questions?.[0]?.id;

      const first = await respond("3");
      assert.match(first.text, /more input is required/);
      await waitUntil(() => fixture!.session.pendingInputState?.activeQuestionIndex === 1, "second question");
      assert.notEqual(fixture.session.pendingInputState?.questions?.[1]?.id, firstId);
      if (MULTI_SELECT_BACKENDS.has(name)) {
        assert.match((await respond("2, 3")).text, /more input is required/);
        await waitUntil(() => fixture!.session.pendingInputState?.activeQuestionIndex === 2, "third question");
      }
      const last = await respond("Nothing else");
      assert.match(last.text, /Pending input request submitted/);

      assert.deepEqual(await outcome, {
        kind: "answered",
        answers: {
          "Which color?": ["Blue"],
          ...(MULTI_SELECT_BACKENDS.has(name) ? { "Which sizes?": ["Medium", "Large"] } : {}),
          "Anything else?": ["Nothing else"],
        },
      });
    });

    it("re-prompts on an option number outside the list and keeps the question open", async () => {
      fixture = await startInteractionFixture(name);
      const { answered: outcome } = await askAndWait([COLOR]);
      const invalid = await respond("7");
      assert.equal(invalid.isError, true);
      assert.match(invalid.text, /Answer not submitted .*"7" is not an option number\. Choose 1-3/);
      assert.match(invalid.text, /The question is still waiting:\n[\s\S]*Which color\?/);
      assert.equal(fixture.session.pendingInputState?.kind, "question", "the question stays pending");

      assert.equal((await respond("1")).isError, undefined);
      assert.deepEqual(await outcome, { kind: "answered", answers: { "Which color?": ["Red"] } });
    });

    it("re-prompts on an empty answer and keeps the question open", async () => {
      fixture = await startInteractionFixture(name);
      const { answered: outcome } = await askAndWait([COLOR]);
      for (const empty of ["", "   "]) {
        const result = await respond(empty);
        assert.equal(result.isError, true);
        assert.match(result.text, /Answer not submitted .*The answer is empty\./);
      }
      assert.equal(fixture.session.pendingInputState?.kind, "question");
      assert.equal((await respond("Red")).isError, undefined);
      assert.deepEqual(await outcome, { kind: "answered", answers: { "Which color?": ["Red"] } });
    });

    for (const channel of ["telegram", "discord"] as const) {
      it(`answers a question with a ${channel} button`, async () => {
        fixture = await startInteractionFixture(name);
        const { answered: outcome } = await askAndWait([COLOR]);
        const buttons = await questionButtons();
        assert.deepEqual(buttons.map((button) => button.label), ["Red", "Green", "Blue"]);

        const click = await clickButton(buttonNamed(buttons, "Blue"), channel);
        assert.deepEqual(click.replies, ["✅ Pending input request submitted."]);
        assert.ok(click.cleared > 0, "the answered buttons are cleared");
        assert.deepEqual(await outcome, { kind: "answered", answers: { "Which color?": ["Blue"] } });
      });
    }

    if (name === "claude-code") {
      it("answers from the buttons of both Claude question prompts (question service and waiting notice)", async () => {
        fixture = await startInteractionFixture(name);
        for (const label of ["ask-user-question", "waiting"]) {
          const before = fixture.notifications.length;
          const { answered } = await askAndWait([COLOR]);
          const prompt = await (async () => {
            await waitUntil(
              () => fixture!.notifications.slice(before).some((entry) => entry.request.label === label && (entry.request.buttons?.length ?? 0) > 0),
              `${label} buttons`,
            );
            return fixture!.notifications.slice(before).find((entry) => entry.request.label === label)!;
          })();
          const click = await clickButton(buttonNamed(prompt.request.buttons!.flat(), "Red"));
          assert.deepEqual(click.replies, ["✅ Pending input request submitted."], label);
          assert.deepEqual(await answered, { kind: "answered", answers: { "Which color?": ["Red"] } });
          await waitUntil(() => !fixture!.session.pendingInputState, "question cleared");
        }
      });
    }

    it("reports a second click on an answered question button as no longer active", async () => {
      fixture = await startInteractionFixture(name);
      const { answered: outcome } = await askAndWait([COLOR]);
      const buttons = await questionButtons();
      await clickButton(buttonNamed(buttons, "Green"));
      assert.deepEqual(await outcome, { kind: "answered", answers: { "Which color?": ["Green"] } });

      for (const label of ["Green", "Red"]) {
        const again = await clickButton(buttonNamed(buttons, label));
        assert.match(again.replies.join("\n"), /no longer active/);
      }
    });

    it("rejects a button from an earlier question step after the wizard moved on", async () => {
      fixture = await startInteractionFixture(name);
      const second: QuestionSpec = { id: "size", question: "Which size?", options: ["Small", "Large"] };
      const { answered: outcome } = await askAndWait([COLOR, second]);
      const firstButtons = await questionButtons();
      const before = fixture.notifications.length;
      await clickButton(buttonNamed(firstButtons, "Red"));
      await waitUntil(() => fixture!.session.pendingInputState?.activeQuestionIndex === 1, "second question");
      const secondButtons = await questionButtons(before);
      assert.deepEqual(secondButtons.map((button) => button.label), ["Small", "Large"]);

      const stale = await clickButton(buttonNamed(firstButtons, "Blue"));
      assert.match(stale.replies.join("\n"), /no longer active/);
      assert.equal(fixture.session.pendingInputState?.activeQuestionIndex, 1, "the stale click does not answer step 2");

      await clickButton(buttonNamed(secondButtons, "Large"));
      assert.deepEqual(await outcome, { kind: "answered", answers: { "Which color?": ["Red"], "Which size?": ["Large"] } });
    });

    if (name === "claude-code") {
      it("tells the agent when the user does not answer within the question timeout", async () => {
        fixture = await startInteractionFixture(name);
        mock.timers.enable({ apis: ["setTimeout"] });
        const outcome = fixture.backend.ask([COLOR]);
        while (fixture.session.pendingInputState?.kind !== "question") {
          await new Promise((resolve) => setImmediate(resolve));
        }
        const buttons = await (async () => {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const entry = [...fixture!.notifications].reverse().find((candidate) => (candidate.request.buttons?.length ?? 0) > 0);
            if (entry) return entry.request.buttons!.flat();
            await new Promise((resolve) => setImmediate(resolve));
          }
          throw new Error("no question buttons");
        })();
        mock.timers.tick(10 * 60 * 1000);
        const result = await outcome;
        mock.timers.reset();
        assert.equal(result.kind, "cancelled");
        assert.match(result.kind === "cancelled" ? result.reason : "", /did not answer the question \(AskUserQuestion timed out after 600s/);
        await waitUntil(() => !fixture!.session.pendingInputState, "question cleared");

        const late = await clickButton(buttonNamed(buttons, "Red"));
        assert.match(late.replies.join("\n"), /no longer waiting for an answer/);
      });
    } else {
      it("clears the question when the backend resolves it without an answer", async () => {
        fixture = await startInteractionFixture(name);
        const { answered: outcome } = await askAndWait([COLOR]);
        const buttons = await questionButtons();
        await fixture.backend.expirePendingRequest();
        assert.equal((await outcome).kind, "cancelled");
        await waitUntil(() => !fixture!.session.pendingInputState, "question cleared");

        const late = await clickButton(buttonNamed(buttons, "Red"));
        assert.match(late.replies.join("\n"), /no longer waiting for an answer/);
        const text = await respond("Red");
        assert.equal(text.isError, undefined, text.text);
        assert.doesNotMatch(text.text, /Pending input request submitted/, "a late reply is a normal message, not an answer");
      });
    }

    it("resumes a suspended session with the answer when a question button is clicked", async () => {
      fixture = await startInteractionFixture(name);
      void fixture.backend.ask([COLOR]);
      await waitUntil(() => fixture!.session.pendingInputState?.kind === "question", "pending question");
      const buttons = await questionButtons();
      const turnsBefore = fixture.backend.turns.length;
      fixture.session.kill("idle-timeout");
      await waitUntil(() => fixture!.sm.getPersistedSession(fixture!.session.id)?.status === "killed", "session suspended");

      const click = await clickButton(buttonNamed(buttons, "Blue"));
      assert.deepEqual(click.replies, ["✅ Answer forwarded to the resumed session."]);
      await waitUntil(() => fixture!.backend.turns.length > turnsBefore, "resumed turn");
      const resumedTurn = fixture.backend.turns.at(-1)!;
      assert.match(resumedTurn.text, /interrupted by an OpenClaw Gateway restart/);
      assert.match(resumedTurn.text, /Selected answer: Blue/);

      const again = await clickButton(buttonNamed(buttons, "Red"));
      assert.match(again.replies.join("\n"), /no longer active/);
    });

    it("resumes the session with the answer when a question button is clicked after a Gateway restart", async () => {
      fixture = await startInteractionFixture(name);
      void fixture.backend.ask([COLOR]);
      await waitUntil(() => fixture!.session.pendingInputState?.kind === "question", "pending question");
      const buttons = await questionButtons();
      const turnsBefore = fixture.backend.turns.length;
      await fixture.restartGateway();

      const click = await clickButton(buttonNamed(buttons, "Green"));
      assert.deepEqual(click.replies, ["✅ Answer forwarded to the resumed session."]);
      await waitUntil(() => fixture!.backend.turns.length > turnsBefore, "resumed turn");
      assert.match(fixture.backend.turns.at(-1)!.text, /Selected answer: Green/);
      assert.equal(fixture.sm.resolve(fixture.session.id)?.status, "running");
    });
  });
}
