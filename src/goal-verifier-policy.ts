import { pluginConfig } from "./config";
import type { GoalTaskState, GoalVerifierSpec } from "./types";

const CONFIG_ERROR = "Invalid requiredGoalVerifierCommands: configure a non-empty array of non-blank shell commands, or remove the setting for new goals.";
const SELECTION_ERROR = "Goal verifiers must match the complete ordered requiredGoalVerifierCommands suite. Omit verifier commands to use the operator's suite, or supply that exact suite.";

export function requiredGoalVerifierCommands(): string[] | undefined {
  const raw: unknown = pluginConfig.requiredGoalVerifierCommands;
  if (raw === undefined) return undefined;
  return commandStrings(raw, CONFIG_ERROR);
}

function commandStrings(raw: unknown, reason: string): string[] {
  const entries: unknown[] | undefined = Array.isArray(raw) ? Array.from(raw) : undefined;
  if (!entries || entries.length === 0 || entries.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(reason);
  }
  return (entries as string[]).map((entry) => entry.trim());
}

function sameCommands(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (typeof left[index] !== "string" || left[index] !== right[index]) return false;
  }
  return true;
}

export function resolveRequiredGoalSelection(commands: unknown): string[] | undefined {
  const required = requiredGoalVerifierCommands();
  if (!required) return undefined;
  if (commands !== undefined && !sameCommands(commandStrings(commands, SELECTION_ERROR), required)) {
    throw new Error(SELECTION_ERROR);
  }
  return required;
}

/** Validate BEFORE compatibility normalization can discard blank/malformed entries. */
export function verifierSpecCommands(specs: unknown): string[] {
  const entries = Array.isArray(specs) ? Array.from(specs) : undefined;
  if (!entries || entries.length === 0 || entries.some((spec) => !spec
    || typeof spec !== "object" || typeof spec.label !== "string" || typeof spec.command !== "string"
    || !spec.command.trim())) throw new Error(SELECTION_ERROR);
  return entries.map((spec: GoalVerifierSpec) => spec.command.trim());
}

/** Returns a binding to establish on an active legacy task, never substitutes checks. */
export function validateGoalVerifierPolicy(task: Pick<GoalTaskState, "verifierCommands" | "requiredVerifierCommands">): string[] | undefined {
  const current = requiredGoalVerifierCommands();
  const binding = task.requiredVerifierCommands === undefined ? undefined
    : commandStrings(task.requiredVerifierCommands, "Invalid stored required verifier binding. Start a new goal; the original evidence is preserved.");
  if (!current && !binding) return undefined;
  const selected = verifierSpecCommands(task.verifierCommands);
  if ((binding && !sameCommands(selected, binding)) || (current && !sameCommands(selected, current))
    || (current && binding && !sameCommands(current, binding))) {
    throw new Error("Goal verifier policy changed or its stored suite does not match. Start a new goal with the complete operator-required suite; stored checks are not replaced.");
  }
  return binding ?? current;
}
