import { createHash } from "crypto";
import type { PersistedSessionInfo } from "./types";
import { WakeDispatcher, type SessionNotificationHooks, type SessionNotificationRequest } from "./wake-dispatcher";
import type { Session } from "./session";
import { getBackendConversationId, getPrimarySessionLookupRef } from "./session-backend-ref";
import { formatOriginRouteWakeBlock } from "./session-route";
import { buildWorktreeOutcomeFollowupWake } from "./session-notification-builder";
import { NotificationDedupeCoordinator } from "./notification-dedupe";
import { resolveNotificationRoute } from "./session-route";
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
  maxNotificationDedupeRecords?: number;
  getPersistedSession?: (ref: string) => PersistedSessionInfo | undefined;
}

const WORKTREE_FOLLOWUP_CONTEXT_GRACE_MS = 2_000;

function writeNotificationDecisionLog(payload: Record<string, unknown>): void {
  process.stderr.write(`[SessionNotification] ${JSON.stringify(payload)}\n`);
}

export class SessionNotificationService {
  private readonly completionSummaries: CompletionSummaryCoordinator;
  private readonly notificationDedupe: NotificationDedupeCoordinator;
  private readonly getPersistedSession?: (ref: string) => PersistedSessionInfo | undefined;

  constructor(
    private readonly wakeDispatcher: WakeDispatcher,
    private readonly applyPersistedPatch: (ref: string, patch: Partial<PersistedSessionInfo>) => void,
    options: SessionNotificationServiceOptions = {},
  ) {
    this.completionSummaries = new CompletionSummaryCoordinator({
      maxCompletedKeys: options.maxCompletedCompletionWakeKeys,
    });
    this.notificationDedupe = new NotificationDedupeCoordinator({
      maxRecords: options.maxNotificationDedupeRecords,
    });
    this.getPersistedSession = options.getPersistedSession;
  }

