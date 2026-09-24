import { randomUUID } from "crypto";
import { getPluginRuntime } from "./runtime-store";

export interface WakeTransportOptions {}

/**
 * Builds the `openclaw gateway call chat.send` wake subprocess arguments.
 *
 * `chat.send` stays a CLI subprocess: the in-process `runtime.gateway.request`
 * surface grants operator scopes only to trusted plugins, which OCA is not.
 */
export class WakeTransport {
  constructor(_options: WakeTransportOptions = {}) {}

  buildChatSendArgs(
    sessionKey: string,
    text: string,
    deliver: boolean,
    idempotencyKey: string = randomUUID(),
  ): string[] {
    return [
      "gateway",
      "call",
      "chat.send",
      "--expect-final",
      "--timeout",
      "30000",
      "--params",
      JSON.stringify({
        sessionKey,
        message: text,
        deliver,
        idempotencyKey,
      }),
    ];
  }
}

export interface SystemEventWakeOptions {
  /** Target session; omitted means the default agent's main session. */
  sessionKey?: string;
  /** Host de-duplication context for repeated events from the same source. */
  contextKey?: string;
}

export interface SystemEventTransport {
  enqueue(text: string, options?: SystemEventWakeOptions): Promise<void>;
}

const MAIN_SESSION_ALIAS = "main";

/**
 * In-process system-event wake through the public plugin runtime
 * (`api.runtime.system.enqueueSystemEvent` + `requestHeartbeat`).
 *
 * This replaces the former `openclaw system event --mode now` subprocess and
 * mirrors the Gateway `wake` method: enqueue the event, then request an
 * immediate heartbeat for the same session.
 */
export class RuntimeSystemEventTransport implements SystemEventTransport {
  async enqueue(text: string, options: SystemEventWakeOptions = {}): Promise<void> {
    const system = getPluginRuntime()?.system;
    if (typeof system?.enqueueSystemEvent !== "function" || typeof system.requestHeartbeat !== "function") {
      throw new Error("OpenClaw runtime system events are unavailable");
    }
    const targetSessionKey = options.sessionKey?.trim() || undefined;
    const contextKey = options.contextKey?.trim() || undefined;
    let sessionKey = targetSessionKey ?? MAIN_SESSION_ALIAS;
    try {
      system.enqueueSystemEvent(text, { sessionKey, ...(contextKey ? { contextKey } : {}) });
    } catch (err) {
      // A targeted key the host refuses (for example a harness/subagent key) falls back
      // to the main session, matching the former CLI fallback target.
      if (!targetSessionKey) throw err;
      sessionKey = MAIN_SESSION_ALIAS;
      system.enqueueSystemEvent(text, { sessionKey, ...(contextKey ? { contextKey } : {}) });
    }
    // `enqueueSystemEvent` returns false for an identical pending event; the wake is
    // still requested so the queued copy is processed.
    system.requestHeartbeat({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      ...(sessionKey !== MAIN_SESSION_ALIAS ? { sessionKey } : {}),
    });
  }
}
