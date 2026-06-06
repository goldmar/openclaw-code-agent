import type { PersistedSessionInfo } from "./types";
import { WakeDispatcher, type SessionNotificationHooks, type SessionNotificationRequest } from "./wake-dispatcher";
import type { Session } from "./session";
import { getBackendConversationId, getPrimarySessionLookupRef } from "./session-backend-ref";
import { formatOriginRouteWakeBlock } from "./session-route";
import { buildWorktreeOutcomeFollowupWake } from "./session-notification-builder";
import {
  CompletionSummaryCoordinator,
  type CompletionSummaryFact,
} from "./completion-summary-coordinator";

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
  completionWakeOutcomeKey?: string;
  completionSummaryOwner?: "wake" | "foreground";
}

export interface SessionNotificationServiceOptions {
  maxCompletedCompletionWakeKeys?: number;
}

const WORKTREE_FOLLOWUP_CONTEXT_GRACE_MS = 2_000;

export class SessionNotificationService {
  private readonly completionSummaries: CompletionSummaryCoordinator;

  constructor(
    private readonly wakeDispatcher: WakeDispatcher,
    private readonly applyPersistedPatch: (ref: string, patch: Partial<PersistedSessionInfo>) => void,
    options: SessionNotificationServiceOptions = {},
  ) {
    this.completionSummaries = new CompletionSummaryCoordinator({
      maxCompletedKeys: options.maxCompletedCompletionWakeKeys,
    });
  }

  dispatch(
    session: RoutableSession | PersistedRoutingSession,
    request: SessionNotificationRequest,
  ): void {
    const deliveryRef = this.getDeliveryRef(session);
    const completionSummaryFact = this.buildCompletionSummaryFact(request);
    const foregroundOwnsSummary =
      request.completionSummaryOwner === "foreground" && completionSummaryFact?.required === true;
    const completionSummaryDecision = foregroundOwnsSummary
      ? this.completionSummaries.recordVisibleDelivery(session, completionSummaryFact)
      : this.completionSummaries.decide(session, completionSummaryFact);
    let dispatchRequest = foregroundOwnsSummary ? this.withoutCompletionWake(request) : request;
    if (completionSummaryDecision.required && !completionSummaryDecision.allowed) {
      request.hooks?.onWakeSkipped?.(completionSummaryDecision.skipReason ?? "completion follow-up wake suppressed");
      if (foregroundOwnsSummary) {
        return;
      } else if (completionSummaryDecision.explicit) {
        dispatchRequest = this.withoutCompletionWake(request);
      } else {
        return;
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
          this.completionSummaries.finish(completionSummaryDecision.key, false);
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
          this.completionSummaries.finish(completionSummaryDecision.key, false);
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
        this.completionSummaries.finish(completionSummaryDecision.key, true);
        dispatchRequest.hooks?.onWakeSucceeded?.();
      },
      onWakeSkipped: (reason) => {
        this.applyPersistedPatchWithCompletionWake(deliveryRef, "idle", this.buildCompletionWakeSucceededPatch(completionWakePatch), {
          completionWakeSucceededAt: undefined,
          completionWakeFailedAt: undefined,
          completionWakeSkippedAt: new Date().toISOString(),
          completionWakeSkipReason: reason,
        });
        this.completionSummaries.finish(completionSummaryDecision.key, true);
        dispatchRequest.hooks?.onWakeSkipped?.(reason);
      },
      onWakeFailed: () => {
        this.applyPersistedPatchWithCompletionWake(deliveryRef, "failed", completionWakePatch, {
          completionWakeFailedAt: new Date().toISOString(),
        });
        this.completionSummaries.finish(completionSummaryDecision.key, false);
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
    const completionSummary: CompletionSummaryFact = {
      required: summaryWakeRequired,
      producer: "worktree-pr",
      outcomeKey: options.completionWakeOutcomeKey ?? `terminal:${sessionId}`,
    };
    const wakeOwnsSummary = options.completionSummaryOwner !== "foreground";
    if (summaryWakeRequired && !wakeOwnsSummary) {
      this.completionSummaries.recordVisibleDelivery(session, completionSummary);
    }
    this.dispatch(session, {
      label: "worktree-outcome",
      userMessage: outcomeLine,
      notifyUser: "always",
      requireDirectUserNotification: true,
      completionSummary: {
        ...completionSummary,
        required: summaryWakeRequired && wakeOwnsSummary,
      },
      completionWakeSummaryRequired: summaryWakeRequired && wakeOwnsSummary,
      completionWakeOutcomeKey: options.completionWakeOutcomeKey ?? `terminal:${sessionId}`,
      deferConditionalWakeUntilNextTick: true,
      deferConditionalWakeMs: WORKTREE_FOLLOWUP_CONTEXT_GRACE_MS,
      wakeMessageOnNotifySuccess: summaryWakeRequired && wakeOwnsSummary ? buildWakeMessage(true) : undefined,
      wakeMessageOnNotifyFailed: summaryWakeRequired && wakeOwnsSummary ? buildWakeMessage(false) : undefined,
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
      completionSummary: request.completionSummary
        ? { ...request.completionSummary, required: false }
        : undefined,
      wakeMessage: undefined,
      wakeMessageOnNotifySuccess: undefined,
      wakeMessageOnNotifyFailed: undefined,
      completionWakeSummaryRequired: false,
    };
  }

  private buildCompletionSummaryFact(
    request: SessionNotificationRequest,
  ): CompletionSummaryFact | undefined {
    if (request.completionSummary) return request.completionSummary;
    if (request.completionWakeSummaryRequired !== true) return undefined;
    const wakeTexts = [
      request.wakeMessage,
      request.wakeMessageOnNotifySuccess,
      request.wakeMessageOnNotifyFailed,
    ]
      .map((text) => text?.trim())
      .filter((text): text is string => Boolean(text));
    return {
      required: true,
      producer: "legacy",
      outcomeKey: request.completionWakeOutcomeKey,
      fallbackFingerprint: wakeTexts.length > 0
        ? `${request.label}\n${wakeTexts.join("\n---completion-wake---\n")}`
        : undefined,
    };
  }
}
