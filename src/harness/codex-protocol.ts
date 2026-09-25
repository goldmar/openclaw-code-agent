/**
 * Typed Codex App Server protocol helpers.
 *
 * All wire shapes come from the vendored `codex app-server generate-ts`
 * output in `./codex-app-server-protocol` (regenerate with
 * `pnpm sync:codex-protocol`). This module owns request builders, the method
 * → response map used by `codexRequest`, and server-request translation into
 * OCA's pending-input model. It intentionally does no field probing: a shape
 * that does not match the generated types is a protocol bug, not something to
 * guess around.
 */

import {
  CODEX_APPROVAL_POLICIES,
  CODEX_APPROVALS_REVIEWERS,
  CODEX_PERMISSION_PROFILES,
  type CodexApprovalPolicy,
  type CodexApprovalsReviewer,
  type CodexPermissionProfile,
} from "../types";
import type {
  PendingInputAction,
  PendingInputDecision,
  PendingInputQuestion,
  PendingInputState,
  PlanArtifactStep,
} from "../types";
import { formatPendingInputWizardQuestion, matchApprovalChoiceText } from "../pending-input-normalization";
import type { JsonRpcClient } from "./codex-rpc";
import type {
  GetAccountParams,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  InitializeParams,
  InitializeResponse,
  ModelListParams,
  ModelListResponse,
  ReviewStartParams,
  ReviewStartResponse,
  ThreadCompactStartParams,
  ThreadCompactStartResponse,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadRevertParams,
  ThreadRevertResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTurnsListParams,
  ThreadTurnsListResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
  CollaborationMode,
} from "./codex-app-server-protocol";
import type { ApprovalsReviewer } from "./codex-app-server-protocol/v2/ApprovalsReviewer";
import type { AskForApproval } from "./codex-app-server-protocol/v2/AskForApproval";
import type { CommandExecutionApprovalDecision } from "./codex-app-server-protocol/v2/CommandExecutionApprovalDecision";
import type { CommandExecutionRequestApprovalParams } from "./codex-app-server-protocol/v2/CommandExecutionRequestApprovalParams";
import type { FileChangeRequestApprovalParams } from "./codex-app-server-protocol/v2/FileChangeRequestApprovalParams";
import type { PermissionsRequestApprovalParams } from "./codex-app-server-protocol/v2/PermissionsRequestApprovalParams";
import type { PermissionsRequestApprovalResponse } from "./codex-app-server-protocol/v2/PermissionsRequestApprovalResponse";
import type { ReviewTarget } from "./codex-app-server-protocol/v2/ReviewTarget";
import type { ToolRequestUserInputParams } from "./codex-app-server-protocol/v2/ToolRequestUserInputParams";
import type { Turn } from "./codex-app-server-protocol/v2/Turn";
import type { FileSystemPath } from "./codex-app-server-protocol/v2/FileSystemPath";
import type { TurnPlanStep } from "./codex-app-server-protocol/v2/TurnPlanStep";
import type { UserInput } from "./codex-app-server-protocol/v2/UserInput";

// ---------------------------------------------------------------------------
// Typed client requests
// ---------------------------------------------------------------------------

/** Client → server methods OCA uses, mapped to their generated params/response types. */
export interface CodexClientMethods {
  initialize: { params: InitializeParams; response: InitializeResponse };
  "account/read": { params: GetAccountParams; response: GetAccountResponse };
  "account/rateLimits/read": { params: undefined; response: GetAccountRateLimitsResponse };
  "model/list": { params: ModelListParams; response: ModelListResponse };
  "thread/start": { params: ThreadStartParams; response: ThreadStartResponse };
  "thread/resume": { params: ThreadResumeParams; response: ThreadResumeResponse };
  "thread/fork": { params: ThreadForkParams; response: ThreadForkResponse };
  "thread/revert": { params: ThreadRevertParams; response: ThreadRevertResponse };
  "thread/turns/list": { params: ThreadTurnsListParams; response: ThreadTurnsListResponse };
  "thread/compact/start": { params: ThreadCompactStartParams; response: ThreadCompactStartResponse };
  "turn/start": { params: TurnStartParams; response: TurnStartResponse };
  "turn/steer": { params: TurnSteerParams; response: TurnSteerResponse };
  "turn/interrupt": { params: TurnInterruptParams; response: TurnInterruptResponse };
  "review/start": { params: ReviewStartParams; response: ReviewStartResponse };
}

