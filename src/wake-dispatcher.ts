import { execFile } from "child_process";
import { randomUUID } from "crypto";
import type { Session } from "./session";

const WAKE_CLI_TIMEOUT_MS = 30_000;
const WAKE_RETRY_BASE_DELAY_MS = 2_000;
const WAKE_RETRY_MAX_DELAY_MS = 20_000;
const WAKE_MAX_ATTEMPTS = 4; // initial try + 3 retries

export type SessionNotificationPolicy = "always" | "on-wake-fallback" | "never";

export interface SessionNotificationRequest {
  label: string;
  userMessage?: string;
  wakeMessage?: string;
  notifyUser?: SessionNotificationPolicy;
  /** Telegram inline keyboard buttons. Ignored by non-Telegram channels. */
  buttons?: Array<Array<{ label: string; callbackData: string }>>;
  /**
   * Called when ALL user-notification delivery attempts fail (direct channel + system-event
   * fallback). Use this to fire a fallback terminal notification when a turn-complete delivery
   * is unconfirmed and all retry paths are exhausted.
   */
  onUserNotifyFailed?: () => void;
}

type DispatchTarget = "chat.send" | "message.send" | "system.event";
type DispatchPhase = "notify" | "wake";
type NotificationRoute = {
  channel: string;
  target: string;
  accountId?: string;
  threadId?: string;
};

export class WakeDispatcher {
  private pendingRetryTimers: Map<string, Set<ReturnType<typeof setTimeout>>> = new Map();

  constructor() {
    process.on("beforeExit", () => {
      if (this.pendingRetryTimers.size > 0) {
        console.warn(
          `[WakeDispatcher] beforeExit: ${this.pendingRetryTimers.size} pending retry timer(s) ` +
          `still active — event loop should stay alive, investigate if process exits prematurely.`,
        );
        // DO NOT cancel — cancelling abandons in-flight notification retries
      }
    });

    const gracefulShutdown = (signal: string): void => {
      if (this.pendingRetryTimers.size === 0) return;
      console.warn(
        `[WakeDispatcher] ${signal}: ${this.pendingRetryTimers.size} pending retry timer(s) ` +
        `will be abandoned on hard exit.`,
      );
    };
    process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.once("SIGINT", () => gracefulShutdown("SIGINT"));
  }

