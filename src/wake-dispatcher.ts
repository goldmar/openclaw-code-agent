import type { Session } from "./session";
import { WakeDeliveryExecutor, type DispatchPhase } from "./wake-delivery-executor";
import { WakeRouteResolver } from "./wake-route-resolver";
import { WakeTransport, type WakeTransportOptions } from "./wake-transport";

export type SessionNotificationPolicy = "always" | "on-wake-fallback" | "never";

export interface SessionNotificationMessage {
  text: string;
  buttons?: Array<Array<{ label: string; callbackData: string }>>;
}

export interface SessionNotificationRequest {
  label: string;
  userMessage?: string;
  userMessages?: SessionNotificationMessage[];
  wakeMessage?: string;
  wakeMessageOnNotifySuccess?: string;
  wakeMessageOnNotifyFailed?: string;
  completionWakeSummaryRequired?: boolean;
  notifyUser?: SessionNotificationPolicy;
  buttons?: Array<Array<{ label: string; callbackData: string }>>;
  onUserNotifyFailed?: () => void;
  hooks?: SessionNotificationHooks;
}

export interface SessionNotificationHooks {
  onNotifyStarted?: () => void;
  onNotifySucceeded?: () => void;
  onNotifyFailed?: () => void;
  onWakeStarted?: () => void;
  onWakeSucceeded?: () => void;
  onWakeFailed?: () => void;
}

export interface WakeDispatcherOptions {
  transport?: WakeTransport;
  transportOptions?: WakeTransportOptions;
}

export class WakeDispatcher {
  private readonly routes = new WakeRouteResolver();
  private readonly transport: WakeTransport;
  private readonly executor = new WakeDeliveryExecutor();

  constructor(options: WakeDispatcherOptions = {}) {
    this.transport = options.transport ?? new WakeTransport(options.transportOptions);
  }

  clearPendingRetries(): void {
    this.executor.clearPendingRetries();
  }

  clearRetryTimersForSession(sessionId: string): void {
    this.executor.clearRetryTimersForSession(sessionId);
  }

  dispose(): void {
    this.executor.dispose();
  }

  private buildDispatchContext(args: {
    routeSummary: string;
    route?: {
      channel: string;
      target: string;
      accountId?: string;
      threadId?: string;
      sessionKey?: string;
    };
    text: string;
    buttons?: Array<Array<{ label: string; callbackData: string }>>;
  }): Record<string, unknown> {
    const buttons = args.buttons ?? [];
    const flattenedButtons = buttons.flat();
    return {
      transportRoute: args.routeSummary,
      transportChannel: args.route?.channel ?? "system",
      transportTarget: args.route?.target ?? "system",
      transportAccountId: args.route?.accountId,
      transportThreadId: args.route?.threadId,
      transportSessionKey: args.route?.sessionKey,
      messageTextLength: args.text.length,
      buttonsPresent: flattenedButtons.length > 0,
      buttonRows: buttons.length || undefined,
      buttonCount: flattenedButtons.length || undefined,
      buttonLabels: flattenedButtons.length > 0 ? flattenedButtons.map((button) => button.label) : undefined,
      maxCallbackDataLength: flattenedButtons.length > 0
        ? Math.max(...flattenedButtons.map((button) => button.callbackData.length))
        : undefined,
    };
  }

  private sendWake(
    session: Session,
    text: string,
    label: string,
    phase: DispatchPhase,
    onFinalFailure?: () => void,
    onSuccess?: () => void,
  ): void {
    const route = this.routes.resolve(session);
    const sessionKey = route?.sessionKey?.trim();
    if (!sessionKey) {
      this.executor.execute(
        this.transport.buildSystemEventArgs(text),
        {
          label: `${label}-system`,
          sessionId: session.id,
          target: "system.event",
          phase,
          routeSummary: "system",
          messageKind: "wake",
          dispatchContext: this.buildDispatchContext({
            routeSummary: "system",
            text,
          }),
          onSuccess,
          onFinalFailure,
        },
      );
      return;
    }

    this.executor.execute(
      this.transport.buildChatSendArgs(sessionKey, text, true),
      {
        label,
        sessionId: session.id,
        target: "chat.send",
        phase,
        routeSummary: `session:${sessionKey}`,
        messageKind: "wake",
        dispatchContext: this.buildDispatchContext({
          routeSummary: `session:${sessionKey}`,
          route,
          text,
        }),
        onSuccess,
        onFinalFailure: () => {
          this.executor.execute(
            this.transport.buildSystemEventArgs(text),
            {
              label: `${label}-fallback`,
              sessionId: session.id,
              target: "system.event",
              phase,
              routeSummary: "system",
              messageKind: "wake",
              dispatchContext: this.buildDispatchContext({
                routeSummary: "system",
                text,
              }),
              onSuccess,
              onFinalFailure,
            },
          );
        },
      },
    );
  }

