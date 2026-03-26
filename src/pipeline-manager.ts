/**
 * Pipeline orchestration manager (event-driven).
 *
 * Runs a multi-stage pipeline: Codex plan → Claude implement → Codex review,
 * with optional fix iterations when the review finds critical issues.
 *
 * Each stage is a normal session spawned via SessionManager.spawn(). Stage
 * transitions are driven by `statusChange` events — no polling, no blocking
 * loops, no waitForSession().
 *
 * @module pipeline-manager
 */

import { appendFileSync } from "fs";
import { nanoid } from "nanoid";
import { Session } from "./session";
import { sessionManager } from "./singletons";
import {
  pluginConfig,
  resolveReasoningEffortForHarness,
} from "./config";
import { isGitRepoWithRemote, createWorktree, removeWorktree } from "./worktree";
import { generateSessionName } from "./format";
import type { SessionConfig, SessionStatus } from "./types";
import type {
  PipelineRun,
  PipelineStageKind,
  PipelineStageRecord,
  ReviewVerdict,
} from "./pipeline-types";

const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);

/** Per-stage timeout in ms. */
const STAGE_TIMEOUT_MS = 600_000;

// -- Stage prompt templates --

const NO_QUESTIONS = "Do NOT ask questions. Make reasonable assumptions and proceed.";

function codexPlanPrompt(task: string): string {
  return [
    "Analyze this problem and write a detailed implementation plan. DO NOT implement anything.",
    "",
    `Task: ${task}`,
    "",
    "1. Read all relevant files",
    "2. Identify root cause/approach",
    "3. List every file to change with code snippets",
    "4. Note edge cases and risks",
    "",
    NO_QUESTIONS,
  ].join("\n");
}

function claudeImplementPrompt(planOutput: string, task: string): string {
  return [
    "Implement this plan:",
    "",
    planOutput,
    "",
    `Original task: ${task}`,
    "",
    "After implementing, create a git commit.",
    "",
    NO_QUESTIONS,
  ].join("\n");
}

function codexReviewPrompt(): string {
  return [
    "Review the code changes just made. Run `git diff HEAD~1`.",
    "",
    "Check for: bugs, edge cases, security, performance, code quality.",
    "",
    "At the end of your review, output this EXACT JSON block:",
    "PIPELINE_REVIEW_JSON",
    '{"verdict":"pass","summary":"...","criticalIssues":[],"fixInstructions":""}',
    'Use "pass" if no critical issues, "critical" if there are bugs/security issues, "needs-human" if unsure.',
    "",
    NO_QUESTIONS,
  ].join("\n");
}

function claudeFixPrompt(reviewOutput: string): string {
  return [
    "Fix these critical issues found in code review:",
    "",
    reviewOutput,
    "",
    "Fix ONLY the critical issues. Create a git commit.",
    "",
    NO_QUESTIONS,
  ].join("\n");
}

// -- Review verdict parser --

/**
 * Parse the review verdict from agent output.
 *
 * Uses a bounded brace-matching parser instead of a greedy regex so that
 * trailing prose after the JSON object does not corrupt the parse.
 */
