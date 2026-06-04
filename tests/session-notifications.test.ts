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
