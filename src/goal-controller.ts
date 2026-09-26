import type { HarnessUsage } from "./harness/types";
import { spawn } from "child_process";
import { buildMinimalChildEnv } from "./child-env";
import { pluginConfig } from "./config";
import { createHash } from "crypto";
import { shortId } from "./short-id";

import { executeRespond } from "./actions/respond";
import { buildGoalIterationSummary } from "./goal-format";
import { GoalTaskStore } from "./goal-store";
import type { Session } from "./session";
import type { SessionManager } from "./session-manager";
import { routeFromOriginMetadata } from "./session-route";
import type {
  GoalTaskConfig,
  GoalTaskStatus,
  GoalTaskState,
  GoalVerifierRunResult,
  GoalVerifierSpec,
  GoalVerifierStepResult,
  PermissionMode,
  SessionConfig,
  SessionRoute,
} from "./types";
import { createLogger } from "./logger";

const log = createLogger("goal-controller");

const DEFAULT_MAX_ITERATIONS = 8;
/** Upper bound for `max_iterations` (restarts after a gateway restart or idle timeout count too). */
export const MAX_GOAL_ITERATIONS = 25;
/** A goal stops once the same failure fingerprint repeats this many times in a row. */
const MAX_REPEATED_FAILURES = 3;
const DEFAULT_VERIFIER_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_VERIFIER_TIMEOUT_MS = 1_000;
const MAX_VERIFIER_TIMEOUT_MS = 30 * 60 * 1000;
/** Only this much of a verifier's output is kept (its tail), however much it prints. */
const VERIFIER_OUTPUT_TAIL_BYTES = 64 * 1024;
const VERIFIER_KILL_GRACE_MS = 2_000;
const MAX_COMMAND_OUTPUT_CHARS = 4000;
const MAX_REASON_CHARS = 1200;
const DEFAULT_RALPH_COMPLETION_PROMISE = "DONE";
/** How often a goal whose session was suspended with a pending plan checks for the decision. */
const PLAN_DECISION_RECHECK_MS = 30_000;

/** `max_iterations` within 1..MAX_GOAL_ITERATIONS (default DEFAULT_MAX_ITERATIONS). */
export function clampGoalMaxIterations(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ITERATIONS;
  return Math.min(MAX_GOAL_ITERATIONS, Math.max(1, Math.floor(value)));
}

function clampVerifierTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_VERIFIER_TIMEOUT_MS;
  return Math.min(MAX_VERIFIER_TIMEOUT_MS, Math.max(MIN_VERIFIER_TIMEOUT_MS, Math.floor(value)));
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "goal-task";
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function summarizeLines(text: string, maxLines: number = 20): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(-maxLines).join("\n");
}

function formatIterationSummaryForNotification(summary: string | undefined): string | undefined {
  const lines = (summary ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^Iteration summary:$/i.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ""));

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCompletionPromise(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_RALPH_COMPLETION_PROMISE;
}

function normalizeRoute(task: Pick<GoalTaskState, "route" | "originChannel" | "originThreadId" | "originSessionKey">): SessionRoute | undefined {
  return task.route ?? routeFromOriginMetadata(task.originChannel, task.originThreadId, task.originSessionKey);
}

export function normalizeVerifierCommands(commands: GoalVerifierSpec[]): GoalVerifierSpec[] {
  return commands
    .map((command, index) => ({
      label: command.label.trim() || `check-${index + 1}`,
      command: command.command.trim(),
      timeoutMs: clampVerifierTimeoutMs(command.timeoutMs),
    }))
    .filter((command) => command.command.length > 0);
}

function requiresVerifierCommands(task: Pick<GoalTaskState, "loopMode">): boolean {
  return task.loopMode === "verifier";
}

function hasVerifierCommands(task: Pick<GoalTaskState, "verifierCommands">): boolean {
  return normalizeVerifierCommands(task.verifierCommands).length > 0;
}

function isInvalidVerifierTask(task: Pick<GoalTaskState, "loopMode" | "verifierCommands">): boolean {
  return requiresVerifierCommands(task) && !hasVerifierCommands(task);
}

function zeroVerifierFailureReason(): string {
  return "Verifier-mode goal tasks require at least one verifier command.";
}

function outputFingerprint(result: GoalVerifierRunResult): string {
  const base = result.steps
    .filter((step) => !step.ok)
    .map((step) => `${step.label}:${step.exitCode}:${summarizeLines(step.output, 12)}`)
    .join("\n");
  return createHash("sha1").update(base).digest("hex");
}

function textFingerprint(text: string): string {
  return createHash("sha1").update(summarizeLines(text, 24)).digest("hex");
}

function classifyGoalAutoReply(text: string): string | undefined {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;

  const permissionRequest =
    /\b(can i|may i|should i|do you want me to|would you like me to)\b/.test(normalized)
    && /\b(read|write|edit|modify|change|inspect|search|run|execute|install|delete|move|rename|open)\b/.test(normalized);
  if (permissionRequest) return "Yes, proceed.";

  const continueRequest =
    /\b(should i continue|shall i continue|want me to continue|should i proceed|shall i proceed|can i proceed|go ahead)\b/.test(normalized);
  if (continueRequest) return "Yes, continue.";

  return undefined;
}

export type GoalTaskEditResult =
  | { action: "updated"; task: GoalTaskState; previousGoal: string }
  | { action: "not_found" }
  | { action: "invalid_goal" }
  | { action: "not_editable"; task: GoalTaskState };

