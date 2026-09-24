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
