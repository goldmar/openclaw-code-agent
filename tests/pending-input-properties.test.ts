import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  extractPendingInputOptions,
  extractPendingInputQuestions,
  formatPendingInputQuestions,
  matchApprovalChoiceText,
  resolvePendingInputAnswer,
  type ApprovalChoiceLike,
} from "../src/pending-input-normalization";
import type { PendingInputOption, PendingInputQuestion } from "../src/types";
import { propertyParams } from "./property-harness";

/**
 * Properties of the shared answer parser every harness uses to map a chat
 * reply onto a structured question (src/pending-input-normalization.ts).
 */

// Labels are distinct (ignoring case), and no label is a comma/newline piece of
// another, so each selection has exactly one reading.
const LABEL_POOL = ["Alpha", "Beta", "Gamma", "Yes, continue", "No, stop, and revert", "Ship it", "7"];
const SEPARATORS = [",", ", ", "\n", " ,  ", ",\n", "\n\n"];

const optionArb = (label: string): fc.Arbitrary<PendingInputOption> => fc.record({
  label: fc.constant(label),
  value: fc.option(fc.constantFrom(`value-${label.length}`, label.toUpperCase(), `v:${label}`), { nil: undefined }),
  description: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
});

const optionsArb: fc.Arbitrary<PendingInputOption[]> = fc.shuffledSubarray(LABEL_POOL, { minLength: 1 })
  .chain((labels) => fc.tuple(...labels.map(optionArb)));

const randomCase = (text: string): fc.Arbitrary<string> =>
  fc.array(fc.boolean(), { minLength: text.length, maxLength: text.length })
    .map((flags) => [...text].map((char, index) => (flags[index] ? char.toUpperCase() : char.toLowerCase())).join(""));

/** Label first, then option number: the documented precedence. */
function expectedAnswer(options: PendingInputOption[], entry: string): string | undefined {
  const byLabel = options.find((option) => option.label.toLowerCase() === entry.toLowerCase());
  if (byLabel) return byLabel.value ?? byLabel.label;
  if (!/^\d+$/.test(entry)) return undefined;
  const option = options[Number.parseInt(entry, 10) - 1];
  return option ? option.value ?? option.label : undefined;
}

function questionArb(options: PendingInputOption[], multiSelect: boolean): fc.Arbitrary<PendingInputQuestion> {
  return fc.record({
    allowsFreeText: fc.option(fc.boolean(), { nil: undefined }),
  }).map(({ allowsFreeText }) => ({
    id: "q1",
    question: "Pick",
    options,
    ...(multiSelect ? { multiSelect: true } : {}),
    ...(allowsFreeText !== undefined ? { allowsFreeText } : {}),
  }));
}

/** A selection typed as an option number or as its label in any case. */
const selectionArb = (options: PendingInputOption[]): fc.Arbitrary<string> =>
  fc.nat({ max: options.length - 1 }).chain((index) => fc.oneof(
    fc.constant(String(index + 1)),
    randomCase(options[index].label),
  ));

