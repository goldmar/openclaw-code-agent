import "./test-env";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { WakeDispatcher, validateCompletionFollowupWakeSuccess, type WakeDispatcherOptions } from "../src/wake-dispatcher";
import {
  RuntimeDirectNotificationTransport,
  type DurableMessageBatchSendResult,
} from "../src/direct-notification-transport";
import { setPluginRuntime } from "../src/runtime-store";
import { buildWaitingForInputPayload } from "../src/session-notification-builders/waiting";
import { wakeDeliveryExecutorInternals } from "../src/wake-delivery-executor";

type FakeSession = {
  id: string;
  harnessSessionId?: string;
  route?: {
    provider?: string;
    accountId?: string;
    target?: string;
    threadId?: string;
    sessionKey?: string;
  };
  originChannel?: string;
  originThreadId?: string | number;
  originSessionKey?: string;
  originAgentId?: string;
};

function buildRoute(overrides: Partial<NonNullable<FakeSession["route"]>> = {}): NonNullable<FakeSession["route"]> {
  return {
    provider: "telegram",
    accountId: "bot",
    target: "-1001234567890",
    threadId: "11239",
    sessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    ...overrides,
  };
}

/**
 * Structured records of what the production transports hand to the host:
 * `sendDurableMessageBatch` params (direct notifications, through the real
 * `RuntimeDirectNotificationTransport`), `runtime.system.enqueueSystemEvent`
 * calls (through the real `RuntimeSystemEventTransport`), and the
 * `openclaw gateway call chat.send` argv (the only delivery that still runs the
 * CLI, through the executor's `execFile` hook).
 */
type DurableSendCall = {
  kind: "durable-send";
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
  text: string;
  presentation?: unknown;
  durability: string;
};
type SystemEventCall = { kind: "system-event"; text: string; sessionKey: string; contextKey?: string };
type ChatSendCall = { kind: "chat-send"; argv: string[]; params: Record<string, unknown> };
type DeliveryCall = DurableSendCall | SystemEventCall | ChatSendCall;
type HeartbeatCall = Record<string, unknown>;

/**
 * Injected outcome for the first matching delivery call (or every match when
 * `once` is false). `failed` returns a durable `{ status: "failed" }` result (or,
 * for chat.send, a non-zero CLI exit); `throw` rejects/throws; `hang` never settles.
 */
type DeliveryRule = {
  match: (call: DeliveryCall) => boolean;
  outcome: "ok" | "failed" | "throw" | "hang";
  error?: string;
  delayMs?: number;
  once?: boolean;
};

let calls: DeliveryCall[] = [];
let heartbeats: HeartbeatCall[] = [];
let rules: DeliveryRule[] = [];
let chatSendStdout = "";

function takeRule(call: DeliveryCall): DeliveryRule | undefined {
  const index = rules.findIndex((rule) => rule.match(call));
  if (index < 0) return undefined;
  const rule = rules[index]!;
  if (rule.once !== false) rules.splice(index, 1);
  return rule;
}

function delay(ms: number | undefined): Promise<void> {
  return ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function fakeSendDurableMessageBatch(params: Record<string, any>): Promise<DurableMessageBatchSendResult> {
  const payload = params.payloads?.[0] ?? {};
  const call: DurableSendCall = {
    kind: "durable-send",
    channel: params.channel,
    to: params.to,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.threadId ? { threadId: params.threadId } : {}),
    text: payload.text,
    ...(payload.presentation ? { presentation: payload.presentation } : {}),
    durability: params.durability,
  };
  assert.equal(params.payloads.length, 1, "OCA sends one payload per durable batch");
  calls.push(call);
  const rule = takeRule(call);
  await delay(rule?.delayMs);
  if (rule?.outcome === "hang") await new Promise<void>(() => {});
  if (rule?.outcome === "throw") throw new Error(rule.error ?? "durable send threw");
  if (rule?.outcome === "failed") {
    return { status: "failed", error: new Error(rule.error ?? "durable send failed"), stage: "send" } as unknown as DurableMessageBatchSendResult;
  }
  return { status: "sent", results: [], receipt: {} } as unknown as DurableMessageBatchSendResult;
}

const fakeSystemRuntime = {
  enqueueSystemEvent(text: string, options: { sessionKey: string; contextKey?: string }) {
    const call: SystemEventCall = {
      kind: "system-event",
      text,
      sessionKey: options.sessionKey,
      ...(options.contextKey ? { contextKey: options.contextKey } : {}),
    };
    calls.push(call);
    const rule = takeRule(call);
    if (rule?.outcome === "throw" || rule?.outcome === "failed") throw new Error(rule.error ?? "system event refused");
    return true;
  },
  requestHeartbeat(options: HeartbeatCall) {
    heartbeats.push(options);
  },
};

const fakeChatSendExecFile = ((file: string, args: string[], _options: unknown, callback?: (err: Error | null, stdout: string, stderr: string) => void) => {
  assert.equal(file, "openclaw");
  assert.deepEqual(args.slice(0, 7), ["gateway", "call", "chat.send", "--expect-final", "--timeout", "30000", "--params"]);
  const call: ChatSendCall = { kind: "chat-send", argv: [...args], params: JSON.parse(args[7] ?? "{}") };
  calls.push(call);
  const rule = takeRule(call);
  if (rule?.outcome !== "hang") {
    void delay(rule?.delayMs).then(() => {
      if (rule?.outcome === "failed" || rule?.outcome === "throw") {
        const message = rule.error ?? "chat.send failed";
        callback?.(new Error(`Command failed: openclaw gateway call chat.send\n${message}`), "", message);
        return;
      }
      callback?.(null, chatSendStdout, "");
    });
  }
  return {} as any;
}) as unknown as typeof wakeDeliveryExecutorInternals.execFile;

const originalExecFile = wakeDeliveryExecutorInternals.execFile;

function createDispatcher(options: WakeDispatcherOptions = {}) {
  return new WakeDispatcher({
    directNotifications: new RuntimeDirectNotificationTransport(async () => fakeSendDurableMessageBatch as never),
    ...options,
  });
}

const WAIT_STEP_MS = 25;
const WAIT_TIMEOUT_MS = 7_000;

async function waitForCalls(count: number): Promise<DeliveryCall[]> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (calls.length >= count) return calls;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  throw new Error(`Timed out waiting for ${count} delivery call(s); saw ${JSON.stringify(calls)}`);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function asDurableSend(call: DeliveryCall | undefined): DurableSendCall {
  assert.equal(call?.kind, "durable-send", `expected a durable send, got ${JSON.stringify(call)}`);
  return call as DurableSendCall;
}

function asChatSend(call: DeliveryCall | undefined): Record<string, unknown> {
  assert.equal(call?.kind, "chat-send", `expected a chat.send wake, got ${JSON.stringify(call)}`);
  return (call as ChatSendCall).params;
}

function findCall<K extends DeliveryCall["kind"]>(kind: K): Extract<DeliveryCall, { kind: K }> | undefined {
  return calls.find((call) => call.kind === kind) as Extract<DeliveryCall, { kind: K }> | undefined;
}

const ORIGIN_SESSION_KEY = "agent:main:telegram:group:-1001234567890:topic:11239";
/** An origin session with no deliverable chat route (for example a cron or CLI-launched agent turn). */
const NON_ROUTABLE_ORIGIN_SESSION_KEY = "agent:ops:main";

function systemEvent(text: string, sessionId: string, sessionKey = ORIGIN_SESSION_KEY): SystemEventCall {
  return { kind: "system-event", text, sessionKey, contextKey: `openclaw-code-agent:${sessionId}` };
}

