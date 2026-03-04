export type NormalizedCodexEvent =
  | { kind: "turn_started" }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | {
      kind: "result";
      success: boolean;
      durationMs?: number;
      numTurns?: number;
      result?: string;
      usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
    }
  | { kind: "error"; message: string }
  | { kind: "noop" };

export interface NormalizedCodexEnvelope {
  sessionId?: string;
  event: NormalizedCodexEvent;
}

function parseTextCandidate(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;

  const v = value as Record<string, unknown>;
  const direct = v.text ?? v.message ?? v.delta ?? v.output_text ?? v.reasoning ?? v.content;
  if (typeof direct === "string") return direct;

  if (Array.isArray(v.content)) {
    const joined = v.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const p = part as Record<string, unknown>;
        return (typeof p.text === "string" ? p.text : "")
          || (typeof p.content === "string" ? p.content : "")
          || (typeof p.delta === "string" ? p.delta : "");
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (joined) return joined;
  }
  return undefined;
}

function parseSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const direct = v.thread_id ?? v.session_id ?? v.id;
  if (typeof direct === "string" && direct) return direct;
  return parseSessionId(v.payload) ?? parseSessionId(v.thread);
}

function parseToolUse(value: unknown): { name: string; input: unknown } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const t = v.type;
  if (t !== "function_call" && t !== "custom_tool_call") return null;
  const name = (typeof v.name === "string" ? v.name : undefined)
    ?? (typeof v.call_id === "string" ? v.call_id : undefined)
    ?? "unknown_tool";
  return { name, input: v.arguments ?? v.input ?? {} };
}

function parseUsage(value: unknown): { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  // The usage field can live at event.usage or event.usage.* directly
  const usage = (v.usage && typeof v.usage === "object" ? v.usage : v) as Record<string, unknown>;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  const cached = typeof usage.cached_input_tokens === "number" ? usage.cached_input_tokens : undefined;
  if (input === undefined && output === undefined && cached === undefined) return undefined;
  return { input_tokens: input, output_tokens: output, cached_input_tokens: cached };
}

export function normalizeCodexEvent(raw: unknown): NormalizedCodexEnvelope {
  const sessionId = parseSessionId(raw);
  if (!raw || typeof raw !== "object") return { sessionId, event: { kind: "noop" } };

  const event = raw as Record<string, unknown>;
  const evType = typeof event.type === "string" ? event.type : "";

  if (evType === "session_meta") {
    return { sessionId, event: { kind: "noop" } };
  }
  if (evType === "thread.started") {
    return { sessionId, event: { kind: "noop" } };
  }
  if (evType === "turn.started") {
    return { sessionId, event: { kind: "turn_started" } };
  }
  if (evType === "turn.completed") {
    return {
      sessionId,
      event: {
        kind: "result",
        success: true,
        durationMs: typeof event.duration_ms === "number" ? event.duration_ms : undefined,
        numTurns: typeof event.num_turns === "number" ? event.num_turns : undefined,
        result: typeof event.result === "string" ? event.result : undefined,
        usage: parseUsage(event),
      },
    };
  }
  if (evType === "turn.failed") {
    const message = parseTextCandidate(event.error) ?? parseTextCandidate(event) ?? "Turn failed";
    return {
      sessionId,
      event: {
        kind: "result",
        success: false,
        durationMs: typeof event.duration_ms === "number" ? event.duration_ms : undefined,
        numTurns: typeof event.num_turns === "number" ? event.num_turns : undefined,
        result: message,
        usage: parseUsage(event),
      },
    };
  }
  if (evType === "error") {
    const message = parseTextCandidate(event.error) ?? parseTextCandidate(event);
    if (!message) return { sessionId, event: { kind: "noop" } };
    return { sessionId, event: { kind: "error", message } };
  }

  if (evType === "event_msg") {
    const inner = (event.payload ?? event.event ?? event) as Record<string, unknown>;
    const innerType = typeof inner.type === "string" ? inner.type : "";
    if (innerType === "task_started") return { sessionId: parseSessionId(inner) ?? sessionId, event: { kind: "turn_started" } };
    if (innerType === "agent_message") {
      const text = parseTextCandidate(inner);
      return text
        ? { sessionId: parseSessionId(inner) ?? sessionId, event: { kind: "text", text } }
        : { sessionId: parseSessionId(inner) ?? sessionId, event: { kind: "noop" } };
    }
    if (innerType === "agent_reasoning") {
      const text = parseTextCandidate(inner);
      return text
        ? { sessionId: parseSessionId(inner) ?? sessionId, event: { kind: "text", text } }
        : { sessionId: parseSessionId(inner) ?? sessionId, event: { kind: "noop" } };
    }
    if (innerType === "task_complete") {
      return {
        sessionId: parseSessionId(inner) ?? sessionId,
        event: {
          kind: "result",
          success: true,
          durationMs: typeof inner.duration_ms === "number" ? inner.duration_ms : undefined,
          numTurns: typeof inner.num_turns === "number" ? inner.num_turns : undefined,
          result: (typeof inner.last_agent_message === "string" ? inner.last_agent_message : undefined)
            ?? (typeof inner.result === "string" ? inner.result : undefined),
        },
      };
    }
    if (innerType === "task_failed") {
      const message = parseTextCandidate(inner.error) ?? parseTextCandidate(inner) ?? "Task failed";
      return {
        sessionId: parseSessionId(inner) ?? sessionId,
        event: {
          kind: "result",
          success: false,
          durationMs: typeof inner.duration_ms === "number" ? inner.duration_ms : undefined,
          numTurns: typeof inner.num_turns === "number" ? inner.num_turns : undefined,
          result: message,
        },
      };
    }
    if (innerType === "turn_aborted") {
      return {
        sessionId: parseSessionId(inner) ?? sessionId,
        event: {
          kind: "result",
          success: false,
          result: (typeof inner.reason === "string" ? inner.reason : undefined) ?? "Turn aborted",
        },
      };
    }
    if (innerType === "error") {
      const message = parseTextCandidate(inner.error) ?? parseTextCandidate(inner);
      if (!message) return { sessionId: parseSessionId(inner) ?? sessionId, event: { kind: "noop" } };
      return { sessionId: parseSessionId(inner) ?? sessionId, event: { kind: "error", message } };
    }
    return { sessionId: parseSessionId(inner) ?? sessionId, event: { kind: "noop" } };
  }

  const payloadRecord = event.payload && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : undefined;
  const item = event.item ?? payloadRecord?.item ?? event.payload;
  const tool = parseToolUse(item);
  if (tool) {
    return { sessionId, event: { kind: "tool_use", name: tool.name, input: tool.input } };
  }

  const text = parseTextCandidate(item) ?? parseTextCandidate(event.payload) ?? parseTextCandidate(event);
  if (text) return { sessionId, event: { kind: "text", text } };

  return { sessionId, event: { kind: "noop" } };
}
