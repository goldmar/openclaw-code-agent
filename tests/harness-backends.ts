/**
 * Scriptable fake backends behind the real harness adapters.
 *
 * Each driver wraps the production harness class (`ClaudeCodeHarness`,
 * `CodexHarness`, `OpenCodeHarness`) around an in-memory transport: a fake
 * Claude SDK query, a fake Codex app-server JSON-RPC client, and a fake
 * OpenCode HTTP/SSE server. Tests register the harness under its real name and
 * drive user-facing flows (questions, permission requests, plan reviews)
 * through SessionManager, agent_respond, and the button callback handler, so
 * the same scenario runs against every backend.
 */
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeHarness } from "../src/harness/claude-code";
import { CodexHarness } from "../src/harness/codex";
import type { JsonRpcClient, JsonRpcId, JsonRpcNotificationHandler, JsonRpcRequestHandler } from "../src/harness/codex-rpc";
import type {
  ItemCompletedNotification,
  ServerRequestResolvedNotification,
  TurnCompletedNotification,
  TurnInterruptResponse,
  TurnPlanUpdatedNotification,
  TurnStartedNotification,
  TurnSteerResponse,
} from "../src/harness/codex-app-server-protocol";
import { OpenCodeHarness } from "../src/harness/opencode";
import type { AgentHarness } from "../src/harness/types";
import { checkProtocol, openCodeEventErrors, openCodeRequestErrors, openCodeResponseErrors } from "./protocol-schema";
import {
  CODEX_FIXTURE_CWD,
  CodexProtocolChecker,
  codexAgentMessage,
  codexInitializeResponse,
  codexPlanItem,
  codexThreadResumeResponse,
  codexThreadStartResponse,
  codexTurn,
  type CodexServerRequestParams,
  type CodexThreadResponseOptions,
  type CommandExecutionRequestApprovalResponse,
  type GetAccountResponse,
  type ModelListResponse,
  type ToolRequestUserInputResponse,
  type TurnStartResponse,
} from "./codex-fixtures";

export type BackendName = "claude-code" | "codex" | "opencode";

export const BACKEND_NAMES: readonly BackendName[] = ["claude-code", "codex", "opencode"];

export type QuestionSpec = {
  id: string;
  question: string;
  header?: string;
  options?: string[];
  multiSelect?: boolean;
  /** Offer a free-text "Other" answer (Codex `isOther`, OpenCode `custom`). */
  other?: boolean;
};

/** Answers the backend received, keyed by question text. */
export type QuestionAnswers = Record<string, string[]>;

export type QuestionOutcome =
  | { kind: "answered"; answers: QuestionAnswers }
  | { kind: "cancelled"; reason: string };

/** Normalized permission decision the backend received. */
export type PermissionOutcome = {
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
  /** Feedback text sent with a decline (OpenCode `message`). */
  message?: string;
};

export type PlanDecisionOutcome =
  | { kind: "approve"; permissionMode?: string }
  | { kind: "revise"; feedback: string }
  | { kind: "cancelled"; reason: string };

/** One user turn as the backend received it. */
export type BackendTurn = {
  text: string;
  /** Whether the backend ran the turn read-only (Claude plan mode, Codex plan collaboration mode, OpenCode plan agent). */
  planMode: boolean;
};

