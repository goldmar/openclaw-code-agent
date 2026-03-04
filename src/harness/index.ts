/**
 * Harness registry — import this module to access any registered agent harness.
 */

import type { AgentHarness } from "./types";
import { ClaudeCodeHarness } from "./claude-code";
import { CodexHarness } from "./codex";
import { pluginConfig } from "../config";

const registry = new Map<string, AgentHarness>();

export function registerHarness(harness: AgentHarness): void {
  registry.set(harness.name, harness);
}

export function getHarness(name: string): AgentHarness {
  const h = registry.get(name);
  if (!h) {
    throw new Error(
      `Unknown agent harness: "${name}". Available: ${[...registry.keys()].join(", ")}`,
    );
  }
  return h;
}

export function getDefaultHarness(): AgentHarness {
  const name = pluginConfig.defaultHarness ?? "claude-code";
  return getHarness(name);
}

export function listHarnesses(): string[] {
  return [...registry.keys()];
}

// Register built-in harnesses
registerHarness(new ClaudeCodeHarness());
registerHarness(new CodexHarness());

// Re-export types for convenience
export type {
  AgentHarness,
  HarnessSession,
  HarnessMessage,
  HarnessResult,
  HarnessLaunchOptions,
} from "./types";
