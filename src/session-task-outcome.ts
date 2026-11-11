import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { runGit } from "./git-exec";

export type TaskCheckStatus = "passed" | "failed" | "timed_out" | "not_run" | "not_applicable";
export interface TaskCheckReceipt {
  name: string;
  scope: string;
  required: boolean;
  status: TaskCheckStatus;
  stage: string;
  evidence: string;
  source: "reviewed_receipt" | "oca_verifier";
  exitCode?: number;
}

export interface TaskOutcomeInput {
  executionCycle: number;
  task: "completed" | "incomplete" | "blocked" | "failed";
  checks: TaskCheckReceipt[];
  repositories: Array<{ workdir: string; head: string }>;
  blockers: string[];
  remainingWork: string[];
  summary: string;
}

export interface TaskOutcomeReviewer {
  source: "orchestrator" | "goal_controller";
  sessionKey?: string;
  agentId?: string;
}

export interface TaskOutcomeReport extends TaskOutcomeInput {
  schemaVersion: 1;
  verification: "passed" | "failed" | "blocked" | "unknown";
  reviewedAt: string;
  reviewer: TaskOutcomeReviewer;
}

export interface TaskOutcomeSession {
  status?: string;
  startedAt?: number;
  createdAt?: number;
  workdir?: string;
  originalWorkdir?: string;
  worktreePath?: string;
  pendingPlanApproval?: boolean;
  taskOutcome?: TaskOutcomeReport;
}

const INPUT_KEYS = new Set(["executionCycle", "task", "checks", "repositories", "blockers", "remainingWork", "summary"]);
const CHECK_KEYS = new Set(["name", "scope", "required", "status", "stage", "evidence", "source", "exitCode"]);
const TASKS = new Set(["completed", "incomplete", "blocked", "failed"]);
const CHECK_STATUSES = new Set(["passed", "failed", "timed_out", "not_run", "not_applicable"]);
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 16_000;
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(text);
}
function onlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

export function executionCycle(session: TaskOutcomeSession): number {
  return session.startedAt ?? session.createdAt ?? 0;
}

export function taskVerification(checks: readonly TaskCheckReceipt[]): TaskOutcomeReport["verification"] {
  const required = checks.filter((check) => check.required);
  if (!required.length) return "unknown";
  if (required.some((check) => check.status === "failed")) return "failed";
  if (required.some((check) => check.status === "timed_out" || check.status === "not_run")) return "blocked";
  return "passed";
}

export function parseTaskOutcomeInput(value: unknown): { ok: true; value: TaskOutcomeInput } | { ok: false; error: string } {
  const invalid = (error: string) => ({ ok: false as const, error });
  if (!record(value) || !onlyKeys(value, INPUT_KEYS)) return invalid("Unexpected task outcome fields.");
  if (!Number.isSafeInteger(value.executionCycle) || Number(value.executionCycle) <= 0) return invalid("executionCycle must identify the current execution.");
  if (typeof value.task !== "string" || !TASKS.has(value.task)) return invalid("Unknown task outcome.");
  if (!text(value.summary) || !strings(value.blockers) || !strings(value.remainingWork)) return invalid("Provide a summary, blockers and remainingWork arrays.");
  if (!Array.isArray(value.checks) || value.checks.length > 100) return invalid("checks must be a bounded receipt array.");
  for (const check of value.checks) {
    if (!record(check) || !onlyKeys(check, CHECK_KEYS)
      || !text(check.name) || !text(check.scope) || !text(check.stage) || !text(check.evidence)
      || typeof check.required !== "boolean" || typeof check.status !== "string" || !CHECK_STATUSES.has(check.status)
      || (check.source !== "reviewed_receipt" && check.source !== "oca_verifier")
      || (check.exitCode !== undefined && !Number.isSafeInteger(check.exitCode))) {
      return invalid("Every check needs scope, stage, result, evidence and source.");
    }
    if (check.status === "passed" && check.exitCode !== undefined && check.exitCode !== 0) return invalid("A passing check cannot have a nonzero exit code.");
    if (check.status === "failed" && check.exitCode === 0) return invalid("A failed check cannot have exit code zero.");
    if ((check.status === "not_run" || check.status === "not_applicable") && check.exitCode !== undefined) return invalid("An unrun or inapplicable check has no exit code.");
  }
  if (!Array.isArray(value.repositories) || value.repositories.length > 20) return invalid("repositories must be a bounded repository snapshot array.");
  const paths = new Set<string>();
  for (const repo of value.repositories) {
    if (!record(repo) || !onlyKeys(repo, new Set(["workdir", "head"])) || !text(repo.workdir)
      || !isAbsolute(repo.workdir) || typeof repo.head !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(repo.head)
      || paths.has(repo.workdir)) return invalid("Repositories need unique absolute workdirs and full Git heads.");
    paths.add(repo.workdir);
  }
  const input = value as unknown as TaskOutcomeInput;
  if (input.task === "completed" && (input.blockers.length || input.remainingWork.length || taskVerification(input.checks) !== "passed")) {
    return invalid("Task completion requires passing required verification and no blockers or remaining work.");
  }
  if (input.task !== "completed" && !input.blockers.length && !input.remainingWork.length) return invalid("An unfinished task must describe its blockers or remaining work.");
  return { ok: true, value: structuredClone(input) };
}