function buildInitialPrompt(task: GoalTaskState): string {
  if (task.loopMode === "ralph") {
    return [
      `You are working inside a Ralph Wiggum-style autonomous loop.`,
      ``,
      `Goal:`,
      task.goal,
      ``,
      `Loop rules:`,
      `- Keep making concrete progress toward the goal in this repository.`,
      `- An external controller will continue looping until you emit the completion promise or the iteration budget is exhausted.`,
      `- When the goal is truly complete, output this exact marker on its own line: <promise>${task.completionPromise}</promise>`,
      `- Do not output that completion marker early, approximately, or with altered spelling.`,
      `- If you are not done yet, do not emit the completion marker.`,
      `- Do not ask to stop or wait for confirmation unless blocked by a real product, architecture, credential, or approval decision.`,
      `- Re-run useful local checks before ending each turn.`,
      task.verifierCommands.length > 0 ? `- External verifier commands will also be run after you claim completion.` : `- There may not be external verifiers, so your completion promise is the success gate.`,
    ].join("\n");
  }

  const verifierList = task.verifierCommands
    .map((command) => `- ${command.label}: ${command.command}`)
    .join("\n");

  return [
    `You are working on an autonomous goal-driven task.`,
    ``,
    `Goal:`,
    task.goal,
    ``,
    `Working rules:`,
    `- Make concrete progress toward the goal in this repository.`,
    `- An external controller will run these verifier commands after your turn:`,
    verifierList,
    `- If any verifier fails, you will receive the exact failures and must continue fixing the remaining gaps.`,
    `- Do not stop early just because you think the task is probably done.`,
    `- Do not ask for confirmation unless you are blocked by a real product, architecture, or credential decision.`,
    `- Before ending a turn, run any local checks you think are useful.`,
  ].join("\n");
}

function buildRestartPrompt(task: GoalTaskState): string {
  if (task.loopMode === "ralph") {
    return [
      `The OpenClaw gateway restarted while this Ralph-style goal task was running.`,
      `Resume from the prior session context and continue immediately.`,
      ``,
      `Goal:`,
      task.goal,
      ``,
      `Instructions:`,
      `- Continue from the current repo state and prior session context without restarting from scratch.`,
      `- Only emit <promise>${task.completionPromise}</promise> when the goal is actually complete.`,
      `- The external controller will keep looping until that marker appears or the iteration budget is exhausted.`,
      `- Do not ask for confirmation just because the gateway restarted.`,
    ].join("\n");
  }

  return [
    `The OpenClaw gateway restarted while this autonomous goal task was running.`,
    `Resume from the prior session context and continue toward the same goal immediately.`,
    ``,
    `Goal:`,
    task.goal,
    ``,
    `Instructions:`,
    `- Re-orient yourself from the existing repo state and prior session context.`,
    `- Continue the task without restarting from scratch unless the prior approach is clearly invalid.`,
    `- The external controller will continue running verifier commands after your turns.`,
    `- Do not ask for confirmation just because the gateway restarted.`,
  ].join("\n");
}

function buildRepairPrompt(task: GoalTaskState, verifier: GoalVerifierRunResult): string {
  const failedSteps = verifier.steps
    .filter((step) => !step.ok)
    .map((step) => [
      `- ${step.label} failed (exit ${step.exitCode})`,
      summarizeLines(step.output, 18),
    ].join("\n"))
    .join("\n\n");

  const retryInstruction =
    task.repeatedFailureCount >= 2
      ? `The same verifier fingerprint has repeated. Use a different debugging strategy than your previous attempt.`
      : `Fix only the remaining issues from the verifier output below.`;

  return [
    `The external verifier did not pass.`,
    retryInstruction,
    ``,
    `Goal:`,
    task.goal,
    ``,
    `Verifier failures:`,
    failedSteps,
    ``,
    `Instructions:`,
    `- Continue from the current code state and prior session context.`,
    `- Make the minimum necessary changes to satisfy the remaining verifier failures.`,
    ...(task.planApproved ? [`- Stay within the scope of the plan that was approved for this goal.`] : []),
    `- Re-run relevant checks yourself before ending the turn.`,
    `- Do not ask for confirmation unless you are truly blocked on a human decision.`,
  ].join("\n");
}

function buildRalphContinuationPrompt(task: GoalTaskState, output: string): string {
  const lastOutput = summarizeLines(output, 18) || "(no meaningful output)";
  const strategyNote =
    task.repeatedFailureCount >= 2
      ? `The loop has repeated without converging. Use a different strategy than the previous attempt.`
      : `Continue from the current repo state and prior session context.`;

  return [
    `Continue the same Ralph-style goal task.`,
    ``,
    `Goal:`,
    task.goal,
    ``,
    `Status:`,
    `- The last turn ended without the completion promise <promise>${task.completionPromise}</promise>.`,
    `- Current iteration: ${task.iteration}/${task.maxIterations}.`,
    `- ${strategyNote}`,
    ``,
    `Latest output / blockers:`,
    lastOutput,
    ``,
    `Instructions:`,
    `- Keep working until the goal is actually complete.`,
    ...(task.planApproved ? [`- Stay within the scope of the plan that was approved for this goal.`] : []),
    `- Only emit <promise>${task.completionPromise}</promise> when all requested work is done.`,
    `- If you are not done, do not emit the completion promise.`,
    task.verifierCommands.length > 0 ? `- If you believe you are done, make sure the expected verifiers are likely to pass before emitting the completion promise.` : `- There may not be external verifiers, so your completion promise is the success signal.`,
  ].join("\n");
}

function buildRalphVerifierFailurePrompt(task: GoalTaskState, verifier: GoalVerifierRunResult): string {
  const failedSteps = verifier.steps
    .filter((step) => !step.ok)
    .map((step) => [
      `- ${step.label} failed (exit ${step.exitCode})`,
      summarizeLines(step.output, 18),
    ].join("\n"))
    .join("\n\n");

  return [
    `You emitted the completion promise, but the external verifiers did not pass.`,
    ``,
    `Goal:`,
    task.goal,
    ``,
    `Verifier failures:`,
    failedSteps,
    ``,
    `Instructions:`,
    `- Continue from the current repo state and fix only the remaining gaps.`,
    ...(task.planApproved ? [`- Stay within the scope of the plan that was approved for this goal.`] : []),
    `- Do not emit <promise>${task.completionPromise}</promise> again until the goal is fully complete and the failing checks are addressed.`,
    `- Re-run relevant checks yourself before ending the turn.`,
  ].join("\n");
}

function outputContainsCompletionPromise(output: string, completionPromise: string): boolean {
  const trimmedPromise = completionPromise.trim();
  if (!trimmedPromise) return false;
  const direct = new RegExp(`(^|\\n)\\s*${escapeRegExp(trimmedPromise)}\\s*(\\n|$)`, "i");
  const wrapped = new RegExp(`<promise>\\s*${escapeRegExp(trimmedPromise)}\\s*<\\/promise>`, "i");
  return direct.test(output) || wrapped.test(output);
}

