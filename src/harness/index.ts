/**
 * Harness registry — import this module to access any registered agent harness.
 */

import type { AgentHarness } from "./types";
import { ClaudeCodeHarness } from "./claude-code";

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
  return getHarness("claude-code");
}

export function listHarnesses(): string[] {
  return [...registry.keys()];
}

// Register built-in harnesses
registerHarness(new ClaudeCodeHarness());

// Re-export types for convenience
export type {
  AgentHarness,
  HarnessSession,
  HarnessMessage,
  HarnessResult,
  HarnessLaunchOptions,
} from "./types";
