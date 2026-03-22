/**
 * Codex harness — wraps `@openai/codex-sdk` threads and maps SDK events
 * into the plugin's HarnessSession message contract.
 */

import { parse, resolve } from "path";
import { Codex, type ApprovalMode, type ModelReasoningEffort, type Thread, type ThreadEvent, type ThreadOptions, type Usage } from "@openai/codex-sdk";
import type {
  AgentHarness,
  HarnessLaunchOptions,
  HarnessSession,
  HarnessMessage,
  HarnessResult,
} from "./types";
import { createCodexAuthWorkspace, type CodexAuthWorkspace } from "./codex-auth";
import { looksLikeWaitingForUser } from "../waiting-detector";

const DEFAULT_HEARTBEAT_MS = 10_000;

const CODEX_QUESTION_TOOL = "codex:waiting-for-user" as const;

const CODEX_INPUT_PRICE = 1.10 / 1_000_000;
const CODEX_CACHED_INPUT_PRICE = 0.275 / 1_000_000;
const CODEX_OUTPUT_PRICE = 4.40 / 1_000_000;
const OPENCLAW_CODEX_HEARTBEAT_MS_ENV = "OPENCLAW_CODEX_HEARTBEAT_MS";
const OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS_ENV = "OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS";
const OPENCLAW_CODEX_AUTH_STRATEGY_ENV = "OPENCLAW_CODEX_AUTH_STRATEGY";

type CodexClientLike = Pick<Codex, "startThread" | "resumeThread">;

type ThreadLike = Pick<Thread, "id" | "runStreamed">;

type TurnStreamLike = { events: AsyncIterable<ThreadEvent> };

interface CodexHarnessDeps {
  createCodex?: (options?: { env?: Record<string, string> }) => CodexClientLike;
  createAuthWorkspace?: (baseEnv?: NodeJS.ProcessEnv) => Promise<CodexAuthWorkspace>;
}

function estimateCostUsd(usage?: Usage): number {
  if (!usage) return 0;
  const cached = usage.cached_input_tokens ?? 0;
  const nonCachedInput = Math.max(0, (usage.input_tokens ?? 0) - cached);
  const output = usage.output_tokens ?? 0;
  return nonCachedInput * CODEX_INPUT_PRICE
    + cached * CODEX_CACHED_INPUT_PRICE
    + output * CODEX_OUTPUT_PRICE;
}

function makeResult(
  sessionId: string,
  partial: Partial<HarnessResult> = {},
): HarnessResult {
  return {
    success: false,
    duration_ms: 0,
    total_cost_usd: 0,
    num_turns: 0,
    session_id: sessionId,
    ...partial,
  };
}

function extractPromptText(msg: unknown): string {
  if (typeof msg === "string") return msg;
  if (!msg || typeof msg !== "object") return String(msg);

  const payload = msg as { message?: { content?: unknown }; text?: unknown };
  if (typeof payload.message?.content === "string") return payload.message.content;
  if (typeof payload.text === "string") return payload.text;
  return String(msg);
}

