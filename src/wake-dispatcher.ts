import { execFile } from "child_process";
import type { NotificationService } from "./notifications";
import type { Session } from "./session";

const WAKE_CLI_TIMEOUT_MS = 30_000;
const WAKE_RETRY_DELAY_MS = 5_000;

export class WakeDispatcher {
  private notifications: NotificationService | null = null;
  private pendingRetryTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  setNotifications(notifications: NotificationService | null): void {
    this.notifications = notifications;
  }

  clearPendingRetries(): void {
    for (const timer of this.pendingRetryTimers) clearTimeout(timer);
    this.pendingRetryTimers.clear();
  }

  deliverToTelegram(session: Session, text: string): void {
    if (!this.notifications) return;
    this.notifications.emitToChannel(session.originChannel || "unknown", text, session.originThreadId);
  }

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

  fireSystemEventWithRetry(eventText: string, label: string, sessionId: string): void {
    const args = ["system", "event", "--text", eventText, "--mode", "now"];
    execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (err) => {
      if (err) {
        console.error(`[WakeDispatcher] System event failed for ${label} session=${sessionId}: ${err.message}`);
        const timer = setTimeout(() => {
          this.pendingRetryTimers.delete(timer);
          execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (retryErr) => {
            if (retryErr) console.error(`[WakeDispatcher] System event retry also failed for ${label} session=${sessionId}`);
          });
        }, WAKE_RETRY_DELAY_MS);
        this.pendingRetryTimers.add(timer);
      }
    });
  }

  wakeAgent(session: Session, eventText: string, telegramText: string, label: string): void {
    const agentId = session.originAgentId?.trim();

    if (!agentId) {
      this.deliverToTelegram(session, telegramText);
      this.fireSystemEventWithRetry(eventText, label, session.id);
      return;
    }

    if (label === "plan-approval") {
      this.deliverToTelegram(session, telegramText);
    }

    const deliverArgs = this.buildDeliverArgs(session.originChannel, session.originThreadId);
    const args = session.originSessionKey
      ? ["agent", "--agent", agentId, "--session-id", session.originSessionKey, "--message", eventText, ...deliverArgs]
      : ["agent", "--agent", agentId, "--message", eventText, ...deliverArgs];

    if (!session.originSessionKey) {
      console.warn(`[WakeDispatcher] No originSessionKey on session=${session.id} — wake will route to agent ${agentId} default session`);
    }

    execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (err) => {
      if (err) {
        console.error(`[WakeDispatcher] Agent wake failed for ${label} session=${session.id}, agent=${agentId}: ${err.message}`);
        const timer = setTimeout(() => {
          this.pendingRetryTimers.delete(timer);
          execFile("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (retryErr) => {
            if (retryErr) {
              console.error(`[WakeDispatcher] Agent wake retry also failed for ${label} session=${session.id}, agent=${agentId}`);
              this.deliverToTelegram(session, telegramText);
            }
          });
        }, WAKE_RETRY_DELAY_MS);
        this.pendingRetryTimers.add(timer);
      }
    });
  }
}