export type CodexClientMethod = keyof CodexClientMethods;

export async function codexRequest<M extends CodexClientMethod>(
  client: JsonRpcClient,
  method: M,
  params: CodexClientMethods[M]["params"],
  timeoutMs: number,
): Promise<CodexClientMethods[M]["response"]> {
  return await client.request(method, params, timeoutMs) as CodexClientMethods[M]["response"];
}

// ---------------------------------------------------------------------------
// Minimum Codex CLI version
// ---------------------------------------------------------------------------

/**
 * Oldest Codex CLI the harness supports. 5.0 relies on `turn/steer`,
 * `thread/fork` `beforeTurnId`, `thread/revert`, `model/list`, the account
 * rate-limit methods, and thread permission profiles; 0.156.1 is the release
 * the vendored protocol was generated from and live-tested with.
 */
export const MIN_CODEX_CLI_VERSION = "0.156.1";

/**
 * The Codex CLI version from the `initialize` response's `userAgent`, which
 * Codex formats as `<originator>/<version> (<os>; <arch>) ...`. Returns
 * undefined when the agent string carries no version.
 */
export function codexVersionFromUserAgent(userAgent: unknown): string | undefined {
  if (typeof userAgent !== "string") return undefined;
  const match = /^[^/\s]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:[\s(]|$)/u.exec(userAgent.trim());
  return match?.[1];
}

/** Negative, zero, or positive as `a` is older than, equal to, or newer than `b` (numeric core only). */
function compareVersionCores(a: string, b: string): number {
  const parts = (version: string): number[] => version.split("-")[0]!.split(".").map(Number);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Why this Codex App Server cannot be used, or undefined when its version is
 * at least {@link MIN_CODEX_CLI_VERSION}. Fails closed: an agent string
 * without a readable version is refused too.
 */
export function codexVersionError(userAgent: unknown): string | undefined {
  const version = codexVersionFromUserAgent(userAgent);
  const upgrade = `OpenClaw Code Agent needs Codex CLI ${MIN_CODEX_CLI_VERSION} or newer. `
    + "Update the `codex` command (for example `npm install -g @openai/codex@latest`), "
    + "or point OPENCLAW_CODEX_APP_SERVER_COMMAND at a newer Codex.";
  if (!version) return `Could not read the Codex CLI version from the App Server. ${upgrade}`;
  if (compareVersionCores(version, MIN_CODEX_CLI_VERSION) < 0) return `Codex CLI ${version} is too old. ${upgrade}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Execution settings (B5)
// ---------------------------------------------------------------------------

// Compile-time guards: OCA's exposed values must stay valid wire values. The
// constraint is checked even though nothing references the alias.
type AssertAssignable<T extends U, U> = T;
type CodexExecutionWireGuards = [
  AssertAssignable<CodexApprovalPolicy, AskForApproval>,
  AssertAssignable<CodexApprovalsReviewer, ApprovalsReviewer>,
];

/** Thread-level Codex execution settings, identical for every OCA permission mode. */
export interface CodexExecutionSettings {
  permissionProfile: CodexPermissionProfile;
  approvalPolicy: CodexApprovalPolicy;
  approvalsReviewer: CodexApprovalsReviewer;
}

/**
 * Default Codex execution when `harnesses.codex` sets none of the execution
 * keys and the host has no `tools.exec.mode` (or `full`): the trusted local
 * operator posture of OpenClaw's bundled Codex plugin (full access, no
 * Codex-side prompts). OCA's own plan review still gates implementation.
 */
export const DEFAULT_CODEX_EXECUTION_SETTINGS: CodexExecutionSettings = {
  permissionProfile: ":danger-full-access",
  approvalPolicy: "never",
  approvalsReviewer: "user",
};

/** OpenClaw's normalized host exec policy (`tools.exec.mode`). */
export type OpenClawExecMode = "deny" | "allowlist" | "ask" | "auto" | "full";

function normalizeExecMode(value: unknown): OpenClawExecMode | undefined {
  return value === "deny" || value === "allowlist" || value === "ask" || value === "auto" || value === "full"
    ? value
    : undefined;
}

/** Read `tools.exec.mode` from an OpenClaw config snapshot. */
export function readOpenClawExecMode(config: unknown): OpenClawExecMode | undefined {
  if (!config || typeof config !== "object") return undefined;
  const tools = (config as { tools?: unknown }).tools;
  if (!tools || typeof tools !== "object") return undefined;
  const exec = (tools as { exec?: unknown }).exec;
  if (!exec || typeof exec !== "object") return undefined;
  return normalizeExecMode((exec as { mode?: unknown }).mode);
}

/**
 * The Codex posture the host exec mode implies, mirroring the bundled Codex
 * plugin: `auto` → guardian (`:workspace`, `on-request`, `auto_review`),
 * `ask` → the same sandbox with approvals routed to the user, `full` or unset
 * → full access with no prompts. `deny` / `allowlist` block Codex local
 * execution, so they have no posture.
 */
function postureForExecMode(mode: OpenClawExecMode | undefined): CodexExecutionSettings | undefined {
  switch (mode) {
    case "auto":
      return { permissionProfile: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "auto_review" };
    case "ask":
      return { permissionProfile: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "user" };
    case "deny":
    case "allowlist":
      return undefined;
    default:
      return DEFAULT_CODEX_EXECUTION_SETTINGS;
  }
}

class CodexExecModeBlockedError extends Error {
  constructor(mode: OpenClawExecMode) {
    super(
      `Codex sessions are unavailable because the host's tools.exec.mode is "${mode}", which blocks Codex local execution `
      + `(as in OpenClaw's bundled Codex plugin). Set harnesses.codex.permissionProfile (and optionally approvalPolicy / approvalsReviewer) `
      + `in the openclaw-code-agent config to run Codex with an explicit posture, or change tools.exec.mode.`,
    );
    this.name = "CodexExecModeBlockedError";
  }
}

