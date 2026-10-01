import * as childProcess from "child_process";
import { logButtonDiagnostic, summarizeButtons, summarizePresentation } from "./button-diagnostics";
import { isInternalChatProvider } from "./session-route";
import { CALLBACK_NAMESPACE } from "./interactive-constants";
import { getRuntimeConfig } from "./runtime-store";
import type { NotificationButton } from "./session-interactions";
import type { NotificationRoute } from "./wake-route-resolver";

type ChannelOutboundModule = typeof import("openclaw/plugin-sdk/channel-outbound");
type SendDurableMessageBatch = ChannelOutboundModule["sendDurableMessageBatch"];
type DurableSendParams = Parameters<SendDurableMessageBatch>[0];
export type DurableMessageBatchSendResult = Awaited<ReturnType<SendDurableMessageBatch>>;

export type MessagePresentation = NonNullable<DurableSendParams["payloads"][number]["presentation"]>;

export interface DirectNotificationTransport {
  send(
    route: NotificationRoute,
    text: string,
    buttons?: Array<Array<NotificationButton>>,
    options?: { onDeliveryIntent?: () => void },
  ): Promise<void>;
}

export class DirectNotificationDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DirectNotificationDeliveryError";
  }
}

async function loadSendDurableMessageBatch(): Promise<SendDurableMessageBatch> {
  // Lazy: keeps plugin registration from loading the host's outbound runtime.
  const mod: ChannelOutboundModule = await import("openclaw/plugin-sdk/channel-outbound");
  return mod.sendDurableMessageBatch;
}

/**
 * The host outbound boundary. Full-stack tests point it at a fake host's
 * `sendDurableMessageBatch`, as `wakeDeliveryExecutorInternals.execFile` is for
 * the `openclaw` CLI.
 */
export const directNotificationTransportInternals = {
  loadSendDurableMessageBatch,
  execFile: childProcess.execFile,
};

const CHAT_INJECT_TIMEOUT_MS = 30_000;

/**
 * Append a notice to an internal chat (WebChat: Control UI and native apps)
 * with `openclaw gateway call chat.inject`, which writes an assistant note to
 * the session transcript and broadcasts it to connected clients without an
 * agent run. It is a CLI subprocess for the same reason `chat.send` wakes are:
 * the in-process gateway request surface is reserved for trusted plugins.
 * Buttons have no rendering there, so the text is sent alone.
 */
async function injectIntoInternalChat(route: NotificationRoute, text: string): Promise<void> {
  const sessionKey = (route.sessionKey?.trim() || route.target).trim();
  const args = [
    "gateway",
    "call",
    "chat.inject",
    "--timeout",
    String(CHAT_INJECT_TIMEOUT_MS),
    "--params",
    JSON.stringify({ sessionKey, message: text }),
  ];
  await new Promise<void>((resolve, reject) => {
    directNotificationTransportInternals.execFile(
      "openclaw",
      args,
      { timeout: CHAT_INJECT_TIMEOUT_MS + 5_000, killSignal: "SIGKILL" },
      (err, _stdout, stderr) => {
        if (!err) return resolve();
        const detail = String(stderr || "").trim() || errorMessage(err);
        reject(new DirectNotificationDeliveryError(
          `OpenClaw chat.inject into ${sessionKey} failed: ${detail.slice(0, 300)}`,
          { cause: err },
        ));
      },
    );
  });
}

/**
 * Direct user notifications through the host's durable outbound queue
 * (`openclaw/plugin-sdk/channel-outbound` `sendDurableMessageBatch`).
 *
 * Core owns presentation rendering (Telegram inline keyboards, Discord
 * components), delivery-queue persistence, crash recovery, and retry of an
 * admitted send. OCA therefore sends each notification exactly once: an
 * admitted-but-failed send is not re-sent through another path.
 */
export class RuntimeDirectNotificationTransport implements DirectNotificationTransport {
  constructor(
    private readonly loadSender: () => Promise<SendDurableMessageBatch> = () => directNotificationTransportInternals.loadSendDurableMessageBatch(),
  ) {}

