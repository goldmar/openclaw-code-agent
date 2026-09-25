import { completeRuntimeLlmText, describeRuntimeLlmError, getRuntimeLlmComplete, RuntimeLlmTimeoutError, runtimeLlmTimeoutsMs, withRuntimeLlmTimeout } from "./runtime-llm";
import { createLogger } from "./logger";

const log = createLogger("question-context-summary");

export interface QuestionContextSummaryEvidence {
  sessionName: string;
  question: string;
  context: string;
}

export interface QuestionContextSummaryProvider {
  generateQuestionContextSummary(evidence: QuestionContextSummaryEvidence, signal?: AbortSignal): Promise<unknown>;
}

const MAX_CONTEXT_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 180;
const SUMMARY_MAX_TOKENS = 200;

export function createRuntimeQuestionContextSummaryProvider(): QuestionContextSummaryProvider | undefined {
  const complete = getRuntimeLlmComplete();
  if (!complete) return undefined;

  return {
    async generateQuestionContextSummary(evidence, signal) {
      return await completeRuntimeLlmText(complete, {
        purpose: "openclaw-code-agent.question-context-summary",
        systemPrompt: QUESTION_CONTEXT_SUMMARY_SYSTEM_PROMPT,
        prompt: buildQuestionContextSummaryPrompt(evidence),
        maxTokens: SUMMARY_MAX_TOKENS,
        signal,
      });
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

  const provider = args.provider;
  try {
    const generated = await withRuntimeLlmTimeout(
      "question-context-summary",
      args.timeoutMs ?? runtimeLlmTimeoutsMs.questionContextSummary,
      (signal) => provider.generateQuestionContextSummary(evidence, signal),
    );
    return validateQuestionContextSummary(generated);
  } catch (err) {
    if (!(err instanceof RuntimeLlmTimeoutError)) {
      log.warn(`[question_context_summary] LLM summary provider failed: ${describeRuntimeLlmError(err)}`);
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

const QUESTION_CONTEXT_SUMMARY_SYSTEM_PROMPT = [
  `You summarize why an OpenClaw Code Agent question is being asked.`,
  `Return only JSON with shape {"summary":"..."}.`,
  `Write one concise user-facing sentence under ${MAX_SUMMARY_CHARS} characters.`,
  `Do not answer the question. Do not invent choices. Do not alter option labels or semantics.`,
].join("\n");

function buildQuestionContextSummaryPrompt(evidence: QuestionContextSummaryEvidence): string {
  return [
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

