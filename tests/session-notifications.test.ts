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
      { ref: "h-1", deliveryState: "notifying" },
      { ref: "h-1", deliveryState: "idle" },
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
      { ref: "h-2", deliveryState: "notifying" },
      { ref: "h-2", deliveryState: "failed" },
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
      { ref: "h-3", deliveryState: "notifying" },
      { ref: "h-3", deliveryState: "wake_pending" },
      { ref: "h-3", deliveryState: "wake_pending" },
      { ref: "h-3", deliveryState: "idle" },
    ]);
  });

  it("marks wake retry exhaustion as failed", () => {
    const patches: Array<{ ref: string; deliveryState?: string }> = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, () => void> }) => {
        request.hooks?.onWakeStarted?.();
        request.hooks?.onWakeFailed?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (ref, patch) => patches.push({ ref, deliveryState: patch.deliveryState }),
    );

    service.dispatch(
      { id: "session-4", harnessSessionId: "h-4" } as any,
      { label: "completed", wakeMessage: "done" },
    );

    assert.deepEqual(patches, [
      { ref: "h-4", deliveryState: "wake_pending" },
      { ref: "h-4", deliveryState: "failed" },
    ]);
  });
});
