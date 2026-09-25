import "./test-env";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHarness, listHarnesses } from "../src/harness/index";
import { CodexHarness, DEFAULT_APP_SERVER_ARGS, DEFAULT_REQUEST_TIMEOUT_MS, isCodexAppServerSessionId } from "../src/harness/codex";
import { JsonRpcResponseError, StdioJsonRpcClient, dispatchJsonRpcEnvelope, type JsonRpcId } from "../src/harness/codex-rpc";
import { codexModelSupportsEffort, recordCodexModelCatalog, resetCodexModelCatalogForTests } from "../src/harness/codex-model-catalog";
import { MIN_CODEX_CLI_VERSION, codexVersionError, codexVersionFromUserAgent } from "../src/harness/codex-protocol";
import { getCodexRateLimits, listCodexRateLimits, resetCodexRateLimitsForTests } from "../src/harness/codex-rate-limits";
import { setPluginConfig } from "../src/config";
import { setPluginRuntime } from "../src/runtime-store";
import type { HarnessMessage, HarnessSession } from "../src/harness/types";
import type { TokenUsageBreakdown } from "../src/harness/codex-app-server-protocol/v2/TokenUsageBreakdown";
import type { Model } from "../src/harness/codex-app-server-protocol/v2/Model";
import type { RateLimitSnapshot } from "../src/harness/codex-app-server-protocol/v2/RateLimitSnapshot";
import { codexCatalogModel } from "./codex-model-catalog-fixture";
import type {
  GetAccountRateLimitsResponse,
  ReviewStartResponse,
  ThreadCompactStartResponse,
  ThreadForkResponse,
  ThreadRevertResponse,
  ThreadTurnsListResponse,
  TurnInterruptResponse,
  TurnSteerResponse,
} from "../src/harness/codex-app-server-protocol";
import type { TurnError } from "../src/harness/codex-app-server-protocol/v2/TurnError";
import type { TurnStatus } from "../src/harness/codex-app-server-protocol/v2/TurnStatus";
import {
  CodexProtocolChecker,
  codexAgentMessage,
  codexInitializeResponse,
  codexPlanItem,
  codexThread,
  codexThreadResumeResponse,
  codexThreadStartResponse,
  codexTurn,
  codexUserAgent,
  type CodexThreadResponseOptions,
  type GetAccountResponse,
  type ModelListResponse,
  type Turn,
  type TurnStartResponse,
} from "./codex-fixtures";

type NotificationHandler = (method: string, params: unknown) => Promise<void> | void;
type RequestHandler = (method: string, params: unknown, id: JsonRpcId) => Promise<unknown>;
type ClientSettings = { command: string; args: string[]; requestTimeoutMs: number };

const CODEX_TIMEOUT_ENV = "OPENCLAW_CODEX_APP_SERVER_TIMEOUT_MS";
const CODEX_ARGS_ENV = "OPENCLAW_CODEX_APP_SERVER_ARGS";
const VALID_THREAD_ID = "123e4567-e89b-12d3-a456-426614174000";
const FORKED_THREAD_ID = "223e4567-e89b-12d3-a456-426614174000";

type ServerRequestSpec = { method: string; params: Record<string, unknown>; id?: JsonRpcId };

type MockOptions = {
  threadId?: string;
  threadModel?: string;
  serviceTier?: string | null;
  accountType?: "apiKey" | "chatgpt";
  assistantText?: string;
  agentMessageSnapshot?: string;
  finalPlanMarkdown?: string;
  turnStatus?: "completed" | "failed" | "interrupted";
  turnError?: { message: string; codexErrorInfo?: unknown };
  serverRequest?: ServerRequestSpec;
  tokenUsage?: TokenUsageBreakdown[];
  reroutedModel?: string;
  failResume?: string;
  /** Leave user turns running until `completeTurn()` is called. */
  holdTurns?: boolean;
  turnsList?: string[];
  models?: Model[];
  rateLimitsUsedPercent?: number;
  rateLimitsResetsAt?: number;
  accountId?: string | null;
  /** Turns returned by thread/turns/list pages (newest first), chunked per page. */
  turnsPages?: Array<Array<{ id: string; status?: TurnStatus }>>;
  steerError?: string;
  /** `initialize` userAgent; defaults to a supported Codex version. */
  userAgent?: string;
};

function breakdown(input: number, cached: number, write: number, output: number, reasoning: number, total = input + output): TokenUsageBreakdown {
  return {
    totalTokens: total,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: write,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
  };
}

function turnPayload(id: string, status: TurnStatus, error?: MockOptions["turnError"]): Turn {
  return {
    ...codexTurn(id, status, error ? { message: error.message, codexErrorInfo: (error.codexErrorInfo ?? null) as TurnError["codexErrorInfo"], additionalDetails: null, misalignment: null } : null),
    durationMs: 42,
  };
}

class MockCodexClient {
  /** Checks OCA's request params, the mock's results, and its notifications against the vendored JSON Schema. */
  readonly protocol = new CodexProtocolChecker();
  requests: Array<{ method: string; params: unknown; timeoutMs: number | undefined }> = [];
  serverResponses: unknown[] = [];
  closeCalls = 0;
  private turnCounter = 0;
  private activeTurnId: string | undefined;
  notificationHandler: NotificationHandler = () => undefined;
  requestHandler: RequestHandler = async () => ({});
  closeHandler: (() => void) | undefined;

  constructor(readonly options: MockOptions = {}) {}

  setNotificationHandler(handler: NotificationHandler): void { this.notificationHandler = handler; }
  setRequestHandler(handler: RequestHandler): void { this.requestHandler = handler; }
  setCloseHandler(handler: () => void): void { this.closeHandler = handler; }
  async connect(): Promise<void> {}
  async close(): Promise<void> { this.closeCalls += 1; }
  async notify(): Promise<void> {}

  get threadId(): string {
    return this.options.threadId ?? VALID_THREAD_ID;
  }

  private threadOptions(params: Record<string, unknown>): CodexThreadResponseOptions {
    return {
      model: (params.model as string | undefined) ?? this.options.threadModel ?? "gpt-6-sol",
      serviceTier: this.options.serviceTier ?? null,
      cwd: (params.cwd as string | undefined) ?? "/tmp",
    };
  }

  /** Deliver a server notification after checking it against the schema. */
  private async emitNotification(method: string, params: unknown): Promise<void> {
    this.protocol.notification(method, params);
    await this.notificationHandler(method, params);
  }

  async request(method: string, params: unknown = {}, timeoutMs?: number): Promise<unknown> {
    this.requests.push({ method, params, timeoutMs });
    this.protocol.clientRequest(method, params);
    return this.protocol.clientResult(method, this.respond(method, (params ?? {}) as Record<string, unknown>));
  }

