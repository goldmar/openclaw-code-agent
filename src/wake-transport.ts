import { randomUUID } from "crypto";
import type { NotificationRoute } from "./wake-route-resolver";
import { CALLBACK_NAMESPACE } from "./interactive-constants";
import type { NotificationButton } from "./session-interactions";

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
    const presentationBlocks = (buttons ?? [])
      .filter((row) => Array.isArray(row) && row.length > 0)
      .map((row) => ({
        type: "buttons",
        buttons: row.map((button) => ({
          label: button.label,
          value: this.prefixCallbackData(button.callbackData),
          ...(button.style ? { style: button.style } : {}),
        })),
      }));
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
    if (presentationBlocks.length > 0) {
      args.push("--presentation", JSON.stringify({
        blocks: presentationBlocks,
      }));
    }
    return args;
  }

  private prefixCallbackData(callbackData: string): string {
    return callbackData.startsWith(`${CALLBACK_NAMESPACE}:`)
      ? callbackData
      : `${CALLBACK_NAMESPACE}:${callbackData}`;
  }

  buildSystemEventArgs(text: string): string[] {
    return ["system", "event", "--text", text, "--mode", "now"];
  }
}
