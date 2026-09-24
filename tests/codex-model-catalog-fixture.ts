import { recordCodexModelCatalog } from "../src/harness/codex-model-catalog";
import type { Model } from "../src/harness/codex-app-server-protocol/v2/Model";

/** Reasoning efforts reported by `model/list` on Codex 0.156.1 (2026-09-23). */
const CATALOG: Array<[string, string[], string]> = [
  ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max", "ultra"], "medium"],
  ["gpt-6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"], "medium"],
  ["gpt-6-luna", ["low", "medium", "high", "xhigh", "max"], "medium"],
  ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"], "low"],
  ["gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max", "ultra"], "medium"],
  ["gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"], "medium"],
  ["gpt-5.5", ["low", "medium", "high", "xhigh"], "medium"],
];

export function codexCatalogModel(id: string, efforts: string[], defaultEffort = "medium"): Model {
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: id,
    description: "",
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: "" })),
    defaultReasoningEffort: defaultEffort,
    inputModalities: [],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [{ id: "priority", name: "Fast", description: "" }],
    defaultServiceTier: null,
    availableAccessPrograms: null,
    isDefault: id === "gpt-6-astra",
  };
}

export function seedCodexModelCatalog(): void {
  recordCodexModelCatalog(CATALOG.map(([id, efforts, defaultEffort]) => codexCatalogModel(id, efforts, defaultEffort)));
}