describe("WakeDispatcher", () => {
  const originalConsoleInfo = console.info;
  const originalConsoleDebug = console.debug;
  const originalConsoleError = console.error;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;

  beforeEach(() => {
    calls = [];
    heartbeats = [];
    rules = [];
    chatSendStdout = "";
    setPluginRuntime({ system: fakeSystemRuntime }, { channels: {} });
    wakeDeliveryExecutorInternals.execFile = fakeChatSendExecFile;
  });

  afterEach(() => {
    console.info = originalConsoleInfo;
    console.debug = originalConsoleDebug;
    console.error = originalConsoleError;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    wakeDeliveryExecutorInternals.execFile = originalExecFile;
    setPluginRuntime(undefined);
    delete process.env.OPENCLAW_CODE_AGENT_BUTTON_DIAGNOSTICS;
  });

  it("accepts NO_REPLY after a routed send, and fails only an empty answer", () => {
    // Routed wakes end with NO_REPLY after the message tool delivered the summary.
    assert.deepEqual(validateCompletionFollowupWakeSuccess(JSON.stringify({ finalResponse: "NO_REPLY" })), { outcome: "success" });
    assert.deepEqual(
      validateCompletionFollowupWakeSuccess("  \n"),
      { outcome: "failure", reason: "completion follow-up wake produced no final response" },
    );
  });

  it("accepts marker-free completion follow-up final text", () => {
    const success = validateCompletionFollowupWakeSuccess(
      "Sent a concise routed summary for PR #185 without repeating the link.\n",
    );

    assert.deepEqual(success, { outcome: "success" });
  });

  it("treats legacy marker text as ordinary non-empty final text", () => {
    const success = validateCompletionFollowupWakeSuccess(
      "COMPLETION_FOLLOWUP_SKIPPED: prior human-visible summary already delivered\n",
    );

    assert.deepEqual(success, { outcome: "success" });
  });

  it("uses message.send for direct user notifications and logs completion", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-1",
      route: buildRoute(),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    };
    const infoLogs: string[] = [];
    console.debug = (message?: unknown, ...rest: unknown[]) => {
      infoLogs.push([message, ...rest].map((value) => String(value)).join(" "));
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(1);

    assert.equal(calls.length, 1);
    const params = asDurableSend(calls[0]);
    assert.equal(params.channel, "telegram");
    assert.equal(params.accountId, "bot");
    assert.equal(params.to, "-1001234567890");
    assert.equal(params.text, "🚀 launched");
    assert.equal(params.threadId, "11239");
    await waitFor(
      () => infoLogs.some((line) => line.includes("\"event\":\"dispatch_succeeded\"") && line.includes("\"target\":\"message.send\"")),
      "dispatcher completion log",
    );
    assert.ok(infoLogs.some((line) => line.includes("\"route\":\"telegram|bot|-1001234567890#11239\"")));
  });

  it("sends buttons only after their tokens are persisted, and never after dispose", async () => {
    const session: FakeSession = {
      id: "session-buttons",
      route: buildRoute(),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    };
    const buttons = [[{ label: "Merge", callbackData: "token-1" }]];

    let releasePersist!: () => void;
    const persisted = new Promise<void>((resolve) => { releasePersist = resolve; });
    const dispatcher = createDispatcher({ beforeInteractiveSend: () => persisted });
    dispatcher.dispatchSessionNotification(session as any, {
      label: "worktree-decision",
      userMessage: "Choose",
      notifyUser: "always",
      buttons,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(calls.length, 0, "no send while the tokens are not persisted");
    releasePersist();
    await waitForCalls(1);
    dispatcher.dispose();

    calls = [];
    let releaseLate!: () => void;
    const late = new Promise<void>((resolve) => { releaseLate = resolve; });
    const stopping = createDispatcher({ beforeInteractiveSend: () => late });
    stopping.dispatchSessionNotification(session as any, {
      label: "worktree-decision",
      userMessage: "Choose again",
      notifyUser: "always",
      buttons,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    stopping.dispose();
    releaseLate();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(calls.length, 0, "a stopped runtime never shows its buttons");
  });

  it("binds each button's action token to the chat it is sent to before the tokens are persisted (N2)", async () => {
    const session: FakeSession = {
      id: "session-bound",
      route: buildRoute(),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    };
    const events: string[] = [];
    let bound: { tokenIds: string[]; route: Record<string, unknown> } | undefined;
    const dispatcher = createDispatcher({
      bindInteractiveButtons: (tokenIds, route) => {
        events.push("bind");
        bound = { tokenIds, route: { ...route } };
      },
      beforeInteractiveSend: async () => { events.push("persist"); },
    });
    dispatcher.dispatchSessionNotification(session as any, {
      label: "worktree-decision",
      userMessage: "Choose",
      notifyUser: "always",
      buttons: [[{ label: "Merge", callbackData: "token-a" }, { label: "Later", callbackData: "token-b" }]],
    });
    await waitForCalls(1);
    dispatcher.dispose();
    assert.deepEqual(events.slice(0, 2), ["bind", "persist"]);
    assert.deepEqual(bound?.tokenIds, ["token-a", "token-b"]);
    assert.equal(bound?.route.channel, "telegram");
    assert.equal(bound?.route.target, "-1001234567890");
  });

  it("keeps direct notification order when an earlier delivery falls back", async () => {
    rules.push({
      match: (call) => call.kind === "durable-send" && call.text === "🚀 launched",
      outcome: "failed",
      delayMs: 50,
      error: "launch delivery failed once",
    });
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-ordering",
      route: buildRoute(),
      originChannel: "telegram|bot|12345",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      notifyUser: "always",
    });

    // Direct sends are never retried by OCA (the host durable queue owns retries);
    // later notifications keep their order and the failed plain notification is
    // re-queued on the same route lane as a system-event fallback.
    const calls = await waitForCalls(3);
    assert.deepEqual(calls.map((call) => call.kind), ["durable-send", "durable-send", "system-event"]);
    assert.equal(asDurableSend(calls[0]).text, "🚀 launched");
    assert.equal(asDurableSend(calls[1]).text, "✅ completed");
    // The notify fallback targets the session's origin conversation, never `main`.
    assert.deepEqual(calls[2], systemEvent("🚀 launched", "session-ordering"));
  });

  it("defers conditional worktree wakes until after the notification turn yields", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-worktree-deferred-wake",
      route: buildRoute({ threadId: "13832", sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832" }),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 13832,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "worktree-outcome",
      userMessage: "✅ Merged: agent/example → main",
      wakeMessageOnNotifySuccess: "Worktree follow-through outcome recorded.",
      notifyUser: "always",
      requireDirectUserNotification: true,
      deferConditionalWakeUntilNextTick: true,
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(findCall("chat-send"), undefined);

    const calls = await waitForCalls(2);
    assert.equal(asDurableSend(calls[0]).text, "✅ Merged: agent/example → main");
    const wakeParams = asChatSend(calls[1]);
    assert.equal(wakeParams.sessionKey, "agent:main:telegram:group:-1001234567890:topic:13832");
    assert.equal(wakeParams.message, "Worktree follow-through outcome recorded.");
  });

  it("honors an explicit conditional wake grace delay", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-worktree-grace-delay",
      route: buildRoute({ threadId: "13832", sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832" }),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 13832,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
    };
    const delays: number[] = [];

    global.setTimeout = (((fn: (...args: any[]) => void, delay?: number) => {
      delays.push(delay ?? 0);
      // Only the grace delay is fast-forwarded; dispatch timeouts keep real timers.
      if (delay !== 2000) return originalSetTimeout(fn, delay);
      queueMicrotask(() => fn());
      return { fake: true, unref() { return this; } } as any;
    }) as typeof setTimeout);
    chatSendStdout = "Sent the routed PR update summary.";

    dispatcher.dispatchSessionNotification(session as any, {
      label: "worktree-outcome",
      userMessage: "✅ PR updated: https://github.example.test/repo/pull/175",
      wakeMessageOnNotifySuccess: "Worktree follow-through outcome recorded.",
      notifyUser: "always",
      requireDirectUserNotification: true,
      completionWakeSummaryRequired: true,
      deferConditionalWakeMs: 2000,
    });

    const calls = await waitForCalls(2);
    assert.equal(delays.includes(2000), true);
    const wakeCall = calls.find((call) => call.kind === "chat-send");
    assert.ok(wakeCall, "expected delayed wake");
    assert.equal(asChatSend(wakeCall).message, "Worktree follow-through outcome recorded.");
  });

  it("suppresses queued revised plan prompts when the plan decision is rejected before delivery starts", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-plan-rejected",
      route: buildRoute(),
      originChannel: "telegram|bot|12345",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    };
    let shouldDeliverPlanV2 = true;

    rules.push({
      match: (call) => call.kind === "durable-send" && call.text === "Plan v1 needs your decision",
      outcome: "ok",
      delayMs: 50,
    });

    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-v1",
      userMessage: "Plan v1 needs your decision",
      notifyUser: "always",
    });
    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-v2",
      userMessage: "Plan v2 needs your decision",
      notifyUser: "always",
      buttons: [[{ label: "Reject", callbackData: "stale-reject-token" }]],
      shouldDispatch: () => shouldDeliverPlanV2,
    });

    await waitForCalls(1);
    shouldDeliverPlanV2 = false;
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(calls.length, 1);
    assert.equal(asDurableSend(calls[0]).text, "Plan v1 needs your decision");
  });

  it("falls back and does not retry a direct launch notification after a failed send", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-launch-timeout",
      route: buildRoute(),
      originChannel: "telegram|bot|12345",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    };
    const errorLogs: string[] = [];
    console.error = (message?: unknown, ...rest: unknown[]) => {
      errorLogs.push([message, ...rest].map((value) => String(value)).join(" "));
    };
    rules.push({
      match: (call) => call.kind === "durable-send",
      outcome: "throw",
      error: "durable outbound admission rejected",
    });

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });

    await waitFor(
      () => errorLogs.some((line) => line.includes("\"terminalReason\":\"non_retryable\"")),
      "terminal direct-send failure log",
    );

    const calls = await waitForCalls(2);
    assert.equal(calls.length, 2);
    assert.equal(asDurableSend(calls[0]).text, "🚀 launched");
    assert.deepEqual(calls[1], systemEvent("🚀 launched", "session-launch-timeout"));
    // No OCA wake follows this notify-only dispatch, so the notice needs a heartbeat to be seen.
    assert.deepEqual(heartbeats, [{ source: "notifications-event", intent: "immediate", reason: "wake", sessionKey: ORIGIN_SESSION_KEY }]);
    assert.ok(!errorLogs.some((line) => line.includes("\"event\":\"dispatch_retry_scheduled\"")));
  });

  it("enqueues a failed notice without a heartbeat when a wake for the same dispatch follows", async () => {
    chatSendStdout = "Relayed.\n";
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-notice-with-wake",
      route: buildRoute(),
      originSessionKey: ORIGIN_SESSION_KEY,
    };
    rules.push({ match: (call) => call.kind === "durable-send", outcome: "failed", error: "chat not found" });

    dispatcher.dispatchSessionNotification(session as any, {
      label: "stopped",
      userMessage: "Session stopped",
      wakeMessage: "Coding agent session stopped.",
      notifyUser: "always",
    });

    await waitFor(() => calls.some((call) => call.kind === "system-event") && calls.some((call) => call.kind === "chat-send"), "notice fallback and wake");
    assert.deepEqual(findCall("system-event"), systemEvent("Session stopped", "session-notice-with-wake"));
    // The chat.send wake turn drains the queued notice, so no full heartbeat run is started.
    assert.deepEqual(heartbeats, []);
  });

  it("wakes the origin session for a failed notice when the conditional success wake is absent", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-notice-conditional",
      route: buildRoute(),
      originSessionKey: ORIGIN_SESSION_KEY,
    };
    rules.push({ match: (call) => call.kind === "durable-send", outcome: "failed", error: "chat not found" });

    dispatcher.dispatchSessionNotification(session as any, {
      label: "question",
      userMessage: "Session needs input",
      wakeMessageOnNotifyFailed: "Tell the user the session needs input.",
    });

    await waitFor(() => calls.some((call) => call.kind === "system-event"), "notice fallback");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(calls.some((call) => call.kind === "chat-send"), false);
    assert.deepEqual(heartbeats, [{ source: "notifications-event", intent: "immediate", reason: "wake", sessionKey: ORIGIN_SESSION_KEY }]);
  });

  it("queues a next-turn success wake as a system event without chat.send or a heartbeat (N37)", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = { id: "session-next-turn", route: buildRoute(), originSessionKey: ORIGIN_SESSION_KEY };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "ask-user-question",
      userMessage: "❓ [s] Which greeting?",
      notifyUser: "always",
      wakeMessageOnNotifySuccess: "[s] The user was asked this question.",
      wakeDelivery: "next-turn",
      wakeMessageOnNotifyFailed: "[s] Show the user this question.",
    });

    await waitFor(() => calls.some((call) => call.kind === "system-event"), "queued context");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(asDurableSend(calls[0]).text, "❓ [s] Which greeting?");
    assert.deepEqual(findCall("system-event"), systemEvent("[s] The user was asked this question.", "session-next-turn"));
    assert.equal(calls.some((call) => call.kind === "chat-send"), false, "a next-turn wake must not start an orchestrator turn");
    assert.deepEqual(heartbeats, []);
  });

  it("still wakes now when the user notification of a next-turn request fails", async () => {
    chatSendStdout = "Relayed.\n";
    const dispatcher = createDispatcher();
    const session: FakeSession = { id: "session-next-turn-failed", route: buildRoute(), originSessionKey: ORIGIN_SESSION_KEY };
    rules.push({ match: (call) => call.kind === "durable-send", outcome: "failed", error: "chat not found" });

    dispatcher.dispatchSessionNotification(session as any, {
      label: "worktree-merge-ask",
      userMessage: "🔀 [s] Finished on branch",
      notifyUser: "always",
      buttons: [[{ label: "Merge", callbackData: "tok" }]],
      wakeMessageOnNotifySuccess: "[s] The user has buttons.",
      wakeDelivery: "next-turn",
      wakeMessageOnNotifyFailed: "[s] Ask the user what to do with the branch.",
    });

    await waitFor(() => calls.some((call) => call.kind === "chat-send"), "failure wake");
    assert.equal(asChatSend(findCall("chat-send")).message, "[s] Ask the user what to do with the branch.");
    assert.equal(calls.some((call) => call.kind === "system-event" && call.text.includes("has buttons")), false);
  });

  it("queues a plain next-turn wake message without a user notification", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = { id: "session-revise", route: buildRoute(), originSessionKey: ORIGIN_SESSION_KEY };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-revise-requested",
      wakeMessage: "[s] The user pressed Revise.",
      wakeDelivery: "next-turn",
      notifyUser: "never",
    });

    await waitFor(() => calls.length > 0, "queued note");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(calls, [systemEvent("[s] The user pressed Revise.", "session-revise")]);
    assert.deepEqual(heartbeats, []);
  });

  it("hands Telegram topic direct notifications to the host durable outbound queue", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-runtime-direct",
      route: buildRoute({ threadId: "28", sessionKey: "agent:main:telegram:group:-1001234567890:topic:28" }),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 28,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:28",
    };
    const infoLogs: string[] = [];
    console.debug = (message?: unknown, ...rest: unknown[]) => {
      infoLogs.push([message, ...rest].map((value) => String(value)).join(" "));
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });

    await waitFor(
      () => infoLogs.some((line) => line.includes("\"event\":\"dispatch_succeeded\"")),
      "runtime direct send",
    );
    assert.deepEqual(calls, [{
      kind: "durable-send",
      channel: "telegram",
      to: "-1001234567890",
      accountId: "bot",
      threadId: "28",
      text: "🚀 launched",
      durability: "required",
    }]);
    assert.deepEqual(heartbeats, []);
    assert.ok(infoLogs.some((line) => line.includes("\"event\":\"dispatch_succeeded\"") && line.includes("\"target\":\"message.send\"")));
  });

  it("falls back on unavailable in-process direct notify without blocking the route lane", async () => {
    rules.push({
      match: (call) => call.kind === "durable-send" && call.text === "🚀 launched",
      outcome: "throw",
      error: "runtime direct sender unavailable",
    });
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-runtime-direct-unavailable",
      route: buildRoute({ threadId: "28", sessionKey: "agent:main:telegram:group:-1001234567890:topic:28" }),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 28,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:28",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      notifyUser: "always",
    });

    const calls = await waitForCalls(3);
    assert.deepEqual(calls.map((call) => call.kind), ["durable-send", "durable-send", "system-event"]);
    assert.equal(asDurableSend(calls[0]).text, "🚀 launched");
    assert.equal(asDurableSend(calls[1]).text, "✅ completed");
    assert.deepEqual(calls[2], systemEvent("🚀 launched", "session-runtime-direct-unavailable", "agent:main:telegram:group:-1001234567890:topic:28"));
  });

  it("does not resend a plain notification through a system event after an ambiguous durable-send timeout", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    rules.push({ match: (call) => call.kind === "durable-send", outcome: "hang" });
    let notifyFailed = 0;
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-durable-timeout",
      route: buildRoute(),
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
      hooks: { onNotifyFailed: () => { notifyFailed += 1; } },
    });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    t.mock.timers.tick(30_000);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    assert.deepEqual(calls.map((call) => call.kind), ["durable-send"]);
    assert.equal(asDurableSend(calls[0]).text, "🚀 launched");
    assert.deepEqual(heartbeats, []);
    assert.equal(notifyFailed, 1);
    dispatcher.dispose();
  });

  it("does not system-fallback strict runtime direct notification failures", async () => {
    rules.push({
      match: (call) => call.kind === "durable-send",
      outcome: "throw",
      error: "runtime direct sender unavailable after send ambiguity",
    });
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-runtime-strict-direct-unavailable",
      route: buildRoute({ threadId: "28", sessionKey: "agent:main:telegram:group:-1001234567890:topic:28" }),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 28,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:28",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "worktree-outcome",
      userMessage: "✅ PR opened: https://github.com/goldmar/openclaw-workspace/pull/3",
      requireDirectUserNotification: true,
      wakeMessageOnNotifySuccess: "Canonical worktree status delivered to user: yes",
      wakeMessageOnNotifyFailed: "Canonical worktree status delivered to user: no",
      notifyUser: "always",
    });

    const calls = await waitForCalls(2);
    assert.equal(asDurableSend(calls[0]).text, "✅ PR opened: https://github.com/goldmar/openclaw-workspace/pull/3");
    assert.equal(calls.some((call) => call.kind === "system-event"), false);
    const wakeParams = asChatSend(calls[1]);
    assert.equal(wakeParams.message, "Canonical worktree status delivered to user: no");
  });

  it("reports a strict completion notification send failure before waking", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-completion-strict",
      route: buildRoute({ threadId: "26", sessionKey: "agent:main:telegram:group:-1001234567890:topic:26" }),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 26,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:26",
    };
    const errorLogs: string[] = [];
    console.error = (message?: unknown, ...rest: unknown[]) => {
      errorLogs.push([message, ...rest].map((value) => String(value)).join(" "));
    };
    rules.push({ match: (call) => call.kind === "durable-send", outcome: "throw", error: "durable outbound admission rejected" });

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      requireDirectUserNotification: true,
      wakeMessageOnNotifySuccess: "Canonical completion status delivered to user: yes",
      wakeMessageOnNotifyFailed: "Canonical completion status delivered to user: no",
      notifyUser: "always",
    });

    const calls = await waitForCalls(2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.kind, "durable-send");
    assert.equal(calls[1]?.kind, "chat-send");
    assert.equal(asDurableSend(calls[0]).text, "✅ completed");
    assert.equal(asDurableSend(calls[0]).threadId, "26");
    const wakeParams = asChatSend(calls[1]);
    assert.equal(wakeParams.message, "Canonical completion status delivered to user: no");
    assert.equal(wakeParams.sessionKey, "agent:main:telegram:group:-1001234567890:topic:26");
    assert.ok(errorLogs.some((line) => line.includes("\"terminal\":true") && line.includes("\"target\":\"message.send\"")));
  });

  it("does not count system fallback as strict completion notification success", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-completion-strict-failure",
      route: buildRoute({ threadId: "26", sessionKey: "agent:main:telegram:group:-1001234567890:topic:26" }),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 26,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:26",
    };

    rules.push({ match: (call) => call.kind === "durable-send", outcome: "failed", error: "telegram send failed" });

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      requireDirectUserNotification: true,
      wakeMessageOnNotifySuccess: "Canonical completion status delivered to user: yes",
      wakeMessageOnNotifyFailed: "Canonical completion status delivered to user: no",
      notifyUser: "always",
    });

    // One direct attempt: the host durable queue, not OCA, owns send retries.
    const calls = await waitForCalls(2);
    assert.equal(calls.filter((call) => call.kind === "durable-send").length, 1);
    assert.equal(calls.some((call) => call.kind === "system-event"), false);
    const wakeCall = calls.find((call) => call.kind === "chat-send");
    assert.ok(wakeCall, "expected failed-delivery wake");
    const wakeParams = asChatSend(wakeCall);
    assert.equal(wakeParams.message, "Canonical completion status delivered to user: no");
  });

  it("does not count system fallback as strict notify-only completion success", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-completion-strict-no-wake",
      route: buildRoute({ threadId: "26", sessionKey: "agent:main:telegram:group:-1001234567890:topic:26" }),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 26,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:26",
    };
    let notifySucceeded = 0;
    let notifyFailed = 0;

    rules.push({ match: (call) => call.kind === "durable-send", outcome: "failed", error: "telegram send failed" });

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      requireDirectUserNotification: true,
      notifyUser: "always",
      hooks: {
        onNotifySucceeded: () => { notifySucceeded += 1; },
        onNotifyFailed: () => { notifyFailed += 1; },
      },
    });

    await waitFor(() => notifyFailed === 1, "strict notify-only failure");
    assert.equal(calls.filter((call) => call.kind === "durable-send").length, 1);
    assert.equal(calls.some((call) => call.kind === "system-event"), false);
    assert.equal(calls.some((call) => call.kind === "chat-send"), false);
    assert.equal(notifySucceeded, 0);
  });

  it("treats explicit system routes as non-routable and falls back to system.event", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-system-route",
      route: {
        provider: "system",
        target: "system",
        sessionKey: NON_ROUTABLE_ORIGIN_SESSION_KEY,
      },
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(1);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], systemEvent("🚀 launched", "session-system-route", NON_ROUTABLE_ORIGIN_SESSION_KEY));
  });

  it("recovers a direct Telegram notification route from degraded persisted metadata", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-degraded-route",
      route: {
        provider: "system",
        target: "system",
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
      },
      originChannel: "telegram",
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(1);

    assert.equal(calls.length, 1);
    const params = asDurableSend(calls[0]);
    assert.equal(params.channel, "telegram");
    assert.equal(params.to, "-1001234567890");
    assert.equal(params.threadId, "11239");
    assert.equal(params.text, "🚀 launched");
  });

  it("does not install process-level signal listeners per instance", () => {
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    createDispatcher();
    createDispatcher();
    createDispatcher();

    assert.equal(process.listenerCount("SIGINT"), sigintBefore);
    assert.equal(process.listenerCount("SIGTERM"), sigtermBefore);
  });

  it("sends the direct notification and wake through separate transports when wake metadata is present", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-2",
      route: buildRoute(),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
      originAgentId: "main",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      wakeMessage: "Coding agent session completed.",
      notifyUser: "always",
    });
    const calls = await waitForCalls(2);

    assert.equal(calls.length, 2);
    const notifyCall = calls.find((call) => call.kind === "durable-send");
    const wakeCall = calls.find((call) => call.kind === "chat-send");
    assert.ok(notifyCall, "expected a durable-send notification");
    assert.ok(wakeCall, "expected a chat.send wake call");
    const notifyArgs = asDurableSend(notifyCall);
    assert.equal(notifyArgs.text, "✅ completed");
    const wakeParams = asChatSend(wakeCall);
    assert.equal(wakeParams.message, "Coding agent session completed.");
    assert.equal(wakeParams.deliver, true);
    assert.equal(wakeParams.channel, undefined);
    assert.equal(wakeParams.accountId, undefined);
    assert.equal(wakeParams.target, undefined);
    assert.equal(wakeParams.threadId, undefined);
  });

  it("preserves Telegram inline buttons when a notification also sends a wake", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-buttons",
      route: buildRoute(),
      originChannel: "telegram|bot|12345",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
      originAgentId: "main",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "worktree-delegate",
      userMessage: "🔀 Worktree decision required",
      wakeMessage: "Delegated worktree decision wake",
      notifyUser: "always",
      buttons: [[
        { label: "✅ Merge", callbackData: "token-merge" },
        { label: "📬 Open PR", callbackData: "token-pr" },
      ]],
    });
    const calls = await waitForCalls(2);

    assert.equal(calls.length, 2);
    const notifyCall = calls.find((call) => call.kind === "durable-send");
    const wakeCall = calls.find((call) => call.kind === "chat-send");
    assert.ok(notifyCall, "expected a durable-send notification");
    assert.ok(wakeCall, "expected a chat.send wake call");
    const notifyArgs = asDurableSend(notifyCall);
    assert.equal(notifyArgs.text, "🔀 Worktree decision required");
    assert.deepEqual(notifyArgs.presentation, {
      blocks: [{
        type: "buttons",
        buttons: [
          { label: "✅ Merge", value: "code-agent:token-merge" },
          { label: "📬 Open PR", value: "code-agent:token-pr" },
        ],
      }],
    });
    const wakeParams = asChatSend(wakeCall);
    assert.equal(wakeParams.message, "Delegated worktree decision wake");
  });

  it("suppresses delegate pending user notifications while still sending the reviewer wake", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-delegate-pending",
      route: buildRoute(),
      originChannel: "telegram|bot|12345",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
      originAgentId: "main",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "worktree-delegate",
      wakeMessage: "Delegated worktree decision wake",
      notifyUser: "never",
    });
    const calls = await waitForCalls(1);

    assert.equal(calls.length, 1);
    assert.equal(calls.some((call) => call.kind === "durable-send"), false);
    const wakeCall = calls.find((call) => call.kind === "chat-send");
    assert.ok(wakeCall, "expected a chat.send wake call");
    const wakeParams = asChatSend(wakeCall);
    assert.equal(wakeParams.message, "Delegated worktree decision wake");
  });

  it("logs Telegram interactive delivery context when direct button sends fail", async () => {
    rules.push({
      match: (call) => call.kind === "durable-send" && call.presentation !== undefined,
      outcome: "failed",
      error: "telegram button delivery failed",
    });

    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-button-failure",
      route: buildRoute(),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    };
    const errorLogs: string[] = [];
    console.error = (message?: unknown, ...rest: unknown[]) => {
      errorLogs.push([message, ...rest].map((value) => String(value)).join(" "));
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-approval",
      userMessage: "📋 Plan ready",
      notifyUser: "always",
      buttons: [[
        { label: "Approve", callbackData: "token-approve" },
        { label: "Revise", callbackData: "token-revise" },
        { label: "Reject", callbackData: "token-reject" },
      ]],
    });

    await waitFor(
      () => errorLogs.some((line) => line.includes("\"event\":\"dispatch_failed\"")),
      "interactive failure log",
    );

    const failureLog = errorLogs.find((line) => line.includes("\"event\":\"dispatch_failed\"")) ?? "";
    assert.match(failureLog, /"buttonsPresent":true/);
    assert.match(failureLog, /"buttonCount":3/);
    assert.match(failureLog, /"buttonLabels":\["Approve","Revise","Reject"\]/);
    assert.match(failureLog, /"transportChannel":"telegram"/);
    assert.match(failureLog, /"transportThreadId":"11239"/);
    assert.match(failureLog, /telegram button delivery failed/);
    dispatcher.dispose();
  });

  it("falls back to a direct user notification and skips the system event when no origin session key exists", async () => {
    const dispatcher = createDispatcher();
    const warnings: string[] = [];
    console.warn = (message?: unknown, ...rest: unknown[]) => {
      warnings.push([message, ...rest].map((value) => String(value)).join(" "));
    };
    const session: FakeSession = {
      id: "session-3",
      route: buildRoute({ sessionKey: undefined }),
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "waiting",
      userMessage: "🔔 waiting",
      wakeMessage: "Session is waiting for input.",
      notifyUser: "on-wake-fallback",
    });
    await waitForCalls(1);
    await waitFor(() => warnings.some((line) => line.includes("no origin session key")), "dropped system-event warning");

    // The user still hears about it directly; the wake is not sent to a `main` alias.
    assert.deepEqual(calls.map((call) => call.kind), ["durable-send"]);
    assert.equal(asDurableSend(calls[0]).text, "🔔 waiting");
    assert.deepEqual(heartbeats, []);
  });

  it("does not silently downgrade interactive notifications to system text when direct routing is unavailable", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-interactive-no-route",
      originSessionKey: NON_ROUTABLE_ORIGIN_SESSION_KEY,
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-approval",
      userMessage: "📋 Plan ready",
      notifyUser: "always",
      buttons: [[
        { label: "Approve", callbackData: "token-approve" },
        { label: "Reject", callbackData: "token-reject" },
      ]],
      wakeMessageOnNotifyFailed: "Interactive delivery failed; no buttons were sent.",
    });
    const calls = await waitForCalls(1);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], systemEvent("Interactive delivery failed; no buttons were sent.", "session-interactive-no-route", NON_ROUTABLE_ORIGIN_SESSION_KEY));
  });

  it("prefers the structured route over legacy originChannel fields for new-schema sessions", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-route-wins",
      route: {
        provider: "discord",
        accountId: "bot-account",
        target: "channel:999",
      },
      originChannel: "telegram|bot|12345",
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(1);
    const params = asDurableSend(calls[0]);
    assert.equal(params.channel, "discord");
    assert.equal(params.accountId, "bot-account");
    assert.equal(params.to, "channel:999");
  });

  it("sends the user notification but no main-session system event when originSessionKey is missing", async () => {
    const dispatcher = createDispatcher();
    let wakeFailed = 0;
    const session: FakeSession = { id: "session-4", route: buildRoute({ sessionKey: undefined }) };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      wakeMessage: "Coding agent session completed.",
      notifyUser: "always",
      hooks: { onWakeFailed: () => { wakeFailed += 1; } },
    });
    await waitForCalls(1);
    await waitFor(() => wakeFailed === 1, "wake reported as failed");

    assert.deepEqual(calls.map((call) => call.kind), ["durable-send"]);
    assert.equal(asDurableSend(calls[0]).text, "✅ completed");
    assert.deepEqual(heartbeats, []);
  });

  it("does not send a direct notify fallback when wake routing is recoverable from originSessionKey", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-origin-session-key-wake",
      route: buildRoute({ sessionKey: undefined }),
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "waiting",
      userMessage: "🔔 waiting",
      wakeMessage: "Session is waiting for input.",
      notifyUser: "on-wake-fallback",
    });
    const calls = await waitForCalls(1);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.kind, "chat-send");
    const wakeParams = asChatSend(calls[0]);
    assert.equal(wakeParams.sessionKey, "agent:main:telegram:group:-1001234567890:topic:11239");
    assert.equal(wakeParams.channel, undefined);
    assert.equal(wakeParams.threadId, undefined);
  });

  it("uses system event for notify-only sessions when originSessionKey is missing", async () => {
    const dispatcher = createDispatcher();
    // An explicit system route is not directly deliverable; its session key
    // still identifies the origin conversation for the system event.
    const session: FakeSession = {
      id: "session-5",
      route: { provider: "system", target: "system", sessionKey: NON_ROUTABLE_ORIGIN_SESSION_KEY },
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(1);

    assert.deepEqual(calls, [systemEvent("🚀 launched", "session-5", NON_ROUTABLE_ORIGIN_SESSION_KEY)]);
  });

  it("routes explicit Discord channel targets through message.send", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-6",
      route: buildRoute({
        provider: "discord",
        accountId: undefined,
        target: "channel:1400000000000000001",
        threadId: undefined,
        sessionKey: undefined,
      }),
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(1);

    assert.equal(calls.length, 1);
    const params = asDurableSend(calls[0]);
    assert.equal(params.channel, "discord");
    assert.equal(params.to, "channel:1400000000000000001");
    assert.equal(params.text, "🚀 launched");
  });

  it("routes explicit Discord DM targets through message.send", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-7",
      route: buildRoute({
        provider: "discord",
        accountId: undefined,
        target: "user:700000000000000001",
        threadId: undefined,
        sessionKey: undefined,
      }),
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(1);

    assert.equal(calls.length, 1);
    const params = asDurableSend(calls[0]);
    assert.equal(params.channel, "discord");
    assert.equal(params.to, "user:700000000000000001");
    assert.equal(params.text, "🚀 launched");
  });

  it("sends Discord buttons through the shared direct presentation path", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-10",
      route: buildRoute({
        provider: "discord",
        accountId: undefined,
        target: "channel:1400000000000000001",
        threadId: "1481999999999999999",
        sessionKey: undefined,
      }),
      originChannel: "discord|1400000000000000001",
      originThreadId: "1481999999999999999",
      originSessionKey: "agent:main:discord:channel:1400000000000000001",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-approval",
      userMessage: "📋 Plan ready",
      notifyUser: "always",
      buttons: [[
        { label: "Approve", callbackData: "token-approve", style: "primary" },
        { label: "Reject", callbackData: "token-reject", style: "danger" },
      ]],
    });

    const calls = await waitForCalls(1);
    const args = asDurableSend(calls[0]);
    assert.equal(args.channel, "discord");
    assert.equal(args.to, "channel:1400000000000000001");
    assert.equal(args.text, "📋 Plan ready");
    assert.equal(args.threadId, "1481999999999999999");
    assert.deepEqual(args.presentation, {
      blocks: [{
        type: "buttons",
        buttons: [
          { label: "Approve", value: "code-agent:token-approve", style: "primary" },
          { label: "Reject", value: "code-agent:token-reject", style: "danger" },
        ],
      }],
    });
  });

  it("preserves Discord account and thread targeting on the shared presentation path", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-discord-account-thread",
      route: buildRoute({
        provider: "discord",
        accountId: "bot-account",
        target: "channel:1400000000000000001",
        threadId: "1481999999999999999",
        sessionKey: undefined,
      }),
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "worktree-delegate",
      userMessage: "🔀 Worktree decision required",
      notifyUser: "always",
      buttons: [[
        { label: "Merge", callbackData: "token-merge", style: "success" },
        { label: "Open PR", callbackData: "token-pr", style: "primary" },
      ]],
    });

    const calls = await waitForCalls(1);
    const args = asDurableSend(calls[0]);
    assert.equal(args.channel, "discord");
    assert.equal(args.accountId, "bot-account");
    assert.equal(args.to, "channel:1400000000000000001");
    assert.equal(args.threadId, "1481999999999999999");
    assert.deepEqual(args.presentation, {
      blocks: [{
        type: "buttons",
        buttons: [
          { label: "Merge", value: "code-agent:token-merge", style: "success" },
          { label: "Open PR", value: "code-agent:token-pr", style: "primary" },
        ],
      }],
    });
  });

  it("logs Discord interactive delivery context when shared presentation delivery fails", async () => {
    rules.push({
      match: (call) => call.kind === "durable-send" && call.presentation !== undefined,
      outcome: "failed",
      error: "discord presentation delivery failed",
    });

    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-discord-button-failure",
      route: buildRoute({
        provider: "discord",
        accountId: "bot-account",
        target: "channel:1400000000000000001",
        threadId: "1481999999999999999",
        sessionKey: undefined,
      }),
    };
    const errorLogs: string[] = [];
    console.error = (message?: unknown, ...rest: unknown[]) => {
      errorLogs.push([message, ...rest].map((value) => String(value)).join(" "));
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-approval",
      userMessage: "📋 Plan ready",
      notifyUser: "always",
      buttons: [[
        { label: "Approve", callbackData: "token-approve", style: "primary" },
        { label: "Reject", callbackData: "token-reject", style: "danger" },
      ]],
    });

    await waitFor(
      () => errorLogs.some((line) => line.includes("\"event\":\"dispatch_failed\"")),
      "discord interactive failure log",
    );

    const failureLog = errorLogs.find((line) => line.includes("\"event\":\"dispatch_failed\"")) ?? "";
    assert.match(failureLog, /"target":"message\.send"/);
    assert.match(failureLog, /"transportChannel":"discord"/);
    assert.match(failureLog, /"transportAccountId":"bot-account"/);
    assert.match(failureLog, /"transportTarget":"channel:1400000000000000001"/);
    assert.match(failureLog, /"transportThreadId":"1481999999999999999"/);
    assert.match(failureLog, /"buttonsPresent":true/);
    assert.match(failureLog, /"buttonCount":2/);
    assert.match(failureLog, /discord presentation delivery failed/);
    dispatcher.dispose();
  });

  it("delivers paginated user notifications in order and keeps buttons only on the final chunk", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-paginated",
      route: buildRoute(),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-approval",
      notifyUser: "always",
      userMessages: [
        { text: "📋 Plan part 1\n\nFull plan:\nchunk one" },
        { text: "📋 Plan part 2\n\nchunk two" },
        {
          text: "📋 Plan part 3\n\nchunk three\n\nChoose Approve, Revise, or Reject below.",
          buttons: [[
            { label: "Approve", callbackData: "token-approve" },
            { label: "Revise", callbackData: "token-revise" },
            { label: "Reject", callbackData: "token-reject" },
          ]],
        },
      ],
    });

    const calls = await waitForCalls(3);
    assert.equal(calls.length, 3);

    const first = asDurableSend(calls[0]);
    const second = asDurableSend(calls[1]);
    const third = asDurableSend(calls[2]);

    assert.equal(first.text, "📋 Plan part 1\n\nFull plan:\nchunk one");
    assert.equal(first.presentation, undefined);
    assert.equal(second.text, "📋 Plan part 2\n\nchunk two");
    assert.equal(second.presentation, undefined);
    assert.equal(third.text, "📋 Plan part 3\n\nchunk three\n\nChoose Approve, Revise, or Reject below.");
    assert.deepEqual(third.presentation, {
      blocks: [{
        type: "buttons",
        buttons: [
          { label: "Approve", value: "code-agent:token-approve" },
          { label: "Revise", value: "code-agent:token-revise" },
          { label: "Reject", value: "code-agent:token-reject" },
        ],
      }],
    });
  });

  it("emits privacy-safe diagnostics for paginated button-bearing chunks", async (t) => {
    process.env.OPENCLAW_CODE_AGENT_BUTTON_DIAGNOSTICS = "1";
    const infoLogs: string[] = [];
    t.mock.method(console, "info", (message?: unknown, ...rest: unknown[]) => {
      infoLogs.push([message, ...rest].map((value) => String(value)).join(" "));
    });
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-paginated-diagnostics",
      route: buildRoute({ threadId: "13832", sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832" }),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 13832,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-approval",
      notifyUser: "always",
      userMessages: [
        { text: "secret plan body chunk one" },
        {
          text: "secret plan body chunk two",
          buttons: [[
            { label: "Approve", callbackData: "secret-approve-token" },
            { label: "Reject", callbackData: "secret-reject-token" },
          ]],
        },
      ],
    });

    await waitFor(
      () => infoLogs.some((line) => line.includes('"event":"wake_notify_sequence_succeeded"')),
      "button diagnostics sequence success",
    );
    const joined = infoLogs.join("\n");
    assert.match(joined, /"event":"wake_notify_sequence_started"/);
    assert.match(joined, /"buttonChunkIndexes":\[2\]/);
    assert.match(joined, /"threadId":"13832"/);
    assert.match(joined, /"buttonLabels":\["Approve","Reject"\]/);
    assert.doesNotMatch(joined, /secret-approve-token/);
    assert.doesNotMatch(joined, /secret plan body/);
  });

  it("treats mid-sequence notification failures as partial success instead of triggering the all-failed fallback", () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-partial-sequence-failure",
      route: buildRoute(),
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:11239",
    };

    const deliveries: string[] = [];
    const wakeEvents: string[] = [];
    let notifyFailed = 0;
    let notifySucceeded = 0;

    (dispatcher as any).sendUserNotification = (
      _session: FakeSession,
      text: string,
      _label: string,
      _buttons: unknown,
      onAllFailed?: () => void,
      onSuccess?: () => void,
    ) => {
      deliveries.push(text);
      if (deliveries.length === 1) {
        onSuccess?.();
        return;
      }
      onAllFailed?.();
    };

    (dispatcher as any).sendWake = (
      _session: FakeSession,
      text: string,
      _label: string,
      _phase: string,
      _onFinalFailure?: () => void,
      onSuccess?: () => void,
    ) => {
      wakeEvents.push(text);
      onSuccess?.();
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-approval",
      userMessages: [
        { text: "part 1" },
        { text: "part 2" },
        { text: "part 3" },
      ],
      wakeMessageOnNotifySuccess: "notify success wake",
      wakeMessageOnNotifyFailed: "notify failed wake",
      hooks: {
        onNotifyFailed: () => { notifyFailed += 1; },
        onNotifySucceeded: () => { notifySucceeded += 1; },
      },
    });

    assert.deepEqual(deliveries, ["part 1", "part 2"]);
    assert.equal(notifyFailed, 0);
    assert.equal(notifySucceeded, 1);
    assert.deepEqual(wakeEvents, ["notify success wake"]);
  });

  it("fails a sequence when the final actionable chunk fails after earlier chunks succeed", () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-final-action-failure",
      route: buildRoute(),
    };
    const deliveries: string[] = [];
    const wakeEvents: string[] = [];
    let notifyFailed = 0;
    let notifySucceeded = 0;

    (dispatcher as any).sendUserNotification = (
      _session: FakeSession,
      text: string,
      _label: string,
      _buttons: unknown,
      onAllFailed?: () => void,
      onSuccess?: () => void,
    ) => {
      deliveries.push(text);
      if (_buttons) onAllFailed?.();
      else onSuccess?.();
    };
    (dispatcher as any).sendWake = (
      _session: FakeSession,
      text: string,
      _label: string,
      _phase: string,
      _onFinalFailure?: () => void,
      onSuccess?: () => void,
    ) => {
      wakeEvents.push(text);
      onSuccess?.();
    };

    const payload = buildWaitingForInputPayload({
      session: { ...session, name: "decision-brief", pendingPlanApproval: true, planDecisionVersion: 2 } as any,
      preview: "", originThreadLine: "", planApprovalMode: "ask",
      planArtifact: { steps: [], markdown: "## Risks\n" + "Private frames may leak. ".repeat(250) },
      planApprovalButtons: [[{ label: "Approve", callbackData: "approve-v2" }]],
    });
    assert.ok(payload.userMessages!.length > 1);
    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-approval",
      userMessages: payload.userMessages,
      wakeMessageOnNotifySuccess: "notify success wake",
      wakeMessageOnNotifyFailed: "notify failed wake",
      hooks: {
        onNotifyFailed: () => { notifyFailed += 1; },
        onNotifySucceeded: () => { notifySucceeded += 1; },
      },
    });

    assert.deepEqual(deliveries, payload.userMessages!.map((message) => message.text));
    assert.equal(notifyFailed, 1);
    assert.equal(notifySucceeded, 0);
    assert.deepEqual(wakeEvents, ["notify failed wake"]);
  });

  it("fails an approval sequence when a required middle chunk fails before the actions", () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-middle-approval-failure",
      route: buildRoute(),
    };
    const deliveries: string[] = [];
    const wakeEvents: string[] = [];
    let notifyFailed = 0;
    let notifySucceeded = 0;

    (dispatcher as any).sendUserNotification = (
      _session: FakeSession,
      text: string,
      _label: string,
      _buttons: unknown,
      onAllFailed?: () => void,
      onSuccess?: () => void,
    ) => {
      deliveries.push(text);
      if (deliveries.length === 2) onAllFailed?.();
      else onSuccess?.();
    };
    (dispatcher as any).sendWake = (
      _session: FakeSession,
      text: string,
      _label: string,
      _phase: string,
      _onFinalFailure?: () => void,
      onSuccess?: () => void,
    ) => {
      wakeEvents.push(text);
      onSuccess?.();
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-approval",
      userMessages: [
        { text: "decision context 1", requiredForSequenceSuccess: true },
        { text: "decision context 2", requiredForSequenceSuccess: true },
        {
          text: "canonical decision prompt",
          buttons: [[{ label: "Approve", callbackData: "approve-v3" }]],
          requiredForSequenceSuccess: true,
        },
      ],
      wakeMessageOnNotifySuccess: "notify success wake",
      wakeMessageOnNotifyFailed: "notify failed wake",
      hooks: {
        onNotifyFailed: () => { notifyFailed += 1; },
        onNotifySucceeded: () => { notifySucceeded += 1; },
      },
    });

    assert.deepEqual(deliveries, ["decision context 1", "decision context 2"]);
    assert.equal(notifyFailed, 1);
    assert.equal(notifySucceeded, 0);
    assert.deepEqual(wakeEvents, ["notify failed wake"]);
  });

  it("falls back to system notify when no explicit route is present", async () => {
    const dispatcher = createDispatcher();
    // An explicit system route is not directly deliverable; its session key
    // still identifies the origin conversation for the system event.
    const session: FakeSession = {
      id: "session-8",
      route: { provider: "system", target: "system", sessionKey: NON_ROUTABLE_ORIGIN_SESSION_KEY },
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(1);

    assert.deepEqual(calls, [systemEvent("🚀 launched", "session-8", NON_ROUTABLE_ORIGIN_SESSION_KEY)]);
  });

  it("preserves existing Telegram routing when Discord sessions are added", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-9",
      route: buildRoute(),
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(1);

    assert.equal(calls.length, 1);
    const params = asDurableSend(calls[0]);
    assert.equal(params.channel, "telegram");
    assert.equal(params.accountId, "bot");
    assert.equal(params.to, "-1001234567890");
    assert.equal(params.text, "🚀 launched");
    assert.equal(params.threadId, "11239");
  });

  it("preserves Telegram topic routing for follow-up notifications", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-10",
      route: {
        provider: "telegram",
        accountId: "bot",
        target: "-1001234567890",
        threadId: "13832",
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
      },
      originChannel: "telegram|bot|-1001234567890",
      originThreadId: 13832,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      notifyUser: "always",
    });
    const calls = await waitForCalls(1);

    assert.equal(calls.length, 1);
    const params = asDurableSend(calls[0]);
    assert.equal(params.channel, "telegram");
    assert.equal(params.accountId, "bot");
    assert.equal(params.to, "-1001234567890");
    assert.equal(params.text, "✅ completed");
    assert.equal(params.threadId, "13832");
  });

  it("accepts a NO_REPLY completion wake (the summary went out with the message tool) without a fallback", async () => {
    chatSendStdout = "NO_REPLY\n";
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-routed-followup",
      route: buildRoute(),
    };
    let wakeSucceeded = 0;
    let wakeFailed = 0;

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      wakeMessage: "Coding agent session completed. Send the user a short factual completion summary.",
      notifyUser: "never",
      completionWakeSummaryRequired: true,
      hooks: {
        onWakeSucceeded: () => { wakeSucceeded += 1; },
        onWakeFailed: () => { wakeFailed += 1; },
      },
    });

    await waitFor(() => wakeSucceeded === 1, "routed completion wake accepted");
    assert.deepEqual(calls.map((call) => call.kind), ["chat-send"]);
    assert.deepEqual(heartbeats, []);
    assert.equal(wakeFailed, 0);
  });

  it("holds a deferred wake and skips it when the orchestrator already read the outcome", async () => {
    const delays: number[] = [];
    global.setTimeout = (((fn: (...args: any[]) => void, delay?: number) => {
      delays.push(delay ?? 0);
      if (delay !== 15_000) return originalSetTimeout(fn, delay);
      queueMicrotask(() => fn());
      return { fake: true, unref() { return this; } } as any;
    }) as typeof setTimeout);
    const dispatcher = createDispatcher();
    const skipped: string[] = [];
    let seen = true;
    const request = (id: string) => ({
      label: "failed",
      userMessage: "❌ [fail] Failed",
      wakeMessage: `[fail] Failed. ID: ${id}`,
      notifyUser: "always" as const,
      deferWakeMs: 15_000,
      skipDeferredWake: () => seen ? "the launching orchestrator turn already saw the failure" : undefined,
      hooks: { onWakeSkipped: (reason: string) => { skipped.push(reason); } },
    });

    dispatcher.dispatchSessionNotification({ id: "seen", route: buildRoute() } as any, request("seen"));
    await waitFor(() => skipped.length === 1, "deferred wake skipped");
    assert.equal(delays.includes(15_000), true);
    assert.equal(calls.some((call) => call.kind === "chat-send"), false);
    assert.equal(calls.some((call) => call.kind === "durable-send"), true, "the user still gets the failure notice");

    seen = false;
    dispatcher.dispatchSessionNotification({ id: "unseen", route: buildRoute() } as any, request("unseen"));
    await waitFor(() => calls.some((call) => call.kind === "chat-send"), "deferred wake sent");
    assert.equal(asChatSend(calls.find((call) => call.kind === "chat-send")!).message, "[fail] Failed. ID: unseen");
    assert.deepEqual(skipped, ["the launching orchestrator turn already saw the failure"]);
  });

  it("marks completion follow-up wakes successful after normal marker-free final text", async () => {
    chatSendStdout = "Sent the routed summary for PR #185 without repeating the link.\n";
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-visible-followup",
      route: buildRoute(),
    };
    let wakeSucceeded = 0;
    let wakeFailed = 0;

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      wakeMessage: "Coding agent session completed. Send the user a short factual completion summary.",
      notifyUser: "never",
      completionWakeSummaryRequired: true,
      hooks: {
        onWakeSucceeded: () => { wakeSucceeded += 1; },
        onWakeFailed: () => { wakeFailed += 1; },
      },
    });

    await waitForCalls(1);
    await waitFor(() => wakeSucceeded === 1, "completion follow-up wake validation success");

    assert.equal(wakeSucceeded, 1);
    assert.equal(wakeFailed, 0);
  });

  it("does not treat legacy completion skip marker text as a transport skip", async () => {
    chatSendStdout = "COMPLETION_FOLLOWUP_SKIPPED: internal pipeline continuing\n";
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-skipped-followup",
      route: buildRoute(),
    };
    let skippedReason = "";
    let wakeSucceeded = 0;
    let wakeFailed = 0;

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      wakeMessage: "Coding agent session completed. Send the user a short factual completion summary.",
      notifyUser: "never",
      completionWakeSummaryRequired: true,
      hooks: {
        onWakeSucceeded: () => { wakeSucceeded += 1; },
        onWakeSkipped: (reason) => { skippedReason = reason; },
        onWakeFailed: () => { wakeFailed += 1; },
      },
    });

    await waitForCalls(1);
    await waitFor(() => wakeSucceeded === 1, "completion follow-up wake success");

    assert.equal(wakeSucceeded, 1);
    assert.equal(wakeFailed, 0);
    assert.equal(skippedReason, "");
  });

  it("repairs Telegram topic follow-ups before notifying or waking", async () => {
    const dispatcher = createDispatcher();
    const session: FakeSession = {
      id: "session-telegram-topic-repair",
      route: {
        provider: "telegram",
        accountId: "bot",
        target: "5551234",
        threadId: "13832",
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
      },
      originChannel: "telegram",
      originThreadId: 13832,
      originSessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      wakeMessage: "Coding agent session completed.",
      notifyUser: "always",
    });
    const calls = await waitForCalls(2);

    assert.equal(calls.length, 2);
    const notifyCall = calls.find((call) => call.kind === "durable-send");
    const wakeCall = calls.find((call) => call.kind === "chat-send");
    assert.ok(notifyCall, "expected a durable-send notification");
    assert.ok(wakeCall, "expected a chat.send wake call");

    const notifyArgs = asDurableSend(notifyCall);
    assert.equal(notifyArgs.to, "-1001234567890");
    assert.equal(notifyArgs.threadId, "13832");

    const wakeParams = asChatSend(wakeCall);
    assert.equal(wakeParams.sessionKey, "agent:main:telegram:group:-1001234567890:topic:13832");
    assert.equal(wakeParams.channel, undefined);
    assert.equal(wakeParams.accountId, undefined);
    assert.equal(wakeParams.target, undefined);
    assert.equal(wakeParams.threadId, undefined);
  });

  it("treats empty button rows as a plain direct notification instead of an interactive failure", async () => {
    const dispatcher = createDispatcher();
    // An explicit system route is not directly deliverable; its session key
    // still identifies the origin conversation for the system event.
    const session: FakeSession = {
      id: "session-empty-button-rows",
      route: { provider: "system", target: "system", sessionKey: NON_ROUTABLE_ORIGIN_SESSION_KEY },
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
      buttons: [[], []],
    });
    const calls = await waitForCalls(1);

    assert.deepEqual(calls, [systemEvent("🚀 launched", "session-empty-button-rows", NON_ROUTABLE_ORIGIN_SESSION_KEY)]);
  });
});