export function createTaskOutcomeReport(input: TaskOutcomeInput, reviewer: TaskOutcomeReviewer): TaskOutcomeReport {
  return {
    ...structuredClone(input),
    schemaVersion: 1,
    verification: taskVerification(input.checks),
    reviewedAt: new Date().toISOString(),
    reviewer: { ...reviewer },
  };
}

/** Invalid or legacy report data cannot authorize success after restore. */
export function normalizeTaskOutcomeReport(value: unknown): TaskOutcomeReport | undefined {
  if (!record(value) || value.schemaVersion !== 1 || !text(value.reviewedAt) || !Number.isFinite(Date.parse(value.reviewedAt))) return undefined;
  if (!record(value.reviewer) || (value.reviewer.source !== "orchestrator" && value.reviewer.source !== "goal_controller")) return undefined;
  if ((value.reviewer.sessionKey !== undefined && !text(value.reviewer.sessionKey)) || (value.reviewer.agentId !== undefined && !text(value.reviewer.agentId))) return undefined;
  const parsed = parseTaskOutcomeInput(Object.fromEntries([...INPUT_KEYS].map((key) => [key, value[key]])));
  if (parsed.ok === false || value.verification !== taskVerification(parsed.value.checks)) return undefined;
  return { ...parsed.value, schemaVersion: 1, verification: taskVerification(parsed.value.checks), reviewedAt: value.reviewedAt,
    reviewer: { source: value.reviewer.source, ...(value.reviewer.sessionKey ? { sessionKey: String(value.reviewer.sessionKey) } : {}),
      ...(value.reviewer.agentId ? { agentId: String(value.reviewer.agentId) } : {}) } };
}

export function hasVerifiedTaskOutcome(session: TaskOutcomeSession): boolean {
  const report = normalizeTaskOutcomeReport(session.taskOutcome);
  return session.status === "completed" && !session.pendingPlanApproval && Boolean(report
    && report.executionCycle === executionCycle(session)
    && report.task === "completed" && report.verification === "passed"
    && report.blockers.length === 0 && report.remainingWork.length === 0);
}

function canonicalPath(path: string): string | undefined {
  try { return realpathSync(path); } catch { return undefined; }
}

function hasGitMarker(workdir: string): boolean {
  const taskDirectory = canonicalPath(workdir);
  for (let dir = taskDirectory; dir; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      try {
        // An empty .git directory is also used as a Git-discovery ceiling for
        // non-repository scratch space. A populated or unreadable marker must
        // fail closed when Git cannot inspect it.
        return dir === taskDirectory || !statSync(dotGit).isDirectory() || readdirSync(dotGit).length > 0;
      } catch { return true; }
    }
    if (dirname(dir) === dir) return false;
  }
  return false;
}