  async send(
    route: NotificationRoute,
    text: string,
    buttons?: Array<Array<NotificationButton>>,
    options?: { onDeliveryIntent?: () => void },
  ): Promise<void> {
    const presentation = buildPresentation(buttons);
    logButtonDiagnostic("direct_send_started", {
      ...summarizeRoute(route),
      messageTextLength: text.length,
      ...summarizeButtons(buttons),
      ...(presentation ? summarizePresentation(presentation) : {}),
    });
    if (isInternalChatProvider(route.channel)) {
      try {
        await injectIntoInternalChat(route, text);
      } catch (err) {
        logButtonDiagnostic("direct_send_failed", { ...summarizeRoute(route), ...summarizeButtons(buttons), error: errorMessage(err) });
        throw err;
      }
      logButtonDiagnostic("direct_send_succeeded", { ...summarizeRoute(route), ...summarizeButtons(buttons), transport: "chat.inject" });
      return;
    }
    const cfg = getRuntimeConfig();
    if (cfg == null) {
      throw new DirectNotificationDeliveryError(
        "OpenClaw runtime config snapshot is unavailable for direct notification delivery",
      );
    }

    let result: DurableMessageBatchSendResult;
    try {
      const sendDurableMessageBatch = await this.loadSender();
      result = await sendDurableMessageBatch({
        cfg: cfg as DurableSendParams["cfg"],
        channel: route.channel,
        to: route.target,
        ...(route.accountId ? { accountId: route.accountId } : {}),
        ...(route.threadId ? { threadId: route.threadId } : {}),
        payloads: [presentation ? { text, presentation } : { text }],
        durability: "required",
        ...(options?.onDeliveryIntent ? { onDeliveryIntent: options.onDeliveryIntent } : {}),
      });
    } catch (err) {
      logButtonDiagnostic("direct_send_failed", {
        ...summarizeRoute(route),
        ...summarizeButtons(buttons),
        error: errorMessage(err),
      });
      throw err;
    }

    const outcome = classifyDurableSendResult(result);
    logButtonDiagnostic(outcome.delivered ? "direct_send_succeeded" : "direct_send_failed", {
      ...summarizeRoute(route),
      ...summarizeButtons(buttons),
      durableStatus: result.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    });
    if (!outcome.delivered) {
      throw new DirectNotificationDeliveryError(
        `OpenClaw durable delivery to ${route.channel} failed: ${outcome.reason ?? result.status}`,
        { cause: result.status === "failed" ? result.error : undefined },
      );
    }
  }
}

/**
 * `sent`/`partial_failed` reached the recipient; `suppressed` is an intentional
 * host/hook omission and must not be re-sent. Only `failed` reports failure.
 */
export function classifyDurableSendResult(result: DurableMessageBatchSendResult): {
  delivered: boolean;
  reason?: string;
} {
  if (result.status === "sent") return { delivered: true };
  if (result.status === "partial_failed") return { delivered: true, reason: `partial: ${errorMessage(result.error)}` };
  if (result.status === "suppressed") return { delivered: true, reason: `suppressed: ${result.reason}` };
  const stage = result.stage ? ` (${result.stage})` : "";
  return { delivered: false, reason: `${errorMessage(result.error)}${stage}` };
}

function summarizeRoute(route: NotificationRoute): Record<string, unknown> {
  return {
    channel: route.channel,
    target: route.target,
    accountId: route.accountId,
    threadId: route.threadId,
    sessionKey: route.sessionKey,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function buildPresentation(
  buttons?: Array<Array<NotificationButton>>,
): MessagePresentation | undefined {
  const blocks = (buttons ?? [])
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => ({
      type: "buttons" as const,
      buttons: row.map((button) => button.url
        ? { label: button.label, action: { type: "url" as const, url: button.url } }
        : {
            label: button.label,
            value: prefixCallbackData(button.callbackData),
            ...(button.style ? { style: button.style } : {}),
          }),
    }));
  return blocks.length > 0 ? { blocks } : undefined;
}

function prefixCallbackData(callbackData: string): string {
  return callbackData.startsWith(`${CALLBACK_NAMESPACE}:`)
    ? callbackData
    : `${CALLBACK_NAMESPACE}:${callbackData}`;
}
