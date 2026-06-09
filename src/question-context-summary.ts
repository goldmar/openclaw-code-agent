import { getPluginRuntime } from "./runtime-store";

export interface QuestionContextSummaryEvidence {
  sessionName: string;
  question: string;
  context: string;
}

export interface QuestionContextSummaryProvider {
  generateQuestionContextSummary(evidence: QuestionContextSummaryEvidence): Promise<unknown>;
}

type RuntimeQuestionSummaryCandidate = {
  generateQuestionContextSummary?: (evidence: QuestionContextSummaryEvidence) => Promise<unknown> | unknown;
  summarizeQuestionContext?: (evidence: QuestionContextSummaryEvidence) => Promise<unknown> | unknown;
  generateObject?: (params: Record<string, unknown>) => Promise<unknown> | unknown;
  generateText?: (params: Record<string, unknown> | string) => Promise<unknown> | unknown;
  complete?: (params: Record<string, unknown> | string) => Promise<unknown> | unknown;
};

const MAX_CONTEXT_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 180;
const SUMMARY_TIMEOUT_MS = 300;

export function createRuntimeQuestionContextSummaryProvider(): QuestionContextSummaryProvider | undefined {
  const runtime = getPluginRuntime() as Record<string, unknown> | undefined;
  const candidate = findRuntimeQuestionSummaryCandidate(runtime);
  if (!candidate) return undefined;

  return {
    async generateQuestionContextSummary(evidence) {
      if (typeof candidate.generateQuestionContextSummary === "function") {
        return await candidate.generateQuestionContextSummary(evidence);
      }
      if (typeof candidate.summarizeQuestionContext === "function") {
        return await candidate.summarizeQuestionContext(evidence);
      }

      const prompt = buildQuestionContextSummaryPrompt(evidence);
      if (typeof candidate.generateObject === "function") {
        return await candidate.generateObject({
          task: "openclaw-code-agent.question-context-summary",
          prompt,
          input: evidence,
        });
      }
      if (typeof candidate.generateText === "function") {
        return await candidate.generateText({
          task: "openclaw-code-agent.question-context-summary",
          prompt,
        });
      }
      if (typeof candidate.complete === "function") {
        return await candidate.complete({ prompt });
      }
      return undefined;
    },
  };
}

export async function buildQuestionContextMicroSummary(args: {
  sessionName: string;
  question?: string;
  context?: string;
  provider?: QuestionContextSummaryProvider;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const question = normalizeWhitespace(args.question ?? "");
  const context = normalizeWhitespace(stripQuestionEcho(question, args.context ?? ""));
  if (!args.provider || !question || !context) return undefined;

  const evidence: QuestionContextSummaryEvidence = {
    sessionName: args.sessionName,
    question,
    context: truncateText(context, MAX_CONTEXT_CHARS),
  };

  try {
    const generated = await withTimeout(
      args.provider.generateQuestionContextSummary(evidence),
      args.timeoutMs ?? SUMMARY_TIMEOUT_MS,
    );
    return validateQuestionContextSummary(generated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message !== "question-context-summary timed out") {
      console.warn(`[question_context_summary] LLM summary provider failed: ${message}`);
    }
    return undefined;
  }
}

function validateQuestionContextSummary(generated: unknown): string | undefined {
  const raw = normalizeGeneratedSummaryPayload(generated);
  const value = typeof raw === "string"
    ? raw
    : raw && typeof raw === "object" && typeof (raw as { summary?: unknown }).summary === "string"
      ? (raw as { summary: string }).summary
      : undefined;
  const text = normalizeWhitespace(value ?? "")
    .replace(/^[-*•]\s+/, "")
    .trim();
  if (!text || text.length > MAX_SUMMARY_CHARS) return undefined;
  if (text.split(/[.!?]+/).filter((part) => part.trim()).length > 1) return undefined;
  return text;
}

function normalizeGeneratedSummaryPayload(generated: unknown): unknown {
  if (typeof generated !== "string") return generated;
  const text = generated.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function findRuntimeQuestionSummaryCandidate(runtime: Record<string, unknown> | undefined): RuntimeQuestionSummaryCandidate | undefined {
  const candidates = [
    runtime?.questionContextSummary,
    runtime?.llm,
    runtime?.ai,
    runtime?.model,
    runtime?.models,
  ];
  return candidates.find((candidate): candidate is RuntimeQuestionSummaryCandidate =>
    Boolean(candidate && typeof candidate === "object" && (
      typeof (candidate as RuntimeQuestionSummaryCandidate).generateQuestionContextSummary === "function"
      || typeof (candidate as RuntimeQuestionSummaryCandidate).summarizeQuestionContext === "function"
      || typeof (candidate as RuntimeQuestionSummaryCandidate).generateObject === "function"
      || typeof (candidate as RuntimeQuestionSummaryCandidate).generateText === "function"
      || typeof (candidate as RuntimeQuestionSummaryCandidate).complete === "function"
    )),
  );
}

function buildQuestionContextSummaryPrompt(evidence: QuestionContextSummaryEvidence): string {
  return [
    `Summarize why an OpenClaw Code Agent question is being asked.`,
    `Return only JSON with shape {"summary":"..."}.`,
    `Write one concise user-facing sentence under ${MAX_SUMMARY_CHARS} characters.`,
    `Do not answer the question. Do not invent choices. Do not alter option labels or semantics.`,
    ``,
    `Evidence:`,
    JSON.stringify(evidence, null, 2),
  ].join("\n");
}

function stripQuestionEcho(question: string, context: string): string {
  if (!question) return context;
  return context
    .split(/\r?\n/)
    .filter((line) => normalizeWhitespace(line) !== question)
    .join("\n");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("question-context-summary timed out")), timeoutMs);
    timeout.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}
