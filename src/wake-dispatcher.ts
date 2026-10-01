import { randomUUID } from "crypto";
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
import { WakeRouteResolver, type NotificationRoute } from "./wake-route-resolver";
import { ROUTED_REPLY_RULE } from "./session-route";
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
  /**
   * How `wakeMessage` and `wakeMessageOnNotifySuccess` reach the orchestrator.
   * "now" (default) runs an orchestrator turn (`chat.send`). "next-turn" only
   * queues the text as a system event on the origin session, without a
   * heartbeat: the host prepends it to that session's next turn (for example
   * the user's reply). Use it for context the orchestrator needs later but
   * must not act on now. A wake for a failed user notification always runs now.
   */
  wakeDelivery?: "now" | "next-turn";
  /** Whether a failure-report wake proves the preceding user notification was delivered. */
  failureWakeConfirmsNotificationDelivery?: boolean;
  completionSummary?: CompletionSummaryFact;
  completionSummaryOwner?: "wake" | "foreground";
  completionWakeSummaryRequired?: boolean;
  completionWakeOutcomeKey?: string;
  idempotencyKey?: string;
  /** Reobserve an admitted completion wake instead of submitting another turn. */
  admittedWakeRunId?: string;
  admittedWakeRoutedReply?: boolean;
  /** Retry this identity only when the durable journal proves no CLI submission occurred. */
  retryUnsubmittedWake?: boolean;
  deferConditionalWakeUntilNextTick?: boolean;
  deferConditionalWakeMs?: number;
  /** Delay an immediate `wakeMessage` (conditional wakes use `deferConditionalWakeMs`). */
  deferWakeMs?: number;
  /** Checked when a wake is about to be sent: a reason skips it (`onWakeSkipped`). */
  skipDeferredWake?: () => string | undefined;
  requireDirectUserNotification?: boolean;
  notifyUser?: SessionNotificationPolicy;
  buttons?: Array<Array<NotificationButton>>;
  shouldDispatch?: () => boolean;
  onUserNotifyFailed?: () => void;
  hooks?: SessionNotificationHooks;
}

export interface SessionNotificationHooks {
  onNotifyStarted?: () => void;
  /** Host durable queue accepted the send intent; its retries now own delivery. */
  onNotifyAdmitted?: () => void;
  onNotifySucceeded?: () => void;
  /** The send may still land; do not start a second delivery. */
  onNotifyAmbiguous?: () => void;
  onNotifyFailed?: () => void;
  onWakeStarted?: () => void;
  /** Retain the submitted run identity before transport; an acknowledgement can be lost. */
  onWakeAdmitted?: (runId: string, routedReply?: boolean, wakeMessage?: string) => void | Promise<void>;
  onWakeAdmissionRejected?: (runId: string) => void;
  onWakeAmbiguous?: (reason: string) => void;
  onWakeSucceeded?: () => void;
  onWakeSkipped?: (reason: string) => void;
  onWakeFailed?: () => void;
  onDuplicateSkipped?: (reason: string) => void;
}

/**
 * Validate the pinned host's agent.wait result, never its chat.send admission
 * acknowledgement. Routed replies require the host's final source-send receipt;
 * NO_REPLY or private assistant text alone does not establish delivery.
 */
export function validateCompletionFollowupWakeSuccess(
  stdout: string,
  routedReply: boolean = true,
  expectedRunId?: string,
): DispatchSuccessValidationResult {
  const result = parseWakeResult(stdout);
  if (!result || typeof result.runId !== "string" || !result.runId.trim()
    || (expectedRunId !== undefined && result.runId !== expectedRunId)
    || !["ok", "error", "timeout"].includes(String(result.status))) {
    return { outcome: "ambiguous", reason: "completion wake has no matching terminal run result" };
  }
  const receipt = asRecord(result.terminalReceipt);
  if (routedReply && receipt?.runId === result.runId && receipt.sourceReplyDelivered === true) {
    return { outcome: "success" };
  }
  const reply = asRecord(result.terminalReply);
  if (!routedReply && result.status === "ok" && result.yielded !== true
    && reply?.disposition === "visible" && typeof reply.text === "string"
    && reply.text.trim() && !/^NO_REPLY$/i.test(reply.text.trim())) {
    return { outcome: "success" };
  }
  return { outcome: "ambiguous", reason: "completion wake has no confirmed visible summary delivery" };
}