async function gitSnapshot(workdir: string): Promise<{ root: string; head: string; dirty: boolean } | undefined> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  env.GIT_OPTIONAL_LOCKS = "0";
  try {
    const options = { cwd: workdir, timeout: 5_000, env };
    const root = canonicalPath((await runGit(["rev-parse", "--show-toplevel"], options)).trim());
    const head = (await runGit(["rev-parse", "--verify", "HEAD"], options)).trim();
    const dirty = Boolean((await runGit(["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=normal"], options)).trim());
    return root ? { root, head, dirty } : undefined;
  } catch { return undefined; }
}

/** Capture the checkout before a controller-owned verifier run; never infer non-Git from an unavailable Git checkout. */
export async function captureTaskOutcomeRepositories(workdir: string): Promise<TaskOutcomeInput["repositories"]> {
  try {
    if (!statSync(workdir).isDirectory()) throw new Error("not a directory");
  } catch { throw new Error("The task checkout is missing or unavailable."); }
  const snapshot = await gitSnapshot(workdir);
  if (!snapshot) {
    if (hasGitMarker(workdir)) throw new Error("The task Git checkout could not be inspected.");
    return [];
  }
  return [{ workdir: snapshot.root, head: snapshot.head }];
}

/** Read-only, fail-closed validation; receipt contents remain the reviewer's responsibility. */
export async function validateTaskOutcomeSnapshot(session: TaskOutcomeSession, report: TaskOutcomeInput): Promise<string | undefined> {
  const parsed = parseTaskOutcomeInput(Object.fromEntries([...INPUT_KEYS].map((key) => [key, report[key as keyof TaskOutcomeInput]])));
  if (parsed.ok === false) return parsed.error;
  if (session.status !== "completed" || session.pendingPlanApproval) return "Execution must end and its plan decision must be resolved before reporting a task outcome.";
  if (executionCycle(session) !== report.executionCycle) return "Task outcome belongs to a different execution cycle.";
  // An unfinished task must be able to report lost checkouts and historical
  // receipts as blockers. Only success evidence can authorize integration.
  if (report.task !== "completed") return undefined;
  const workdir = session.worktreePath ?? session.workdir ?? session.originalWorkdir;
  try {
    if (!workdir || !statSync(workdir).isDirectory()) return "The session checkout is unknown or missing.";
  } catch { return "The session checkout is unknown or missing."; }
  const primary = await gitSnapshot(workdir);
  if (!primary && (session.worktreePath || hasGitMarker(workdir))) return "The session worktree cannot be inspected.";
  const roots = new Set<string>();
  for (const repo of report.repositories) {
    const snapshot = await gitSnapshot(repo.workdir);
    const root = canonicalPath(repo.workdir);
    if (!snapshot || !root || snapshot.root !== root || roots.has(root)) return "A reported repository is missing, ambiguous, or not its checkout root.";
    roots.add(root);
    if (snapshot.head !== repo.head) return "A repository head changed after the reported verification.";
    if (snapshot.dirty) return "A reported repository has uncommitted changes; integration readiness is not established.";
  }
  if (primary && !roots.has(primary.root)) return "The report must include the session's current checkout and full Git head.";
  if (executionCycle(session) !== report.executionCycle || session.status !== "completed") return "The session resumed while its evidence was being checked.";
  return undefined;
}

export async function isTaskOutcomeCurrent(session: TaskOutcomeSession): Promise<boolean> {
  const report = session.taskOutcome;
  return Boolean(report && hasVerifiedTaskOutcome(session)
    && !(await validateTaskOutcomeSnapshot(session, report))
    && session.taskOutcome === report && hasVerifiedTaskOutcome(session));
}