function buildSoftPlanningPrompt(prompt: string): string {
  return [
    "[SYSTEM: First turn only. Do not implement yet.]",
    "Start by producing a concise implementation plan only.",
    "Then end your response with an explicit question asking whether you should proceed with implementation.",
    "",
    prompt,
  ].join("\n");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseCsvEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

/**
 * Return the filesystem root for the launch cwd.
 *
 * We resolve first so relative inputs still map to a stable root (`/` on POSIX,
 * drive root on Windows-like paths).
 */
function resolveCwdRoot(cwd: string): string {
  const root = parse(resolve(cwd)).root;
  return root || "/";
}

/**
 * Build extra sandbox directories for bypass mode.
 *
 * Why include the filesystem root:
 * Codex SDK still applies an allowlist boundary even under permissive sandbox
 * settings. Including the root avoids accidental write denials when a task
 * needs to cross project boundaries (e.g., temp dirs, sibling repos, mounts).
 */
function buildBypassAdditionalDirectories(cwd: string): string[] {
  const root = resolveCwdRoot(cwd);
  const extras = [root];
  extras.push(...parseCsvEnv(process.env[OPENCLAW_CODEX_BYPASS_ADDITIONAL_DIRS_ENV]));

  return [...new Set(extras)];
}

function buildThreadOptions(options: HarnessLaunchOptions, permissionMode?: string): ThreadOptions {
  const effectivePermissionMode = permissionMode ?? options.permissionMode;
  const additionalDirectories = effectivePermissionMode === "bypassPermissions"
    ? buildBypassAdditionalDirectories(options.cwd)
    : undefined;

  return {
    model: options.model,
    modelReasoningEffort: options.reasoningEffort as ModelReasoningEffort | undefined,
    workingDirectory: options.cwd,
    sandboxMode: "danger-full-access",
    approvalPolicy: (options.codexApprovalPolicy ?? "on-request") as ApprovalMode,
    skipGitRepoCheck: true,
    additionalDirectories,
  };
}

export class CodexHarness implements AgentHarness {
  readonly name = "codex";

  readonly supportedPermissionModes = [
    "default",
    "plan",
    "bypassPermissions",
  ] as const;

  readonly questionToolNames: readonly string[] = [CODEX_QUESTION_TOOL];
  readonly planApprovalToolNames: readonly string[] = [];

  constructor(private readonly deps: CodexHarnessDeps = {}) {}

  private activityHeartbeatMs(): number {
    const parsed = Number.parseInt(process.env[OPENCLAW_CODEX_HEARTBEAT_MS_ENV] ?? String(DEFAULT_HEARTBEAT_MS), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HEARTBEAT_MS;
    return parsed;
  }

  private createCodexClient(env?: Record<string, string>): CodexClientLike {
    return this.deps.createCodex?.({ env }) ?? (env ? new Codex({ env }) : new Codex());
  }

  /**
   * Launch a Codex session backed by SDK threads.
   *
   * The harness emits:
   * - `init` once thread identity is known
   * - `text` for assistant/reasoning output
   * - synthetic `tool_use` events for waiting-for-user only
   * - `activity` heartbeats while a turn is in-flight
   * - `result` exactly once per turn
   *
   * `setPermissionMode()` marks the thread for recreation on the *next* turn.
   * Recreation uses `resumeThread` with the current thread id so continuity is
   * preserved while new thread options take effect.
   */
  launch(options: HarnessLaunchOptions): HarnessSession {
    const useLegacyAuthStrategy = process.env[OPENCLAW_CODEX_AUTH_STRATEGY_ENV] === "legacy";
    const authWorkspacePromise = useLegacyAuthStrategy
      ? undefined
      : (this.deps.createAuthWorkspace?.(process.env) ?? createCodexAuthWorkspace(process.env));
    const softPlanningFirstTurn = options.permissionMode === "plan";
    let effectivePermissionMode: string | undefined =
      options.permissionMode === "plan" ? "default" : options.permissionMode;
    let codexSessionId: string | undefined = options.resumeSessionId;
    let accumulatedCostUsd = 0;
    let numTurns = 0;

    const heartbeatMs = this.activityHeartbeatMs();

    let codexClient: CodexClientLike | undefined;
    let thread: ThreadLike | undefined;
    let pendingThreadRecreate = false;
    let firstTurn = true;
    let activeTurnAbortController: AbortController | undefined;
    let suppressAbortFailureOnce = false;

    const queue: HarnessMessage[] = [];
    let queueResolve: (() => void) | null = null;
    let queueDone = false;
    let initEmitted = false;

    function flushResolve(): void {
      if (queueResolve) {
        queueResolve();
        queueResolve = null;
      }
    }

    function enqueue(msg: HarnessMessage): void {
      queue.push(msg);
      flushResolve();
    }

    function endQueue(): void {
      queueDone = true;
      flushResolve();
    }

    function emitInitIfNeeded(sessionId: string | undefined): void {
      if (!sessionId || initEmitted) return;
      initEmitted = true;
      enqueue({ type: "init", session_id: sessionId });
    }

    async function* messageIterator(): AsyncGenerator<HarnessMessage> {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (queueDone) return;
        await new Promise<void>((r) => { queueResolve = r; });
      }
    }

    const threadOptionsFactory = (): ThreadOptions => buildThreadOptions(options, effectivePermissionMode);

    const ensureThreadForTurn = (env?: Record<string, string>): ThreadLike => {
      if (!codexClient) codexClient = this.createCodexClient(env);

      if (!thread) {
        if (firstTurn && options.resumeSessionId) {
          thread = codexClient.resumeThread(options.resumeSessionId, threadOptionsFactory());
        } else if (codexSessionId) {
          thread = codexClient.resumeThread(codexSessionId, threadOptionsFactory());
        } else {
          thread = codexClient.startThread(threadOptionsFactory());
        }
      }

      if (pendingThreadRecreate && codexSessionId) {
        thread = codexClient.resumeThread(codexSessionId, threadOptionsFactory());
        pendingThreadRecreate = false;
      }

      return thread;
    };

    const runTurn = async (prompt: string): Promise<void> => {
      const turnStart = Date.now();
      numTurns += 1;
      let turnAssistantText = "";
      let terminalEmitted = false;
      let suppressTerminalResult = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let releaseAuthBootstrap: (() => Promise<void>) | undefined;
      let authBootstrapReleased = false;
      const turnPrompt = firstTurn && softPlanningFirstTurn
        ? buildSoftPlanningPrompt(prompt)
        : prompt;

      const emitResult = (partial: Partial<HarnessResult>): void => {
        if (terminalEmitted) return;
        terminalEmitted = true;
        enqueue({
          type: "result",
          data: makeResult(codexSessionId ?? "", {
            duration_ms: Date.now() - turnStart,
            total_cost_usd: accumulatedCostUsd,
            num_turns: numTurns,
            ...partial,
            session_id: codexSessionId ?? "",
          }),
        });
      };

      const releaseAuthBootstrapIfNeeded = async (): Promise<void> => {
        if (!releaseAuthBootstrap || authBootstrapReleased) return;
        authBootstrapReleased = true;
        await releaseAuthBootstrap();
      };

      try {
        const authWorkspace = authWorkspacePromise ? await authWorkspacePromise : undefined;
        if (authWorkspace) {
          releaseAuthBootstrap = await authWorkspace.prepareForTurn();
        }

        const activeThread = ensureThreadForTurn(authWorkspace?.env);
        const knownSessionId = (activeThread.id ?? codexSessionId) ?? undefined;
        if (knownSessionId) {
          codexSessionId = knownSessionId;
        }

        activeTurnAbortController = new AbortController();
        if (options.abortController?.signal.aborted) {
          activeTurnAbortController.abort(options.abortController.signal.reason);
        }

        heartbeatTimer = setInterval(() => {
          // Keepalive so Session idle timers don't kill long silent turns.
          enqueue({ type: "activity" });
        }, heartbeatMs);

        const streamed: TurnStreamLike = await activeThread.runStreamed(turnPrompt, {
          signal: activeTurnAbortController.signal,
        });

        for await (const event of streamed.events) {
          await releaseAuthBootstrapIfNeeded();

          if (event.type === "thread.started") {
            codexSessionId = event.thread_id;
          }

          // Only mark the session live once the streamed turn has produced a
          // real event. `resumeThread(id)` exposes a thread id immediately, but
          // that alone does not guarantee a new Codex turn actually started.
          emitInitIfNeeded(codexSessionId ?? activeThread.id ?? undefined);

          if (event.type === "thread.started") {
            continue;
          }

          if (event.type === "item.completed") {
            if (event.item.type === "agent_message" || event.item.type === "reasoning") {
              turnAssistantText += `${event.item.text}\n`;
              enqueue({ type: "text", text: event.item.text });
            }
            continue;
          }

          if (event.type === "error") {
            if (!(activeTurnAbortController?.signal.aborted && suppressAbortFailureOnce)) {
              enqueue({ type: "text", text: `[codex:error] ${event.message}` });
            }
            continue;
          }

          if (event.type === "turn.failed") {
            if (activeTurnAbortController?.signal.aborted && suppressAbortFailureOnce) {
              suppressAbortFailureOnce = false;
              suppressTerminalResult = true;
              pendingThreadRecreate = true;
              break;
            }
            emitResult({
              success: false,
              result: event.error.message,
              session_id: codexSessionId ?? "",
            });
            continue;
          }

          if (event.type === "turn.completed") {
            accumulatedCostUsd += estimateCostUsd(event.usage);

            const tail = turnAssistantText.slice(-500);
            if (looksLikeWaitingForUser(tail)) {
              enqueue({
                type: "tool_use",
                name: CODEX_QUESTION_TOOL,
                input: { text: tail },
              });
            }

            emitResult({
              success: true,
              session_id: codexSessionId ?? "",
            });
          }
        }

        await releaseAuthBootstrapIfNeeded();

        if (suppressTerminalResult) {
          return;
        }

        if (!terminalEmitted) {
          emitResult({
            success: false,
            result: "Codex turn ended without terminal event",
            session_id: codexSessionId ?? "",
          });
        }
      } catch (err: unknown) {
        await releaseAuthBootstrapIfNeeded();
        if (activeTurnAbortController?.signal.aborted && suppressAbortFailureOnce) {
          suppressAbortFailureOnce = false;
          pendingThreadRecreate = true;
          return;
        }
        emitResult({
          success: false,
          result: errorMessage(err),
          session_id: codexSessionId ?? "",
        });
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        activeTurnAbortController = undefined;
        firstTurn = false;
      }
    };

    const onExternalAbort = (): void => {
      activeTurnAbortController?.abort(options.abortController?.signal.reason ?? "interrupted");
    };

    if (options.abortController?.signal) {
      options.abortController.signal.addEventListener("abort", onExternalAbort);
    }

    const runSession = async (): Promise<void> => {
      try {
        const promptInput = options.prompt;

        if (typeof promptInput === "string") {
          await runTurn(promptInput);
          return;
        }

        for await (const msg of promptInput) {
          if (options.abortController?.signal.aborted) break;
          await runTurn(extractPromptText(msg));
          if (options.abortController?.signal.aborted) break;
        }
      } finally {
        options.abortController?.signal.removeEventListener("abort", onExternalAbort);
        if (authWorkspacePromise) {
          try {
            const authWorkspace = await authWorkspacePromise;
            await authWorkspace.cleanup();
          } catch {
            // Startup already surfaced the failure to the session result.
          }
        }
        endQueue();
      }
    };

    runSession().catch((err: unknown) => {
      enqueue({
        type: "result",
        data: makeResult(codexSessionId ?? "", {
          success: false,
          result: errorMessage(err),
          total_cost_usd: accumulatedCostUsd,
          num_turns: numTurns,
          session_id: codexSessionId ?? "",
        }),
      });
      options.abortController?.signal.removeEventListener("abort", onExternalAbort);
      endQueue();
    });

    return {
      messages: messageIterator(),

      async setPermissionMode(mode: string): Promise<void> {
        effectivePermissionMode = mode;
        // Codex SDK thread options are immutable after creation. Recreate the
        // thread lazily before the next turn (same session id via resumeThread).
        pendingThreadRecreate = true;
      },

      async interrupt(): Promise<void> {
        if (!activeTurnAbortController) return;
        suppressAbortFailureOnce = true;
        activeTurnAbortController.abort("interrupted");
      },
    };
  }

  buildUserMessage(text: string, sessionId: string): unknown {
    return { type: "user", text, session_id: sessionId };
  }
}