  private sendUserNotification(
    session: Session,
    text: string,
    label: string,
    buttons?: Array<Array<{ label: string; callbackData: string }>>,
    onAllFailed?: () => void,
    onSuccess?: () => void,
  ): void {
    const hasInteractiveButtons = Boolean(buttons && buttons.length > 0);
    const route = this.routes.resolve(session);
    const orderingKey = route
      ? `notify:${route.channel}|${route.accountId ?? ""}|${route.target}|${route.threadId ?? ""}`
      : `notify:system:${session.id}`;
    if (!route) {
      if (hasInteractiveButtons) {
        console.warn(
          `[WakeDispatcher] Interactive notification "${label}" for session ${session.id} ` +
          `has no direct route; refusing text-only fallback because buttons would be lost.`,
        );
        onAllFailed?.();
        return;
      }
      this.executor.execute(
        this.transport.buildSystemEventArgs(text),
        {
          label: `${label}-notify-system`,
          sessionId: session.id,
          target: "system.event",
          phase: "notify",
          routeSummary: "system",
          messageKind: "notify",
          dispatchContext: this.buildDispatchContext({
            routeSummary: "system",
            text,
            buttons,
          }),
          orderingKey,
          onSuccess,
          onFinalFailure: onAllFailed,
        },
      );
      return;
    }

    if (hasInteractiveButtons && route.channel === "discord") {
      const sendComponents = (): void => {
        this.executor.executePromise(
          () => this.transport.sendDiscordComponents(route, buttons!),
          {
            label: `${label}-notify-components`,
            sessionId: session.id,
            target: "discord.components",
            phase: "notify",
            routeSummary: this.routes.summary(route),
            messageKind: "notify",
            dispatchContext: this.buildDispatchContext({
              routeSummary: this.routes.summary(route),
              route,
              text,
              buttons,
            }),
            onSuccess,
            onFinalFailure: () => {
              console.warn(
                `[WakeDispatcher] Interactive notification "${label}" for session ${session.id} ` +
                `failed Discord component delivery.`,
              );
              onAllFailed?.();
            },
          },
        );
      };

      if (text) {
        this.executor.execute(
          this.transport.buildDirectNotificationArgs(route, text),
          {
            label: `${label}-notify-text`,
            sessionId: session.id,
            target: "message.send",
            phase: "notify",
            routeSummary: this.routes.summary(route),
            messageKind: "notify",
            dispatchContext: this.buildDispatchContext({
              routeSummary: this.routes.summary(route),
              route,
              text,
              buttons,
            }),
            orderingKey,
            onSuccess: sendComponents,
            onFinalFailure: onAllFailed,
          },
        );
        return;
      }

      sendComponents();
      return;
    }

    this.executor.execute(
      this.transport.buildDirectNotificationArgs(route, text, buttons),
      {
        label: `${label}-notify`,
        sessionId: session.id,
        target: "message.send",
        phase: "notify",
        routeSummary: this.routes.summary(route),
        messageKind: "notify",
        dispatchContext: this.buildDispatchContext({
          routeSummary: this.routes.summary(route),
          route,
          text,
          buttons,
        }),
        orderingKey,
        onSuccess,
        onFinalFailure: () => {
          if (hasInteractiveButtons) {
            console.warn(
              `[WakeDispatcher] Interactive notification "${label}" for session ${session.id} ` +
              `failed direct delivery; refusing text-only fallback because buttons would be lost.`,
            );
            onAllFailed?.();
            return;
          }
          this.executor.execute(
            this.transport.buildSystemEventArgs(text),
            {
              label: `${label}-notify-fallback`,
              sessionId: session.id,
              target: "system.event",
              phase: "notify",
              routeSummary: "system",
              messageKind: "notify",
              dispatchContext: this.buildDispatchContext({
                routeSummary: "system",
                text,
              }),
              orderingKey,
              onSuccess,
              onFinalFailure: onAllFailed,
            },
          );
        },
      },
    );
  }

