import type {
  PendingInputOption,
  PendingInputQuestion,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(
  record: Record<string, unknown> | null | undefined,
  keys: readonly string[],
  options?: { trim?: boolean },
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value !== "string") continue;
    const text = options?.trim === false ? value : value.trim();
    if (text) return text;
  }
  return undefined;
}

function optionLooksRecommended(label: string, record?: Record<string, unknown>): boolean {
  if (record && typeof record.recommended === "boolean") return record.recommended;
  if (record && typeof record.isRecommended === "boolean") return record.isRecommended;
  if (/\b(?:not\s+(?:a\s+)?|non[-\s]?|un)recommended\b/i.test(label)) return false;
  return /\brecommended\b/i.test(label);
}

function normalizePendingInputOption(value: unknown): PendingInputOption | undefined {
  if (typeof value === "string") {
    const label = value.trim();
    return label ? { label, value: label, recommended: optionLooksRecommended(label) } : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const label = pickString(record, ["label", "title", "text", "value", "name", "id"])?.trim();
  if (!label) return undefined;
  const description = pickString(record, ["description", "preview", "detail", "details"]);
  const optionValue = pickString(record, ["value", "id", "name"]);
  const isOther = record.isOther === true || record.is_other === true || record.other === true;
  return {
    label,
    ...(description ? { description } : {}),
    ...(optionValue ? { value: optionValue } : {}),
    ...(isOther ? { isOther: true } : {}),
    recommended: optionLooksRecommended(label, record),
  };
}

export function extractPendingInputOptions(value: unknown): PendingInputOption[] {
  const record = asRecord(value);
  if (!record) return [];
  const rawOptions = record.options ?? record.choices ?? record.availableDecisions ?? record.decisions;
  if (!Array.isArray(rawOptions)) return [];
  return rawOptions
    .map(normalizePendingInputOption)
    .filter((option): option is PendingInputOption => Boolean(option));
}

export function extractPendingInputQuestions(value: unknown): PendingInputQuestion[] {
  const record = asRecord(value);
  const rawQuestions = Array.isArray(record?.questions) ? record.questions : [];
  return rawQuestions
    .map((entry, index) => normalizePendingInputQuestion(entry, index))
    .filter((question): question is PendingInputQuestion => Boolean(question));
}

function normalizePendingInputQuestion(value: unknown, index = 0): PendingInputQuestion | undefined {
  const questionRecord = asRecord(value);
  if (!questionRecord) return undefined;
  const question = pickString(questionRecord, ["question", "prompt", "message", "text", "summary"])?.trim();
  if (!question) return undefined;
  const id = pickString(questionRecord, ["id", "questionId", "question_id", "name"]);
  const header = pickString(questionRecord, ["header", "title", "label"]);
  const rawOptions = Array.isArray(questionRecord.options)
    ? questionRecord.options
    : Array.isArray(questionRecord.choices)
      ? questionRecord.choices
      : [];
  const options = rawOptions
    .map(normalizePendingInputOption)
    .filter((option): option is PendingInputOption => Boolean(option));
  const multiSelect = questionRecord.multiSelect === true || questionRecord.multi_select === true;
  const allowsFreeText = questionRecord.isOther === true
    || questionRecord.is_other === true
    || questionRecord.allowFreeText === true
    || questionRecord.allowsFreeText === true
    || multiSelect
    || options.some((option) => option.isOther);
  return {
    id: id ?? `question_${index + 1}`,
    ...(header ? { header } : {}),
    question,
    options,
    ...(multiSelect ? { multiSelect: true } : {}),
    ...(allowsFreeText ? { allowsFreeText: true } : {}),
    ...(questionRecord.isSecret === true || questionRecord.is_secret === true ? { isSecret: true } : {}),
  };
}

function formatPendingInputQuestion(question: PendingInputQuestion, index: number, count: number): string[] {
  const title = [
    count > 1 ? `Question ${index + 1}` : undefined,
    question.header,
  ].filter(Boolean).join(" - ");
  const lines = [
    ...(title ? [title] : []),
    question.question,
  ];
  if (question.options.length > 0) {
    lines.push(
      "Options:",
      ...question.options.map((option, optionIndex) => {
        const recommended = option.recommended && !/\brecommended\b/i.test(option.label) ? " (recommended)" : "";
        const description = option.description ? ` - ${option.description}` : "";
        const freeText = option.isOther ? " (free text)" : "";
        return `  ${optionIndex + 1}. ${option.label}${recommended}${freeText}${description}`;
      }),
    );
  }
  if (question.multiSelect && question.options.length > 0) {
    lines.push("Reply with one or more option numbers or labels, separated by commas.");
  } else if (question.allowsFreeText && !question.options.some((option) => option.isOther)) {
    lines.push("Free-form answer is allowed.");
  }
  return lines;
}

export function formatPendingInputQuestions(questions: PendingInputQuestion[]): string | undefined {
  if (questions.length === 0) return undefined;
  const lines = questions.flatMap((question, index) => [
    ...(index > 0 ? [""] : []),
    ...formatPendingInputQuestion(question, index, questions.length),
  ]);
  if (questions.length > 1) {
    lines.push("", "Reply with answers by question, for example: Q1: ..., Q2: ...");
  }
  return lines.join("\n");
}

export function formatPendingInputWizardQuestion(question: PendingInputQuestion, index: number, count: number): string {
  return formatPendingInputQuestion(question, index, count).join("\n");
}

export type PendingInputAnswerResolution =
  | { ok: true; answers: string[] }
  | { ok: false; error: string };

/**
 * Map a text reply onto a structured question, the same way for every harness.
 * An option label (case-insensitive) or option number selects that option and
 * yields its value; anything else is a free-text answer unless the question
 * forbids free text. Multi-select questions take comma- or newline-separated
 * entries. Empty replies and option numbers outside the list are rejected so
 * the caller can re-prompt instead of sending a wrong answer.
 */
export function resolvePendingInputAnswer(question: PendingInputQuestion, text: string): PendingInputAnswerResolution {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "The answer is empty." };
  const options = question.options;
  if (options.length === 0) return { ok: true, answers: [trimmed] };
  const entries = question.multiSelect
    ? trimmed.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean)
    : [trimmed];
  if (entries.length === 0) return { ok: false, error: "The answer is empty." };
  const answers: string[] = [];
  for (const entry of entries) {
    const byLabel = options.find((option) => option.label.toLowerCase() === entry.toLowerCase());
    if (byLabel) {
      answers.push(byLabel.value ?? byLabel.label);
      continue;
    }
    if (/^\d+$/.test(entry)) {
      const option = options[Number.parseInt(entry, 10) - 1];
      if (!option) {
        return {
          ok: false,
          error: `"${entry}" is not an option number. Choose 1-${options.length}, reply with an option label${question.allowsFreeText === false ? "" : ", or write the answer in words"}.`,
        };
      }
      answers.push(option.value ?? option.label);
      continue;
    }
    if (question.allowsFreeText === false) {
      return {
        ok: false,
        error: `"${entry}" is not one of the options. Reply with an option number (1-${options.length}) or label.`,
      };
    }
    answers.push(entry);
  }
  return { ok: true, answers: [...new Set(answers)] };
}

