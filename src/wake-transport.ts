import { randomUUID } from "crypto";
import type { NotificationRoute } from "./wake-route-resolver";
import { CALLBACK_NAMESPACE } from "./interactive-constants";

type NotificationButton = { label: string; callbackData: string };
type DiscordButtonStyle = "primary" | "secondary" | "success" | "danger";
type DiscordComponentMessageSpec = {
  blocks: Array<{
    type: "actions";
    buttons: Array<{
      label: string;
      callbackData: string;
      style: DiscordButtonStyle;
    }>;
  }>;
};
type DiscordComponentSender = (
  to: string,
  spec: DiscordComponentMessageSpec,
  opts?: { accountId?: string },
) => Promise<unknown>;

function getDiscordSdkModuleUrl(): string {
  return process.env.OPENCLAW_CODE_AGENT_DISCORD_SDK_MODULE_URL ?? "openclaw/plugin-sdk/discord";
}

export class WakeTransport {
  private discordComponentSenderPromise: Promise<DiscordComponentSender> | null = null;

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
    buttons?: Array<Array<NotificationButton>>,
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
          callback_data: button.callbackData.startsWith(`${CALLBACK_NAMESPACE}:`)
            ? button.callbackData
            : `${CALLBACK_NAMESPACE}:${button.callbackData}`,
        }))),
      ));
    }
    return args;
  }

  private prefixCallbackData(callbackData: string): string {
    return callbackData.startsWith(`${CALLBACK_NAMESPACE}:`)
      ? callbackData
      : `${CALLBACK_NAMESPACE}:${callbackData}`;
  }

  private resolveDiscordButtonStyle(label: string): DiscordButtonStyle {
    const normalized = label.trim().toLowerCase();
    if (normalized === "approve" || normalized === "open pr") return "primary";
    if (normalized === "merge" || normalized === "resume") return "success";
    if (normalized === "reject" || normalized === "discard") return "danger";
    return "secondary";
  }

  private buildDiscordComponentSpec(buttons: Array<Array<NotificationButton>>): DiscordComponentMessageSpec {
    const blocks: DiscordComponentMessageSpec["blocks"] = [];
    for (const row of buttons) {
      if (!Array.isArray(row) || row.length === 0) continue;
      for (let index = 0; index < row.length; index += 5) {
        const slice = row.slice(index, index + 5);
        blocks.push({
          type: "actions",
          buttons: slice.map((button) => ({
            label: button.label,
            callbackData: this.prefixCallbackData(button.callbackData),
            style: this.resolveDiscordButtonStyle(button.label),
          })),
        });
      }
    }
    return { blocks };
  }

  private resolveDiscordComponentTarget(route: NotificationRoute): string {
    const threadId = route.threadId?.trim();
    return threadId ? `channel:${threadId}` : route.target;
  }

  private async loadDiscordComponentSender(): Promise<DiscordComponentSender> {
    if (!this.discordComponentSenderPromise) {
      this.discordComponentSenderPromise = import(getDiscordSdkModuleUrl())
        .then((mod) => {
          if (typeof mod.sendDiscordComponentMessage !== "function") {
            throw new Error("OpenClaw Discord component sender export is unavailable");
          }
          return mod.sendDiscordComponentMessage as DiscordComponentSender;
        })
        .catch((err) => {
          this.discordComponentSenderPromise = null;
          throw err;
        });
    }
    return this.discordComponentSenderPromise;
  }

  async sendDiscordComponents(
    route: NotificationRoute,
    buttons: Array<Array<NotificationButton>>,
  ): Promise<void> {
    const sendDiscordComponentMessage = await this.loadDiscordComponentSender();
    await sendDiscordComponentMessage(
      this.resolveDiscordComponentTarget(route),
      this.buildDiscordComponentSpec(buttons),
      route.accountId ? { accountId: route.accountId } : undefined,
    );
  }

  buildSystemEventArgs(text: string): string[] {
    return ["system", "event", "--text", text, "--mode", "now"];
  }
}