/**
 * Resolve the Codex execution settings for a new session. Explicit
 * `harnesses.codex.*` values always win (unlike the bundled Codex plugin, whose
 * `tools.exec.mode: "auto"` overrides configured values); unset fields follow
 * the host `tools.exec.mode` posture.
 */
export function resolveCodexExecutionSettings(
  config: {
    permissionProfile?: string;
    approvalPolicy?: string;
    approvalsReviewer?: string;
  } | undefined,
  execMode?: OpenClawExecMode,
): CodexExecutionSettings {
  const explicit = <T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined =>
    allowed.includes(value as T) ? value as T : undefined;
  const permissionProfile = explicit(config?.permissionProfile, CODEX_PERMISSION_PROFILES);
  const approvalPolicy = explicit(config?.approvalPolicy, CODEX_APPROVAL_POLICIES);
  const approvalsReviewer = explicit(config?.approvalsReviewer, CODEX_APPROVALS_REVIEWERS);
  let posture = postureForExecMode(execMode);
  if (!posture) {
    // deny / allowlist: only an explicit sandbox choice may run Codex; the rest
    // of the posture then asks the user before any escalation.
    if (!permissionProfile) throw new CodexExecModeBlockedError(execMode!);
    posture = { permissionProfile, approvalPolicy: "on-request", approvalsReviewer: "user" };
  }
  return {
    permissionProfile: permissionProfile ?? posture.permissionProfile,
    approvalPolicy: approvalPolicy ?? posture.approvalPolicy,
    approvalsReviewer: approvalsReviewer ?? posture.approvalsReviewer,
  };
}

function executionFields(execution: CodexExecutionSettings): Pick<ThreadStartParams, "permissions" | "approvalPolicy" | "approvalsReviewer"> {
  // `permissions` selects a named profile; it cannot be combined with `sandbox`.
  return {
    permissions: execution.permissionProfile,
    approvalPolicy: execution.approvalPolicy,
    approvalsReviewer: execution.approvalsReviewer,
  };
}

// ---------------------------------------------------------------------------
// Thread / turn builders
// ---------------------------------------------------------------------------

/** Codex's model catalog exposes fast mode as the `priority` service tier. */
const CODEX_FAST_SERVICE_TIER = "priority";

type CommonThreadOptions = {
  model?: string;
  fastMode?: boolean;
  developerInstructions?: string;
  execution: CodexExecutionSettings;
};

