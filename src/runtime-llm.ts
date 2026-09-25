import { AsyncResource } from "node:async_hooks";
import { getPluginRuntime, type PluginRuntime } from "./runtime-store";

type RuntimeLlmComplete = PluginRuntime["llm"]["complete"];

export interface RuntimeLlmTextRequest {
  /** Stable audit label, e.g. `openclaw-code-agent.pr-metadata`. */
  purpose: string;
  systemPrompt: string;
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal;
}

/**
 * Host-owned text completion via the public `api.runtime.llm.complete(...)`.
 *
 * OpenClaw grants external plugins direct completions against the default
 * agent's configured model without extra config. OCA never requests a model,
 * agent, or auth-profile override, so no `plugins.entries.<id>.llm.*` opt-in is
 * needed; an operator `allowedCompletionModels` allowlist can still deny the
 * call (`LLM_COMPLETION_NOT_AUTHORIZED`), and callers then use their
 * deterministic fallback.
 */
export function getRuntimeLlmComplete(): RuntimeLlmComplete | undefined {
  // Undefined only before plugin registration; callers then use their fallback.
  return getPluginRuntime()?.llm.complete;
}

/**
 * Async context captured when this module is first evaluated (plugin load),
 * before any tool call or Gateway request runs plugin code.
 *
 * OCA's summaries run from session events: harness output loops started inside
 * an earlier tool call (for example `agent_launch`) keep that call's async
 * context, including the host's per-request async work scope. Once the tool
 * call returned, the host closes that scope, and `runtime.llm.complete` then
 * rejects with "Async work scope is closed" because it admits its work into
 * the caller's scope. Running the call inside this detached resource restores
 * the load-time context instead, so the completion is owned by no finished
 * request. (The host uses the same pattern for its own background work; there
 * is no public plugin-SDK helper for it on 2026.9.6.)
 */
const detachedLlmContext = new AsyncResource("openclaw-code-agent.runtime-llm");

/** Run `fn` outside the async context (and request work scope) of the caller. */
export function runDetachedFromRequestScope<T>(fn: () => T): T {
  return detachedLlmContext.runInAsyncScope(fn);
}

/** Returns the completion text, or throws the host error (with its stable `code`). */
export async function completeRuntimeLlmText(
  complete: RuntimeLlmComplete,
  request: RuntimeLlmTextRequest,
): Promise<string> {
  const result = await runDetachedFromRequestScope(() => complete({
    messages: [{ role: "user", content: request.prompt }],
    systemPrompt: request.systemPrompt,
    purpose: request.purpose,
    maxTokens: request.maxTokens,
    // Short structured summaries; "low" is accepted by every current reasoning model.
    reasoning: "low",
    ...(request.signal ? { signal: request.signal } : {}),
  }));
  const text = typeof result?.text === "string" ? result.text : "";
  return stripJsonCodeFence(text);
}

/**
 * How long each caller waits for a host completion before it uses its
 * deterministic fallback. The question and worktree-decision notifications and
 * `agent_pr` wait on these completions. Mutable only so tests can shorten them.
 */
export const runtimeLlmTimeoutsMs = {
  questionContextSummary: 5_000,
  worktreeDecisionSummary: 20_000,
  prMetadata: 45_000,
};

/** Thrown by `withRuntimeLlmTimeout` when the host completion did not finish in time. */
export class RuntimeLlmTimeoutError extends Error {
  readonly code = "LLM_COMPLETION_TIMEOUT";
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "RuntimeLlmTimeoutError";
  }
}

/**
 * Bound a host completion. Every OCA summary has a deterministic fallback, so a
 * completion that hangs (a stuck provider, a host that never settles the call)
 * must not hold back the notification or tool call waiting on it: after
 * `timeoutMs` the request is aborted through its signal and this rejects with
 * `RuntimeLlmTimeoutError`.
 */
export function withRuntimeLlmTimeout<T>(
  label: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new RuntimeLlmTimeoutError(label, timeoutMs));
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    let pending: Promise<T>;
    try {
      pending = run(controller.signal);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Models often wrap JSON in a Markdown fence even when asked not to. */
export function stripJsonCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

export function describeRuntimeLlmError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;
  return code ? `${code}: ${message}` : message;
}
