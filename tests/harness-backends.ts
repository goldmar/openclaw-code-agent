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
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
import { OpenCodeFakeServer } from "./opencode-fake-server";
import type { AgentHarness } from "../src/harness/types";
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

  private queryHandle(output: Pushable<unknown>): Record<string | symbol, unknown> & Pick<Query, "close"> {
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
      close: () => output.end(),
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

export class OpenCodeBackend implements BackendDriver {
  readonly name="opencode" as const;
  readonly fake=new OpenCodeFakeServer();
  readonly turns:BackendTurn[]=[];
  readonly steers:string[]=[];
  readonly supportsPermissionRequests=true;
  readonly nativePlanDecisions=true;
  readonly harness:AgentHarness;
  private activeSessionId:string|undefined;
  get requests(){return this.fake.requests;}
  get protocolViolations(){return this.fake.protocolViolations;}
  get fetch(){return this.fake.fetch;}
  get openEventStreams(){return this.fake.streams.size;}
  constructor(){
    this.fake.onPrompt=(id,text,delivery)=>{this.activeSessionId=id;if(delivery === "steer")this.steers.push(text);else this.turns.push({text,planMode:this.fake.sessions.get(id).agent === "plan"});};
    this.harness=new OpenCodeHarness({createServer:async()=>this.fake.handle(),fetch:this.fake.fetch,serverIdleShutdownMs:0,streamReconnectDelayMs:5});
  }
  waitForTurns(count:number):Promise<void>{return waitUntil(()=>this.turns.length>=count && this.fake.streams.size>0,`${count} OpenCode turn(s)`);}
  async ask(questions:QuestionSpec[]):Promise<QuestionOutcome>{
    const request=await this.fake.askForm(this.activeSessionId!,questions.map((q,i)=>({key:`q${i}`,title:q.header ?? q.id,description:q.question,type:q.multiSelect?"multiselect":"string",options:(q.options ?? []).map(label=>({label,value:label,description:`${label} option`})),custom:q.other!==false})));
    if(request.method === "DELETE")return {kind:"cancelled",reason:"question rejected by the server"};
    const answers:QuestionAnswers={};questions.forEach((q,i)=>{const a=request.body?.answer?.[`q${i}`];if(a!==undefined)answers[q.question]=Array.isArray(a)?a:[a];});return {kind:"answered",answers};
  }
  async requestPermission(description:string):Promise<PermissionOutcome>{const reply=await this.fake.askPermission(this.activeSessionId!,description);return {decision:reply.body?.decision === "once"?"accept":reply.body?.decision === "always"?"acceptForSession":"decline",...(reply.body?.message?{message:reply.body.message}:{})};}
  proposePlan(markdown:string):undefined{void this.endTurn(markdown);return undefined;}
  async endTurn(text="Done."):Promise<void>{this.fake.end(this.activeSessionId!,text);}
  dropEventStreams():void{this.fake.dropStreams();}
  async crashMidTurn():Promise<void>{this.fake.crash();}
  async expirePendingRequest():Promise<void>{
    for(const value of this.fake.forms.values()){
      this.fake.forms.delete(value.id);this.fake.event("form.cancelled",{sessionID:value.sessionID,id:value.id});this.fake.replyWaiters.get(value.id)?.({method:"DELETE",path:`/api/session/${value.sessionID}/form/${value.id}`});this.fake.replyWaiters.delete(value.id);
    }
    for(const value of this.fake.permissions.values()){this.fake.permissions.delete(value.id);this.fake.event("permission.replied",{sessionID:value.sessionID,requestID:value.id,reply:"reject"});}
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