function commonThreadFields(options: CommonThreadOptions): Pick<ThreadStartParams, "model" | "serviceTier" | "developerInstructions" | "permissions" | "approvalPolicy" | "approvalsReviewer"> {
  const model = options.model?.trim();
  const developerInstructions = options.developerInstructions?.trim();
  return {
    ...(model ? { model } : {}),
    ...(options.fastMode === true ? { serviceTier: CODEX_FAST_SERVICE_TIER } : {}),
    // Thread-level developer instructions carry OCA's system prompt (including
    // the worktree preamble). The collaboration mode keeps
    // `developer_instructions: null` so Codex's built-in plan/default mode
    // instructions still apply alongside them.
    ...(developerInstructions ? { developerInstructions } : {}),
    ...executionFields(options.execution),
  };
}

export function buildThreadStartParams(options: CommonThreadOptions & { cwd: string }): ThreadStartParams {
  return { cwd: options.cwd, ...commonThreadFields(options) };
}

export function buildThreadResumeParams(options: CommonThreadOptions & { threadId: string; cwd?: string }): ThreadResumeParams {
  const cwd = options.cwd?.trim();
  return {
    threadId: options.threadId,
    ...(cwd ? { cwd } : {}),
    ...commonThreadFields(options),
    // OCA never renders prior turns, so skip full-history hydration.
    excludeTurns: true,
  };
}

export function buildThreadForkParams(options: CommonThreadOptions & {
  threadId: string;
  cwd?: string;
  beforeTurnId?: string;
}): ThreadForkParams {
  const cwd = options.cwd?.trim();
  return {
    threadId: options.threadId,
    ...(options.beforeTurnId ? { beforeTurnId: options.beforeTurnId } : {}),
    ...(cwd ? { cwd } : {}),
    ...commonThreadFields(options),
    excludeTurns: true,
  };
}

function buildTurnInput(prompt: string): UserInput[] {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function collaborationModeKindForPermissionMode(permissionMode: string | undefined): CollaborationMode["mode"] {
  return permissionMode === "plan" ? "plan" : "default";
}

/**
 * Codex collaboration `Settings` is snake_case (`reasoning_effort`,
 * `developer_instructions`) and `model` is required. `developer_instructions:
 * null` selects the built-in instructions for the chosen mode.
 */
export function buildCollaborationMode(
  mode: CollaborationMode["mode"],
  model: string,
  reasoningEffort?: string,
): CollaborationMode {
  return {
    mode,
    settings: {
      model,
      reasoning_effort: reasoningEffort?.trim() || null,
      developer_instructions: null,
    },
  };
}

export function buildTurnStartParams(options: {
  threadId: string;
  prompt: string;
  model: string;
  reasoningEffort?: string;
  permissionMode?: string;
}): TurnStartParams {
  const effort = options.reasoningEffort?.trim();
  return {
    threadId: options.threadId,
    input: buildTurnInput(options.prompt),
    model: options.model,
    ...(effort ? { effort } : {}),
    // Takes precedence over model/effort, so it must repeat both.
    collaborationMode: buildCollaborationMode(
      collaborationModeKindForPermissionMode(options.permissionMode),
      options.model,
      effort,
    ),
  };
}

export function buildTurnSteerParams(options: { threadId: string; expectedTurnId: string; text: string }): TurnSteerParams {
  return {
    threadId: options.threadId,
    input: buildTurnInput(options.text),
    expectedTurnId: options.expectedTurnId,
  };
}

/** OCA review targets for `review/start`. */
export type CodexReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "custom"; instructions: string };

export function buildReviewStartParams(threadId: string, target: CodexReviewTarget): ReviewStartParams {
  const wireTarget: ReviewTarget = target.type === "commit"
    ? { type: "commit", sha: target.sha, title: target.title ?? null }
    : target;
  return { threadId, target: wireTarget, delivery: "inline" };
}

// ---------------------------------------------------------------------------
// Turn outcome helpers
// ---------------------------------------------------------------------------

export type CodexTurnOutcome = "completed" | "failed" | "interrupted";

/** `turn/completed` is the only terminal notification; its `turn.status` is authoritative. */
export function classifyTurnOutcome(turn: Pick<Turn, "status"> | undefined): CodexTurnOutcome {
  if (turn?.status === "failed") return "failed";
  if (turn?.status === "interrupted") return "interrupted";
  return "completed";
}

export function turnErrorMessage(turn: Pick<Turn, "error"> | undefined): string | undefined {
  const error = turn?.error;
  if (!error) return undefined;
  const details = error.additionalDetails?.trim();
  return details ? `${error.message}\n${details}` : error.message;
}

