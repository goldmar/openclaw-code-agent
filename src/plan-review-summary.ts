import { truncateText } from "./format";
import type { PlanArtifact } from "./types";

const PLAN_APPROVAL_FULL_PLAN_MAX_CHARS = 3_200;
const PLAN_APPROVAL_FULL_PLAN_CHUNK_MAX_CHARS = 3_000;
const PLAN_APPROVAL_FULL_PLAN_CHUNK_BODY_MAX_CHARS = 2_400;
const PLAN_APPROVAL_SESSION_NAME_MAX_CHARS = 120;
const PLAN_APPROVAL_SUMMARY_ITEM_MAX_CHARS = 420;
const PLAN_APPROVAL_APPROACH_MAX_ITEMS = 6;
const PLAN_APPROVAL_AFFECTED_MAX_ITEMS = 6;
const PLAN_APPROVAL_VERIFICATION_MAX_ITEMS = 4;

type DecisionSection =
  | "objective"
  | "approach"
  | "affected"
  | "verification"
  | "effects"
  | "risks"
  | "unknowns";

const DECISION_SECTION_LABELS: Record<DecisionSection, string> = {
  objective: "Objective / scope",
  approach: "Implementation approach",
  affected: "Files / systems affected",
  verification: "Tests / verification",
  effects: "Destructive / external effects",
  risks: "Material risks",
  unknowns: "Unknowns / decisions",
};

export type PlanApprovalPromptContent = {
  displayMode: "chunked-summary" | "summary";
  userMessages: string[];
  reviewSummary: string;
};

function classifyDecisionSection(text: string): DecisionSection | undefined {
  const normalized = text.toLowerCase();
  if (/^(unknowns?|omissions?|assumptions?|open questions?|decisions?)(?:\s*\/[^:]*)?:/.test(normalized)) return "unknowns";
  if (/^(material\s+)?risks?(?:\s*\/[^:]*)?:/.test(normalized)) return "risks";
  if (/^(destructive|irreversible|external)(?:\s*\/[^:]*)?\s*(?:effects?|actions?)?:/.test(normalized)) return "effects";
  if (/^(tests?|verification|validation)(?:\s*\/[^:]*)?:/.test(normalized)) return "verification";
  if (/^(affected\s+)?(?:files?|components?|systems?)(?:\s*\/[^:]*)?:/.test(normalized)) return "affected";
  if (/^(objective|scope|goal|purpose)(?:\s*\/[^:]*)?:/.test(normalized)) return "objective";
  if (/^(implementation|approach|steps?)(?:\s*\/[^:]*)?:/.test(normalized)) return "approach";
  if (/\b(unknown|uncertain|assumption|omission|open question|decision needed|tbd|not specified)\b/.test(normalized)) return "unknowns";
  if (/\b(delete|deletion|remove|drop|overwrite|force[- ]?push|destructive|irreversible|deploy|publish|release|restart|production|external effect|send|notify|purchase|trade)\b/.test(normalized)) return "effects";
  if (/\b(test|verify|verification|validation|lint|typecheck|build|check|proof)\b/.test(normalized)) return "verification";
  if (/\b(risk|hazard|failure mode|danger|caveat)\b/.test(normalized)) return "risks";
  if (/\b(affected|files?\/systems?|components?\/files?)\b/.test(normalized) || /`[^`]+(?:\/[^`]*)?`/.test(text) || /\b[\w.-]+\.(?:ts|tsx|js|jsx|py|md|json|ya?ml|toml|sql)\b/.test(text)) return "affected";
  if (/\b(objective|scope|goal|purpose|outcome|intent)\b/.test(normalized)) return "objective";
  if (/\b(approach|implementation|step|change|update|add|create|refactor|modify|wire|use)\b/.test(normalized)) return "approach";
  return undefined;
}

function stripPlanLinePrefix(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line) || /^[A-Za-z][^.!?]{0,80}:\s*$/.test(line);
}

