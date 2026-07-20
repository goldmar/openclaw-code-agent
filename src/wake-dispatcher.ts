import type { Session } from "./session";
import type { CompletionSummaryFact } from "./completion-summary-coordinator";
import { logButtonDiagnostic, summarizeButtons } from "./button-diagnostics";
import { RuntimeDirectNotificationTransport, type DirectNotificationTransport } from "./direct-notification-transport";
import {
  WakeDeliveryExecutor,
  type DispatchPhase,
  type DispatchSuccessValidationResult,
} from "./wake-delivery-executor";
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
  completionSummary?: CompletionSummaryFact;
  completionSummaryOwner?: "wake" | "foreground";
  completionWakeSummaryRequired?: boolean;
  completionWakeOutcomeKey?: string;
  idempotencyKey?: string;
  deferConditionalWakeUntilNextTick?: boolean;
  deferConditionalWakeMs?: number;
  requireDirectUserNotification?: boolean;
  notifyUser?: SessionNotificationPolicy;
  buttons?: Array<Array<{ label: string; callbackData: string }>>;
  shouldDispatch?: () => boolean;
  onUserNotifyFailed?: () => void;
  /** Direct, routed fallback used only when a canonical summary wake fails. */
  userMessageOnWakeFailure?: string;
  /** @internal Prevents recursive summary-only normalization. */
  summaryDispatchNormalized?: boolean;
  hooks?: SessionNotificationHooks;
}

export interface SessionNotificationHooks {
  onNotifyStarted?: () => void;
  onNotifySucceeded?: () => void;
  onNotifyFailed?: () => void;
  onWakeStarted?: () => void;
  onWakeSucceeded?: () => void;
  onWakeSkipped?: (reason: string) => void;
  onWakeFailed?: () => void;
  onDuplicateSkipped?: (reason: string) => void;
}

export function validateCompletionFollowupWakeSuccess(stdout: string): DispatchSuccessValidationResult {
  const finalText = extractWakeFinalText(stdout).trim();
  if (!finalText) {
    return { outcome: "failure", reason: "completion follow-up wake produced no final response" };
  }
  if (/^NO_REPLY$/i.test(finalText)) {
    return { outcome: "failure", reason: "completion follow-up wake ended with NO_REPLY" };
  }
  return { outcome: "success" };
}

function extractWakeFinalText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    return extractJsonFinalText(JSON.parse(trimmed)).trim();
  } catch {
    return trimmed;
  }
}

function extractJsonFinalText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractJsonFinalText(item)).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  const directKeys = [
    "final",
    "finalResponse",
    "final_response",
    "assistantFinal",
    "assistant_final",
    "response",
    "text",
    "content",
  ];
  for (const key of directKeys) {
    const direct = record[key];
    if (typeof direct === "string" && direct.trim()) return direct;
  }

  for (const key of ["result", "message", "data"]) {
    const nested = extractJsonFinalText(record[key]);
    if (nested.trim()) return nested;
  }
  return "";
}

export interface WakeDispatcherOptions {
  transport?: WakeTransport;
  transportOptions?: WakeTransportOptions;
  directNotifications?: DirectNotificationTransport | null;
}

export class WakeDispatcher {
  private readonly routes = new WakeRouteResolver();
  private readonly transport: WakeTransport;
  private readonly directNotifications: DirectNotificationTransport | null;
  private readonly executor = new WakeDeliveryExecutor();

