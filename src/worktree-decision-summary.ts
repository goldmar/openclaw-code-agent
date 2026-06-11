import type { getDiffSummary } from "./worktree";
import { getPluginRuntime } from "./runtime-store";

type DiffSummary = NonNullable<ReturnType<typeof getDiffSummary>>;

export interface WorktreeDecisionSummaryEvidence {
  sessionName: string;
  objective?: string;
  stats?: {
    commits: number;
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  changedFiles: string[];
  commitSubjects: string[];
  outputPreview?: string;
}

export interface WorktreeDecisionSummaryProvider {
  generateWorktreeDecisionSummary(evidence: WorktreeDecisionSummaryEvidence): Promise<unknown>;
}

export type WorktreeDecisionSummaryResult =
  | { source: "llm"; lines: string[]; evidence: WorktreeDecisionSummaryEvidence }
  | { source: "fallback"; lines: string[]; evidence: WorktreeDecisionSummaryEvidence; error?: string };

const MAX_SUMMARY_LINES = 3;
const MAX_SUMMARY_LINE_LENGTH = 180;
const MAX_OUTPUT_PREVIEW_LENGTH = 4_000;
const OPAQUE_TOKEN_MIN_LENGTH = 32;

type RuntimeSummaryCandidate = {
  generateWorktreeDecisionSummary?: (evidence: WorktreeDecisionSummaryEvidence) => Promise<unknown> | unknown;
  summarizeWorktreeDecision?: (evidence: WorktreeDecisionSummaryEvidence) => Promise<unknown> | unknown;
  generateObject?: (params: Record<string, unknown>) => Promise<unknown> | unknown;
  generateText?: (params: Record<string, unknown> | string) => Promise<unknown> | unknown;
  complete?: (params: Record<string, unknown> | string) => Promise<unknown> | unknown;
};

export function createRuntimeWorktreeDecisionSummaryProvider(): WorktreeDecisionSummaryProvider | undefined {
  const runtime = getPluginRuntime() as Record<string, unknown> | undefined;
  const candidate = findRuntimeSummaryCandidate(runtime);
  if (!candidate) return undefined;

  return {
    async generateWorktreeDecisionSummary(evidence) {
      if (typeof candidate.generateWorktreeDecisionSummary === "function") {
        return await candidate.generateWorktreeDecisionSummary(evidence);
      }
      if (typeof candidate.summarizeWorktreeDecision === "function") {
        return await candidate.summarizeWorktreeDecision(evidence);
      }

      const prompt = buildWorktreeDecisionSummaryPrompt(evidence);
      if (typeof candidate.generateObject === "function") {
        return await candidate.generateObject({
          task: "openclaw-code-agent.worktree-decision-summary",
          prompt,
          input: evidence,
        });
      }
      if (typeof candidate.generateText === "function") {
        return await candidate.generateText({
          task: "openclaw-code-agent.worktree-decision-summary",
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

export function buildFallbackWorktreeDecisionSummary(diffSummary: {
  changedFiles: string[];
  commitMessages: Array<{ message: string }>;
}, outputPreview?: string): string[] {
  const outputLines = buildOutputPreviewSummaryLines(outputPreview);
  if (outputLines.length > 0) return outputLines;

  const summaryLines: string[] = [];
  const topFiles = diffSummary.changedFiles.slice(0, 3).map((file) => `\`${file}\``);
  if (topFiles.length > 0) {
    const remainingFiles = diffSummary.changedFiles.length - topFiles.length;
    summaryLines.push(
      remainingFiles > 0
        ? `Touches ${topFiles.join(", ")} and ${remainingFiles} more file${remainingFiles === 1 ? "" : "s"}`
        : `Touches ${topFiles.join(", ")}`,
    );
  }

  const recentSubjects = [...new Set(
    diffSummary.commitMessages
      .map((commit) => commit.message.trim())
      .filter(Boolean),
  )].slice(0, 2);
  if (recentSubjects.length > 0) {
    summaryLines.push(`Recent work: ${recentSubjects.join("; ")}`);
  }

  return summaryLines;
}

export async function buildWorktreeDecisionWorkSummary(args: {
  sessionName: string;
  prompt?: string;
  diffSummary?: DiffSummary;
  outputPreview?: string;
  provider?: WorktreeDecisionSummaryProvider;
}): Promise<WorktreeDecisionSummaryResult> {
  const evidence = buildWorktreeDecisionSummaryEvidence(args);
  const fallback = buildFallbackWorktreeDecisionSummary(args.diffSummary ?? {
    changedFiles: evidence.changedFiles,
    commitMessages: evidence.commitSubjects.map((message) => ({ message })),
  }, args.outputPreview);

  if (!args.provider) {
    return { source: "fallback", lines: fallback, evidence, error: "LLM summary provider unavailable." };
  }

  try {
    const generated = await args.provider.generateWorktreeDecisionSummary(evidence);
    const lines = validateGeneratedWorktreeDecisionSummary(generated);
    if (lines.length > 0) return { source: "llm", lines, evidence };
    return {
      source: "fallback",
      lines: fallback,
      evidence,
      error: "LLM-generated worktree summary failed schema validation.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[worktree_decision_summary] LLM summary provider failed: ${message}`);
    return {
      source: "fallback",
      lines: fallback,
      evidence,
      error: "LLM summary provider failed.",
    };
  }
}

function buildWorktreeDecisionSummaryEvidence(args: {
  sessionName: string;
  prompt?: string;
  diffSummary?: DiffSummary;
  outputPreview?: string;
}): WorktreeDecisionSummaryEvidence {
  const diffSummary = args.diffSummary;
  return {
    sessionName: args.sessionName,
    objective: buildSafeObjective(args.prompt),
    stats: diffSummary
      ? {
          commits: diffSummary.commits,
          filesChanged: diffSummary.filesChanged,
          insertions: diffSummary.insertions,
          deletions: diffSummary.deletions,
        }
      : undefined,
    changedFiles: diffSummary?.changedFiles ?? [],
    commitSubjects: diffSummary?.commitMessages
      .map((commit) => sanitizeSummaryText(commit.message))
      .filter(Boolean)
      .slice(0, 8) ?? [],
    outputPreview: truncateText(redactSensitiveText(args.outputPreview ?? ""), MAX_OUTPUT_PREVIEW_LENGTH),
  };
}

function validateGeneratedWorktreeDecisionSummary(generated: unknown): string[] {
  const normalizedGenerated = normalizeGeneratedSummaryPayload(generated);
  const rawLines = Array.isArray(normalizedGenerated)
    ? normalizedGenerated
    : normalizedGenerated && typeof normalizedGenerated === "object" && Array.isArray((normalizedGenerated as { summary?: unknown }).summary)
      ? (normalizedGenerated as { summary: unknown[] }).summary
      : undefined;
  if (!rawLines || rawLines.length === 0 || rawLines.length > MAX_SUMMARY_LINES) return [];

  const lines = rawLines
    .map((line) => typeof line === "string" ? sanitizeSummaryText(line) : "")
    .filter(Boolean);
  if (lines.length !== rawLines.length) return [];
  if (lines.some((line) => line.length > MAX_SUMMARY_LINE_LENGTH)) return [];
  if (lines.some(containsSensitiveText)) return [];
  return lines;
}

function normalizeGeneratedSummaryPayload(generated: unknown): unknown {
  if (typeof generated !== "string") return generated;
  const text = generated.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return {
      summary: text
        .split("\n")
        .map((line) => line.replace(/^[-*•]\s+/, "").trim())
        .filter(Boolean)
        .slice(0, MAX_SUMMARY_LINES),
    };
  }
}

function findRuntimeSummaryCandidate(runtime: Record<string, unknown> | undefined): RuntimeSummaryCandidate | undefined {
  const candidates = [
    runtime?.worktreeDecisionSummary,
    runtime?.llm,
    runtime?.ai,
    runtime?.model,
    runtime?.models,
  ];
  return candidates.find((candidate): candidate is RuntimeSummaryCandidate =>
    Boolean(candidate && typeof candidate === "object" && (
      typeof (candidate as RuntimeSummaryCandidate).generateWorktreeDecisionSummary === "function"
      || typeof (candidate as RuntimeSummaryCandidate).summarizeWorktreeDecision === "function"
      || typeof (candidate as RuntimeSummaryCandidate).generateObject === "function"
      || typeof (candidate as RuntimeSummaryCandidate).generateText === "function"
      || typeof (candidate as RuntimeSummaryCandidate).complete === "function"
    )),
  );
}

function buildWorktreeDecisionSummaryPrompt(evidence: WorktreeDecisionSummaryEvidence): string {
  return [
    `Summarize the completed OpenClaw Code Agent work for a worktree decision notification.`,
    `Return only JSON with shape {"summary":["..."]}.`,
    `Write 1-3 concise, user-facing bullets that help a human choose Merge, Open PR, Later, or Discard.`,
    `Do not mention that you are summarizing. Do not invent changes not supported by the evidence.`,
    ``,
    `Evidence:`,
    JSON.stringify(evidence, null, 2),
  ].join("\n");
}

function buildOutputPreviewSummaryLines(outputPreview: string | undefined): string[] {
  const seen = new Set<string>();
  const lines = redactSensitiveText(outputPreview ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => sanitizeSummaryText(line))
    .map((line) => stripSummaryPrefix(line))
    .filter(isUsefulOutputSummaryLine)
    .map((line) => truncateText(line, MAX_SUMMARY_LINE_LENGTH))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SUMMARY_LINES);
  return lines;
}

function stripSummaryPrefix(line: string): string {
  return line
    .replace(/^(?:summary|done|completed|changes|validation|verified)\s*:\s*/i, "")
    .trim();
}

function isUsefulOutputSummaryLine(line: string): boolean {
  if (line.length < 12 || line.length > MAX_SUMMARY_LINE_LENGTH) return false;
  if (containsSensitiveText(line)) return false;
  if (/^(```|>|command\b|exit code\b|\$|[a-z0-9_-]+@[a-z0-9_-]+:)/i.test(line)) return false;
  if (/^(?:running|ran|pnpm|npm|node|git|tsc|vitest|jest)\b/i.test(line)) return false;
  if (/^(?:pass|fail|ok|error)\b[:\s]/i.test(line)) return false;
  if (/^(?:changed files?|files changed|recent commits?|commits?)\b/i.test(line)) return false;
  return /^(?:implemented|updated|added|fixed|changed|removed|verified|covered|refactored|improved|created|documented|hardened|restored|simplified|renamed|moved|wired|handled|blocked|reduced|deduplicated|normalized|addressed|prevented)\b/i.test(line)
    || /\b(?:now|so that|coverage|tests?|validation|regression|cleanup|summary|notification|callback|button|merge|worktree|policy|pr)\b/i.test(line);
}

function buildSafeObjective(prompt: string | undefined): string | undefined {
  const normalized = prompt
    ?.replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  if (!normalized) return undefined;
  const firstSentence = normalized.match(/^[^.!?]+[.!?]/)?.[0] ?? normalized;
  const redacted = redactSensitiveText(firstSentence).replace(/\s+/g, " ").trim();
  return redacted ? truncateText(redacted, 180) : undefined;
}

function sanitizeSummaryText(value: string): string {
  return value
    .replace(/^[-*•]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\b[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|pwd|credential|credentials|authorization|auth)[A-Za-z0-9_-]*\b\s*[:=]\s*["']?[^"'\s,;)]+/gi, "[redacted credential]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g, "[redacted token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted token]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted token]")
    .replace(/\bhttps?:\/\/\S+/gi, "[redacted link]")
    .replace(new RegExp(`\\b[A-Za-z0-9_-]{${OPAQUE_TOKEN_MIN_LENGTH},}\\b`, "g"), "[redacted token]");
}

function containsSensitiveText(value: string): boolean {
  return /\b[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|passwd|pwd|credential|credentials|authorization|auth)[A-Za-z0-9_-]*\b\s*[:=]\s*["']?[^"'\s,;)]+/i.test(value)
    || /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/.test(value)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)
    || /\bhttps?:\/\/\S+/i.test(value)
    || new RegExp(`\\b[A-Za-z0-9_-]{${OPAQUE_TOKEN_MIN_LENGTH},}\\b`).test(value);
}
