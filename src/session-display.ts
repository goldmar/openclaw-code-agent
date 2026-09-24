import { REASONING_EFFORTS, type ReasoningEffort } from "./types";

/**
 * Model/effort facts for display. `reasoningEffortSupported` is the backend's
 * own report (Claude: system/init effort or supportedModels() levels); when it
 * is known it overrides the static capability tables below.
 */
export type ReasoningDisplayInput = {
  harness?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningEffortSupported?: boolean;
};

export function formatHarnessModelLabel(input: ReasoningDisplayInput): string | undefined {
  const harness = input.harness?.trim();
  const model = input.model?.trim();
  if (harness && model) return `${harness} | ${model}${formatReasoningSuffix(input)}`;
  if (harness) return `${harness} | default`;
  return model;
}

export function formatHarnessModelSuffix(input: ReasoningDisplayInput): string {
  const label = formatHarnessModelLabel(input);
  return label ? ` | ${label}` : "";
}

/**
 * Metadata added to lifecycle headings is atomic: reasoning is useful only when
 * the exact model that consumes it is visible beside it. Existing renderers
 * that intentionally show harness/model without reasoning should continue to
 * use formatHarnessModelLabel/formatHarnessModelSuffix.
 */
export function formatReasoningMetadataSuffix(input: ReasoningDisplayInput): string {
  const harness = input.harness?.trim();
  const model = input.model?.trim();
  const reasoning = formatReasoningSuffix(input);
  if (!harness || !model || !reasoning) return "";
  return ` | ${harness} | ${model}${reasoning}`;
}

/** Only describe a known setting on a model/harness that consumes named effort.
 * Never consult current plugin defaults while rendering historical sessions.
 */
function formatReasoningSuffix(input: ReasoningDisplayInput): string {
  const effort = input.reasoningEffort;
  if (!effort || !REASONING_EFFORTS.includes(effort)) return "";
  if (input.harness === "claude-code" && typeof input.reasoningEffortSupported === "boolean") {
    return input.reasoningEffortSupported ? ` | reasoning: ${effort}` : "";
  }
  // Capability checks use the base ID consistently; display retains the exact ID.
  const model = input.model?.trim().toLowerCase()
    .replace(/^(openai|anthropic)\//, "")
    .replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  if (!model) return "";
  if (input.harness === "codex") {
    // Exclude chat/non-reasoning variants and unknown custom provider models.
    if (!/^(gpt-6-(?:astra|sol)|gpt-5\.6-(sol|terra|luna)|gpt-5(?:\.[1-5])?(?:-codex(?:-max|-mini)?|-mini|-nano)?|o[134](?:-mini)?)$/.test(model)) return "";
    if (effort === "xhigh" && /^(gpt-5(?:-mini|-nano|-codex)?|gpt-5\.1(?:-codex(?:-mini)?)?|o[134](?:-mini)?)$/.test(model)) return "";
    if (effort === "max" && !/^(gpt-6-(?:astra|sol)|gpt-5\.6-(sol|terra|luna))$/.test(model)) return "";
  } else if (input.harness === "claude-code") {
    // Before the backend reports support (launch notices, persisted history),
    // fall back to known model capabilities. Claude Code can silently
    // downgrade unsupported effort levels, so omit those rather than claim the
    // requested level was applied.
    const basic = /^(?:claude-)?(?:opus|sonnet)(?:-4-[678]|-5(?:-5)?)?$/.test(model)
      || /^(?:claude-)?opus-4-5$/.test(model);
    if (!basic || !["low", "medium", "high", "xhigh", "max"].includes(effort)) return "";
    if (effort === "xhigh" && model !== "opus" && !/^(?:claude-)?(?:opus-(?:4-[78]|5(?:-5)?)|sonnet-5)$/.test(model)) return "";
    if (effort === "max" && /opus-4-5/.test(model)) return "";
  } else {
    // OpenCode receives the effort as a model-specific `variant` and silently
    // ignores names the model lacks, so OCA cannot claim it was applied.
    return "";
  }
  return ` | reasoning: ${effort}`;
}

export function hasDisplayableReasoning(input: ReasoningDisplayInput): boolean {
  return Boolean(formatReasoningSuffix(input));
}

/** Enrich only the heading, leaving message bodies, URLs and markup intact. */
export function appendStatusMetadata(text: string, suffix: string): string {
  if (!text || !suffix) return text;
  const newline = text.indexOf("\n");
  const heading = newline < 0 ? text : text.slice(0, newline);
  if (heading.endsWith(suffix)) return text;
  return `${heading}${suffix}${newline < 0 ? "" : text.slice(newline)}`;
}
