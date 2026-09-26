import { truncateText } from "./format";
import type { PlanArtifact } from "./types";

const PLAN_APPROVAL_FULL_PLAN_MAX_CHARS = 3_200;
const PLAN_APPROVAL_FULL_PLAN_CHUNK_MAX_CHARS = 3_000;
const PLAN_APPROVAL_FULL_PLAN_CHUNK_BODY_MAX_CHARS = 2_400;
const PLAN_APPROVAL_SESSION_NAME_MAX_CHARS = 120;
const PLAN_APPROVAL_APPROACH_MAX_ITEMS = 6;

type DecisionSection =
  | "objective"
  | "approach"
  | "affected"
  | "verification"
  | "effects"
  | "risks"
  | "unknowns"
  | "costs"
  | "rollback";

const DECISION_SECTION_LABELS: Record<DecisionSection, string> = {
  objective: "Objective / scope",
  approach: "Implementation approach",
  affected: "Files / systems affected",
  verification: "Tests / verification",
  effects: "Destructive / external effects",
  risks: "Material risks",
  unknowns: "Unknowns / decisions",
  costs: "Costs / resources",
  rollback: "Rollback / recovery",
};

export type PlanApprovalPromptContent = {
  displayMode: "chunked-summary" | "summary";
  userMessages: string[];
  reviewSummary: string;
};