  dispatch(
    session: RoutableSession | PersistedRoutingSession,
    request: SessionNotificationRequest,
  ): void {
    const deliveryRef = this.getDeliveryRef(session);
    const persistedSession = this.getPersistedSession?.(deliveryRef);
    const notificationDedupeKey = this.buildNotificationDedupeKey(session, request);
    const notificationDedupeClaim = this.notificationDedupe.claim(
      notificationDedupeKey,
      persistedSession?.notificationDedupe,
      request.label,
    );
    if (notificationDedupeClaim.records) {
      this.applyNotificationDedupePatch(deliveryRef, notificationDedupeClaim.records);
    }
    if (!notificationDedupeClaim.allowed) {
      this.logNotificationDecision({
        session,
        request,
        deliveryRef,
        dedupeKey: notificationDedupeKey,
        decision: "skip",
        reason: notificationDedupeClaim.reason ?? "duplicate notification skipped",
        deliveryPath: "notify",
      });
      request.hooks?.onDuplicateSkipped?.(notificationDedupeClaim.reason ?? "duplicate notification skipped");
      return;
    }
    const completionSummaryFact = this.buildCompletionSummaryFact(request);
    const foregroundOwnsSummary =
      request.completionSummaryOwner === "foreground" && completionSummaryFact?.required === true;
    const completionSummaryDecision = foregroundOwnsSummary
      ? this.completionSummaries.recordVisibleDelivery(
          session,
          completionSummaryFact,
          persistedSession?.completionSummaryDedupe,
          request.label,
        )
      : this.completionSummaries.decide(
          session,
          completionSummaryFact,
          persistedSession?.completionSummaryDedupe,
        );
    if (completionSummaryDecision.records) {
      this.applyCompletionSummaryDedupePatch(deliveryRef, completionSummaryDecision.records);
    }
    let dispatchRequest = foregroundOwnsSummary ? this.withoutCompletionWake(request) : request;
    if (completionSummaryDecision.required && !completionSummaryDecision.allowed) {
      const duplicateSummaryMessage = completionSummaryDecision.explicit && this.isCompletionSummaryMessage(request);
      this.logNotificationDecision({
        session,
        request,
        deliveryRef,
        dedupeKey: completionSummaryDecision.dedupeKey ?? completionSummaryDecision.key,
        outcomeKey: completionSummaryFact?.outcomeKey,
        decision: foregroundOwnsSummary || duplicateSummaryMessage
          ? "skip"
          : completionSummaryDecision.explicit ? "send_without_followup" : "skip",
        reason: completionSummaryDecision.skipReason ?? "completion follow-up wake suppressed",
        deliveryPath: foregroundOwnsSummary ? "foreground-summary" : "wake",
        followupKind: completionSummaryFact?.producer,
      });
      request.hooks?.onWakeSkipped?.(completionSummaryDecision.skipReason ?? "completion follow-up wake suppressed");
      if (foregroundOwnsSummary) {
        this.releaseNotificationDedupe(deliveryRef, notificationDedupeKey);
        return;
      } else if (duplicateSummaryMessage) {
        this.releaseNotificationDedupe(deliveryRef, notificationDedupeKey);
        return;
      } else if (completionSummaryDecision.explicit) {
        dispatchRequest = this.withoutCompletionWake(request);
      } else {
        this.releaseNotificationDedupe(deliveryRef, notificationDedupeKey);
        return;
      }
    }
    if (completionSummaryFact?.required === true) {
      this.logNotificationDecision({
        session,
        request: dispatchRequest,
        deliveryRef,
        dedupeKey: completionSummaryDecision.dedupeKey ?? completionSummaryDecision.key,
        outcomeKey: completionSummaryFact.outcomeKey,
        decision: foregroundOwnsSummary ? "record_visible" : dispatchRequest.completionWakeSummaryRequired === true ? "send_with_followup" : "send_without_followup",
        reason: foregroundOwnsSummary ? "foreground summary owns completion follow-up" : undefined,
        deliveryPath: foregroundOwnsSummary ? "foreground-summary" : "wake",
        followupKind: completionSummaryFact.producer,
      });
    }
    const completionWakePatch = this.buildCompletionWakePatch(dispatchRequest);
    const hasWakeAfterNotifySuccess = Boolean(dispatchRequest.wakeMessage?.trim() || dispatchRequest.wakeMessageOnNotifySuccess?.trim());
    const hasWakeAfterNotifyFailure = Boolean(dispatchRequest.wakeMessage?.trim() || dispatchRequest.wakeMessageOnNotifyFailed?.trim());
    let notificationDedupeResolved = false;
    let dispatchCancelled = false;
    const cancelDispatch = (): void => {
      if (dispatchCancelled) return;
      dispatchCancelled = true;
      if (!notificationDedupeResolved) {
        this.releaseNotificationDedupe(deliveryRef, notificationDedupeKey);
        notificationDedupeResolved = true;
      }
      this.completionSummaries.finish(completionSummaryDecision.key, false);
    };
    const shouldDispatch = dispatchRequest.shouldDispatch
      ? () => {
          const allowed = dispatchRequest.shouldDispatch?.() !== false;
          if (!allowed) cancelDispatch();
          return allowed;
        }
      : undefined;

    const mergedHooks: SessionNotificationHooks = {
      onNotifyStarted: () => {
        this.applyDeliveryState(deliveryRef, "notifying");
        dispatchRequest.hooks?.onNotifyStarted?.();
      },
      onNotifySucceeded: () => {
        notificationDedupeResolved = true;
        this.markNotificationDedupeDelivered(deliveryRef, notificationDedupeKey, dispatchRequest.label);
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
          this.releaseNotificationDedupe(deliveryRef, notificationDedupeKey);
          notificationDedupeResolved = true;
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
        notificationDedupeResolved = true;
        this.markNotificationDedupeDelivered(deliveryRef, notificationDedupeKey, dispatchRequest.label);
        this.markCompletionSummaryDelivered(
          deliveryRef,
          completionSummaryDecision.key,
          dispatchRequest.label,
        );
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
        if (dispatchCancelled) {
          dispatchRequest.hooks?.onWakeSkipped?.(reason);
          return;
        }
        notificationDedupeResolved = true;
        this.markNotificationDedupeDelivered(deliveryRef, notificationDedupeKey, dispatchRequest.label);
        this.markCompletionSummaryDelivered(
          deliveryRef,
          completionSummaryDecision.key,
          dispatchRequest.label,
          reason,
        );
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
        this.releaseNotificationDedupe(deliveryRef, notificationDedupeKey);
        notificationDedupeResolved = true;
        dispatchRequest.hooks?.onWakeFailed?.();
      },
    };

    this.wakeDispatcher.dispatchSessionNotification(session as Session, {
      ...dispatchRequest,
      idempotencyKey: notificationDedupeKey ?? dispatchRequest.idempotencyKey,
      shouldDispatch,
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
      const deliveryRef = this.getDeliveryRef(session);
      const decision = this.completionSummaries.recordVisibleDelivery(
        session,
        completionSummary,
        deliveryRef ? this.getPersistedSession?.(deliveryRef)?.completionSummaryDedupe : undefined,
        "worktree-outcome",
      );
      if (decision.records) {
        this.applyCompletionSummaryDedupePatch(deliveryRef, decision.records);
      }
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
      idempotencyKey: `worktree-outcome:${options.completionWakeOutcomeKey ?? outcomeLine}`,
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

  private isCompletionSummaryMessage(request: SessionNotificationRequest): boolean {
    if (request.completionSummaryOwner === "foreground") return true;
    return /\b(?:summary|follow-?up)\b/i.test(request.label);
  }

  private buildNotificationDedupeKey(
    session: RoutableSession | PersistedRoutingSession,
    request: SessionNotificationRequest,
  ): string | undefined {
    const semanticKey = request.idempotencyKey?.trim();
    if (!semanticKey) return undefined;
    const deliveryRef = this.getDeliveryRef(session);
    if (!deliveryRef) return undefined;
    const route = resolveNotificationRoute(session);
    const scope = route
      ? {
          provider: route.provider,
          accountId: route.accountId,
          target: route.target,
          threadId: route.threadId,
        }
      : { deliveryRef };
    return `notification:${this.digest(JSON.stringify({ scope, semanticKey }))}`;
  }

  private markNotificationDedupeDelivered(ref: string, key: string | undefined, label: string): void {
    const records = this.notificationDedupe.deliveredRecords(
      key,
      ref ? this.getPersistedSession?.(ref)?.notificationDedupe : undefined,
      label,
    );
    if (records) this.applyNotificationDedupePatch(ref, records);
  }

  private releaseNotificationDedupe(ref: string, key: string | undefined): void {
    const records = this.notificationDedupe.releasedRecords(
      key,
      ref ? this.getPersistedSession?.(ref)?.notificationDedupe : undefined,
    );
    if (records) this.applyNotificationDedupePatch(ref, records);
  }

  private applyNotificationDedupePatch(
    ref: string,
    notificationDedupe: PersistedSessionInfo["notificationDedupe"],
  ): void {
    if (!this.getPersistedSession) return;
    if (!ref) return;
    this.applyPersistedPatch(ref, { notificationDedupe });
  }

  private markCompletionSummaryDelivered(
    ref: string,
    key: string | undefined,
    label: string,
    skipReason?: string,
  ): void {
    const records = this.completionSummaries.completionRecordsAfterDelivery(
      key,
      ref ? this.getPersistedSession?.(ref)?.completionSummaryDedupe : undefined,
      label,
      skipReason,
    );
    if (records) this.applyCompletionSummaryDedupePatch(ref, records);
  }

  private applyCompletionSummaryDedupePatch(
    ref: string,
    completionSummaryDedupe: PersistedSessionInfo["completionSummaryDedupe"],
  ): void {
    if (!this.getPersistedSession) return;
    if (!ref) return;
    this.applyPersistedPatch(ref, { completionSummaryDedupe });
  }

  private logNotificationDecision(args: {
    session: RoutableSession | PersistedRoutingSession;
    request: SessionNotificationRequest;
    deliveryRef: string;
    dedupeKey?: string;
    outcomeKey?: string;
    decision: "send_with_followup" | "send_without_followup" | "record_visible" | "skip";
    reason?: string;
    deliveryPath: "notify" | "wake" | "foreground-summary";
    followupKind?: string;
  }): void {
    const route = resolveNotificationRoute(args.session);
    writeNotificationDecisionLog({
      event: "oca_notification_decision",
      sessionId: "id" in args.session ? args.session.id : args.session.sessionId,
      sessionName: args.session.name,
      harnessSessionId: args.session.harnessSessionId,
      originRoute: route
        ? {
            provider: route.provider,
            accountId: route.accountId,
            target: route.target,
            threadId: route.threadId,
            sessionKey: route.sessionKey,
          }
        : undefined,
      outcomeType: args.outcomeKey?.split(":").slice(0, 2).join(":") ?? args.request.label,
      notificationKind: args.request.label,
      followupKind: args.followupKind,
      dedupeKey: args.dedupeKey,
      deliveryPath: args.deliveryPath,
      decision: args.decision,
      reason: args.reason,
      completionWakeSummaryRequired: args.request.completionWakeSummaryRequired,
      deliveryRef: args.deliveryRef,
    });
  }

  private digest(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
  }
}
