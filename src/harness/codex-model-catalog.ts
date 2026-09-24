/**
 * Process-wide cache of the Codex `model/list` catalog.
 *
 * Codex reports, per model, the supported reasoning efforts, the default
 * effort, and the available service tiers. OCA uses that instead of
 * hand-maintained model regex tables. Every Codex connection refreshes it
 * after `initialize` and validates efforts against its own result; this
 * process-wide copy (the most recent refresh) only feeds status rendering.
 * Until the first successful refresh the helpers return `undefined` and
 * callers fall back to conservative behavior.
 */

import type { JsonRpcClient } from "./codex-rpc";
import { codexRequest } from "./codex-protocol";
import type { Model } from "./codex-app-server-protocol/v2/Model";

export interface CodexModelInfo {
  id: string;
  model: string;
  displayName: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
  serviceTiers: string[];
  isDefault: boolean;
  hidden: boolean;
}

const MAX_PAGES = 10;

let catalog: { models: CodexModelInfo[]; fetchedAt: number } | undefined;

function toInfo(model: Model): CodexModelInfo {
  return {
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
    defaultReasoningEffort: model.defaultReasoningEffort,
    serviceTiers: model.serviceTiers.map((tier) => tier.id),
    isDefault: model.isDefault,
    hidden: model.hidden,
  };
}

/**
 * Merge one connection's `model/list` into the process-wide display catalog.
 * Efforts are unioned per model. This union is only a fallback for rendering
 * before a live session reports its own connection's verdict (the harness
 * emits `backend_info.reasoningEffortSupported`, which display prefers).
 */
export function recordCodexModelCatalog(models: Model[], now = Date.now()): void {
  const merged = new Map((catalog?.models ?? []).map((entry) => [entry.id.toLowerCase(), entry]));
  for (const info of models.map(toInfo)) {
    const previous = merged.get(info.id.toLowerCase());
    merged.set(info.id.toLowerCase(), previous
      ? {
          ...info,
          supportedReasoningEfforts: [...new Set([...previous.supportedReasoningEfforts, ...info.supportedReasoningEfforts])],
          serviceTiers: [...new Set([...previous.serviceTiers, ...info.serviceTiers])],
        }
      : info);
  }
  catalog = { models: [...merged.values()], fetchedAt: now };
}

export function hasCodexModelCatalog(): boolean {
  return !!catalog && catalog.models.length > 0;
}

/** Look up a model by catalog id or model slug (case-insensitive). */
export function getCodexModelInfo(model: string | undefined): CodexModelInfo | undefined {
  const wanted = model?.trim().toLowerCase();
  if (!wanted || !catalog) return undefined;
  return catalog.models.find((entry) => entry.id.toLowerCase() === wanted || entry.model.toLowerCase() === wanted);
}

export function getDefaultCodexModelInfo(): CodexModelInfo | undefined {
  return catalog?.models.find((entry) => entry.isDefault);
}

/**
 * Whether Codex accepts `effort` for `model`. `undefined` means the catalog
 * does not know the model (or has not been loaded yet).
 */
export function codexModelSupportsEffort(model: string | undefined, effort: string | undefined): boolean | undefined {
  if (!effort) return undefined;
  const info = getCodexModelInfo(model);
  if (!info) return undefined;
  return info.supportedReasoningEfforts.includes(effort);
}

/** Fetch every `model/list` page and record it. Failures leave the previous catalog in place. */
export async function refreshCodexModelCatalog(client: JsonRpcClient, timeoutMs: number): Promise<CodexModelInfo[]> {
  const models: Model[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await codexRequest(client, "model/list", { cursor, includeHidden: true }, timeoutMs);
    models.push(...response.data);
    cursor = response.nextCursor;
    if (!cursor) break;
  }
  recordCodexModelCatalog(models);
  // Return this connection's own list; the shared catalog is a display union.
  return models.map(toInfo);
}

export function resetCodexModelCatalogForTests(): void {
  catalog = undefined;
}
