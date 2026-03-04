import type { Session } from "./session";

/** Transport callback used to emit chat messages to a channel/thread target. */
export type SendMessageFn = (channelId: string, text: string, threadId?: string | number) => void;

/**
 * NotificationService — delivers notifications via channel messaging.
 *
 * Completion/failure formatting is driven by SessionManager.
 */
export class NotificationService {
  private sendMessage: SendMessageFn;

  constructor(sendMessage: SendMessageFn) {
    this.sendMessage = sendMessage;
  }

  /** Hook called when a session starts. Currently a no-op; notifications are driven by SessionManager. */
  attachToSession(_session: Session): void {}

  stop(): void {
    // No-op — retained for interface compatibility with index.ts lifecycle.
  }

  /** Emit a message to a specific channel. */
  emitToChannel(channelId: string, text: string, threadId?: string | number): void {
    this.sendMessage(channelId, text, threadId);
  }
}

/** Summarize tool input for compact display. */
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";

  const payload = input as Record<string, unknown>;
  if (typeof payload.file_path === "string") return truncate(payload.file_path, 60);
  if (typeof payload.path === "string") return truncate(payload.path, 60);
  if (typeof payload.command === "string") return truncate(payload.command, 80);
  if (typeof payload.pattern === "string") return truncate(payload.pattern, 60);
  if (typeof payload.glob === "string") return truncate(payload.glob, 60);

  const firstValue = Object.values(payload).find((v) => typeof v === "string" && v.length > 0);
  if (firstValue) return truncate(String(firstValue), 60);
  return "";
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}
