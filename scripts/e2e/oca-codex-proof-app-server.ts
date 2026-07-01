#!/usr/bin/env -S node --import tsx
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

type JsonRpcId = string | number;
type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

type ScenarioName =
  | "approval"
  | "basic"
  | "fail"
  | "interrupted"
  | "pending-question"
  | "plan"
  | "worktree";

type Scenario = {
  assistantText?: string;
  failureMessage?: string;
  pendingInput?: {
    method: string;
    params: Record<string, unknown>;
  };
  plan?: {
    explanation: string;
    markdown: string;
    steps: Array<{ status: "completed" | "in_progress" | "pending"; step: string }>;
  };
  terminalStatus: "cancelled" | "completed" | "failed" | "interrupted";
  worktreePath?: string;
};

const THREAD_ID = "123e4567-e89b-12d3-a456-426614174000";
const TURN_ID_PREFIX = "oca-proof-turn";
const DEFAULT_WORKTREE_PATH = "/tmp/oca-proof/worktrees/native-codex/openclaw-code-agent";

export function scenarioByName(name: string | undefined): Scenario {
  const scenario = (name || "basic").trim() as ScenarioName;
  switch (scenario) {
    case "approval":
      return {
        pendingInput: {
          method: "turn/requestApproval",
          params: {
            requestId: "req-approval",
            question: "Allow command?",
            actions: [
              {
                kind: "approval",
                label: "Approve",
                responseDecision: "approve",
                proposedExecpolicyAmendment: {
                  approvalPolicy: "never",
                  sandbox: "danger-full-access",
                },
              },
              {
                kind: "approval",
                label: "Decline",
                responseDecision: "decline",
              },
            ],
          },
        },
        assistantText: "OPENCLAW_OCA_CODEX_APPROVAL_OK",
        terminalStatus: "completed",
      };
    case "fail":
      return {
        failureMessage: "OPENCLAW_OCA_CODEX_EXPECTED_FAILURE",
        terminalStatus: "failed",
      };
    case "interrupted":
      return {
        assistantText: "OPENCLAW_OCA_CODEX_INTERRUPTED",
        terminalStatus: "interrupted",
      };
    case "pending-question":
      return {
        pendingInput: {
          method: "turn/requestUserInput",
          params: {
            requestId: "req-question",
            questions: [
              {
                id: "environment",
                header: "Environment",
                question: "Choose an environment",
                options: [
                  { label: "Staging (Recommended)", description: "Use disposable proof settings." },
                  { label: "Production", description: "Use production credentials." },
                ],
              },
            ],
          },
        },
        assistantText: "OPENCLAW_OCA_CODEX_PENDING_INPUT_OK",
        terminalStatus: "completed",
      };
    case "plan":
      return {
        plan: {
          explanation: "Proof plan",
          steps: [
            { step: "Show the plan in Telegram", status: "completed" },
            { step: "Wait for approval callback", status: "pending" },
          ],
          markdown: [
            "# OCA Codex Proof Plan",
            "",
            "1. Show a deterministic plan artifact.",
            "2. Wait for the Telegram approval buttons.",
          ].join("\n"),
        },
        terminalStatus: "completed",
      };
    case "worktree":
      return {
        assistantText: "OPENCLAW_OCA_CODEX_WORKTREE_OK",
        terminalStatus: "completed",
        worktreePath: process.env.OCA_CODEX_PROOF_WORKTREE_PATH || DEFAULT_WORKTREE_PATH,
      };
    case "basic":
      return {
        assistantText: "OPENCLAW_OCA_CODEX_BASIC_OK",
        terminalStatus: "completed",
      };
    default:
      throw new Error(`Unknown OCA Codex proof scenario: ${name}`);
  }
}

export function redactProofValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\b(Bearer\s+)[^\s]+/gi, "$1[redacted credential]")
      .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[opsru]_[A-Za-z0-9_]{8,}|[A-Za-z0-9_-]{32,})\b/g, "[redacted token]")
      .replace(/(?:\/Users|\/home)\/[^\s]+/g, "[redacted path]");
  }
  if (Array.isArray(value)) return value.map((entry) => redactProofValue(entry));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/(api[_-]?key|token|secret|password|authorization)/iu.test(key)) {
      output[key] = "[redacted credential]";
      continue;
    }
    output[key] = redactProofValue(entry);
  }
  return output;
}