function buildVerifierSummary(result: GoalVerifierRunResult): string {
  return result.steps
    .map((step) => `${step.ok ? "PASS" : "FAIL"} ${step.label} (exit ${step.exitCode}, ${Math.round(step.durationMs)}ms)`)
    .join("\n");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTerminalGoalTaskStatus(status: GoalTaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "stopped";
}

function sessionFailureReason(session: Pick<Session, "error">): string {
  return truncate(session.error?.trim() || "Underlying session failed.", MAX_REASON_CHARS);
}

class VerifierOutputTail {
  private chunks: Buffer[] = [];
  private bytes = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > VERIFIER_OUTPUT_TAIL_BYTES && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.length;
    }
  }

  text(): string {
    const buffer = Buffer.concat(this.chunks);
    const tail = buffer.length > VERIFIER_OUTPUT_TAIL_BYTES ? buffer.subarray(buffer.length - VERIFIER_OUTPUT_TAIL_BYTES) : buffer;
    return tail.toString("utf8");
  }
}

function killVerifierGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Already exited.
  }
}

/**
 * Run one verifier command: `bash -c` (no login shell, so no profile scripts),
 * in the task workdir, with a minimal allowlisted environment (no API keys or
 * tokens; see child-env.ts), in its own process group. Only the output tail is
 * kept, so a noisy but passing check still passes. On timeout the whole
 * process group is terminated.
 */
export function runVerifierCommand(workdir: string, spec: GoalVerifierSpec): Promise<GoalVerifierStepResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timeoutMs = clampVerifierTimeoutMs(spec.timeoutMs);
    const stdout = new VerifierOutputTail();
    const stderr = new VerifierOutputTail();
    let timedOut = false;
    let settled = false;
    const child = spawn("bash", ["-c", spec.command], {
      cwd: workdir,
      env: buildMinimalChildEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killVerifierGroup(child.pid, "SIGTERM");
      forceKill = setTimeout(() => killVerifierGroup(child.pid, "SIGKILL"), VERIFIER_KILL_GRACE_MS);
      forceKill.unref?.();
    }, timeoutMs);
    timer.unref?.();
    const finish = (code: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      // Background processes the command left behind never outlive it.
      killVerifierGroup(child.pid, "SIGKILL");
      const out = stdout.text();
      const err = stderr.text();
      const combined = `${out}${err ? `\n${err}` : ""}`.trim();
      const exitCode = timedOut ? 124 : (code ?? 1);
      const note = timedOut
        ? `Timed out after ${Math.round(timeoutMs / 1000)} s; the command's process group was terminated.`
        : error ? `Failed to start: ${error.message}` : "";
      const output = [combined, note].filter(Boolean).join("\n") || "(no output)";
      resolve({
        label: spec.label,
        command: spec.command,
        ok: !timedOut && !error && code === 0,
        exitCode,
        durationMs: Date.now() - startedAt,
        output: output.length > MAX_COMMAND_OUTPUT_CHARS ? `...${output.slice(output.length - MAX_COMMAND_OUTPUT_CHARS + 3)}` : output,
      });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code));
  });
}

/**
 * Permission mode for a goal session: the configured mode until the first
 * plan is approved; afterwards later iterations continue within the approved
 * scope (plan mode switches to bypassPermissions, as a plan approval does).
 */
function goalSessionPermissionMode(task: Pick<GoalTaskState, "permissionMode" | "planApproved">): PermissionMode {
  const configured = (task.permissionMode ?? "plan") as PermissionMode;
  return configured === "plan" && task.planApproved ? "bypassPermissions" : configured;
}

function buildVerifierConfirmationText(task: GoalTaskState): string {
  return [
    `🎯 [${task.name}] Goal task waiting for your confirmation`,
    ``,
    `Goal:`,
    truncate(task.goal, 500),
    ``,
    `After each coding turn the goal loop will run these shell commands in ${task.workdir}:`,
    ...task.verifierCommands.map((command) => `  $ ${command.command}`),
    ``,
    `Nothing runs until you confirm. Up to ${task.maxIterations} iterations${task.maxCostUsd ? `, at most $${task.maxCostUsd.toFixed(2)}` : ""}.`,
  ].join("\n");
}

/**
 * The cost a goal's spend limit counts for one run: the billed cost, or, for
 * a backend that bills nothing per token (Codex with a ChatGPT login), the
 * API-price estimate of the tokens it used, so `max_cost_usd` still bounds it.
 */
export function goalRunCostUsd(session: { costUsd: number; usage?: Pick<HarnessUsage, "estimatedCostUsd"> }): number {
  const billed = Number.isFinite(session.costUsd) ? session.costUsd : 0;
  if (billed > 0) return billed;
  const estimate = session.usage?.estimatedCostUsd;
  return typeof estimate === "number" && Number.isFinite(estimate) && estimate > 0 ? estimate : billed;
}

