import { existsSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { saveJsonFile } from "openclaw/plugin-sdk/json-store";
import { resolveOpenClawStateDir } from "./state-paths";
import { assertTestSafeStatePath } from "./test-state-guard";

import type { GoalTaskState, SessionRoute } from "./types";
import { createLogger } from "./logger";

const log = createLogger("goal-store");

const GOAL_TASK_STATUSES: ReadonlySet<GoalTaskState["status"]> = new Set([
  "awaiting_verifier_confirmation",
  "running",
  "waiting_for_session",
  "waiting_for_plan_approval",
  "waiting_for_user",
  "succeeded",
  "failed",
  "stopped",
]);

function isTerminalTask(task: { status: unknown }): boolean {
  return task.status === "succeeded" || task.status === "failed" || task.status === "stopped";
}

function resolveGoalTasksPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH?.trim();
  if (explicit) return explicit;
  return join(resolveOpenClawStateDir(env), "code-agent-goal-tasks.json");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return Boolean(raw) && typeof raw === "object" && !Array.isArray(raw);
}

const GOAL_TASK_ARCHIVE_COLLISION_SUFFIX_LIMIT = 100;

function goalTaskArchivePath(path: string, now: number, suffix?: number): string {
  const suffixSegment = suffix == null ? "" : `-${suffix}`;
  return `${path}.invalid-${now}${suffixSegment}.json`;
}

function availableGoalTaskArchivePath(path: string): string | undefined {
  if (!existsSync(path)) return undefined;

  const now = Date.now();
  const basePath = goalTaskArchivePath(path, now);
  if (!existsSync(basePath)) return basePath;

  for (let suffix = 1; suffix <= GOAL_TASK_ARCHIVE_COLLISION_SUFFIX_LIMIT; suffix += 1) {
    const candidate = goalTaskArchivePath(path, now, suffix);
    if (!existsSync(candidate)) return candidate;
  }

  return undefined;
}

function archiveGoalTasksFile(path: string, reason: string): boolean {
  assertTestSafeStatePath(path, "archive the goal task store");
  try {
    const archivedPath = availableGoalTaskArchivePath(path);
    if (!archivedPath) {
      if (existsSync(path)) {
        log.warn("[GoalTaskStore] Failed to archive goal task store: no available archive path");
      }
      return false;
    }
    renameSync(path, archivedPath);
    log.warn(`[GoalTaskStore] Archived ${reason} goal task store to ${archivedPath}.`);
    return true;
  } catch (err: unknown) {
    log.warn(`[GoalTaskStore] Failed to archive goal task store: ${errorMessage(err)}`);
    return false;
  }
}

export const goalStoreInternals = {
  archiveGoalTasksFile,
  GOAL_TASK_ARCHIVE_COLLISION_SUFFIX_LIMIT,
};

function normalizeRoute(raw: unknown): SessionRoute | undefined {
  if (!isRecord(raw)) return undefined;
  const value = raw;
  if (typeof value.provider !== "string" || typeof value.target !== "string") return undefined;
  return {
    provider: value.provider,
    target: value.target,
    accountId: typeof value.accountId === "string" ? value.accountId : undefined,
    threadId: typeof value.threadId === "string" ? value.threadId : undefined,
    sessionKey: typeof value.sessionKey === "string" ? value.sessionKey : undefined,
  };
}

