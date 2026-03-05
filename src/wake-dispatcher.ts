import { execFile } from "child_process";
import { randomUUID } from "crypto";
import type { NotificationService } from "./notifications";
import type { Session } from "./session";

const WAKE_CLI_TIMEOUT_MS = 30_000;
const WAKE_RETRY_BASE_DELAY_MS = 2_000;
const WAKE_RETRY_MAX_DELAY_MS = 20_000;
const WAKE_MAX_ATTEMPTS = 4; // initial try + 3 retries

export class WakeDispatcher {
  private notifications: NotificationService | null = null;
  private pendingRetryTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  /** Inject notification transport used for direct user-channel fallbacks. */
  setNotifications(notifications: NotificationService | null): void {
    this.notifications = notifications;
  }

  /** Cancel any scheduled retry timers (called during service shutdown). */
  clearPendingRetries(): void {
    for (const timer of this.pendingRetryTimers) clearTimeout(timer);
    this.pendingRetryTimers.clear();
  }

  /** Send a direct message to the originating channel/thread, if available. */
  deliverToTelegram(session: Session, text: string): void {
    if (!this.notifications) return;
    this.notifications.emitToChannel(session.originChannel || "unknown", text, session.originThreadId);
  }

  /** Build `openclaw agent --deliver` routing args from origin channel metadata. */
  buildDeliverArgs(originChannel?: string, threadId?: string | number): string[] {
    if (!originChannel || originChannel === "unknown" || originChannel === "gateway") return [];
    const parts = originChannel.split("|");
    if (parts.length < 2) return [];

    const args: string[] = [];
    const topicSuffix = (threadId != null && parts[0] === "telegram") ? `:topic:${threadId}` : "";
    if (parts.length >= 3) {
      args.push("--deliver", "--reply-channel", parts[0], "--reply-account", parts[1], "--reply-to", parts.slice(2).join("|") + topicSuffix);
    } else {
      args.push("--deliver", "--reply-channel", parts[0], "--reply-to", parts[1] + topicSuffix);
    }
    return args;
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
      target: "chat" | "system";
      onFinalFailure?: () => void;
    },
    attempt: number = 1,
  ): void {
    execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (err) => {
      if (!err) return;

      if (attempt >= WAKE_MAX_ATTEMPTS) {
        console.error(
          `[WakeDispatcher] ${opts.target} wake failed after ${attempt} attempts for ${opts.label} session=${opts.sessionId}: ${err.message}`,
        );
        opts.onFinalFailure?.();
        return;
      }

      const delay = this.retryDelayMs(attempt);
      console.error(
        `[WakeDispatcher] ${opts.target} wake failed attempt ${attempt}/${WAKE_MAX_ATTEMPTS} for ${opts.label} session=${opts.sessionId}: ${err.message}. Retrying in ${delay}ms`,
      );
      const timer = setTimeout(() => {
        this.pendingRetryTimers.delete(timer);
        this.executeWithRetries(args, opts, attempt + 1);
      }, delay);
      this.pendingRetryTimers.add(timer);
    });
  }

  /** Fire `openclaw gateway call chat.send` for a specific topic/session key with bounded retries. */
  fireChatSendWithRetry(
    sessionKey: string,
    eventText: string,
    label: string,
    sessionId: string,
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
        message: eventText,
        idempotencyKey: randomUUID(),
      }),
    ];
    this.executeWithRetries(args, {
      label,
      sessionId,
      target: "chat",
      onFinalFailure,
    });
  }

  /** Fire `openclaw system event` with bounded retries. */
  fireSystemEventWithRetry(eventText: string, label: string, sessionId: string): void {
    const args = ["system", "event", "--text", eventText, "--mode", "now"];
    this.executeWithRetries(args, {
      label,
      sessionId,
      target: "system",
    });
  }

  /**
   * Wake the originating orchestrator agent with context.
   * Falls back to direct channel delivery + system event when wake metadata is missing.
   */
  wakeAgent(session: Session, eventText: string, telegramText: string, label: string): void {
    const agentId = session.originAgentId?.trim();
    const sessionKey = session.originSessionKey?.trim();

    // Always notify via Telegram for plan-approval or missing wake metadata.
    if (!agentId || !sessionKey || label === "plan-approval") {
      this.deliverToTelegram(session, telegramText);
    }

    if (!agentId || !sessionKey) {
      this.fireSystemEventWithRetry(eventText, label, session.id);
      return;
    }

    // Route wake via gateway chat.send so the originating topic-scoped session is targeted exactly.
    this.fireChatSendWithRetry(sessionKey, eventText, label, session.id, () => {
      // Final fallback: notify user directly and emit a system event so the orchestrator can still recover.
      this.deliverToTelegram(session, telegramText);
      this.fireSystemEventWithRetry(eventText, `${label}-fallback`, session.id);
    });
  }
}