export interface BackendDriver {
  readonly name: BackendName;
  readonly harness: AgentHarness;
  /** User turns the backend started, in order. */
  readonly turns: BackendTurn[];
  /** Messages steered into a running turn (Codex `turn/steer`). */
  readonly steers: string[];
  /** Whether the backend raises structured permission requests. */
  readonly supportsPermissionRequests: boolean;
  /** Whether a plan decision is carried by the backend protocol itself. */
  readonly nativePlanDecisions: boolean;
  /** Frames that did not match the vendored protocol schema (empty for a correct fake and a correct OCA). */
  readonly protocolViolations: readonly string[];
  waitForTurns(count: number): Promise<void>;
  /** Raise a structured question inside the running turn. */
  ask(questions: QuestionSpec[]): Promise<QuestionOutcome>;
  /** Raise a tool/command permission request inside the running turn. */
  requestPermission(description: string): Promise<PermissionOutcome>;
  /**
   * Submit a plan for review. Claude holds ExitPlanMode open inside the turn
   * and resolves with the native decision; Codex and OpenCode finish the
   * planning turn, and their decision arrives as the next user turn.
   */
  proposePlan(markdown: string): Promise<PlanDecisionOutcome> | undefined;
  /** Finish the running turn with a final assistant message. */
  endTurn(text?: string): Promise<void>;
  /** The backend resolves the pending request itself (expiry, turn interrupted). */
  expirePendingRequest(): Promise<void>;
  /**
   * The backend dies in the middle of the running turn: the Codex app-server
   * stdio closes, the Claude SDK query throws, the OpenCode server exits.
   */
  crashMidTurn(): Promise<void>;
}

export async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class Pushable<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  push(item: T): void {
    this.items.push(item);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  /** Make the consumer's iteration throw once the queued items are drained. */
  fail(error: Error): void {
    this.failure = error;
    this.wake?.();
  }

  private failure: Error | undefined;

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

function promptText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as { text?: unknown; message?: { content?: unknown } };
  if (typeof record.text === "string") return record.text;
  const content = record.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "")).join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Claude Code: fake SDK query behind ClaudeCodeHarness
// ---------------------------------------------------------------------------

type ClaudePermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown>; updatedPermissions?: Array<{ type: string; mode?: string }> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; requestId?: string },
) => Promise<ClaudePermissionResult>;

export class ClaudeBackend implements BackendDriver {
  readonly name = "claude-code" as const;
  readonly harness: AgentHarness;
  readonly turns: BackendTurn[] = [];
  readonly steers: string[] = [];
  readonly supportsPermissionRequests = false;
  readonly nativePlanDecisions = true;
  /** The Claude Agent SDK is typed in-process; there is no wire schema to check. */
  readonly protocolViolations: readonly string[] = [];
  readonly permissionModes: string[] = [];
  private output = new Pushable<unknown>();
  private canUseTool: ClaudeCanUseTool | undefined;
  private permissionMode = "default";
  private toolCounter = 0;
  private sessionCounter = 0;
  private conversationId = "claude-session-1";

  constructor() {
    this.harness = new ClaudeCodeHarness({
      startup: async ({ options }) => {
        this.canUseTool = options.canUseTool as unknown as ClaudeCanUseTool;
        this.permissionMode = String(options.permissionMode ?? "default");
        this.output = new Pushable<unknown>();
        const output = this.output;
        this.sessionCounter += 1;
        this.conversationId = typeof options.resume === "string" ? options.resume : `claude-session-${this.sessionCounter}`;
        options.abortController?.signal.addEventListener("abort", () => output.end(), { once: true });
        return {
          query: (prompt: string | AsyncIterable<SDKUserMessage>) => {
            void this.consumePrompts(prompt, output);
            return this.queryHandle(output) as never;
          },
          close: () => output.end(),
        } as never;
      },
      getSessionInfo: async (sessionId: string) => ({ sessionId, summary: "", lastModified: 0 }) as never,
    });
  }

  private queryHandle(output: Pushable<unknown>): Record<string | symbol, unknown> {
    return {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      setPermissionMode: async (mode: string) => {
        this.permissionModes.push(mode);
        this.permissionMode = mode;
      },
      streamInput: async (input: AsyncIterable<SDKUserMessage>) => {
        await this.consumePrompts(input, output);
      },
      interrupt: async (): Promise<undefined> => undefined,
      getContextUsage: async () => { throw new Error("not supported by the fake query"); },
      supportedModels: async (): Promise<never[]> => [],
    };
  }

