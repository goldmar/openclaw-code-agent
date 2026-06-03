import type { PersistedSessionInfo } from "./types";
import { WakeDispatcher, type SessionNotificationHooks, type SessionNotificationRequest } from "./wake-dispatcher";
import type { Session } from "./session";
import { getBackendConversationId, getPrimarySessionLookupRef } from "./session-backend-ref";
import { formatOriginRouteWakeBlock } from "./session-route";
import { buildWorktreeOutcomeFollowupWake } from "./session-notification-builder";
import { createHash } from "crypto";

type RoutableSession = Pick<
  Session,
  "id" | "harnessSessionId" | "backendRef" | "route" | "originChannel" | "originThreadId" | "originSessionKey"
> & {
  name?: string;
};

type PersistedRoutingSession = Pick<
  PersistedSessionInfo,
  "sessionId" | "harnessSessionId" | "backendRef" | "route" | "name" | "originChannel" | "originThreadId" | "originSessionKey"
> & {
  id?: string;
};

export interface WorktreeOutcomeNotificationOptions {
  summaryWakeRequired?: boolean;
  detailLines?: string[];
}

export class SessionNotificationService {
  private readonly inFlightCompletionWakes = new Set<string>();
  private readonly completedCompletionWakes = new Set<string>();

  constructor(
    private readonly wakeDispatcher: WakeDispatcher,
    private readonly applyPersistedPatch: (ref: string, patch: Partial<PersistedSessionInfo>) => void,
  ) {}

  dispatch(
    session: RoutableSession | PersistedRoutingSession,
    request: SessionNotificationRequest,
  ): void {
    const deliveryRef = this.getDeliveryRef(session);
    const completionWakeKey = this.buildCompletionWakeKey(deliveryRef, request);
    if (completionWakeKey) {
      if (this.inFlightCompletionWakes.has(completionWakeKey) || this.completedCompletionWakes.has(completionWakeKey)) {
        request.hooks?.onWakeSkipped?.("duplicate completion follow-up wake already handled");
        return;
      }
      this.inFlightCompletionWakes.add(completionWakeKey);
    }
    const completionWakePatch = this.buildCompletionWakePatch(request);
    const hasWakeAfterNotifySuccess = Boolean(request.wakeMessage?.trim() || request.wakeMessageOnNotifySuccess?.trim());
    const hasWakeAfterNotifyFailure = Boolean(request.wakeMessage?.trim() || request.wakeMessageOnNotifyFailed?.trim());

    const mergedHooks: SessionNotificationHooks = {
      onNotifyStarted: () => {
        this.applyDeliveryState(deliveryRef, "notifying");
        request.hooks?.onNotifyStarted?.();
      },
      onNotifySucceeded: () => {
        this.applyNotifyDeliveryState(
          deliveryRef,
          hasWakeAfterNotifySuccess ? "wake_pending" : "idle",
          hasWakeAfterNotifySuccess ? completionWakePatch : undefined,
        );
        request.hooks?.onNotifySucceeded?.();
      },
      onNotifyFailed: () => {
        this.applyNotifyDeliveryState(
          deliveryRef,
          hasWakeAfterNotifyFailure ? "wake_pending" : "failed",
          hasWakeAfterNotifyFailure ? completionWakePatch : undefined,
        );
        request.hooks?.onNotifyFailed?.();
      },
      onWakeStarted: () => {
        this.applyPersistedPatchWithCompletionWake(deliveryRef, "wake_pending", completionWakePatch, {
          completionWakeIssuedAt: new Date().toISOString(),
          completionWakeSucceededAt: undefined,
          completionWakeFailedAt: undefined,
          completionWakeSkippedAt: undefined,
          completionWakeSkipReason: undefined,
        });
        request.hooks?.onWakeStarted?.();
      },
      onWakeSucceeded: () => {
        this.applyPersistedPatchWithCompletionWake(deliveryRef, "idle", this.buildCompletionWakeSucceededPatch(completionWakePatch), {
          completionWakeSucceededAt: new Date().toISOString(),
          completionWakeFailedAt: undefined,
          completionWakeSkippedAt: undefined,
          completionWakeSkipReason: undefined,
        });
        this.markCompletionWakeFinished(completionWakeKey, true);
        request.hooks?.onWakeSucceeded?.();
      },
      onWakeSkipped: (reason) => {
        this.applyPersistedPatchWithCompletionWake(deliveryRef, "idle", this.buildCompletionWakeSucceededPatch(completionWakePatch), {
          completionWakeSucceededAt: undefined,
          completionWakeFailedAt: undefined,
          completionWakeSkippedAt: new Date().toISOString(),
          completionWakeSkipReason: reason,
        });
        this.markCompletionWakeFinished(completionWakeKey, true);
        request.hooks?.onWakeSkipped?.(reason);
      },
      onWakeFailed: () => {
        this.applyPersistedPatchWithCompletionWake(deliveryRef, "failed", completionWakePatch, {
          completionWakeFailedAt: new Date().toISOString(),
        });
        this.markCompletionWakeFinished(completionWakeKey, false);
        request.hooks?.onWakeFailed?.();
      },
    };

    this.wakeDispatcher.dispatchSessionNotification(session as Session, {
      ...request,
      hooks: mergedHooks,
    });
  }

