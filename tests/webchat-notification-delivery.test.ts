import "./test-env";
import { afterEach, describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directNotificationTransportInternals } from "../src/direct-notification-transport";
import { setPluginRuntime } from "../src/runtime-store";
import { buildWaitingForInputPayload, buildPlanApprovalFallbackMessages } from "../src/session-notification-builders/waiting";
import { SessionLifecycleService } from "../src/session-lifecycle-service";
import { SessionNotificationService } from "../src/session-notifications";
import { isCurrentPendingPlanDecision } from "../src/session-plan-approval-delivery";
import { SessionStore } from "../src/session-store";
import { WakeDispatcher } from "../src/wake-dispatcher";
import { createStubSession } from "./helpers";
import type { PersistedSessionInfo } from "../src/types";

const UI_KEY = "agent:main:telegram:group:-100123:topic:71";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "notification did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("WebChat notification delivery", () => {
  afterEach(() => setPluginRuntime(undefined));

  function fixture(t: TestContext) {
    const directory = mkdtempSync(join(tmpdir(), "oca-webchat-notify-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const indexPath = join(directory, "sessions.json");
    const store = new SessionStore({ indexPath });
    const session = createStubSession({
      id: "webchat-plan", name: "webchat-plan", harnessSessionId: "worker-plan",
      pendingPlanApproval: true, planDecisionVersion: 1, actionablePlanDecisionVersion: 1,
      approvalState: "pending", lifecycle: "awaiting_plan_decision",
      originSessionKey: UI_KEY, originChannel: `webchat|${UI_KEY}`,
      route: { provider: "webchat", target: UI_KEY, sessionKey: UI_KEY },
    });
    store.replacePersistedSession({
      sessionId: session.id, harnessSessionId: session.harnessSessionId, name: session.name,
      harness: "claude-code", backendRef: session.backendRef,
      prompt: "Test a plan", workdir: "/tmp", status: "running", costUsd: 0,
      pendingPlanApproval: true, planDecisionVersion: 1, actionablePlanDecisionVersion: 1,
      approvalState: "pending", lifecycle: "awaiting_plan_decision",
      route: session.route,
    });
    const patch = (ref: string, update: Partial<PersistedSessionInfo>): boolean => {
      const row = store.getPersistedSession(ref);
      assert.ok(row);
      Object.assign(row, update);
      Object.assign(session, update);
      store.saveIndex();
      return true;
    };
    const systemEvents: string[] = [];
    let heartbeats = 0;
    setPluginRuntime({ system: {
      enqueueSystemEvent: (text: string) => { systemEvents.push(text); return true; },
      requestHeartbeat: () => { heartbeats += 1; },
    } }, {});
    const dispatcher = new WakeDispatcher();
    const service = new SessionNotificationService(dispatcher, patch, {
      getPersistedSession: (ref) => store.getPersistedSession(ref),
      confirmNotificationInjection: (ref, key, attemptId) => store.confirmNotificationInjection(ref, key, attemptId),
    });
    t.after(() => service.dispose());
    return { indexPath, store, session, patch, systemEvents, service, getHeartbeats: () => heartbeats };
  }

  for (const variant of ["single", "multipart"] as const) {
  it(`persists an actionable ${variant} text fallback instead of claiming unrendered plan buttons were delivered`, async (t) => {
    const f = fixture(t);
    const injected: Array<Record<string, unknown>> = [];
    t.mock.method(directNotificationTransportInternals, "execFile", ((
      _file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      injected.push(JSON.parse(args[args.indexOf("--params") + 1]));
      queueMicrotask(() => callback(null, JSON.stringify({ ok: true, messageId: "fallback-note" }), ""));
      return {};
    }) as typeof directNotificationTransportInternals.execFile);
    const preview = variant === "single" ? "Review the proposed change."
      : `## Current file\n${Array.from({ length: 100 }, (_, index) => `Preserve exact section ${index}: inspect the original source before applying this scoped change.`).join("\n")}`;
    const buttons = [[{ label: "Approve", callbackData: "approve-v1" }]];
    const canonical = buildWaitingForInputPayload({ session: f.session, preview, originThreadLine: "", planApprovalMode: "ask", planApprovalButtons: buttons });
    if (variant === "multipart") {
      assert.ok((canonical.userMessages?.length ?? 0) > 1, "the real plan builder must place buttons after earlier text pages");
      assert.ok(canonical.userMessages?.at(-1)?.buttons?.length);
    }
    const fallback = buildPlanApprovalFallbackMessages({ session: f.session, summary: canonical.planReviewSummary! });
    const lifecycle = new SessionLifecycleService({
      persistSession: () => {}, clearWaitingTimestamp: () => {},
      handleWorktreeStrategy: async () => ({ notificationSent: false, worktreeRemoved: false }),
      resolveWorktreeRepoDir: () => undefined, updatePersistedSession: f.patch,
      dispatchSessionNotification: (session, request) => f.service.dispatch(session, request),
      notifySession: () => {}, clearRetryTimersForSession: () => {},
      hasTurnCompleteWakeMarker: () => false, shouldEmitTurnCompleteWake: () => true,
      shouldEmitTerminalWake: () => true, resolvePlanApprovalMode: () => "ask",
      getPlanApprovalButtons: () => buttons,
      getResumeButtons: () => [], getQuestionButtons: () => undefined,
      extractLastOutputLine: () => undefined, getOutputPreview: () => preview,
      originThreadLine: () => "", debounceWaitingEvent: () => true, isAlreadyMerged: () => false,
    });
    assert.equal(isCurrentPendingPlanDecision(f.session, 1), true, "the production guard must admit the pending plan fixture");
    await lifecycle.emitWaitingForInput(f.session);
    await until(() => f.session.approvalPromptStatus === "fallback_delivered");
    const persisted = new SessionStore({ indexPath: f.indexPath }).getPersistedSession(f.session.id)!;
    assert.equal(persisted.approvalPromptMessageKind, "explicit_fallback_text");
    assert.equal(persisted.approvalPromptRequiredVersion, 1);
    assert.equal(persisted.approvalPromptVersion, 1);
    assert.equal(isCurrentPendingPlanDecision(f.session, 1), true, "the delivered fallback remains actionable for this plan");
    assert.equal(persisted.canonicalPlanPromptVersion, undefined);
    assert.equal(injected.length, fallback.length, "the rejected canonical sequence appends zero pages; only the explicit fallback appears");
    assert.deepEqual(injected.map((entry) => entry.message), fallback.map((page) => page.text));
    assert.ok(!persisted.notificationDedupe?.some((record) => record.label === "plan-approval" && record.status === "injection_unknown"));
    assert.equal(injected[0].sessionKey, UI_KEY);
    assert.match(String(injected[0].message), /Reply "approve"/);
    assert.match(String(injected[0].message), /Reply "reject"/);
    assert.equal(f.getHeartbeats(), 0);
  });
  }

  it("persists quarantine before append and keeps it through callback loss, reload, age and retention", async (t) => {
    const f = fixture(t);
    let injections = 0;
    t.mock.method(directNotificationTransportInternals, "execFile", ((
      _file: string, _args: string[], _options: unknown, _callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      injections += 1;
      const disk = JSON.parse(readFileSync(f.indexPath, "utf8")) as { sessions: PersistedSessionInfo[] };
      assert.equal(disk.sessions[0]?.notificationDedupe?.[0]?.status, "injection_unknown",
        "the non-idempotent append must start only after independent disk confirmation");
      assert.ok(disk.sessions[0]?.notificationDedupe?.[0]?.injectionAttemptId);
      // Simulate successful host append followed by process loss before any callback.
      return {};
    }) as typeof directNotificationTransportInternals.execFile);
    const request = { label: "crash-notice", idempotencyKey: "crash-notice-v1", userMessage: "Appended before crash" };
    f.service.dispatch(f.session, request);
    await until(() => injections === 1);
    f.service.dispose();
    const reloaded = new SessionStore({ indexPath: f.indexPath });
    const row = reloaded.getPersistedSession(f.session.id)!;
    const quarantine = row.notificationDedupe![0]!;
    quarantine.recordedAt = "2000-01-01T00:00:00.000Z";
    // Ordinary dedupe eviction must not make an unresolved append replayable.
    row.notificationDedupe!.push(...Array.from({ length: 70 }, (_, index) => ({
      key: `later-${index}`, status: "delivered" as const, recordedAt: new Date().toISOString(),
    })));
    reloaded.saveIndex();
    const normalized = new SessionStore({ indexPath: f.indexPath });
    assert.ok(normalized.getPersistedSession(f.session.id)?.notificationDedupe?.some((record) => record.key === quarantine.key));
    const restarted = new SessionNotificationService(new WakeDispatcher(), (_ref, patch) => {
      Object.assign(normalized.getPersistedSession(f.session.id)!, patch);
      normalized.saveIndex();
    }, { getPersistedSession: (ref) => normalized.getPersistedSession(ref),
      confirmNotificationInjection: (ref, key, attemptId) => normalized.confirmNotificationInjection(ref, key, attemptId) });
    t.after(() => restarted.dispose());
    let duplicate = false;
    restarted.dispatch(f.session, { ...request, hooks: { onDuplicateSkipped: () => { duplicate = true; } } });
    assert.equal(duplicate, true);
    assert.equal(injections, 1);
  });

  it("does not append if its current quarantine cannot be independently confirmed on disk", async (t) => {
    const f = fixture(t);
    let injections = 0;
    t.mock.method(directNotificationTransportInternals, "execFile", (() => { injections += 1; return {}; }) as typeof directNotificationTransportInternals.execFile);
    // Deterministic disk-write failure: memory updates continue, disk retains the old snapshot.
    t.mock.method(f.store, "saveIndex", () => {});
    let failed = false;
    f.service.dispatch(f.session, {
      label: "unpersisted-notice", idempotencyKey: "unpersisted-notice", userMessage: "Never append",
      requireDirectUserNotification: true, hooks: { onNotifyFailed: () => { failed = true; } },
    });
    await until(() => failed);
    assert.equal(injections, 0);
    assert.ok(!f.store.getPersistedSession(f.session.id)?.notificationDedupe?.some((record) => record.status === "injection_unknown"),
      "a proven non-submission must not leave a phantom quarantine");
  });

  it("releases only a proven-unsubmitted first append so a later safe retry can succeed", async (t) => {
    const f = fixture(t);
    let attempts = 0;
    t.mock.method(directNotificationTransportInternals, "execFile", ((
      _file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      attempts += 1;
      queueMicrotask(() => callback(attempts === 1 ? Object.assign(new Error("missing executable"), { code: "ENOENT" }) : null,
        JSON.stringify({ ok: true, messageId: "retry-appended" }), ""));
      return {};
    }) as typeof directNotificationTransportInternals.execFile);
    const request = { label: "safe-retry", idempotencyKey: "safe-retry", userMessage: "Retry after executable restore", requireDirectUserNotification: true };
    let failed = false;
    f.service.dispatch(f.session, { ...request, hooks: { onNotifyFailed: () => { failed = true; } } });
    await until(() => failed);
    let delivered = false;
    f.service.dispatch(f.session, { ...request, hooks: { onNotifySucceeded: () => { delivered = true; } } });
    await until(() => delivered);
    assert.equal(attempts, 2);
    assert.equal(f.store.getPersistedSession(f.session.id)?.notificationDedupe?.[0]?.status, "delivered");
  });

  it("keeps prior appended pages quarantined when a later page is proven unsubmitted", async (t) => {
    const f = fixture(t);
    let pages = 0;
    t.mock.method(directNotificationTransportInternals, "execFile", ((
      _file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      pages += 1;
      queueMicrotask(() => callback(pages === 2 ? Object.assign(new Error("missing executable"), { code: "ENOENT" }) : null,
        JSON.stringify({ ok: true, messageId: "first-page" }), ""));
      return {};
    }) as typeof directNotificationTransportInternals.execFile);
    let failed = false;
    f.service.dispatch(f.session, {
      label: "multipart-notice", idempotencyKey: "multipart-notice", requireDirectUserNotification: true,
      userMessages: [{ text: "First page", requiredForSequenceSuccess: true }, { text: "Second page", requiredForSequenceSuccess: true }],
      hooks: { onNotifyFailed: () => { failed = true; } },
    });
    await until(() => failed);
    assert.equal(pages, 2);
    assert.equal(new SessionStore({ indexPath: f.indexPath }).getPersistedSession(f.session.id)?.notificationDedupe?.[0]?.status,
      "injection_unknown", "the first page must not be duplicated after a failed second page");
  });

  it("releases the quarantine when disposal happens during persistence before CLI submission", async (t) => {
    const f = fixture(t);
    let release!: () => void;
    let confirming = false;
    const original = f.store.confirmNotificationInjection.bind(f.store);
    t.mock.method(f.store, "confirmNotificationInjection", async (...args: Parameters<typeof original>) => {
      confirming = true;
      await new Promise<void>((resolve) => { release = resolve; });
      return original(...args);
    });
    let injections = 0;
    t.mock.method(directNotificationTransportInternals, "execFile", (() => { injections += 1; return {}; }) as typeof directNotificationTransportInternals.execFile);
    f.service.dispatch(f.session, { label: "disposed-notice", idempotencyKey: "disposed-notice", userMessage: "Never submit" });
    await until(() => confirming);
    f.service.dispose();
    release();
    await until(() => !f.store.getPersistedSession(f.session.id)?.notificationDedupe?.some((record) => record.status === "injection_unknown"));
    assert.equal(injections, 0);
  });

  for (const reply of ["lost", "malformed"] as const) {
    it(`retains unknown notice dedupe after a ${reply} append acknowledgement without a fallback resend`, async (t) => {
      const f = fixture(t);
      let injections = 0;
      t.mock.method(directNotificationTransportInternals, "execFile", ((
        _file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        injections += 1; // Model the host appending before its response becomes unusable.
        queueMicrotask(() => callback(reply === "lost" ? new Error("connection lost after append") : null, "", ""));
        return {};
      }) as typeof directNotificationTransportInternals.execFile);
      let fallback = false;
      const request = {
        label: "completion-notice", idempotencyKey: "same-notice", userMessage: "Already appended",
        wakeMessageOnNotifyFailed: "Repeat the notice", onUserNotifyFailed: () => { fallback = true; },
      };
      f.service.dispatch(f.session, request);
      await until(() => f.store.getPersistedSession(f.session.id)?.deliveryState === "failed");
      assert.equal(injections, 1);
      assert.equal(fallback, false);
      assert.deepEqual(f.systemEvents, []);
      assert.equal(f.getHeartbeats(), 0);
      f.service.dispose();
      const reloaded = new SessionStore({ indexPath: f.indexPath });
      const restarted = new SessionNotificationService(new WakeDispatcher(), (_ref, patch) => {
        Object.assign(reloaded.getPersistedSession(f.session.id)!, patch);
        reloaded.saveIndex();
      }, { getPersistedSession: (ref) => reloaded.getPersistedSession(ref),
        confirmNotificationInjection: (ref, key, attemptId) => reloaded.confirmNotificationInjection(ref, key, attemptId) });
      t.after(() => restarted.dispose());
      let duplicate = false;
      restarted.dispatch(f.session, {
        ...request, hooks: { onDuplicateSkipped: () => { duplicate = true; } },
      });
      assert.equal(duplicate, true);
      assert.equal(injections, 1);
    });
  }
});
