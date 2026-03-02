import type { Session } from "./session";

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
export function summarizeToolInput(input: any): string {
  if (!input || typeof input !== "object") return "";
  if (input.file_path) return truncate(input.file_path, 60);
  if (input.path) return truncate(input.path, 60);
  if (input.command) return truncate(input.command, 80);
  if (input.pattern) return truncate(input.pattern, 60);
  if (input.glob) return truncate(input.glob, 60);
  const firstValue = Object.values(input).find((v) => typeof v === "string" && (v as string).length > 0);
  if (firstValue) return truncate(String(firstValue), 60);
  return "";
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}