  notifyWorktreeOutcome(
    session: RoutableSession | PersistedRoutingSession,
    outcomeLine: string,
    options: WorktreeOutcomeNotificationOptions = {},
  ): void {
    const sessionId = this.getDeliveryRef(session);
    const buildWakeMessage = (canonicalStatusDelivered: boolean): string => buildWorktreeOutcomeFollowupWake({
      sessionId,
      sessionName: session.name,
      outcomeLine,
      originThreadLine: formatOriginRouteWakeBlock(session),
      detailLines: options.detailLines,
      canonicalStatusDelivered,
    });
    const summaryWakeRequired = options.summaryWakeRequired ?? true;
    this.dispatch(session, {
      label: "worktree-outcome",
      userMessage: outcomeLine,
      notifyUser: "always",
      requireDirectUserNotification: true,
      completionWakeSummaryRequired: summaryWakeRequired,
      deferConditionalWakeUntilNextTick: true,
      wakeMessageOnNotifySuccess: summaryWakeRequired ? buildWakeMessage(true) : undefined,
      wakeMessageOnNotifyFailed: summaryWakeRequired ? buildWakeMessage(false) : undefined,
    });
  }

  dispose(): void {
    this.wakeDispatcher.dispose();
  }

  private getDeliveryRef(session: RoutableSession | PersistedRoutingSession): string {
    return getPrimarySessionLookupRef(session) ?? getBackendConversationId(session) ?? "";
  }

  private applyDeliveryState(
    ref: string,
    deliveryState: PersistedSessionInfo["deliveryState"],
  ): void {
    if (!ref || !deliveryState) return;
    this.applyPersistedPatch(ref, { deliveryState });
  }

  private applyNotifyDeliveryState(
    ref: string,
    deliveryState: PersistedSessionInfo["deliveryState"],
    completionWakePatch: Pick<PersistedSessionInfo, "completionWakeSummaryRequired"> | undefined,
  ): void {
    if (!ref || !deliveryState) return;
    this.applyPersistedPatch(ref, completionWakePatch
      ? {
          deliveryState,
          ...completionWakePatch,
        }
      : { deliveryState });
  }

  private applyPersistedPatchWithCompletionWake(
    ref: string,
    deliveryState: PersistedSessionInfo["deliveryState"],
    completionWakePatch: Pick<PersistedSessionInfo, "completionWakeSummaryRequired"> | undefined,
    extraPatch: Partial<
      Pick<
        PersistedSessionInfo,
        | "completionWakeIssuedAt"
        | "completionWakeSucceededAt"
        | "completionWakeFailedAt"
        | "completionWakeSkippedAt"
        | "completionWakeSkipReason"
      >
    >,
  ): void {
    if (!ref || !deliveryState) return;
    this.applyPersistedPatch(ref, completionWakePatch
      ? {
          deliveryState,
          ...completionWakePatch,
          ...extraPatch,
        }
      : { deliveryState });
  }

  private buildCompletionWakePatch(
    request: SessionNotificationRequest,
  ): Pick<PersistedSessionInfo, "completionWakeSummaryRequired"> | undefined {
    if (request.completionWakeSummaryRequired !== true) return undefined;
    return { completionWakeSummaryRequired: true };
  }

  private buildCompletionWakeSucceededPatch(
    completionWakePatch: Pick<PersistedSessionInfo, "completionWakeSummaryRequired"> | undefined,
  ): Pick<PersistedSessionInfo, "completionWakeSummaryRequired"> | undefined {
    if (!completionWakePatch) return undefined;
    return { completionWakeSummaryRequired: undefined };
  }

  private buildCompletionWakeKey(deliveryRef: string, request: SessionNotificationRequest): string | undefined {
    if (request.completionWakeSummaryRequired !== true || !deliveryRef) return undefined;
    const wakeTexts = [
      request.wakeMessage,
      request.wakeMessageOnNotifySuccess,
      request.wakeMessageOnNotifyFailed,
    ]
      .map((text) => text?.trim())
      .filter((text): text is string => Boolean(text));
    if (wakeTexts.length === 0) return undefined;
    const digest = createHash("sha256").update(wakeTexts.join("\n---completion-wake---\n")).digest("hex").slice(0, 16);
    return `${deliveryRef}:${request.label}:${digest}`;
  }

  private markCompletionWakeFinished(key: string | undefined, completed: boolean): void {
    if (!key) return;
    this.inFlightCompletionWakes.delete(key);
    if (completed) {
      this.completedCompletionWakes.add(key);
    }
  }
}