export class GoalController {
  private readonly store: GoalTaskStore;
  private readonly sessionManager: SessionManager;
  private restorePromise: Promise<void> | null = null;
  private readonly inFlight: Set<string> = new Set();
  private readonly observerDisposers: Map<string, () => void> = new Map();
  private readonly scheduledEvaluations = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    sessionId?: string;
  }>();
  private readonly dirtyEvaluations = new Set<string>();
  private readonly dirtyEvaluationSessionIds = new Map<string, string | undefined>();
  private started = false;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
    this.store = new GoalTaskStore();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.restorePromise) return;
    this.restorePromise = this.restoreRecoverableTasks()
      .catch((err: unknown) => {
        log.warn(`[GoalController] Failed to restore recoverable tasks: ${errorMessage(err)}`);
      })
      .finally(() => {
        this.restorePromise = null;
      });
  }

  stop(): void {
    this.started = false;
    this.clearScheduledEvaluations();
    this.detachSessionObservers();
    this.captureRecoverableTasks();
    this.store.save();
  }

  listTasks(): GoalTaskState[] {
    return this.store.list();
  }

  getTask(ref: string): GoalTaskState | undefined {
    return this.store.get(ref);
  }

  async launchTask(config: GoalTaskConfig): Promise<GoalTaskState> {
    const loopMode = config.loopMode ?? "verifier";
    const verifierCommands = normalizeVerifierCommands(config.verifierCommands);
    if (loopMode === "verifier" && verifierCommands.length === 0) {
      throw new Error(zeroVerifierFailureReason());
    }

    const id = shortId(8);
    const task: GoalTaskState = {
      id,
      name: normalizeName(config.name ?? config.goal),
      goal: config.goal.trim(),
      workdir: config.workdir,
      status: "waiting_for_session",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      iteration: 0,
      maxIterations: clampGoalMaxIterations(config.maxIterations),
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      fastMode: config.fastMode,
      systemPrompt: config.systemPrompt,
      allowedTools: config.allowedTools,
      originChannel: config.originChannel,
      originThreadId: config.originThreadId,
      originAgentId: config.originAgentId,
      originSessionKey: config.originSessionKey,
      route: config.route,
      harness: config.harness,
      // The first iteration goes through the normal plan gate (default: plan).
      permissionMode: config.permissionMode ?? pluginConfig.permissionMode ?? "plan",
      loopMode,
      completionPromise: normalizeCompletionPromise(config.completionPromise),
      verifierCommands,
      repeatedFailureCount: 0,
      ...(config.maxCostUsd !== undefined && config.maxCostUsd > 0 ? { maxCostUsd: config.maxCostUsd } : {}),
      totalCostUsd: 0,
    };

    if (config.requireVerifierConfirmation && verifierCommands.length > 0) {
      // Commands the orchestrator chose run only after the user confirms them.
      task.status = "awaiting_verifier_confirmation";
      this.store.upsert(task);
      this.sessionManager.sendGoalVerifierConfirmation(task, buildVerifierConfirmationText(task));
      return task;
    }

    return await this.startTask(task);
  }

  /** The user confirmed the verifier commands of a waiting task: start it. */
  async confirmVerifierCommands(ref: string): Promise<{ task: GoalTaskState; action: "started" | "not_waiting" } | undefined> {
    const task = this.store.get(ref);
    if (!task) return undefined;
    if (task.status !== "awaiting_verifier_confirmation") return { task, action: "not_waiting" };
    task.status = "waiting_for_session";
    task.updatedAt = Date.now();
    this.store.upsert(task);
    try {
      return { task: await this.startTask(task), action: "started" };
    } catch (err: unknown) {
      this.markTaskFailed(task, `Failed to start the goal task: ${errorMessage(err)}`);
      throw err;
    }
  }

  /** The user declined the verifier commands of a waiting task. */
  declineVerifierCommands(ref: string): { task: GoalTaskState; action: "stopped" | "not_waiting" } | undefined {
    const task = this.store.get(ref);
    if (!task) return undefined;
    if (task.status !== "awaiting_verifier_confirmation") return { task, action: "not_waiting" };
    this.markTaskStopped(task, "The user did not confirm the verifier commands.");
    return { task, action: "stopped" };
  }

  private async startTask(task: GoalTaskState): Promise<GoalTaskState> {
    const session = await this.spawnTaskSession(task, buildInitialPrompt(task));
    this.attachSessionObservers(task, session);
    task.sessionId = session.id;
    task.sessionName = session.name;
    task.harnessSessionId = session.harnessSessionId;
    task.status = "running";
    task.updatedAt = Date.now();
    this.store.upsert(task);
    this.scheduleTaskEvaluation(task.id, "launch", session.id);

    this.notify(task, `🎯 [${task.name}] Goal task started\n\nGoal:\n${truncate(task.goal, 500)}`, "goal-task-started");
    return task;
  }

  stopTask(ref: string): { task: GoalTaskState; action: "stopped" | "already_terminal" } | undefined {
    const task = this.store.get(ref);
    if (!task) return undefined;
    if (isTerminalGoalTaskStatus(task.status)) {
      return { task, action: "already_terminal" };
    }

    if (task.sessionId) {
      this.sessionManager.kill(task.sessionId, "user");
    }

    this.markTaskStopped(task, "Stopped by user.");
    return { task, action: "stopped" };
  }

  editTask(ref: string, replacementGoal: string): GoalTaskEditResult {
    const goal = replacementGoal.trim();
    if (!goal) return { action: "invalid_goal" };

    const task = this.store.get(ref);
    if (!task) return { action: "not_found" };
    if (isTerminalGoalTaskStatus(task.status) || task.status === "waiting_for_user") {
      return { action: "not_editable", task };
    }

    const previousGoal = task.goal;
    task.goal = goal;
    task.updatedAt = Date.now();
    this.store.upsert(task);
    this.notify(task, `✏️ [${task.name}] Goal task edited\n\nGoal:\n${truncate(task.goal, 500)}`, "goal-task-edited");
    return { action: "updated", task, previousGoal };
  }

  private async spawnTaskSession(task: GoalTaskState, prompt: string): Promise<Session> {
    return this.spawnManagedTaskSession(task, prompt);
  }

  private async spawnManagedTaskSession(task: GoalTaskState, prompt: string, resumeRef?: string): Promise<Session> {
    const requestedResumeSessionId = resumeRef
      ? (this.sessionManager.resolveBackendConversationId(resumeRef) ?? resumeRef)
      : undefined;
    const resumeSessionId = requestedResumeSessionId;

    const config: SessionConfig = {
      prompt,
      name: task.name,
      workdir: task.workdir,
      model: task.model,
      reasoningEffort: task.reasoningEffort,
      fastMode: task.fastMode,
      systemPrompt: task.systemPrompt,
      allowedTools: task.allowedTools,
      originChannel: task.originChannel,
      originThreadId: task.originThreadId,
      originAgentId: task.originAgentId,
      originSessionKey: task.originSessionKey,
      route: normalizeRoute(task),
      permissionMode: goalSessionPermissionMode(task),
      multiTurn: true,
      goalTaskId: task.id,
      harness: task.harness,
      resumeSessionId,
      resumeWorktreeFrom: requestedResumeSessionId,
      // Goal loops intentionally own terminal handling and disable worktree flows.
      worktreeStrategy: "off",
    };
    const session = await this.sessionManager.launchAndAwaitRunning(config, { notifyLaunch: false });
    // Pin resolved settings for later iterations and restart recovery.
    task.harness = session.harnessName ?? task.harness;
    task.model = session.model ?? task.model;
    task.reasoningEffort = session.reasoningEffort ?? task.reasoningEffort;
    return session;
  }

  private async resumeTaskSession(task: GoalTaskState, prompt: string, session: Session): Promise<Session> {
    if (!session.harnessSessionId) {
      const spawned = await this.spawnTaskSession(task, [
        `The previous session ended without a resumable harness session id.`,
        `Continue working on the same goal.`,
        ``,
        prompt,
      ].join("\n"));
      this.attachSessionObservers(task, spawned);
      return spawned;
    }

    const resumed = await this.spawnManagedTaskSession(task, prompt, session.harnessSessionId);
    this.attachSessionObservers(task, resumed);
    return resumed;
  }

  private resolveResumeSessionId(task: GoalTaskState): string | undefined {
    if (task.harnessSessionId) return task.harnessSessionId;
    if (task.sessionId) {
      const resumed = this.sessionManager.resolveBackendConversationId(task.sessionId);
      if (resumed) return resumed;
    }
    const byName = this.sessionManager.resolveBackendConversationId(task.name);
    if (byName) return byName;
    return undefined;
  }

  private captureRecoverableTasks(): void {
    for (const task of this.store.list()) {
      if (task.status !== "running" && task.status !== "waiting_for_session") continue;
      const session = task.sessionId ? this.sessionManager.resolve(task.sessionId) : undefined;
      if (!session) continue;

      task.sessionId = session.id;
      task.sessionName = session.name;
      task.harnessSessionId = session.harnessSessionId ?? task.harnessSessionId;
      task.route = session.route ?? task.route;
      task.updatedAt = Date.now();
      task.status = "waiting_for_session";
      this.store.upsert(task);
    }
  }

  private async restoreRecoverableTasks(): Promise<void> {
    for (const task of this.store.list()) {
      if (!this.started) break;
      if (task.status === "waiting_for_user") {
        this.markTaskFailed(task, "Goal task was waiting for user input and cannot continue autonomously");
        continue;
      }
      if (task.status !== "waiting_for_session" && task.status !== "running") continue;
      if (isInvalidVerifierTask(task)) {
        this.markTaskFailed(task, zeroVerifierFailureReason());
        continue;
      }

      if (task.sessionId) {
        const active = this.sessionManager.resolve(task.sessionId);
        if (active && (active.status === "starting" || active.status === "running")) {
          continue;
        }
      }

      const resumeSessionId = this.resolveResumeSessionId(task);
      if (!resumeSessionId) {
        this.markTaskFailed(task, "Goal task could not be resumed after gateway restart because no resumable session id was available.");
        continue;
      }
      // A restart is an iteration too: a task cannot restart forever.
      if (!this.consumeIteration(task, "The gateway restarted while the goal task was running.")) continue;

      try {
        const resumed = await this.spawnManagedTaskSession(task, buildRestartPrompt(task), resumeSessionId);
        if (!this.started) {
          task.sessionId = resumed.id;
          task.sessionName = resumed.name;
          task.harnessSessionId = resumed.harnessSessionId ?? resumeSessionId;
          task.route = resumed.route ?? task.route;
          task.status = "waiting_for_session";
          task.updatedAt = Date.now();
          this.store.upsert(task);
          this.sessionManager.kill(resumed.id, "shutdown");
          break;
        }
        this.attachSessionObservers(task, resumed);
        task.sessionId = resumed.id;
        task.sessionName = resumed.name;
        task.harnessSessionId = resumed.harnessSessionId ?? resumeSessionId;
        task.route = resumed.route ?? task.route;
        task.status = "running";
        task.updatedAt = Date.now();
        this.store.upsert(task);
        this.notifyIterationStatus(task, `🔄 [${task.name}] Goal task resumed after gateway restart`, resumed);
        this.scheduleTaskEvaluation(task.id, "restore", resumed.id);
      } catch (err: unknown) {
        this.markTaskFailed(task, `Failed to resume the goal task after gateway restart: ${errorMessage(err)}`);
      }
    }
  }

  private async runVerifiers(task: GoalTaskState): Promise<GoalVerifierRunResult> {
    const verifierCommands = normalizeVerifierCommands(task.verifierCommands);
    if (verifierCommands.length === 0) {
      const result: GoalVerifierRunResult = {
        status: "fail",
        steps: [{
          label: "verifier-config",
          command: "(none configured)",
          ok: false,
          exitCode: 1,
          durationMs: 0,
          output: zeroVerifierFailureReason(),
        }],
        summary: "",
        fingerprint: "",
      };
      result.fingerprint = outputFingerprint(result);
      result.summary = buildVerifierSummary(result);
      return result;
    }

    const steps: GoalVerifierStepResult[] = [];
    for (const command of verifierCommands) {
      steps.push(await runVerifierCommand(task.workdir, command));
    }

    const status = steps.every((step) => step.ok) ? "pass" : "fail";
    const result: GoalVerifierRunResult = {
      status,
      steps,
      summary: "",
      fingerprint: "",
    };
    result.fingerprint = outputFingerprint(result);
    result.summary = buildVerifierSummary(result);
    return result;
  }

  private notify(task: GoalTaskState, text: string, label: string): void {
    this.sessionManager.emitGoalTaskUpdate(task, text, label);
  }

  private notifyIterationStatus(task: GoalTaskState, heading: string, _session?: Session, iterationSummary?: string): void {
    const iterationLabel = task.loopMode === "ralph" ? "iteration" : "repair iteration";
    const progressHeading = /\b(?:repair\s+)?iteration\s+\d+\/\d+\b/i.test(heading)
      ? heading
      : `${heading} ${iterationLabel} ${task.iteration}/${task.maxIterations}`;
    const compactSummary = formatIterationSummaryForNotification(iterationSummary);
    const text = compactSummary ? `${progressHeading}\n\n${compactSummary}` : progressHeading;
    this.notify(task, text, "goal-task-progress");
  }

  private setTaskRunningWithSession(task: GoalTaskState, session: Pick<Session, "id" | "name" | "harnessSessionId" | "route">): void {
    task.sessionId = session.id;
    task.sessionName = session.name;
    task.harnessSessionId = session.harnessSessionId;
    task.route = session.route ?? task.route;
    task.status = "running";
    task.waitingForUserReason = undefined;
    task.updatedAt = Date.now();
    this.store.upsert(task);
  }

  private attachSessionObservers(task: GoalTaskState, session: Session): void {
    if (this.observerDisposers.has(session.id)) return;
    const onStatusChange = (_current: Session, nextStatus: Session["status"]) => {
      if (nextStatus === "completed" || nextStatus === "failed" || nextStatus === "killed") {
        this.removeSessionObserver(session.id);
        this.scheduleTaskEvaluation(task.id, `status:${nextStatus}`, session.id);
      }
    };

    const onTurnEnd = () => {
      const current = this.store.get(task.id);
      if (!current) return;

      current.sessionId = session.id;
      current.sessionName = session.name;
      current.harnessSessionId = session.harnessSessionId;
      current.route = session.route ?? current.route;
      current.updatedAt = Date.now();
      if (current.status === "waiting_for_session") {
        current.status = "running";
      }
      this.store.upsert(current);

      this.notifyIterationStatus(current, `🔄 [${current.name}] Coding turn complete`, session);
      this.scheduleTaskEvaluation(task.id, "turnEnd", session.id);
    };

    session.on("statusChange", onStatusChange);
    session.on("turnEnd", onTurnEnd);
    this.observerDisposers.set(session.id, () => {
      session.off?.("statusChange", onStatusChange);
      session.off?.("turnEnd", onTurnEnd);
      session.removeListener?.("statusChange", onStatusChange);
      session.removeListener?.("turnEnd", onTurnEnd);
    });
  }

  private scheduleTaskEvaluation(taskId: string, trigger: string, sessionId?: string): void {
    if (!this.started) return;
    const existing = this.scheduledEvaluations.get(taskId);
    if (existing) {
      if (!existing.sessionId && sessionId) existing.sessionId = sessionId;
      return;
    }

    const entry = {
      timer: setTimeout(() => {
        this.scheduledEvaluations.delete(taskId);
        void this.evaluateTask(taskId, trigger, entry.sessionId).catch((err: unknown) => {
          log.warn(`[GoalController] evaluateTask error (${trigger}): ${errorMessage(err)}`);
        });
      }, 0),
      sessionId,
    };
    entry.timer.unref?.();
    this.scheduledEvaluations.set(taskId, entry);
  }

  private clearScheduledEvaluations(): void {
    for (const entry of this.scheduledEvaluations.values()) {
      clearTimeout(entry.timer);
    }
    this.scheduledEvaluations.clear();
    this.dirtyEvaluations.clear();
    this.dirtyEvaluationSessionIds.clear();
  }

  private detachSessionObservers(): void {
    for (const sessionId of [...this.observerDisposers.keys()]) {
      this.removeSessionObserver(sessionId);
    }
  }

  private removeSessionObserver(sessionId: string): void {
    const dispose = this.observerDisposers.get(sessionId);
    if (!dispose) return;
    this.observerDisposers.delete(sessionId);
    dispose();
  }

  private markTaskFailed(task: GoalTaskState, reason: string): void {
    task.status = "failed";
    task.failureReason = truncate(reason, MAX_REASON_CHARS);
    task.updatedAt = Date.now();
    this.store.upsert(task);
    this.notify(task, `❌ [${task.name}] Goal task failed\n\n${task.failureReason}`, "goal-task-failed");
  }

  private markTaskFailedWaitingForUser(task: GoalTaskState, reason: string): void {
    this.markTaskFailed(task, `Goal task was waiting for user input and cannot continue autonomously: ${reason}`);
  }

  private markTaskSucceeded(task: GoalTaskState, summary: string): void {
    task.status = "succeeded";
    task.lastVerifierSummary = summary;
    task.updatedAt = Date.now();
    this.store.upsert(task);
    this.notify(task, `✅ [${task.name}] Goal task succeeded\n\n${summary}`, "goal-task-succeeded");
  }

  private markTaskStopped(task: GoalTaskState, reason: string): void {
    task.status = "stopped";
    task.failureReason = truncate(reason, MAX_REASON_CHARS);
    task.updatedAt = Date.now();
    this.store.upsert(task);
    this.notify(task, `⛔ [${task.name}] Goal task stopped\n\n${task.failureReason}`, "goal-task-stopped");
  }

  /** Remember that the first plan was approved: later iterations run within its scope. */
  private notePlanApproval(task: GoalTaskState, session: Session): void {
    if (task.planApproved) return;
    const planModeApproved = typeof session.controlStateSnapshot === "function" && session.controlStateSnapshot().planModeApproved;
    if (planModeApproved || session.approvalState === "approved") {
      task.planApproved = true;
      task.updatedAt = Date.now();
      this.store.upsert(task);
    }
  }

  /**
   * Count one more iteration (a repair turn, or a restart after a gateway
   * restart or idle timeout). False, and the task failed, once the budget is used.
   */
  private consumeIteration(task: GoalTaskState, reason: string): boolean {
    if (task.iteration + 1 >= task.maxIterations) {
      this.markTaskFailed(task, `${reason} The iteration budget (${task.maxIterations}) is used up.`);
      return false;
    }
    task.iteration += 1;
    task.updatedAt = Date.now();
    this.store.upsert(task);
    return true;
  }

  /** Add a finished run's cost; false, and the task failed, once `maxCostUsd` is reached. */
  private recordRunCost(task: GoalTaskState, session: Pick<Session, "id" | "startedAt" | "costUsd"> & { usage?: Pick<HarnessUsage, "estimatedCostUsd"> }): boolean {
    const runKey = `${session.id}:${session.startedAt}`;
    if (task.lastCostedRun !== runKey) {
      task.totalCostUsd = (task.totalCostUsd ?? 0) + goalRunCostUsd(session);
      task.lastCostedRun = runKey;
      this.store.upsert(task);
    }
    if (task.maxCostUsd !== undefined && (task.totalCostUsd ?? 0) >= task.maxCostUsd) {
      this.markTaskFailed(task, `The goal task reached its cost limit ($${(task.totalCostUsd ?? 0).toFixed(2)} of $${task.maxCostUsd.toFixed(2)}).`);
      return false;
    }
    return true;
  }

  /** Track a failure fingerprint; false, and the task failed, after MAX_REPEATED_FAILURES identical ones. */
  private recordFailureFingerprint(task: GoalTaskState, fingerprint: string, summary: string): boolean {
    task.repeatedFailureCount = task.lastVerifierFingerprint === fingerprint ? task.repeatedFailureCount + 1 : 1;
    task.lastVerifierFingerprint = fingerprint;
    if (task.repeatedFailureCount >= MAX_REPEATED_FAILURES) {
      this.markTaskFailed(task, [
        `The same failure repeated ${task.repeatedFailureCount} times in a row; stopping instead of retrying.`,
        summary,
      ].join("\n"));
      return false;
    }
    return true;
  }

  private async handleRunningSession(task: GoalTaskState, session: Session): Promise<void> {
    if (session.pendingPlanApproval) {
      // The first iteration's plan goes through the normal plan gate (the
      // user, or the orchestrator when planApproval allows it); the goal loop
      // never approves its own plan.
      if (task.status !== "waiting_for_plan_approval") {
        task.status = "waiting_for_plan_approval";
        task.updatedAt = Date.now();
        this.store.upsert(task);
      }
      return;
    }
    this.notePlanApproval(task, session);

    if (!session.pendingInputState) {
      this.setTaskRunningWithSession(task, session);
      return;
    }

    const output = session.getOutput(30).join("\n");
    const autoReply = classifyGoalAutoReply(output);
    if (!autoReply) {
      this.markTaskFailedWaitingForUser(task, summarizeLines(output, 24) || "The session is waiting for user input.");
      return;
    }

    const result = await executeRespond(this.sessionManager, {
      session: session.id,
      message: autoReply,
      userInitiated: false,
    });
    if (result.isError || result.text.includes("Auto-respond limit reached")) {
      this.markTaskFailedWaitingForUser(task, result.text);
      return;
    }

    task.status = "running";
    task.waitingForUserReason = undefined;
    task.updatedAt = Date.now();
    this.store.upsert(task);
  }

  private async resumeAfterIdleTimeout(task: GoalTaskState, session: Session, prompt: string): Promise<void> {
    // A restart is an iteration too: an idle loop cannot restart forever.
    if (!this.consumeIteration(task, "The goal task was idle-suspended and would restart again.")) return;
    try {
      const resumed = await this.resumeTaskSession(task, prompt, session);
      this.setTaskRunningWithSession(task, resumed);
      this.notifyIterationStatus(task, `🔄 [${task.name}] Goal task resumed after idle timeout`, resumed);
      this.scheduleTaskEvaluation(task.id, "idle-timeout-resume", resumed.id);
    } catch (err: unknown) {
      this.markTaskFailed(task, `Failed to resume the goal task after idle timeout: ${errorMessage(err)}`);
    }
  }

  /**
   * A goal session suspended while its plan waited: the plan decision resumes
   * it under the same session id (for example the user's Approve button).
   * Check periodically and follow the resumed session from there.
   */
  private schedulePlanDecisionRecheck(taskId: string, suspended: Session): void {
    if (!this.started) return;
    const timer = setTimeout(() => {
      const task = this.store.get(taskId);
      if (!task || task.status !== "waiting_for_plan_approval" || !task.sessionId) return;
      const current = this.sessionManager.resolve(task.sessionId);
      if (current && current !== suspended && (current.status === "starting" || current.status === "running")) {
        this.attachSessionObservers(task, current);
        this.setTaskRunningWithSession(task, current);
        this.scheduleTaskEvaluation(task.id, "plan-decision-resumed", current.id);
        return;
      }
      const persisted = this.sessionManager.getPersistedSession(task.sessionId);
      if (persisted?.approvalState === "rejected") {
        this.markTaskStopped(task, "The plan was rejected.");
        return;
      }
      this.schedulePlanDecisionRecheck(taskId, suspended);
    }, PLAN_DECISION_RECHECK_MS);
    timer.unref?.();
  }

  private async handleTerminalSession(task: GoalTaskState, session: Session): Promise<void> {
    if (!this.recordRunCost(task, session)) return;
    this.notePlanApproval(task, session);

    if (session.status === "failed") {
      this.markTaskFailed(task, sessionFailureReason(session));
      return;
    }

    if (session.status === "killed" && session.killReason === "user") {
      this.markTaskStopped(task, "Stopped by user.");
      return;
    }

    if (session.status === "killed" && session.killReason === "idle-timeout") {
      const output = session.getOutput(60).join("\n");
      if (session.pendingPlanApproval) {
        // The plan still waits for its decision; the suspended session resumes
        // (same session id) when it is approved, rejected, or revised.
        task.status = "waiting_for_plan_approval";
        task.updatedAt = Date.now();
        this.store.upsert(task);
        this.schedulePlanDecisionRecheck(task.id, session);
        return;
      }
      if (session.pendingInputState) {
        const autoReply = classifyGoalAutoReply(output);
        if (!autoReply) {
          this.markTaskFailed(
            task,
            `Goal task was waiting for user input and cannot continue autonomously: ${summarizeLines(output, 24) || "The goal task hit idle timeout while waiting for user input."}`,
          );
          return;
        }
        await this.resumeAfterIdleTimeout(
          task,
          session,
          [
            `The previous session hit idle timeout while waiting for a response.`,
            `Use this response and continue the goal: ${autoReply}`,
          ].join("\n\n"),
        );
        return;
      }
      await this.resumeAfterIdleTimeout(task, session, buildRestartPrompt(task));
      return;
    }

    if (session.status === "killed" && session.killReason !== "done") {
      this.markTaskFailed(task, `Underlying session was killed (${session.killReason}).`);
      return;
    }

    if (task.loopMode === "ralph") {
      const output = session.getOutput(200).join("\n");
      const completionPromise = normalizeCompletionPromise(task.completionPromise);
      const completionDetected = outputContainsCompletionPromise(output, completionPromise);

      if (completionDetected) {
        if (task.verifierCommands.length === 0) {
          this.markTaskSucceeded(task, `Completion promise "${completionPromise}" detected in agent output.`);
          return;
        }

        const verifier = await this.runVerifiers(task);
        task.lastVerifierSummary = verifier.summary;
        task.updatedAt = Date.now();

        if (verifier.status === "pass") {
          this.markTaskSucceeded(
            task,
            [`Completion promise "${completionPromise}" detected.`, verifier.summary].join("\n"),
          );
          return;
        }

        if (!this.recordFailureFingerprint(task, verifier.fingerprint, verifier.summary)) return;

        if (task.iteration + 1 >= task.maxIterations) {
          this.markTaskFailed(
            task,
            [
              `Goal task emitted completion promise but verifiers still failed before hitting the iteration budget (${task.maxIterations}).`,
              verifier.summary,
            ].join("\n"),
          );
          return;
        }

        task.iteration += 1;
        const prompt = buildRalphVerifierFailurePrompt(task, verifier);
        const iterationSummary = buildGoalIterationSummary({
          output,
          verifierSummary: verifier.summary,
          completionPromise,
          completionDetected: true,
        });
        try {
          const resumed = await this.resumeTaskSession(task, prompt, session);
          this.setTaskRunningWithSession(task, resumed);
          this.notifyIterationStatus(task, `🔁 [${task.name}] Completion claimed but verifiers still failed`, undefined, iterationSummary);
          this.scheduleTaskEvaluation(task.id, "ralph-verifier-resume", resumed.id);
        } catch (err: unknown) {
          this.markTaskFailed(task, `Failed to resume the Ralph goal task after verifier failure: ${errorMessage(err)}`);
        }
        return;
      }

      const latestFingerprint = textFingerprint(output);
      if (!this.recordFailureFingerprint(task, latestFingerprint, `Latest output:\n${summarizeLines(output, 12) || "(no output)"}`)) return;

      if (task.iteration + 1 >= task.maxIterations) {
        this.markTaskFailed(
          task,
          [
            `Completion promise "${completionPromise}" was not emitted before hitting the iteration budget (${task.maxIterations}).`,
            `Latest output:`,
            summarizeLines(output, 20) || "(no output)",
          ].join("\n"),
        );
        return;
      }

      task.iteration += 1;
      const prompt = buildRalphContinuationPrompt(task, output);
      const iterationSummary = buildGoalIterationSummary({
        output,
        completionPromise,
        completionDetected: false,
      });
      try {
        const resumed = await this.resumeTaskSession(task, prompt, session);
        this.setTaskRunningWithSession(task, resumed);
        this.notifyIterationStatus(task, `🔁 [${task.name}] Continued`, undefined, iterationSummary);
        this.scheduleTaskEvaluation(task.id, "ralph-continue", resumed.id);
      } catch (err: unknown) {
        this.markTaskFailed(task, `Failed to continue the Ralph goal task: ${errorMessage(err)}`);
      }
      return;
    }

    const verifier = await this.runVerifiers(task);
    task.lastVerifierSummary = verifier.summary;
    task.updatedAt = Date.now();

    if (verifier.status === "pass") {
      this.markTaskSucceeded(task, verifier.summary);
      return;
    }

    if (!this.recordFailureFingerprint(task, verifier.fingerprint, verifier.summary)) return;

    if (task.iteration + 1 >= task.maxIterations) {
      this.markTaskFailed(
        task,
        [
          `Verifier did not pass before hitting the iteration budget (${task.maxIterations}).`,
          verifier.summary,
        ].join("\n"),
      );
      return;
    }

    task.iteration += 1;
    const prompt = buildRepairPrompt(task, verifier);
    const iterationSummary = buildGoalIterationSummary({
      verifierSummary: verifier.summary,
    });
    try {
      const resumed = await this.resumeTaskSession(task, prompt, session);
      this.setTaskRunningWithSession(task, resumed);
      this.notifyIterationStatus(task, `🔁 [${task.name}] Repair iteration started after verifier failure`, undefined, iterationSummary);
      this.scheduleTaskEvaluation(task.id, "repair-resume", resumed.id);
    } catch (err: unknown) {
      this.markTaskFailed(task, `Failed to resume the goal task: ${errorMessage(err)}`);
    }
  }

  private async evaluateTask(taskId: string, trigger: string, hintedSessionId?: string): Promise<void> {
    if (this.restorePromise) {
      await this.restorePromise;
    }
    const task = this.store.get(taskId);
    if (!task) return;
    await this.reconcileTask(task, trigger, hintedSessionId);
  }

  private async reconcileTask(task: GoalTaskState, trigger: string = "manual", hintedSessionId?: string): Promise<void> {
    if (task.status === "succeeded" || task.status === "failed" || task.status === "stopped") {
      return;
    }
    if (this.inFlight.has(task.id)) {
      this.dirtyEvaluations.add(task.id);
      const existingDirtySessionId = this.dirtyEvaluationSessionIds.get(task.id);
      if (!existingDirtySessionId && hintedSessionId) {
        this.dirtyEvaluationSessionIds.set(task.id, hintedSessionId);
      } else if (!this.dirtyEvaluationSessionIds.has(task.id)) {
        this.dirtyEvaluationSessionIds.set(task.id, hintedSessionId);
      }
      return;
    }

    this.inFlight.add(task.id);
    try {
      if (hintedSessionId && task.sessionId && task.sessionId !== hintedSessionId) {
        const hintedSession = this.sessionManager.resolve(hintedSessionId);
        if (hintedSession && (hintedSession.status === "completed" || hintedSession.status === "failed" || hintedSession.status === "killed")) {
          return;
        }
      }

      const session = hintedSessionId
        ? (this.sessionManager.resolve(hintedSessionId) ?? (task.sessionId ? this.sessionManager.resolve(task.sessionId) : undefined))
        : (task.sessionId ? this.sessionManager.resolve(task.sessionId) : undefined);
      if (task.status === "waiting_for_user") {
        this.markTaskFailed(task, "Goal task was waiting for user input and cannot continue autonomously");
        return;
      }
      if (isInvalidVerifierTask(task)) {
        this.markTaskFailed(task, zeroVerifierFailureReason());
        return;
      }
      if (!session) {
        this.markTaskFailed(task, "Underlying session could not be found.");
        return;
      }

      task.sessionName = session.name;
      task.harnessSessionId = session.harnessSessionId;
      task.route = session.route ?? task.route;
      task.updatedAt = Date.now();
      this.store.upsert(task);

      if (session.status === "starting" || session.status === "running") {
        await this.handleRunningSession(task, session);
        return;
      }

      await this.handleTerminalSession(task, session);
    } finally {
      this.inFlight.delete(task.id);
      if (this.dirtyEvaluations.has(task.id)) {
        this.dirtyEvaluations.delete(task.id);
        const dirtySessionId = this.dirtyEvaluationSessionIds.get(task.id);
        this.dirtyEvaluationSessionIds.delete(task.id);
        this.scheduleTaskEvaluation(task.id, `${trigger}:dirty`, dirtySessionId);
      }
    }
  }

}