export function parseReviewVerdict(output: string): ReviewVerdict | undefined {
  const marker = "PIPELINE_REVIEW_JSON";
  const idx = output.lastIndexOf(marker);
  if (idx < 0) return undefined;

  const after = output.slice(idx + marker.length).trim();

  const start = after.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let end = -1;
  for (let i = start; i < after.length; i++) {
    if (after[i] === "{") depth++;
    else if (after[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return undefined;

  try {
    const raw = JSON.parse(after.slice(start, end)) as Record<string, unknown>;
    const verdict = raw.verdict;
    if (verdict !== "pass" && verdict !== "critical" && verdict !== "needs-human") {
      return undefined;
    }
    return {
      verdict,
      summary: typeof raw.summary === "string" ? raw.summary : "",
      criticalIssues: Array.isArray(raw.criticalIssues)
        ? (raw.criticalIssues as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      fixInstructions: typeof raw.fixInstructions === "string" ? raw.fixInstructions : undefined,
    };
  } catch {
    return undefined;
  }
}

// -- Logging --

function pipelineLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [PipelineManager] ${msg}\n`;
  console.log(line.trim());
  try { appendFileSync("/tmp/pipeline-debug.log", line); } catch {}
}

// -- Internal tracking for active stage --

interface ActiveStage {
  session: Session;
  record: PipelineStageRecord;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Event-driven pipeline orchestrator.
 *
 * Each stage is a normal session. Stage transitions happen in statusChange
 * event callbacks — no polling or blocking loops.
 */
export class PipelineManager {
  private runs: Map<string, PipelineRun> = new Map();
  /** Map from pipeline ID to the currently active stage (for timeout cleanup). */
  private activeStages: Map<string, ActiveStage> = new Map();

  list(): PipelineRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): PipelineRun | undefined {
    return this.runs.get(id);
  }

  /**
   * Launch a new pipeline. Returns immediately with the run.
   * All stage transitions happen asynchronously via event callbacks.
   */
  launch(params: {
    prompt: string;
    workdir: string;
    name?: string;
    worktree?: boolean;
    maxIterations?: number;
    originChannel?: string;
    originThreadId?: string | number;
    originAgentId?: string;
    originSessionKey?: string;
  }): PipelineRun {
    if (!sessionManager) {
      throw new Error("SessionManager not initialized. The code-agent service must be running.");
    }

    const id = nanoid(8);
    const name = params.name || `pipeline-${generateSessionName(params.prompt)}`;
    const maxIterations = params.maxIterations ?? 2;

    // Create shared worktree for all stages
    let actualWorkdir = params.workdir;
    let worktreePath: string | undefined;
    let originalWorkdir: string | undefined;
    const worktreeExplicit = params.worktree === true;
    const shouldWorktree = params.worktree !== false;
    if (shouldWorktree && isGitRepoWithRemote(params.workdir)) {
      const uniqueName = `${name}-${Date.now()}`;
      try {
        worktreePath = createWorktree(params.workdir, uniqueName);
        actualWorkdir = worktreePath;
        originalWorkdir = params.workdir;
        pipelineLog(`Created shared worktree at ${worktreePath}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (worktreeExplicit) {
          throw new Error(`Pipeline requires a worktree but creation failed: ${msg}`);
        }
        pipelineLog(`WARN: Failed to create worktree: ${msg}, using original workdir`);
      }
    }

    const run: PipelineRun = {
      id,
      name,
      prompt: params.prompt,
      workdir: actualWorkdir,
      worktreePath,
      originalWorkdir,
      maxIterations,
      status: "starting",
      stages: [],
      startedAt: Date.now(),
      originChannel: params.originChannel,
      originThreadId: params.originThreadId,
      originAgentId: params.originAgentId,
      originSessionKey: params.originSessionKey,
    };

    this.runs.set(id, run);

    // Kick off Stage 1
    run.status = "running";
    pipelineLog(`Pipeline ${id} starting: ${name}`);
    this.sendStatus(run, `🔧 Pipeline started: ${name}`);
    this.sendStatus(run, `📋 Stage 1/3: Codex analyzing and planning...`);

    try {
      this.spawnStage(run, {
        kind: "codex-plan",
        harness: "codex",
        prompt: codexPlanPrompt(run.prompt),
        iteration: 0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finalizePipeline(run, "failed", `Failed to spawn Stage 1: ${msg}`);
    }

    return run;
  }

  /**
   * Spawn a single stage session and wire up the statusChange listener.
   */
  private spawnStage(
    run: PipelineRun,
    spec: { kind: PipelineStageKind; harness: "codex" | "claude-code"; prompt: string; iteration: number },
  ): void {
    if (!sessionManager) {
      throw new Error("SessionManager not initialized");
    }

    const stage: PipelineStageRecord = {
      kind: spec.kind,
      iteration: spec.iteration,
      harness: spec.harness,
      status: "starting",
      startedAt: Date.now(),
    };
    run.stages.push(stage);

    const sessionConfig: SessionConfig = {
      prompt: spec.prompt,
      workdir: run.workdir,
      name: `${run.name}-${spec.kind}${spec.iteration > 0 ? `-${spec.iteration}` : ""}`,
      harness: spec.harness,
      multiTurn: false,
      worktree: false,
      permissionMode: "bypassPermissions",
      codexApprovalPolicy: spec.harness === "codex" ? "never" : undefined,
      reasoningEffort: resolveReasoningEffortForHarness(spec.harness),
      originChannel: run.originChannel,
      originThreadId: run.originThreadId,
      originAgentId: run.originAgentId,
      originSessionKey: run.originSessionKey,
      notificationsEnabled: false,
    };

    let session: Session;
    try {
      session = sessionManager.spawn(sessionConfig, { notifyLaunch: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pipelineLog(`ERROR: Failed to spawn stage ${spec.kind}: ${msg}`);
      stage.status = "failed";
      stage.error = msg;
      stage.completedAt = Date.now();
      throw err;
    }

    stage.sessionId = session.id;
    stage.status = "running";
    pipelineLog(`Stage ${spec.kind} spawned: session=${session.id} name=${session.name}`);

    // Set up a timeout for this stage
    const timeout = setTimeout(() => {
      pipelineLog(`TIMEOUT: Stage ${spec.kind} session=${session.id} did not complete within ${STAGE_TIMEOUT_MS / 1000}s`);
      // Kill the session — this will trigger the statusChange listener
      if (session.status !== "completed" && session.status !== "failed" && session.status !== "killed") {
        session.kill("idle-timeout");
      }
    }, STAGE_TIMEOUT_MS);

    this.activeStages.set(run.id, { session, record: stage, timeout });

    // Wire up the event-driven transition
    const onStatusChange = (_s: Session, newStatus: SessionStatus) => {
      if (!TERMINAL_STATUSES.has(newStatus)) return;

      // Clean up listener and timeout
      session.removeListener("statusChange", onStatusChange);
      clearTimeout(timeout);
      this.activeStages.delete(run.id);

      // Record stage completion
      stage.completedAt = Date.now();

      if (newStatus === "completed") {
        stage.output = session.getOutput().join("\n");
        stage.status = "completed";
        pipelineLog(`Stage ${spec.kind} completed: session=${session.id}`);
        this.onStageCompleted(run, spec.kind, spec.iteration, stage.output);
      } else {
        stage.status = "failed";
        stage.error = session.error || `Session ended with status: ${newStatus}`;
        pipelineLog(`Stage ${spec.kind} failed: session=${session.id} status=${newStatus} error=${stage.error}`);
        this.finalizePipeline(run, "failed", `Stage ${spec.kind} failed: ${stage.error}`);
      }
    };

    session.on("statusChange", onStatusChange);
  }

  /**
   * Called when a stage completes successfully. Determines and spawns the next stage.
   */
  private onStageCompleted(
    run: PipelineRun,
    kind: PipelineStageKind,
    iteration: number,
    output: string,
  ): void {
    try {
      switch (kind) {
        case "codex-plan": {
          this.sendStatus(run, `✅ Codex plan complete. Launching Claude Code implementation...`);
          this.sendStatus(run, `🔨 Stage 2/3: Claude Code implementing...`);
          this.spawnStage(run, {
            kind: "claude-implement",
            harness: "claude-code",
            prompt: claudeImplementPrompt(output, run.prompt),
            iteration: 0,
          });
          break;
        }

        case "claude-implement": {
          this.sendStatus(run, `✅ Implementation complete. Launching Codex review...`);
          this.sendStatus(run, `🔍 Stage 3/3: Codex reviewing changes...`);
          this.spawnStage(run, {
            kind: "codex-review",
            harness: "codex",
            prompt: codexReviewPrompt(),
            iteration: 0,
          });
          break;
        }

        case "codex-review": {
          const verdict = parseReviewVerdict(output);

          if (!verdict) {
            this.sendStatus(run, `⚠️ Could not parse review verdict. Treating as needs-human.`);
            this.finalizePipeline(run, "blocked", "Could not parse review verdict. Manual review needed.");
            return;
          }

          if (verdict.verdict === "pass") {
            this.finalizePipeline(run, "completed", undefined, verdict.summary);
            return;
          }

          if (verdict.verdict === "needs-human") {
            this.finalizePipeline(run, "blocked", `Codex review requires human judgment.\n\nSummary: ${verdict.summary}`);
            return;
          }

          // verdict === "critical"
          if (iteration >= run.maxIterations - 1) {
            const issueList = verdict.criticalIssues.length > 0
              ? verdict.criticalIssues.join("\n- ")
              : verdict.summary || "No specific issues listed";
            this.finalizePipeline(
              run,
              "blocked",
              `Max fix iterations (${run.maxIterations}) reached — needs human judgment.\n\n` +
              `**Codex review summary:** ${verdict.summary || "(no summary)"}\n\n` +
              `**Remaining issues:**\n- ${issueList}\n\n` +
              `Reply with instructions to redirect the fix approach, or approve to ship as-is.`
            );
            return;
          }

          const fixRound = iteration + 1;
          this.sendStatus(run, `🔴 Codex found critical issues. Launching fix round ${fixRound}...`);
          this.sendStatus(run, `🔨 Fix round ${fixRound}: Claude Code fixing issues...`);
          this.spawnStage(run, {
            kind: "claude-fix",
            harness: "claude-code",
            prompt: claudeFixPrompt(output),
            iteration: fixRound,
          });
          break;
        }

        case "claude-fix": {
          this.sendStatus(run, `✅ Fix round ${iteration} complete. Re-reviewing...`);
          this.sendStatus(run, `🔍 Re-review: Codex checking fixes...`);
          this.spawnStage(run, {
            kind: "codex-review",
            harness: "codex",
            prompt: codexReviewPrompt(),
            iteration,
          });
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finalizePipeline(run, "failed", `Failed to spawn next stage after ${kind}: ${msg}`);
    }
  }

  /**
   * Finalize a pipeline run: set terminal status, send notification, clean up worktree.
   */
  private finalizePipeline(
    run: PipelineRun,
    status: "completed" | "failed" | "blocked",
    error?: string,
    summary?: string,
  ): void {
    run.status = status;
    run.completedAt = Date.now();
    if (error) run.error = error;

    // Clean up any active stage timeout
    const active = this.activeStages.get(run.id);
    if (active) {
      clearTimeout(active.timeout);
      this.activeStages.delete(run.id);
    }

    // Send final status
    if (status === "completed") {
      this.sendStatus(run, `✅ Pipeline complete! All stages passed.\n\nSummary: ${summary || "(no summary)"}`);
    } else if (status === "blocked") {
      this.sendStatus(run, `🟡 Pipeline blocked: ${error || "Unknown reason"}`);
    } else {
      const lastStage = run.stages[run.stages.length - 1];
      const stageLabel = lastStage ? lastStage.kind : "unknown";
      this.sendStatus(run, `❌ Pipeline failed at ${stageLabel}: ${error || "Unknown error"}`);
    }

    // Clean up shared worktree
    if (run.worktreePath && run.originalWorkdir) {
      try {
        removeWorktree(run.originalWorkdir, run.worktreePath);
        pipelineLog(`Cleaned up worktree at ${run.worktreePath}`);
      } catch (err) {
        pipelineLog(`WARN: Failed to clean up worktree: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    pipelineLog(`Pipeline ${run.id} finalized: ${status}${error ? ` — ${error}` : ""}`);

    // Auto-purge from map after 1 hour
    setTimeout(() => this.runs.delete(run.id), 3_600_000);
  }

  /** Send a status message for a pipeline run. */
  private sendStatus(run: PipelineRun, text: string): void {
    if (!sessionManager) return;

    const proxySession = {
      id: run.id,
      name: run.name,
      originChannel: run.originChannel,
      originThreadId: run.originThreadId,
      originAgentId: run.originAgentId,
      originSessionKey: run.originSessionKey,
    } as Session;

    sessionManager.notifySession(proxySession, text, "pipeline");
  }
}