describe("resolvePendingInputAnswer (properties)", () => {
  it("maps any list of option numbers and labels onto those options", () => {
    fc.assert(
      fc.property(
        optionsArb.chain((options) => fc.tuple(
          fc.constant(options),
          questionArb(options, true),
          fc.array(selectionArb(options), { minLength: 1, maxLength: 5 }),
          fc.array(fc.constantFrom(...SEPARATORS), { minLength: 5, maxLength: 5 }),
          fc.constantFrom("", " ", "\n", "  \n "),
        )),
        ([options, question, selections, separators, padding]) => {
          const text = padding + selections.map((entry, index) => (index === 0 ? entry : `${separators[index]}${entry}`)).join("") + padding;
          const result = resolvePendingInputAnswer(question, text);
          const expected = [...new Set(selections.map((entry) => expectedAnswer(options, entry)))];
          assert.deepEqual(result, { ok: true, answers: expected }, JSON.stringify(text));
        },
      ),
      propertyParams(400),
    );
  });

  it("maps a single-select number or label onto its option", () => {
    fc.assert(
      fc.property(
        optionsArb.chain((options) => fc.tuple(fc.constant(options), questionArb(options, false), selectionArb(options))),
        ([options, question, selection]) => {
          const result = resolvePendingInputAnswer(question, `  ${selection} `);
          assert.deepEqual(result, { ok: true, answers: [expectedAnswer(options, selection)] });
        },
      ),
      propertyParams(200),
    );
  });

  it("rejects option numbers outside the list with the valid range", () => {
    fc.assert(
      fc.property(
        optionsArb.chain((options) => fc.tuple(
          fc.constant(options.filter((option) => !/^\d+$/.test(option.label))),
          fc.boolean(),
        )).filter(([options]) => options.length > 0),
        fc.oneof(fc.constant(0), fc.integer({ min: 8, max: 1_000_000 })),
        ([options, multiSelect], number) => {
          const question: PendingInputQuestion = { id: "q", question: "Pick", options, ...(multiSelect ? { multiSelect: true } : {}) };
          const result = resolvePendingInputAnswer(question, String(number));
          assert.equal(result.ok, false);
          assert.ok(!result.ok && result.error.includes(`1-${options.length}`), JSON.stringify(result));
        },
      ),
      propertyParams(150),
    );
  });

  it("rejects blank replies", () => {
    fc.assert(
      fc.property(optionsArb, fc.boolean(), fc.stringMatching(/^[ \t\n\r]*$/), (options, multiSelect, blank) => {
        const result = resolvePendingInputAnswer({ id: "q", question: "Pick", options, ...(multiSelect ? { multiSelect: true } : {}) }, blank);
        assert.deepEqual(result, { ok: false, error: "The answer is empty." });
      }),
      propertyParams(50),
    );
  });

  it("never throws, and answers are options unless free text is allowed", () => {
    const textArb = fc.oneof(
      fc.string({ maxLength: 30 }),
      fc.array(fc.oneof(fc.nat({ max: 12 }).map(String), fc.constantFrom(...LABEL_POOL), fc.string({ maxLength: 6 })), { maxLength: 5 })
        .chain((pieces) => fc.constantFrom(...SEPARATORS).map((separator) => pieces.join(separator))),
    );
    fc.assert(
      fc.property(
        fc.oneof(optionsArb, fc.constant<PendingInputOption[]>([])),
        fc.boolean(),
        fc.option(fc.boolean(), { nil: undefined }),
        textArb,
        (options, multiSelect, allowsFreeText, text) => {
          const question: PendingInputQuestion = {
            id: "q",
            question: "Pick",
            options,
            ...(multiSelect ? { multiSelect: true } : {}),
            ...(allowsFreeText !== undefined ? { allowsFreeText } : {}),
          };
          const result = resolvePendingInputAnswer(question, text);
          if ("error" in result) {
            assert.equal(result.ok, false);
            assert.ok(result.error.length > 0);
            return;
          }
          assert.ok(result.answers.length > 0, "an accepted answer is never empty");
          assert.equal(new Set(result.answers).size, result.answers.length, "answers are unique");
          if (options.length === 0) {
            assert.deepEqual(result.answers, [text.trim()]);
            return;
          }
          const optionAnswers = new Set(options.map((option) => option.value ?? option.label));
          for (const answer of result.answers) {
            if (optionAnswers.has(answer)) continue;
            assert.notEqual(allowsFreeText, false, `free text "${answer}" accepted although free text is forbidden`);
            assert.ok(text.includes(answer), `free-text answer "${answer}" is not part of the reply`);
            assert.equal(answer, answer.trim());
          }
        },
      ),
      propertyParams(400),
    );
  });
});

describe("question and option extraction (properties)", () => {
  it("never throws on arbitrary protocol payloads and keeps only usable entries", () => {
    const rawOptionArb = fc.oneof(
      fc.string({ maxLength: 8 }),
      fc.record({
        label: fc.oneof(fc.string({ maxLength: 8 }), fc.integer()),
        title: fc.string({ maxLength: 8 }),
        value: fc.string({ maxLength: 8 }),
        id: fc.string({ maxLength: 4 }),
        recommended: fc.boolean(),
        isOther: fc.boolean(),
        description: fc.string({ maxLength: 8 }),
      }, { requiredKeys: [] }),
      fc.anything({ maxDepth: 1 }),
    );
    const rawQuestionArb = fc.oneof(
      fc.record({
        question: fc.oneof(fc.string({ maxLength: 12 }), fc.constant(undefined)),
        prompt: fc.string({ maxLength: 12 }),
        id: fc.string({ maxLength: 6 }),
        header: fc.string({ maxLength: 6 }),
        options: fc.array(rawOptionArb, { maxLength: 4 }),
        choices: fc.array(rawOptionArb, { maxLength: 4 }),
        multiSelect: fc.anything({ maxDepth: 0 }),
        multi_select: fc.boolean(),
        allowFreeText: fc.boolean(),
        isSecret: fc.boolean(),
      }, { requiredKeys: [] }),
      fc.anything({ maxDepth: 2 }),
    );
    fc.assert(
      fc.property(
        fc.oneof(
          fc.record({ questions: fc.array(rawQuestionArb, { maxLength: 4 }) }),
          fc.record({ options: fc.array(rawOptionArb, { maxLength: 5 }), choices: fc.anything({ maxDepth: 1 }) }, { requiredKeys: [] }),
          fc.anything({ maxDepth: 3 }),
        ),
        (payload) => {
          const questions = extractPendingInputQuestions(payload);
          for (const question of questions) {
            assert.ok(question.id.length > 0);
            assert.ok(question.question.length > 0 && question.question === question.question.trim());
            if (question.multiSelect) assert.equal(question.allowsFreeText, true, "multi-select questions accept free text");
            for (const option of question.options) assert.ok(option.label.length > 0 && option.label === option.label.trim());
          }
          for (const option of extractPendingInputOptions(payload)) {
            assert.ok(option.label.length > 0 && option.label === option.label.trim());
            assert.equal(typeof option.recommended, "boolean");
          }
          const formatted = formatPendingInputQuestions(questions);
          assert.equal(formatted === undefined, questions.length === 0);
        },
      ),
      propertyParams(300),
    );
  });
});

