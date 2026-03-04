/**
 * Codex harness — wraps OpenAI's `codex` CLI via subprocess + JSONL streaming.
 *
 * Auth: user runs `codex login` once; credentials are stored by the CLI itself.
 * Multi-turn: restart model — `codex exec resume <session-id> "<text>"` replays
 *   conversation history and continues from the previous turn.
 */

import { execFileSync, spawn } from "child_process";
import { createInterface } from "readline";
import type {
  AgentHarness,
  HarnessLaunchOptions,
  HarnessSession,
  HarnessMessage,
  HarnessResult,
} from "./types";
import { normalizeCodexEvent } from "./codex-events";
import { looksLikeWaitingForUser } from "../waiting-detector";

const DEFAULT_HEARTBEAT_MS = 10_000;
const INTERRUPT_KILL_AFTER_MS = 2_000;

// Synthetic tool names emitted when heuristic detection determines Codex is
// waiting for user input or plan approval (Codex has no real tool-use events
// for these, unlike Claude Code's AskUserQuestion / ExitPlanMode).
const CODEX_QUESTION_TOOL = "codex:waiting-for-user" as const;
const CODEX_PLAN_APPROVAL_TOOL = "codex:plan-approval" as const;

// ---------------------------------------------------------------------------
// Token pricing — Codex CLI defaults to codex-mini-latest (o4-mini class).
// Prices in USD per token. Cached input tokens are discounted.
// ---------------------------------------------------------------------------

const CODEX_INPUT_PRICE = 1.10 / 1_000_000;   // $1.10 per 1M input tokens
const CODEX_CACHED_INPUT_PRICE = 0.275 / 1_000_000; // $0.275 per 1M cached input
const CODEX_OUTPUT_PRICE = 4.40 / 1_000_000;  // $4.40 per 1M output tokens

function estimateCostUsd(usage?: {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
}): number {
  if (!usage) return 0;
  const cached = usage.cached_input_tokens ?? 0;
  const nonCachedInput = Math.max(0, (usage.input_tokens ?? 0) - cached);
  const output = usage.output_tokens ?? 0;
  return nonCachedInput * CODEX_INPUT_PRICE
    + cached * CODEX_CACHED_INPUT_PRICE
    + output * CODEX_OUTPUT_PRICE;
}

// ---------------------------------------------------------------------------
// Permission mode → Codex CLI flag mapping
// ---------------------------------------------------------------------------

