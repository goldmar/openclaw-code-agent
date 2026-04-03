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
  orderingKey?: string;
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

type RetryTimerEntry = {
  timer: ReturnType<typeof setTimeout>;
  onCleared?: () => void;
};

export class WakeDeliveryExecutor {
  private pendingRetryTimers: Map<string, Set<RetryTimerEntry>> = new Map();
  private orderedDispatchTails: Map<string, Promise<void>> = new Map();
  private disposed = false;

  clearPendingRetries(): void {
    for (const entries of this.pendingRetryTimers.values()) {
      for (const entry of entries) {
        clearTimeout(entry.timer);
        entry.onCleared?.();
      }
    }
    this.pendingRetryTimers.clear();
  }

  clearRetryTimersForSession(sessionId: string): void {
    const entries = this.pendingRetryTimers.get(sessionId);
    if (!entries) return;
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.onCleared?.();
    }
    this.pendingRetryTimers.delete(sessionId);
  }

  dispose(): void {
    this.disposed = true;
    this.clearPendingRetries();
    this.orderedDispatchTails.clear();
  }

  execute(args: string[], opts: ExecuteOptions, attempt: number = 1): void {
    if (this.disposed) return;
    if (attempt === 1 && opts.orderingKey) {
      this.enqueueOrderedDispatch(opts.orderingKey, (onSettled) => this.executeNow(args, opts, onSettled, attempt));
      return;
    }
    this.executeNow(args, opts, undefined, attempt);
  }

  executePromise(task: () => Promise<void>, opts: ExecuteOptions, attempt: number = 1): void {
    if (this.disposed) return;
    if (attempt === 1 && opts.orderingKey) {
      this.enqueueOrderedDispatch(opts.orderingKey, (onSettled) => this.executePromiseNow(task, opts, onSettled, attempt));
      return;
    }
    this.executePromiseNow(task, opts, undefined, attempt);
  }

  private executeNow(
    args: string[],
    opts: ExecuteOptions,
    onSettled?: () => void,
    attempt: number = 1,
  ): void {
    if (this.disposed) {
      onSettled?.();
      return;
    }
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
      if (this.disposed) {
        onSettled?.();
        return;
      }
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
        onSettled?.();
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
        onSettled?.();
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
      const entry: RetryTimerEntry = {
        timer: setTimeout(() => {
          const entries = this.pendingRetryTimers.get(opts.sessionId);
          if (entries) {
            entries.delete(entry);
            if (entries.size === 0) this.pendingRetryTimers.delete(opts.sessionId);
          }
          this.executeNow(args, opts, onSettled, attempt + 1);
        }, delay),
        onCleared: onSettled,
      };
      entry.timer.unref?.();
      if (!this.pendingRetryTimers.has(opts.sessionId)) {
        this.pendingRetryTimers.set(opts.sessionId, new Set());
      }
      this.pendingRetryTimers.get(opts.sessionId)!.add(entry);
    });
  }

  private executePromiseNow(
    task: () => Promise<void>,
    opts: ExecuteOptions,
    onSettled?: () => void,
    attempt: number = 1,
  ): void {
    if (this.disposed) {
      onSettled?.();
      return;
    }
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
        if (this.disposed) {
          onSettled?.();
          return;
        }
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
        onSettled?.();
      })
      .catch((err) => {
        if (this.disposed) {
          onSettled?.();
          return;
        }
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
          onSettled?.();
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
        const entry: RetryTimerEntry = {
          timer: setTimeout(() => {
            const entries = this.pendingRetryTimers.get(opts.sessionId);
            if (entries) {
              entries.delete(entry);
              if (entries.size === 0) this.pendingRetryTimers.delete(opts.sessionId);
            }
            this.executePromiseNow(task, opts, onSettled, attempt + 1);
          }, delay),
          onCleared: onSettled,
        };
        entry.timer.unref?.();
        if (!this.pendingRetryTimers.has(opts.sessionId)) {
          this.pendingRetryTimers.set(opts.sessionId, new Set());
        }
        this.pendingRetryTimers.get(opts.sessionId)!.add(entry);
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

  private enqueueOrderedDispatch(orderingKey: string, task: (onSettled: () => void) => void): void {
    const previous = this.orderedDispatchTails.get(orderingKey) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => {
        if (this.disposed) return;
        return new Promise<void>((resolve) => {
          let settled = false;
          const onSettled = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          task(onSettled);
        });
      });
    this.orderedDispatchTails.set(orderingKey, next);
    void next.finally(() => {
      if (this.orderedDispatchTails.get(orderingKey) === next) {
        this.orderedDispatchTails.delete(orderingKey);
      }
    });
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
