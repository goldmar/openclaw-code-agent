/**
 * Typed Codex App Server wire fixtures for the fake app servers in
 * tests/harness-backends.ts and tests/codex-harness.test.ts.
 *
 * Every builder returns a value typed as the vendored generated protocol type
 * (src/harness/codex-app-server-protocol, `pnpm sync:codex-protocol`), so a
 * protocol refresh that changes a shape breaks `pnpm typecheck`. The frames are
 * also validated at run time against the vendored JSON Schema
 * (tests/protocol-schema.ts).
 */
import type {
  CommandExecutionRequestApprovalResponse,
  GetAccountResponse,
  InitializeResponse,
  ModelListResponse,
  ServerRequest,
  ThreadResumeResponse,
  ThreadStartResponse,
  ToolRequestUserInputResponse,
  TurnStartResponse,
} from "../src/harness/codex-app-server-protocol";
import type { Thread } from "../src/harness/codex-app-server-protocol/v2/Thread";
import type { ThreadItem } from "../src/harness/codex-app-server-protocol/v2/ThreadItem";
import type { Turn } from "../src/harness/codex-app-server-protocol/v2/Turn";
import type { TurnError } from "../src/harness/codex-app-server-protocol/v2/TurnError";
import type { TurnStatus } from "../src/harness/codex-app-server-protocol/v2/TurnStatus";
import type { AskForApproval } from "../src/harness/codex-app-server-protocol/v2/AskForApproval";
import type { SandboxPolicy } from "../src/harness/codex-app-server-protocol/v2/SandboxPolicy";
import {
  checkProtocol,
  codexClientRequestErrors,
  codexClientResultErrors,
  codexNotificationErrors,
  codexServerRequestErrors,
  codexServerResultErrors,
} from "./protocol-schema";

export type {
  CommandExecutionRequestApprovalResponse,
  GetAccountResponse,
  InitializeResponse,
  ModelListResponse,
  ThreadItem,
  ToolRequestUserInputResponse,
  Turn,
  TurnStartResponse,
};

/** Params of a Codex server-initiated request, by method. */
export type CodexServerRequestParams<M extends ServerRequest["method"]> = Extract<ServerRequest, { method: M }>["params"];

export const CODEX_FIXTURE_CWD = "/tmp";

export function codexInitializeResponse(userAgent = "fake"): InitializeResponse {
  return { userAgent, codexHome: CODEX_FIXTURE_CWD, platformFamily: "unix", platformOs: "linux" };
}

export function codexThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    environments: null,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "legacy",
    modelProvider: "openai",
    model: null,
    reasoningEffort: null,
    createdAt: 0,
    updatedAt: 0,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: CODEX_FIXTURE_CWD,
    cliVersion: "0.156.1",
    originator: null,
    source: "appServer",
    canAcceptDirectInput: null,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    daybreakEnabled: null,
    turns: [],
    ...overrides,
  };
}

export type CodexThreadResponseOptions = {
  model?: string;
  serviceTier?: string | null;
  cwd?: string;
  approvalPolicy?: AskForApproval;
  sandbox?: SandboxPolicy;
};

export function codexThreadStartResponse(threadId: string, options: CodexThreadResponseOptions = {}): ThreadStartResponse {
  return {
    thread: codexThread(threadId),
    model: options.model ?? "gpt-6-sol",
    modelProvider: "openai",
    serviceTier: options.serviceTier ?? null,
    disabledPluginIds: [],
    cwd: options.cwd ?? CODEX_FIXTURE_CWD,
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: options.approvalPolicy ?? "never",
    approvalsReviewer: "user",
    sandbox: options.sandbox ?? { type: "dangerFullAccess" },
    activePermissionProfile: null,
    reasoningEffort: null,
    multiAgentMode: "explicitRequestOnly",
  };
}

export function codexThreadResumeResponse(threadId: string, options: CodexThreadResponseOptions = {}): ThreadResumeResponse {
  return {
    ...codexThreadStartResponse(threadId, options),
    collaborationMode: null,
    initialTurnsPage: null,
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
  };
}

export function codexTurn(id: string, status: TurnStatus, error: TurnError | null = null): Turn {
  return { id, items: [], itemsView: "notLoaded", status, error, startedAt: null, completedAt: null, durationMs: 1 };
}

export function codexAgentMessage(id: string, text: string): Extract<ThreadItem, { type: "agentMessage" }> {
  return { type: "agentMessage", id, text, phase: null, memoryCitation: null, delivery: null, questions: null };
}

export function codexPlanItem(id: string, text: string): Extract<ThreadItem, { type: "plan" }> {
  return { type: "plan", id, text };
}

/**
 * Run-time checks for one fake app server. Each check records the violation
 * and throws, so a shape mismatch fails the test even when the harness would
 * swallow the error.
 */
export class CodexProtocolChecker {
  readonly violations: string[] = [];

  clientRequest(method: string, params: unknown): void {
    checkProtocol(this.violations, `Codex client request ${method} params`, codexClientRequestErrors(method, params));
  }

  clientResult<T>(method: string, result: T): T {
    checkProtocol(this.violations, `Codex ${method} result`, codexClientResultErrors(method, result));
    return result;
  }

  notification(method: string, params: unknown): void {
    checkProtocol(this.violations, `Codex notification ${method}`, codexNotificationErrors(method, params));
  }

  serverRequest(method: string, params: unknown): void {
    checkProtocol(this.violations, `Codex server request ${method} params`, codexServerRequestErrors(method, params));
  }

  serverResult(method: string, result: unknown): void {
    checkProtocol(this.violations, `OCA's result for Codex server request ${method}`, codexServerResultErrors(method, result));
  }
}
