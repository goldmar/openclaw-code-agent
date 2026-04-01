import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

import type { GoalTaskState, SessionRoute } from "./types";

function resolveOpenclawHomeDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCLAW_HOME?.trim();
  if (explicit) return explicit;
  return join(homedir(), ".openclaw");
}

function resolveGoalTasksPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH?.trim();
  if (explicit) return explicit;
  return join(resolveOpenclawHomeDir(env), "code-agent-goal-tasks.json");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeRoute(raw: unknown): SessionRoute | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
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
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.goal !== "string") return undefined;
  if (typeof value.workdir !== "string" || typeof value.status !== "string") return undefined;

  const status = value.status;
  const resumedStatus =
    status === "running" || status === "waiting_for_session"
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
    verifierCommands: Array.isArray(value.verifierCommands)
      ? value.verifierCommands
          .filter((item): item is { label: string; command: string; timeoutMs?: number } =>
            Boolean(item)
            && typeof item === "object"
            && typeof (item as { label?: unknown }).label === "string"
            && typeof (item as { command?: unknown }).command === "string")
      : [],
    lastVerifierSummary: typeof value.lastVerifierSummary === "string" ? value.lastVerifierSummary : undefined,
    lastVerifierFingerprint: typeof value.lastVerifierFingerprint === "string" ? value.lastVerifierFingerprint : undefined,
    repeatedFailureCount: typeof value.repeatedFailureCount === "number" ? value.repeatedFailureCount : 0,
    waitingForUserReason: typeof value.waitingForUserReason === "string" ? value.waitingForUserReason : undefined,
    failureReason: typeof value.failureReason === "string" ? value.failureReason : undefined,
  };
}

export class GoalTaskStore {
  private readonly path: string;
  private readonly tasks: Map<string, GoalTaskState> = new Map();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.path = resolveGoalTasksPath(env);
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;

      for (const item of parsed) {
        const task = normalizeTask(item);
        if (task) {
          this.tasks.set(task.id, task);
        }
      }
      this.save();
    } catch {
      // Start with an empty store if the file is unreadable.
    }
  }

  save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmpPath = `${this.path}.tmp`;
      writeFileSync(tmpPath, JSON.stringify([...this.tasks.values()], null, 2), "utf8");
      renameSync(tmpPath, this.path);
    } catch (err: unknown) {
      console.warn(`[GoalTaskStore] Failed to save ${this.path}: ${errorMessage(err)}`);
    }
  }

  upsert(task: GoalTaskState): void {
    this.tasks.set(task.id, task);
    this.save();
  }

  get(ref: string): GoalTaskState | undefined {
    const byId = this.tasks.get(ref);
    if (byId) return byId;
    return [...this.tasks.values()].find((task) => task.name === ref);
  }

  list(): GoalTaskState[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}