function classifyDecisionSection(text: string): DecisionSection | undefined {
  const normalized = text.toLowerCase();
  if (/\b(rollback|roll back|revert|restore|recovery)\b/.test(normalized)) return "rollback";
  if (/\?\s*$/.test(normalized)) return "unknowns";
  if (/^budget:|\b(costs?|billing|paid|pricing|spend|charges?)\b|[$€£]\s*\d/.test(normalized)) return "costs";
  if (/^(unknowns?|omissions?|assumptions?|open questions?|decisions?|choices?|alternatives?|options?)(?:\s*\/[^:]*)?:/.test(normalized)) return "unknowns";
  if (/^(material\s+)?risks?(?:\s*\/[^:]*)?:/.test(normalized)) return "risks";
  if (/^(destructive|irreversible|external)(?:\s*\/[^:]*)?\s*(?:effects?|actions?)?:/.test(normalized)) return "effects";
  if (/^(tests?|verification|validation)(?:\s*\/[^:]*)?:/.test(normalized)) return "verification";
  if (/^(affected\s+)?(?:files?|components?|systems?)(?:\s*\/[^:]*)?:/.test(normalized)) return "affected";
  if (/^(objective|scope|goal|purpose)(?:\s*\/[^:]*)?:/.test(normalized)) return "objective";
  if (/\b(unknown|uncertain|assumption|omission|open question|choose|choices?|alternatives?|options?|decision needed|tbd|not specified)\b/.test(normalized)) return "unknowns";
  if (/\b(delete|deletion|remove|drop|overwrite|force[- ]?push|rm|truncate|credentials?|secrets?|migrate|destructive|irreversible|deploy|publish|release|restart|production|external effect|send|notify|purchase|trade)\b/.test(normalized)) return "effects";
  if (/\b(risk|hazard|failure mode|danger|caveat)\b/.test(normalized)) return "risks";
  if (/\b(objective|scope|goal|purpose|outcome|intent)\b/.test(normalized)) return "objective";
  if (/\b(tests?|verify|verification|validation|lint|typecheck|build|checks?|proof)\b/.test(normalized)) return "verification";
  if (/\b(affected|files?\/systems?|components?\/files?)\b/.test(normalized) || /`[^`]+(?:\/[^`]*)?`/.test(text) || /\b[\w.-]+\.(?:ts|tsx|js|jsx|py|md|json|ya?ml|toml|sql)\b/.test(text)) return "affected";
  if (/^(implementation(?: approach| steps)?|approach|steps?(?: \d+)?)(?:\s*\/[^:]*)?:/.test(normalized)) return "approach";
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

// Normalize plan-local Markdown before extraction, including tables that may
// already have acquired a list prefix. Plain fields work on every chat channel.
function cleanInline(text: string): string {
  // Code spans are literal: emphasis cleanup must not rewrite identifiers such
  // as `__init__` or glob expressions inside them.
  return text.split(/(`+[^`]*`+)/g).map((part, index) => index % 2 ? part : part
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)__([^_]+)__(?=\s|$|:)/g, "$1$2"))
    .join("").trim();
}

function isHeading(line: string): boolean {
  const text = cleanInline(stripPlanLinePrefix(line));
  return /^#{1,6}\s+/.test(line) || /^[A-Za-z][^.!?]{0,80}:\s*$/.test(text);
}

function normalizePlanLines(source: string): string[] {
  const lines = source.split("\n");
  const result: string[] = [];
  const cells = (line: string): string[] => cleanInline(stripPlanLinePrefix(line))
    .replace(/^•\s*/, "").replace(/^\|/, "").replace(/\|$/, "")
    .split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const next = lines[index + 1];
    const fence = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      // A fenced code block is one literal item: its lines are not headings or
      // fields. It joins the line that introduced it ("…to add:") as inline code.
      const code: string[] = [];
      while (index + 1 < lines.length && !lines[index + 1]!.trim().startsWith(fence)) {
        const codeLine = lines[++index]!.trim();
        if (codeLine) code.push(codeLine);
      }
      index += 1; // the closing fence (or the end of the plan)
      if (code.length === 0) continue;
      const inline = formatInlineCode(code);
      const previous = result.length ? result[result.length - 1]! : "";
      if (previous.trim() && !isHeading(previous)) result[result.length - 1] = `${previous.trimEnd()} ${inline}`;
      else result.push(`- ${inline}`);
      continue;
    }
    if (line.includes("|") && next && cells(next).every((cell) => /^:?-+:?$/.test(cell))) {
      const headers = cells(line);
      index += 1;
      while (index + 1 < lines.length && lines[index + 1]!.includes("|")) {
        const row = cells(lines[++index]!);
        const fields = row.flatMap((value, column) => value ? [`${headers[column] || `Field ${column + 1}`}: ${value}`] : []);
        if (fields.length) result.push(`- ${fields.join("; ")}`);
      }
    } else {
      result.push(cleanInline(line));
    }
  }
  return result;
}

/** A fenced block longer than this is not folded into the brief: the plan is shown itself. */
const PLAN_INLINE_CODE_MAX_CHARS = 160;

/** One code block as one inline code span: `def f(a): return a` or `a; b`. */
function formatInlineCode(lines: string[]): string {
  const content = joinCodeLines(lines);
  const delimiter = "`".repeat(Math.max(1, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length + 1)));
  return `${delimiter}${content}${delimiter}`;
}

function joinCodeLines(lines: string[]): string {
  let text = "";
  for (const line of lines) {
    text = !text ? line : /[:{(,[]$/.test(text) ? `${text} ${line}` : `${text}; ${line}`;
  }
  return text;
}

/**
 * Multiline code, code with backticks, and long blocks stay verbatim. Joining
 * lines or changing backtick quoting can change an executable command's
 * meaning, and clipping a block can hide a material command.
 */
function requiresVerbatimFencedBlock(source: string): boolean {
  let fence: string | undefined;
  let code: string[] = [];
  for (const line of source.split("\n")) {
    const opener = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence) {
      if (opener) {
        fence = opener;
        code = [];
      }
      continue;
    }
    if (line.trim().startsWith(fence)) {
      if (code.length > 1 || code.some((item) => item.includes("`")) || joinCodeLines(code).length > PLAN_INLINE_CODE_MAX_CHARS) return true;
      fence = undefined;
      continue;
    }
    if (line.trim()) code.push(line.trim());
  }
  return fence !== undefined && (code.length > 1 || code.some((item) => item.includes("`")) || joinCodeLines(code).length > PLAN_INLINE_CODE_MAX_CHARS);
}

function pushUnique(target: string[], text: string): void {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return;
  if (!target.some((item) => item.toLowerCase() === normalized.toLowerCase())) target.push(normalized);
}

type PlanSummary = { text: string; verbatim: boolean };

function buildDecisionGradePlanSummary(args: { preview: string; artifact?: PlanArtifact; detailRef?: string }): PlanSummary {
  const source = args.artifact?.markdown?.trim() || args.preview.trim();
  const sections: Record<DecisionSection, string[]> = {
    objective: [], approach: [], affected: [], verification: [], effects: [], risks: [], unknowns: [], costs: [], rollback: [],
  };
  let activeSection: DecisionSection | undefined;
  let unclassifiedCount = 0;
  // Under a Markdown section heading that maps to no brief field ("## Current
  // file", "## Commit"), lines are not fields: the brief would mislabel them.
  let underUnmappedHeading = false;
  let unmappedLines = 0;
  let seenBody = false;

  if (args.artifact?.explanation?.trim()) pushUnique(sections.objective, formatPlanApprovalSummary(args.artifact.explanation));
  for (const step of args.artifact?.steps ?? []) {
    const text = formatPlanApprovalSummary(step.step);
    const section = classifyDecisionSection(text) ?? "approach";
    pushUnique(sections[section], text);
  }

  for (const rawLine of normalizePlanLines(source)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const text = stripPlanLinePrefix(trimmed);
    if (!text || /^(plan|proposed plan|implementation plan|decision brief):?$/i.test(text)) continue;
    if (/^(thinking|checking|considering|analyzing)\b/i.test(text) || /^(should|can|could|would|will) (?:i|we) (?:proceed|continue|start)\?$/i.test(text)) continue;

    if (isHeading(trimmed)) {
      activeSection = classifyDecisionSection(`${text.replace(/:\s*$/, "")}:`);
      // A leading `# Title` is the plan's name, not a section.
      const isTitle = /^#\s/.test(trimmed) && !seenBody;
      underUnmappedHeading = !activeSection && /^#{1,6}\s/.test(trimmed) && !isTitle;
      continue;
    }
    seenBody = true;
    if (underUnmappedHeading) {
      unmappedLines += 1;
      continue;
    }

    const inferred = classifyDecisionSection(text);
    // An explicit risk/cost/scope heading governs its body even when that body
    // mentions a file or a test. Those incidental words must not hide decisions.
    const materialSections: DecisionSection[] = ["objective", "effects", "risks", "unknowns", "costs", "rollback"];
    const classified = activeSection && materialSections.includes(activeSection)
      ? activeSection : inferred ?? activeSection;
    if (classified) {
      pushUnique(sections[classified], text);
    } else if (sections.objective.length === 0) {
      pushUnique(sections.objective, text);
    } else {
      pushUnique(sections.approach, text);
      unclassifiedCount += 1;
    }
  }

  let routineCount = 0;
  let approachOmitted = 0;
  sections.approach = sections.approach.filter((item) => {
    // Converted table rows retain every field, including choices after the
    // first column. They must not be treated as expendable routine steps.
    if (item.includes("; ")) return true;
    if (++routineCount <= PLAN_APPROVAL_APPROACH_MAX_ITEMS) return true;
    approachOmitted += 1;
    return false;
  });

  const renderSection = (section: DecisionSection): string[] => {
    const items = sections[section];
    return items.length ? [`${DECISION_SECTION_LABELS[section]}: ${items[0]}`, ...items.slice(1).map((item) => `- ${item}`)] : [];
  };

  const detailNotes: string[] = [];
  // N42: only say what was left out; whether a structured plan artifact existed is not the user's concern.
  if (approachOmitted > 0) detailNotes.push(`${approachOmitted} more routine step${approachOmitted === 1 ? "" : "s"} not shown`);
  if (unclassifiedCount > PLAN_APPROVAL_APPROACH_MAX_ITEMS) detailNotes.push("some detail was condensed");

  const detailAction = args.detailRef && /^[a-zA-Z0-9_-]+$/.test(args.detailRef)
    ? `Full plan: /agent_output ${args.detailRef} --full`
    : "Reply asking for the full plan to see everything.";

  if (unmappedLines > 0 || requiresVerbatimFencedBlock(source)) {
    // The plan does not map cleanly onto the brief (a section with no brief
    // field, or code too long for one line): show the plan itself.
    // The approval controls can appear after paginated messages. Keep the
    // complete source so a late effect or command remains visible before the
    // user decides.
    return { text: source, verbatim: true };
  }

  const brief = [
    ...renderSection("objective"),
    "",
    ...renderSection("approach"),
    "",
    ...renderSection("affected"),
    "",
    ...renderSection("verification"),
    "",
    ...renderSection("effects"),
    "",
    ...renderSection("risks"),
    "",
    ...renderSection("unknowns"),
    "",
    ...renderSection("costs"),
    "",
    ...renderSection("rollback"),
    ...(detailNotes.length > 0 ? [
      "",
      `(${detailNotes.join("; ")}. ${detailAction})`,
    ] : []),
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim() || "Plan context: No concrete plan content was available. Request the complete plan before deciding.";
  return { text: brief, verbatim: false };
}

export function formatPlanApprovalSummary(summary: string): string {
  const result: string[] = [];
  let heading: string | undefined;
  for (const line of normalizePlanLines(summary)) {
    if (isHeading(line)) {
      heading = stripPlanLinePrefix(line).replace(/:$/, "");
    } else if (line.trim()) {
      result.push(heading ? `${heading}: ${stripPlanLinePrefix(line)}` : line);
      heading = undefined;
    } else if (!heading && result.length) {
      result.push("");
    }
  }
  return result.join("\n").trim();
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
  // Keep heading chains with the first body item, even for oversized items.
  const lines = text.split("\n");
  const units: string[] = [];
  let headings: string[] = [];
  for (const line of lines) {
    if (isHeading(line.trim()) || line.trim() === "Decision brief" || line.trim() === "Plan") {
      headings.push(line);
    } else if (line.trim()) {
      units.push([...headings, line].join("\n"));
      headings = [];
    } else if (!headings.length && units.length) {
      units[units.length - 1] += "\n";
    }
  }
  const chunks: string[] = [];
  let current = "";
  const pushCurrent = (): void => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const unit of units) {
    const parts = unit.length > maxChars ? splitLongLine(unit, maxChars) : [unit];
    for (const part of parts) {
      const candidate = current ? `${current}\n${part}` : part;
      if (candidate.length > maxChars) pushCurrent();
      current = current ? `${current}\n${part}` : part;
    }
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
      const header = `📋 [${displaySessionName}] Plan v${actionableVersion ?? "?"} ${heading} (${index + 1}/${total})`;
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
  return buildDecisionGradePlanSummary(args).text;
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
  const planSummary = buildDecisionGradePlanSummary({ preview, artifact, detailRef: sessionName });
  const summaryHeading = planSummary.verbatim ? "Plan" : "Decision brief";
  const rationale = formatPlanApprovalSummary(escalationRationale ?? "");
  const reviewSummary = rationale
    ? `Why this was escalated: ${rationale}\n\n${summaryHeading}\n${planSummary.text}`
    : `${summaryHeading}\n${planSummary.text}`;
  const singleMessage = `📋 [${displaySessionName}] Plan v${actionableVersion ?? "?"} ${heading}\n\n${reviewSummary}\n\n${hasButtons ? "Choose Approve, Revise, or Reject below." : "Approval is still pending for this plan version."}`;
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
