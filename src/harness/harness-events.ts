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
