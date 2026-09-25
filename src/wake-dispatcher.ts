import type { Session } from "./session";
import type { NotificationButton } from "./session-interactions";
import type { CompletionSummaryFact } from "./completion-summary-coordinator";
import { logButtonDiagnostic, summarizeButtons } from "./button-diagnostics";
import { RuntimeDirectNotificationTransport, type DirectNotificationTransport } from "./direct-notification-transport";
import {
  WakeDeliveryExecutor,
  type DispatchPhase,
  type DispatchSuccessValidationResult,
} from "./wake-delivery-executor";
import { WakeRouteResolver } from "./wake-route-resolver";
import {
  RuntimeSystemEventTransport,
  WakeTransport,
  type SystemEventTransport,
  type WakeTransportOptions,
} from "./wake-transport";
import { createLogger } from "./logger";

const log = createLogger("wake-dispatcher");

export type SessionNotificationPolicy = "always" | "on-wake-fallback" | "never";

export interface SessionNotificationMessage {
  text: string;
  buttons?: Array<Array<NotificationButton>>;
  /** A failure delivering this message makes the whole sequence non-actionable. */
  requiredForSequenceSuccess?: boolean;
}

export interface SessionNotificationRequest {
  label: string;
  userMessage?: string;
  userMessages?: SessionNotificationMessage[];
  wakeMessage?: string;
  wakeMessageOnNotifySuccess?: string;
  wakeMessageOnNotifyFailed?: string;
  /** Whether a failure-report wake proves the preceding user notification was delivered. */
  failureWakeConfirmsNotificationDelivery?: boolean;
  completionSummary?: CompletionSummaryFact;
  completionSummaryOwner?: "wake" | "foreground";
  completionWakeSummaryRequired?: boolean;
  completionWakeOutcomeKey?: string;
  idempotencyKey?: string;
  deferConditionalWakeUntilNextTick?: boolean;
  deferConditionalWakeMs?: number;
  requireDirectUserNotification?: boolean;
  notifyUser?: SessionNotificationPolicy;
  buttons?: Array<Array<NotificationButton>>;
  shouldDispatch?: () => boolean;
  onUserNotifyFailed?: () => void;
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
  directNotifications?: DirectNotificationTransport;
  systemEvents?: SystemEventTransport;
  /**
   * Awaited before a message with buttons is sent, so the action tokens behind
   * the buttons are persisted before a user can press them (a save can be
   * deferred briefly while another writer holds the session-index lock).
   */
  beforeInteractiveSend?: () => Promise<void>;
}

export class WakeDispatcher {
  private readonly routes = new WakeRouteResolver();
  private readonly transport: WakeTransport;
  private readonly directNotifications: DirectNotificationTransport;
  private readonly systemEvents: SystemEventTransport;
  private readonly executor = new WakeDeliveryExecutor();
  private readonly beforeInteractiveSend?: () => Promise<void>;
  private disposed = false;

  constructor(options: WakeDispatcherOptions = {}) {
    this.beforeInteractiveSend = options.beforeInteractiveSend;
    this.transport = options.transport ?? new WakeTransport(options.transportOptions);
    this.directNotifications = options.directNotifications ?? new RuntimeDirectNotificationTransport();
    this.systemEvents = options.systemEvents ?? new RuntimeSystemEventTransport();
  }

  clearPendingRetries(): void {
    this.executor.clearPendingRetries();
  }

  clearRetryTimersForSession(sessionId: string): void {
    this.executor.clearRetryTimersForSession(sessionId);
  }

