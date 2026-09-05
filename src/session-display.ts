import { REASONING_EFFORTS, type ReasoningEffort } from "./types";

export function formatHarnessModelLabel(input: {
  harness?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): string | undefined {
  const harness = input.harness?.trim();
  const model = input.model?.trim();
  if (harness && model) return `${harness} | ${model}${formatReasoningSuffix(input)}`;
  if (harness) return `${harness} | default`;
  return model;
}

export function formatHarnessModelSuffix(input: {
  harness?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): string {
  const label = formatHarnessModelLabel(input);
  return label ? ` | ${label}` : "";
}

/** Only describe a known setting on a model/harness that consumes named effort.
 * Never consult current plugin defaults while rendering historical sessions.
 */
export function formatReasoningSuffix(input: {
  harness?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): string {
  const effort = input.reasoningEffort;
  if (!effort || !REASONING_EFFORTS.includes(effort)) return "";
  const model = input.model?.trim().toLowerCase().replace(/^(openai|anthropic)\//, "");
  if (!model) return "";
  if (input.harness === "codex") {
    // Exclude chat/non-reasoning variants and unknown custom provider models.
    if (!/^(gpt-6-astra|gpt-5\.6-(sol|terra|luna)|gpt-5(?:\.[1-5])?(?:-codex(?:-max|-mini)?|-mini|-nano)?|o[134](?:-mini)?)(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return "";
    if (effort === "xhigh" && /^(gpt-5(?:-mini|-nano|-codex)?|gpt-5\.1(?:-codex(?:-mini)?)?|o[134](?:-mini)?)$/.test(model)) return "";
    if (effort === "max" && !/^(gpt-6-astra|gpt-5\.6-(sol|terra|luna))$/.test(model)) return "";
  } else if (input.harness === "claude-code") {
    // Claude Code can silently downgrade unsupported effort levels. Omit those
    // rather than claim the requested level was applied by the backend.
    const basic = /^(?:claude-)?(?:opus|sonnet)(?:-4-[678]|-5)?(?:-\d{8})?$/.test(model)
      || /^(?:claude-)?opus-4-5(?:-\d{8})?$/.test(model);
    if (!basic || !["low", "medium", "high", "xhigh", "max"].includes(effort)) return "";
    if (effort === "xhigh" && !/^(?:claude-)?(?:opus-(?:4-[78]|5)|sonnet-5)$/.test(model)) return "";
    if (effort === "max" && /opus-4-5/.test(model)) return "";
  } else {
    // OpenCode currently does not forward OCA's reasoningEffort option.
    return "";
  }
  return ` | reasoning: ${effort}`;
}

/** Enrich only the heading, leaving message bodies, URLs and markup intact. */
export function appendReasoningToStatus(text: string, suffix: string): string {
  if (!text || !suffix) return text;
  const newline = text.indexOf("\n");
  const heading = newline < 0 ? text : text.slice(0, newline);
  if (heading.endsWith(suffix)) return text;
  return `${heading}${suffix}${newline < 0 ? "" : text.slice(newline)}`;
}
