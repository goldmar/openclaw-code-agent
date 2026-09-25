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
import { OpenCodeHarness } from "../src/harness/opencode";
import type { AgentHarness } from "../src/harness/types";

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

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      while (this.items.length > 0) yield this.items.shift()!;
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
      interrupt: async () => undefined,
      getContextUsage: async () => { throw new Error("not supported by the fake query"); },
      supportedModels: async () => [],
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
}

// ---------------------------------------------------------------------------
// Codex: fake app-server JSON-RPC client behind CodexHarness
// ---------------------------------------------------------------------------

const CODEX_THREAD_ID = "123e4567-e89b-12d3-a456-426614174000";

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
  private notificationHandler: JsonRpcNotificationHandler = () => undefined;
  private requestHandler: JsonRpcRequestHandler = async () => ({});
  private activeTurnId: string | undefined;
  private turnCounter = 0;
  private requestCounter = 0;
  private pendingRequest: CodexServerRequest | undefined;

  constructor() {
    this.harness = new CodexHarness({ createClient: () => this.client() });
  }

  private client(): JsonRpcClient {
    return {
      connect: async () => undefined,
      close: async () => undefined,
      notify: async () => undefined,
      setNotificationHandler: (handler) => { this.notificationHandler = handler; },
      setRequestHandler: (handler) => { this.requestHandler = handler; },
      setCloseHandler: () => undefined,
      request: async (method, params) => this.handle(method, (params ?? {}) as Record<string, unknown>),
    };
  }

  private threadResponse(threadId: string): Record<string, unknown> {
    return {
      thread: { id: threadId },
      model: "gpt-6-sol",
      modelProvider: "openai",
      serviceTier: null,
      cwd: "/tmp",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite" },
      activePermissionProfile: null,
      reasoningEffort: null,
    };
  }

  private async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        return { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" };
      case "account/read":
        return { account: null, requiresOpenaiAuth: false, workspaceRouting: null };
      case "model/list":
        return { data: [], nextCursor: null };
      case "thread/start":
        this.threadStartParams.push(params);
        return this.threadResponse(CODEX_THREAD_ID);
      case "thread/resume":
        this.threadStartParams.push(params);
        return this.threadResponse(String(params.threadId));
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
          void this.notificationHandler("turn/started", { threadId: CODEX_THREAD_ID, turn: this.turnPayload(turnId, "inProgress") });
        });
        return { turn: this.turnPayload(turnId, "inProgress") };
      }
      case "turn/steer": {
        if (!this.activeTurnId || params.expectedTurnId !== this.activeTurnId) throw new Error("no active turn to steer");
        const input = Array.isArray(params.input) ? params.input : [];
        this.steers.push(input.map((item) => String((item as { text?: unknown }).text ?? "")).join(""));
        return { turnId: this.activeTurnId };
      }
      case "turn/interrupt":
        return {};
      default:
        throw new Error(`fake Codex app server does not implement ${method}`);
    }
  }

  private turnPayload(id: string, status: string): Record<string, unknown> {
    return { id, items: [], itemsView: "notLoaded", status, error: null, startedAt: null, completedAt: null, durationMs: 1 };
  }

  waitForTurns(count: number): Promise<void> {
    return waitUntil(() => this.turns.length >= count && !!this.activeTurnId, `${count} Codex turn(s)`);
  }

  private serverRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.activeTurnId) throw new Error("no active Codex turn");
    this.requestCounter += 1;
    const id = this.requestCounter;
    const response = this.requestHandler(method, {
      threadId: CODEX_THREAD_ID,
      turnId: this.activeTurnId,
      itemId: `item-${id}`,
      ...params,
    }, id);
    this.pendingRequest = { id, method, response };
    void response.finally(() => {
      if (this.pendingRequest?.id === id) this.pendingRequest = undefined;
    }).catch(() => undefined);
    return response;
  }

  async ask(questions: QuestionSpec[]): Promise<QuestionOutcome> {
    const response = await this.serverRequest("item/tool/requestUserInput", {
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
    }) as { answers?: Record<string, { answers: string[] } | undefined> };
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
    const response = await this.serverRequest("item/commandExecution/requestApproval", {
      command: description,
      cwd: "/tmp",
      reason: "The test needs it",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    }) as { decision: PermissionOutcome["decision"] };
    return { decision: response.decision };
  }

  proposePlan(markdown: string): undefined {
    void (async () => {
      const turnId = this.activeTurnId;
      await this.notificationHandler("turn/plan/updated", {
        threadId: CODEX_THREAD_ID,
        turnId,
        explanation: "Implementation plan",
        plan: [{ step: "Change the code", status: "pending" }],
      });
      await this.notificationHandler("item/completed", {
        threadId: CODEX_THREAD_ID,
        turnId,
        completedAtMs: 0,
        item: { type: "plan", id: `plan-${turnId}`, text: markdown },
      });
      await this.endTurn(markdown);
    })();
    return undefined;
  }

  async endTurn(text = "Done."): Promise<void> {
    const turnId = this.activeTurnId;
    if (!turnId) throw new Error("no active Codex turn to end");
    await this.notificationHandler("item/completed", {
      threadId: CODEX_THREAD_ID,
      turnId,
      completedAtMs: 0,
      item: { type: "agentMessage", id: `msg-${turnId}-${text.length}`, text, phase: null, memoryCitation: null, delivery: null, questions: null },
    });
    this.activeTurnId = undefined;
    await this.notificationHandler("turn/completed", { threadId: CODEX_THREAD_ID, turn: this.turnPayload(turnId, "completed") });
  }

  async expirePendingRequest(): Promise<void> {
    const pending = this.pendingRequest;
    if (!pending) throw new Error("no pending Codex server request");
    await this.notificationHandler("serverRequest/resolved", { threadId: CODEX_THREAD_ID, requestId: pending.id });
  }
}

