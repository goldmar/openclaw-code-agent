import { randomUUID } from "crypto";
import type { NotificationRoute } from "./wake-route-resolver";

export class WakeTransport {
  buildChatSendArgs(sessionKey: string, text: string, deliver: boolean): string[] {
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
    buttons?: Array<Array<{ label: string; callbackData: string }>>,
  ): string[] {
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
      args.push("--buttons", JSON.stringify(
        buttons.map((row) => row.map((button) => ({
          text: button.label,
          callback_data: button.callbackData,
        }))),
      ));
    }
    return args;
  }

  buildSystemEventArgs(text: string): string[] {
    return ["system", "event", "--text", text, "--mode", "now"];
  }
}
