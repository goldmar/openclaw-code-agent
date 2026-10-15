import type { OpenCodeEvent } from "./protocol/events";
export interface TurnOutcome {
  outcome: "completed" | "failed" | "interrupted";
  errorCode?: string;
  message?: string;
}
/** Execution terminals have no input ID: admission is correlated through delivery. */
export class TurnTracker {
  readonly owned = new Set<string>();
  readonly delivered = new Set<string>();
  running = false;
  continuing = false;
  interruptRequested = false;
  attached = false;
  /** A server-confirmed pending request belongs to an existing execution. */
  attach(): void {
    this.attached = true;
    this.running = true;
  }
  begin(id: string): void {
    this.owned.add(id);
    this.running = true;
  }
  forget(id: string): void {
    this.owned.delete(id);
  }
  apply(e: OpenCodeEvent): TurnOutcome | undefined {
    if (
      e.type === "session.inbox.delivered" &&
      this.owned.has(e.data.inboxID)
    ) {
      this.delivered.add(e.data.inboxID);
      this.continuing = false;
    }
    if (e.type === "session.inbox.cancelled") this.owned.delete(e.data.inboxID);
    if (
      !e.type.startsWith("session.execution.") ||
      e.type === "session.execution.started" ||
      (!this.delivered.size && !this.attached)
    )
      return;
    if ([...this.owned].some((id) => !this.delivered.has(id))) {
      this.continuing = true;
      return;
    }
    this.running = false;
    switch (e.type) {
      case "session.execution.succeeded":
        return { outcome: "completed" };
      case "session.execution.failed":
        return {
          outcome: "failed",
          errorCode: e.data.error.type,
          message: e.data.error.message,
        };
      case "session.execution.interrupted": {
        const reason = e.data.reason;
        return reason === "inactivity" ||
          (reason === "shutdown" && !this.interruptRequested)
          ? { outcome: "failed", errorCode: `opencode_${reason}` }
          : { outcome: "interrupted" };
      }
    }
  }
}