  private sendUserNotificationSequence(
    session: Session,
    messages: SessionNotificationMessage[],
    label: string,
    onAllFailed?: () => void,
    onSuccess?: () => void,
  ): void {
    const normalizedMessages = messages
      .map((message) => ({
        text: message.text.trim(),
        buttons: message.buttons,
      }))
      .filter((message) => message.text.length > 0);

    if (normalizedMessages.length === 0) {
      onAllFailed?.();
      return;
    }

    const sendAt = (index: number): void => {
      const message = normalizedMessages[index];
      if (!message) {
        onSuccess?.();
        return;
      }
      const onFailure = index === 0 ? onAllFailed : onSuccess;

      this.sendUserNotification(
        session,
        message.text,
        `${label}-part-${index + 1}`,
        message.buttons,
        onFailure,
        () => sendAt(index + 1),
      );
    };

    sendAt(0);
  }

  dispatchSessionNotification(session: Session, request: SessionNotificationRequest): void {
    const hooks = request.hooks;
    const hasConditionalWake =
      request.wakeMessageOnNotifySuccess != null || request.wakeMessageOnNotifyFailed != null;
    const notifyUser = request.notifyUser ?? (request.wakeMessage ? "on-wake-fallback" : "always");
    const userMessages = (request.userMessages?.length
      ? request.userMessages
      : request.userMessage?.trim()
        ? [{ text: request.userMessage.trim(), buttons: request.buttons }]
        : []
    ).map((message) => ({
      text: message.text.trim(),
      buttons: message.buttons,
    })).filter((message) => message.text.length > 0);
    const userMessage = userMessages[0]?.text;
    const wakeMessage = request.wakeMessage?.trim();

    if (hasConditionalWake) {
      const wakeOnSuccess = request.wakeMessageOnNotifySuccess?.trim();
      const wakeOnFailed = request.wakeMessageOnNotifyFailed?.trim();

      const dispatchWake = (wakeText: string): void => {
        if (!wakeText) return;
        hooks?.onWakeStarted?.();
        this.sendWake(
          session,
          wakeText,
          `${request.label}-wake`,
          "wake",
          hooks?.onWakeFailed,
          hooks?.onWakeSucceeded,
        );
      };

      const onSuccess = () => {
        hooks?.onNotifySucceeded?.();
        if (wakeOnSuccess) dispatchWake(wakeOnSuccess);
      };
      const onFailed = wakeOnFailed
        ? () => {
            hooks?.onNotifyFailed?.();
            request.onUserNotifyFailed?.();
            dispatchWake(wakeOnFailed);
          }
        : () => {
            hooks?.onNotifyFailed?.();
            request.onUserNotifyFailed?.();
          };

      if (userMessages.length > 0) {
        hooks?.onNotifyStarted?.();
        this.sendUserNotificationSequence(session, userMessages, request.label, onFailed, onSuccess);
      } else {
        onFailed();
      }
      return;
    }

    if (notifyUser === "always" && userMessages.length > 0) {
      hooks?.onNotifyStarted?.();
      this.sendUserNotificationSequence(
        session,
        userMessages,
        request.label,
        () => {
          hooks?.onNotifyFailed?.();
          request.onUserNotifyFailed?.();
        },
        () => hooks?.onNotifySucceeded?.(),
      );
    }

    if (!wakeMessage) return;
    hooks?.onWakeStarted?.();

    if (notifyUser === "on-wake-fallback" && userMessages.length > 0 && !this.routes.resolve(session)?.sessionKey) {
      hooks?.onNotifyStarted?.();
      this.sendUserNotificationSequence(
        session,
        userMessages,
        request.label,
        () => {
          hooks?.onNotifyFailed?.();
          request.onUserNotifyFailed?.();
        },
        () => hooks?.onNotifySucceeded?.(),
      );
    }

    this.sendWake(
      session,
      wakeMessage,
      `${request.label}-wake`,
      "wake",
      hooks?.onWakeFailed,
      hooks?.onWakeSucceeded,
    );
  }
}
