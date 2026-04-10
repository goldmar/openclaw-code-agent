import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { truncateText } from "./format";
import { getOpenClawConfig, getPluginRuntime } from "./runtime-store";
import type { PlanArtifact } from "./types";

const PLAN_APPROVAL_FULL_PLAN_MAX_CHARS = 3_200;
const PLAN_APPROVAL_SUMMARY_MAX_CHARS = 2_400;
const PLAN_APPROVAL_SUMMARY_SOURCE_MAX_CHARS = 16_000;
const PLAN_APPROVAL_SUMMARY_TIMEOUT_MS = 45_000;

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? (match[1] ?? "").trim() : trimmed;
}

function collectText(payloads?: Array<{ text?: string }>): string {
  return (payloads ?? [])
    .filter((payload) => typeof payload.text === "string")
    .map((payload) => payload.text ?? "")
    .join("\n")
    .trim();
}

function normalizeSummaryItem(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^`([^`]+)`$/, "$1")
    .trim();
}

function extractPlanSummaryCandidates(preview: string): string[] {
  return preview
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeSummaryItem)
    .map((line) => truncateText(line, 220))
    .filter((line) => line.length > 0)
    .filter((line) => !/^(plan|proposed plan|implementation plan|review summary)[:]?$/i.test(line))
    .filter((line) => !/^(should|can|could|would|will)\b.*\?$/i.test(line))
    .filter((line) => !/^(thinking|checking|considering|analyzing)\b/i.test(line));
}

function buildSafeFallbackSummary(source: string): string {
  const summaryCandidates = extractPlanSummaryCandidates(source);
  if (summaryCandidates.length === 0) {
    return "Review summary:\n- Plan details are available in the full session output.";
  }
  return [
    "Review summary:",
    ...summaryCandidates.slice(0, 6).map((line) => `- ${line}`),
  ].join("\n");
}

function sanitizeLlmSummary(summary: string): string {
  const lines = summary
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, all) => !(line.length === 0 && all[index - 1]?.length === 0));
  const normalized = lines.join("\n").trim();
  if (!normalized) {
    return "Review summary:\n- Plan details are available in the full session output.";
  }
  const withHeader = /^review summary:/i.test(normalized)
    ? normalized
    : `Review summary:\n${normalized}`;
  return truncateText(withHeader, PLAN_APPROVAL_SUMMARY_MAX_CHARS);
}

function resolveEmbeddedModelDefaults(): { provider?: string; model?: string; workspaceDir: string; config?: ReturnType<typeof getOpenClawConfig> } {
  const config = getOpenClawConfig();
  const defaults = config?.agents?.defaults;
  const configuredModel = typeof defaults?.model === "string"
    ? defaults.model.trim()
    : defaults?.model?.primary?.trim();
  const provider = configuredModel?.split("/")[0];
  const model = configuredModel?.split("/").slice(1).join("/");
  return {
    provider: provider || undefined,
    model: model || undefined,
    workspaceDir: defaults?.workspace || process.cwd(),
    config,
  };
}

async function summarizeWithEmbeddedAgent(finalizedPlanSource: string): Promise<string | undefined> {
  const runtime = getPluginRuntime();
  const runEmbeddedPiAgent = runtime?.agent?.runEmbeddedPiAgent;
  if (!runEmbeddedPiAgent) return undefined;

  const sourceText = truncateText(finalizedPlanSource, PLAN_APPROVAL_SUMMARY_SOURCE_MAX_CHARS);
  const prompt = [
    "You are preparing a plan-approval review summary for a human deciding whether to approve implementation.",
    "Use ONLY the finalized plan text provided below.",
    "Do not include chain-of-thought, hidden reasoning, or meta commentary.",
    "Ignore conversational transcript noise and do not quote raw session chatter.",
    "Return ONLY valid JSON in this shape: {\"summary\":\"...\"}.",
    "The summary field must be plain text, under 2200 characters, and optimized for an approval decision.",
    "Format the summary as:",
    "Review summary:",
    "- Scope: ...",
    "- Planned changes: ...",
    "- Risks or limitations: ...",
    "- Validation: ...",
    "- Open questions or assumptions: ... (omit if none)",
    "Keep bullets concrete and specific to the plan. Mention affected components/files only if the plan itself names them.",
    "",
    "FINALIZED_PLAN:",
    sourceText,
  ].join("\n");

  const { provider, model, workspaceDir, config } = resolveEmbeddedModelDefaults();
  let tempDir: string | undefined;

  try {
    tempDir = await mkdtemp(join(tmpdir(), "openclaw-plan-review-"));
    const sessionId = `plan-review-summary-${Date.now()}`;
    const sessionFile = join(tempDir, "session.json");
    const text = collectText((await runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      workspaceDir,
      config,
      prompt,
      timeoutMs: PLAN_APPROVAL_SUMMARY_TIMEOUT_MS,
      runId: `${sessionId}-run`,
      provider,
      model,
      authProfileIdSource: "auto",
      disableTools: true,
    })).payloads);
    if (!text) return undefined;
    const parsed = JSON.parse(stripCodeFences(text)) as { summary?: unknown };
    if (typeof parsed.summary !== "string" || parsed.summary.trim().length === 0) {
      return undefined;
    }
    return sanitizeLlmSummary(parsed.summary);
  } catch (error) {
    console.warn(`[plan-review-summary] Embedded summary generation failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch((): undefined => undefined);
    }
  }
}

export async function buildPlanReviewSummary(args: {
  preview: string;
  artifact?: PlanArtifact;
}): Promise<string> {
  const { preview, artifact } = args;
  const fullPlanText = artifact?.markdown?.trim();
  if (fullPlanText && fullPlanText.length <= PLAN_APPROVAL_FULL_PLAN_MAX_CHARS) {
    return `Full plan:\n${fullPlanText}`;
  }

  const summarySource = fullPlanText || extractPlanSummaryCandidates(preview).join("\n");
  if (!summarySource) {
    return buildSafeFallbackSummary(preview);
  }

  const llmSummary = await summarizeWithEmbeddedAgent(summarySource);
  if (llmSummary) {
    return llmSummary;
  }

  return buildSafeFallbackSummary(summarySource);
}