export function mapTurnPlanSteps(plan: TurnPlanStep[]): PlanArtifactStep[] {
  return plan
    .filter((entry) => entry.step.trim())
    .map((entry) => ({ step: entry.step, status: entry.status }));
}

// ---------------------------------------------------------------------------
// Server requests → OCA pending input
// ---------------------------------------------------------------------------

export const CODEX_COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";
export const CODEX_FILE_CHANGE_APPROVAL_METHOD = "item/fileChange/requestApproval";
export const CODEX_PERMISSIONS_APPROVAL_METHOD = "item/permissions/requestApproval";
export const CODEX_USER_INPUT_METHOD = "item/tool/requestUserInput";

/** One selectable approval answer and the exact wire response it produces. */
export type CodexApprovalChoice = {
  label: string;
  decision: PendingInputDecision;
  response: unknown;
  /**
   * Choices that also persist a policy change (exec-policy or network
   * amendments). Free-text replies never select these implicitly.
   */
  amendment?: true;
};

export type CodexPendingRequest =
  | { kind: "approval"; state: PendingInputState; choices: CodexApprovalChoice[]; declineResponse: unknown }
  | { kind: "question"; state: PendingInputState };

function commandDecisionChoice(decision: CommandExecutionApprovalDecision): CodexApprovalChoice {
  if (decision === "accept") return { label: "Approve once", decision: "accept", response: { decision } };
  if (decision === "acceptForSession") return { label: "Approve for session", decision: "acceptForSession", response: { decision } };
  if (decision === "decline") return { label: "Decline", decision: "decline", response: { decision } };
  if (decision === "cancel") return { label: "Decline and stop turn", decision: "cancel", response: { decision } };
  if ("acceptWithExecpolicyAmendment" in decision) {
    const prefix = decision.acceptWithExecpolicyAmendment.execpolicy_amendment.join(" ");
    return { label: `Always allow \`${prefix}\``, decision: "acceptForSession", response: { decision }, amendment: true };
  }
  const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment;
  return {
    label: `${amendment.action === "allow" ? "Always allow" : "Always deny"} host ${amendment.host}`,
    decision: amendment.action === "allow" ? "acceptForSession" : "decline",
    response: { decision },
    amendment: true,
  };
}

const DEFAULT_COMMAND_DECISIONS: CommandExecutionApprovalDecision[] = ["accept", "acceptForSession", "decline", "cancel"];

function approvalState(requestId: string, promptText: string, choices: CodexApprovalChoice[]): PendingInputState {
  const actions: PendingInputAction[] = choices.map((choice, index) => ({
    kind: "approval",
    label: choice.label,
    decision: choice.decision,
    responseDecision: String(index),
  }));
  return {
    requestId,
    kind: "approval",
    promptText,
    options: choices.map((choice) => choice.label),
    actions,
    allowsFreeText: true,
  };
}

function joinLines(lines: Array<string | null | undefined | false>): string {
  return lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0).join("\n");
}

export function buildCommandApprovalRequest(requestId: string, params: CommandExecutionRequestApprovalParams): CodexPendingRequest {
  const decisions = params.availableDecisions?.length ? params.availableDecisions : DEFAULT_COMMAND_DECISIONS;
  const choices = decisions.map(commandDecisionChoice);
  const promptText = joinLines([
    params.kind === "writeStdin" ? "Codex wants to write to a running terminal." : "Codex wants to run a command.",
    params.command ? `Command: ${params.command}` : undefined,
    params.cwd ? `Directory: ${params.cwd}` : undefined,
    params.networkApprovalContext ? `Network access: ${params.networkApprovalContext.host} (${params.networkApprovalContext.protocol})` : undefined,
    params.reason ? `Reason: ${params.reason}` : undefined,
  ]);
  return { kind: "approval", state: approvalState(requestId, promptText, choices), choices, declineResponse: { decision: "decline" } };
}

export function buildFileChangeApprovalRequest(requestId: string, params: FileChangeRequestApprovalParams): CodexPendingRequest {
  const choices: CodexApprovalChoice[] = [
    { label: "Approve once", decision: "accept", response: { decision: "accept" } },
    { label: "Approve for session", decision: "acceptForSession", response: { decision: "acceptForSession" } },
    { label: "Decline", decision: "decline", response: { decision: "decline" } },
    { label: "Decline and stop turn", decision: "cancel", response: { decision: "cancel" } },
  ];
  const promptText = joinLines([
    "Codex wants to apply file changes.",
    params.grantRoot ? `Requested write root: ${params.grantRoot}` : undefined,
    params.reason ? `Reason: ${params.reason}` : undefined,
  ]);
  return { kind: "approval", state: approvalState(requestId, promptText, choices), choices, declineResponse: { decision: "decline" } };
}