function writeFrame(frame: JsonRpcEnvelope): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function appendRequestLog(logPath: string | undefined, entry: Record<string, unknown>): void {
  if (!logPath) return;
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(redactProofValue(entry))}\n`);
}

function parseEnvelope(line: string): JsonRpcEnvelope | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as JsonRpcEnvelope
      : undefined;
  } catch {
    return undefined;
  }
}

class ProofServer {
  private initialized = false;
  private requestCounter = 0;
  private turnCounter = 0;
  private readonly pendingServerRequests = new Map<string, (value: unknown) => void>();

  constructor(
    private readonly scenario: Scenario,
    private readonly requestLogPath?: string,
  ) {}

  async handle(payload: JsonRpcEnvelope): Promise<void> {
    if (payload.id != null && Object.hasOwn(payload, "result")) {
      const key = String(payload.id);
      const resolve = this.pendingServerRequests.get(key);
      if (resolve) {
        this.pendingServerRequests.delete(key);
        resolve(payload.result);
      }
      return;
    }

    const method = payload.method?.trim();
    if (!method || payload.id == null) return;
    appendRequestLog(this.requestLogPath, { method, params: payload.params });

    try {
      const result = await this.route(method, payload.params);
      writeFrame({ jsonrpc: "2.0", id: payload.id, result: result ?? {} });
    } catch (error) {
      writeFrame({
        jsonrpc: "2.0",
        id: payload.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async route(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        this.initialized = true;
        return { capabilities: { experimentalApi: true } };
      case "thread/start":
      case "thread/new":
        this.requireInitialized();
        return this.threadState(params);
      case "thread/resume":
        this.requireInitialized();
        return this.threadState(params);
      case "turn/start":
        this.requireInitialized();
        return await this.startTurn(params);
      case "turn/interrupt":
        return {};
      default:
        return {};
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error("fake Codex proof server was used before initialize");
    }
  }

  private threadState(params: unknown): Record<string, unknown> {
    const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
    return {
      threadId: typeof record.threadId === "string" ? record.threadId : THREAD_ID,
      ...(this.scenario.worktreePath ? { cwd: this.scenario.worktreePath } : {}),
    };
  }

  private async startTurn(params: unknown): Promise<unknown> {
    this.turnCounter += 1;
    const turnId = `${TURN_ID_PREFIX}-${this.turnCounter}`;
    queueMicrotask(() => {
      void this.emitTurn(turnId, params);
    });
    return { threadId: THREAD_ID, turnId };
  }

  private async emitTurn(turnId: string, params: unknown): Promise<void> {
    const base = {
      threadId: THREAD_ID,
      turnId,
      ...(this.scenario.worktreePath ? { thread: { id: THREAD_ID, cwd: this.scenario.worktreePath } } : {}),
    };

    if (this.scenario.pendingInput) {
      const requestId = this.scenario.pendingInput.params.requestId ?? `req-${this.turnCounter}`;
      await this.sendRequest(this.scenario.pendingInput.method, {
        ...base,
        ...this.scenario.pendingInput.params,
        requestId,
      });
      writeFrame({
        jsonrpc: "2.0",
        method: "serverrequest/resolved",
        params: { ...base, requestId },
      });
    }

    if (this.scenario.plan) {
      writeFrame({
        jsonrpc: "2.0",
        method: "turn/plan/updated",
        params: {
          ...base,
          plan: {
            explanation: this.scenario.plan.explanation,
            steps: this.scenario.plan.steps,
          },
        },
      });
      writeFrame({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          ...base,
          item: {
            id: `plan-${turnId}`,
            type: "plan",
            text: this.scenario.plan.markdown,
          },
        },
      });
    }

    if (this.scenario.assistantText) {
      writeFrame({
        jsonrpc: "2.0",
        method: "item/agentmessage/delta",
        params: {
          ...base,
          item: {
            id: `assistant-${turnId}`,
            type: "agentMessage",
            delta: this.scenario.assistantText,
          },
        },
      });
    }

    const failed = this.scenario.terminalStatus === "failed";
    const cancelled = this.scenario.terminalStatus === "cancelled";
    writeFrame({
      jsonrpc: "2.0",
      method: failed ? "turn/failed" : cancelled ? "turn/cancelled" : "turn/completed",
      params: {
        ...base,
        turn: {
          id: turnId,
          status: this.scenario.terminalStatus,
          ...(this.scenario.failureMessage ? { error: { message: this.scenario.failureMessage } } : {}),
        },
      },
    });
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = `server-req-${++this.requestCounter}`;
    writeFrame({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingServerRequests.delete(id);
        resolve({ timedOut: true });
      }, 30_000);
      timer.unref?.();
      this.pendingServerRequests.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
}

export function runProofAppServer(): void {
  const scenario = scenarioByName(process.env.OCA_CODEX_PROOF_SCENARIO);
  const server = new ProofServer(scenario, process.env.OCA_CODEX_PROOF_REQUEST_LOG);
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const payload = parseEnvelope(line);
    if (payload) void server.handle(payload);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProofAppServer();
}
