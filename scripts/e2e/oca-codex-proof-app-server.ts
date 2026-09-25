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
  | "plan";

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
    steps: Array<{ status: "completed" | "inProgress" | "pending"; step: string }>;
  };
  terminalStatus: "completed" | "failed" | "interrupted";
};

const THREAD_ID = "123e4567-e89b-12d3-a456-426614174000";
const TURN_ID_PREFIX = "oca-proof-turn";

export function scenarioByName(name: string | undefined): Scenario {
  const scenario = (name || "basic").trim() as ScenarioName;
  switch (scenario) {
    case "approval":
      return {
        pendingInput: {
          method: "item/commandExecution/requestApproval",
          params: {
            kind: "command",
            itemId: "item-approval",
            startedAtMs: 0,
            environmentId: null,
            command: "echo proof",
            reason: "Allow command?",
            availableDecisions: ["accept", "decline"],
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
          method: "item/tool/requestUserInput",
          params: {
            itemId: "item-question",
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: "environment",
                header: "Environment",
                question: "Choose an environment",
                isOther: false,
                isSecret: false,
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
      .replace(/\bauthorization\b(?:(\s*[:=]\s*)|\s+)(?:"(?:Bearer\s+)?[^"]+"|'(?:Bearer\s+)?[^']+'|(?:Bearer\s+)?[A-Za-z0-9._~+/-]+=*)/giu, "authorization$1[redacted credential]")
      .replace(/\b(secret|password|api[-_ ]?key|credential|token)\b(?:(\s*[:=]\s*)|\s+)(?:"[^"]*"|'[^']*'|[^\s,;)}\]]+)/giu, "$1$2[redacted credential]")
      .replace(/\b(Bearer\s+)[^\s]+/gi, "$1[redacted credential]")
      .replace(/\b\d{7,}:[A-Za-z0-9_-]{20,}\b/gu, "[redacted credential]")
      .replace(/\b\d{6,}\b/gu, "[redacted id]")
      .replace(/@[A-Za-z][A-Za-z0-9_]{4,}\b/gu, "@[redacted username]")
      .replace(/\+?\d[\d .().-]{7,}\d/gu, "[redacted phone]")
      .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[opsru]_[A-Za-z0-9_]{8,}|[A-Za-z0-9_-]{32,})\b/g, "[redacted token]")
      .replace(/\/(?:Users|home|tmp|private\/tmp|var\/folders|workspace|run\/user)\/[^\s"',}\]]+/g, "[redacted path]");
  }
  if (Array.isArray(value)) return value.map((entry) => redactProofValue(entry));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/(api[_-]?key|token|secret|password|authorization|credential|groupId|testerUserId|ownerId|username|messageId|callback.*data|^data$)/iu.test(key)) {
      output[key] = "[redacted credential]";
      continue;
    }
    if (/(^|[_-])(cwd|path|dir|directory|worktree|output)([_-]|$)/iu.test(key) && typeof entry === "string" && path.isAbsolute(entry)) {
      output[key] = "[redacted path]";
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

  // Response shapes follow the vendored `codex app-server generate-ts` types
  // (src/harness/codex-app-server-protocol), trimmed to what OCA reads.
  private async route(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        this.initialized = true;
        return { userAgent: "oca-codex-proof/0.156.1 (linux; x86_64)", codexHome: "/tmp/oca-codex-proof", platformFamily: "unix", platformOs: "linux" };
      case "account/read":
        return { account: null, requiresOpenaiAuth: false, workspaceRouting: null };
      case "model/list":
        return { data: [], nextCursor: null };
      case "thread/start":
      case "thread/resume":
      case "thread/fork":
        this.requireInitialized();
        return this.threadResponse(params);
      case "turn/start":
        this.requireInitialized();
        return this.startTurn();
      case "turn/interrupt":
        return {};
      default:
        throw new Error(`fake Codex proof server does not implement ${method}`);
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) {
      throw new Error("fake Codex proof server was used before initialize");
    }
  }

  private threadResponse(params: unknown): Record<string, unknown> {
    const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
    const cwd = typeof record.cwd === "string" ? record.cwd : "/tmp";
    return {
      thread: { id: typeof record.threadId === "string" ? record.threadId : THREAD_ID, turns: [] },
      model: typeof record.model === "string" ? record.model : "gpt-6-sol",
      modelProvider: "openai",
      serviceTier: null,
      cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
      activePermissionProfile: { id: ":danger-full-access", extends: null },
      reasoningEffort: null,
    };
  }

  private turn(turnId: string, status: string, errorMessage?: string): Record<string, unknown> {
    return {
      id: turnId,
      items: [],
      itemsView: "notLoaded",
      status,
      error: errorMessage
        ? { message: errorMessage, codexErrorInfo: null, additionalDetails: null, misalignment: null }
        : null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    };
  }

  private startTurn(): unknown {
    this.turnCounter += 1;
    const turnId = `${TURN_ID_PREFIX}-${this.turnCounter}`;
    queueMicrotask(() => {
      void this.emitTurn(turnId);
    });
    return { turn: this.turn(turnId, "inProgress") };
  }

  private async emitTurn(turnId: string): Promise<void> {
    const base = { threadId: THREAD_ID, turnId };
    writeFrame({ jsonrpc: "2.0", method: "turn/started", params: { threadId: THREAD_ID, turn: this.turn(turnId, "inProgress") } });

    if (this.scenario.pendingInput) {
      const { id } = await this.sendRequest(this.scenario.pendingInput.method, {
        ...base,
        ...this.scenario.pendingInput.params,
      });
      writeFrame({
        jsonrpc: "2.0",
        method: "serverRequest/resolved",
        params: { threadId: THREAD_ID, requestId: id },
      });
    }

    if (this.scenario.plan) {
      writeFrame({
        jsonrpc: "2.0",
        method: "turn/plan/updated",
        params: {
          ...base,
          explanation: this.scenario.plan.explanation,
          plan: this.scenario.plan.steps,
        },
      });
      writeFrame({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          ...base,
          completedAtMs: 0,
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
        method: "item/agentMessage/delta",
        params: {
          ...base,
          itemId: `assistant-${turnId}`,
          delta: this.scenario.assistantText,
        },
      });
    }

    writeFrame({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: THREAD_ID,
        turn: this.turn(turnId, this.scenario.terminalStatus, this.scenario.failureMessage),
      },
    });
  }

  private sendRequest(method: string, params: unknown): Promise<{ id: number; result: unknown }> {
    const id = ++this.requestCounter;
    writeFrame({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingServerRequests.delete(String(id));
        resolve({ id, result: { timedOut: true } });
      }, 30_000);
      timer.unref?.();
      this.pendingServerRequests.set(String(id), (value) => {
        clearTimeout(timer);
        resolve({ id, result: value });
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