  /** Cancel all scheduled retry timers across all sessions. */
  clearPendingRetries(): void {
    for (const timers of this.pendingRetryTimers.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    this.pendingRetryTimers.clear();
  }

  /** Cancel retry timers for a specific session (e.g. when a session is killed). */
  clearRetryTimersForSession(sessionId: string): void {
    const timers = this.pendingRetryTimers.get(sessionId);
    if (!timers) return;
    for (const timer of timers) clearTimeout(timer);
    this.pendingRetryTimers.delete(sessionId);
  }

  private getOriginSessionKey(session: Session): string | undefined {
    const sessionKey = session.originSessionKey?.trim();
    return sessionKey ? sessionKey : undefined;
  }

  private getOriginThreadId(session: Session): string | undefined {
    const threadId = session.originThreadId;
    if (threadId == null) return undefined;
    const normalized = String(threadId).trim();
    return normalized || undefined;
  }

  private parseNotificationRoute(session: Session): NotificationRoute | undefined {
    const originChannel = session.originChannel?.trim();
    const originThreadId = this.getOriginThreadId(session);
    if (originChannel) {
      const parts = originChannel.split("|").map((part) => part.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const [channel, second, third] = parts;
        const target = third ?? second;
        const accountId = third ? second : undefined;
        if (channel && target) {
          let enrichedTarget = target;
          if (channel === "discord" && /^\d+$/.test(target)) {
            const sk = session.originSessionKey ?? "";
            const discordPrefixMatch = sk.match(/^agent:[^:]+:discord:(channel|user):/i);
            if (discordPrefixMatch?.[1]) {
              enrichedTarget = `${discordPrefixMatch[1]}:${target}`;
            }
          }
          return {
            channel,
            target: enrichedTarget,
            accountId,
            threadId: originThreadId ?? this.parseThreadIdFromSessionKey(session.originSessionKey),
          };
        }
      }
    }

    const sessionKey = this.getOriginSessionKey(session);
    if (!sessionKey) return undefined;
    const match = sessionKey.match(/^agent:[^:]+:telegram:(?:direct|dm|group|channel):([^:]+)(?::topic:(\d+))?$/i);
    if (match?.[1]) {
      return {
        channel: "telegram",
        target: match[1],
        threadId: originThreadId ?? match[2],
      };
    }
    const discordMatch = sessionKey.match(/^agent:[^:]+:discord:(direct|dm|channel|group):(\d+)$/i);
    if (discordMatch?.[2]) {
      const dKind = discordMatch[1].toLowerCase();
      const dId = discordMatch[2];
      return {
        channel: "discord",
        target: (dKind === "direct" || dKind === "dm") ? `user:${dId}` : `channel:${dId}`,
        threadId: originThreadId,
      };
    }
    return undefined;
  }

  private parseThreadIdFromSessionKey(sessionKey?: string): string | undefined {
    if (!sessionKey) return undefined;
    const match = sessionKey.match(/:topic:(\d+)$/);
    return match?.[1];
  }

  private retryDelayMs(attempt: number): number {
    const exp = Math.max(0, attempt - 1);
    const delay = WAKE_RETRY_BASE_DELAY_MS * (2 ** exp);
    return Math.min(delay, WAKE_RETRY_MAX_DELAY_MS);
  }

  private executeWithRetries(
    args: string[],
    opts: {
      label: string;
      sessionId: string;
      target: DispatchTarget;
      phase: DispatchPhase;
      onFinalFailure?: () => void;
    },
    attempt: number = 1,
  ): void {
    const startedAt = Date.now();
    console.info(
      `[WakeDispatcher] ${opts.target} ${opts.phase} started attempt ${attempt}/${WAKE_MAX_ATTEMPTS} for ${opts.label} session=${opts.sessionId}`,
    );
    console.info(
      `[WakeDispatcher] dispatching notification: label=${opts.label} session=${opts.sessionId}`,
    );

    execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (err, _stdout, stderr) => {
      const elapsedMs = Date.now() - startedAt;
      if (!err) {
        console.info(
          `[WakeDispatcher] ${opts.target} ${opts.phase} completed attempt ${attempt}/${WAKE_MAX_ATTEMPTS} for ${opts.label} session=${opts.sessionId} in ${elapsedMs}ms`,
        );
        return;
      }

      const stderrSuffix = stderr?.trim() ? ` | stderr: ${stderr.trim()}` : "";
      const failurePrefix = `[WakeDispatcher] ${opts.target} ${opts.phase} failed`;
      if (attempt >= WAKE_MAX_ATTEMPTS) {
        console.error(
          `${failurePrefix} after ${attempt} attempts for ${opts.label} session=${opts.sessionId} in ${elapsedMs}ms: ${err.message}${stderrSuffix}`,
        );
        opts.onFinalFailure?.();
        return;
      }

      const delay = this.retryDelayMs(attempt);
      console.error(
        `${failurePrefix} attempt ${attempt}/${WAKE_MAX_ATTEMPTS} for ${opts.label} session=${opts.sessionId} in ${elapsedMs}ms: ${err.message}${stderrSuffix}. Retrying in ${delay}ms`,
      );
      const timer = setTimeout(() => {
        const timers = this.pendingRetryTimers.get(opts.sessionId);
        if (timers) {
          timers.delete(timer);
          if (timers.size === 0) this.pendingRetryTimers.delete(opts.sessionId);
        }
        this.executeWithRetries(args, opts, attempt + 1);
      }, delay);
      if (!this.pendingRetryTimers.has(opts.sessionId)) {
        this.pendingRetryTimers.set(opts.sessionId, new Set());
      }
      this.pendingRetryTimers.get(opts.sessionId)!.add(timer);
    });
  }

  /** Fire `openclaw gateway call chat.send` for a specific origin session key with bounded retries. */
  private fireChatSendWithRetry(
    sessionKey: string,
    text: string,
    label: string,
    sessionId: string,
    phase: DispatchPhase,
    deliver: boolean = false,
    onFinalFailure?: () => void,
  ): void {
    const args = [
      "gateway",
      "call",
      "chat.send",
      "--expect-final",
      "--timeout",
      String(WAKE_CLI_TIMEOUT_MS),
      "--params",
      JSON.stringify({
        sessionKey,
        message: text,
        deliver,
        idempotencyKey: randomUUID(),
      }),
    ];
    this.executeWithRetries(args, {
      label,
      sessionId,
      target: "chat.send",
      phase,
      onFinalFailure,
    });
  }

