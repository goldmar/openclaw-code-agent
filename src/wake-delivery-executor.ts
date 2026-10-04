import * as childProcess from "child_process";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { KeyedOperationQueue } from "./keyed-operation-queue";
import { createLogger } from "./logger";

const log = createLogger("wake-delivery-executor");

const WAKE_CLI_TIMEOUT_MS = 30_000;
const WAKE_RETRY_BASE_DELAY_MS = 2_000;
const WAKE_RETRY_MAX_DELAY_MS = 20_000;
const WAKE_MAX_ATTEMPTS = 4;

/** A delivery task can confirm success, skip, or leave its outcome unknown. */
export type PromiseDeliveryResult = void | "skipped" | "ambiguous";

export type DispatchTarget = "chat.send" | "message.send" | "system.event";
export type DispatchPhase = "notify" | "wake";
export type DispatchSuccessValidationResult =
  | { outcome: "success" }
  | { outcome: "ambiguous"; reason: string }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failure"; reason: string };

type ExecuteOptions = {
  label: string;
  sessionId: string;
  target: DispatchTarget;
  phase: DispatchPhase;
  routeSummary: string;
  messageKind: "notify" | "wake";
  dispatchContext?: Record<string, unknown>;
  orderingKey?: string;
  onStarted?: () => void;
  onSuccess?: () => void;
  onSkipped?: (reason: string) => void;
  /**
   * The task timed out or reported an unknown outcome after possible delivery.
   * When set, a timeout calls this instead of retrying or `onFinalFailure`, so
   * callers never trigger a second delivery path for a send that may land later.
   */
  onAmbiguousResult?: () => void;
  onAdmissionRejected?: () => void;
  onFinalFailure?: () => void;
  successValidator?: (stdout: string) => DispatchSuccessValidationResult | Promise<DispatchSuccessValidationResult>;
  shouldContinue?: () => boolean;
  terminalOnFailure?: boolean;
  /** Explicit origin fields require authenticated admin scope, unavailable in CLI flags. */
  gatewayRpc?: { method: "chat.send"; params: Record<string, unknown> };
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class DispatchTimeoutError extends Error {
  constructor() {
    super(`Dispatch timed out after ${wakeDeliveryExecutorInternals.promiseTimeoutMs}ms`);
    this.name = "DispatchTimeoutError";
  }
}

class DispatchNotSubmittedError extends Error {}

function createDispatchTimeoutError(): Error {
  return new DispatchTimeoutError();
}

export const wakeDeliveryExecutorInternals = {
  execFile: childProcess.execFile,
  callGatewayFromCli,
  /** How long a promise-based delivery (a direct send) may take before its outcome counts as unknown. */
  promiseTimeoutMs: WAKE_CLI_TIMEOUT_MS,
};

type RetryTimerEntry = {
  timer: ReturnType<typeof setTimeout>;
  onCleared?: () => void;
};

export class WakeDeliveryExecutor {
  private pendingRetryTimers: Map<string, Set<RetryTimerEntry>> = new Map();
  private orderedDispatches = new KeyedOperationQueue();
  private disposed = false;
  private readonly gatewayRequests = new Set<AbortController>();

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
    for (const controller of this.gatewayRequests) controller.abort();
    this.gatewayRequests.clear();
    this.clearPendingRetries();
    this.orderedDispatches.clear();
  }

  execute(args: string[], opts: ExecuteOptions, attempt: number = 1): void {
    if (this.disposed) {
      if (opts.onAdmissionRejected) {
        opts.onAdmissionRejected();
        opts.onAmbiguousResult?.();
      }
      return;
    }
    if (attempt === 1 && opts.orderingKey) {
      this.enqueueOrderedDispatch(opts.orderingKey, (onSettled) => this.executeNow(args, opts, onSettled, attempt));
      return;
    }
    this.executeNow(args, opts, undefined, attempt);
  }

  /** Observe an admitted wake through the same CLI boundary without resending it. */
  request(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      wakeDeliveryExecutorInternals.execFile(
        "openclaw", [...args], { timeout: WAKE_CLI_TIMEOUT_MS, killSignal: "SIGKILL" },
        (err, stdout) => err ? reject(err) : resolve(stdout ?? ""),
      );
    });
  }

  /**
   * Run a delivery task. A task that resolves to `"skipped"` decided not to send
   * (for example its prompt became obsolete); that is logged as skipped, not as
   * a successful delivery, and no success or failure handler runs.
   */
  executePromise(task: () => Promise<PromiseDeliveryResult>, opts: ExecuteOptions, attempt: number = 1): void {
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
    if (this.disposed || opts.shouldContinue?.() === false) {
      if (opts.onAdmissionRejected) {
        opts.onAdmissionRejected();
        opts.onAmbiguousResult?.();
      }
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
      ...opts.dispatchContext,
      attempt,
      maxAttempts: WAKE_MAX_ATTEMPTS,
    });

    const onResult = async (err: unknown, stdout: string, stderr: string): Promise<void> => {
        if (this.disposed) {
          onSettled?.();
          return;
        }
        const elapsedMs = Date.now() - startedAt;
        if (!err) {
          let validation: DispatchSuccessValidationResult | undefined;
          try {
            validation = await opts.successValidator?.(stdout ?? "");
          } catch {
            // A validator may be observing an already admitted host run. An
            // observation error cannot establish that resending is safe.
            validation = { outcome: "ambiguous", reason: "wake result observation failed" };
          }
          if (this.disposed || opts.shouldContinue?.() === false) {
            onSettled?.();
            return;
          }
          if (validation?.outcome === "ambiguous") {
            this.log("warn", "dispatch_ambiguous", {
              label: opts.label, sessionId: opts.sessionId, target: opts.target,
              phase: opts.phase, messageKind: opts.messageKind, route: opts.routeSummary,
              attempt, elapsedMs: Date.now() - startedAt, reason: validation.reason,
            });
            opts.onAmbiguousResult?.();
            onSettled?.();
            return;
          }
          if (validation?.outcome === "failure") {
            this.log("error", "dispatch_success_validation_failed", {
              label: opts.label,
              sessionId: opts.sessionId,
              target: opts.target,
              phase: opts.phase,
              messageKind: opts.messageKind,
              route: opts.routeSummary,
              ...opts.dispatchContext,
              attempt,
              maxAttempts: WAKE_MAX_ATTEMPTS,
              elapsedMs,
              error: validation.reason,
              terminal: true,
            });
            opts.onFinalFailure?.();
            onSettled?.();
            return;
          }
          if (validation?.outcome === "skipped") {
            this.log("info", "dispatch_skipped", {
              label: opts.label,
              sessionId: opts.sessionId,
              target: opts.target,
              phase: opts.phase,
              messageKind: opts.messageKind,
              route: opts.routeSummary,
              ...opts.dispatchContext,
              attempt,
              maxAttempts: WAKE_MAX_ATTEMPTS,
              elapsedMs,
              reason: validation.reason,
            });
            if (opts.shouldContinue?.() !== false) {
              opts.onSkipped?.(validation.reason);
            }
            onSettled?.();
            return;
          }
          this.log("info", "dispatch_succeeded", {
            label: opts.label,
            sessionId: opts.sessionId,
            target: opts.target,
            phase: opts.phase,
            messageKind: opts.messageKind,
            route: opts.routeSummary,
            ...opts.dispatchContext,
            attempt,
            maxAttempts: WAKE_MAX_ATTEMPTS,
            elapsedMs,
          });
          if (opts.shouldContinue?.() !== false) {
            opts.onSuccess?.();
          }
          onSettled?.();
          return;
        }

        const stderrSuffix = stderr?.trim() ? ` | stderr: ${stderr.trim()}` : "";
        if (opts.shouldContinue?.() === false) {
          onSettled?.();
          return;
        }
        const definitelyRejected = (err as NodeJS.ErrnoException).code === "ENOENT"
          || stderr?.includes("originating route fields require admin scope") === true;
        if (opts.onAmbiguousResult && opts.target === "chat.send" && !definitelyRejected) {
          // A CLI timeout or connection failure can happen after admission.
          // Keep the pending wake; never start a second heartbeat delivery.
          opts.onAmbiguousResult();
          onSettled?.();
          return;
        }
        if (definitelyRejected && opts.onAdmissionRejected) {
          opts.onAdmissionRejected();
          opts.onFinalFailure?.();
          onSettled?.();
          return;
        }
        if (attempt >= WAKE_MAX_ATTEMPTS || opts.terminalOnFailure === true) {
          this.log("error", "dispatch_failed", {
            label: opts.label,
            sessionId: opts.sessionId,
            target: opts.target,
            phase: opts.phase,
            messageKind: opts.messageKind,
            route: opts.routeSummary,
            ...opts.dispatchContext,
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
        this.log("warn", "dispatch_retry_scheduled", {
          label: opts.label,
          sessionId: opts.sessionId,
          target: opts.target,
          phase: opts.phase,
          messageKind: opts.messageKind,
          route: opts.routeSummary,
          ...opts.dispatchContext,
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
            if (opts.shouldContinue?.() === false) {
              onSettled?.();
              return;
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
    };
    if (opts.gatewayRpc) {
      const controller = new AbortController();
      this.gatewayRequests.add(controller);
      // This public helper creates an ordinary authenticated WS client. It
      // requests admin scope; the Gateway still checks credentials and grants.
      // It does not use the trusted plugin runtime.gateway.request surface.
      void this.executePromiseWithTimeout(() => {
        if (this.disposed || opts.shouldContinue?.() === false) throw new DispatchNotSubmittedError();
        return wakeDeliveryExecutorInternals.callGatewayFromCli(
          opts.gatewayRpc!.method,
          { json: true, timeout: String(WAKE_CLI_TIMEOUT_MS) },
          opts.gatewayRpc!.params,
          { scopes: ["operator.admin"], progress: false, sharedStateMode: "read-only", signal: controller.signal },
        );
      }).finally(() => {
        controller.abort();
        this.gatewayRequests.delete(controller);
      }).then(
        (result) => onResult(null, JSON.stringify(result), ""),
        (error: unknown) => {
          if (error instanceof DispatchNotSubmittedError) {
            opts.onAdmissionRejected?.();
            opts.onAmbiguousResult?.();
            onSettled?.();
            return;
          }
          return onResult(error, "", errorMessage(error));
        },
      ).catch(() => { onSettled?.(); });
      return;
    }
    wakeDeliveryExecutorInternals.execFile(
      "openclaw", [...args], { timeout: WAKE_CLI_TIMEOUT_MS, killSignal: "SIGKILL" },
      (err, stdout, stderr) => { void onResult(err, stdout, stderr).catch(() => { onSettled?.(); }); },
    );
  }

  private executePromiseNow(
    task: () => Promise<PromiseDeliveryResult>,
    opts: ExecuteOptions,
    onSettled?: () => void,
    attempt: number = 1,
  ): void {
    if (this.disposed || opts.shouldContinue?.() === false) {
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
      ...opts.dispatchContext,
      attempt,
      maxAttempts: WAKE_MAX_ATTEMPTS,
    });

    this.executePromiseWithTimeout(task)
      .then((result) => {
        if (this.disposed) {
          onSettled?.();
          return;
        }
        const elapsedMs = Date.now() - startedAt;
        if (result === "ambiguous") {
          this.settleAmbiguousResult(opts, onSettled);
          return;
        }
        if (result === "skipped") {
          this.log("info", "dispatch_skipped", {
            label: opts.label,
            sessionId: opts.sessionId,
            target: opts.target,
            phase: opts.phase,
            messageKind: opts.messageKind,
            route: opts.routeSummary,
            ...opts.dispatchContext,
            attempt,
            maxAttempts: WAKE_MAX_ATTEMPTS,
            elapsedMs,
            reason: "delivery no longer applicable",
          });
          onSettled?.();
          return;
        }
        this.log("info", "dispatch_succeeded", {
          label: opts.label,
          sessionId: opts.sessionId,
          target: opts.target,
          phase: opts.phase,
          messageKind: opts.messageKind,
          route: opts.routeSummary,
          ...opts.dispatchContext,
          attempt,
          maxAttempts: WAKE_MAX_ATTEMPTS,
          elapsedMs,
        });
        if (opts.shouldContinue?.() !== false) {
          opts.onSuccess?.();
        }
        onSettled?.();
      })
      .catch((err) => {
        if (this.disposed) {
          onSettled?.();
          return;
        }
        const elapsedMs = Date.now() - startedAt;
        if (opts.shouldContinue?.() === false) {
          onSettled?.();
          return;
        }
        if (err instanceof DispatchTimeoutError && opts.onAmbiguousResult) {
          this.log("error", "dispatch_failed", {
            label: opts.label,
            sessionId: opts.sessionId,
            target: opts.target,
            phase: opts.phase,
            messageKind: opts.messageKind,
            route: opts.routeSummary,
            ...opts.dispatchContext,
            attempt,
            maxAttempts: WAKE_MAX_ATTEMPTS,
            elapsedMs,
            error: errorMessage(err),
            terminal: true,
            ambiguousResult: true,
          });
          this.settleAmbiguousResult(opts, onSettled);
          return;
        }
        if (attempt >= WAKE_MAX_ATTEMPTS || opts.terminalOnFailure === true) {
          this.log("error", "dispatch_failed", {
            label: opts.label,
            sessionId: opts.sessionId,
            target: opts.target,
            phase: opts.phase,
            messageKind: opts.messageKind,
            route: opts.routeSummary,
            ...opts.dispatchContext,
            attempt,
            maxAttempts: WAKE_MAX_ATTEMPTS,
            elapsedMs,
            error: errorMessage(err),
            terminal: true,
            ...(opts.terminalOnFailure === true && attempt < WAKE_MAX_ATTEMPTS ? { terminalReason: "non_retryable" } : {}),
          });
          opts.onFinalFailure?.();
          onSettled?.();
          return;
        }

        const delay = this.retryDelayMs(attempt);
        this.log("warn", "dispatch_retry_scheduled", {
          label: opts.label,
          sessionId: opts.sessionId,
          target: opts.target,
          phase: opts.phase,
          messageKind: opts.messageKind,
          route: opts.routeSummary,
          ...opts.dispatchContext,
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
            if (opts.shouldContinue?.() === false) {
              onSettled?.();
              return;
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

  /** Unknown delivery stays terminal even if caller bookkeeping fails. */
  private settleAmbiguousResult(opts: ExecuteOptions, onSettled?: () => void): void {
    for (const callback of [opts.onAmbiguousResult, onSettled]) {
      try { callback?.(); }
      catch {
        this.log("error", "dispatch_ambiguity_hook_failed", {
          label: opts.label, sessionId: opts.sessionId, target: opts.target,
          phase: opts.phase, ambiguousResult: true,
        });
      }
    }
  }

  private executePromiseWithTimeout<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(createDispatchTimeoutError());
      }, wakeDeliveryExecutorInternals.promiseTimeoutMs);
      timer.unref?.();

      Promise.resolve()
        .then(task)
        .then((result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
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
    void this.orderedDispatches.enqueue(orderingKey, async () => {
      if (this.disposed) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const onSettled = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        task(onSettled);
      });
    });
  }

  private log(level: "info" | "warn" | "error", event: string, details: Record<string, unknown>): void {
    const message = `[WakeDispatcher] ${JSON.stringify({ event, ...details })}`;
    if (level === "error") {
      log.error(message);
      return;
    }
    // A scheduled retry is transient; only the terminal failure is an error.
    if (level === "warn") {
      log.warn(message);
      return;
    }
    // Per-dispatch progress is verbose diagnostics; failures stay at error level.
    log.debug(message);
  }
}