function describeFileSystemPath(path: FileSystemPath): string {
  if (path.type === "path") return path.path;
  if (path.type === "glob_pattern") return `glob ${path.pattern}`;
  const special = path.value;
  if (special.kind === "project_roots") return special.subpath ? `project roots/${special.subpath}` : "project roots";
  if (special.kind === "unknown") return special.subpath ? `${special.path}/${special.subpath}` : special.path;
  if (special.kind === "slash_tmp") return "/tmp";
  if (special.kind === "root") return "/ (entire filesystem)";
  return special.kind;
}

export function buildPermissionsApprovalRequest(requestId: string, params: PermissionsRequestApprovalParams): CodexPendingRequest {
  const granted: PermissionsRequestApprovalResponse["permissions"] = {
    ...(params.permissions.network ? { network: params.permissions.network } : {}),
    ...(params.permissions.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
  };
  const denied: PermissionsRequestApprovalResponse = { permissions: {}, scope: "turn" };
  const choices: CodexApprovalChoice[] = [
    { label: "Grant for this turn", decision: "accept", response: { permissions: granted, scope: "turn" } satisfies PermissionsRequestApprovalResponse },
    { label: "Grant for session", decision: "acceptForSession", response: { permissions: granted, scope: "session" } satisfies PermissionsRequestApprovalResponse },
    { label: "Decline", decision: "decline", response: denied },
  ];
  const fileSystem = params.permissions.fileSystem;
  const promptText = joinLines([
    "Codex requests additional permissions.",
    params.permissions.network?.enabled ? "Network access" : undefined,
    fileSystem?.write?.length ? `Write access: ${fileSystem.write.join(", ")}` : undefined,
    fileSystem?.read?.length ? `Read access: ${fileSystem.read.join(", ")}` : undefined,
    // `entries` supersedes read/write; every requested entry must be visible
    // because granting forwards the full filesystem request.
    ...(fileSystem?.entries ?? []).map((entry) => `Filesystem ${entry.access}: ${describeFileSystemPath(entry.path)}`),
    fileSystem?.globScanMaxDepth != null ? `Glob scan depth: ${fileSystem.globScanMaxDepth}` : undefined,
    `Directory: ${params.cwd}`,
    params.reason ? `Reason: ${params.reason}` : undefined,
  ]);
  return { kind: "approval", state: approvalState(requestId, promptText, choices), choices, declineResponse: denied };
}

export function buildUserInputRequest(requestId: string, params: ToolRequestUserInputParams): CodexPendingRequest {
  const questions: PendingInputQuestion[] = params.questions
    .filter((question) => question.question.trim())
    .map((question) => {
      const options = (question.options ?? []).map((option) => ({
        label: option.label,
        value: option.label,
        ...(option.description ? { description: option.description } : {}),
      }));
      return {
        id: question.id,
        ...(question.header ? { header: question.header } : {}),
        question: question.question,
        options,
        ...(question.isOther || options.length === 0 ? { allowsFreeText: true } : {}),
        ...(question.isSecret ? { isSecret: true } : {}),
      };
    });
  if (questions.length === 0) {
    throw new Error(`Malformed Codex request_user_input payload for ${requestId}: expected non-empty questions[]`);
  }
  const first = questions[0];
  return {
    kind: "question",
    state: {
      requestId,
      kind: "question",
      promptText: formatPendingInputWizardQuestion(first, 0, questions.length),
      options: first.options.map((option) => option.label),
      questions,
      activeQuestionIndex: 0,
      actions: first.options.map((option) => ({ kind: "option", label: option.label, value: option.value ?? option.label })),
      allowsFreeText: true,
    },
  };
}

/**
 * Map a free-text reply onto an approval choice. Returns `undefined` when the
 * text is not a recognizable decision; callers then decline and forward the
 * text to the agent as feedback.
 */
export function matchApprovalChoiceFromText(choices: CodexApprovalChoice[], text: string): CodexApprovalChoice | undefined {
  return matchApprovalChoiceText(choices, text);
}