  dispose(): void {
    this.disposed = true;
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
    buttons?: Array<Array<NotificationButton>>;
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
      this.sendSystemEvent(session, text, {
        label: `${label}-system`,
        phase,
        messageKind: "wake",
        wakeNow: true,
        onSuccess,
        onFinalFailure,
        shouldContinue,
      });
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
          this.sendSystemEvent(session, text, {
            label: `${label}-fallback`,
            phase,
            messageKind: "wake",
            wakeNow: true,
            sessionKey,
            onSuccess,
            onFinalFailure,
            shouldContinue,
          });
        },
      },
    );
  }

  private sendUserNotification(
    session: Session,
    text: string,
    label: string,
    buttons?: Array<Array<NotificationButton>>,
    onAllFailed?: () => void,
    onSuccess?: () => void,
    requireDirectDelivery: boolean = false,
    shouldDispatch?: () => boolean,
    wakeFollows: boolean = false,
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
        log.warn(
          `[WakeDispatcher] Direct notification "${label}" for session ${session.id} ` +
          `has no direct route; reporting delivery failure instead of using system fallback.`,
        );
        onAllFailed?.();
        return;
      }
      if (hasInteractiveButtons) {
        log.warn(
          `[WakeDispatcher] Interactive notification "${label}" for session ${session.id} ` +
          `has no direct route; refusing text-only fallback because buttons would be lost.`,
        );
        onAllFailed?.();
        return;
      }
      this.sendSystemEvent(session, text, {
        label: `${label}-notify-system`,
        phase: "notify",
        messageKind: "notify",
        wakeNow: !wakeFollows,
        buttons,
        orderingKey,
        onSuccess,
        onFinalFailure: onAllFailed,
        shouldContinue: shouldDispatch,
      });
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
        log.warn(
          `[WakeDispatcher] Direct notification "${label}" for session ${session.id} ` +
          `failed direct delivery; reporting delivery failure instead of using system fallback.`,
        );
        onAllFailed?.();
        return;
      }
      if (hasInteractiveButtons) {
        log.warn(
          `[WakeDispatcher] Interactive notification "${label}" for session ${session.id} ` +
          `failed direct delivery; refusing text-only fallback because buttons would be lost.`,
        );
        onAllFailed?.();
        return;
      }
      this.sendSystemEvent(session, text, {
        label: `${label}-notify-fallback`,
        phase: "notify",
        messageKind: "notify",
        wakeNow: !wakeFollows,
        orderingKey,
        onSuccess,
        onFinalFailure: onAllFailed,
        shouldContinue: shouldDispatch,
      });
    };

    // The durable send may still land after the executor's timeout, so an ambiguous
    // result must never start a second (system-event) delivery of the same text.
    const ambiguousHandler = () => {
      logButtonDiagnostic("wake_notify_direct_ambiguous", {
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
      log.warn(
        `[WakeDispatcher] Direct notification "${label}" for session ${session.id} ` +
        `timed out with an unknown outcome; reporting delivery failure without a fallback resend.`,
      );
      onAllFailed?.();
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
      onAmbiguousResult: ambiguousHandler,
      onFinalFailure: directFailureHandler,
      // The host durable queue owns retries for an admitted send; re-sending here
      // could duplicate a notification the queue later delivers.
      terminalOnFailure: true,
      shouldContinue: shouldDispatch,
    } as const;

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
      async () => {
        if (hasInteractiveButtons && this.beforeInteractiveSend) {
          await this.beforeInteractiveSend();
          // The runtime may have stopped (or the prompt been superseded) while
          // the tokens were being persisted: never show buttons that are stale.
          if (this.disposed || shouldDispatch?.() === false) return "skipped" as const;
        }
        await this.directNotifications.send(route, text, buttons);
      },
      options,
    );
  }

  /** The session key of the conversation that owns this OCA session, if known. */
  private originSessionKey(session: Session): string | undefined {
    const candidates = [
      this.routes.resolve(session)?.sessionKey,
      session.originSessionKey,
      session.route?.sessionKey,
    ];
    for (const candidate of candidates) {
      const trimmed = candidate?.trim();
      if (trimmed) return trimmed;
    }
    return undefined;
  }

  private sendSystemEvent(
    session: Session,
    text: string,
    opts: {
      label: string;
      phase: DispatchPhase;
      messageKind: "notify" | "wake";
      /**
       * Request an immediate host heartbeat. Every host heartbeat runs the agent's
       * full heartbeat routine, so a notice skips it when an OCA wake for the same
       * dispatch follows: that `chat.send` turn drains the queued notice.
       */
      wakeNow: boolean;
      sessionKey?: string;
      buttons?: Array<Array<NotificationButton>>;
      orderingKey?: string;
      onSuccess?: () => void;
      onFinalFailure?: () => void;
      shouldContinue?: () => boolean;
    },
  ): void {
    const sessionKey = opts.sessionKey?.trim() || this.originSessionKey(session);
    if (!sessionKey) {
      // Without an origin session there is nowhere safe to deliver the event:
      // the bare `main` alias is rejected on multi-agent hosts and lands in the
      // user's direct-message session on single-agent hosts.
      log.warn(
        `[WakeDispatcher] Dropping system-event fallback "${opts.label}" for session ${session.id}: ` +
        "the session has no origin session key.",
      );
      if (opts.shouldContinue?.() !== false) opts.onFinalFailure?.();
      return;
    }
    const routeSummary = `system:${sessionKey}`;
    this.executor.executePromise(
      () => this.systemEvents.enqueue(text, {
        sessionKey,
        contextKey: `openclaw-code-agent:${session.id}`,
        wakeNow: opts.wakeNow,
      }),
      {
        label: opts.label,
        sessionId: session.id,
        target: "system.event",
        phase: opts.phase,
        routeSummary,
        messageKind: opts.messageKind,
        dispatchContext: this.buildDispatchContext({
          routeSummary,
          text,
          buttons: opts.buttons,
        }),
        orderingKey: opts.orderingKey,
        onSuccess: opts.onSuccess,
        onFinalFailure: opts.onFinalFailure,
        shouldContinue: opts.shouldContinue,
      },
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
    wakeFollows: boolean = false,
  ): void {
    const normalizedMessages = messages
      .map((message) => ({
        text: message.text.trim(),
        buttons: message.buttons,
        requiredForSequenceSuccess: message.requiredForSequenceSuccess,
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
      const failureIsTerminal = index === 0 || message.requiredForSequenceSuccess === true;
      const onFailure = failureIsTerminal ? onAllFailed : onSuccess;
      logButtonDiagnostic("wake_notify_sequence_chunk_selected", {
        sessionId: session.id,
        sessionName: session.name,
        label,
        chunkIndex: index + 1,
        chunkCount: normalizedMessages.length,
        messageTextLength: message.text.length,
        failureHandler: failureIsTerminal ? "sequence-failed" : "partial-success",
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
        wakeFollows,
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
      requiredForSequenceSuccess: message.requiredForSequenceSuccess,
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
          // A system-event fallback counts as notify success, which dispatches the success wake.
          Boolean(wakeOnSuccess),
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
        Boolean(wakeMessage),
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
        true,
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