  private async consumePrompts(prompt: string | AsyncIterable<SDKUserMessage>, output: Pushable<unknown>): Promise<void> {
    const startTurn = (text: string): void => {
      if (this.turns.length === 0 || output !== this.output || !this.initialized.has(output)) {
        this.initialized.add(output);
        output.push({ type: "system", subtype: "init", session_id: this.conversationId, model: "claude-test" });
      }
      this.turns.push({ text, planMode: this.permissionMode === "plan" });
      output.push({ type: "assistant", message: { content: [{ type: "text", text: "Working." }] } });
    };
    if (typeof prompt === "string") {
      startTurn(prompt);
      return;
    }
    for await (const message of prompt) startTurn(promptText(message));
  }

  private readonly initialized = new WeakSet<Pushable<unknown>>();

  waitForTurns(count: number): Promise<void> {
    return waitUntil(() => this.turns.length >= count, `${count} Claude turn(s)`);
  }

  private toolOptions(): { signal: AbortSignal; toolUseID: string } {
    this.toolCounter += 1;
    return { signal: new AbortController().signal, toolUseID: `toolu_${this.toolCounter}` };
  }

  async ask(questions: QuestionSpec[]): Promise<QuestionOutcome> {
    if (!this.canUseTool) throw new Error("Claude session has not started");
    const input = {
      questions: questions.map((question) => ({
        question: question.question,
        header: question.header ?? question.id,
        options: (question.options ?? []).map((label) => ({ label, description: `${label} option` })),
        multiSelect: question.multiSelect === true,
      })),
    };
    try {
      const result = await this.canUseTool("AskUserQuestion", input, this.toolOptions());
      if (result.behavior === "deny") return { kind: "cancelled", reason: result.message };
      const raw = (result.updatedInput.answers ?? {}) as Record<string, string>;
      const answers: QuestionAnswers = {};
      for (const question of questions) {
        const value = raw[question.question];
        if (value === undefined) continue;
        answers[question.question] = question.multiSelect ? value.split(", ") : [value];
      }
      return { kind: "answered", answers };
    } catch (error) {
      return { kind: "cancelled", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async requestPermission(): Promise<PermissionOutcome> {
    throw new Error("Claude Code sessions run tools without interactive permission requests");
  }

  proposePlan(markdown: string): Promise<PlanDecisionOutcome> {
    if (!this.canUseTool) throw new Error("Claude session has not started");
    return this.canUseTool("ExitPlanMode", { plan: markdown }, this.toolOptions()).then((result): PlanDecisionOutcome => {
      if (result.behavior === "allow") {
        const setMode = result.updatedPermissions?.find((entry) => entry.type === "setMode");
        return { kind: "approve", permissionMode: setMode?.mode };
      }
      return result.interrupt ? { kind: "cancelled", reason: result.message } : { kind: "revise", feedback: result.message };
    });
  }

  async endTurn(text = "Done."): Promise<void> {
    this.output.push({ type: "assistant", message: { content: [{ type: "text", text }] } });
    this.output.push({
      type: "result",
      subtype: "success",
      session_id: this.conversationId,
      duration_ms: 1,
      total_cost_usd: 0,
      num_turns: 1,
      result: text,
    });
  }

  async expirePendingRequest(): Promise<void> {
    throw new Error("Claude questions expire through OCA's question timeout, not the backend");
  }

  async crashMidTurn(): Promise<void> {
    this.output.fail(new Error("Claude Code process exited with code 1"));
  }
}

// ---------------------------------------------------------------------------
// Codex: fake app-server JSON-RPC client behind CodexHarness
// ---------------------------------------------------------------------------

const CODEX_THREAD_ID = "123e4567-e89b-12d3-a456-426614174000";
const CODEX_WORKSPACE_WRITE: CodexThreadResponseOptions = {
  approvalPolicy: "on-request",
  sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
};

type CodexServerRequest = { id: JsonRpcId; method: string; response: Promise<unknown> };

export class CodexBackend implements BackendDriver {
  readonly name = "codex" as const;
  readonly harness: AgentHarness;
  readonly turns: BackendTurn[] = [];
  readonly steers: string[] = [];
  readonly supportsPermissionRequests = true;
  readonly nativePlanDecisions = false;
  readonly turnStartParams: Array<Record<string, unknown>> = [];
  readonly threadStartParams: Array<Record<string, unknown>> = [];
  /** Validates every frame against the vendored Codex JSON Schema. */
  readonly protocol = new CodexProtocolChecker();
  private notificationHandler: JsonRpcNotificationHandler = () => undefined;
  private requestHandler: JsonRpcRequestHandler = async () => ({});
  private activeTurnId: string | undefined;
  private turnCounter = 0;
  private requestCounter = 0;
  private pendingRequest: CodexServerRequest | undefined;
  private closeHandler: (() => void) | undefined;

  constructor() {
    this.harness = new CodexHarness({ createClient: () => this.client() });
  }

  get protocolViolations(): readonly string[] {
    return this.protocol.violations;
  }

  private client(): JsonRpcClient {
    return {
      connect: async () => undefined,
      close: async () => undefined,
      notify: async () => undefined,
      setNotificationHandler: (handler) => { this.notificationHandler = handler; },
      setRequestHandler: (handler) => { this.requestHandler = handler; },
      setCloseHandler: (handler) => { this.closeHandler = handler; },
      request: async (method, params) => {
        this.protocol.clientRequest(method, params);
        return this.protocol.clientResult(method, this.handle(method, (params ?? {}) as Record<string, unknown>));
      },
    };
  }

  /** Send a server notification after checking it against the schema. */
  private async notify<M extends string>(method: M, params: unknown): Promise<void> {
    this.protocol.notification(method, params);
    await this.notificationHandler(method, params);
  }

  private handle(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "initialize":
        return codexInitializeResponse();
      case "account/read":
        return { account: null, requiresOpenaiAuth: false, workspaceRouting: null } satisfies GetAccountResponse;
      case "model/list":
        return { data: [], nextCursor: null } satisfies ModelListResponse;
      case "thread/start":
        this.threadStartParams.push(params);
        return codexThreadStartResponse(CODEX_THREAD_ID, CODEX_WORKSPACE_WRITE);
      case "thread/resume":
        this.threadStartParams.push(params);
        return codexThreadResumeResponse(String(params.threadId), CODEX_WORKSPACE_WRITE);
      case "turn/start": {
        this.turnStartParams.push(params);
        const input = Array.isArray(params.input) ? params.input : [];
        const text = input.map((item) => (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "")).join("");
        const mode = (params.collaborationMode as { mode?: string } | undefined)?.mode;
        this.turns.push({ text, planMode: mode === "plan" });
        this.turnCounter += 1;
        const turnId = `turn-${this.turnCounter}`;
        this.activeTurnId = turnId;
        queueMicrotask(() => {
          void this.notify("turn/started", { threadId: CODEX_THREAD_ID, turn: codexTurn(turnId, "inProgress") } satisfies TurnStartedNotification);
        });
        return { turn: codexTurn(turnId, "inProgress") } satisfies TurnStartResponse;
      }
      case "turn/steer": {
        if (!this.activeTurnId || params.expectedTurnId !== this.activeTurnId) throw new Error("no active turn to steer");
        const input = Array.isArray(params.input) ? params.input : [];
        this.steers.push(input.map((item) => String((item as { text?: unknown }).text ?? "")).join(""));
        return { turnId: this.activeTurnId } satisfies TurnSteerResponse;
      }
      case "turn/interrupt":
        return {} satisfies TurnInterruptResponse;
      default:
        throw new Error(`fake Codex app server does not implement ${method}`);
    }
  }

  waitForTurns(count: number): Promise<void> {
    return waitUntil(() => this.turns.length >= count && !!this.activeTurnId, `${count} Codex turn(s)`);
  }

  private serverRequest<M extends "item/tool/requestUserInput" | "item/commandExecution/requestApproval">(
    method: M,
    params: CodexServerRequestParams<M>,
  ): Promise<unknown> {
    if (!this.activeTurnId) throw new Error("no active Codex turn");
    this.protocol.serverRequest(method, params);
    const id = this.requestCounter;
    const response = this.requestHandler(method, params, id).then((result) => {
      this.protocol.serverResult(method, result);
      return result;
    });
    this.pendingRequest = { id, method, response };
    void response.finally(() => {
      if (this.pendingRequest?.id === id) this.pendingRequest = undefined;
    }).catch((): undefined => undefined);
    return response;
  }

  private nextItemId(): string {
    this.requestCounter += 1;
    return `item-${this.requestCounter}`;
  }

  async ask(questions: QuestionSpec[]): Promise<QuestionOutcome> {
    const turnId = this.activeTurnId;
    if (!turnId) throw new Error("no active Codex turn");
    const response = await this.serverRequest("item/tool/requestUserInput", {
      threadId: CODEX_THREAD_ID,
      turnId,
      itemId: this.nextItemId(),
      isBlocking: true,
      autoResolutionMs: null,
      questions: questions.map((question) => ({
        id: question.id,
        header: question.header ?? question.id,
        question: question.question,
        isOther: question.other === true,
        isSecret: false,
        options: question.options ? question.options.map((label) => ({ label, description: `${label} option` })) : null,
      })),
    }) as ToolRequestUserInputResponse;
    const raw = response.answers ?? {};
    if (Object.keys(raw).length === 0) return { kind: "cancelled", reason: "resolved without answers" };
    const answers: QuestionAnswers = {};
    for (const question of questions) {
      const entry = raw[question.id];
      if (entry) answers[question.question] = entry.answers;
    }
    return { kind: "answered", answers };
  }

  async requestPermission(description: string): Promise<PermissionOutcome> {
    const turnId = this.activeTurnId;
    if (!turnId) throw new Error("no active Codex turn");
    const response = await this.serverRequest("item/commandExecution/requestApproval", {
      kind: "command",
      threadId: CODEX_THREAD_ID,
      turnId,
      itemId: this.nextItemId(),
      startedAtMs: 0,
      environmentId: null,
      command: description,
      cwd: CODEX_FIXTURE_CWD,
      reason: "The test needs it",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    }) as CommandExecutionRequestApprovalResponse;
    const decision = response.decision;
    if (typeof decision !== "string") throw new Error(`unexpected structured Codex approval decision ${JSON.stringify(decision)}`);
    return { decision };
  }

  proposePlan(markdown: string): undefined {
    void (async () => {
      const turnId = this.activeTurnId;
      if (!turnId) throw new Error("no active Codex turn");
      await this.notify("turn/plan/updated", {
        threadId: CODEX_THREAD_ID,
        turnId,
        explanation: "Implementation plan",
        plan: [{ step: "Change the code", status: "pending" }],
      } satisfies TurnPlanUpdatedNotification);
      await this.notify("item/completed", {
        threadId: CODEX_THREAD_ID,
        turnId,
        completedAtMs: 0,
        item: codexPlanItem(`plan-${turnId}`, markdown),
      } satisfies ItemCompletedNotification);
      await this.endTurn(markdown);
    })();
    return undefined;
  }

  async endTurn(text = "Done."): Promise<void> {
    const turnId = this.activeTurnId;
    if (!turnId) throw new Error("no active Codex turn to end");
    await this.notify("item/completed", {
      threadId: CODEX_THREAD_ID,
      turnId,
      completedAtMs: 0,
      item: codexAgentMessage(`msg-${turnId}-${text.length}`, text),
    } satisfies ItemCompletedNotification);
    this.activeTurnId = undefined;
    await this.notify("turn/completed", { threadId: CODEX_THREAD_ID, turn: codexTurn(turnId, "completed") } satisfies TurnCompletedNotification);
  }

  async expirePendingRequest(): Promise<void> {
    const pending = this.pendingRequest;
    if (!pending) throw new Error("no pending Codex server request");
    await this.notify("serverRequest/resolved", { threadId: CODEX_THREAD_ID, requestId: pending.id } satisfies ServerRequestResolvedNotification);
  }

  async crashMidTurn(): Promise<void> {
    if (!this.activeTurnId) throw new Error("no active Codex turn");
    this.activeTurnId = undefined;
    const close = this.closeHandler;
    if (!close) throw new Error("the Codex harness registered no close handler");
    close();
  }
}

// ---------------------------------------------------------------------------
// OpenCode: fake HTTP/SSE server behind OpenCodeHarness
// ---------------------------------------------------------------------------

type OpenCodeRequest = { method: string; path: string; body?: Record<string, unknown> };

const OPENCODE_DIRECTORY = "/tmp";
const OPENCODE_MODEL = { providerID: "opencode", modelID: "test" } as const;

export class OpenCodeBackend implements BackendDriver {
  readonly name = "opencode" as const;
  readonly harness: AgentHarness;
  readonly turns: BackendTurn[] = [];
  readonly steers: string[] = [];
  readonly supportsPermissionRequests = true;
  readonly nativePlanDecisions = true;
  readonly requests: OpenCodeRequest[] = [];
  /** Requests, responses, and events that do not match the vendored OpenAPI document. */
  readonly protocolViolations: string[] = [];
  private readonly streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  private readonly encoder = new TextEncoder();
  private readonly messages = new Map<string, unknown[]>();
  private sessionCounter = 0;
  private requestCounter = 0;
  private eventCounter = 0;
  private activeSessionId: string | undefined;
  private busy = false;
  private readonly replyWaiters = new Map<string, (request: OpenCodeRequest) => void>();
  private pendingRequestId: string | undefined;
  private pendingKind: "question" | "permission" | undefined;

  constructor() {
    this.harness = new OpenCodeHarness({
      createServer: async () => ({
        baseUrl: "http://opencode.test",
        onExit: (listener: (reason: string) => void) => { this.serverExit = listener; },
        close: async () => {
          for (const stream of this.streams.splice(0)) {
            try { stream.close(); } catch { /* already closed */ }
          }
        },
      }),
      fetch: this.fetch,
      serverIdleShutdownMs: 0,
      fallbackPollIntervalMs: 5,
      streamReconnectDelayMs: 5,
    });
  }

  private session(id: string): Record<string, unknown> {
    return {
      id,
      slug: id,
      projectID: "prj_test",
      directory: OPENCODE_DIRECTORY,
      title: "OCA test session",
      version: "1.18.32",
      cost: 0,
      time: { created: 1, updated: 1 },
    };
  }

  /** A JSON response, checked against the documented response schema. */
  private json(method: string, path: string, value: unknown): Response {
    checkProtocol(this.protocolViolations, `OpenCode ${method} ${path} response`, openCodeResponseErrors(method, path, 200, value));
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }

  /** The fake server's request handler (in-memory `fetch`, or behind a real HTTP listener). */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const request = { method, path, body };
    this.requests.push(request);
    // Every route OCA calls must be documented, and its JSON body must match.
    checkProtocol(this.protocolViolations, `OCA's OpenCode ${method} ${path} request`, openCodeRequestErrors(method, path, body));
    if (path === "/global/event") {
      return new Response(new ReadableStream<Uint8Array>({
        start: (controller) => { this.streams.push(controller); },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (method === "POST" && path === "/session") {
      this.sessionCounter += 1;
      const id = `ses_${this.sessionCounter}`;
      this.messages.set(id, []);
      return this.json(method, path, this.session(id));
    }
    if (method === "GET" && path === "/session/status") {
      return this.json(method, path, this.activeSessionId && this.busy ? { [this.activeSessionId]: { type: "busy" } } : {});
    }
    const messageMatch = /^\/session\/([^/]+)\/message$/.exec(path);
    if (method === "GET" && messageMatch) return this.json(method, path, this.messages.get(messageMatch[1]!) ?? []);
    const promptMatch = /^\/session\/([^/]+)\/prompt_async$/.exec(path);
    if (method === "POST" && promptMatch) {
      const id = promptMatch[1]!;
      this.activeSessionId = id;
      this.busy = true;
      const parts = Array.isArray(body?.parts) ? body.parts : [];
      const text = parts.map((part) => String((part as { text?: unknown }).text ?? "")).join("");
      this.turns.push({ text, planMode: body?.agent === "plan" });
      this.messages.get(id)?.push({
        info: {
          role: "user",
          id: `msg_user_${this.turns.length}`,
          sessionID: id,
          time: { created: this.turns.length * 1_000 },
          agent: typeof body?.agent === "string" ? body.agent : "build",
          model: { ...OPENCODE_MODEL },
        },
        parts: [],
      });
      queueMicrotask(() => this.emit({ type: "session.status", properties: { sessionID: id, status: { type: "busy" } } }));
      checkProtocol(this.protocolViolations, `OpenCode ${method} ${path} response`, openCodeResponseErrors(method, path, 204, undefined));
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && /^\/session\/[^/]+\/abort$/.test(path)) return this.json(method, path, true);
    const sessionMatch = /^\/session\/([^/]+)$/.exec(path);
    if (sessionMatch && (method === "GET" || method === "PATCH")) return this.json(method, path, this.session(sessionMatch[1]!));
    const replyMatch = /^\/(permission|question)\/([^/]+)\/reply$/.exec(path);
    if (method === "POST" && replyMatch) {
      const kind = replyMatch[1] as "permission" | "question";
      const requestId = replyMatch[2]!;
      const waiter = this.replyWaiters.get(requestId);
      this.replyWaiters.delete(requestId);
      waiter?.(request);
      if (this.pendingRequestId === requestId) {
        const sessionID = this.activeSessionId;
        this.pendingRequestId = undefined;
        const properties = kind === "permission"
          ? { sessionID, requestID: requestId, reply: body?.reply }
          : { sessionID, requestID: requestId, answers: body?.answers ?? [] };
        queueMicrotask(() => this.emit({ type: `${kind}.replied`, properties }));
      }
      return this.json(method, path, true);
    }
    return new Response(JSON.stringify({ error: `unexpected ${method} ${path}` }), { status: 404 });
  };

  /** Broadcast one `/global/event` frame, checked against the documented event schema. */
  private emit(payload: { type: string; properties: Record<string, unknown> }): void {
    this.eventCounter += 1;
    const frame = { directory: OPENCODE_DIRECTORY, payload: { id: `evt_${this.eventCounter}`, ...payload } };
    checkProtocol(this.protocolViolations, `OpenCode ${payload.type} event`, openCodeEventErrors(frame));
    const bytes = this.encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
    for (const stream of this.streams) {
      try { stream.enqueue(bytes); } catch { /* closed */ }
    }
  }

  waitForTurns(count: number): Promise<void> {
    return waitUntil(() => this.turns.length >= count && this.busy && this.streams.length > 0, `${count} OpenCode turn(s)`);
  }

  private raise(kind: "question" | "permission", properties: Record<string, unknown>): Promise<OpenCodeRequest> {
    if (!this.activeSessionId) throw new Error("no active OpenCode session");
    this.requestCounter += 1;
    const id = `${kind === "question" ? "que" : "per"}_${this.requestCounter}`;
    this.pendingRequestId = id;
    this.pendingKind = kind;
    const reply = new Promise<OpenCodeRequest>((resolve) => { this.replyWaiters.set(id, resolve); });
    this.emit({ type: `${kind}.asked`, properties: { id, sessionID: this.activeSessionId, ...properties } });
    return reply;
  }

  async ask(questions: QuestionSpec[]): Promise<QuestionOutcome> {
    const reply = await Promise.race([
      this.raise("question", {
        questions: questions.map((question) => ({
          question: question.question,
          header: question.header ?? question.id,
          options: (question.options ?? []).map((label) => ({ label, description: `${label} option` })),
          ...(question.multiSelect ? { multiple: true } : {}),
          ...(question.other === false ? { custom: false } : {}),
        })),
      }),
      this.expiry,
    ]);
    if (!reply) return { kind: "cancelled", reason: "question rejected by the server" };
    const raw = (reply.body?.answers ?? []) as string[][];
    const answers: QuestionAnswers = {};
    questions.forEach((question, index) => {
      if (raw[index]) answers[question.question] = raw[index];
    });
    return { kind: "answered", answers };
  }

  private expire: (() => void) | undefined;
  private expiry = this.newExpiry();

  private newExpiry(): Promise<undefined> {
    return new Promise<undefined>((resolve) => { this.expire = () => resolve(undefined); });
  }

  async requestPermission(description: string): Promise<PermissionOutcome> {
    const reply = await this.raise("permission", { permission: "bash", patterns: [description], metadata: {}, always: [] });
    const value = String(reply.body?.reply ?? "");
    const message = typeof reply.body?.message === "string" ? reply.body.message : undefined;
    const decision = value === "once" ? "accept" : value === "always" ? "acceptForSession" : "decline";
    return { decision, ...(message ? { message } : {}) };
  }

  proposePlan(markdown: string): undefined {
    void this.endTurn(markdown);
    return undefined;
  }

  async endTurn(text = "Done."): Promise<void> {
    const id = this.activeSessionId;
    if (!id) throw new Error("no active OpenCode session");
    const records = this.messages.get(id) ?? [];
    const created = 1_000 + records.length * 1_000;
    const messageID = `msg_asst_${records.length}`;
    const partID = `prt_${records.length}`;
    records.push({
      info: {
        role: "assistant",
        id: messageID,
        sessionID: id,
        parentID: `msg_user_${this.turns.length}`,
        providerID: OPENCODE_MODEL.providerID,
        modelID: OPENCODE_MODEL.modelID,
        mode: "build",
        agent: "build",
        path: { cwd: OPENCODE_DIRECTORY, root: OPENCODE_DIRECTORY },
        cost: 0,
        tokens: { total: 2, input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created, completed: created + 10 },
      },
      parts: [{ id: partID, sessionID: id, messageID, type: "text", text }],
    });
    this.busy = false;
    this.emit({ type: "message.part.delta", properties: { sessionID: id, field: "text", delta: text, messageID, partID } });
    this.emit({ type: "session.status", properties: { sessionID: id, status: { type: "idle" } } });
    this.emit({ type: "session.idle", properties: { sessionID: id } });
  }

  /** Drop every open `/global/event` stream (a network blip); the harness reconnects. */
  dropEventStreams(): void {
    for (const stream of this.streams.splice(0)) {
      try { stream.error(new Error("socket hang up")); } catch { /* already closed */ }
    }
  }

  /** Number of `/global/event` streams currently open. */
  get openEventStreams(): number {
    return this.streams.length;
  }

  async crashMidTurn(): Promise<void> {
    if (!this.busy) throw new Error("no running OpenCode turn");
    this.busy = false;
    const onExit = this.serverExit;
    if (!onExit) throw new Error("the OpenCode harness registered no server-exit handler");
    onExit("opencode serve exited with code 1");
  }

  private serverExit: ((reason: string) => void) | undefined;

  async expirePendingRequest(): Promise<void> {
    const requestId = this.pendingRequestId;
    if (!requestId) throw new Error("no pending OpenCode request");
    this.pendingRequestId = undefined;
    this.replyWaiters.delete(requestId);
    this.emit({ type: `${this.pendingKind}.rejected`, properties: { sessionID: this.activeSessionId, requestID: requestId } });
    this.expire?.();
    this.expiry = this.newExpiry();
  }
}

export function createBackend(name: BackendName): BackendDriver {
  switch (name) {
    case "claude-code":
      return new ClaudeBackend();
    case "codex":
      return new CodexBackend();
    case "opencode":
      return new OpenCodeBackend();
  }
}