function pushUnique(target: string[], text: string, preserveFull: boolean = false): void {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return;
  const bounded = preserveFull ? normalized : truncateText(normalized, PLAN_APPROVAL_SUMMARY_ITEM_MAX_CHARS);
  if (!target.some((item) => item.toLowerCase() === bounded.toLowerCase())) target.push(bounded);
}

function buildDecisionGradePlanSummary(args: { preview: string; artifact?: PlanArtifact }): string {
  const source = args.artifact?.markdown?.trim() || args.preview.trim();
  const sections: Record<DecisionSection, string[]> = {
    objective: [], approach: [], affected: [], verification: [], effects: [], risks: [], unknowns: [],
  };
  let activeSection: DecisionSection | undefined;
  let unclassifiedCount = 0;

  if (args.artifact?.explanation?.trim()) pushUnique(sections.objective, args.artifact.explanation);
  for (const step of args.artifact?.steps ?? []) pushUnique(sections.approach, step.step);

  for (const rawLine of source.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const text = stripPlanLinePrefix(trimmed).replace(/:\s*$/, "").trim();
    if (!text || /^(plan|proposed plan|implementation plan)$/i.test(text)) continue;
    if (/^(thinking|checking|considering|analyzing)\b/i.test(text) || /^(should|can|could|would|will)\b.*\?$/i.test(text)) continue;

    if (isHeading(trimmed)) {
      activeSection = classifyDecisionSection(text);
      continue;
    }

    const classified = classifyDecisionSection(text) ?? activeSection;
    if (classified) {
      if (classified === "approach" && (args.artifact?.steps.length ?? 0) > 0) continue;
      pushUnique(sections[classified], text, classified === "effects" || classified === "risks" || classified === "unknowns");
    } else if (sections.objective.length === 0) {
      pushUnique(sections.objective, text);
    } else {
      pushUnique(sections.approach, text);
      unclassifiedCount += 1;
    }
  }

  const approachOmitted = Math.max(0, sections.approach.length - PLAN_APPROVAL_APPROACH_MAX_ITEMS);
  const affectedOmitted = Math.max(0, sections.affected.length - PLAN_APPROVAL_AFFECTED_MAX_ITEMS);
  const verificationOmitted = Math.max(0, sections.verification.length - PLAN_APPROVAL_VERIFICATION_MAX_ITEMS);
  sections.approach = sections.approach.slice(0, PLAN_APPROVAL_APPROACH_MAX_ITEMS);
  sections.affected = sections.affected.slice(0, PLAN_APPROVAL_AFFECTED_MAX_ITEMS);
  sections.verification = sections.verification.slice(0, PLAN_APPROVAL_VERIFICATION_MAX_ITEMS);

  const renderSection = (section: DecisionSection, emptyText: string): string[] => {
    const items = sections[section];
    return [`${DECISION_SECTION_LABELS[section]}:`, ...(items.length ? items.map((item) => `- ${item}`) : [`- ${emptyText}`])];
  };

  const detailNotes: string[] = [];
  if (approachOmitted > 0) detailNotes.push(`${approachOmitted} additional routine implementation step(s)`);
  if (affectedOmitted > 0) detailNotes.push(`${affectedOmitted} additional affected-item detail(s)`);
  if (verificationOmitted > 0) detailNotes.push(`${verificationOmitted} additional verification detail(s)`);
  if (!args.artifact) detailNotes.push("a version-matched structured plan artifact was unavailable; this brief uses the available plan preview");
  if (unclassifiedCount > PLAN_APPROVAL_APPROACH_MAX_ITEMS) detailNotes.push("unclassified plan detail was compacted into the implementation section");

  return [
    ...renderSection("objective", "Not clearly specified in the available plan text."),
    "",
    ...renderSection("approach", "No concrete implementation steps were identified."),
    "",
    ...renderSection("affected", "No specific files, components, or external systems were identified."),
    "",
    ...renderSection("verification", "No verification steps were specified."),
    "",
    ...renderSection("effects", "No destructive or external effect was identified in the plan text."),
    "",
    ...renderSection("risks", "No material risk was identified in the plan text."),
    "",
    ...renderSection("unknowns", "No explicit unknown or user decision was identified in the plan text."),
    ...(detailNotes.length > 0 ? [
      "",
      "Full-plan detail:",
      `- This decision brief does not show ${detailNotes.join("; ")}. Choose Revise and request the complete plan before approving if those details could change your decision.`,
    ] : []),
  ].join("\n");
}

