import * as childProcess from "child_process";
import { CALLBACK_NAMESPACE } from "./interactive-constants";
import { getPluginRuntime, getRuntimeConfig } from "./runtime-store";
import type { NotificationButton } from "./session-interactions";
import type { NotificationRoute } from "./wake-route-resolver";

const FALLBACK_CLI_TIMEOUT_MS = 5_000;

type RuntimeOutboundAdapter = NonNullable<
  NonNullable<ReturnType<typeof getPluginRuntime>>["channel"]
>["outbound"] extends { loadAdapter?: (...args: any[]) => Promise<infer T> }
  ? NonNullable<T>
  : never;

type ExecFile = typeof childProcess.execFile;

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

export const directNotificationTransportInternals = {
  execFile: childProcess.execFile,
};

class MissingRuntimeDirectNotificationCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingRuntimeDirectNotificationCapabilityError";
  }
}

export class RuntimeDirectNotificationTransport implements DirectNotificationTransport {
  constructor(
    private readonly execFile: ExecFile = directNotificationTransportInternals.execFile,
  ) {}

  async send(
    route: NotificationRoute,
    text: string,
    buttons?: Array<Array<NotificationButton>>,
  ): Promise<void> {
    try {
      await this.sendViaRuntime(route, text, buttons);
      return;
    } catch (err) {
      if (!(err instanceof MissingRuntimeDirectNotificationCapabilityError)) {
        throw err;
      }
      await this.sendViaBoundedCliFallback(route, text, buttons, err.message);
    }
  }

  private async sendViaRuntime(
    route: NotificationRoute,
    text: string,
    buttons?: Array<Array<NotificationButton>>,
  ): Promise<void> {
    const runtime = getPluginRuntime();
    const cfg = getRuntimeConfig();
    const loadAdapter = runtime?.channel?.outbound?.loadAdapter;
    if (!runtime) {
      throw new MissingRuntimeDirectNotificationCapabilityError(
        "OpenClaw plugin runtime is unavailable for direct notification delivery",
      );
    }
    if (cfg == null) {
      throw new MissingRuntimeDirectNotificationCapabilityError(
        "OpenClaw runtime config snapshot is unavailable for direct notification delivery",
      );
    }
    if (!runtime.channel) {
      throw new MissingRuntimeDirectNotificationCapabilityError(
        `OpenClaw plugin runtime channel surface is unavailable for direct notification delivery (runtimeVersion=${formatRuntimeVersion(runtime)})`,
      );
    }
    if (!runtime.channel.outbound) {
      throw new MissingRuntimeDirectNotificationCapabilityError(
        `OpenClaw plugin runtime channel outbound surface is unavailable for direct notification delivery (runtimeVersion=${formatRuntimeVersion(runtime)})`,
      );
    }
    if (!loadAdapter) {
      throw new MissingRuntimeDirectNotificationCapabilityError(
        `OpenClaw plugin runtime channel outbound loadAdapter is unavailable for direct notification delivery (runtimeVersion=${formatRuntimeVersion(runtime)})`,
      );
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

  private sendViaBoundedCliFallback(
    route: NotificationRoute,
    text: string,
    buttons: Array<Array<NotificationButton>> | undefined,
    reason: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = buildDirectNotificationCliArgs(route, text, buttons);
      this.execFile(
        "openclaw",
        args,
        { timeout: FALLBACK_CLI_TIMEOUT_MS, killSignal: "SIGKILL" },
        (err, _stdout, stderr) => {
          if (!err) {
            resolve();
            return;
          }
          const stderrSuffix = stderr?.trim() ? ` | stderr: ${stderr.trim()}` : "";
          reject(
            new Error(
              `${reason}; bounded openclaw message send fallback failed within ${FALLBACK_CLI_TIMEOUT_MS}ms timeout: ${errorMessage(err)}${stderrSuffix}`,
            ),
          );
        },
      );
    });
  }
}

function buildDirectNotificationCliArgs(
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatRuntimeVersion(runtime: unknown): string {
  if (!runtime || typeof runtime !== "object") return "unknown";
  const version = (runtime as { version?: unknown }).version;
  return typeof version === "string" && version.trim() ? version : "unknown";
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
