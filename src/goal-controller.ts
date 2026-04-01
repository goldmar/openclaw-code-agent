import { execFile } from "child_process";
import { createHash } from "crypto";
import { nanoid } from "nanoid";

import { executeRespond } from "./actions/respond";
import { buildGoalTaskRuntimeSnapshot, formatGoalTask } from "./goal-format";
import { GoalTaskStore } from "./goal-store";
import { decideResumeSessionId } from "./resume-policy";
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

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_VERIFIER_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_COMMAND_OUTPUT_CHARS = 4000;
const MAX_REASON_CHARS = 1200;
const DEFAULT_RALPH_COMPLETION_PROMISE = "DONE";

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
  return commands.map((command, index) => ({
    label: command.label.trim() || `check-${index + 1}`,
    command: command.command.trim(),
    timeoutMs: command.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS,
  }));
}

function requiresVerifierCommands(task: Pick<GoalTaskState, "loopMode">): boolean {
  return task.loopMode === "verifier";
}

function hasVerifierCommands(task: Pick<GoalTaskState, "verifierCommands">): boolean {
  return task.verifierCommands.length > 0;
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

export function classifyGoalAutoReply(text: string): string | undefined {
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

export function buildRepairPrompt(task: GoalTaskState, verifier: GoalVerifierRunResult): string {
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

function runCommand(workdir: string, spec: GoalVerifierSpec): Promise<GoalVerifierStepResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      "bash",
      ["-lc", spec.command],
      {
        cwd: workdir,
        timeout: spec.timeoutMs ?? DEFAULT_VERIFIER_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        const exitCode =
          typeof (err as { code?: unknown } | null)?.code === "number"
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        const combined = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
        resolve({
          label: spec.label,
          command: spec.command,
          ok: !err,
          exitCode,
          durationMs,
          output: truncate(combined || "(no output)", MAX_COMMAND_OUTPUT_CHARS),
        });
      },
    );
  });
}

