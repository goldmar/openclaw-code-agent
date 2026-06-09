import type {
  PendingInputOption,
  PendingInputQuestion,
} from "./types";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function pickString(
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

export function optionLooksRecommended(label: string, record?: Record<string, unknown>): boolean {
  if (record && typeof record.recommended === "boolean") return record.recommended;
  if (record && typeof record.isRecommended === "boolean") return record.isRecommended;
  return /\brecommended\b/i.test(label);
}

export function normalizePendingInputOption(value: unknown): PendingInputOption | undefined {
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

export function normalizePendingInputQuestion(value: unknown, index = 0): PendingInputQuestion | undefined {
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
  const allowsFreeText = questionRecord.isOther === true
    || questionRecord.is_other === true
    || questionRecord.allowFreeText === true
    || questionRecord.allowsFreeText === true
    || questionRecord.multiSelect === true
    || options.some((option) => option.isOther);
  return {
    id: id ?? `question_${index + 1}`,
    ...(header ? { header } : {}),
    question,
    options,
    ...(allowsFreeText ? { allowsFreeText: true } : {}),
    ...(questionRecord.isSecret === true || questionRecord.is_secret === true ? { isSecret: true } : {}),
  };
}

export function formatPendingInputQuestion(question: PendingInputQuestion, index: number, count: number): string[] {
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
  if (question.allowsFreeText && !question.options.some((option) => option.isOther)) {
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
