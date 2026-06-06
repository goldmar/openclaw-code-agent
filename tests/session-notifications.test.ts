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

  it("suppresses duplicate idempotent notifications and persists the delivered key", () => {
    const persisted = { notificationDedupe: undefined } as any;
    const requests: Array<Record<string, unknown>> = [];
    const skippedReasons: string[] = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (_ref, patch) => Object.assign(persisted, patch),
      { getPersistedSession: () => persisted },
    );
    const session = {
      id: "session-idempotent-notify",
      harnessSessionId: "h-idempotent-notify",
      route: {
        provider: "telegram",
        target: "topic",
        threadId: "42",
        sessionKey: "agent:x:telegram:channel:topic:topic:42",
      },
    } as any;
    const request = {
      label: "plan-approval",
      idempotencyKey: "plan-approval:session-idempotent-notify:v1:canonical",
      userMessage: "Plan v1 needs approval",
      notifyUser: "always" as const,
      hooks: {
        onDuplicateSkipped: (reason?: string) => skippedReasons.push(reason ?? ""),
      },
    };

    service.dispatch(session, request);
    service.dispatch(session, request);

    assert.equal(requests.length, 1);
    assert.match(String(requests[0]?.idempotencyKey), /^notification:[0-9a-f]{16}$/);
    assert.notEqual(requests[0]?.idempotencyKey, request.idempotencyKey);
    assert.deepEqual(skippedReasons, ["duplicate notification already delivered or in flight"]);
    assert.equal(persisted.notificationDedupe?.length, 1);
    assert.equal(persisted.notificationDedupe?.[0]?.status, "delivered");
    assert.equal(persisted.notificationDedupe?.[0]?.label, "plan-approval");
  });

  it("suppresses duplicate idempotent notifications while the first delivery is in flight", () => {
    const persisted = { notificationDedupe: undefined } as any;
    const requests: Array<{ hooks?: Record<string, (reason?: string) => void> }> = [];
    const skippedReasons: string[] = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request);
        request.hooks?.onNotifyStarted?.();
      },
      dispose: () => {},
    };
    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (_ref, patch) => Object.assign(persisted, patch),
      { getPersistedSession: () => persisted },
    );
    const session = { id: "session-in-flight-dedupe", harnessSessionId: "h-in-flight-dedupe" } as any;
    const request = {
      label: "plan-approval",
      idempotencyKey: "plan-approval:session-in-flight-dedupe:v1:canonical",
      userMessage: "Plan v1 needs approval",
      notifyUser: "always" as const,
      hooks: {
        onDuplicateSkipped: (reason?: string) => skippedReasons.push(reason ?? ""),
      },
    };

    service.dispatch(session, request);
    service.dispatch(session, request);

    assert.equal(requests.length, 1);
    assert.equal(persisted.notificationDedupe?.[0]?.status, "in_flight");
    assert.deepEqual(skippedReasons, ["duplicate notification already delivered or in flight"]);

    requests[0]?.hooks?.onNotifySucceeded?.();

    assert.equal(persisted.notificationDedupe?.[0]?.status, "delivered");
  });

  it("allows the same semantic notification key on different delivery routes", () => {
    const persistedByRef = new Map<string, any>();
    const requests: Array<Record<string, unknown>> = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, () => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
      },
      dispose: () => {},
    };
    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (ref, patch) => {
        const persisted = persistedByRef.get(ref) ?? {};
        Object.assign(persisted, patch);
        persistedByRef.set(ref, persisted);
      },
      { getPersistedSession: (ref) => persistedByRef.get(ref) },
    );
    const baseRequest = {
      label: "plan-approval",
      idempotencyKey: "plan-approval:shared:v1:canonical",
      userMessage: "Plan v1 needs approval",
      notifyUser: "always" as const,
    };

    service.dispatch(
      {
        id: "session-route-a",
        route: { provider: "telegram", target: "chat-a", threadId: "1", sessionKey: "session:a" },
      } as any,
      baseRequest,
    );
    service.dispatch(
      {
        id: "session-route-b",
        route: { provider: "telegram", target: "chat-b", threadId: "1", sessionKey: "session:b" },
      } as any,
      baseRequest,
    );

    assert.equal(requests.length, 2);
    assert.match(String(requests[0]?.idempotencyKey), /^notification:[0-9a-f]{16}$/);
    assert.match(String(requests[1]?.idempotencyKey), /^notification:[0-9a-f]{16}$/);
    assert.notEqual(requests[0]?.idempotencyKey, requests[1]?.idempotencyKey);
    assert.equal(persistedByRef.get("session-route-a")?.notificationDedupe?.[0]?.status, "delivered");
    assert.equal(persistedByRef.get("session-route-b")?.notificationDedupe?.[0]?.status, "delivered");
  });

  it("uses persisted idempotency records to suppress duplicates after service restart", () => {
    const persisted = { notificationDedupe: undefined } as any;
    const session = { id: "session-restarted-dedupe", harnessSessionId: "h-restarted-dedupe" } as any;
    const request = {
      label: "worktree-outcome",
      idempotencyKey: "worktree-outcome:terminal:session-restarted-dedupe",
      userMessage: "PR opened",
      notifyUser: "always" as const,
    };
    const firstDispatcher = {
      dispatchSessionNotification: (_session: unknown, dispatched: { hooks?: Record<string, () => void> }) => {
        dispatched.hooks?.onNotifyStarted?.();
        dispatched.hooks?.onNotifySucceeded?.();
      },
      dispose: () => {},
    };
    const firstService = new SessionNotificationService(
      firstDispatcher as any,
      (_ref, patch) => Object.assign(persisted, patch),
      { getPersistedSession: () => persisted },
    );

    firstService.dispatch(session, request);

    let restartedDispatches = 0;
    const restartedService = new SessionNotificationService(
      {
        dispatchSessionNotification: () => { restartedDispatches += 1; },
        dispose: () => {},
      } as any,
      (_ref, patch) => Object.assign(persisted, patch),
      { getPersistedSession: () => persisted },
    );

    restartedService.dispatch(session, request);

    assert.equal(restartedDispatches, 0);
    assert.equal(persisted.notificationDedupe?.[0]?.status, "delivered");
  });

  it("releases an idempotency key after notify-only delivery fails", () => {
    const persisted = { notificationDedupe: undefined } as any;
    let attempts = 0;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, () => void> }) => {
        attempts += 1;
        request.hooks?.onNotifyStarted?.();
        if (attempts === 1) {
          request.hooks?.onNotifyFailed?.();
        } else {
          request.hooks?.onNotifySucceeded?.();
        }
      },
      dispose: () => {},
    };
    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (_ref, patch) => Object.assign(persisted, patch),
      { getPersistedSession: () => persisted },
    );
    const session = { id: "session-retry-idempotent", harnessSessionId: "h-retry-idempotent" } as any;
    const request = {
      label: "launch",
      idempotencyKey: "launch:session-retry-idempotent",
      userMessage: "launched",
      notifyUser: "always" as const,
    };

    service.dispatch(session, request);
    service.dispatch(session, request);

    assert.equal(attempts, 2);
    assert.equal(persisted.notificationDedupe?.length, 1);
    assert.equal(persisted.notificationDedupe?.[0]?.status, "delivered");
  });

  it("releases an idempotency key when shouldDispatch cancels before delivery", () => {
    const persisted = { notificationDedupe: undefined } as any;
    let attempts = 0;
    let shouldDispatch = false;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { shouldDispatch?: () => boolean; hooks?: Record<string, () => void> }) => {
        attempts += 1;
        if (request.shouldDispatch?.() === false) return;
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
      },
      dispose: () => {},
    };
    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (_ref, patch) => Object.assign(persisted, patch),
      { getPersistedSession: () => persisted },
    );
    const session = { id: "session-stale-plan", harnessSessionId: "h-stale-plan" } as any;
    const request = {
      label: "plan-approval",
      idempotencyKey: "plan-approval:session-stale-plan:v2:canonical",
      userMessage: "Plan v2 needs approval",
      notifyUser: "always" as const,
      shouldDispatch: () => shouldDispatch,
    };

    service.dispatch(session, request);
    shouldDispatch = true;
    service.dispatch(session, request);

    assert.equal(attempts, 2);
    assert.equal(persisted.notificationDedupe?.length, 1);
    assert.equal(persisted.notificationDedupe?.[0]?.status, "delivered");
  });

  it("releases an idempotency key when a guarded wake fallback is canceled", () => {
    const persisted = { notificationDedupe: undefined } as any;
    let attempts = 0;
    let shouldDispatch = true;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { shouldDispatch?: () => boolean; hooks?: Record<string, () => void> }) => {
        attempts += 1;
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifyFailed?.();
        shouldDispatch = attempts > 1;
        if (request.shouldDispatch?.() === false) return;
        request.hooks?.onWakeStarted?.();
        request.hooks?.onWakeSucceeded?.();
      },
      dispose: () => {},
    };
    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (_ref, patch) => Object.assign(persisted, patch),
      { getPersistedSession: () => persisted },
    );
    const session = { id: "session-stale-fallback", harnessSessionId: "h-stale-fallback" } as any;
    const request = {
      label: "plan-approval-fallback",
      idempotencyKey: "plan-approval:session-stale-fallback:v3:fallback",
      userMessage: "Plan v3 fallback",
      wakeMessageOnNotifyFailed: "Plan delivery failed",
      notifyUser: "always" as const,
      shouldDispatch: () => shouldDispatch,
    };

    service.dispatch(session, request);
    service.dispatch(session, request);

    assert.equal(attempts, 2);
    assert.equal(persisted.notificationDedupe?.length, 1);
    assert.equal(persisted.notificationDedupe?.[0]?.status, "delivered");
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
      { label: "completed", wakeMessage: "done", completionWakeSummaryRequired: true },
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
        completionWakeSummaryRequired: true,
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
          completionWakeSummaryRequired: true,
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
          completionWakeSummaryRequired: undefined,
          hasIssuedAt: false,
          hasSucceededAt: true,
          hasFailedAt: false,
        },
      ],
    );
  });

  it("persists completion repair state after notify success before a deferred wake starts", () => {
    const patches: Array<{ ref: string; patch: Record<string, unknown> }> = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, () => void> }) => {
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (ref, patch) => patches.push({ ref, patch: patch as Record<string, unknown> }),
    );

    service.notifyWorktreeOutcome(
      { id: "session-deferred", harnessSessionId: "h-deferred", name: "deferred-worktree" } as any,
      "✅ [deferred-worktree] Branch merged.",
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
          ref: "session-deferred",
          deliveryState: "notifying",
          completionWakeSummaryRequired: undefined,
          hasIssuedAt: false,
          hasSucceededAt: false,
          hasFailedAt: false,
        },
        {
          ref: "session-deferred",
          deliveryState: "wake_pending",
          completionWakeSummaryRequired: true,
          hasIssuedAt: false,
          hasSucceededAt: false,
          hasFailedAt: false,
        },
      ],
    );
  });

  it("records explicit completion follow-up skips and clears retry state", () => {
    const patches: Array<{ ref: string; patch: Record<string, unknown> }> = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeStarted?.();
        request.hooks?.onWakeSkipped?.("internal pipeline continuing");
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (ref, patch) => patches.push({ ref, patch: patch as Record<string, unknown> }),
    );

    service.dispatch(
      { id: "session-skip", harnessSessionId: "h-skip" } as any,
      {
        label: "completed",
        userMessage: "done",
        wakeMessageOnNotifySuccess: "wake",
        completionWakeSummaryRequired: true,
        notifyUser: "always",
      },
    );

    const lastPatch = patches.at(-1)?.patch;
    assert.equal(lastPatch?.deliveryState, "idle");
    assert.equal(lastPatch?.completionWakeSummaryRequired, undefined);
    assert.equal(lastPatch?.completionWakeSucceededAt, undefined);
    assert.equal(lastPatch?.completionWakeFailedAt, undefined);
    assert.equal(typeof lastPatch?.completionWakeSkippedAt, "string");
    assert.equal(lastPatch?.completionWakeSkipReason, "internal pipeline continuing");
  });

  it("suppresses duplicate completion follow-up wakes for the same terminal wake payload", () => {
    const patches: Array<{ ref: string; patch: Record<string, unknown> }> = [];
    const requests: Array<Record<string, unknown>> = [];
    let wakeStarted = 0;
    let wakeSucceeded = 0;
    let duplicateSkippedReason = "";
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeStarted?.();
        wakeStarted += 1;
        request.hooks?.onWakeSucceeded?.();
        wakeSucceeded += 1;
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (ref, patch) => patches.push({ ref, patch: patch as Record<string, unknown> }),
    );
    const session = { id: "session-duplicate-summary", harnessSessionId: "h-duplicate-summary" } as any;
    const request = {
      label: "completed",
      userMessage: "done",
      wakeMessageOnNotifySuccess: "wake: send summary",
      completionWakeSummaryRequired: true,
      notifyUser: "always" as const,
      hooks: {
        onWakeSkipped: (reason?: string) => {
          duplicateSkippedReason = reason ?? "";
        },
      },
    };

    service.dispatch(session, request);
    service.dispatch(session, request);

    assert.equal(requests.length, 1);
    assert.equal(wakeStarted, 1);
    assert.equal(wakeSucceeded, 1);
    assert.equal(duplicateSkippedReason, "duplicate completion follow-up wake already handled");
    assert.equal(patches.filter(({ patch }) => patch.completionWakeSucceededAt).length, 1);
  });

  it("suppresses completion follow-up prompt variants for the same terminal outcome key", () => {
    const requests: Array<Record<string, unknown>> = [];
    const skippedReasons: string[] = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeStarted?.();
        request.hooks?.onWakeSucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const session = { id: "session-same-terminal-outcome", harnessSessionId: "h-same-terminal-outcome" } as any;
    const hooks = {
      onWakeSkipped: (reason?: string) => {
        skippedReasons.push(reason ?? "");
      },
    };

    service.dispatch(session, {
      label: "completed",
      userMessage: "✅ [editable-running-goals] Completed",
      wakeMessageOnNotifySuccess: "generic terminal completion wake",
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "terminal:session-same-terminal-outcome",
      notifyUser: "always",
    });
    service.dispatch(session, {
      label: "worktree-outcome",
      userMessage: "✅ PR updated: https://github.example.test/repo/pull/165",
      wakeMessageOnNotifySuccess: "richer PR outcome wake with different text",
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "terminal:session-same-terminal-outcome",
      notifyUser: "always",
      hooks,
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => ({
        label: request.label,
        userMessage: request.userMessage,
        wakeMessageOnNotifySuccess: request.wakeMessageOnNotifySuccess,
        completionWakeSummaryRequired: request.completionWakeSummaryRequired,
      })),
      [
        {
          label: "completed",
          userMessage: "✅ [editable-running-goals] Completed",
          wakeMessageOnNotifySuccess: "generic terminal completion wake",
          completionWakeSummaryRequired: true,
        },
        {
          label: "worktree-outcome",
          userMessage: "✅ PR updated: https://github.example.test/repo/pull/165",
          wakeMessageOnNotifySuccess: undefined,
          completionWakeSummaryRequired: false,
        },
      ],
    );
    assert.deepEqual(skippedReasons, ["duplicate completion follow-up wake already handled"]);
  });

  it("suppresses a terminal completion follow-up after a goal success follow-up for the same goal-owned session", () => {
    const requests: Array<Record<string, unknown>> = [];
    const skippedReasons: string[] = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeStarted?.();
        request.hooks?.onWakeSucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const session = {
      id: "goal-owned-session",
      harnessSessionId: "h-goal-owned-session",
      goalTaskId: "goal-123",
    } as any;

    service.dispatch(session, {
      label: "goal-task-succeeded",
      userMessage: "✅ [paper-watcher] Goal task succeeded",
      wakeMessageOnNotifySuccess: "goal success follow-up wake",
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "goal:goal-123",
      notifyUser: "always",
    });
    service.dispatch(session, {
      label: "completed",
      userMessage: "✅ [paper-watcher] Completed",
      wakeMessageOnNotifySuccess: "ordinary terminal completion wake",
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "terminal:goal-owned-session",
      notifyUser: "always",
      hooks: {
        onWakeSkipped: (reason?: string) => {
          skippedReasons.push(reason ?? "");
        },
      },
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => ({
        label: request.label,
        userMessage: request.userMessage,
        wakeMessageOnNotifySuccess: request.wakeMessageOnNotifySuccess,
        completionWakeSummaryRequired: request.completionWakeSummaryRequired,
      })),
      [
        {
          label: "goal-task-succeeded",
          userMessage: "✅ [paper-watcher] Goal task succeeded",
          wakeMessageOnNotifySuccess: "goal success follow-up wake",
          completionWakeSummaryRequired: true,
        },
        {
          label: "completed",
          userMessage: "✅ [paper-watcher] Completed",
          wakeMessageOnNotifySuccess: undefined,
          completionWakeSummaryRequired: false,
        },
      ],
    );
    assert.deepEqual(skippedReasons, ["duplicate completion follow-up wake already handled"]);
  });

  it("suppresses a goal success follow-up after a terminal completion follow-up for the same goal-owned session", () => {
    const requests: Array<Record<string, unknown>> = [];
    const skippedReasons: string[] = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeStarted?.();
        request.hooks?.onWakeSucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const session = {
      id: "goal-owned-session-terminal-first",
      harnessSessionId: "h-goal-owned-session-terminal-first",
      goalTaskId: "goal-terminal-first",
    } as any;

    service.dispatch(session, {
      label: "completed",
      userMessage: "✅ [paper-watcher] Completed",
      wakeMessageOnNotifySuccess: "ordinary terminal completion wake",
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "terminal:goal-owned-session-terminal-first",
      notifyUser: "always",
    });
    service.dispatch(session, {
      label: "goal-task-succeeded",
      userMessage: "✅ [paper-watcher] Goal task succeeded",
      wakeMessageOnNotifySuccess: "goal success follow-up wake",
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "goal:goal-terminal-first",
      notifyUser: "always",
      hooks: {
        onWakeSkipped: (reason?: string) => {
          skippedReasons.push(reason ?? "");
        },
      },
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.wakeMessageOnNotifySuccess, "ordinary terminal completion wake");
    assert.equal(requests[0]?.completionWakeSummaryRequired, true);
    assert.equal(requests[1]?.label, "goal-task-succeeded");
    assert.equal(requests[1]?.userMessage, "✅ [paper-watcher] Goal task succeeded");
    assert.equal(requests[1]?.wakeMessageOnNotifySuccess, undefined);
    assert.equal(requests[1]?.completionWakeSummaryRequired, false);
    assert.deepEqual(skippedReasons, ["duplicate completion follow-up wake already handled"]);
  });

  it("suppresses a goal success follow-up after a PR outcome follow-up for the same goal-owned session", () => {
    const requests: Array<Record<string, unknown>> = [];
    const skippedReasons: string[] = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeStarted?.();
        request.hooks?.onWakeSucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const route = {
      provider: "telegram",
      target: "example-chat",
      threadId: "example-topic",
      sessionKey: "agent:x:telegram:channel:example-chat:topic:example-topic",
    };
    const worktreeTarget = {
      id: "goal-owned-pr-session",
      harnessSessionId: "h-goal-owned-pr-session",
      name: "paper-watcher",
      route,
      goalTaskId: "goal-pr-merged",
    } as any;
    const goalRoutingProxy = {
      id: "goal-owned-pr-session",
      harnessSessionId: "h-goal-owned-pr-session",
      name: "paper-watcher",
      route,
    } as any;

    service.notifyWorktreeOutcome(
      worktreeTarget,
      "✅ PR opened: https://github.example.test/repo/pull/1",
      {
        completionWakeOutcomeKey: "worktree-pr:opened:example/repo:#1:agent/example",
        detailLines: ["PR number: #1."],
      },
    );
    service.dispatch(goalRoutingProxy, {
      label: "goal-task-succeeded",
      userMessage: "✅ [paper-watcher] Goal task succeeded",
      wakeMessageOnNotifySuccess: "goal success follow-up wake with same PR details",
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "goal:goal-pr-merged",
      notifyUser: "always",
      hooks: {
        onWakeSkipped: (reason?: string) => {
          skippedReasons.push(reason ?? "");
        },
      },
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.label, "worktree-outcome");
    assert.equal(requests[0]?.completionWakeSummaryRequired, true);
    assert.equal(typeof requests[0]?.wakeMessageOnNotifySuccess, "string");
    assert.equal(requests[1]?.label, "goal-task-succeeded");
    assert.equal(requests[1]?.wakeMessageOnNotifySuccess, undefined);
    assert.equal(requests[1]?.completionWakeSummaryRequired, false);
    assert.deepEqual(skippedReasons, ["duplicate completion follow-up wake already handled"]);
  });

  it("suppresses a PR outcome follow-up after a goal success follow-up for the same goal-owned session", () => {
    const requests: Array<Record<string, unknown>> = [];
    let wakeAttempts = 0;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: Record<string, unknown> & { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        if (request.wakeMessage || request.wakeMessageOnNotifySuccess || request.wakeMessageOnNotifyFailed) {
          wakeAttempts += 1;
          request.hooks?.onWakeStarted?.();
          request.hooks?.onWakeSucceeded?.();
        }
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const route = {
      provider: "telegram",
      target: "example-chat",
      threadId: "example-topic",
      sessionKey: "agent:x:telegram:channel:example-chat:topic:example-topic",
    };
    const goalRoutingProxy = {
      id: "goal-owned-pr-session-goal-first",
      harnessSessionId: "h-goal-owned-pr-session-goal-first",
      name: "paper-watcher",
      route,
    } as any;
    const worktreeTarget = {
      id: "goal-owned-pr-session-goal-first",
      harnessSessionId: "h-goal-owned-pr-session-goal-first",
      name: "paper-watcher",
      route,
      goalTaskId: "goal-pr-merged-goal-first",
    } as any;

    service.dispatch(goalRoutingProxy, {
      label: "goal-task-succeeded",
      userMessage: "✅ [paper-watcher] Goal task succeeded",
      wakeMessageOnNotifySuccess: "goal success follow-up wake with PR details",
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "goal:goal-pr-merged-goal-first",
      notifyUser: "always",
    });
    service.notifyWorktreeOutcome(
      worktreeTarget,
      "✅ PR opened: https://github.example.test/repo/pull/1",
      {
        completionWakeOutcomeKey: "worktree-pr:opened:example/repo:#1:agent/example",
        detailLines: ["PR number: #1."],
      },
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.label, "goal-task-succeeded");
    assert.equal(requests[0]?.completionWakeSummaryRequired, true);
    assert.equal(requests[0]?.wakeMessageOnNotifySuccess, "goal success follow-up wake with PR details");
    assert.equal(requests[1]?.label, "worktree-outcome");
    assert.equal(requests[1]?.wakeMessageOnNotifySuccess, undefined);
    assert.equal(requests[1]?.completionWakeSummaryRequired, false);
    assert.equal(wakeAttempts, 1);
  });

  it("allows a retry for the same goal terminal outcome after the follow-up wake fails", () => {
    const requests: Array<Record<string, unknown>> = [];
    let wakeAttempts = 0;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: Record<string, unknown> & { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeStarted?.();
        wakeAttempts += 1;
        if (wakeAttempts === 1) {
          request.hooks?.onWakeFailed?.();
        } else {
          request.hooks?.onWakeSucceeded?.();
        }
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const session = {
      id: "goal-owned-retry-session",
      harnessSessionId: "h-goal-owned-retry-session",
      goalTaskId: "goal-retry",
    } as any;

    service.dispatch(session, {
      label: "goal-task-succeeded",
      userMessage: "✅ [paper-watcher] Goal task succeeded",
      wakeMessageOnNotifySuccess: "goal success follow-up wake",
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "goal:goal-retry",
      notifyUser: "always",
    });
    service.dispatch(session, {
      label: "completed",
      userMessage: "✅ [paper-watcher] Completed",
      wakeMessageOnNotifySuccess: "retry terminal completion wake",
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "terminal:goal-owned-retry-session",
      notifyUser: "always",
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.wakeMessageOnNotifySuccess),
      ["goal success follow-up wake", "retry terminal completion wake"],
    );
    assert.equal(wakeAttempts, 2);
  });

  it("deduplicates goal success summary wakes within the Trading Platform Telegram topic", () => {
    const requests: Array<Record<string, unknown>> = [];
    let wakeAttempts = 0;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: Record<string, unknown> & { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        if (request.wakeMessage || request.wakeMessageOnNotifySuccess || request.wakeMessageOnNotifyFailed) {
          wakeAttempts += 1;
          request.hooks?.onWakeStarted?.();
          request.hooks?.onWakeSucceeded?.();
        }
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const route = {
      provider: "telegram",
      target: "-1003863755361",
      threadId: "32947",
      sessionKey: "agent:x:telegram:channel:-1003863755361:topic:32947",
    };
    const session = {
      id: "trading-platform-readiness-gate-fix-restart",
      harnessSessionId: "h-trading-platform-readiness-gate-fix-restart",
      name: "trading-platform-readiness-gate-fix-restart",
      route,
      goalTaskId: "goal-readiness-gate-fix-restart",
    } as any;
    const goalStatus = [
      "✅ [trading-platform-readiness-gate-fix-restart] Goal task succeeded",
      "",
      'Completion promise "READINESS_GATE_FIX_RESTART_DONE" detected in agent output.',
    ].join("\n");

    service.dispatch(session, {
      label: "goal-task-succeeded",
      wakeMessage: [
        "Goal task succeeded.",
        goalStatus,
        'originRoute: {"provider":"telegram","target":"-1003863755361","threadId":"32947","sessionKey":"agent:x:telegram:channel:-1003863755361:topic:32947"}',
      ].join("\n"),
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "goal:goal-readiness-gate-fix-restart",
      notifyUser: "never",
    });
    service.dispatch(session, {
      label: "goal-task-succeeded",
      wakeMessage: "duplicate goal success follow-up wake",
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "goal:goal-readiness-gate-fix-restart",
      notifyUser: "never",
    });

    assert.equal(requests.length, 2);
    assert.equal(wakeAttempts, 1);
    assert.equal(requests[0]?.userMessage, undefined);
    assert.equal(requests[0]?.completionWakeSummaryRequired, true);
    assert.match(requests[0]?.wakeMessage as string, /"threadId":"32947"/);
    assert.equal(requests[1]?.userMessage, undefined);
    assert.equal(requests[1]?.completionWakeSummaryRequired, false);
    assert.equal(requests[1]?.wakeMessage, undefined);
  });

  it("shows exactly one substantive summary for goal success, promise detection, foreground summary, and terminal follow-up", () => {
    const requests: Array<Record<string, unknown>> = [];
    const userMessages: string[] = [];
    const skippedReasons: string[] = [];
    let wakeAttempts = 0;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: Record<string, unknown> & { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        if (typeof request.userMessage === "string" && request.userMessage.trim()) {
          userMessages.push(request.userMessage);
        }
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        if (request.wakeMessage || request.wakeMessageOnNotifySuccess || request.wakeMessageOnNotifyFailed) {
          wakeAttempts += 1;
        }
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const route = {
      provider: "telegram",
      target: "trading-topic-fixture",
      threadId: "32947",
      sessionKey: "agent:x:telegram:channel:trading-topic-fixture:topic:32947",
    };
    const session = {
      id: "trading-platform-full-repo-review-20-iter",
      harnessSessionId: "h-trading-platform-full-repo-review-20-iter",
      name: "trading-platform-full-repo-review-20-iter",
      route,
      goalTaskId: "goal-trading-platform-full-repo-review-20-iter",
    } as any;
    const goalStatus = [
      "✅ [trading-platform-full-repo-review-20-iter] Goal task succeeded",
      "",
      'Completion promise "TRADING_PLATFORM_FULL_REPO_REVIEW_20_ITER_DONE" detected in agent output.',
    ].join("\n");

    service.dispatch(session, {
      label: "goal-task-succeeded",
      wakeMessage: [
        "Goal task succeeded.",
        goalStatus,
        "Final result summary available in agent_output.",
      ].join("\n"),
      completionSummary: {
        required: true,
        producer: "goal",
        outcomeKey: "goal:goal-trading-platform-full-repo-review-20-iter",
      },
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "goal:goal-trading-platform-full-repo-review-20-iter",
      notifyUser: "never",
    });
    service.dispatch(session, {
      label: "goal-foreground-summary",
      userMessage: [
        "Second full-repo OCA review finished and pushed.",
        "Commit: `753f35f` - `Harden paper runtime approval and execution checks`",
        "Verification passed via `./scripts/check-workspace.sh`.",
      ].join("\n"),
      completionSummaryOwner: "foreground",
      completionSummary: {
        required: true,
        producer: "goal",
        outcomeKey: "goal:goal-trading-platform-full-repo-review-20-iter",
      },
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "goal:goal-trading-platform-full-repo-review-20-iter",
      notifyUser: "always",
    });
    (requests[0]?.hooks as Record<string, () => void> | undefined)?.onWakeSucceeded?.();
    service.dispatch(session, {
      label: "terminal-completed",
      wakeMessage: "terminal worktree/session follow-up summary wake",
      completionSummary: {
        required: true,
        producer: "terminal",
        outcomeKey: "terminal:trading-platform-full-repo-review-20-iter",
      },
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "terminal:trading-platform-full-repo-review-20-iter",
      notifyUser: "never",
      hooks: {
        onWakeSkipped: (reason?: string) => {
          skippedReasons.push(reason ?? "");
        },
      },
    });

    assert.equal(requests.length, 3);
    assert.equal(requests[0]?.userMessage, undefined);
    assert.match(requests[0]?.wakeMessage as string, /Completion promise "TRADING_PLATFORM_FULL_REPO_REVIEW_20_ITER_DONE" detected/);
    assert.equal(requests[1]?.userMessage, userMessages[0]);
    assert.equal(requests[1]?.wakeMessageOnNotifySuccess, undefined);
    assert.equal(requests[1]?.completionWakeSummaryRequired, false);
    assert.equal(requests[2]?.userMessage, undefined);
    assert.equal(requests[2]?.wakeMessage, undefined);
    assert.equal(requests[2]?.completionWakeSummaryRequired, false);
    assert.equal(userMessages.length, 1);
    assert.match(userMessages[0] ?? "", /Second full-repo OCA review finished and pushed/);
    assert.doesNotMatch(userMessages[0] ?? "", /Completion promise/);
    assert.equal(wakeAttempts, 1);
    assert.deepEqual(skippedReasons, ["COMPLETION_FOLLOWUP_SKIPPED: prior human-visible summary already delivered"]);
  });

  it("suppresses a later goal success wake after a same-topic foreground summary without goalTaskId", () => {
    const requests: Array<Record<string, unknown>> = [];
    const userMessages: string[] = [];
    const skippedReasons: string[] = [];
    let wakeAttempts = 0;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: Record<string, unknown> & { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        if (typeof request.userMessage === "string" && request.userMessage.trim()) {
          userMessages.push(request.userMessage);
        }
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        if (request.wakeMessage || request.wakeMessageOnNotifySuccess || request.wakeMessageOnNotifyFailed) {
          wakeAttempts += 1;
          request.hooks?.onWakeStarted?.();
          request.hooks?.onWakeSucceeded?.();
        }
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const route = {
      provider: "telegram",
      target: "trading-topic-fixture",
      threadId: "review-topic-fixture",
      sessionKey: "agent:x:telegram:channel:trading-topic-fixture:topic:review-topic-fixture",
    };
    const session = {
      id: "trading-platform-full-repo-review-2-20-iter",
      harnessSessionId: "h-trading-platform-full-repo-review-2-20-iter",
      name: "trading-platform-full-repo-review-2-20-iter",
      route,
    } as any;

    service.dispatch(session, {
      label: "goal-task-succeeded",
      userMessage: [
        "✅ [trading-platform-full-repo-review-2-20-iter] Goal task succeeded",
        "Session: trading-platform-full-repo-review-2-20-iter [session-fixture]",
      ].join("\n"),
      notifyUser: "always",
    });
    service.dispatch(session, {
      label: "foreground-routed-summary",
      userMessage: [
        "Full-repo OCA review finished and pushed.",
        "Commit `abc1234` (`Harden repo hygiene checks`).",
        "Two review/implementation iterations completed; verification passed.",
      ].join("\n"),
      completionSummaryOwner: "foreground",
      completionSummary: {
        required: true,
        producer: "terminal",
        outcomeKey: "terminal:trading-platform-full-repo-review-2-20-iter",
      },
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "terminal:trading-platform-full-repo-review-2-20-iter",
      notifyUser: "always",
    });
    service.dispatch(session, {
      label: "goal-task-succeeded",
      wakeMessage: "duplicate goal success follow-up wake",
      completionSummary: {
        required: true,
        producer: "goal",
        outcomeKey: "goal:goal-trading-platform-full-repo-review-2-20-iter",
      },
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "goal:goal-trading-platform-full-repo-review-2-20-iter",
      notifyUser: "never",
      hooks: {
        onWakeSkipped: (reason?: string) => {
          skippedReasons.push(reason ?? "");
        },
      },
    });

    assert.equal(requests.length, 3);
    assert.match(userMessages[0] ?? "", /Goal task succeeded/);
    assert.match(userMessages[1] ?? "", /Full-repo OCA review finished and pushed/);
    assert.equal(userMessages.length, 2);
    assert.equal(requests[1]?.completionWakeSummaryRequired, false);
    assert.equal(requests[2]?.wakeMessage, undefined);
    assert.equal(requests[2]?.completionWakeSummaryRequired, false);
    assert.equal(wakeAttempts, 0);
    assert.deepEqual(skippedReasons, ["COMPLETION_FOLLOWUP_SKIPPED: prior human-visible summary already delivered"]);
  });

  it("keeps iteration progress visible while final goal completion has one status and one summary wake", () => {
    const requests: Array<Record<string, unknown>> = [];
    const userMessages: string[] = [];
    const skippedReasons: string[] = [];
    let wakeAttempts = 0;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: Record<string, unknown> & { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        if (typeof request.userMessage === "string" && request.userMessage.trim()) {
          userMessages.push(request.userMessage);
        }
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        if (request.wakeMessage || request.wakeMessageOnNotifySuccess || request.wakeMessageOnNotifyFailed) {
          wakeAttempts += 1;
          request.hooks?.onWakeStarted?.();
          request.hooks?.onWakeSucceeded?.();
        }
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const session = {
      id: "trading-platform-full-repo-review-2-20-iter",
      harnessSessionId: "h-trading-platform-full-repo-review-2-20-iter",
      name: "trading-platform-full-repo-review-2-20-iter",
      route: {
        provider: "telegram",
        target: "trading-topic-fixture",
        threadId: "32947",
        sessionKey: "agent:x:telegram:channel:trading-topic-fixture:topic:32947",
      },
      goalTaskId: "goal-trading-platform-full-repo-review-2-20-iter",
    } as any;

    service.dispatch(session, {
      label: "goal-task-progress",
      userMessage: [
        "🔁 [trading-platform-full-repo-review-2-20-iter] Continued iteration 1/20",
        "",
        "Agent: Hardened paper runtime review guards.",
      ].join("\n"),
      notifyUser: "always",
    });
    service.dispatch(session, {
      label: "goal-task-succeeded",
      userMessage: [
        "✅ [trading-platform-full-repo-review-2-20-iter] Goal task succeeded",
        "Session: trading-platform-full-repo-review-2-20-iter [kzKq9Grv]",
      ].join("\n"),
      wakeMessageOnNotifySuccess: [
        "Goal task succeeded.",
        'Completion promise "TRADING_PLATFORM_FULL_REPO_REVIEW_2_20_ITER_DONE" detected in agent output.',
        "Use agent_output(session='kzKq9Grv', full=true) to send one factual summary.",
      ].join("\n"),
      completionSummary: {
        required: true,
        producer: "goal",
        outcomeKey: "goal:goal-trading-platform-full-repo-review-2-20-iter",
      },
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "goal:goal-trading-platform-full-repo-review-2-20-iter",
      notifyUser: "always",
    });
    service.dispatch(session, {
      label: "goal-task-progress",
      userMessage: "🔁 [trading-platform-full-repo-review-2-20-iter] Continued iteration 2/20",
      notifyUser: "always",
    });
    service.dispatch(session, {
      label: "terminal-completed",
      wakeMessage: "terminal worktree/session follow-up summary wake",
      completionSummary: {
        required: true,
        producer: "terminal",
        outcomeKey: "terminal:trading-platform-full-repo-review-2-20-iter",
      },
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "terminal:trading-platform-full-repo-review-2-20-iter",
      notifyUser: "never",
      hooks: {
        onWakeSkipped: (reason?: string) => {
          skippedReasons.push(reason ?? "");
        },
      },
    });

    assert.equal(requests.length, 4);
    assert.match(userMessages[0] ?? "", /Continued iteration 1\/20/);
    assert.match(userMessages[0] ?? "", /Agent: Hardened paper runtime review guards/);
    assert.doesNotMatch(userMessages[0] ?? "", /Iteration summary:/);
    assert.doesNotMatch(userMessages[0] ?? "", /Status: running/);
    assert.match(userMessages[1] ?? "", /Goal task succeeded/);
    assert.doesNotMatch(userMessages[1] ?? "", /Completion promise/);
    assert.match(userMessages[2] ?? "", /Continued iteration 2\/20/);
    assert.equal(userMessages.filter((message) => /Goal task succeeded/.test(message)).length, 1);
    assert.equal(wakeAttempts, 1);
    assert.equal(requests[3]?.wakeMessage, undefined);
    assert.equal(requests[3]?.completionWakeSummaryRequired, false);
    assert.deepEqual(skippedReasons, ["duplicate completion follow-up wake already handled"]);
  });

  it("uses the same completion outcome key for routed worktree follow-through prompts", () => {
    const requests: Array<Record<string, unknown>> = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeStarted?.();
        request.hooks?.onWakeSucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const session = {
      id: "session-routed-terminal-outcome",
      harnessSessionId: "h-routed-terminal-outcome",
      name: "routed-outcome",
      route: {
        provider: "telegram",
        target: "-100123",
        threadId: "32947",
        sessionKey: "agent:x:telegram:channel:-100123:topic:32947",
      },
    } as any;

    service.dispatch(session, {
      label: "completed",
      userMessage: "✅ [routed-outcome] Completed",
      wakeMessageOnNotifySuccess: "generic terminal completion wake",
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: "terminal:session-routed-terminal-outcome",
      notifyUser: "always",
    });
    service.notifyWorktreeOutcome(
      session,
      "✅ PR updated: https://github.example.test/repo/pull/165",
      { detailLines: ["PR number: #165."] },
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.label, "worktree-outcome");
    assert.equal(requests[1]?.userMessage, "✅ PR updated: https://github.example.test/repo/pull/165");
    assert.equal(requests[1]?.wakeMessageOnNotifySuccess, undefined);
    assert.equal(requests[1]?.completionWakeSummaryRequired, false);
  });

  it("requests one follow-up summary after a terse PR-updated status when agent output has the substantive summary", () => {
    const requests: Array<Record<string, unknown>> = [];
    const userMessages: string[] = [];
    let wakeAttempts = 0;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: Record<string, unknown> & { hooks?: Record<string, () => void> }) => {
        requests.push(request as Record<string, unknown>);
        if (typeof request.userMessage === "string" && request.userMessage.trim()) {
          userMessages.push(request.userMessage);
        }
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        if (request.wakeMessage || request.wakeMessageOnNotifySuccess || request.wakeMessageOnNotifyFailed) {
          wakeAttempts += 1;
          request.hooks?.onWakeStarted?.();
          request.hooks?.onWakeSucceeded?.();
        }
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const session = {
      id: "pr-174-update-session",
      harnessSessionId: "h-pr-174-update-session",
      name: "fix-trading-platform-goal-summary-dup",
      route: {
        provider: "telegram",
        target: "topic-fixture",
        threadId: "13832",
        sessionKey: "agent:x:telegram:channel:topic-fixture:topic:13832",
      },
    } as any;

    service.notifyWorktreeOutcome(
      session,
      "✅ PR updated: https://github.com/goldmar/openclaw-code-agent/pull/174",
      {
        completionWakeOutcomeKey: "worktree-pr:updated:goldmar/openclaw-code-agent:#174:agent/fix-trading-platform-goal-summary-dup:6b9c5a4",
        detailLines: [
          "Updated PR for branch agent/fix-trading-platform-goal-summary-dup into main.",
          "PR number: #174.",
          "Pushed 1 new commit (+57/-42).",
        ],
      },
    );

    assert.equal(requests.length, 1);
    assert.deepEqual(userMessages, ["✅ PR updated: https://github.com/goldmar/openclaw-code-agent/pull/174"]);
    assert.equal(requests[0]?.completionWakeSummaryRequired, true);
    assert.equal(requests[0]?.deferConditionalWakeMs, 2000);
    assert.equal(wakeAttempts, 1);
    assert.match(requests[0]?.wakeMessageOnNotifySuccess as string, /agent_output\(session='pr-174-update-session', full=true\)/);
    assert.match(requests[0]?.wakeMessageOnNotifySuccess as string, /If the visible result is only the plugin's terse status line/);
    assert.match(requests[0]?.wakeMessageOnNotifySuccess as string, /Do this even when agent_output already contains a good final summary/);
    assert.match(requests[0]?.wakeMessageOnNotifySuccess as string, /routed message tool send\/delivery mirror/);
  });

  it("suppresses duplicate opened PR follow-through wakes across session refs for the same routed outcome", () => {
    const requests: Array<Record<string, unknown>> = [];
    let wakeAttempts = 0;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: Record<string, unknown> & { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        if (request.wakeMessage || request.wakeMessageOnNotifySuccess || request.wakeMessageOnNotifyFailed) {
          wakeAttempts += 1;
          request.hooks?.onWakeStarted?.();
          request.hooks?.onWakeSucceeded?.();
        }
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const route = {
      provider: "telegram",
      target: "-100123",
      threadId: "13832",
      sessionKey: "agent:x:telegram:channel:-100123:topic:13832",
    };
    const firstTarget = {
      id: "active-session-ref",
      harnessSessionId: "h-active-session-ref",
      name: "pr-update",
      route,
    } as any;
    const secondTarget = {
      id: "persisted-session-ref",
      harnessSessionId: "h-persisted-session-ref",
      name: "pr-update",
      route,
    } as any;
    const outcomeKey = "worktree-pr:opened:goldmar/openclaw-code-agent:#171:agent/fix-duplicate-completion-notifications-0ce3:created";

    service.notifyWorktreeOutcome(
      firstTarget,
      "✅ PR opened: https://github.example.test/repo/pull/171",
      {
        completionWakeOutcomeKey: outcomeKey,
        detailLines: [
          "Opened PR for branch agent/fix-duplicate-completion-notifications-0ce3 into main.",
          "PR number: #171.",
        ],
      },
    );
    service.notifyWorktreeOutcome(
      secondTarget,
      "✅ PR opened: https://github.example.test/repo/pull/171",
      {
        completionWakeOutcomeKey: outcomeKey,
        detailLines: [
          "Opened PR for branch agent/fix-duplicate-completion-notifications-0ce3 into main.",
          "PR number: #171.",
        ],
      },
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.wakeMessageOnNotifySuccess === undefined, false);
    assert.equal(requests[0]?.completionWakeSummaryRequired, true);
    assert.equal(wakeAttempts, 1);
  });

  it("deduplicates PR follow-through summaries independently in the reported Telegram topics", () => {
    const requests: Array<Record<string, unknown>> = [];
    let wakeAttempts = 0;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: Record<string, unknown> & { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        if (request.wakeMessage || request.wakeMessageOnNotifySuccess || request.wakeMessageOnNotifyFailed) {
          wakeAttempts += 1;
          request.hooks?.onWakeStarted?.();
          request.hooks?.onWakeSucceeded?.();
        }
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const openClawTopic = {
      provider: "telegram",
      target: "-1003863755361",
      threadId: "13832",
      sessionKey: "agent:x:telegram:channel:-1003863755361:topic:13832",
    };
    const tradingPlatformTopic = {
      provider: "telegram",
      target: "-1003863755361",
      threadId: "32947",
      sessionKey: "agent:x:telegram:channel:-1003863755361:topic:32947",
    };
    const outcomeKey = "worktree-pr:opened:goldmar/openclaw-code-agent:#171:agent/fix-duplicate-completion-notifications-0ce3:created";
    const notify = (id: string, route: typeof openClawTopic) => service.notifyWorktreeOutcome(
      {
        id,
        harnessSessionId: `h-${id}`,
        name: "duplicate-completion-notifications",
        route,
      } as any,
      "✅ PR opened: https://github.com/goldmar/openclaw-code-agent/pull/171",
      {
        completionWakeOutcomeKey: outcomeKey,
        detailLines: [
          "Opened PR for branch agent/fix-duplicate-completion-notifications-0ce3 into main.",
          "PR number: #171.",
        ],
      },
    );

    notify("openclaw-topic-first", openClawTopic);
    notify("openclaw-topic-duplicate", openClawTopic);
    notify("trading-platform-topic-first", tradingPlatformTopic);
    notify("trading-platform-topic-duplicate", tradingPlatformTopic);

    assert.equal(requests.length, 2);
    assert.equal(wakeAttempts, 2);
    assert.deepEqual(
      requests.map((request) => ({
        label: request.label,
        completionWakeSummaryRequired: request.completionWakeSummaryRequired,
        hasWake: typeof request.wakeMessageOnNotifySuccess === "string",
      })),
      [
        { label: "worktree-outcome", completionWakeSummaryRequired: true, hasWake: true },
        { label: "worktree-outcome", completionWakeSummaryRequired: true, hasWake: true },
      ],
    );
    assert.match(requests[0]?.wakeMessageOnNotifySuccess as string, /"threadId":"13832"/);
    assert.match(requests[1]?.wakeMessageOnNotifySuccess as string, /"threadId":"32947"/);
  });

  it("suppresses a routed PR follow-up after a foreground summary already owned topic 13832", () => {
    const requests: Array<Record<string, unknown>> = [];
    const skippedReasons: string[] = [];
    let wakeAttempts = 0;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: Record<string, unknown> & { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        if (request.wakeMessage || request.wakeMessageOnNotifySuccess || request.wakeMessageOnNotifyFailed) {
          wakeAttempts += 1;
          request.hooks?.onWakeStarted?.();
          request.hooks?.onWakeSucceeded?.();
        }
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const route = {
      provider: "telegram",
      target: "topic-fixture",
      threadId: "13832",
      sessionKey: "agent:x:telegram:channel:topic-fixture:topic:13832",
    };
    const outcomeKey = "worktree-pr:updated:goldmar/openclaw-code-agent:#172:agent/centralize-completion-summary-owner:commit-fixture";
    const foregroundTarget = {
      id: "pr-172-foreground",
      harnessSessionId: "h-pr-172-foreground",
      name: "centralize-completion-summary-owner",
      route,
    } as any;
    const routedTarget = {
      id: "pr-172-routed-followup",
      harnessSessionId: "h-pr-172-routed-followup",
      name: "centralize-completion-summary-owner",
      route,
    } as any;

    service.notifyWorktreeOutcome(
      foregroundTarget,
      "✅ PR updated: https://github.com/goldmar/openclaw-code-agent/pull/172",
      {
        completionSummaryOwner: "foreground",
        completionWakeOutcomeKey: outcomeKey,
        detailLines: [
          "Updated draft PR for branch agent/centralize-completion-summary-owner.",
          "Validation completed with focused tests and build.",
        ],
      },
    );
    service.dispatch(routedTarget, {
      label: "worktree-outcome",
      userMessage: "✅ PR updated: https://github.com/goldmar/openclaw-code-agent/pull/172",
      wakeMessageOnNotifySuccess: "routed duplicate PR #172 summary",
      completionSummary: {
        required: true,
        producer: "worktree-pr",
        outcomeKey,
      },
      completionWakeSummaryRequired: true,
      completionWakeOutcomeKey: outcomeKey,
      notifyUser: "always",
      hooks: {
        onWakeSkipped: (reason?: string) => {
          skippedReasons.push(reason ?? "");
        },
      },
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.userMessage, "✅ PR updated: https://github.com/goldmar/openclaw-code-agent/pull/172");
    assert.equal(requests[0]?.completionWakeSummaryRequired, false);
    assert.equal(requests[0]?.wakeMessageOnNotifySuccess, undefined);
    assert.equal(requests[1]?.completionWakeSummaryRequired, false);
    assert.equal(requests[1]?.wakeMessageOnNotifySuccess, undefined);
    assert.equal(wakeAttempts, 0);
    assert.deepEqual(skippedReasons, ["COMPLETION_FOLLOWUP_SKIPPED: prior human-visible summary already delivered"]);
  });

  it("suppresses a PR #175 follow-through wake after a substantive same-topic routed summary is visible", () => {
    const requests: Array<Record<string, unknown>> = [];
    const userMessages: string[] = [];
    const skippedReasons: string[] = [];
    let wakeAttempts = 0;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: Record<string, unknown> & { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        if (typeof request.userMessage === "string" && request.userMessage.trim()) {
          userMessages.push(request.userMessage);
        }
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        if (request.wakeMessage || request.wakeMessageOnNotifySuccess || request.wakeMessageOnNotifyFailed) {
          wakeAttempts += 1;
          request.hooks?.onWakeStarted?.();
          request.hooks?.onWakeSucceeded?.();
        }
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const route = {
      provider: "telegram",
      target: "openclaw-topic-fixture",
      threadId: "13832",
      sessionKey: "agent:x:telegram:channel:openclaw-topic-fixture:topic:13832",
    };
    const outcomeKey = "worktree-pr:updated:goldmar/openclaw-code-agent:#175:agent/fix-goal-iteration-completion-notifications:a0de54a";
    const session = {
      id: "pr-175-update-session",
      harnessSessionId: "h-pr-175-update-session",
      name: "fix-goal-iteration-completion-notifications",
      route,
    } as any;

    service.dispatch(session, {
      label: "worktree-outcome",
      userMessage: "✅ PR updated: https://github.com/goldmar/openclaw-code-agent/pull/175",
      notifyUser: "always",
    });
    service.dispatch(
      { ...session, id: "pr-175-foreground-routed-summary" },
      {
        label: "worktree-foreground-summary",
        userMessage: [
          "PR #175 is open and updated.",
          "Restored a sanitized visible goal success status and explicit iteration 1/20 progress.",
          "Commit: a0de54a. Verification passed.",
        ].join("\n"),
        completionSummaryOwner: "foreground",
        completionSummary: {
          required: true,
          producer: "worktree-pr",
          outcomeKey,
        },
        completionWakeSummaryRequired: true,
        completionWakeOutcomeKey: outcomeKey,
        notifyUser: "always",
      },
    );
    service.dispatch(
      { ...session, id: "pr-175-later-routed-followup" },
      {
        label: "worktree-outcome",
        userMessage: "✅ PR updated: https://github.com/goldmar/openclaw-code-agent/pull/175",
        wakeMessageOnNotifySuccess: "duplicate PR #175 follow-through summary wake",
        completionSummary: {
          required: true,
          producer: "worktree-pr",
          outcomeKey,
        },
        completionWakeSummaryRequired: true,
        completionWakeOutcomeKey: outcomeKey,
        notifyUser: "always",
        hooks: {
          onWakeSkipped: (reason?: string) => {
            skippedReasons.push(reason ?? "");
          },
        },
      },
    );

    assert.equal(requests.length, 3);
    assert.deepEqual(userMessages, [
      "✅ PR updated: https://github.com/goldmar/openclaw-code-agent/pull/175",
      [
        "PR #175 is open and updated.",
        "Restored a sanitized visible goal success status and explicit iteration 1/20 progress.",
        "Commit: a0de54a. Verification passed.",
      ].join("\n"),
      "✅ PR updated: https://github.com/goldmar/openclaw-code-agent/pull/175",
    ]);
    assert.notEqual(requests[0]?.completionWakeSummaryRequired, true);
    assert.equal(requests[1]?.completionWakeSummaryRequired, false);
    assert.equal(requests[2]?.completionWakeSummaryRequired, false);
    assert.equal(requests[2]?.wakeMessageOnNotifySuccess, undefined);
    assert.equal(wakeAttempts, 0);
    assert.deepEqual(skippedReasons, ["COMPLETION_FOLLOWUP_SKIPPED: prior human-visible summary already delivered"]);
  });

  it("keeps materially new PR follow-through outcomes visible for the same route", () => {
    const requests: Array<Record<string, unknown>> = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeStarted?.();
        request.hooks?.onWakeSucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const session = {
      id: "pr-update-session",
      harnessSessionId: "h-pr-update-session",
      route: {
        provider: "telegram",
        target: "-100123",
        threadId: "13832",
      },
    } as any;

    service.notifyWorktreeOutcome(
      session,
      "✅ PR updated: https://github.example.test/repo/pull/169",
      {
        completionWakeOutcomeKey: "worktree-pr:updated:goldmar/openclaw-code-agent:#169:agent/example:abc1234",
        detailLines: ["PR number: #169.", "Pushed 1 new commit (+2/-1)."],
      },
    );
    service.notifyWorktreeOutcome(
      session,
      "✅ PR updated: https://github.example.test/repo/pull/169",
      {
        completionWakeOutcomeKey: "worktree-pr:updated:goldmar/openclaw-code-agent:#169:agent/example:def5678",
        detailLines: ["PR number: #169.", "Pushed 1 new commit (+3/-0)."],
      },
    );

    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.completionWakeSummaryRequired),
      [true, true],
    );
    assert.equal(requests.every((request) => typeof request.wakeMessageOnNotifySuccess === "string"), true);
  });

  it("bounds completed completion wake keys while retaining recent duplicate suppression", () => {
    const requests: Array<Record<string, unknown>> = [];
    const skippedReasons: string[] = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeStarted?.();
        request.hooks?.onWakeSucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
      { maxCompletedCompletionWakeKeys: 2 },
    );
    const session = { id: "session-bounded-completion-wakes", harnessSessionId: "h-bounded-completion-wakes" } as any;
    const requestFor = (wakeMessageOnNotifySuccess: string) => ({
      label: "completed",
      userMessage: "done",
      wakeMessageOnNotifySuccess,
      completionWakeSummaryRequired: true,
      notifyUser: "always" as const,
      hooks: {
        onWakeSkipped: (reason?: string) => {
          skippedReasons.push(reason ?? "");
        },
      },
    });

    service.dispatch(session, requestFor("wake: summary A"));
    service.dispatch(session, requestFor("wake: summary A"));
    service.dispatch(session, requestFor("wake: summary B"));
    service.dispatch(session, requestFor("wake: summary C"));
    service.dispatch(session, requestFor("wake: summary B"));
    service.dispatch(session, requestFor("wake: summary C"));
    service.dispatch(session, requestFor("wake: summary A"));

    assert.deepEqual(
      requests.map((request) => request.wakeMessageOnNotifySuccess),
      ["wake: summary A", "wake: summary B", "wake: summary C", "wake: summary A"],
    );
    assert.deepEqual(skippedReasons, [
      "duplicate completion follow-up wake already handled",
      "duplicate completion follow-up wake already handled",
      "duplicate completion follow-up wake already handled",
    ]);
  });

  it("releases completion wake keys when notify succeeds without a success wake", () => {
    const requests: Array<Record<string, unknown>> = [];
    const skippedReasons: string[] = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const session = { id: "session-success-no-wake", harnessSessionId: "h-success-no-wake" } as any;
    const request = {
      label: "completed",
      userMessage: "done",
      wakeMessageOnNotifyFailed: "wake only after notify failure",
      completionWakeSummaryRequired: true,
      notifyUser: "always" as const,
      hooks: {
        onWakeSkipped: (reason?: string) => {
          skippedReasons.push(reason ?? "");
        },
      },
    };

    service.dispatch(session, request);
    service.dispatch(session, request);

    assert.equal(requests.length, 2);
    assert.deepEqual(skippedReasons, []);
  });

  it("releases completion wake keys when notify fails without a failure wake", () => {
    const requests: Array<Record<string, unknown>> = [];
    const skippedReasons: string[] = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifyFailed?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      () => {},
    );
    const session = { id: "session-failed-no-wake", harnessSessionId: "h-failed-no-wake" } as any;
    const request = {
      label: "completed",
      userMessage: "done",
      wakeMessageOnNotifySuccess: "wake only after notify success",
      completionWakeSummaryRequired: true,
      notifyUser: "always" as const,
      hooks: {
        onWakeSkipped: (reason?: string) => {
          skippedReasons.push(reason ?? "");
        },
      },
    };

    service.dispatch(session, request);
    service.dispatch(session, request);

    assert.equal(requests.length, 2);
    assert.deepEqual(skippedReasons, []);
  });

  it("suppresses duplicate completion follow-up wakes while the first wake is still in flight", () => {
    const patches: Array<{ ref: string; patch: Record<string, unknown> }> = [];
    const requests: Array<Record<string, unknown>> = [];
    let duplicateSkippedReason = "";
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, (reason?: string) => void> }) => {
        requests.push(request as Record<string, unknown>);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        request.hooks?.onWakeStarted?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (ref, patch) => patches.push({ ref, patch: patch as Record<string, unknown> }),
    );
    const session = { id: "session-duplicate-inflight", harnessSessionId: "h-duplicate-inflight" } as any;
    const request = {
      label: "completed",
      userMessage: "done",
      wakeMessageOnNotifySuccess: "wake: send summary",
      completionWakeSummaryRequired: true,
      notifyUser: "always" as const,
      hooks: {
        onWakeSkipped: (reason?: string) => {
          duplicateSkippedReason = reason ?? "";
        },
      },
    };

    service.dispatch(session, request);
    service.dispatch(session, request);

    assert.equal(requests.length, 1);
    assert.equal(duplicateSkippedReason, "duplicate completion follow-up wake already handled");
    assert.equal(patches.filter(({ patch }) => patch.completionWakeIssuedAt).length, 1);
  });

  it("does not persist completion follow-up state when the terminal session opts out", () => {
    const patches: Array<{ ref: string; patch: Record<string, unknown> }> = [];
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, () => void> }) => {
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
      },
      dispose: () => {},
    };

    const service = new SessionNotificationService(
      fakeDispatcher as any,
      (ref, patch) => patches.push({ ref, patch: patch as Record<string, unknown> }),
    );

    service.dispatch(
      { id: "session-6", harnessSessionId: "h-6" } as any,
      {
        label: "completed",
        userMessage: "done",
        notifyUser: "always",
        completionWakeSummaryRequired: false,
      },
    );

    assert.deepEqual(
      patches.map(({ ref, patch }) => ({
        ref,
        deliveryState: patch.deliveryState,
        completionWakeSummaryRequired: patch.completionWakeSummaryRequired,
      })),
      [
        { ref: "session-6", deliveryState: "notifying", completionWakeSummaryRequired: undefined },
        { ref: "session-6", deliveryState: "idle", completionWakeSummaryRequired: undefined },
      ],
    );
  });

  it("requests a follow-up wake for worktree outcomes and records the summary contract", () => {
    const patches: Array<{ ref: string; patch: Record<string, unknown> }> = [];
    let capturedRequest: any;
    const fakeDispatcher = {
      dispatchSessionNotification: (_session: unknown, request: { hooks?: Record<string, () => void> }) => {
        capturedRequest = request;
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

    service.notifyWorktreeOutcome(
      {
        id: "session-7",
        harnessSessionId: "h-7",
        name: "merge-summary",
        route: {
          provider: "telegram",
          target: "-100123",
          threadId: "32947",
          sessionKey: "agent:x:telegram:channel:-100123:topic:32947",
        },
      } as any,
      "✅ Merged: agent/example → main",
      { detailLines: ["Pushed main.", "Branch and worktree cleaned up."] },
    );

    assert.equal(capturedRequest.label, "worktree-outcome");
    assert.equal(capturedRequest.requireDirectUserNotification, true);
    assert.equal(capturedRequest.completionWakeSummaryRequired, true);
    assert.equal(capturedRequest.deferConditionalWakeUntilNextTick, true);
    assert.match(capturedRequest.wakeMessageOnNotifySuccess, /agent_output\(session='session-7', full=true\)/);
    assert.match(capturedRequest.wakeMessageOnNotifySuccess, /originRoute: \{"provider":"telegram","target":"-100123","threadId":"32947","sessionKey":"agent:x:telegram:channel:-100123:topic:32947"\}/);
    assert.match(capturedRequest.wakeMessageOnNotifySuccess, /Pushed main\./);
    assert.deepEqual(
      patches.map(({ ref, patch }) => ({
        ref,
        deliveryState: patch.deliveryState,
        completionWakeSummaryRequired: patch.completionWakeSummaryRequired,
        hasIssuedAt: typeof patch.completionWakeIssuedAt === "string",
        hasSucceededAt: typeof patch.completionWakeSucceededAt === "string",
      })),
      [
        { ref: "session-7", deliveryState: "notifying", completionWakeSummaryRequired: undefined, hasIssuedAt: false, hasSucceededAt: false },
        { ref: "session-7", deliveryState: "wake_pending", completionWakeSummaryRequired: true, hasIssuedAt: false, hasSucceededAt: false },
        { ref: "session-7", deliveryState: "wake_pending", completionWakeSummaryRequired: true, hasIssuedAt: true, hasSucceededAt: false },
        { ref: "session-7", deliveryState: "idle", completionWakeSummaryRequired: undefined, hasIssuedAt: false, hasSucceededAt: true },
      ],
    );
  });
});
