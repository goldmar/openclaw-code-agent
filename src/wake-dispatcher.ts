import type { Session } from "./session";
import { WakeDeliveryExecutor, type DispatchPhase } from "./wake-delivery-executor";
import { WakeRouteResolver } from "./wake-route-resolver";
import { WakeTransport } from "./wake-transport";

export type SessionNotificationPolicy = "always" | "on-wake-fallback" | "never";

export interface SessionNotificationRequest {
  label: string;
  userMessage?: string;
  wakeMessage?: string;
  wakeMessageOnNotifySuccess?: string;
  wakeMessageOnNotifyFailed?: string;
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

export class WakeDispatcher {
  private readonly routes = new WakeRouteResolver();
  private readonly transport = new WakeTransport();
  private readonly executor = new WakeDeliveryExecutor();

  clearPendingRetries(): void {
    this.executor.clearPendingRetries();
  }

  clearRetryTimersForSession(sessionId: string): void {
    this.executor.clearRetryTimersForSession(sessionId);
  }

  dispose(): void {
    this.executor.dispose();
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
          onSuccess,
          onFinalFailure,
        },
      );
      return;
    }

    this.executor.execute(
      this.transport.buildChatSendArgs(sessionKey, text, true, route),
      {
        label,
        sessionId: session.id,
        target: "chat.send",
        phase,
        routeSummary: `session:${sessionKey}`,
        messageKind: "wake",
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
              orderingKey,
              onSuccess,
              onFinalFailure: onAllFailed,
            },
          );
        },
      },
    );
  }

  dispatchSessionNotification(session: Session, request: SessionNotificationRequest): void {
    const hooks = request.hooks;
    const hasConditionalWake =
      request.wakeMessageOnNotifySuccess != null || request.wakeMessageOnNotifyFailed != null;
    const notifyUser = request.notifyUser ?? (request.wakeMessage ? "on-wake-fallback" : "always");
    const userMessage = request.userMessage?.trim();
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

      if (userMessage) {
        hooks?.onNotifyStarted?.();
        this.sendUserNotification(session, userMessage, request.label, request.buttons, onFailed, onSuccess);
      } else {
        onFailed();
      }
      return;
    }

    if (notifyUser === "always" && userMessage) {
      hooks?.onNotifyStarted?.();
      this.sendUserNotification(
        session,
        userMessage,
        request.label,
        request.buttons,
        () => {
          hooks?.onNotifyFailed?.();
          request.onUserNotifyFailed?.();
        },
        () => hooks?.onNotifySucceeded?.(),
      );
    }

    if (!wakeMessage) return;
    hooks?.onWakeStarted?.();

    if (notifyUser === "on-wake-fallback" && userMessage && !this.routes.resolve(session)?.sessionKey) {
      hooks?.onNotifyStarted?.();
      this.sendUserNotification(
        session,
        userMessage,
        request.label,
        request.buttons,
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