  /** Fire `openclaw message send` for a direct outbound notification. */
  private fireDirectNotificationWithRetry(
    route: NotificationRoute,
    text: string,
    label: string,
    sessionId: string,
    buttons?: Array<Array<{ label: string; callbackData: string }>>,
    onFinalFailure?: () => void,
  ): void {
    const args = [
      "message",
      "send",
      "--channel",
      route.channel,
      "--target",
      route.target,
      "--message",
      text,
    ];
    if (route.accountId) {
      args.push("--account", route.accountId);
    }
    if (route.threadId) {
      args.push("--thread-id", route.threadId);
    }
    if (buttons && route.channel === "telegram") {
      // OpenClaw CLI expects { text, callback_data } — map from internal { label, callbackData }
      const cliButtons = buttons.map(row =>
        row.map(btn => ({ text: btn.label, callback_data: btn.callbackData }))
      );
      args.push("--buttons", JSON.stringify(cliButtons));
    }
    this.executeWithRetries(args, {
      label,
      sessionId,
      target: "message.send",
      phase: "notify",
      onFinalFailure,
    });
  }

  /** Fire `openclaw system event` with bounded retries. */
  private fireSystemEventWithRetry(
    text: string,
    label: string,
    sessionId: string,
    phase: DispatchPhase,
    onFinalFailure?: () => void,
  ): void {
    const args = ["system", "event", "--text", text, "--mode", "now"];
    this.executeWithRetries(args, {
      label,
      sessionId,
      target: "system.event",
      phase,
      onFinalFailure,
    });
  }

  private sendUserNotification(
    session: Session,
    text: string,
    label: string,
    sessionId: string,
    buttons?: Array<Array<{ label: string; callbackData: string }>>,
    onAllFailed?: () => void,
  ): void {
    const route = this.parseNotificationRoute(session);
    if (!route) {
      this.fireSystemEventWithRetry(text, `${label}-notify-system`, sessionId, "notify", onAllFailed);
      return;
    }

    this.fireDirectNotificationWithRetry(route, text, `${label}-notify`, sessionId, buttons, () => {
      this.fireSystemEventWithRetry(text, `${label}-notify-fallback`, sessionId, "notify", onAllFailed);
    });
  }

  /**
   * Dispatch a session notification through one conceptual pipeline.
   *
   * - `userMessage` is the compact chat-facing status update.
   * - `wakeMessage` is the richer orchestrator/system-event payload.
   * - `notifyUser: "on-wake-fallback"` only emits `userMessage` when the wake cannot
   *   be routed directly to the originating orchestrator session.
   */
  dispatchSessionNotification(session: Session, request: SessionNotificationRequest): void {
    const sessionKey = this.getOriginSessionKey(session);
    const notifyUser = request.notifyUser ?? (request.wakeMessage ? "on-wake-fallback" : "always");
    const userMessage = request.userMessage?.trim();
    const wakeMessage = request.wakeMessage?.trim();
    const buttons = request.buttons;

    if (notifyUser === "always" && userMessage) {
      this.sendUserNotification(session, userMessage, request.label, session.id, buttons, request.onUserNotifyFailed);
    }

    if (!wakeMessage) return;

    if (!sessionKey) {
      if (notifyUser === "on-wake-fallback" && userMessage) {
        this.sendUserNotification(session, userMessage, request.label, session.id, buttons, request.onUserNotifyFailed);
      }
      this.fireSystemEventWithRetry(wakeMessage, `${request.label}-wake-system`, session.id, "wake");
      return;
    }

    // Wakes should target the exact origin session, but preserve the original
    // channel route so the orchestrator's reply goes back to the same topic.
    this.fireChatSendWithRetry(sessionKey, wakeMessage, `${request.label}-wake`, session.id, "wake", true, () => {
      // Final fallback: emit a system event so the orchestrator can still recover.
      this.fireSystemEventWithRetry(wakeMessage, `${request.label}-wake-fallback`, session.id, "wake");
    });
  }
}
