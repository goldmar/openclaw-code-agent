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
