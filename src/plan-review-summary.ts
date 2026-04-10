import { truncateText } from "./format";
import type { PlanArtifact } from "./types";

const PLAN_APPROVAL_FULL_PLAN_MAX_CHARS = 3_200;
const PLAN_APPROVAL_FULL_PLAN_CHUNK_MAX_CHARS = 3_000;
const PLAN_APPROVAL_FULL_PLAN_CHUNK_BODY_MAX_CHARS = 2_400;
const PLAN_APPROVAL_SESSION_NAME_MAX_CHARS = 120;

export type PlanApprovalPromptContent = {
  displayMode: "single-full-plan" | "chunked-full-plan" | "summary";
  userMessages: string[];
  reviewSummary: string;
};

function normalizeSummaryItem(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^`([^`]+)`$/, "$1")
    .trim();
}

function extractPlanSummaryCandidates(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizeSummaryItem)
    .map((line) => truncateText(line, 220))
    .filter((line) => line.length > 0)
    .filter((line) => !/^(plan|proposed plan|implementation plan|review summary|full plan)[:]?$/i.test(line))
    .filter((line) => !/^(should|can|could|would|will)\b.*\?$/i.test(line))
    .filter((line) => !/^(thinking|checking|considering|analyzing)\b/i.test(line));
}

function buildDeterministicFallbackSummary(source: string): string {
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

function formatPlanApprovalSessionName(sessionName: string): string {
  return truncateText(sessionName.trim(), PLAN_APPROVAL_SESSION_NAME_MAX_CHARS);
}

function buildPlanApprovalFooter(hasButtons: boolean, isLastChunk: boolean): string {
  if (!isLastChunk) {
    return "\n\nContinued in next message.";
  }

  return hasButtons
    ? "\n\nChoose Approve, Revise, or Reject below."
    : "\n\nApproval is still pending for this plan version.";
}

function buildTruncatedFullPlanFallbackMessage(args: {
  sessionName: string;
  actionableVersion?: number;
  fullPlanText: string;
  hasButtons: boolean;
}): string {
  const { sessionName, actionableVersion, fullPlanText, hasButtons } = args;
  const header = `📋 [${sessionName}] Plan v${actionableVersion ?? "?"} ready for approval:`;
  const bodyLabel = "\n\nFull plan (truncated):\n";
  const footer = buildPlanApprovalFooter(hasButtons, true);
  const availableBodyChars = Math.max(
    0,
    PLAN_APPROVAL_FULL_PLAN_CHUNK_MAX_CHARS - header.length - bodyLabel.length - footer.length,
  );

  return `${header}${bodyLabel}${truncateText(fullPlanText, availableBodyChars)}${footer}`;
}

function buildChunkedFullPlanMessages(args: {
  sessionName: string;
  actionableVersion?: number;
  fullPlanText: string;
  hasButtons: boolean;
}): string[] {
  const { sessionName, actionableVersion, fullPlanText, hasButtons } = args;
  const displaySessionName = formatPlanApprovalSessionName(sessionName);
  let chunkBodyMaxChars = PLAN_APPROVAL_FULL_PLAN_CHUNK_BODY_MAX_CHARS;

  while (chunkBodyMaxChars > 0) {
    const bodyChunks = splitPlanBodyIntoChunks(fullPlanText, chunkBodyMaxChars);
    const messages = bodyChunks.map((body, index) => {
      const total = bodyChunks.length;
      const header = [
        `📋 [${displaySessionName}] Plan v${actionableVersion ?? "?"} ready for approval (${index + 1}/${total}):`,
        "",
        index === 0 ? "Full plan:" : "",
      ].filter(Boolean).join("\n");
      const footer = buildPlanApprovalFooter(hasButtons, index === total - 1);

      return `${header}\n${body}${footer}`;
    });

    const longestMessageLength = messages.reduce((max, message) => Math.max(max, message.length), 0);
    if (longestMessageLength <= PLAN_APPROVAL_FULL_PLAN_CHUNK_MAX_CHARS) {
      return messages;
    }

    const overshoot = longestMessageLength - PLAN_APPROVAL_FULL_PLAN_CHUNK_MAX_CHARS;
    chunkBodyMaxChars -= Math.max(overshoot, 50);
  }

  return [
    buildTruncatedFullPlanFallbackMessage({
      sessionName: displaySessionName,
      actionableVersion,
      fullPlanText,
      hasButtons,
    }),
  ];
}

export function buildPlanReviewSummary(args: {
  preview: string;
  artifact?: PlanArtifact;
}): string {
  const { preview, artifact } = args;
  const fullPlanText = artifact?.markdown?.trim();
  if (fullPlanText && fullPlanText.length <= PLAN_APPROVAL_FULL_PLAN_MAX_CHARS) {
    return `Full plan:\n${fullPlanText}`;
  }

  return buildDeterministicFallbackSummary(fullPlanText || preview);
}

export function buildPlanApprovalPromptContent(args: {
  sessionName: string;
  actionableVersion?: number;
  preview: string;
  artifact?: PlanArtifact;
  hasButtons: boolean;
}): PlanApprovalPromptContent {
  const { sessionName, actionableVersion, preview, artifact, hasButtons } = args;
  const fullPlanText = artifact?.markdown?.trim();
  const displaySessionName = formatPlanApprovalSessionName(sessionName);

  if (fullPlanText) {
    const singleMessage = `📋 [${displaySessionName}] Plan v${actionableVersion ?? "?"} ready for approval:\n\nFull plan:\n${fullPlanText}\n\n${hasButtons ? "Choose Approve, Revise, or Reject below." : "Approval is still pending for this plan version."}`;
    if (singleMessage.length <= PLAN_APPROVAL_FULL_PLAN_MAX_CHARS) {
      return {
        displayMode: "single-full-plan",
        userMessages: [singleMessage],
        reviewSummary: `Full plan:\n${fullPlanText}`,
      };
    }

    return {
      displayMode: "chunked-full-plan",
      userMessages: buildChunkedFullPlanMessages({
        sessionName,
        actionableVersion,
        fullPlanText,
        hasButtons,
      }),
      reviewSummary: buildDeterministicFallbackSummary(fullPlanText),
    };
  }

  const reviewSummary = buildDeterministicFallbackSummary(preview);
  return {
    displayMode: "summary",
    userMessages: [
      `📋 [${displaySessionName}] Plan v${actionableVersion ?? "?"} ready for approval:\n\n${reviewSummary}\n\n${hasButtons ? "Choose Approve, Revise, or Reject below." : "Approval is still pending for this plan version."}`,
    ],
    reviewSummary,
  };
}