/** An approval answer a pending permission request offers. */
export type ApprovalChoiceLike = {
  label: string;
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
  /** Choices that also persist a policy change; free text never selects them implicitly. */
  amendment?: true;
};

/**
 * Map a free-text reply onto an approval choice: an exact label, a choice
 * number, or a plain yes/no/always/cancel word. Returns `undefined` when the
 * text is not a recognizable decision.
 */
export function matchApprovalChoiceText<T extends ApprovalChoiceLike>(choices: T[], text: string): T | undefined {
  const normalized = text.trim().toLowerCase().replace(/[.!]+$/g, "");
  if (!normalized) return undefined;
  const byLabel = choices.find((choice) => choice.label.toLowerCase() === normalized);
  if (byLabel) return byLabel;
  const index = /^\d+$/.test(normalized) ? Number(normalized) - 1 : -1;
  if (index >= 0 && index < choices.length) return choices[index];
  let wanted: ApprovalChoiceLike["decision"] | undefined;
  if (/^(?:approve|approved|allow|accept|yes|y|ok)(?: once)?$/.test(normalized)) wanted = "accept";
  else if (/^(?:approve|allow|accept|yes)(?: for)?(?: this)? session$|^always(?: allow)?$/.test(normalized)) wanted = "acceptForSession";
  else if (/^(?:deny|denied|decline|declined|reject|rejected|no|n|block)$/.test(normalized)) wanted = "decline";
  else if (/^(?:cancel|abort|stop)$/.test(normalized)) wanted = "cancel";
  // Plain decisions only: "no" must never select a persistent deny rule and
  // "always" must never select a persistent allow amendment by accident.
  return wanted ? choices.find((choice) => choice.decision === wanted && !choice.amendment) : undefined;
}