function permissionModeToFlags(mode?: string): string[] {
  switch (mode) {
    case "plan":
      return ["--sandbox", "read-only"];
    case "acceptEdits":
      return ["--sandbox", "workspace-write"];
    case "bypassPermissions":
      return ["--dangerously-bypass-approvals-and-sandbox"];
    default:
      return []; // "default" → no flag, Codex on-request approvals
  }
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// CodexHarness
// ---------------------------------------------------------------------------

export class CodexHarness implements AgentHarness {
  readonly name = "codex";

  readonly supportedPermissionModes = [
    "default",
    "plan",
    "acceptEdits",
    "bypassPermissions",
  ] as const;

  readonly questionToolNames: readonly string[] = [CODEX_QUESTION_TOOL];
  readonly planApprovalToolNames: readonly string[] = [CODEX_PLAN_APPROVAL_TOOL];

  private activityHeartbeatMs(): number {
    const parsed = Number.parseInt(process.env.OPENCLAW_CODEX_HEARTBEAT_MS ?? String(DEFAULT_HEARTBEAT_MS), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HEARTBEAT_MS;
    return parsed;
  }

  launch(options: HarnessLaunchOptions): HarnessSession {
    // Verify `codex` binary is available at launch time
    try {
      execFileSync("which", ["codex"], { stdio: "ignore" });
    } catch {
      throw new Error(
        "codex CLI not found. Install it with: npm install -g @openai/codex && codex login",
      );
    }

    // Mutable state shared by the async runSession loop and the HarnessSession handle
    let effectivePermissionMode: string | undefined = options.permissionMode;
    let codexSessionId: string | undefined;
    let currentProcess: ReturnType<typeof spawn> | undefined;
    let accumulatedCostUsd = 0;
    const heartbeatMs = this.activityHeartbeatMs();

    // Simple async queue for HarnessMessages
    const queue: HarnessMessage[] = [];
    let queueResolve: (() => void) | null = null;
    let queueDone = false;

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

    async function* messageIterator(): AsyncGenerator<HarnessMessage> {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (queueDone) return;
        await new Promise<void>((r) => { queueResolve = r; });
      }
    }

    // Spawn a single `codex exec` or `codex exec resume` process and parse JSONL
    function spawnCodexProcess(prompt: string, resumeId?: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const sandboxFlags = permissionModeToFlags(effectivePermissionMode);

        const args = resumeId
          // `codex exec resume` expects: `codex exec resume --json <session-id> <prompt>`
          // and rejects sandbox flags. Keep permission mode for future turns but
          // do not pass sandbox flags on resume invocation itself.
          ? ["exec", "resume", "--json", resumeId, prompt]
          : [
              "exec",
              ...(options.cwd ? ["-C", options.cwd] : []),
              ...(options.model ? ["-m", options.model] : []),
              ...sandboxFlags,
              "--json",
              prompt,
            ];

        let currentTurnStarted = false;
        let initEmitted = false;
        let terminalResultEmitted = false;
        let lastErrorMessage = "";
        let stderrOutput = "";
        let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
        // Accumulates assistant text during the current turn so we can run
        // the waiting-for-user heuristic on turn completion.
        let turnAssistantText = "";

        const emitInitIfNeeded = (sid?: string): void => {
          if (!sid) return;
          codexSessionId = sid;
          if (!initEmitted) {
            initEmitted = true;
            enqueue({ type: "init", session_id: sid });
          }
        };

        const emitResult = (result: Partial<HarnessResult>): void => {
          if (terminalResultEmitted) return;
          terminalResultEmitted = true;
          enqueue({
            type: "result",
            data: makeResult(codexSessionId ?? "", result),
          });
        };

        const child = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"] });
        currentProcess = child;

        // Kill the child process when the session's AbortController fires
        // (e.g. session.kill() → teardown → abort). SIGTERM first, then
        // SIGKILL after INTERRUPT_KILL_AFTER_MS if still alive.
        let abortKillTimer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = (): void => {
          try { child.kill("SIGTERM"); } catch { /* already exited */ }
          abortKillTimer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* already exited */ }
          }, INTERRUPT_KILL_AFTER_MS);
        };
        if (options.abortController) {
          if (options.abortController.signal.aborted) {
            onAbort();
          } else {
            options.abortController.signal.addEventListener("abort", onAbort, { once: true });
          }
        }

        // Heartbeat prevents idle-timeout kills while a Codex subprocess is
        // busy but temporarily silent (no text/tool events emitted yet).
        heartbeatTimer = setInterval(() => {
          enqueue({ type: "activity" });
        }, heartbeatMs);

        const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        const errRl = createInterface({ input: child.stderr!, crlfDelay: Infinity });

        rl.on("line", (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;

          let event: unknown;
          try {
            event = JSON.parse(trimmed);
          } catch {
            return; // non-JSON line (debug output, etc.)
          }

          const normalized = normalizeCodexEvent(event);
          emitInitIfNeeded(normalized.sessionId);

          if (normalized.event.kind === "turn_started") {
            currentTurnStarted = true;
            turnAssistantText = "";
            return;
          }

          if (normalized.event.kind === "noop") {
            return;
          }

          // Only emit text/tool events for the current turn (skip replay/history)
          if (!currentTurnStarted && (normalized.event.kind === "text" || normalized.event.kind === "tool_use")) {
            return;
          }

          if (normalized.event.kind === "text") {
            turnAssistantText += normalized.event.text + "\n";
            enqueue({ type: "text", text: normalized.event.text });
            return;
          }

          if (normalized.event.kind === "tool_use") {
            enqueue({
              type: "tool_use",
              name: normalized.event.name,
              input: normalized.event.input,
            });
            return;
          }

          if (normalized.event.kind === "error") {
            lastErrorMessage = normalized.event.message;
            enqueue({ type: "text", text: `[codex:error] ${normalized.event.message}` });
            return;
          }

          if (normalized.event.kind === "result") {
            if (!normalized.event.success && normalized.event.result) {
              lastErrorMessage = normalized.event.result;
            }

            // Heuristic question/plan-approval detection for Codex.
            // Codex doesn't use named tools like Claude Code's AskUserQuestion
            // / ExitPlanMode, so we detect waiting-for-user from the assistant
            // text and emit synthetic tool_use messages that the session's
            // consumeMessages loop recognises.
            if (normalized.event.success) {
              // Use the tail of the assistant text for heuristic matching
              // (last 500 chars captures the final question/prompt).
              const tail = turnAssistantText.slice(-500);
              if (effectivePermissionMode === "plan") {
                // In plan mode every successful turn completion means the
                // plan has been presented and is awaiting approval.
                enqueue({
                  type: "tool_use",
                  name: CODEX_PLAN_APPROVAL_TOOL,
                  input: { text: tail },
                });
              } else if (looksLikeWaitingForUser(tail)) {
                enqueue({
                  type: "tool_use",
                  name: CODEX_QUESTION_TOOL,
                  input: { text: tail },
                });
              }
            }

            // Accumulate cost from token usage reported by the Codex CLI
            const turnCost = estimateCostUsd(normalized.event.usage);
            accumulatedCostUsd += turnCost;

            emitResult({
              success: normalized.event.success,
              duration_ms: normalized.event.durationMs ?? 0,
              total_cost_usd: accumulatedCostUsd,
              num_turns: normalized.event.numTurns ?? 1,
              result: normalized.event.result,
            });
          }
        });

        child.on("error", (err) => {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
          }
          reject(new Error(`codex process error: ${err.message}`));
        });

        errRl.on("line", (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          stderrOutput = stderrOutput ? `${stderrOutput}\n${trimmed}` : trimmed;
        });

        child.on("close", (code) => {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
          }
          if (abortKillTimer) {
            clearTimeout(abortKillTimer);
            abortKillTimer = undefined;
          }
          options.abortController?.signal.removeEventListener("abort", onAbort);
          rl.close();
          errRl.close();
          currentProcess = undefined;
          if (!terminalResultEmitted) {
            if (code === 0 || code === null) {
              emitResult({
                success: true,
                result: lastErrorMessage || undefined,
              });
            } else {
              const stderrMsg = stderrOutput ? ` | stderr: ${stderrOutput}` : "";
              emitResult({
                success: false,
                result: lastErrorMessage
                  ? `${lastErrorMessage}${stderrMsg}`
                  : `codex exited with code ${code}${stderrMsg}`,
              });
            }
          }
          resolve();
        });
      });
    }

    // Main session loop: first turn, then follow-up turns from the prompt iterable
    async function runSession(): Promise<void> {
      try {
        const promptInput = options.prompt;

        if (typeof promptInput === "string") {
          // Single-turn or explicit string prompt
          await spawnCodexProcess(promptInput, options.resumeSessionId);
        } else {
          // Multi-turn: async iterable of user messages
          for await (const msg of promptInput) {
            if (options.abortController?.signal.aborted) break;
            const text = extractPromptText(msg);
            const resumeId = codexSessionId ?? options.resumeSessionId;
            await spawnCodexProcess(text, resumeId);
            if (options.abortController?.signal.aborted) break;
          }
        }
      } catch (err: unknown) {
        enqueue({
          type: "result",
          data: makeResult(codexSessionId ?? "", { result: errorMessage(err) }),
        });
      } finally {
        endQueue();
      }
    }

    // Start the session loop (detached — errors surface via enqueue)
    runSession().catch(() => endQueue());

    return {
      messages: messageIterator(),

      async setPermissionMode(mode: string): Promise<void> {
        // Stored and applied on the next exec resume spawn
        effectivePermissionMode = mode;
      },

      async interrupt(): Promise<void> {
        if (currentProcess) {
          currentProcess.kill("SIGTERM");
          const proc = currentProcess;
          setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              // Process already exited
            }
              }, INTERRUPT_KILL_AFTER_MS);
            }
          },
        };
      }

  buildUserMessage(text: string, sessionId: string): unknown {
    return { type: "user", text, session_id: sessionId };
  }
}
