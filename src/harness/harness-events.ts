import type {
  PendingInputState,
  PlanArtifact,
  SessionBackendRef,
} from "../types";
import type { HarnessMessage, HarnessResult } from "./types";

export function createBackendRefEvent(ref: SessionBackendRef): HarnessMessage {
  return { type: "backend_ref", ref };
}

export function createRunStartedEvent(runId?: string): HarnessMessage {
  return { type: "run_started", ...(runId ? { runId } : {}) };
}

/** A pulled prompt settled without a turn, so the session must not wait for one. */
export function createPromptSettledEvent(): HarnessMessage {
  return { type: "prompt_settled" };
}

export function createTextDeltaEvent(text: string): HarnessMessage {
  return { type: "text_delta", text };
}

export function createToolCallEvent(name: string, input: unknown): HarnessMessage {
  return { type: "tool_call", name, input };
}

export function createPendingInputEvent(state: PendingInputState): HarnessMessage {
  return { type: "pending_input", state };
}

export function createPendingInputResolvedEvent(requestId?: string): HarnessMessage {
  return requestId
    ? { type: "pending_input_resolved", requestId }
    : { type: "pending_input_resolved" };
}

export function createPlanArtifactEvent(
  artifact: PlanArtifact,
  finalized: boolean,
): HarnessMessage {
  return { type: "plan_artifact", artifact, finalized };
}

export function createSettingsChangedEvent(permissionMode?: string): HarnessMessage {
  return permissionMode
    ? { type: "settings_changed", permissionMode }
    : { type: "settings_changed" };
}

export function createRunCompletedEvent(data: HarnessResult): HarnessMessage {
  return { type: "run_completed", data };
}

export class HarnessMessageQueue {
  private readonly queue: HarnessMessage[] = [];
  private resolvePending: (() => void) | null = null;
  private done = false;

  enqueue(message: HarnessMessage): void {
    this.queue.push(message);
    this.flush();
  }

  close(): void {
    this.done = true;
    this.flush();
  }

  private flush(): void {
    if (this.resolvePending) {
      this.resolvePending();
      this.resolvePending = null;
    }
  }

  messages(): AsyncIterable<HarnessMessage> {
    const self = this;
    return (async function* (): AsyncGenerator<HarnessMessage> {
      while (true) {
        while (self.queue.length > 0) {
          yield self.queue.shift()!;
        }
        if (self.done) return;
        await new Promise<void>((resolve) => {
          self.resolvePending = resolve;
        });
      }
    })();
  }
}

/**
 * Pull-based reader over a harness prompt stream that can tell whether the
 * next prompt is already queued.
 *
 * A harness pulls the next prompt as soon as a turn ends. When a follow-up was
 * queued during that turn, the session would otherwise receive the turn's
 * `run_completed` after the prompt already left its message stream, see no
 * pending messages, and end the session with the follow-up dropped. Harnesses
 * therefore ask `hasQueued()` before reporting a turn result and, like Claude
 * Code's `queued_turn_count`, defer the result to the queued turn.
 */
export class PromptReader {
  private readonly iterator: AsyncIterator<unknown>;
  private buffered: Promise<IteratorResult<unknown>> | undefined;

  constructor(iterable: AsyncIterable<unknown>) {
    this.iterator = iterable[Symbol.asyncIterator]();
  }

  next(): Promise<IteratorResult<unknown>> {
    const buffered = this.buffered;
    this.buffered = undefined;
    return buffered ?? this.iterator.next();
  }

  /**
   * True when another prompt is already queued: its `next()` settles before the
   * next macrotask. A prompt pushed later is picked up by the following
   * `next()` as usual.
   */
  async hasQueued(): Promise<boolean> {
    if (!this.buffered) {
      this.buffered = this.iterator.next();
      // Observed here so a stream failure never surfaces as an unhandled rejection;
      // the caller of next() still receives it.
      this.buffered.catch((): undefined => undefined);
    }
    const tick = new Promise<"tick">((resolve) => setImmediate(() => resolve("tick")));
    const winner = await Promise.race([
      this.buffered.then((result) => (result.done ? "done" : "item"), (): "done" => "done"),
      tick,
    ]);
    return winner === "item";
  }
}