// ---------------------------------------------------------------------------
// OpenCode: fake HTTP/SSE server behind OpenCodeHarness
// ---------------------------------------------------------------------------

type OpenCodeRequest = { method: string; path: string; body?: Record<string, unknown> };

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

export class OpenCodeBackend implements BackendDriver {
  readonly name = "opencode" as const;
  readonly harness: AgentHarness;
  readonly turns: BackendTurn[] = [];
  readonly steers: string[] = [];
  readonly supportsPermissionRequests = true;
  readonly nativePlanDecisions = true;
  readonly requests: OpenCodeRequest[] = [];
  private readonly streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  private readonly encoder = new TextEncoder();
  private readonly messages = new Map<string, unknown[]>();
  private sessionCounter = 0;
  private requestCounter = 0;
  private activeSessionId: string | undefined;
  private busy = false;
  private readonly replyWaiters = new Map<string, (request: OpenCodeRequest) => void>();
  private pendingRequestId: string | undefined;
  private pendingKind: "question" | "permission" | undefined;

  constructor() {
    this.harness = new OpenCodeHarness({
      createServer: async () => ({
        baseUrl: "http://opencode.test",
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

  private readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const request = { method, path, body };
    this.requests.push(request);
    if (path === "/global/event") {
      return new Response(new ReadableStream<Uint8Array>({
        start: (controller) => { this.streams.push(controller); },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (method === "POST" && path === "/session") {
      this.sessionCounter += 1;
      const id = `ses_${this.sessionCounter}`;
      this.messages.set(id, []);
      return json({ id });
    }
    if (method === "GET" && path === "/session/status") {
      return json(this.activeSessionId && this.busy ? { [this.activeSessionId]: { type: "busy" } } : {});
    }
    const messageMatch = /^\/session\/([^/]+)\/message$/.exec(path);
    if (method === "GET" && messageMatch) return json(this.messages.get(messageMatch[1]) ?? []);
    const promptMatch = /^\/session\/([^/]+)\/prompt_async$/.exec(path);
    if (method === "POST" && promptMatch) {
      const id = promptMatch[1];
      this.activeSessionId = id;
      this.busy = true;
      const parts = Array.isArray(body?.parts) ? body.parts : [];
      const text = parts.map((part) => String((part as { text?: unknown }).text ?? "")).join("");
      this.turns.push({ text, planMode: body?.agent === "plan" });
      this.messages.get(id)?.push({ info: { role: "user", id: `msg_user_${this.turns.length}` }, parts: [] });
      queueMicrotask(() => this.emit({ type: "session.status", properties: { sessionID: id, status: { type: "busy" } } }));
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && /^\/session\/[^/]+\/abort$/.test(path)) return json(true);
    const sessionMatch = /^\/session\/([^/]+)$/.exec(path);
    if (sessionMatch && (method === "GET" || method === "PATCH")) return json({ id: sessionMatch[1], cost: 0 });
    const replyMatch = /^\/(permission|question)\/([^/]+)\/reply$/.exec(path);
    if (method === "POST" && replyMatch) {
      const waiter = this.replyWaiters.get(replyMatch[2]);
      this.replyWaiters.delete(replyMatch[2]);
      waiter?.(request);
      if (this.pendingRequestId === replyMatch[2]) {
        const requestId = replyMatch[2];
        const kind = replyMatch[1];
        this.pendingRequestId = undefined;
        queueMicrotask(() => this.emit({ type: `${kind}.replied`, properties: { sessionID: this.activeSessionId, requestID: requestId } }));
      }
      return json(true);
    }
    return new Response(JSON.stringify({ error: `unexpected ${method} ${path}` }), { status: 404 });
  };

  private emit(payload: unknown): void {
    const frame = this.encoder.encode(`data: ${JSON.stringify({ directory: "/tmp", payload })}\n\n`);
    for (const stream of this.streams) {
      try { stream.enqueue(frame); } catch { /* closed */ }
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
    const reply = await this.raise("permission", { permission: "bash", patterns: [description] });
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
    records.push({
      info: {
        role: "assistant",
        id: `msg_asst_${records.length}`,
        providerID: "opencode",
        modelID: "test",
        cost: 0,
        tokens: { total: 2, input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created, completed: created + 10 },
      },
      parts: [{ type: "text", text }],
    });
    this.busy = false;
    this.emit({ type: "message.part.delta", properties: { sessionID: id, field: "text", delta: text, messageID: `msg_asst_${records.length}`, partID: "p1" } });
    this.emit({ type: "session.status", properties: { sessionID: id, status: { type: "idle" } } });
    this.emit({ type: "session.idle", properties: { sessionID: id } });
  }

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