export function formatPlanApprovalSummary(summary: string): string {
  return summary.trim();
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

export function paginatePlanApprovalText(text: string): string[] {
  return splitPlanBodyIntoChunks(text.trim(), PLAN_APPROVAL_FULL_PLAN_CHUNK_BODY_MAX_CHARS);
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

function buildChunkedFullPlanMessages(args: {
  sessionName: string;
  actionableVersion?: number;
  fullPlanText: string;
  hasButtons: boolean;
  heading: string;
}): string[] {
  const { sessionName, actionableVersion, fullPlanText, hasButtons, heading } = args;
  const displaySessionName = formatPlanApprovalSessionName(sessionName);
  let chunkBodyMaxChars = PLAN_APPROVAL_FULL_PLAN_CHUNK_BODY_MAX_CHARS;

  while (chunkBodyMaxChars > 0) {
    const bodyChunks = splitPlanBodyIntoChunks(fullPlanText, chunkBodyMaxChars);
    const messages = bodyChunks.map((body, index) => {
      const total = bodyChunks.length;
      const header = [
        `📋 [${displaySessionName}] Plan v${actionableVersion ?? "?"} ${heading} (${index + 1}/${total}):`,
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

  // Session names are bounded, so this conservative body size always fits. Keep
  // the complete plan even if future header/footer changes defeat rebalancing.
  const bodyChunks = splitPlanBodyIntoChunks(fullPlanText, 100);
  return bodyChunks.map((body, index) => {
    const isLast = index === bodyChunks.length - 1;
    return `📋 [${displaySessionName}] Plan v${actionableVersion ?? "?"} ${heading} (${index + 1}/${bodyChunks.length}):\n${body}${buildPlanApprovalFooter(hasButtons, isLast)}`;
  });
}

export function buildPlanReviewSummary(args: {
  preview: string;
  artifact?: PlanArtifact;
}): string {
  return buildDecisionGradePlanSummary(args);
}

export function buildPlanApprovalPromptContent(args: {
  sessionName: string;
  actionableVersion?: number;
  preview: string;
  artifact?: PlanArtifact;
  hasButtons: boolean;
  escalationRationale?: string;
  heading?: "ready for approval" | "needs your decision";
}): PlanApprovalPromptContent {
  const { sessionName, actionableVersion, preview, artifact, hasButtons, escalationRationale } = args;
  const heading = args.heading ?? "ready for approval";
  const displaySessionName = formatPlanApprovalSessionName(sessionName);
  const planSummary = buildDecisionGradePlanSummary({ preview, artifact });
  const reviewSummary = escalationRationale?.trim()
    ? `Why this was escalated:\n${escalationRationale.trim()}\n\nDecision brief:\n${planSummary}`
    : `Decision brief:\n${planSummary}`;
  const singleMessage = `📋 [${displaySessionName}] Plan v${actionableVersion ?? "?"} ${heading}:\n\n${reviewSummary}\n\n${hasButtons ? "Choose Approve, Revise, or Reject below." : "Approval is still pending for this plan version."}`;
  if (singleMessage.length > PLAN_APPROVAL_FULL_PLAN_MAX_CHARS) {
    return {
      displayMode: "chunked-summary",
      userMessages: buildChunkedFullPlanMessages({
        sessionName,
        actionableVersion,
        fullPlanText: reviewSummary,
        hasButtons,
        heading,
      }),
      reviewSummary,
    };
  }
  return {
    displayMode: "summary",
    userMessages: [singleMessage],
    reviewSummary,
  };
}
