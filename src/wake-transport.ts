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
  /**
   * Target session: the origin session that owns the OCA session. Required;
   * there is no implicit fallback to the default agent's `main` session, which
   * multi-agent hosts reject and single-agent hosts would route to the user's
   * direct-message session.
   */
  sessionKey: string;
  /** Host de-duplication context for repeated events from the same source. */
  contextKey?: string;
  /**
   * Whether the orchestrator must act on the event now. `true` requests an
   * immediate host heartbeat for the origin session; `false` only enqueues, and
   * the host prepends the event to that session's next turn.
   */
  wakeNow: boolean;
}

export interface SystemEventTransport {
  enqueue(text: string, options: SystemEventWakeOptions): Promise<void>;
}

/**
 * In-process system-event delivery through the public plugin runtime
 * (`api.runtime.system.enqueueSystemEvent`, plus `requestHeartbeat` when the
 * event must be handled now).
 *
 * Wake cost: OpenClaw 2026.9.6 has no plugin-usable wake that processes a
 * generic system event without the heartbeat routine. Any `requestHeartbeat`
 * (every intent) runs the agent's configured heartbeat prompt
 * (`HEARTBEAT.md` checklist) with the queued events attached; only exec
 * completions and `cron:` events get a dedicated event-only prompt, and those
 * belong to their host producers. `intent: "event"` uses the same prompt plus
 * cooldown gating, and is not admitted for agents without a heartbeat
 * schedule. So OCA requests an immediate `notifications-event` wake for wake
 * fallbacks (the orchestrator must act: a failed `chat.send` or a session
 * without a chat route) and for text-only user notices that could not be sent
 * directly when nothing else would surface them. A notice whose dispatch also
 * sends an OCA wake is only enqueued: the host prepends it to that wake's
 * `chat.send` turn, so no heartbeat run is needed.
 *
 * A session key the host refuses is an error; it is never rerouted to another
 * session.
 */
export class RuntimeSystemEventTransport implements SystemEventTransport {
  async enqueue(text: string, options: SystemEventWakeOptions): Promise<void> {
    const system = getPluginRuntime()?.system;
    if (!system) throw new Error("OpenClaw runtime system events are unavailable before plugin registration");
    const sessionKey = options.sessionKey?.trim();
    if (!sessionKey) throw new Error("System event wake requires the origin session key");
    const contextKey = options.contextKey?.trim() || undefined;
    system.enqueueSystemEvent(text, { sessionKey, ...(contextKey ? { contextKey } : {}) });
    if (!options.wakeNow) return;
    // `enqueueSystemEvent` returns false for an identical pending event; the wake is
    // still requested so the queued copy is processed.
    system.requestHeartbeat({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      sessionKey,
    });
  }
}
