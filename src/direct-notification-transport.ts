import { CALLBACK_NAMESPACE } from "./interactive-constants";
import { getPluginRuntime, getRuntimeConfig } from "./runtime-store";
import type { NotificationButton } from "./session-interactions";
import type { NotificationRoute } from "./wake-route-resolver";

type RuntimeOutboundAdapter = NonNullable<
  NonNullable<ReturnType<typeof getPluginRuntime>>["channel"]
>["outbound"] extends { loadAdapter?: (...args: any[]) => Promise<infer T> }
  ? NonNullable<T>
  : never;

type MessagePresentation = {
  blocks: Array<{
    type: "buttons";
    buttons: Array<{
      label: string;
      value: string;
      style?: string;
    }>;
  }>;
};

export interface DirectNotificationTransport {
  send(
    route: NotificationRoute,
    text: string,
    buttons?: Array<Array<NotificationButton>>,
  ): Promise<void>;
}

export class RuntimeDirectNotificationTransport implements DirectNotificationTransport {
  async send(
    route: NotificationRoute,
    text: string,
    buttons?: Array<Array<NotificationButton>>,
  ): Promise<void> {
    const runtime = getPluginRuntime();
    const cfg = getRuntimeConfig();
    const loadAdapter = runtime?.channel?.outbound?.loadAdapter;
    if (!cfg || !loadAdapter) {
      throw new Error("OpenClaw runtime channel outbound adapter is unavailable");
    }

    const adapter = await loadAdapter(route.channel);
    if (!adapter) {
      throw new Error(`OpenClaw outbound adapter for channel "${route.channel}" is unavailable`);
    }

    const presentation = buildPresentation(buttons);
    if (presentation) {
      await this.sendPresentation(adapter, cfg, route, text, presentation);
      return;
    }

    if (!adapter.sendText) {
      throw new Error(`OpenClaw outbound adapter for channel "${route.channel}" cannot send text`);
    }
    await adapter.sendText({
      cfg,
      to: route.target,
      text,
      accountId: route.accountId,
      threadId: route.threadId,
    });
  }

  private async sendPresentation(
    adapter: RuntimeOutboundAdapter,
    cfg: unknown,
    route: NotificationRoute,
    text: string,
    presentation: MessagePresentation,
  ): Promise<void> {
    const basePayload = { text, presentation };
    const ctx = {
      cfg,
      to: route.target,
      text,
      payload: basePayload,
      accountId: route.accountId,
      threadId: route.threadId,
    };
    const renderedPayload = adapter.renderPresentation
      ? await adapter.renderPresentation({
          payload: basePayload,
          presentation,
          ctx,
        })
      : basePayload;

    if (!renderedPayload || typeof renderedPayload !== "object" || !adapter.sendPayload) {
      throw new Error(
        `OpenClaw outbound adapter for channel "${route.channel}" cannot preserve interactive presentation`,
      );
    }

    await adapter.sendPayload({
      ...ctx,
      payload: renderedPayload,
    });
  }
}

export function buildPresentation(
  buttons?: Array<Array<NotificationButton>>,
): MessagePresentation | undefined {
  const blocks = (buttons ?? [])
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => ({
      type: "buttons" as const,
      buttons: row.map((button) => ({
        label: button.label,
        value: prefixCallbackData(button.callbackData),
        ...(button.style ? { style: button.style } : {}),
      })),
    }));
  return blocks.length > 0 ? { blocks } : undefined;
}

function prefixCallbackData(callbackData: string): string {
  return callbackData.startsWith(`${CALLBACK_NAMESPACE}:`)
    ? callbackData
    : `${CALLBACK_NAMESPACE}:${callbackData}`;
}
