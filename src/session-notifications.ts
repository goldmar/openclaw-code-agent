import type { PersistedSessionInfo } from "./types";
import { WakeDispatcher, type SessionNotificationHooks, type SessionNotificationRequest } from "./wake-dispatcher";
import type { Session } from "./session";
import { getBackendConversationId, getPrimarySessionLookupRef } from "./session-backend-ref";

type RoutableSession = Pick<
  Session,
  "id" | "harnessSessionId" | "backendRef" | "route"
> & {
  name?: string;
};

type PersistedRoutingSession = Pick<
  PersistedSessionInfo,
  "sessionId" | "harnessSessionId" | "backendRef" | "route" | "name"
> & {
  id?: string;
};

export class SessionNotificationService {
  constructor(
    private readonly wakeDispatcher: WakeDispatcher,
    private readonly applyPersistedPatch: (ref: string, patch: Partial<PersistedSessionInfo>) => void,
  ) {}

  dispatch(
    session: RoutableSession | PersistedRoutingSession,
    request: SessionNotificationRequest,
  ): void {
    const deliveryRef = this.getDeliveryRef(session);
    const completionWakePatch = this.buildCompletionWakePatch(request);
    const hasWakeAfterNotifySuccess = Boolean(request.wakeMessage?.trim() || request.wakeMessageOnNotifySuccess?.trim());
    const hasWakeAfterNotifyFailure = Boolean(request.wakeMessage?.trim() || request.wakeMessageOnNotifyFailed?.trim());

    const mergedHooks: SessionNotificationHooks = {
      onNotifyStarted: () => {
        this.applyDeliveryState(deliveryRef, "notifying");
        request.hooks?.onNotifyStarted?.();
      },
      onNotifySucceeded: () => {
        this.applyDeliveryState(deliveryRef, hasWakeAfterNotifySuccess ? "wake_pending" : "idle");
        request.hooks?.onNotifySucceeded?.();
      },
      onNotifyFailed: () => {
        this.applyDeliveryState(deliveryRef, hasWakeAfterNotifyFailure ? "wake_pending" : "failed");
        request.hooks?.onNotifyFailed?.();
      },
      onWakeStarted: () => {
        this.applyPersistedPatchWithCompletionWake(deliveryRef, "wake_pending", completionWakePatch, {
          completionWakeIssuedAt: new Date().toISOString(),
          completionWakeSucceededAt: undefined,
          completionWakeFailedAt: undefined,
        });
        request.hooks?.onWakeStarted?.();
      },
      onWakeSucceeded: () => {
        this.applyPersistedPatchWithCompletionWake(deliveryRef, "idle", completionWakePatch, {
          completionWakeSucceededAt: new Date().toISOString(),
          completionWakeFailedAt: undefined,
        });
        request.hooks?.onWakeSucceeded?.();
      },
      onWakeFailed: () => {
        this.applyPersistedPatchWithCompletionWake(deliveryRef, "failed", completionWakePatch, {
          completionWakeFailedAt: new Date().toISOString(),
        });
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
  ): void {
    this.dispatch(session, {
      label: "worktree-outcome",
      userMessage: outcomeLine,
      notifyUser: "always",
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

  private applyPersistedPatchWithCompletionWake(
    ref: string,
    deliveryState: PersistedSessionInfo["deliveryState"],
    completionWakePatch: Pick<PersistedSessionInfo, "completionWakeSummaryRequired"> | undefined,
    extraPatch: Partial<
      Pick<
        PersistedSessionInfo,
        "completionWakeIssuedAt" | "completionWakeSucceededAt" | "completionWakeFailedAt"
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
    if (request.label !== "completed") return undefined;
    return { completionWakeSummaryRequired: true };
  }
}
