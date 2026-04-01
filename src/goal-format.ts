import type { GoalTaskState } from "./types";

export interface GoalTaskRuntimeSnapshot {
  phase?: string;
  awaitingInput?: boolean;
  latestOutput?: string;
}

function indentBlock(text: string, prefix: string): string[] {
  return text.split("\n").map((line) => `${prefix}${line}`);
}

function summarizeOutput(lines: string[], maxLines: number = 8, maxChars: number = 600): string | undefined {
  const nonEmpty = lines
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return undefined;

  const selected = nonEmpty.slice(-maxLines).join("\n");
  if (selected.length <= maxChars) return selected;
  return `...${selected.slice(-(maxChars - 3))}`;
}

export function buildGoalTaskRuntimeSnapshot(session: {
  phase?: string;
  isAwaitingInput?: boolean;
  pendingInputState?: unknown;
  getOutput(lines?: number): string[];
} | undefined): GoalTaskRuntimeSnapshot | undefined {
  if (!session) return undefined;

  return {
    phase: session.phase,
    awaitingInput: session.isAwaitingInput ?? Boolean(session.pendingInputState),
    latestOutput: summarizeOutput(session.getOutput(20)),
  };
}

export function formatGoalTask(task: GoalTaskState, runtime?: GoalTaskRuntimeSnapshot): string {
  const loopMode = task.loopMode ?? "verifier";
  const lines = [
    `${task.name} [${task.id}]`,
    `  Status: ${task.status}`,
    ...(loopMode === "ralph"
      ? [`  Loop mode: ralph`, `  Iteration: ${task.iteration}/${task.maxIterations}`]
      : [`  Repair iteration: ${task.iteration}/${task.maxIterations}`]),
    `  Workdir: ${task.workdir}`,
  ];

  if (loopMode === "ralph" && task.completionPromise) {
    lines.push(`  Completion promise: ${task.completionPromise}`);
  }

  if (task.sessionId) {
    lines.push(`  Session: ${task.sessionName ?? "(unknown)"} [${task.sessionId}]`);
  }
  if (runtime?.phase) {
    lines.push(`  Phase: ${runtime.phase}`);
  }
  if (runtime?.awaitingInput !== undefined) {
    lines.push(`  Awaiting input: ${runtime.awaitingInput ? "yes" : "no"}`);
  }
  if (task.lastVerifierSummary) {
    lines.push(`  Last verifier:`);
    lines.push(...indentBlock(task.lastVerifierSummary, "    "));
  }
  if (runtime?.latestOutput) {
    lines.push(`  Latest activity:`);
    lines.push(...indentBlock(runtime.latestOutput, "    "));
  }
  if (task.waitingForUserReason) {
    lines.push(`  Waiting on user: ${task.waitingForUserReason}`);
  }
  if (task.failureReason) {
    lines.push(`  Failure: ${task.failureReason}`);
  }

  return lines.join("\n");
}
