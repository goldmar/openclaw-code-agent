/**
 * Shared type definitions for the pipeline orchestration system.
 *
 * @module pipeline-types
 */

/** Pipeline stage kinds in execution order. */
export type PipelineStageKind = "codex-plan" | "claude-implement" | "codex-review" | "claude-fix";

/** Review verdict emitted by the codex-review stage. */
export interface ReviewVerdict {
  verdict: "pass" | "critical" | "needs-human";
  summary: string;
  criticalIssues: string[];
  fixInstructions?: string;
}

/** Record of a single pipeline stage execution. */
export interface PipelineStageRecord {
  kind: PipelineStageKind;
  iteration: number;
  /** Which harness ran this stage. */
  harness?: "codex" | "claude-code";
  sessionId?: string;
  status: "starting" | "running" | "completed" | "failed" | "killed";
  startedAt: number;
  completedAt?: number;
  output?: string;
  error?: string;
  verdict?: ReviewVerdict;
}

/** Pipeline run status. */
export type PipelineStatus = "starting" | "running" | "completed" | "failed" | "killed" | "blocked";

/** Full pipeline run state (serializable for persistence). */
export interface PipelineRun {
  id: string;
  name: string;
  prompt: string;
  workdir: string;
  worktreePath?: string;
  originalWorkdir?: string;
  maxIterations: number;
  status: PipelineStatus;
  stages: PipelineStageRecord[];
  startedAt: number;
  completedAt?: number;
  error?: string;
  originChannel?: string;
  originThreadId?: string | number;
  originAgentId?: string;
  originSessionKey?: string;
}
