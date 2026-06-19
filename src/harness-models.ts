import { isModelAllowed } from "./model-allowlist";

export function canonicalizeModelForHarness(harness: string, model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (harness !== "codex") return trimmed;

  const [provider, ...modelParts] = trimmed.split("/");
  if (provider?.toLowerCase() === "openai" && modelParts.length === 1 && modelParts[0]?.trim()) {
    return modelParts[0].trim();
  }
  return trimmed;
}

function isCodexModelAllowed(model: string | undefined, allowedModels: string[] | undefined): boolean {
  if (!allowedModels || allowedModels.length === 0) return true;
  if (!model) return false;
  const modelLower = model.toLowerCase();
  return allowedModels.some((allowed) => {
    const canonicalAllowed = canonicalizeModelForHarness("codex", allowed);
    return canonicalAllowed?.toLowerCase() === modelLower;
  });
}

export function isModelAllowedForHarness(
  harness: string,
  model: string | undefined,
  allowedModels: string[] | undefined,
): boolean {
  return harness === "codex"
    ? isCodexModelAllowed(model, allowedModels)
    : isModelAllowed(model, allowedModels);
}

export function isModelFormatSupportedForHarness(harness: string, model: string | undefined): boolean {
  if (harness !== "codex" || !model) return true;
  return !model.includes("/");
}

export function canonicalAllowedModelForHarness(
  harness: string,
  model: string | undefined,
  allowedModels: string[] | undefined,
): string | undefined {
  if (harness !== "codex" || !model || !allowedModels || allowedModels.length === 0) return model;
  const modelLower = model.toLowerCase();
  const matched = allowedModels.find((allowed) => {
    const canonicalAllowed = canonicalizeModelForHarness("codex", allowed);
    return canonicalAllowed?.toLowerCase() === modelLower;
  });
  return canonicalizeModelForHarness("codex", matched) ?? model;
}