  constructor(options: WakeDispatcherOptions = {}) {
    this.transport = options.transport ?? new WakeTransport(options.transportOptions);
    this.directNotifications = options.directNotifications === undefined
      ? new RuntimeDirectNotificationTransport()
      : options.directNotifications;
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
    shouldDispatch?: () => boolean,
    successValidator?: (stdout: string) => DispatchSuccessValidationResult,
    onSkipped?: (reason: string) => void,
    idempotencyKey?: string,
  ): void {
    const route = this.routes.resolve(session);
    const shouldContinue = shouldDispatch;
    if (shouldContinue?.() === false) return;
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
          onSkipped,
          onFinalFailure,
          successValidator,
          shouldContinue,
        },
      );
      return;
    }

    this.executor.execute(
      this.transport.buildChatSendArgs(sessionKey, text, true, idempotencyKey),
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
        onSkipped,
        successValidator,
        shouldContinue,
        onFinalFailure: () => {
          if (shouldContinue?.() === false) return;
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
              onSkipped,
              onFinalFailure,
              successValidator,
              shouldContinue,
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
    requireDirectDelivery: boolean = false,
    shouldDispatch?: () => boolean,
  ): void {
    if (shouldDispatch?.() === false) return;
    const hasInteractiveButtons = Boolean(buttons?.some((row) => Array.isArray(row) && row.length > 0));
    const route = this.routes.resolve(session);
    logButtonDiagnostic("wake_notify_selected", {
      sessionId: session.id,
      sessionName: session.name,
      label,
      messageTextLength: text.length,
      requireDirectDelivery,
      hasDirectNotificationTransport: Boolean(this.directNotifications),
      routeSummary: route ? this.routes.summary(route) : "system",
      channel: route?.channel,
      target: route?.target,
      accountId: route?.accountId,
      threadId: route?.threadId,
      sessionKey: route?.sessionKey,
      ...summarizeButtons(buttons),
    });
    const orderingKey = route
      ? `notify:${route.channel}|${route.accountId ?? ""}|${route.target}|${route.threadId ?? ""}`
      : `notify:system:${session.id}`;
    if (!route) {
      logButtonDiagnostic("wake_notify_no_direct_route", {
        sessionId: session.id,
        sessionName: session.name,
        label,
        requireDirectDelivery,
        hasInteractiveButtons,
        ...summarizeButtons(buttons),
      });
      if (requireDirectDelivery) {
        console.warn(
          `[WakeDispatcher] Direct notification "${label}" for session ${session.id} ` +
          `has no direct route; reporting delivery failure instead of using system fallback.`,
        );
        onAllFailed?.();
        return;
      }
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
          shouldContinue: shouldDispatch,
        },
      );
      return;
    }

    const directFailureHandler = () => {
      logButtonDiagnostic("wake_notify_direct_failed", {
        sessionId: session.id,
        sessionName: session.name,
        label,
        requireDirectDelivery,
        hasInteractiveButtons,
        channel: route.channel,
        target: route.target,
        accountId: route.accountId,
        threadId: route.threadId,
        sessionKey: route.sessionKey,
        ...summarizeButtons(buttons),
      });
      if (requireDirectDelivery) {
        console.warn(
          `[WakeDispatcher] Direct notification "${label}" for session ${session.id} ` +
          `failed direct delivery; reporting delivery failure instead of using system fallback.`,
        );
        onAllFailed?.();
        return;
      }
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
          shouldContinue: shouldDispatch,
        },
      );
    };

    const options = {
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
      onAmbiguousResult: directFailureHandler,
      onFinalFailure: directFailureHandler,
      terminalOnFailure: this.directNotifications ? true : undefined,
      shouldContinue: shouldDispatch,
    } as const;

    if (this.directNotifications) {
      logButtonDiagnostic("wake_notify_dispatching_direct_runtime", {
        sessionId: session.id,
        sessionName: session.name,
        label,
        channel: route.channel,
        target: route.target,
        accountId: route.accountId,
        threadId: route.threadId,
        sessionKey: route.sessionKey,
        ...summarizeButtons(buttons),
      });
      this.executor.executePromise(
        () => this.directNotifications!.send(route, text, buttons),
        options,
      );
      return;
    }

    logButtonDiagnostic("wake_notify_dispatching_cli_message_send", {
      sessionId: session.id,
      sessionName: session.name,
      label,
      channel: route.channel,
      target: route.target,
      accountId: route.accountId,
      threadId: route.threadId,
      sessionKey: route.sessionKey,
      ...summarizeButtons(buttons),
    });
    this.executor.execute(
      this.transport.buildDirectNotificationArgs(route, text, buttons),
      options,
    );
  }

  private sendUserNotificationSequence(
    session: Session,
    messages: SessionNotificationMessage[],
    label: string,
    onAllFailed?: () => void,
    onSuccess?: () => void,
    requireDirectDelivery: boolean = false,
    shouldDispatch?: () => boolean,
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

    logButtonDiagnostic("wake_notify_sequence_started", {
      sessionId: session.id,
      sessionName: session.name,
      label,
      chunkCount: normalizedMessages.length,
      buttonChunkIndexes: normalizedMessages
        .map((message, index) => (
          message.buttons?.some((row) => Array.isArray(row) && row.length > 0) ? index + 1 : undefined
        ))
        .filter((index): index is number => typeof index === "number"),
      requireDirectDelivery,
    });

    const sendAt = (index: number): void => {
      if (shouldDispatch?.() === false) {
        return;
      }
      const message = normalizedMessages[index];
      if (!message) {
        logButtonDiagnostic("wake_notify_sequence_succeeded", {
          sessionId: session.id,
          sessionName: session.name,
          label,
          chunkCount: normalizedMessages.length,
        });
        onSuccess?.();
        return;
      }
      const onFailure = index === 0 ? onAllFailed : onSuccess;
      logButtonDiagnostic("wake_notify_sequence_chunk_selected", {
        sessionId: session.id,
        sessionName: session.name,
        label,
        chunkIndex: index + 1,
        chunkCount: normalizedMessages.length,
        messageTextLength: message.text.length,
        failureHandler: index === 0 ? "all-failed" : "sequence-success",
        ...summarizeButtons(message.buttons),
      });

      this.sendUserNotification(
        session,
        message.text,
        `${label}-part-${index + 1}`,
        message.buttons,
        onFailure,
        () => sendAt(index + 1),
        requireDirectDelivery,
        shouldDispatch,
      );
    };

    sendAt(0);
  }

  dispatchSessionNotification(session: Session, request: SessionNotificationRequest): void {
    if (
      request.summaryDispatchNormalized !== true
      && request.completionSummary?.required === true
      && (request.wakeMessageOnNotifySuccess?.trim() || request.wakeMessage?.trim())
    ) {
      this.dispatchSessionNotification(session, {
        ...request,
        userMessage: undefined,
        userMessages: undefined,
        buttons: undefined,
        notifyUser: "never",
        // No plugin status was sent, so the wake must account for that gap.
        wakeMessage: request.wakeMessageOnNotifyFailed?.trim()
          || request.wakeMessageOnNotifySuccess?.trim()
          || request.wakeMessage?.trim(),
        wakeMessageOnNotifySuccess: undefined,
        wakeMessageOnNotifyFailed: undefined,
        summaryDispatchNormalized: true,
      });
      return;
    }
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
    const wakeMessage = request.wakeMessage?.trim();
    const shouldDispatch = request.shouldDispatch;
    const wakeSuccessValidator = request.completionWakeSummaryRequired === true
      ? validateCompletionFollowupWakeSuccess
      : undefined;

    if (hasConditionalWake) {
      const wakeOnSuccess = request.wakeMessageOnNotifySuccess?.trim();
      const wakeOnFailed = request.wakeMessageOnNotifyFailed?.trim();

      const sendDeferredWake = (wakeText: string): void => {
        if (!wakeText) return;
        if (shouldDispatch?.() === false) return;
        hooks?.onWakeStarted?.();
        this.sendWake(
          session,
          wakeText,
          `${request.label}-wake`,
          "wake",
          hooks?.onWakeFailed,
          hooks?.onWakeSucceeded,
          shouldDispatch,
          wakeSuccessValidator,
          hooks?.onWakeSkipped,
          request.idempotencyKey,
        );
      };
      const dispatchWake = (wakeText: string): void => {
        if (!wakeText) return;
        if (request.deferConditionalWakeUntilNextTick === true || request.deferConditionalWakeMs !== undefined) {
          const delayMs = Math.max(0, Math.floor(request.deferConditionalWakeMs ?? 0));
          setTimeout(() => sendDeferredWake(wakeText), delayMs).unref?.();
          return;
        }
        sendDeferredWake(wakeText);
      };

      const onSuccess = () => {
        if (shouldDispatch?.() === false) return;
        hooks?.onNotifySucceeded?.();
        if (wakeOnSuccess) dispatchWake(wakeOnSuccess);
      };
      const onFailed = wakeOnFailed
        ? () => {
            if (shouldDispatch?.() === false) return;
            hooks?.onNotifyFailed?.();
            request.onUserNotifyFailed?.();
            dispatchWake(wakeOnFailed);
          }
        : () => {
            if (shouldDispatch?.() === false) return;
            hooks?.onNotifyFailed?.();
            request.onUserNotifyFailed?.();
          };

      if (userMessages.length > 0) {
        if (shouldDispatch?.() === false) return;
        hooks?.onNotifyStarted?.();
        this.sendUserNotificationSequence(
          session,
          userMessages,
          request.label,
          onFailed,
          onSuccess,
          request.requireDirectUserNotification === true,
          shouldDispatch,
        );
      } else {
        onFailed();
      }
      return;
    }

    if (notifyUser === "always" && userMessages.length > 0) {
      if (shouldDispatch?.() === false) return;
      hooks?.onNotifyStarted?.();
      this.sendUserNotificationSequence(
        session,
        userMessages,
        request.label,
        () => {
          if (shouldDispatch?.() === false) return;
          hooks?.onNotifyFailed?.();
          request.onUserNotifyFailed?.();
        },
        () => {
          if (shouldDispatch?.() === false) return;
          hooks?.onNotifySucceeded?.();
        },
        request.requireDirectUserNotification === true,
        shouldDispatch,
      );
    }

    if (!wakeMessage) return;
    if (shouldDispatch?.() === false) return;
    hooks?.onWakeStarted?.();

    if (notifyUser === "on-wake-fallback" && userMessages.length > 0 && !this.routes.resolve(session)?.sessionKey) {
      if (shouldDispatch?.() === false) return;
      hooks?.onNotifyStarted?.();
      this.sendUserNotificationSequence(
        session,
        userMessages,
        request.label,
        () => {
          if (shouldDispatch?.() === false) return;
          hooks?.onNotifyFailed?.();
          request.onUserNotifyFailed?.();
        },
        () => {
          if (shouldDispatch?.() === false) return;
          hooks?.onNotifySucceeded?.();
        },
        false,
        shouldDispatch,
      );
    }

    this.sendWake(
      session,
      wakeMessage,
      `${request.label}-wake`,
      "wake",
      hooks?.onWakeFailed,
      hooks?.onWakeSucceeded,
      shouldDispatch,
      wakeSuccessValidator,
      hooks?.onWakeSkipped,
      request.idempotencyKey,
    );
  }
}