  private respond(method: string, record: Record<string, unknown>): unknown {
    switch (method) {
      case "initialize":
        return codexInitializeResponse(this.options.userAgent);
      case "account/read":
        return {
          account: this.options.accountType === "chatgpt"
            ? { type: "chatgpt", email: null, planType: "pro" }
            : this.options.accountType === "apiKey" ? { type: "apiKey" } : null,
          requiresOpenaiAuth: true,
          workspaceRouting: null,
        } satisfies GetAccountResponse;
      case "account/rateLimits/read":
        return {
          ordinaryUsageAllowed: true,
          rateLimits: {
            limitId: "codex",
            limitName: null,
            normalModelSlug: null,
            primary: { usedPercent: this.options.rateLimitsUsedPercent ?? 12, windowDurationMins: 300, resetsAt: this.options.rateLimitsResetsAt ?? 4_000_000_000 },
            secondary: null,
            credits: null,
            individualLimit: null,
            spendControlReached: null,
            planType: "pro",
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
          rateLimitResetCredits: null,
          accountId: this.options.accountId ?? null,
          rateLimitUpsell: null,
        } satisfies GetAccountRateLimitsResponse;
      case "model/list":
        return { data: this.options.models ?? [], nextCursor: null } satisfies ModelListResponse;
      case "thread/start":
        return codexThreadStartResponse(this.threadId, this.threadOptions(record));
      case "thread/resume":
        if (this.options.failResume) throw new Error(this.options.failResume);
        return codexThreadResumeResponse(record.threadId as string, this.threadOptions(record));
      case "thread/fork":
        return codexThreadStartResponse(FORKED_THREAD_ID, this.threadOptions(record)) satisfies ThreadForkResponse;
      case "thread/turns/list": {
        if (this.options.turnsPages) {
          const index = record.cursor ? Number(record.cursor) : 0;
          const page = this.options.turnsPages[index] ?? [];
          return {
            data: page.map((turn) => turnPayload(turn.id, turn.status ?? "completed")),
            nextCursor: index + 1 < this.options.turnsPages.length ? String(index + 1) : null,
            backwardsCursor: null,
          } satisfies ThreadTurnsListResponse;
        }
        return {
          data: (this.options.turnsList ?? []).map((id) => turnPayload(id, "completed")),
          nextCursor: null,
          backwardsCursor: null,
        } satisfies ThreadTurnsListResponse;
      }
      case "thread/revert":
        return { thread: codexThread(record.threadId as string), turnsBackwardsCursor: null, itemsBackwardsCursor: null } satisfies ThreadRevertResponse;
      case "turn/interrupt":
        return {} satisfies TurnInterruptResponse;
      case "turn/steer":
        if (this.options.steerError) throw new Error(this.options.steerError);
        if (record.expectedTurnId !== this.activeTurnId) throw new Error("codex app server rpc error (-32600): no active turn to steer");
        return { turnId: this.activeTurnId! } satisfies TurnSteerResponse;
      case "turn/start":
        return { turn: turnPayload(this.startTurn("user"), "inProgress") } satisfies TurnStartResponse;
      case "thread/compact/start":
        this.startTurn("compact");
        return {} satisfies ThreadCompactStartResponse;
      case "review/start":
        return { turn: turnPayload(this.startTurn("review"), "inProgress"), reviewThreadId: this.threadId } satisfies ReviewStartResponse;
      default:
        throw new Error(`mock does not implement ${method}`);
    }
  }

  private startTurn(kind: "user" | "compact" | "review"): string {
    this.turnCounter += 1;
    const turnId = `turn-${this.turnCounter}`;
    this.activeTurnId = turnId;
    queueMicrotask(() => { void this.runTurn(turnId, kind); });
    return turnId;
  }

  private async runTurn(turnId: string, kind: "user" | "compact" | "review"): Promise<void> {
    const threadId = this.threadId;
    await this.emitNotification("turn/started", { threadId, turn: turnPayload(turnId, "inProgress") });
    if (kind === "compact") {
      await this.emitNotification("item/completed", { threadId, turnId, completedAtMs: 0, item: { type: "contextCompaction", id: "c-1" } });
      await this.completeTurn(turnId);
      return;
    }
    if (kind === "review") {
      await this.emitNotification("item/completed", { threadId, turnId, completedAtMs: 0, item: { ...codexAgentMessage("r-1", "No findings."), phase: "final_answer" } });
      await this.completeTurn(turnId);
      return;
    }
    if (this.options.serverRequest) {
      const id = this.options.serverRequest.id ?? 0;
      const response = await this.requestHandler(
        this.options.serverRequest.method,
        { threadId, turnId, ...this.options.serverRequest.params },
        id,
      ).catch((error: unknown) => ({ rpcError: error instanceof JsonRpcResponseError ? error.code : String(error) }));
      this.serverResponses.push(response);
      await this.emitNotification("serverRequest/resolved", { threadId, requestId: id });
    }
    if (this.options.assistantText) {
      await this.emitNotification("item/agentMessage/delta", { threadId, turnId, itemId: "msg-1", delta: this.options.assistantText });
      await this.emitNotification("item/completed", { threadId, turnId, completedAtMs: 0, item: codexAgentMessage("msg-1", this.options.assistantText) });
    }
    if (this.options.agentMessageSnapshot) {
      await this.emitNotification("item/completed", { threadId, turnId, completedAtMs: 0, item: codexAgentMessage("msg-2", this.options.agentMessageSnapshot) });
    }
    if (this.options.finalPlanMarkdown) {
      await this.emitNotification("turn/plan/updated", { threadId, turnId, explanation: "Implementation plan", plan: [{ step: "Update code", status: "pending" }] });
      await this.emitNotification("item/completed", { threadId, turnId, completedAtMs: 0, item: codexPlanItem("plan-1", this.options.finalPlanMarkdown) });
    }
    if (this.options.reroutedModel) {
      await this.emitNotification("model/rerouted", { threadId, turnId, fromModel: "gpt-5.6-sol", toModel: this.options.reroutedModel, reason: "highRiskCyberActivity" });
    }
    let total = 0;
    for (const last of this.options.tokenUsage ?? []) {
      total += last.totalTokens;
      await this.emitNotification("thread/tokenUsage/updated", {
        threadId,
        turnId,
        tokenUsage: { total: { ...last, totalTokens: total }, last, modelContextWindow: 258_400 },
      });
    }
    if (!this.options.holdTurns) await this.completeTurn(turnId);
  }

  async completeTurn(turnId = this.activeTurnId!, status?: TurnStatus): Promise<void> {
    if (this.activeTurnId === turnId) this.activeTurnId = undefined;
    await this.emitNotification("turn/completed", {
      threadId: this.threadId,
      turn: turnPayload(turnId, status ?? this.options.turnStatus ?? "completed", this.options.turnError),
    });
  }

  requestsFor(method: string): Array<Record<string, unknown>> {
    return this.requests.filter((request) => request.method === method).map((request) => request.params as Record<string, unknown>);
  }
}

async function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

async function collectMessages(session: { messages: AsyncIterable<HarnessMessage> }, limit = 40): Promise<HarnessMessage[]> {
  const out: HarnessMessage[] = [];
  for await (const message of session.messages) {
    out.push(message);
    if (out.length >= limit || message.type === "run_completed") break;
  }
  return out;
}

async function nextOfType<T extends HarnessMessage["type"]>(
  iter: AsyncIterator<HarnessMessage>,
  type: T,
  seen: HarnessMessage[] = [],
): Promise<Extract<HarnessMessage, { type: T }>> {
  for (let i = 0; i < 40; i += 1) {
    const next = await iter.next();
    if (next.done) break;
    seen.push(next.value);
    if (next.value.type === type) return next.value as Extract<HarnessMessage, { type: T }>;
  }
  throw new Error(`expected a ${type} message`);
}

function runCompleted(messages: HarnessMessage[]): Extract<HarnessMessage, { type: "run_completed" }> | undefined {
  return messages.find((message): message is Extract<HarnessMessage, { type: "run_completed" }> => message.type === "run_completed");
}

function launch(client: MockCodexClient, options: Partial<Parameters<CodexHarness["launch"]>[0]> = {}): HarnessSession {
  return new CodexHarness({ createClient: () => client }).launch({ prompt: "ship it", cwd: "/tmp", ...options });
}

function pushableStream(): { stream: AsyncIterable<unknown>; push: (message: unknown) => void; end: () => void } {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  return {
    stream: (async function* () {
      while (true) {
        while (queue.length > 0) yield queue.shift();
        if (done) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })(),
    push: (message) => { queue.push(message); wake?.(); },
    end: () => { done = true; wake?.(); },
  };
}

beforeEach(() => {
  resetCodexModelCatalogForTests();
  resetCodexRateLimitsForTests();
  setPluginConfig({});
});

afterEach(() => {
  setPluginConfig({});
  setPluginRuntime(undefined);
});

describe("CodexHarness static properties", () => {
  const h = new CodexHarness();

  it("has name 'codex' and supports all permission modes", () => {
    assert.equal(h.name, "codex");
    for (const mode of ["default", "plan", "bypassPermissions"]) assert.ok(h.supportedPermissionModes.includes(mode as never));
  });

  it("exposes native pending-input, plan-artifact, and thread-action capabilities", () => {
    assert.equal(h.capabilities.nativePendingInput, true);
    assert.equal(h.capabilities.nativePlanArtifacts, true);
    assert.deepEqual([...h.capabilities.threadActions], ["compact", "review"]);
    assert.equal(Object.hasOwn(h.capabilities, "worktrees"), false);
  });

  it("builds user and thread-action messages", () => {
    assert.deepEqual(h.buildUserMessage("hello", "sess-xyz"), { type: "user", text: "hello", session_id: "sess-xyz" });
    assert.deepEqual(h.buildThreadActionMessage({ kind: "compact" }), { type: "codex_thread_action", action: { kind: "compact" } });
  });

  it("is registered as the codex harness", () => {
    assert.ok(getHarness("codex") instanceof CodexHarness);
    assert.ok(listHarnesses().includes("codex"));
  });
});

describe("Codex App Server RPC transport", () => {
  it("never leaves an orphaned pending request when a write fails (Gateway crash regression)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const client = new StdioJsonRpcClient("codex", DEFAULT_APP_SERVER_ARGS, 1_000);
      // Not connected (as after the session closed the transport): the write throws.
      await assert.rejects(() => client.request("review/start", { threadId: VALID_THREAD_ID }), /stdio not connected/);
      assert.equal((client as unknown as { pending: Map<string, unknown> }).pending.size, 0);
      // Closing afterwards must not reject anything nobody is listening to.
      await client.close();
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("passes the JSON-RPC id to request handlers and maps typed errors to their code", async () => {
    const frames: unknown[] = [];
    const seenIds: JsonRpcId[] = [];
    const onRequest = async (method: string, _params: unknown, id: JsonRpcId) => {
      seenIds.push(id);
      if (method === "unsupported") throw new JsonRpcResponseError(-32601, "nope");
      return { ok: true };
    };
    const common = { pending: new Map(), onNotification: (): undefined => undefined, onRequest, respond: (frame: unknown) => { frames.push(frame); } };
    await dispatchJsonRpcEnvelope({ jsonrpc: "2.0", id: 7, method: "supported", params: {} }, common);
    await dispatchJsonRpcEnvelope({ jsonrpc: "2.0", id: 8, method: "unsupported", params: {} }, common);
    assert.deepEqual(seenIds, [7, 8]);
    assert.deepEqual(frames, [
      { jsonrpc: "2.0", id: 7, result: { ok: true } },
      { jsonrpc: "2.0", id: 8, error: { code: -32601, message: "nope" } },
    ]);
  });

  it("answers server requests with method-not-found when no handler is installed", async () => {
    const client = new StdioJsonRpcClient("true", [], 1000);
    const handler = (client as unknown as { onRequest: RequestHandler }).onRequest;
    await assert.rejects(handler("whatever", {}, 1), (error: unknown) => error instanceof JsonRpcResponseError && error.code === -32601);
  });

  it("redacts raw process command arguments from spawn diagnostics", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const originalDebug = console.debug;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    // Routine transport events (spawn, close) log at debug.
    console.debug = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const client = new StdioJsonRpcClient("true", ["--token", "secret-token"], 1234);
      let closed = 0;
      client.setCloseHandler(() => { closed += 1; });
      await client.connect();
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
      await client.close();
      const joined = warnings.join("\n");
      assert.doesNotMatch(joined, /secret-token/);
      assert.doesNotMatch(joined, /"args"/);
      const spawn = warnings.map((warning) => JSON.parse(warning) as Record<string, unknown>).find((entry) => entry.event === "process.spawn");
      assert.equal(spawn?.commandKind, "custom");
      assert.equal(spawn?.configuredArgCount, 2);
      assert.equal(closed, 1, "close handler fires when the child exits");
    } finally {
      console.warn = originalWarn;
      console.debug = originalDebug;
    }
  });

  it("does not release close until a SIGTERM-resistant child has actually exited", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "oca-codex-rpc-close-"));
    const fixturePath = join(fixtureDir, "ignore-sigterm.mjs");
    const readyPath = join(fixtureDir, "ready");
    writeFileSync(fixturePath, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => {});\nwriteFileSync(${JSON.stringify(readyPath)}, 'ok');\nsetInterval(() => {}, 1000);\n`);
    chmodSync(fixturePath, 0o755);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const originalDebug = console.debug;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    console.debug = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const client = new StdioJsonRpcClient(fixturePath, [], 1_000, 10);
      await client.connect();
      // Wait until the child has installed its SIGTERM handler (slow under load).
      for (let i = 0; i < 200 && !existsSync(readyPath); i += 1) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
      }
      await client.close();
      const events = warnings.map((warning) => JSON.parse(warning) as { event?: string });
      const forceKillIndex = events.findIndex((entry) => entry.event === "process.force_kill");
      assert.ok(forceKillIndex >= 0);
      assert.ok(events.findIndex((entry) => entry.event === "process.close") > forceKillIndex);
    } finally {
      console.warn = originalWarn;
      console.debug = originalDebug;
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("fails pending requests, fires the close handler, and drops late replies when the app server dies mid-turn", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "oca-codex-rpc-crash-"));
    const fixturePath = join(fixtureDir, "crash-mid-turn.mjs");
    // A minimal app server: answers initialize, then on turn/start asks the
    // client a question and exits before the turn (or the question) completes.
    writeFileSync(fixturePath, [
      "#!/usr/bin/env node",
      "import readline from 'node:readline';",
      "const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');",
      "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
      "  const frame = JSON.parse(line);",
      "  if (frame.method === 'initialize') out({ jsonrpc: '2.0', id: frame.id, result: {} });",
      "  if (frame.method === 'turn/start') {",
      "    out({ jsonrpc: '2.0', id: 'srv-1', method: 'item/tool/requestUserInput', params: { questions: [] } });",
      "    setTimeout(() => process.exit(3), 20);",
      "  }",
      "});",
    ].join("\n"));
    chmodSync(fixturePath, 0o755);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    const logs: string[] = [];
    const originalWarn = console.warn;
    const originalDebug = console.debug;
    console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.debug = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
      const client = new StdioJsonRpcClient(fixturePath, [], 5_000, 10);
      let closed = 0;
      client.setCloseHandler(() => { closed += 1; });
      const question = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<Record<string, unknown>>();
      // The user answers only after the server died: the late reply cannot be written.
      client.setRequestHandler(async () => {
        question.resolve();
        return await reply.promise;
      });
      await client.connect();
      assert.deepEqual(await client.request("initialize", {}), {});
      const turn = client.request("turn/start", { threadId: VALID_THREAD_ID });
      await question.promise;
      await assert.rejects(turn, /codex app server stdio closed/);
      assert.equal(closed, 1, "the close handler fires once");
      await assert.rejects(() => client.request("turn/interrupt", {}), /stdio not connected/);
      reply.resolve({ answers: {} });
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
      const events = logs.map((line) => JSON.parse(line) as { event?: string; code?: number; pendingRequests?: number });
      assert.ok(events.some((entry) => entry.event === "line.failed"), "the late reply is logged, not thrown");
      const close = events.find((entry) => entry.event === "process.close");
      assert.equal(close?.code, 3);
      assert.equal(close?.pendingRequests, 1);
      await client.close();
      assert.deepEqual(unhandled, []);
    } finally {
      console.warn = originalWarn;
      console.debug = originalDebug;
      process.off("unhandledRejection", onUnhandled);
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("redacts sensitive stderr details from Codex app-server timeout errors", () => {
    const client = new StdioJsonRpcClient("codex", DEFAULT_APP_SERVER_ARGS, DEFAULT_REQUEST_TIMEOUT_MS) as unknown as {
      stderrTail: string;
      buildTimeoutErrorMessage: (method: string, timeoutMs: number) => string;
    };
    client.stderrTail = [
      "api_key=sk-test-secret1234567890",
      "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
      '{"password":"hunter2"}',
      "database postgres://user:secret@db.example.com/openclaw",
      "path /home/alice/projects/private-openclaw/session.log",
      "opaque abcdef1234567890abcdef1234567890",
    ].join("\n");
    const message = client.buildTimeoutErrorMessage("initialize", 120000);
    assert.match(message, /recent stderr:/);
    for (const secret of [/sk-test-secret/, /ghp_abc/, /hunter2/, /user:secret/, /\/home\/alice/, /abcdef1234567890abcdef1234567890/]) {
      assert.doesNotMatch(message, secret);
    }
  });
});

describe("CodexHarness launch settings", () => {
  it("passes the configured request timeout to the client and every request", async () => {
    await withEnv(CODEX_TIMEOUT_ENV, "12345", async () => {
      const client = new MockCodexClient({ assistantText: "Done." });
      const settings: ClientSettings[] = [];
      await collectMessages(new CodexHarness({ createClient: (s) => { settings.push(s); return client; } }).launch({ prompt: "x", cwd: "/tmp" }));
      assert.equal(settings[0]?.requestTimeoutMs, 12345);
      for (const method of ["initialize", "thread/start", "turn/start"]) {
        assert.equal(client.requests.find((request) => request.method === method)?.timeoutMs, 12345, method);
      }
      assert.equal(client.requests.find((request) => request.method === "account/read")?.timeoutMs, 5_000);
    });
  });

  it("falls back to the default timeout for invalid env values", async () => {
    for (const value of ["invalid", "0", "-1"]) {
      await withEnv(CODEX_TIMEOUT_ENV, value, async () => {
        const settings: ClientSettings[] = [];
        await collectMessages(new CodexHarness({ createClient: (s) => { settings.push(s); return new MockCodexClient(); } }).launch({ prompt: "x", cwd: "/tmp" }));
        assert.equal(settings[0]?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
      });
    }
  });

  it("uses stdio listener args by default and lets explicit args override them", async () => {
    for (const [value, expected] of [[undefined, DEFAULT_APP_SERVER_ARGS], ["   ", DEFAULT_APP_SERVER_ARGS], ["--a,--b", ["--a", "--b"]]] as const) {
      await withEnv(CODEX_ARGS_ENV, value, async () => {
        const settings: ClientSettings[] = [];
        await collectMessages(new CodexHarness({ createClient: (s) => { settings.push(s); return new MockCodexClient(); } }).launch({ prompt: "x", cwd: "/tmp" }));
        assert.deepEqual(settings[0]?.args, expected);
      });
    }
  });

  it("initializes without the removed protocolVersion field and opts out of unused delta streams", async () => {
    const client = new MockCodexClient();
    await collectMessages(launch(client));
    const init = client.requestsFor("initialize")[0] as { clientInfo: { name: string; version: string }; capabilities: { optOutNotificationMethods: string[] } };
    assert.equal("protocolVersion" in init, false);
    assert.equal(init.clientInfo.name, "openclaw-code-agent");
    assert.match(init.clientInfo.version, /^\d+\.\d+\.\d+/);
    assert.ok(init.capabilities.optOutNotificationMethods.includes("item/commandExecution/outputDelta"));
    assert.equal(init.capabilities.optOutNotificationMethods.includes("item/agentMessage/delta"), false);
  });

  it("sends the system prompt as thread developer instructions and snake_case collaboration settings (A1)", async () => {
    const client = new MockCodexClient({ assistantText: "ok" });
    await collectMessages(launch(client, {
      model: "gpt-6-astra",
      permissionMode: "plan",
      reasoningEffort: "max",
      fastMode: true,
      systemPrompt: "You are working in a git worktree.",
    }));
    assert.deepEqual(client.requestsFor("thread/start")[0], {
      cwd: "/tmp",
      model: "gpt-6-astra",
      serviceTier: "priority",
      developerInstructions: "You are working in a git worktree.",
      permissions: ":danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    });
    assert.deepEqual(client.requestsFor("turn/start")[0], {
      threadId: VALID_THREAD_ID,
      input: [{ type: "text", text: "ship it", text_elements: [] }],
      model: "gpt-6-astra",
      effort: "max",
      collaborationMode: {
        mode: "plan",
        settings: { model: "gpt-6-astra", reasoning_effort: "max", developer_instructions: null },
      },
    });
  });

  it("uses the thread's reported model for the required collaboration model when none is configured", async () => {
    const client = new MockCodexClient({ threadModel: "gpt-5.6-terra" });
    await collectMessages(launch(client));
    const turn = client.requestsFor("turn/start")[0] as { model: string; collaborationMode: { settings: { model: string } } };
    assert.equal(turn.model, "gpt-5.6-terra");
    assert.equal(turn.collaborationMode.settings.model, "gpt-5.6-terra");
    assert.equal("model" in client.requestsFor("thread/start")[0], false);
  });

  it("applies configured Codex permission profile, approval policy, and reviewer (B5)", async () => {
    setPluginConfig({ harnesses: { codex: { permissionProfile: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "auto_review" } } });
    const client = new MockCodexClient();
    await collectMessages(launch(client, { permissionMode: "bypassPermissions" }));
    const start = client.requestsFor("thread/start")[0];
    assert.equal(start.permissions, ":workspace");
    assert.equal(start.approvalPolicy, "on-request");
    assert.equal(start.approvalsReviewer, "auto_review");
    assert.equal("sandbox" in start, false);
  });

  it("follows the host tools.exec.mode read from the live runtime config at launch", async () => {
    let execMode = "auto";
    setPluginRuntime({ config: { current: () => ({ tools: { exec: { mode: execMode } } }) } });
    const auto = new MockCodexClient();
    await collectMessages(launch(auto));
    const autoStart = auto.requestsFor("thread/start")[0];
    assert.deepEqual([autoStart.permissions, autoStart.approvalPolicy, autoStart.approvalsReviewer], [":workspace", "on-request", "auto_review"]);

    execMode = "full";
    const full = new MockCodexClient();
    await collectMessages(launch(full));
    const fullStart = full.requestsFor("thread/start")[0];
    assert.deepEqual([fullStart.permissions, fullStart.approvalPolicy, fullStart.approvalsReviewer], [":danger-full-access", "never", "user"]);

    // Explicit OCA settings win over the host exec mode.
    execMode = "auto";
    setPluginConfig({ harnesses: { codex: { approvalsReviewer: "user" } } });
    const mixed = new MockCodexClient();
    await collectMessages(launch(mixed));
    const mixedStart = mixed.requestsFor("thread/start")[0];
    assert.deepEqual([mixedStart.permissions, mixedStart.approvalPolicy, mixedStart.approvalsReviewer], [":workspace", "on-request", "user"]);
  });

  it("refuses to launch Codex when tools.exec.mode blocks local execution and no profile is configured", () => {
    setPluginRuntime({ config: { current: () => ({ tools: { exec: { mode: "deny" } } }) } });
    assert.throws(() => launch(new MockCodexClient()), /tools\.exec\.mode is "deny"/);
  });

  it("sends bare Codex model ids and rejects provider-prefixed ones before launch", async () => {
    const client = new MockCodexClient();
    await collectMessages(launch(client, { model: "openai/gpt-5.5" }));
    assert.equal(client.requestsFor("thread/start")[0].model, "gpt-5.5");
    assert.throws(() => launch(new MockCodexClient(), { model: "anthropic/gpt-5.5" }), /Codex model "anthropic\/gpt-5\.5" is not supported/);
  });

  it("drops a reasoning effort that model/list says the model does not support (B9)", async () => {
    const client = new MockCodexClient({
      models: [{
        id: "gpt-5.5",
        model: "gpt-5.5",
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: "GPT-5.5",
        description: "",
        modelSpecialty: null,
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "high", description: "" }],
        defaultReasoningEffort: "low",
        inputModalities: [],
        supportsPersonality: false,
        multiAgentVersion: null,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        availableAccessPrograms: null,
        isDefault: false,
      }],
    });
    await collectMessages(launch(client, { model: "gpt-5.5", reasoningEffort: "max" }));
    const turn = client.requestsFor("turn/start")[0] as { effort?: string; collaborationMode: { settings: { reasoning_effort: string | null } } };
    assert.equal(turn.effort, undefined);
    assert.equal(turn.collaborationMode.settings.reasoning_effort, null);
  });

  it("records ChatGPT account rate limits per account for agent_stats (B14)", async () => {
    await collectMessages(launch(new MockCodexClient({ accountType: "chatgpt", rateLimitsUsedPercent: 64, accountId: "acct-a" })));
    await collectMessages(launch(new MockCodexClient({ accountType: "chatgpt", rateLimitsUsedPercent: 5, accountId: "acct-b" })));
    assert.equal(getCodexRateLimits("acct-a")?.snapshot.primary?.usedPercent, 64);
    assert.equal(getCodexRateLimits("acct-b")?.snapshot.primary?.usedPercent, 5);
    assert.equal(listCodexRateLimits().length, 2);
  });

  it("keeps tracking rate-limit updates when the initial read fails, without merging unknown accounts", async () => {
    const client = new MockCodexClient({ accountType: "chatgpt", holdTurns: true });
    const originalRequest = client.request.bind(client);
    client.request = async (method: string, params?: unknown, timeoutMs?: number) => {
      if (method === "account/rateLimits/read") throw new Error("temporarily unavailable");
      return originalRequest(method, params, timeoutMs);
    };
    const session = launch(client);
    const iter = session.messages[Symbol.asyncIterator]();
    await nextOfType(iter, "run_started");
    const update: RateLimitSnapshot = {
      limitId: "codex", limitName: null, normalModelSlug: null,
      primary: { usedPercent: 81, windowDurationMins: 300, resetsAt: 4_000_000_000 },
      secondary: null, credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null,
    };
    await client.notificationHandler("account/rateLimits/updated", { rateLimits: update });
    assert.deepEqual(listCodexRateLimits().map((state) => state.snapshot.primary?.usedPercent), [81]);
    await client.completeTurn();
    await nextOfType(iter, "run_completed");
  });

  it("reports the effort its own connection applies as backend info", async () => {
    const rejected = await collectMessages(launch(new MockCodexClient({ models: [codexCatalogModel("gpt-5.5", ["low"])] }), { model: "gpt-5.5", reasoningEffort: "high" }));
    assert.deepEqual(rejected.find((message) => message.type === "backend_info"), {
      type: "backend_info",
      info: { model: "gpt-5.5", reasoningEffort: null, reasoningEffortSupported: false },
    });
    const applied = await collectMessages(launch(new MockCodexClient({ models: [codexCatalogModel("gpt-5.5", ["low", "high"])] }), { model: "gpt-5.5", reasoningEffort: "high" }));
    assert.deepEqual(applied.find((message) => message.type === "backend_info"), {
      type: "backend_info",
      info: { model: "gpt-5.5", reasoningEffort: "high", reasoningEffortSupported: true },
    });
    assert.equal(codexModelSupportsEffort("gpt-5.5", "high"), true, "the shared display catalog is a union fallback");
  });

  it("releases connection-scoped rate-limit snapshots when the connection closes", async () => {
    await collectMessages(launch(new MockCodexClient({ accountType: "chatgpt", accountId: null })));
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    assert.equal(listCodexRateLimits().length, 0);
    await collectMessages(launch(new MockCodexClient({ accountType: "chatgpt", accountId: "acct-kept" })));
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    assert.equal(getCodexRateLimits("acct-kept")?.snapshot.primary?.usedPercent, 12);
  });

  it("refreshes model/list on every connection instead of trusting another server's catalog", async () => {
    const first = new MockCodexClient({ models: [codexCatalogModel("gpt-5.5", ["low"])] });
    await collectMessages(launch(first, { model: "gpt-5.5", reasoningEffort: "high" }));
    assert.equal("effort" in first.requestsFor("turn/start")[0], false);
    const second = new MockCodexClient({ models: [codexCatalogModel("gpt-5.5", ["low", "high"])] });
    await collectMessages(launch(second, { model: "gpt-5.5", reasoningEffort: "high" }));
    assert.equal(second.requestsFor("model/list").length, 1);
    assert.equal(second.requestsFor("turn/start")[0].effort, "high");
  });
});

describe("CodexHarness turns", () => {
  it("emits backend ref, streamed assistant output once, and a completed run", async () => {
    const client = new MockCodexClient({ assistantText: "Done." });
    const messages = await collectMessages(launch(client));
    const refs = messages.filter((message): message is Extract<HarnessMessage, { type: "backend_ref" }> => message.type === "backend_ref");
    assert.equal(refs[0]?.ref.kind, "codex-app-server");
    assert.equal(refs[0]?.ref.conversationId, VALID_THREAD_ID);
    assert.equal(refs.at(-1)?.ref.runId, "turn-1");
    assert.deepEqual(messages.filter((message) => message.type === "text_delta").map((message) => (message as { text: string }).text), ["Done."]);
    const result = runCompleted(messages);
    assert.equal(result?.data.success, true);
    assert.equal(result?.data.outcome, "completed");
    assert.equal(result?.data.duration_ms, 42);
    assert.equal(result?.data.session_id, VALID_THREAD_ID);
  });

  it("emits non-streamed agent message snapshots", async () => {
    const messages = await collectMessages(launch(new MockCodexClient({ agentMessageSnapshot: "Snapshot only." })));
    assert.ok(messages.some((message) => message.type === "text_delta" && message.text === "Snapshot only."));
  });

  it("uses turn.status from turn/completed for failed and interrupted outcomes (B4)", async () => {
    const failed = runCompleted(await collectMessages(launch(new MockCodexClient({ turnStatus: "failed", turnError: { message: "boom" } }))));
    assert.equal(failed?.data.outcome, "failed");
    assert.equal(failed?.data.result, "boom");
    const interrupted = runCompleted(await collectMessages(launch(new MockCodexClient({ turnStatus: "interrupted" }))));
    assert.equal(interrupted?.data.outcome, "interrupted");
    assert.equal(interrupted?.data.success, false);
  });

  it("does not report an already-expired reset time on usage-limit failures", async () => {
    const result = runCompleted(await collectMessages(launch(new MockCodexClient({
      accountType: "chatgpt",
      rateLimitsUsedPercent: 100,
      rateLimitsResetsAt: 1_000,
      turnStatus: "failed",
      turnError: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" },
    }))));
    assert.equal(result?.data.result, "You've hit your usage limit.");
  });

  it("appends the rate-limit reset time to usage-limit failures", async () => {
    const result = runCompleted(await collectMessages(launch(new MockCodexClient({
      accountType: "chatgpt",
      rateLimitsUsedPercent: 100,
      turnStatus: "failed",
      turnError: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" },
    }))));
    assert.match(result?.data.result ?? "", /usage limit[\s\S]*Codex usage limit resets in/);
  });

  it("fails an active turn when the app server exits", async () => {
    const client = new MockCodexClient({ holdTurns: true });
    const session = launch(client);
    const iter = session.messages[Symbol.asyncIterator]();
    await nextOfType(iter, "run_started");
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    client.closeHandler?.();
    const result = await nextOfType(iter, "run_completed");
    assert.equal(result.data.success, false);
    assert.match(result.data.result ?? "", /exited before the turn completed/);
  });

  it("emits finalized plan artifacts from Codex plan notifications", async () => {
    const messages = await collectMessages(launch(new MockCodexClient({ finalPlanMarkdown: "# Plan\n\n1. Update code" }), { permissionMode: "plan" }));
    const artifact = messages.find((message): message is Extract<HarnessMessage, { type: "plan_artifact" }> => message.type === "plan_artifact");
    assert.equal(artifact?.finalized, true);
    assert.equal(artifact?.artifact.markdown, "# Plan\n\n1. Update code");
    assert.equal(artifact?.artifact.explanation, "Implementation plan");
    assert.deepEqual(artifact?.artifact.steps, [{ step: "Update code", status: "pending" }]);
  });

  it("switches collaboration mode on the next turn after setPermissionMode", async () => {
    const client = new MockCodexClient();
    const prompts = pushableStream();
    prompts.push({ type: "user", text: "plan" });
    const session = launch(client, { prompt: prompts.stream, permissionMode: "plan" });
    const iter = session.messages[Symbol.asyncIterator]();
    await nextOfType(iter, "run_completed");
    await session.setPermissionMode?.("bypassPermissions");
    prompts.push({ type: "user", text: "implement" });
    await nextOfType(iter, "run_completed");
    prompts.end();
    const modes = client.requestsFor("turn/start").map((params) => (params.collaborationMode as { mode: string }).mode);
    assert.deepEqual(modes, ["plan", "default"]);
    assert.equal(client.requestsFor("thread/start").length, 1, "the thread is prepared once per connection");
    assert.equal(client.requestsFor("thread/resume").length, 0);
  });
});

describe("CodexHarness resume and fork", () => {
  it("resumes an existing thread with excludeTurns and the prepared cwd (A5)", async () => {
    const client = new MockCodexClient();
    const messages = await collectMessages(launch(client, { resumeSessionId: `  ${VALID_THREAD_ID}\n`, cwd: "/wt", systemPrompt: "rules" }));
    const resume = client.requestsFor("thread/resume")[0];
    assert.equal(resume.threadId, VALID_THREAD_ID);
    assert.equal(resume.excludeTurns, true);
    assert.equal(resume.cwd, "/wt");
    assert.equal(resume.developerInstructions, "rules");
    assert.equal("persistExtendedHistory" in resume, false);
    assert.equal(client.requestsFor("thread/start").length, 0);
    assert.equal((messages.find((message) => message.type === "backend_ref") as { ref: { conversationId: string } }).ref.conversationId, VALID_THREAD_ID);
  });

  it("starts a fresh thread instead of sending non-UUID resume ids", async () => {
    const client = new MockCodexClient();
    await collectMessages(launch(client, { resumeSessionId: "ses_plugin_owned_thread" }));
    assert.equal(isCodexAppServerSessionId("ses_plugin_owned_thread"), false);
    // Codex emits plain UUID thread ids; OCA resumes only ids it stored from Codex.
    assert.equal(isCodexAppServerSessionId(`urn:uuid:${VALID_THREAD_ID}`), false);
    assert.equal(isCodexAppServerSessionId(VALID_THREAD_ID), true);
    assert.equal(client.requestsFor("thread/resume").length, 0);
    assert.equal(client.requestsFor("thread/start").length, 1);
  });

  it("forks once to a new thread, then keeps using the fork", async () => {
    const client = new MockCodexClient({ threadId: FORKED_THREAD_ID });
    const prompts = pushableStream();
    prompts.push({ type: "user", text: "first" });
    const session = launch(client, { prompt: prompts.stream, resumeSessionId: VALID_THREAD_ID, forkSession: true, fastMode: true, cwd: "/fork" });
    const iter = session.messages[Symbol.asyncIterator]();
    await nextOfType(iter, "run_completed");
    prompts.push({ type: "user", text: "second" });
    const second = await nextOfType(iter, "run_completed");
    prompts.end();
    const fork = client.requestsFor("thread/fork");
    assert.equal(fork.length, 1);
    assert.equal(fork[0].threadId, VALID_THREAD_ID);
    assert.equal(fork[0].cwd, "/fork");
    assert.equal(fork[0].serviceTier, "priority");
    assert.equal("beforeTurnId" in fork[0], false);
    assert.equal(client.requestsFor("thread/resume").length, 0);
    assert.deepEqual(client.requestsFor("turn/start").map((params) => params.threadId), [FORKED_THREAD_ID, FORKED_THREAD_ID]);
    assert.equal(second.data.session_id, FORKED_THREAD_ID);
  });

  it("forks before the last N turns when rewinding (B11)", async () => {
    const client = new MockCodexClient({ threadId: FORKED_THREAD_ID, turnsList: ["turn-c", "turn-b", "turn-a"] });
    await collectMessages(launch(client, { resumeSessionId: VALID_THREAD_ID, forkSession: true, rewindTurns: 2 }));
    assert.deepEqual(client.requestsFor("thread/turns/list")[0], { threadId: VALID_THREAD_ID, limit: 3, sortDirection: "desc", itemsView: "notLoaded" });
    assert.equal(client.requestsFor("thread/fork")[0].beforeTurnId, "turn-b");
    assert.equal(client.requestsFor("thread/revert").length, 0);
  });

  it("pages past an in-progress turn to find enough completed turns to rewind", async () => {
    const client = new MockCodexClient({
      threadId: FORKED_THREAD_ID,
      turnsPages: [[{ id: "turn-live", status: "inProgress" }, { id: "turn-3" }], [{ id: "turn-2" }, { id: "turn-1" }]],
    });
    await collectMessages(launch(client, { resumeSessionId: VALID_THREAD_ID, forkSession: true, rewindTurns: 2 }));
    assert.equal(client.requestsFor("thread/turns/list").length, 2);
    assert.equal(client.requestsFor("thread/turns/list")[1].cursor, "1");
    assert.equal(client.requestsFor("thread/fork")[0].beforeTurnId, "turn-2");
  });

  it("reverts the resumed thread in place when rewinding without a fork (B11)", async () => {
    const client = new MockCodexClient({ turnsList: ["turn-z"] });
    await collectMessages(launch(client, { resumeSessionId: VALID_THREAD_ID, rewindTurns: 1 }));
    const methods = client.requests.map((request) => request.method);
    assert.ok(methods.indexOf("thread/resume") < methods.indexOf("thread/revert"));
    assert.deepEqual(client.requestsFor("thread/revert")[0], { threadId: VALID_THREAD_ID, beforeTurnId: "turn-z" });
  });

  it("fails clearly when asked to rewind more turns than the thread has", async () => {
    const client = new MockCodexClient({ turnsList: ["turn-z"] });
    const result = runCompleted(await collectMessages(launch(client, { resumeSessionId: VALID_THREAD_ID, rewindTurns: 3 })));
    assert.equal(result?.data.success, false);
    assert.match(result?.data.result ?? "", /Cannot rewind 3 turn\(s\): the Codex thread only has 1/);
  });

  it("reports resume failures before any turn starts and closes its client", async () => {
    const error = `codex app server rpc error (-32600): thread ${VALID_THREAD_ID} already has an active writer`;
    const client = new MockCodexClient({ failResume: error });
    const messages = await collectMessages(launch(client, { resumeSessionId: VALID_THREAD_ID }));
    assert.equal(messages.some((message) => message.type === "run_started"), false);
    const result = runCompleted(messages);
    assert.equal(result?.data.success, false);
    assert.equal(result?.data.num_turns, 0);
    assert.equal(result?.data.result, error);
    assert.equal(client.closeCalls, 1);
  });
});

describe("CodexHarness minimum Codex CLI version (B23)", () => {
  for (const [label, userAgent, reported] of [
    ["an older Codex CLI", codexUserAgent("0.155.9"), /Codex CLI 0\.155\.9 is too old/],
    ["an older pre-release", codexUserAgent("0.156.0-alpha.3"), /Codex CLI 0\.156\.0-alpha\.3 is too old/],
    ["a pre-release of the minimum", codexUserAgent(`${MIN_CODEX_CLI_VERSION}-rc.1`), /Codex CLI 0\.156\.1-rc\.1 is too old/],
    ["an agent string without a version", "codex_cli_rs (linux; x86_64)", /Could not read the Codex CLI version/],
  ] as const) {
    it(`fails closed on ${label} before any thread exists`, async () => {
      const client = new MockCodexClient({ userAgent });
      const messages = await collectMessages(launch(client));
      const result = runCompleted(messages);
      assert.equal(result?.data.success, false);
      assert.match(result?.data.result ?? "", reported);
      assert.match(result?.data.result ?? "", new RegExp(`needs Codex CLI ${MIN_CODEX_CLI_VERSION.replaceAll(".", "\\.")} or newer`));
      assert.match(result?.data.result ?? "", /npm install -g @openai\/codex@latest/);
      assert.deepEqual(client.requests.map((request) => request.method), ["initialize"]);
      assert.equal(messages.some((message) => message.type === "run_started"), false);
      assert.equal(client.closeCalls, 1);
    });
  }

  it("accepts the minimum and newer Codex CLIs", async () => {
    for (const version of [MIN_CODEX_CLI_VERSION, "0.156.2-alpha.1", "0.157.0", "1.0.0"]) {
      const client = new MockCodexClient({ userAgent: codexUserAgent(version) });
      const result = runCompleted(await collectMessages(launch(client)));
      assert.equal(result?.data.success, true, version);
      assert.ok(client.requestsFor("thread/start").length === 1, version);
    }
  });

  it("reads the version from Codex user agents", () => {
    assert.equal(MIN_CODEX_CLI_VERSION, "0.156.1");
    assert.equal(codexVersionFromUserAgent(codexUserAgent("0.157.0")), "0.157.0");
    assert.equal(codexVersionFromUserAgent("codex_cli_rs/0.156.1 (Mac OS 15.1.0; arm64) iTerm.app/3.5.0"), "0.156.1");
    assert.equal(codexVersionFromUserAgent("codex_cli_rs/0.157.0-alpha.2"), "0.157.0-alpha.2");
    assert.equal(codexVersionFromUserAgent("codex_cli_rs/dev (linux)"), undefined);
    assert.equal(codexVersionFromUserAgent(undefined), undefined);
    assert.equal(codexVersionError(codexUserAgent("0.156.1")), undefined);
    assert.equal(codexVersionError(codexUserAgent("0.156.2")), undefined);
    assert.match(codexVersionError(codexUserAgent("0.99.0")) ?? "", /0\.99\.0 is too old/);
  });
});

describe("CodexHarness cost accounting (B8)", () => {
  it("prices each thread/tokenUsage/updated response for API-key accounts", async () => {
    const client = new MockCodexClient({
      accountType: "apiKey",
      tokenUsage: [breakdown(1_000, 400, 200, 100, 90), breakdown(500, 0, 0, 50, 40)],
    });
    const messages = await collectMessages(launch(client, { model: "gpt-5.6-sol" }));
    const result = runCompleted(messages);
    assert.equal(result?.data.total_cost_usd, 0.00776);
    // The running total is reported as each response is priced, before the turn completes.
    const running = messages.flatMap((message) => message.type === "usage_updated" && message.usage.costUsd !== undefined ? [message.usage.costUsd] : []);
    assert.equal(running.length, 2);
    assert.ok(running[0]! > 0 && running[0]! < running[1]!);
    assert.equal(running[1], 0.00776);
    assert.ok(messages.findIndex((message) => message.type === "usage_updated") < messages.findIndex((message) => message.type === "run_completed"));
  });

  it("applies the fast multiplier only when Codex reports the priority tier", async () => {
    const standard = runCompleted(await collectMessages(launch(new MockCodexClient({
      accountType: "apiKey",
      serviceTier: null,
      tokenUsage: [breakdown(1_000, 0, 0, 100, 0)],
    }), { model: "gpt-5.6-sol", fastMode: true })));
    const priority = runCompleted(await collectMessages(launch(new MockCodexClient({
      accountType: "apiKey",
      serviceTier: "priority",
      tokenUsage: [breakdown(1_000, 0, 0, 100, 0)],
    }), { model: "gpt-5.6-sol", fastMode: true })));
    assert.equal(priority!.data.total_cost_usd, standard!.data.total_cost_usd * 2);
  });

  it("prices with the effective rerouted model and keeps ChatGPT sessions unpriced", async () => {
    const rerouted = runCompleted(await collectMessages(launch(new MockCodexClient({
      accountType: "apiKey",
      reroutedModel: "gpt-5.6-luna",
      tokenUsage: [breakdown(1_000, 0, 0, 100, 90)],
    }), { model: "gpt-5.6-sol" })));
    assert.equal(rerouted?.data.total_cost_usd, 0.00032);
    const oauth = runCompleted(await collectMessages(launch(new MockCodexClient({
      accountType: "chatgpt",
      tokenUsage: [breakdown(100_000, 0, 0, 10_000, 9_000)],
    }), { model: "gpt-5.6-sol" })));
    assert.equal(oauth?.data.total_cost_usd, 0);
  });
});

describe("CodexHarness server requests (A6, B5)", () => {
  it("declines MCP elicitations, dynamic tool calls, and answers the time request", async () => {
    const client = new MockCodexClient({ holdTurns: true });
    const session = launch(client);
    const iter = session.messages[Symbol.asyncIterator]();
    await nextOfType(iter, "run_started");
    assert.deepEqual(await client.requestHandler("mcpServer/elicitation/request", { threadId: VALID_THREAD_ID, turnId: null, serverName: "x", mode: "form" }, 1), {
      action: "decline",
      content: null,
      _meta: null,
    });
    const tool = await client.requestHandler("item/tool/call", { threadId: VALID_THREAD_ID, turnId: "t", callId: "c", namespace: null, tool: "x", arguments: {} }, 2) as { success: boolean; contentItems: Array<{ type: string }> };
    assert.equal(tool.success, false);
    assert.equal(tool.contentItems[0]?.type, "inputText");
    const time = await client.requestHandler("currentTime/read", { threadId: VALID_THREAD_ID }, 3) as { currentTimeAt: number };
    assert.ok(Math.abs(time.currentTimeAt - Date.now() / 1000) < 5);
    for (const method of ["account/chatgptAuthTokens/refresh", "attestation/generate", "execCommandApproval", "something/new"]) {
      await assert.rejects(client.requestHandler(method, {}, 4), (error: unknown) => error instanceof JsonRpcResponseError && error.code === -32601, method);
    }
    await client.completeTurn();
    await nextOfType(iter, "run_completed");
  });

  it("routes command approvals to pending input and answers with the typed decision", async () => {
    const client = new MockCodexClient({
      serverRequest: {
        method: "item/commandExecution/requestApproval",
        id: 5,
        params: {
          kind: "command",
          itemId: "i",
          startedAtMs: 0,
          environmentId: null,
          command: "npm publish",
          availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "publish"] } }, "decline"],
        },
      },
    });
    const session = launch(client);
    const iter = session.messages[Symbol.asyncIterator]();
    const pending = await nextOfType(iter, "pending_input");
    assert.equal(pending.state.kind, "approval");
    assert.equal(pending.state.requestId, "5");
    assert.deepEqual(pending.state.options, ["Approve once", "Always allow `npm publish`", "Decline"]);
    assert.equal(await session.submitPendingInputOption?.(1, { requestId: "5" }), true);
    const resolved = await nextOfType(iter, "pending_input_resolved");
    assert.equal(resolved.requestId, "5");
    await nextOfType(iter, "run_completed");
    assert.deepEqual(client.serverResponses, [{ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "publish"] } } }]);
  });

  it("maps free-text approval replies and declines unrecognized text as feedback", async () => {
    const approved = new MockCodexClient({
      serverRequest: { method: "item/fileChange/requestApproval", params: { itemId: "i", startedAtMs: 0 } },
    });
    const session = launch(approved);
    const iter = session.messages[Symbol.asyncIterator]();
    await nextOfType(iter, "pending_input");
    assert.equal(await session.submitPendingInputText?.("approve for session"), true);
    await nextOfType(iter, "run_completed");
    assert.deepEqual(approved.serverResponses, [{ decision: "acceptForSession" }]);

    const feedback = new MockCodexClient({
      holdTurns: true,
      serverRequest: { method: "item/fileChange/requestApproval", params: { itemId: "i", startedAtMs: 0 } },
    });
    const second = launch(feedback);
    const iter2 = second.messages[Symbol.asyncIterator]();
    await nextOfType(iter2, "pending_input");
    assert.equal(await second.submitPendingInputText?.("write it under /tmp instead"), true);
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    assert.deepEqual(feedback.serverResponses, [{ decision: "decline" }]);
    const steer = feedback.requestsFor("turn/steer")[0] as { input: Array<{ text: string }>; expectedTurnId: string };
    assert.equal(steer.input[0]?.text, "write it under /tmp instead");
    assert.equal(steer.expectedTurnId, "turn-1");
    await feedback.completeTurn();
    await nextOfType(iter2, "run_completed");
  });

  it("answers permission requests with the requested profile", async () => {
    const client = new MockCodexClient({
      serverRequest: {
        method: "item/permissions/requestApproval",
        params: { itemId: "i", environmentId: null, startedAtMs: 0, cwd: "/repo", reason: null, permissions: { network: { enabled: true }, fileSystem: null } },
      },
    });
    const session = launch(client);
    const iter = session.messages[Symbol.asyncIterator]();
    await nextOfType(iter, "pending_input");
    assert.equal(await session.submitPendingInputOption?.(2), true);
    await nextOfType(iter, "run_completed");
    assert.deepEqual(client.serverResponses, [{ permissions: {}, scope: "turn" }]);
  });

  it("walks multi-question request_user_input wizards and submits all answers at once", async () => {
    const client = new MockCodexClient({
      serverRequest: {
        method: "item/tool/requestUserInput",
        id: 9,
        params: {
          itemId: "i",
          isBlocking: true,
          autoResolutionMs: null,
          questions: [
            { id: "environment", header: "Environment", question: "Which environment?", isOther: false, isSecret: false, options: [{ label: "Staging", description: "" }, { label: "Production", description: "" }] },
            { id: "scope", header: "Scope", question: "How broad?", isOther: true, isSecret: false, options: [{ label: "Canary", description: "" }] },
          ],
        },
      },
    });
    const session = launch(client);
    const iter = session.messages[Symbol.asyncIterator]();
    const first = await nextOfType(iter, "pending_input");
    assert.deepEqual(first.state.options, ["Staging", "Production"]);
    assert.equal(await session.submitPendingInputOption?.(1, { requestId: "9", questionId: "scope" }), false, "stale question tokens are rejected");
    assert.equal(await session.submitPendingInputOption?.(1, { requestId: "9", questionId: "environment" }), true);
    const second = await nextOfType(iter, "pending_input");
    assert.equal(second.state.activeQuestionIndex, 1);
    assert.deepEqual(second.state.answers, { environment: { answers: ["Production"] } });
    assert.equal(await session.submitPendingInputText?.("Canary, then everyone"), true);
    await nextOfType(iter, "run_completed");
    assert.deepEqual(client.serverResponses, [{
      answers: {
        environment: { answers: ["Production"] },
        scope: { answers: ["Canary, then everyone"] },
      },
    }]);
  });

  it("rejects malformed request_user_input payloads without showing pending input", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const client = new MockCodexClient({
        serverRequest: { method: "item/tool/requestUserInput", id: 3, params: { itemId: "i", isBlocking: true, autoResolutionMs: null, questions: [] } },
      });
      const messages = await collectMessages(launch(client));
      assert.equal(messages.some((message) => message.type === "pending_input"), false);
      assert.match(warnings.join("\n"), /Malformed Codex request_user_input payload for 3/);
      assert.equal(typeof (client.serverResponses[0] as { rpcError?: unknown }).rpcError, "string");
    } finally {
      console.warn = originalWarn;
    }
  });

  it("clears a pending request when Codex resolves it on its own", async () => {
    const client = new MockCodexClient({ holdTurns: true });
    const session = launch(client);
    const iter = session.messages[Symbol.asyncIterator]();
    await nextOfType(iter, "run_started");
    const answer = client.requestHandler("item/fileChange/requestApproval", { threadId: VALID_THREAD_ID, turnId: "turn-1", itemId: "i", startedAtMs: 0 }, 11);
    await nextOfType(iter, "pending_input");
    await client.notificationHandler("serverRequest/resolved", { threadId: VALID_THREAD_ID, requestId: 11 });
    assert.deepEqual(await answer, { decision: "decline" });
    const resolved = await nextOfType(iter, "pending_input_resolved");
    assert.equal(resolved.requestId, "11");
    assert.equal(await session.submitPendingInputOption?.(0), false);
    await client.completeTurn();
    await nextOfType(iter, "run_completed");
  });
});

describe("CodexHarness steering, interrupts, and thread actions", () => {
  it("refuses a queued review after the session closed instead of writing to a closed transport", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const client = new MockCodexClient({ holdTurns: true });
      const harness = new CodexHarness({ createClient: () => client });
      const prompts = pushableStream();
      prompts.push({ type: "user", text: "work" });
      const session = harness.launch({ prompt: prompts.stream, cwd: "/tmp" });
      const iter = session.messages[Symbol.asyncIterator]();
      await nextOfType(iter, "run_started");
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      // The session goes terminal and closes while a review is queued behind the turn.
      await session.close?.();
      prompts.push(harness.buildThreadActionMessage({ kind: "review", target: { type: "uncommittedChanges" } }));
      await client.completeTurn();
      for (let i = 0; i < 40; i += 1) {
        const next = await iter.next();
        if (next.done) break;
      }
      assert.equal(client.requestsFor("review/start").length, 0);
      assert.equal(await session.steer?.("late"), false);
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("starts the next turn for a follow-up queued during a running turn instead of dropping it", async () => {
    const client = new MockCodexClient({ holdTurns: true, assistantText: "done" });
    const prompts = pushableStream();
    prompts.push({ type: "user", text: "first" });
    const session = launch(client, { prompt: prompts.stream });
    const iter = session.messages[Symbol.asyncIterator]();
    await nextOfType(iter, "run_started");
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    // Queued while the first turn runs (steer unavailable here).
    prompts.push({ type: "user", text: "second" });
    await client.completeTurn();
    // The first turn's result is carried by the queued turn, so the session never
    // sees an idle turn end while the follow-up is still pending.
    const seen: HarnessMessage[] = [];
    await nextOfType(iter, "run_started", seen);
    assert.equal(seen.some((message) => message.type === "run_completed"), false);
    for (let i = 0; i < 20 && client.requestsFor("turn/start").length < 2; i += 1) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
    }
    assert.equal(client.requestsFor("turn/start").length, 2);
    await client.completeTurn();
    const completed = await nextOfType(iter, "run_completed");
    assert.equal(completed.data.success, true);
    prompts.end();
  });

  it("separates consecutive agent messages in the output", async () => {
    const client = new MockCodexClient({ assistantText: "first message", agentMessageSnapshot: "second message" });
    const messages = await collectMessages(launch(client));
    const text = messages
      .filter((message): message is Extract<HarnessMessage, { type: "text_delta" }> => message.type === "text_delta")
      .map((message) => message.text)
      .join("");
    assert.equal(text, "first message\n\nsecond message");
  });

  it("steers the running turn with expectedTurnId (B10)", async () => {
    const client = new MockCodexClient({ holdTurns: true });
    const session = launch(client);
    const iter = session.messages[Symbol.asyncIterator]();
    await nextOfType(iter, "run_started");
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    assert.equal(await session.steer?.("also update the docs"), true);
    assert.deepEqual(client.requestsFor("turn/steer")[0], {
      threadId: VALID_THREAD_ID,
      input: [{ type: "text", text: "also update the docs", text_elements: [] }],
      expectedTurnId: "turn-1",
    });
    await client.completeTurn();
    await nextOfType(iter, "run_completed");
    assert.equal(await session.steer?.("too late"), false, "no active turn after completion");
  });

  it("does not steer into a turn that is being interrupted, and interrupts with the active turn id", async () => {
    await withEnv(CODEX_TIMEOUT_ENV, "34567", async () => {
      const client = new MockCodexClient({ holdTurns: true });
      const session = launch(client);
      const iter = session.messages[Symbol.asyncIterator]();
      await nextOfType(iter, "run_started");
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      await session.interrupt?.();
      const interrupt = client.requests.find((request) => request.method === "turn/interrupt");
      assert.deepEqual(interrupt?.params, { threadId: VALID_THREAD_ID, turnId: "turn-1" });
      assert.equal(interrupt?.timeoutMs, 34567);
      assert.equal(await session.steer?.("redirect"), false);
      assert.equal(client.requestsFor("turn/steer").length, 0);
      await client.completeTurn("turn-1", "interrupted");
      assert.equal((await nextOfType(iter, "run_completed")).data.outcome, "interrupted");
    });
  });

  it("falls back to queueing when Codex rejects the steer", async () => {
    const client = new MockCodexClient({ holdTurns: true, steerError: "codex app server rpc error (-32600): expected active turn id" });
    const session = launch(client);
    const iter = session.messages[Symbol.asyncIterator]();
    await nextOfType(iter, "run_started");
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    assert.equal(await session.steer?.("more"), false);
    await client.completeTurn();
    await nextOfType(iter, "run_completed");
  });

  it("runs compaction and inline review as serialized thread-action turns (B12, B13)", async () => {
    const client = new MockCodexClient();
    const harness = new CodexHarness({ createClient: () => client });
    const prompts = pushableStream();
    prompts.push({ type: "user", text: "work" });
    prompts.push(harness.buildThreadActionMessage({ kind: "compact" }));
    prompts.push(harness.buildThreadActionMessage({ kind: "review", target: { type: "baseBranch", branch: "main" } }));
    const session = harness.launch({ prompt: prompts.stream, cwd: "/tmp" });
    const iter = session.messages[Symbol.asyncIterator]();
    // Queued actions carry the turn result forward: one run_completed after the last.
    const seen: HarnessMessage[] = [];
    const completed = await nextOfType(iter, "run_completed", seen);
    assert.equal(completed.data.success, true);
    assert.equal(seen.filter((message) => message.type === "run_started").length, 3);
    assert.ok(seen.some((message) => message.type === "text_delta" && /compacted/.test(message.text)));
    assert.ok(seen.some((message) => message.type === "text_delta" && message.text === "No findings."));
    prompts.end();
    assert.deepEqual(client.requestsFor("thread/compact/start")[0], { threadId: VALID_THREAD_ID });
    assert.deepEqual(client.requestsFor("review/start")[0], { threadId: VALID_THREAD_ID, target: { type: "baseBranch", branch: "main" }, delivery: "inline" });
    assert.equal(client.requestsFor("thread/start").length, 1);
  });

  it("never uses removed fallback methods (B3)", async () => {
    const client = new MockCodexClient();
    await collectMessages(launch(client));
    const methods = new Set(client.requests.map((request) => request.method));
    for (const removed of ["thread/new", "turn/failed", "turn/cancelled", "thread/rollback"]) {
      assert.equal(methods.has(removed), false, removed);
    }
  });
});
