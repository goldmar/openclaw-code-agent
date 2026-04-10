import { randomUUID } from "crypto";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { truncateText } from "./format";
import { getOpenClawConfig, getPluginRuntime } from "./runtime-store";
import type { PlanArtifact } from "./types";

const PLAN_APPROVAL_FULL_PLAN_MAX_CHARS = 3_200;
const PLAN_APPROVAL_FULL_PLAN_CHUNK_MAX_CHARS = 3_000;
const PLAN_APPROVAL_FULL_PLAN_CHUNK_BODY_MAX_CHARS = 2_400;
const PLAN_APPROVAL_FULL_PLAN_MAX_CHUNKS = 3;
const PLAN_APPROVAL_SUMMARY_MAX_CHARS = 2_400;
const PLAN_APPROVAL_SUMMARY_SOURCE_MAX_CHARS = 16_000;
const PLAN_APPROVAL_SUMMARY_TIMEOUT_MS = 45_000;
const PLAN_APPROVAL_MISSING_PROVIDER_WARNING =
  "[plan-review-summary] Embedded model defaults must use \"provider/model\". " +
  "Skipping LLM summary generation.";

export type PlanApprovalPromptContent = {
  displayMode: "single-full-plan" | "chunked-full-plan" | "summary";
  userMessages: string[];
  reviewSummary: string;
};

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

function splitLongLine(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf(" ", maxChars);
    if (splitAt < Math.floor(maxChars * 0.6)) {
      splitAt = maxChars;
    }
    parts.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}

function splitPlanBodyIntoChunks(text: string, maxChars: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = (): void => {
    if (current.trim().length > 0) {
      chunks.push(current.trimEnd());
      current = "";
    }
  };

  for (const line of lines) {
    if (line.length > maxChars) {
      pushCurrent();
      for (const part of splitLongLine(line, maxChars)) {
        chunks.push(part);
      }
      continue;
    }

    const candidate = current.length > 0 ? `${current}\n${line}` : line;
    if (candidate.length > maxChars) {
      pushCurrent();
      current = line;
      continue;
    }

    current = candidate;
  }

  pushCurrent();
  return chunks;
}

function buildChunkedFullPlanMessages(sessionName: string, actionableVersion: number | undefined, fullPlanText: string, hasButtons: boolean): string[] | undefined {
  const bodyChunks = splitPlanBodyIntoChunks(fullPlanText, PLAN_APPROVAL_FULL_PLAN_CHUNK_BODY_MAX_CHARS);
  if (bodyChunks.length === 0 || bodyChunks.length > PLAN_APPROVAL_FULL_PLAN_MAX_CHUNKS) {
    return undefined;
  }

  const total = bodyChunks.length;
  const messages = bodyChunks.map((body, index) => {
    const partLabel = total > 1 ? ` (${index + 1}/${total})` : "";
    const header = [
      `📋 [${sessionName}] Plan v${actionableVersion ?? "?"} ready for approval${partLabel}:`,
      "",
      index === 0 ? "Full plan:" : "",
    ].filter(Boolean).join("\n");
    const footer = index === total - 1
      ? (hasButtons ? "\n\nChoose Approve, Revise, or Reject below." : "\n\nApproval is still pending for this plan version.")
      : "\n\nContinued in next message.";
    return `${header}\n${body}${footer}`;
  });

  return messages.every((message) => message.length <= PLAN_APPROVAL_FULL_PLAN_CHUNK_MAX_CHARS)
    ? messages
    : undefined;
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
  if (configuredModel && !configuredModel.includes("/")) {
    console.warn(`${PLAN_APPROVAL_MISSING_PROVIDER_WARNING} Received: "${configuredModel}".`);
    return {
      workspaceDir: defaults?.workspace || process.cwd(),
      config,
    };
  }
  const [provider, ...modelParts] = configuredModel?.split("/") ?? [];
  const model = modelParts.join("/");
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
  if (!provider || !model) return undefined;
  let tempDir: string | undefined;

  try {
    tempDir = await mkdtemp(join(tmpdir(), "openclaw-plan-review-"));
    const sessionId = `plan-review-summary-${randomUUID()}`;
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
  skipLlm?: boolean;
}): Promise<string> {
  const { preview, artifact, skipLlm = false } = args;
  const fullPlanText = artifact?.markdown?.trim();
  if (fullPlanText && fullPlanText.length <= PLAN_APPROVAL_FULL_PLAN_MAX_CHARS) {
    return `Full plan:\n${fullPlanText}`;
  }

  const summarySource = fullPlanText || extractPlanSummaryCandidates(preview).join("\n");
  if (!summarySource) {
    return buildSafeFallbackSummary(preview);
  }

  if (!skipLlm) {
    const llmSummary = await summarizeWithEmbeddedAgent(summarySource);
    if (llmSummary) {
      return llmSummary;
    }
  }

  return buildSafeFallbackSummary(summarySource);
}

export async function buildPlanApprovalPromptContent(args: {
  sessionName: string;
  actionableVersion?: number;
  preview: string;
  artifact?: PlanArtifact;
  hasButtons: boolean;
  skipLlm?: boolean;
}): Promise<PlanApprovalPromptContent> {
  const { sessionName, actionableVersion, preview, artifact, hasButtons, skipLlm = false } = args;
  const fullPlanText = artifact?.markdown?.trim();

  if (fullPlanText) {
    const singleMessage = `📋 [${sessionName}] Plan v${actionableVersion ?? "?"} ready for approval:\n\nFull plan:\n${fullPlanText}\n\n${hasButtons ? "Choose Approve, Revise, or Reject below." : "Approval is still pending for this plan version."}`;
    if (singleMessage.length <= PLAN_APPROVAL_FULL_PLAN_MAX_CHARS) {
      return {
        displayMode: "single-full-plan",
        userMessages: [singleMessage],
        reviewSummary: `Full plan:\n${fullPlanText}`,
      };
    }

    const chunkedMessages = buildChunkedFullPlanMessages(sessionName, actionableVersion, fullPlanText, hasButtons);
    if (chunkedMessages) {
      return {
        displayMode: "chunked-full-plan",
        userMessages: chunkedMessages,
        reviewSummary: await buildPlanReviewSummary({ preview, artifact, skipLlm }),
      };
    }
  }

  const reviewSummary = await buildPlanReviewSummary({ preview, artifact, skipLlm });
  return {
    displayMode: "summary",
    userMessages: [
      `📋 [${sessionName}] Plan v${actionableVersion ?? "?"} ready for approval:\n\n${reviewSummary}\n\n${hasButtons ? "Choose Approve, Revise, or Reject below." : "Approval is still pending for this plan version."}`,
    ],
    reviewSummary,
  };
}
