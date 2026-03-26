/**
 * Heuristics for detecting whether the latest model text is waiting on user input.
 *
 * This is intentionally conservative: false negatives are preferred over false
 * positives to avoid spurious wake/notify cycles.
 */
const ACTION_VERBS = [
  "proceed",
  "continue",
  "implement",
  "apply",
  "run",
  "merge",
  "deploy",
  "commit",
];

const POSITIVE_PATTERNS = [
  "shall i proceed",
  "do you want me to",
  "would you like me to",
  "please confirm",
  "should i continue",
  "can i proceed",
  "should i proceed",
  "should i go ahead",
  "want me to continue",
  "approve and i'll",
  "confirm and i'll",
];

const NEGATIVE_PATTERNS = [
  "why this failed was",
  "why did this fail",
  "what failed",
  "what happened",
  "how can i help",
  "is this clear",
  "any questions",
  "anything else",
  "let me know",
  "would you like a summary",
];

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const PLAN_ONLY_PROMPT_PATTERNS = [
  "plan only",
  "planning only",
  "do not implement yet",
  "don't implement yet",
  "do not implement",
  "don't implement",
  "stop after the plan",
  "stop after planning",
  "wait for approval",
  "ask before implementing",
  "provide a plan",
  "produce a plan",
  "write a plan",
  "implementation plan",
];

const PLAN_OUTPUT_KEYWORDS_RE =
  /\b(plan|implementation plan|approach|next steps|step 1|phase 1|findings|root cause|investigation)\b/i;

const PLAN_OUTPUT_INTRO_RE =
  /\b(here(?:'s| is)|below is|proposed|recommended|concise|high-level)\b.{0,40}\b(plan|approach|next steps)\b/i;

function structuredPlanLineCount(text: string): number {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(\d+[.)]|[-*])\s+\S+/.test(line))
    .length;
}

/** Return true when text likely asks for explicit user action/approval. */
export function looksLikeWaitingForUser(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;

  // Guard 1: known rhetorical/status phrasings that end with "?" but are not
  // blocking questions requiring user approval/decision.
  if (NEGATIVE_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return false;
  }

  const hasActionVerb = ACTION_VERBS.some((verb) => normalized.includes(verb));

  // Guard 2: direct approval/request templates. We still require an action verb
  // (or explicit "confirm") to avoid over-triggering on vague confirmations.
  if (POSITIVE_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return hasActionVerb || normalized.includes("confirm");
  }

  // Guard 3: generic question fallback is intentionally strict to prefer false
  // negatives over false positives.
  if (!normalized.endsWith("?")) {
    return false;
  }

  return hasActionVerb;
}

/** Return true when the original prompt explicitly asked for planning only. */
export function looksLikePlanOnlyPrompt(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  return PLAN_ONLY_PROMPT_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/** Return true when the assistant output looks like a plan rather than a final answer. */
export function looksLikePlanOutput(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;

  const structuredLines = structuredPlanLineCount(text);
  const hasPlanKeywords = PLAN_OUTPUT_KEYWORDS_RE.test(normalized);
  const hasPlanIntro = PLAN_OUTPUT_INTRO_RE.test(text);
  const hasStepSequence = /\b(step 1|first,|first step|next steps)\b/i.test(text);

  return hasPlanIntro || hasStepSequence || (hasPlanKeywords && structuredLines >= 2);
}

/** Return true when output both looks like a plan and asks whether to continue. */
export function looksLikePlanApprovalRequest(text: string): boolean {
  return looksLikePlanOutput(text) && looksLikeWaitingForUser(text);
}
