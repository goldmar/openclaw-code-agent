import { randomUUID } from "crypto";
import type { NotificationRoute } from "./wake-route-resolver";
import type { NotificationButton } from "./session-interactions";
import { buildPresentation } from "./direct-notification-transport";

export interface WakeTransportOptions {}

export class WakeTransport {
  constructor(
    private readonly options: WakeTransportOptions = {},
  ) {}

  buildChatSendArgs(
    sessionKey: string,
    text: string,
    deliver: boolean,
  ): string[] {
    return [
      "gateway",
      "call",
      "chat.send",
      "--expect-final",
      "--timeout",
      "30000",
      "--params",
      JSON.stringify({
        sessionKey,
        message: text,
        deliver,
        idempotencyKey: randomUUID(),
      }),
    ];
  }

  buildDirectNotificationArgs(
    route: NotificationRoute,
    text: string,
    buttons?: Array<Array<NotificationButton>>,
  ): string[] {
    const presentation = buildPresentation(buttons);
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
    if (presentation) {
      args.push("--presentation", JSON.stringify(presentation));
    }
    return args;
  }

  buildSystemEventArgs(text: string): string[] {
    return ["system", "event", "--text", text, "--mode", "now"];
  }
}
