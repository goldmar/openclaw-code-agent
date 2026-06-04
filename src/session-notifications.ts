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
  goalTaskId?: string;
};

type PersistedRoutingSession = Pick<
  PersistedSessionInfo,
  | "sessionId"
  | "harnessSessionId"
  | "backendRef"
  | "route"
  | "name"
  | "originChannel"
  | "originThreadId"
  | "originSessionKey"
  | "goalTaskId"
> & {
  id?: string;
};

export interface WorktreeOutcomeNotificationOptions {
  summaryWakeRequired?: boolean;
  detailLines?: string[];
}

export interface SessionNotificationServiceOptions {
  maxCompletedCompletionWakeKeys?: number;
}

const DEFAULT_MAX_COMPLETED_COMPLETION_WAKE_KEYS = 1024;

export class SessionNotificationService {
  private readonly inFlightCompletionWakes = new Set<string>();
  private readonly completedCompletionWakes = new Map<string, true>();
  private readonly maxCompletedCompletionWakeKeys: number;

  constructor(
    private readonly wakeDispatcher: WakeDispatcher,
    private readonly applyPersistedPatch: (ref: string, patch: Partial<PersistedSessionInfo>) => void,
    options: SessionNotificationServiceOptions = {},
  ) {
    this.maxCompletedCompletionWakeKeys = Math.max(
      1,
      Math.floor(options.maxCompletedCompletionWakeKeys ?? DEFAULT_MAX_COMPLETED_COMPLETION_WAKE_KEYS),
    );
  }