function parseWakeResult(stdout: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(stdout));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
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
  /**
   * Called with the action-token ids behind a message's buttons and the chat
   * the message is sent to, before the tokens are persisted, so each token is
   * bound to that chat (N2: callbacks from any other chat are refused).
   */
  bindInteractiveButtons?: (tokenIds: string[], route: NotificationRoute) => void;
}

export class WakeDispatcher {
  private readonly routes = new WakeRouteResolver();
  private readonly transport: WakeTransport;
  private readonly directNotifications: DirectNotificationTransport;
  private readonly systemEvents: SystemEventTransport;
  private readonly executor = new WakeDeliveryExecutor();
  private readonly beforeInteractiveSend?: () => Promise<void>;
  private readonly bindInteractiveButtons?: (tokenIds: string[], route: NotificationRoute) => void;
  private disposed = false;
  private stopping = false;
  private readonly deferredWakes = new Set<{ send: () => void; timer: ReturnType<typeof setTimeout> | undefined }>();

  constructor(options: WakeDispatcherOptions = {}) {
    this.beforeInteractiveSend = options.beforeInteractiveSend;
    this.bindInteractiveButtons = options.bindInteractiveButtons;
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

  /**
   * Run a held wake after `delayMs`. On dispose (a Gateway stop or plugin
   * restart) held wakes are sent at once instead of being dropped: the timer
   * would otherwise lose them, since no pending wake is persisted.
   */
  private deferWake(send: () => void, delayMs: number): void {
    const entry = { send, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    entry.timer = setTimeout(() => {
      this.deferredWakes.delete(entry);
      if (!this.disposed) send();
    }, delayMs);
    entry.timer.unref?.();
    this.deferredWakes.add(entry);
  }

  dispose(): void {
    // Held wakes go out now, through the in-process system-event queue: a CLI
    // `chat.send` against a stopping Gateway could fail with no retry left.
    this.stopping = true;
    for (const entry of this.deferredWakes) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.send();
    }
    this.deferredWakes.clear();
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
    wakeHooks?: Pick<SessionNotificationHooks, "onWakeAdmitted" | "onWakeAmbiguous" | "onWakeAdmissionRejected">,
    admittedWakeRunId?: string,
    admittedWakeRoutedReply?: boolean,
    retryUnsubmittedWake: boolean = false,
  ): void {
    const route = this.routes.resolve(session);
    const routedReply = admittedWakeRoutedReply
      ?? (Boolean(route && route.channel !== "webchat") || text.includes(ROUTED_REPLY_RULE));
    const shouldContinue = shouldDispatch;
    if (shouldContinue?.() === false) return;
    const onAmbiguous = (reason: string): void => {
      log.warn(`[WakeDispatcher] Wake "${label}" has an unconfirmed delivery outcome; preserving the pending summary without a fallback resend.`);
      wakeHooks?.onWakeAmbiguous?.(reason);
    };
    const observeRun = async (runId: string): Promise<DispatchSuccessValidationResult> => {
      try {
        for (let observation = 0; observation < 3; observation += 1) {
          if (this.disposed || this.stopping || shouldContinue?.() === false) {
            return { outcome: "ambiguous", reason: "completion wake observation interrupted" };
          }
          const stdout = await this.executor.request(this.transport.buildAgentWaitArgs(runId));
          const validation = validateCompletionFollowupWakeSuccess(stdout, routedReply, runId);
          const result = parseWakeResult(stdout);
          if (validation.outcome === "success" || !result
            || !["timeout", "pending"].includes(String(result.status)) || observation === 2) {
            return validation;
          }
          // Queued turns can return pending immediately. Bound observation and
          // use the owned timer set so Gateway stop interrupts the wait.
          await new Promise<void>((resolve) => this.deferWake(resolve, 2000));
        }
        return { outcome: "ambiguous", reason: "completion wake terminal observation timed out" };
      } catch {
        return { outcome: "ambiguous", reason: "completion wake terminal observation failed" };
      }
    };
    const observeOnly = Boolean(admittedWakeRunId && !retryUnsubmittedWake);
    if (observeOnly && this.stopping) {
      onAmbiguous("gateway stopped while an admitted completion wake was pending");
      return;
    }
    const sessionKey = route?.sessionKey?.trim();
    if ((!sessionKey || this.stopping) && !observeOnly) {
      if (admittedWakeRunId) {
        wakeHooks?.onWakeAdmissionRejected?.(admittedWakeRunId);
        onAmbiguous("gateway unavailable before the retained wake could be submitted");
        return;
      }
      this.sendSystemEvent(session, text, {
        label: `${label}-${sessionKey ? "on-stop" : "system"}`,
        phase,
        messageKind: "wake",
        wakeNow: true,
        sessionKey,
        onSuccess: successValidator
          ? () => onAmbiguous("system wake queued without terminal delivery proof")
          : onSuccess,
        onFinalFailure,
        shouldContinue,
      });
      return;
    }

    let ambiguityReason = "wake delivery remains unconfirmed";
    const submittedRunId = admittedWakeRunId ?? idempotencyKey ?? randomUUID();
    const explicitOrigin = !observeOnly && route && (route.channel === "webchat" || text.includes(ROUTED_REPLY_RULE))
      ? route : undefined;
    // WebChat final events are visible internally without automatic channel
    // delivery. Explicit deliver=true would switch the host out of its internal
    // source policy and could require an external message-tool reply.
    const deliver = route?.channel !== "webchat" && !text.includes(ROUTED_REPLY_RULE);
    const args = observeOnly
      ? this.transport.buildAgentWaitArgs(admittedWakeRunId!)
      : this.transport.buildChatSendArgs(sessionKey!, text, deliver, submittedRunId,
        explicitOrigin);
    const dispatch = (): void => this.executor.execute(
      // Routed external wakes send with the message tool; WebChat keeps the
      // host's internal final-event path. Both suppress automatic channel delivery.
      args,
      {
        label,
        sessionId: session.id,
        target: "chat.send",
        phase,
        routeSummary: `session:${sessionKey}`,
        messageKind: "wake",
        ...(explicitOrigin ? {
          gatewayRpc: {
            method: "chat.send" as const,
            params: this.transport.buildChatSendParams(sessionKey!, text, deliver, submittedRunId, explicitOrigin),
          },
        } : {}),
        dispatchContext: this.buildDispatchContext({
          routeSummary: `session:${sessionKey}`,
          route,
          text,
        }),
        onSuccess,
        onSkipped,
        successValidator: observeOnly
          ? async (stdout) => {
            const validation = validateCompletionFollowupWakeSuccess(stdout, routedReply, submittedRunId);
            const result = parseWakeResult(stdout);
            return validation.outcome !== "success" && result
              && ["timeout", "pending"].includes(String(result.status))
              ? observeRun(submittedRunId) : validation;
          }
          : async (stdout) => {
            const acknowledgement = parseWakeResult(stdout);
            if (!acknowledgement || typeof acknowledgement.runId !== "string"
              || !acknowledgement.runId.trim()
              || acknowledgement.runId !== submittedRunId
              || !["started", "in_flight", "queued", "ok", "accepted"].includes(String(acknowledgement.status))) {
              return { outcome: "ambiguous", reason: "wake admission could not be confirmed" };
            }
            if (!successValidator) return { outcome: "success" };
            const observation = await observeRun(acknowledgement.runId);
            if (observation.outcome === "ambiguous") {
              // Keep the reason available to the caller's persistence boundary.
              ambiguityReason = observation.reason;
            }
            return observation;
          },
        onAmbiguousResult: () => onAmbiguous(ambiguityReason),
        ...(!observeOnly ? {
          onAdmissionRejected: () => wakeHooks?.onWakeAdmissionRejected?.(submittedRunId),
        } : {}),
        shouldContinue,
        onFinalFailure: () => {
          if (shouldContinue?.() === false) return;
          if (observeOnly) {
            onAmbiguous("admitted completion wake could not be observed");
            return;
          }
          if (successValidator) {
            // Keep the proven-unsubmitted journal retryable. A heartbeat would
            // create an untracked run that could deliver before that retry.
            onAmbiguous("completion wake was rejected before admission");
            return;
          }
          this.sendSystemEvent(session, text, {
            label: `${label}-fallback`,
            phase,
            messageKind: "wake",
            wakeNow: true,
            sessionKey,
            onSuccess: successValidator
              ? () => onAmbiguous("system wake queued without terminal delivery proof")
              : onSuccess,
            onFinalFailure,
            shouldContinue,
          });
        },
      },
    );
    if (observeOnly) {
      dispatch();
      return;
    }
    // The host uses idempotencyKey as runId. Retain it before submission so
    // a lost acknowledgement or process restart never creates a fresh turn.
    void Promise.resolve().then(() => wakeHooks?.onWakeAdmitted?.(submittedRunId, routedReply, text)).then(
      () => {
        if (this.disposed || this.stopping || shouldContinue?.() === false) {
          wakeHooks?.onWakeAdmissionRejected?.(submittedRunId);
          onAmbiguous("gateway stopped before the retained wake could be submitted");
          return;
        }
        try {
          dispatch();
        } catch {
          // An executor exception does not prove where submission stopped.
          // Keep the durable identity unknown, never safely retryable.
          onAmbiguous("wake submission could not be confirmed");
        }
      },
      () => {
        // No transport was attempted: this identity can safely be retried once
        // its journal becomes writable, rather than observing a nonexistent run.
        wakeHooks?.onWakeAdmissionRejected?.(submittedRunId);
        onAmbiguous("wake run identity could not be retained before submission");
      },
    ).catch(() => {
      log.warn(`[WakeDispatcher] Wake "${label}" could not update its retained delivery state.`);
    });
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
    onAdmitted?: () => void,
    onAmbiguous?: () => void,
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

    let durableIntentRecorded = false;
    const directFailureHandler = () => {
      if (durableIntentRecorded) {
        ambiguousHandler();
        return;
      }
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
        `has an unknown delivery outcome; suppressing a fallback resend.`,
      );
      if (onAmbiguous) onAmbiguous();
      else onAllFailed?.();
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
    if (hasInteractiveButtons && this.bindInteractiveButtons) {
      const tokenIds = (buttons ?? []).flat().map((button) => button.callbackData).filter(Boolean);
      this.bindInteractiveButtons(tokenIds, route);
    }
    this.executor.executePromise(
      async () => {
        if (hasInteractiveButtons && this.beforeInteractiveSend) {
          await this.beforeInteractiveSend();
          // The runtime may have stopped (or the prompt been superseded) while
          // the tokens were being persisted: never show buttons that are stale.
          if (this.disposed || shouldDispatch?.() === false) return "skipped" as const;
        }
        await this.directNotifications.send(route, text, buttons, {
          onDeliveryIntent: () => {
            durableIntentRecorded = true;
            onAdmitted?.();
          },
        });
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

  /** Queue orchestrator context for its next turn (a system event without a heartbeat). */
  private queueForNextTurn(
    session: Session,
    text: string,
    label: string,
    hooks: SessionNotificationHooks | undefined,
    shouldContinue?: () => boolean,
  ): void {
    this.sendSystemEvent(session, text, {
      label: `${label}-queued`,
      phase: "wake",
      messageKind: "wake",
      wakeNow: false,
      onSuccess: hooks?.onWakeSucceeded,
      onFinalFailure: hooks?.onWakeFailed,
      shouldContinue,
    });
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
    onAdmitted?: () => void,
    onAmbiguous?: () => void,
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
        onAdmitted,
        onAmbiguous,
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
    const wakeSuccessValidatorFor = (wakeText: string) => request.completionWakeSummaryRequired === true
      ? (stdout: string) => validateCompletionFollowupWakeSuccess(stdout, wakeText.includes(ROUTED_REPLY_RULE))
      : undefined;

    if (hasConditionalWake) {
      const wakeOnSuccess = request.wakeMessageOnNotifySuccess?.trim();
      const wakeOnFailed = request.wakeMessageOnNotifyFailed?.trim();

      const sendDeferredWake = (wakeText: string, queueOnly = false): void => {
        if (!wakeText) return;
        if (shouldDispatch?.() === false) return;
        const skipReason = request.skipDeferredWake?.();
        if (skipReason) {
          hooks?.onWakeSkipped?.(skipReason);
          return;
        }
        hooks?.onWakeStarted?.();
        if (queueOnly) {
          this.queueForNextTurn(session, wakeText, `${request.label}-wake`, hooks, shouldDispatch);
          return;
        }
        this.sendWake(
          session,
          wakeText,
          `${request.label}-wake`,
          "wake",
          hooks?.onWakeFailed,
          hooks?.onWakeSucceeded,
          shouldDispatch,
          wakeSuccessValidatorFor(wakeText),
          hooks?.onWakeSkipped,
          request.idempotencyKey,
          hooks,
          request.admittedWakeRunId,
          request.admittedWakeRoutedReply,
          request.retryUnsubmittedWake,
        );
      };
      const dispatchWake = (wakeText: string, queueOnly = false): void => {
        if (!wakeText) return;
        if (request.deferConditionalWakeUntilNextTick === true || request.deferConditionalWakeMs !== undefined) {
          const delayMs = Math.max(0, Math.floor(request.deferConditionalWakeMs ?? 0));
          this.deferWake(() => sendDeferredWake(wakeText, queueOnly), delayMs);
          return;
        }
        sendDeferredWake(wakeText, queueOnly);
      };

      const onSuccess = () => {
        if (shouldDispatch?.() === false) return;
        hooks?.onNotifySucceeded?.();
        if (wakeOnSuccess) dispatchWake(wakeOnSuccess, request.wakeDelivery === "next-turn");
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
          // A queued (next-turn) success wake does not run a turn, so the fallback must.
          Boolean(wakeOnSuccess) && request.wakeDelivery !== "next-turn",
          hooks?.onNotifyAdmitted,
          hooks?.onNotifyAmbiguous,
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
        hooks?.onNotifyAdmitted,
        hooks?.onNotifyAmbiguous,
      );
    }

    if (!wakeMessage) return;
    if (shouldDispatch?.() === false) return;
    hooks?.onWakeStarted?.();

    if (request.wakeDelivery === "next-turn") {
      this.queueForNextTurn(session, wakeMessage, `${request.label}-wake`, hooks, shouldDispatch);
      return;
    }

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
        hooks?.onNotifyAdmitted,
        hooks?.onNotifyAmbiguous,
      );
    }

    const sendImmediateWake = (): void => {
      if (shouldDispatch?.() === false) return;
      const skipReason = request.skipDeferredWake?.();
      if (skipReason) {
        hooks?.onWakeSkipped?.(skipReason);
        return;
      }
      this.sendWake(
        session,
        wakeMessage,
        `${request.label}-wake`,
        "wake",
        hooks?.onWakeFailed,
        hooks?.onWakeSucceeded,
        shouldDispatch,
        wakeSuccessValidatorFor(wakeMessage),
        hooks?.onWakeSkipped,
        request.idempotencyKey,
        hooks,
        request.admittedWakeRunId,
        request.admittedWakeRoutedReply,
        request.retryUnsubmittedWake,
      );
    };
    if (request.deferWakeMs !== undefined && request.deferWakeMs > 0) {
      this.deferWake(sendImmediateWake, request.deferWakeMs);
      return;
    }
    sendImmediateWake();
  }
}
