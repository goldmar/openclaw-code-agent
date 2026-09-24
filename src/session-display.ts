import { codexModelSupportsEffort, hasCodexModelCatalog } from "./harness/codex-model-catalog";
import { REASONING_EFFORTS, type ReasoningEffort } from "./types";

const CODEX_UNIVERSAL_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high"]);

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

/**
 * Metadata added to lifecycle headings is atomic: reasoning is useful only when
 * the exact model that consumes it is visible beside it. Existing renderers
 * that intentionally show harness/model without reasoning should continue to
 * use formatHarnessModelLabel/formatHarnessModelSuffix.
 */
export function formatReasoningMetadataSuffix(input: {
  harness?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): string {
  const harness = input.harness?.trim();
  const model = input.model?.trim();
  const reasoning = formatReasoningSuffix(input);
  if (!harness || !model || !reasoning) return "";
  return ` | ${harness} | ${model}${reasoning}`;
}

/** Only describe a known setting on a model/harness that consumes named effort.
 * Never consult current plugin defaults while rendering historical sessions.
 */
function formatReasoningSuffix(input: {
  harness?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): string {
  const effort = input.reasoningEffort;
  if (!effort || !REASONING_EFFORTS.includes(effort)) return "";
  // Capability checks use the base ID consistently; display retains the exact ID.
  const model = input.model?.trim().toLowerCase()
    .replace(/^(openai|anthropic)\//, "")
    .replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  if (!model) return "";
  if (input.harness === "codex") {
    // Codex's model/list catalog is authoritative: omit efforts it rejects and
    // models it does not list. Before any Codex session has loaded the catalog,
    // only claim the levels every Codex reasoning model accepts.
    if (hasCodexModelCatalog()) {
      if (codexModelSupportsEffort(model, effort) !== true) return "";
    } else if (!CODEX_UNIVERSAL_EFFORTS.has(effort)) {
      return "";
    }
  } else if (input.harness === "claude-code") {
    // Claude Code can silently downgrade unsupported effort levels. Omit those
    // rather than claim the requested level was applied by the backend.
    const basic = /^(?:claude-)?(?:opus|sonnet)(?:-4-[678]|-5(?:-5)?)?$/.test(model)
      || /^(?:claude-)?opus-4-5$/.test(model);
    if (!basic || !["low", "medium", "high", "xhigh", "max"].includes(effort)) return "";
    if (effort === "xhigh" && model !== "opus" && !/^(?:claude-)?(?:opus-(?:4-[78]|5(?:-5)?)|sonnet-5)$/.test(model)) return "";
    if (effort === "max" && /opus-4-5/.test(model)) return "";
  } else {
    // OpenCode currently does not forward OCA's reasoningEffort option.
    return "";
  }
  return ` | reasoning: ${effort}`;
}

export function hasDisplayableReasoning(input: {
  harness?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}): boolean {
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
