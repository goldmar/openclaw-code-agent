import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionNotificationService } from "../src/session-notifications";

describe("SessionNotificationService", () => {
  it("marks notify-only deliveries as notifying then idle on success", () => {
    const patches: Array<{ ref: string; deliveryState?: string }> = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, () => void> }) => {
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (ref, patch) => patches.push({ ref, deliveryState: patch.deliveryState }),
    );

    service.dispatch(
      { id: "session-1", harnessSessionId: "h-1" } as any,
      { label: "launch", userMessage: "hello", notifyUser: "always" },
    );

    assert.deepEqual(patches, [
      { ref: "session-1", deliveryState: "notifying" },
      { ref: "session-1", deliveryState: "idle" },
    ]);
  });

  it("marks failed notify paths as failed when no wake fallback exists", () => {
    const patches: Array<{ ref: string; deliveryState?: string }> = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, () => void> }) => {
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifyFailed?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (ref, patch) => patches.push({ ref, deliveryState: patch.deliveryState }),
    );

    service.dispatch(
      { id: "session-2", harnessSessionId: "h-2" } as any,
      { label: "launch", userMessage: "hello", notifyUser: "always" },
    );

    assert.deepEqual(patches, [
      { ref: "session-2", deliveryState: "notifying" },
      { ref: "session-2", deliveryState: "failed" },
    ]);
  });

  it("keeps delivery in wake_pending when notify failure hands off to a wake fallback", () => {
    const patches: Array<{ ref: string; deliveryState?: string }> = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, () => void> }) => {
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifyFailed?.();
        request.hooks?.onWakeStarted?.();
        request.hooks?.onWakeSucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (ref, patch) => patches.push({ ref, deliveryState: patch.deliveryState }),
    );

    service.dispatch(
      { id: "session-3", harnessSessionId: "h-3" } as any,
      {
        label: "plan-approval",
        userMessage: "plan ready",
        wakeMessageOnNotifyFailed: "fallback wake",
        notifyUser: "always",
      },
    );

    assert.deepEqual(patches, [
      { ref: "session-3", deliveryState: "notifying" },
      { ref: "session-3", deliveryState: "wake_pending" },
      { ref: "session-3", deliveryState: "wake_pending" },
      { ref: "session-3", deliveryState: "idle" },
    ]);
  });

  it("marks wake retry exhaustion as failed", () => {
    const patches: Array<{ ref: string; patch: Record<string, unknown> }> = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, () => void> }) => {
        request.hooks?.onWakeStarted?.();
        request.hooks?.onWakeFailed?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (ref, patch) => patches.push({ ref, patch: patch as Record<string, unknown> }),
    );

    service.dispatch(
      { id: "session-4", harnessSessionId: "h-4" } as any,
      { label: "completed", wakeMessage: "done" },
    );

    assert.deepEqual(
      patches.map(({ ref, patch }) => ({
        ref,
        deliveryState: patch.deliveryState,
        completionWakeSummaryRequired: patch.completionWakeSummaryRequired,
        hasIssuedAt: typeof patch.completionWakeIssuedAt === "string",
        hasFailedAt: typeof patch.completionWakeFailedAt === "string",
      })),
      [
        {
          ref: "session-4",
          deliveryState: "wake_pending",
          completionWakeSummaryRequired: true,
          hasIssuedAt: true,
          hasFailedAt: false,
        },
        {
          ref: "session-4",
          deliveryState: "failed",
          completionWakeSummaryRequired: true,
          hasIssuedAt: false,
          hasFailedAt: true,
        },
      ],
    );
  });

  it("records completion wake diagnostics for terminal completion paths", () => {
    const patches: Array<{ ref: string; patch: Record<string, unknown> }> = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, () => void> }) => {
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeStarted?.();
        request.hooks?.onWakeSucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (ref, patch) => patches.push({ ref, patch: patch as Record<string, unknown> }),
    );

    service.dispatch(
      { id: "session-5", harnessSessionId: "h-5" } as any,
      {
        label: "completed",
        userMessage: "done",
        wakeMessageOnNotifySuccess: "wake",
        notifyUser: "always",
      },
    );

    assert.deepEqual(
      patches.map(({ ref, patch }) => ({
        ref,
        deliveryState: patch.deliveryState,
        completionWakeSummaryRequired: patch.completionWakeSummaryRequired,
        hasIssuedAt: typeof patch.completionWakeIssuedAt === "string",
        hasSucceededAt: typeof patch.completionWakeSucceededAt === "string",
        hasFailedAt: typeof patch.completionWakeFailedAt === "string",
      })),
      [
        {
          ref: "session-5",
          deliveryState: "notifying",
          completionWakeSummaryRequired: undefined,
          hasIssuedAt: false,
          hasSucceededAt: false,
          hasFailedAt: false,
        },
        {
          ref: "session-5",
          deliveryState: "wake_pending",
          completionWakeSummaryRequired: undefined,
          hasIssuedAt: false,
          hasSucceededAt: false,
          hasFailedAt: false,
        },
        {
          ref: "session-5",
          deliveryState: "wake_pending",
          completionWakeSummaryRequired: true,
          hasIssuedAt: true,
          hasSucceededAt: false,
          hasFailedAt: false,
        },
        {
          ref: "session-5",
          deliveryState: "idle",
          completionWakeSummaryRequired: true,
          hasIssuedAt: false,
          hasSucceededAt: true,
          hasFailedAt: false,
        },
      ],
    );
  });
});
