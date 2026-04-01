import { execFile } from "child_process";

const WAKE_CLI_TIMEOUT_MS = 30_000;
const WAKE_RETRY_BASE_DELAY_MS = 2_000;
const WAKE_RETRY_MAX_DELAY_MS = 20_000;
const WAKE_MAX_ATTEMPTS = 4;

export type DispatchTarget = "chat.send" | "message.send" | "discord.components" | "system.event";
export type DispatchPhase = "notify" | "wake";

type ExecuteOptions = {
  label: string;
  sessionId: string;
  target: DispatchTarget;
  phase: DispatchPhase;
  routeSummary: string;
  messageKind: "notify" | "wake";
  onStarted?: () => void;
  onSuccess?: () => void;
  onFinalFailure?: () => void;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function createDispatchTimeoutError(): Error {
  return new Error(`Dispatch timed out after ${WAKE_CLI_TIMEOUT_MS}ms`);
}

export class WakeDeliveryExecutor {
  private pendingRetryTimers: Map<string, Set<ReturnType<typeof setTimeout>>> = new Map();

  clearPendingRetries(): void {
    for (const timers of this.pendingRetryTimers.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    this.pendingRetryTimers.clear();
  }

  clearRetryTimersForSession(sessionId: string): void {
    const timers = this.pendingRetryTimers.get(sessionId);
    if (!timers) return;
    for (const timer of timers) clearTimeout(timer);
    this.pendingRetryTimers.delete(sessionId);
  }

  dispose(): void {
    this.clearPendingRetries();
  }

  execute(args: string[], opts: ExecuteOptions, attempt: number = 1): void {
    const startedAt = Date.now();
    if (attempt === 1) opts.onStarted?.();
    this.log("info", "dispatch_started", {
      label: opts.label,
      sessionId: opts.sessionId,
      target: opts.target,
      phase: opts.phase,
      messageKind: opts.messageKind,
      route: opts.routeSummary,
      attempt,
      maxAttempts: WAKE_MAX_ATTEMPTS,
    });

    execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (err, _stdout, stderr) => {
      const elapsedMs = Date.now() - startedAt;
      if (!err) {
        this.log("info", "dispatch_succeeded", {
          label: opts.label,
          sessionId: opts.sessionId,
          target: opts.target,
          phase: opts.phase,
          messageKind: opts.messageKind,
          route: opts.routeSummary,
          attempt,
          maxAttempts: WAKE_MAX_ATTEMPTS,
          elapsedMs,
        });
        opts.onSuccess?.();
        return;
      }

      const stderrSuffix = stderr?.trim() ? ` | stderr: ${stderr.trim()}` : "";
      if (attempt >= WAKE_MAX_ATTEMPTS) {
        this.log("error", "dispatch_failed", {
          label: opts.label,
          sessionId: opts.sessionId,
          target: opts.target,
          phase: opts.phase,
          messageKind: opts.messageKind,
          route: opts.routeSummary,
          attempt,
          maxAttempts: WAKE_MAX_ATTEMPTS,
          elapsedMs,
          error: `${errorMessage(err)}${stderrSuffix}`,
          terminal: true,
        });
        opts.onFinalFailure?.();
        return;
      }

      const delay = this.retryDelayMs(attempt);
      this.log("error", "dispatch_retry_scheduled", {
        label: opts.label,
        sessionId: opts.sessionId,
        target: opts.target,
        phase: opts.phase,
        messageKind: opts.messageKind,
        route: opts.routeSummary,
        attempt,
        maxAttempts: WAKE_MAX_ATTEMPTS,
        elapsedMs,
        retryDelayMs: delay,
        error: `${errorMessage(err)}${stderrSuffix}`,
      });
      const timer = setTimeout(() => {
        const timers = this.pendingRetryTimers.get(opts.sessionId);
        if (timers) {
          timers.delete(timer);
          if (timers.size === 0) this.pendingRetryTimers.delete(opts.sessionId);
        }
        this.execute(args, opts, attempt + 1);
      }, delay);
      timer.unref?.();
      if (!this.pendingRetryTimers.has(opts.sessionId)) {
        this.pendingRetryTimers.set(opts.sessionId, new Set());
      }
      this.pendingRetryTimers.get(opts.sessionId)!.add(timer);
    });
  }

  executePromise(task: () => Promise<void>, opts: ExecuteOptions, attempt: number = 1): void {
    const startedAt = Date.now();
    if (attempt === 1) opts.onStarted?.();
    this.log("info", "dispatch_started", {
      label: opts.label,
      sessionId: opts.sessionId,
      target: opts.target,
      phase: opts.phase,
      messageKind: opts.messageKind,
      route: opts.routeSummary,
      attempt,
      maxAttempts: WAKE_MAX_ATTEMPTS,
    });

    this.executePromiseWithTimeout(task)
      .then(() => {
        const elapsedMs = Date.now() - startedAt;
        this.log("info", "dispatch_succeeded", {
          label: opts.label,
          sessionId: opts.sessionId,
          target: opts.target,
          phase: opts.phase,
          messageKind: opts.messageKind,
          route: opts.routeSummary,
          attempt,
          maxAttempts: WAKE_MAX_ATTEMPTS,
          elapsedMs,
        });
        opts.onSuccess?.();
      })
      .catch((err) => {
        const elapsedMs = Date.now() - startedAt;
        if (attempt >= WAKE_MAX_ATTEMPTS) {
          this.log("error", "dispatch_failed", {
            label: opts.label,
            sessionId: opts.sessionId,
            target: opts.target,
            phase: opts.phase,
            messageKind: opts.messageKind,
            route: opts.routeSummary,
            attempt,
            maxAttempts: WAKE_MAX_ATTEMPTS,
            elapsedMs,
            error: errorMessage(err),
            terminal: true,
          });
          opts.onFinalFailure?.();
          return;
        }

        const delay = this.retryDelayMs(attempt);
        this.log("error", "dispatch_retry_scheduled", {
          label: opts.label,
          sessionId: opts.sessionId,
          target: opts.target,
          phase: opts.phase,
          messageKind: opts.messageKind,
          route: opts.routeSummary,
          attempt,
          maxAttempts: WAKE_MAX_ATTEMPTS,
          elapsedMs,
          retryDelayMs: delay,
          error: errorMessage(err),
        });
        const timer = setTimeout(() => {
          const timers = this.pendingRetryTimers.get(opts.sessionId);
          if (timers) {
            timers.delete(timer);
            if (timers.size === 0) this.pendingRetryTimers.delete(opts.sessionId);
          }
          this.executePromise(task, opts, attempt + 1);
        }, delay);
        timer.unref?.();
        if (!this.pendingRetryTimers.has(opts.sessionId)) {
          this.pendingRetryTimers.set(opts.sessionId, new Set());
        }
        this.pendingRetryTimers.get(opts.sessionId)!.add(timer);
      });
  }

  private executePromiseWithTimeout(task: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(createDispatchTimeoutError());
      }, WAKE_CLI_TIMEOUT_MS);
      timer.unref?.();

      Promise.resolve()
        .then(task)
        .then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        })
        .catch((err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private retryDelayMs(attempt: number): number {
    const exp = Math.max(0, attempt - 1);
    const delay = WAKE_RETRY_BASE_DELAY_MS * (2 ** exp);
    return Math.min(delay, WAKE_RETRY_MAX_DELAY_MS);
  }

  private log(level: "info" | "error", event: string, details: Record<string, unknown>): void {
    const message = `[WakeDispatcher] ${JSON.stringify({ event, ...details })}`;
    if (level === "error") {
      console.error(message);
      return;
    }
    console.info(message);
  }
}