  dispatch(
    session: RoutableSession | PersistedRoutingSession,
    request: SessionNotificationRequest,
  ): void {
    const deliveryRef = this.getDeliveryRef(session);
    const completionWakeKey = this.buildCompletionWakeKey(deliveryRef, request, session);
    let dispatchRequest = request;
    let claimedCompletionWakeKey: string | undefined;
    if (completionWakeKey?.key) {
      if (this.inFlightCompletionWakes.has(completionWakeKey.key) || this.completedCompletionWakes.has(completionWakeKey.key)) {
        request.hooks?.onWakeSkipped?.("duplicate completion follow-up wake already handled");
        if (completionWakeKey.explicit) {
          dispatchRequest = this.withoutCompletionWake(request);
        } else {
          return;
        }
      } else {
        this.inFlightCompletionWakes.add(completionWakeKey.key);
        claimedCompletionWakeKey = completionWakeKey.key;
      }
    }
    const completionWakePatch = this.buildCompletionWakePatch(dispatchRequest);
    const hasWakeAfterNotifySuccess = Boolean(dispatchRequest.wakeMessage?.trim() || dispatchRequest.wakeMessageOnNotifySuccess?.trim());
    const hasWakeAfterNotifyFailure = Boolean(dispatchRequest.wakeMessage?.trim() || dispatchRequest.wakeMessageOnNotifyFailed?.trim());

    const mergedHooks: SessionNotificationHooks = {
      onNotifyStarted: () => {
        this.applyDeliveryState(deliveryRef, "notifying");
        dispatchRequest.hooks?.onNotifyStarted?.();
      },
      onNotifySucceeded: () => {
        this.applyNotifyDeliveryState(
          deliveryRef,
          hasWakeAfterNotifySuccess ? "wake_pending" : "idle",
          hasWakeAfterNotifySuccess ? completionWakePatch : undefined,
        );
        if (!hasWakeAfterNotifySuccess) {
          this.markCompletionWakeFinished(claimedCompletionWakeKey, false);
        }
        dispatchRequest.hooks?.onNotifySucceeded?.();
      },
      onNotifyFailed: () => {
        this.applyNotifyDeliveryState(
          deliveryRef,
          hasWakeAfterNotifyFailure ? "wake_pending" : "failed",
          hasWakeAfterNotifyFailure ? completionWakePatch : undefined,
        );
        if (!hasWakeAfterNotifyFailure) {
          this.markCompletionWakeFinished(claimedCompletionWakeKey, false);
        }
        dispatchRequest.hooks?.onNotifyFailed?.();
      },
      onWakeStarted: () => {
        this.applyPersistedPatchWithCompletionWake(deliveryRef, "wake_pending", completionWakePatch, {
          completionWakeIssuedAt: new Date().toISOString(),
          completionWakeSucceededAt: undefined,
          completionWakeFailedAt: undefined,
          completionWakeSkippedAt: undefined,
          completionWakeSkipReason: undefined,
        });
        dispatchRequest.hooks?.onWakeStarted?.();
      },
      onWakeSucceeded: () => {
        this.applyPersistedPatchWithCompletionWake(deliveryRef, "idle", this.buildCompletionWakeSucceededPatch(completionWakePatch), {
          completionWakeSucceededAt: new Date().toISOString(),
          completionWakeFailedAt: undefined,
          completionWakeSkippedAt: undefined,
          completionWakeSkipReason: undefined,
        });
        this.markCompletionWakeFinished(claimedCompletionWakeKey, true);
        dispatchRequest.hooks?.onWakeSucceeded?.();
      },
      onWakeSkipped: (reason) => {
        this.applyPersistedPatchWithCompletionWake(deliveryRef, "idle", this.buildCompletionWakeSucceededPatch(completionWakePatch), {
          completionWakeSucceededAt: undefined,
          completionWakeFailedAt: undefined,
          completionWakeSkippedAt: new Date().toISOString(),
          completionWakeSkipReason: reason,
        });
        this.markCompletionWakeFinished(claimedCompletionWakeKey, true);
        dispatchRequest.hooks?.onWakeSkipped?.(reason);
      },
      onWakeFailed: () => {
        this.applyPersistedPatchWithCompletionWake(deliveryRef, "failed", completionWakePatch, {
          completionWakeFailedAt: new Date().toISOString(),
        });
        this.markCompletionWakeFinished(claimedCompletionWakeKey, false);
        dispatchRequest.hooks?.onWakeFailed?.();
      },
    };

    this.wakeDispatcher.dispatchSessionNotification(session as Session, {
      ...dispatchRequest,
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
      completionWakeOutcomeKey: `terminal:${sessionId}`,
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

  private withoutCompletionWake(request: SessionNotificationRequest): SessionNotificationRequest {
    return {
      ...request,
      wakeMessage: undefined,
      wakeMessageOnNotifySuccess: undefined,
      wakeMessageOnNotifyFailed: undefined,
      completionWakeSummaryRequired: false,
    };
  }

  private buildCompletionWakeKey(
    deliveryRef: string,
    request: SessionNotificationRequest,
    session: RoutableSession | PersistedRoutingSession,
  ): { key: string; explicit: boolean } | undefined {
    if (request.completionWakeSummaryRequired !== true || !deliveryRef) return undefined;
    const outcomeKey = this.normalizeCompletionWakeOutcomeKey(session, request.completionWakeOutcomeKey?.trim());
    if (outcomeKey) {
      const digest = createHash("sha256").update(outcomeKey).digest("hex").slice(0, 16);
      return { key: `${deliveryRef}:outcome:${digest}`, explicit: true };
    }
    const wakeTexts = [
      request.wakeMessage,
      request.wakeMessageOnNotifySuccess,
      request.wakeMessageOnNotifyFailed,
    ]
      .map((text) => text?.trim())
      .filter((text): text is string => Boolean(text));
    if (wakeTexts.length === 0) return undefined;
    const digest = createHash("sha256").update(wakeTexts.join("\n---completion-wake---\n")).digest("hex").slice(0, 16);
    return { key: `${deliveryRef}:${request.label}:${digest}`, explicit: false };
  }

  private normalizeCompletionWakeOutcomeKey(
    session: RoutableSession | PersistedRoutingSession,
    outcomeKey: string | undefined,
  ): string | undefined {
    if (!outcomeKey) return undefined;
    const goalTaskId = session.goalTaskId?.trim();
    if (goalTaskId && outcomeKey.startsWith("terminal:")) {
      return `goal:${goalTaskId}`;
    }
    return outcomeKey;
  }

  private markCompletionWakeFinished(key: string | undefined, completed: boolean): void {
    if (!key) return;
    this.inFlightCompletionWakes.delete(key);
    if (completed) {
      this.completedCompletionWakes.delete(key);
      this.completedCompletionWakes.set(key, true);
      while (this.completedCompletionWakes.size > this.maxCompletedCompletionWakeKeys) {
        const oldestKey = this.completedCompletionWakes.keys().next().value;
        if (oldestKey === undefined) break;
        this.completedCompletionWakes.delete(oldestKey);
      }
    }
  }
}