function normalizeTask(raw: unknown): GoalTaskState | undefined {
  if (!isRecord(raw)) return undefined;
  const value = raw;
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.goal !== "string") return undefined;
  if (typeof value.workdir !== "string" || typeof value.status !== "string") return undefined;
  if (!GOAL_TASK_STATUSES.has(value.status as GoalTaskState["status"])) return undefined;

  const status = value.status;
  // A running task, or one whose plan still waits for a decision, resumes its
  // session after a restart (the resumed session presents its plan again).
  const resumedStatus =
    status === "running" || status === "waiting_for_session" || status === "waiting_for_plan_approval"
      ? "waiting_for_session"
      : status;

  return {
    id: value.id,
    name: value.name,
    goal: value.goal,
    workdir: value.workdir,
    status: resumedStatus as GoalTaskState["status"],
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
    iteration: typeof value.iteration === "number" ? value.iteration : 0,
    maxIterations: typeof value.maxIterations === "number" ? value.maxIterations : 8,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    sessionName: typeof value.sessionName === "string" ? value.sessionName : undefined,
    harnessSessionId: typeof value.harnessSessionId === "string" ? value.harnessSessionId : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort as GoalTaskState["reasoningEffort"] : undefined,
    fastMode: value.fastMode === true ? true : undefined,
    systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : undefined,
    allowedTools: Array.isArray(value.allowedTools) ? value.allowedTools.filter((item): item is string => typeof item === "string") : undefined,
    originChannel: typeof value.originChannel === "string" ? value.originChannel : undefined,
    originThreadId:
      typeof value.originThreadId === "string" || typeof value.originThreadId === "number"
        ? value.originThreadId
        : undefined,
    originAgentId: typeof value.originAgentId === "string" ? value.originAgentId : undefined,
    originSessionKey: typeof value.originSessionKey === "string" ? value.originSessionKey : undefined,
    route: normalizeRoute(value.route),
    harness: typeof value.harness === "string" ? value.harness : undefined,
    permissionMode: typeof value.permissionMode === "string" ? value.permissionMode as GoalTaskState["permissionMode"] : undefined,
    loopMode: value.loopMode === "ralph" ? "ralph" : "verifier",
    completionPromise: typeof value.completionPromise === "string" ? value.completionPromise : undefined,
    // Keep raw selection evidence, including malformed entries. Policy validation
    // rejects active invalid tasks before normalization; history is never sanitized.
    verifierCommands: (Object.hasOwn(value, "verifierCommands") ? value.verifierCommands : []) as GoalTaskState["verifierCommands"],
    ...(Object.hasOwn(value, "goalVerificationBinding")
      ? { goalVerificationBinding: value.goalVerificationBinding as GoalTaskState["goalVerificationBinding"] } : {}),
    ...(Object.hasOwn(value, "requiredVerifierCommands")
      ? { requiredVerifierCommands: value.requiredVerifierCommands as string[] } : {}),
    lastVerifierSummary: typeof value.lastVerifierSummary === "string" ? value.lastVerifierSummary : undefined,
    lastVerifierFingerprint: typeof value.lastVerifierFingerprint === "string" ? value.lastVerifierFingerprint : undefined,
    repeatedFailureCount: typeof value.repeatedFailureCount === "number" ? value.repeatedFailureCount : 0,
    waitingForUserReason: typeof value.waitingForUserReason === "string" ? value.waitingForUserReason : undefined,
    failureReason: typeof value.failureReason === "string" ? value.failureReason : undefined,
    planApproved: value.planApproved === true ? true : undefined,
    maxCostUsd: typeof value.maxCostUsd === "number" && value.maxCostUsd > 0 ? value.maxCostUsd : undefined,
    totalCostUsd: typeof value.totalCostUsd === "number" && value.totalCostUsd >= 0 ? value.totalCostUsd : undefined,
    lastCostedRun: typeof value.lastCostedRun === "string" ? value.lastCostedRun : undefined,
  };
}

function normalizeTaskStore(raw: unknown): GoalTaskState[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  // A duplicate persisted ID cannot identify an authoritative owner. Reject the
  // entire file before normalization or Map insertion can discard either row.
  const ids = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string" || ids.has(item.id)) return undefined;
    ids.add(item.id);
  }

  const tasks: GoalTaskState[] = [];
  for (const item of raw) {
    const task = normalizeTask(item);
    if (!task) return undefined;
    tasks.push(task);
  }
  return tasks;
}

export class GoalTaskStore {
  private readonly path: string;
  private readonly tasks: Map<string, GoalTaskState> = new Map();
  private readonly terminalRows: Map<string, Record<string, unknown>> = new Map();
  private writesBlocked = false;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.path = resolveGoalTasksPath(env);
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const tasks = normalizeTaskStore(parsed);
      if (!tasks) {
        this.archiveInvalidStore("invalid");
        return;
      }

      this.tasks.clear();
      for (const [index, task] of tasks.entries()) {
        this.tasks.set(task.id, task);
        if (isTerminalTask(task)) {
          // Read compatibility defaults must never replace original evidence,
          // including unknown metadata, malformed checks and absent fields.
          this.terminalRows.set(task.id, structuredClone((parsed as Record<string, unknown>[])[index]!));
        }
      }
      this.save();
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      this.archiveInvalidStore("corrupt or unreadable");
    }
  }

  private archiveInvalidStore(reason: string): void {
    if (archiveGoalTasksFile(this.path, reason)) this.save();
    else this.writesBlocked = true;
  }

  private assertWritable(): void {
    if (this.writesBlocked) {
      throw new Error("Goal task store is unavailable: invalid saved evidence could not be archived.");
    }
  }

  save(): void {
    this.assertWritable();
    assertTestSafeStatePath(this.path, "write the goal task store");
    try {
      saveJsonFile(this.path, [...this.tasks.values()].map((task) => this.terminalRows.get(task.id) ?? task));
    } catch (err: unknown) {
      log.warn(`[GoalTaskStore] Failed to save ${this.path}: ${errorMessage(err)}`);
    }
  }

  upsert(task: GoalTaskState): void {
    this.assertWritable();
    if (this.terminalRows.has(task.id)) {
      if (!isTerminalTask(task)) throw new Error("A terminal goal task identity cannot be reused.");
      // Repeated terminal notifications/upserts remain harmless and idempotent.
      return;
    }
    if (isTerminalTask(task)) {
      // Capture exactly the JSON record emitted at the terminal transition.
      this.terminalRows.set(task.id, JSON.parse(JSON.stringify(task)) as Record<string, unknown>);
      this.tasks.set(task.id, structuredClone(task));
    } else this.tasks.set(task.id, task);
    this.save();
  }

  private readTask(task: GoalTaskState): GoalTaskState {
    return this.terminalRows.has(task.id) ? structuredClone(task) : task;
  }

  get(ref: string): GoalTaskState | undefined {
    const byId = this.tasks.get(ref);
    if (byId) return this.readTask(byId);
    const byName = [...this.tasks.values()].find((task) => task.name === ref);
    return byName ? this.readTask(byName) : undefined;
  }

  list(): GoalTaskState[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map((task) => this.readTask(task));
  }
}