describe("matchApprovalChoiceText (properties)", () => {
  const choiceArb: fc.Arbitrary<ApprovalChoiceLike> = fc.record({
    label: fc.oneof(fc.constantFrom("Allow", "Allow for session", "Deny", "Always allow", "Cancel", "Yes", "no"), fc.string({ maxLength: 10 })),
    decision: fc.constantFrom<ApprovalChoiceLike["decision"]>("accept", "acceptForSession", "decline", "cancel"),
    amendment: fc.option(fc.constant(true as const), { nil: undefined }),
  });

  it("returns one of the choices and never picks a policy amendment from a plain word", () => {
    fc.assert(
      fc.property(
        fc.array(choiceArb, { maxLength: 6 }),
        fc.oneof(
          fc.constantFrom("yes", "No.", "always", "ALWAYS ALLOW", "deny!", "cancel", "approve for this session", "y", "n", "ok", "1", "3", "0"),
          fc.string({ maxLength: 12 }),
        ),
        (choices, text) => {
          const choice = matchApprovalChoiceText(choices, text);
          if (!choice) return;
          assert.ok(choices.includes(choice), "the match is one of the offered choices");
          const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, "");
          const exact = choices.find((candidate) => candidate.label.toLowerCase() === normalized);
          if (exact) {
            assert.equal(choice, exact, "an exact label wins");
            return;
          }
          const index = /^\d+$/.test(normalized) ? Number(normalized) - 1 : -1;
          if (index >= 0 && index < choices.length) {
            assert.equal(choice, choices[index], "an option number selects that choice");
            return;
          }
          assert.notEqual(choice.amendment, true, `"${text}" selected a policy amendment`);
        },
      ),
      propertyParams(300),
    );
  });
});

describe("pending input regressions", () => {
  it("keeps a multi-select label that contains a comma whole", () => {
    const question: PendingInputQuestion = {
      id: "q",
      question: "Next steps?",
      multiSelect: true,
      allowsFreeText: true,
      options: [
        { label: "Yes, continue", value: "continue" },
        { label: "Add tests", value: "tests" },
      ],
    };
    assert.deepEqual(resolvePendingInputAnswer(question, "Yes, continue"), { ok: true, answers: ["continue"] });
    assert.deepEqual(resolvePendingInputAnswer(question, "add tests, yes, continue"), { ok: true, answers: ["tests", "continue"] });
    assert.deepEqual(resolvePendingInputAnswer(question, "Yes, 2"), { ok: true, answers: ["Yes", "tests"] });
  });

  it("prefers separate options when a reply also spells a combined label", () => {
    const question: PendingInputQuestion = {
      id: "q",
      question: "Pick",
      multiSelect: true,
      options: [{ label: "A" }, { label: "B" }, { label: "A, B" }, { label: "No" }, { label: "No, stop, and revert" }],
    };
    assert.deepEqual(resolvePendingInputAnswer(question, "A, B"), { ok: true, answers: ["A", "B"] });
    assert.deepEqual(resolvePendingInputAnswer(question, "3"), { ok: true, answers: ["A, B"] });
    assert.deepEqual(resolvePendingInputAnswer(question, "no, stop, and revert"), { ok: true, answers: ["No, stop, and revert"] });
    assert.deepEqual(resolvePendingInputAnswer(question, "No, B"), { ok: true, answers: ["No", "B"] });
  });
});
