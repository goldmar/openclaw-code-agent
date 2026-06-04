import type { GoalTaskState } from "./types";

export interface GoalTaskRuntimeSnapshot {
  phase?: string;
  awaitingInput?: boolean;
  latestOutput?: string;
}

export interface GoalIterationSummaryInput {
  output?: string;
  verifierSummary?: string;
  completionPromise?: string;
  completionDetected?: boolean;
}

function indentBlock(text: string, prefix: string): string[] {
  return text.split("\n").map((line) => `${prefix}${line}`);
}

function truncateLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
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

function summarizeOutputBullets(output: string | undefined, completionPromise: string | undefined): string[] {
  const promise = completionPromise?.trim();
  const nonEmpty = (output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter((line) => line.length > 0)
    .filter((line) => !(promise && line === promise))
    .filter((line) => !/^<promise>.*<\/promise>$/.test(line));

  if (nonEmpty.length === 0) return [];

  return nonEmpty
    .slice(-3)
    .map((line) => truncateLine(line, 180));
}

function summarizeVerifierBullets(verifierSummary: string | undefined): string[] {
  const lines = (verifierSummary ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return [];

  return lines.slice(0, 2).map((line) => truncateLine(line, 180));
}

export function buildGoalIterationSummary(input: GoalIterationSummaryInput): string | undefined {
  const bullets: string[] = [];
  const verifierBullets = summarizeVerifierBullets(input.verifierSummary);
  const outputBullets = summarizeOutputBullets(input.output, input.completionPromise);

  if (verifierBullets.length === 0 && outputBullets.length === 0) return undefined;

  if (input.completionDetected === true) {
    bullets.push("Completion was claimed, but the loop is continuing after verification.");
  }

  for (const line of verifierBullets) {
    bullets.push(`Verifier: ${line}`);
  }

  const remaining = Math.max(0, 3 - bullets.length);
  if (remaining > 0) {
    for (const line of outputBullets.slice(-remaining)) {
      bullets.push(`Agent: ${line}`);
    }
  }

  return [`Iteration summary:`, ...bullets.map((line) => `- ${line}`)].join("\n");
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

export function formatGoalTask(task: GoalTaskState, runtime?: GoalTaskRuntimeSnapshot, iterationSummary?: string): string {
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
  if (iterationSummary) {
    lines.push(...indentBlock(iterationSummary, "  "));
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
