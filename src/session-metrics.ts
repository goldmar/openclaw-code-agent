import { truncateText } from "./format";
import type { SessionMetrics, SessionStatus } from "./types";
import type { Session } from "./session";

const TERMINAL_STATUSES = new Set<SessionStatus>(["completed", "failed", "killed"]);

/** Aggregates in-memory usage metrics across session lifecycles. */
export class SessionMetricsRecorder {
  private metrics: SessionMetrics = {
    totalCostUsd: 0,
    costPerDay: new Map(),
    sessionsByStatus: { completed: 0, failed: 0, killed: 0 },
    totalLaunched: 0,
    totalDurationMs: 0,
    sessionsWithDuration: 0,
    mostExpensive: null,
  };

  /** Count a newly launched session. */
  incrementLaunched(): void {
    this.metrics.totalLaunched++;
  }

  /** Record terminal session metrics exactly once per lifecycle. */
  recordSession(session: Session): void {
    const cost = session.costUsd ?? 0;
    const status = session.status;

    this.metrics.totalCostUsd += cost;

    const dateKey = new Date(session.completedAt ?? session.startedAt).toISOString().slice(0, 10);
    this.metrics.costPerDay.set(dateKey, (this.metrics.costPerDay.get(dateKey) ?? 0) + cost);

    if (TERMINAL_STATUSES.has(status)) {
      this.metrics.sessionsByStatus[status as "completed" | "failed" | "killed"]++;
    }

    if (session.completedAt) {
      const durationMs = session.completedAt - session.startedAt;
      this.metrics.totalDurationMs += durationMs;
      this.metrics.sessionsWithDuration++;
    }

    if (!this.metrics.mostExpensive || cost > this.metrics.mostExpensive.costUsd) {
      this.metrics.mostExpensive = {
        id: session.id,
        name: session.name,
        costUsd: cost,
        prompt: truncateText(session.prompt, 80),
      };
    }
  }

  /** Return the current metrics snapshot object. */
  getMetrics(): SessionMetrics {
    return {
      totalCostUsd: this.metrics.totalCostUsd,
      costPerDay: new Map(this.metrics.costPerDay),
      sessionsByStatus: { ...this.metrics.sessionsByStatus },
      totalLaunched: this.metrics.totalLaunched,
      totalDurationMs: this.metrics.totalDurationMs,
      sessionsWithDuration: this.metrics.sessionsWithDuration,
      mostExpensive: this.metrics.mostExpensive ? { ...this.metrics.mostExpensive } : null,
    };
  }
}