export class GoalController {
  private readonly store: GoalTaskStore;
  private readonly sessionManager: SessionManager;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private restorePromise: Promise<void> | null = null;
  private readonly inFlight: Set<string> = new Set();
  private readonly observedSessions: Set<string> = new Set();
  private started = false;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
    this.store = new GoalTaskStore();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.reconcileTimer || this.restorePromise) return;
    this.restorePromise = this.restoreRecoverableTasks()
      .catch((err: unknown) => {
        console.warn(`[GoalController] Failed to restore recoverable tasks: ${errorMessage(err)}`);
      })
      .finally(() => {
        this.restorePromise = null;
        if (!this.started || this.reconcileTimer) return;
        this.reconcileTimer = setInterval(() => {
          void this.reconcileAll().catch((err: unknown) => {
            console.warn(`[GoalController] reconcileAll error: ${errorMessage(err)}`);
          });
        }, 5_000);
      });
  }

  stop(): void {
    this.started = false;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
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
    if (loopMode === "verifier" && config.verifierCommands.length === 0) {
      throw new Error(zeroVerifierFailureReason());
    }

    const id = nanoid(8);
    const task: GoalTaskState = {
      id,
      name: normalizeName(config.name ?? config.goal),
      goal: config.goal.trim(),
      workdir: config.workdir,
      status: "waiting_for_session",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      iteration: 0,
      maxIterations: config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      systemPrompt: config.systemPrompt,
      allowedTools: config.allowedTools,
      originChannel: config.originChannel,
      originThreadId: config.originThreadId,
      originAgentId: config.originAgentId,
      originSessionKey: config.originSessionKey,
      route: config.route,
      harness: config.harness,
      permissionMode: config.permissionMode ?? "bypassPermissions",
      loopMode,
      completionPromise: normalizeCompletionPromise(config.completionPromise),
      verifierCommands: normalizeVerifierCommands(config.verifierCommands),
      repeatedFailureCount: 0,
    };

    const session = await this.spawnTaskSession(task, buildInitialPrompt(task));
    this.attachSessionObservers(task, session);
    task.sessionId = session.id;
    task.sessionName = session.name;
    task.harnessSessionId = session.harnessSessionId;
    task.status = "running";
    task.updatedAt = Date.now();
    this.store.upsert(task);

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

  private async spawnTaskSession(task: GoalTaskState, prompt: string): Promise<Session> {
    return this.spawnManagedTaskSession(task, prompt);
  }

  private async spawnManagedTaskSession(task: GoalTaskState, prompt: string, resumeRef?: string): Promise<Session> {
    const requestedResumeSessionId = resumeRef
      ? (this.sessionManager.resolveHarnessSessionId(resumeRef) ?? resumeRef)
      : undefined;
    const activeResumeSession = resumeRef ? this.sessionManager.resolve(resumeRef) : undefined;
    const persistedResumeSession = requestedResumeSessionId
      ? (this.sessionManager.getPersistedSession(requestedResumeSessionId) ?? this.sessionManager.getPersistedSession(resumeRef ?? requestedResumeSessionId))
      : undefined;
    const { resumeSessionId } = decideResumeSessionId({
      requestedResumeSessionId,
      activeSession: activeResumeSession
        ? { harnessSessionId: activeResumeSession.harnessSessionId }
        : undefined,
      persistedSession: persistedResumeSession
        ? {
            harness: persistedResumeSession.harness,
            backendRef: persistedResumeSession.backendRef,
          }
        : undefined,
    });

    const config: SessionConfig = {
      prompt,
      name: task.name,
      workdir: task.workdir,
      model: task.model,
      reasoningEffort: task.reasoningEffort,
      systemPrompt: task.systemPrompt,
      allowedTools: task.allowedTools,
      originChannel: task.originChannel,
      originThreadId: task.originThreadId,
      originAgentId: task.originAgentId,
      originSessionKey: task.originSessionKey,
      route: normalizeRoute(task),
      permissionMode: task.permissionMode as PermissionMode,
      multiTurn: true,
      goalTaskId: task.id,
      harness: task.harness,
      resumeSessionId,
      resumeWorktreeFrom: requestedResumeSessionId,
      // Goal loops intentionally own terminal handling and disable worktree flows.
      worktreeStrategy: "off",
    };
    return this.sessionManager.spawnAndAwaitRunning(config, { notifyLaunch: false });
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
      const resumed = this.sessionManager.resolveHarnessSessionId(task.sessionId);
      if (resumed) return resumed;
    }
    const byName = this.sessionManager.resolveHarnessSessionId(task.name);
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
      } catch (err: unknown) {
        this.markTaskFailed(task, `Failed to resume the goal task after gateway restart: ${errorMessage(err)}`);
      }
    }
  }

  private async runVerifiers(task: GoalTaskState): Promise<GoalVerifierRunResult> {
    if (!hasVerifierCommands(task)) {
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
    for (const command of task.verifierCommands) {
      steps.push(await runCommand(task.workdir, command));
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

  private notifyIterationStatus(task: GoalTaskState, heading: string, session?: Session): void {
    const runtime = buildGoalTaskRuntimeSnapshot(session ?? (task.sessionId ? this.sessionManager.resolve(task.sessionId) : undefined));
    const text = `${heading}\n\n${formatGoalTask(task, runtime)}`;
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
    if (this.observedSessions.has(session.id)) return;
    this.observedSessions.add(session.id);
    session.on("statusChange", (_current, nextStatus) => {
      if (nextStatus === "completed" || nextStatus === "failed" || nextStatus === "killed") {
        this.observedSessions.delete(session.id);
      }
    });

    session.on("turnEnd", () => {
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
    });
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

  private async handleRunningSession(task: GoalTaskState, session: Session): Promise<void> {
    if (session.pendingPlanApproval) {
      // Goal loops are autonomous by design. Approval is resolved before the loop starts;
      // once inside the loop, verifier checks are the approval mechanism and human review
      // would break the contract by stalling the controller.
      const result = await executeRespond(this.sessionManager, {
        session: session.id,
        message: "Approved. Implement the plan.",
        approve: true,
        userInitiated: false,
      });
      if (result.isError) {
        this.markTaskFailed(task, result.text);
      }
      return;
    }

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
    try {
      const resumed = await this.resumeTaskSession(task, prompt, session);
      this.setTaskRunningWithSession(task, resumed);
      this.notifyIterationStatus(task, `🔄 [${task.name}] Goal task resumed after idle timeout`, resumed);
    } catch (err: unknown) {
      this.markTaskFailed(task, `Failed to resume the goal task after idle timeout: ${errorMessage(err)}`);
    }
  }

  private async handleTerminalSession(task: GoalTaskState, session: Session): Promise<void> {
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
        await this.resumeAfterIdleTimeout(
          task,
          session,
          [
            `The previous session hit idle timeout while it was waiting at the plan review step.`,
            `Treat that plan as approved and continue implementation from the existing repository state.`,
          ].join("\n"),
        );
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

        if (task.lastVerifierFingerprint === verifier.fingerprint) {
          task.repeatedFailureCount += 1;
        } else {
          task.repeatedFailureCount = 1;
        }
        task.lastVerifierFingerprint = verifier.fingerprint;

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
        try {
          const resumed = await this.resumeTaskSession(task, prompt, session);
          this.setTaskRunningWithSession(task, resumed);
          this.notifyIterationStatus(task, `🔁 [${task.name}] Completion claimed but verifiers still failed`);
        } catch (err: unknown) {
          this.markTaskFailed(task, `Failed to resume the Ralph goal task after verifier failure: ${errorMessage(err)}`);
        }
        return;
      }

      const latestFingerprint = textFingerprint(output);
      if (task.lastVerifierFingerprint === latestFingerprint) {
        task.repeatedFailureCount += 1;
      } else {
        task.repeatedFailureCount = 1;
      }
      task.lastVerifierFingerprint = latestFingerprint;

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
      try {
        const resumed = await this.resumeTaskSession(task, prompt, session);
        this.setTaskRunningWithSession(task, resumed);
        this.notifyIterationStatus(task, `🔁 [${task.name}] Ralph iteration continued`);
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

    if (task.lastVerifierFingerprint === verifier.fingerprint) {
      task.repeatedFailureCount += 1;
    } else {
      task.repeatedFailureCount = 1;
    }
    task.lastVerifierFingerprint = verifier.fingerprint;

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
    try {
      const resumed = await this.resumeTaskSession(task, prompt, session);
      this.setTaskRunningWithSession(task, resumed);
      this.notifyIterationStatus(task, `🔁 [${task.name}] Repair iteration started after verifier failure`);
    } catch (err: unknown) {
      this.markTaskFailed(task, `Failed to resume the goal task: ${errorMessage(err)}`);
    }
  }

  private async reconcileTask(task: GoalTaskState): Promise<void> {
    if (task.status === "succeeded" || task.status === "failed" || task.status === "stopped") {
      return;
    }
    if (this.inFlight.has(task.id)) return;

    this.inFlight.add(task.id);
    try {
      const session = task.sessionId ? this.sessionManager.resolve(task.sessionId) : undefined;
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
    }
  }

  async reconcileAll(): Promise<void> {
    if (this.restorePromise) {
      await this.restorePromise;
    }
    for (const task of this.store.list()) {
      await this.reconcileTask(task);
    }
  }
}
