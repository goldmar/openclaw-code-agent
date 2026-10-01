import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDurableSendResult,
  directNotificationTransportInternals,
  DirectNotificationDeliveryError,
  DirectNotificationDeliveryUnknownError,
  RuntimeDirectNotificationTransport,
  type DurableMessageBatchSendResult,
} from "../src/direct-notification-transport";
import { buildWaitingForInputPayload } from "../src/session-notification-builders/waiting";
import { getRuntimeConfig, setPluginRuntime } from "../src/runtime-store";

type SendCall = Record<string, any>;

const TOPIC_ROUTE = {
  channel: "telegram",
  accountId: "default",
  target: "-1001234567890",
  threadId: "28",
  sessionKey: "agent:main:telegram:group:-1001234567890:topic:28",
};

function sentResult(): DurableMessageBatchSendResult {
  return { status: "sent", results: [], receipt: {} } as unknown as DurableMessageBatchSendResult;
}

function recordingTransport(
  result: DurableMessageBatchSendResult | (() => Promise<DurableMessageBatchSendResult>) = sentResult(),
) {
  const calls: SendCall[] = [];
  const transport = new RuntimeDirectNotificationTransport(async () => (async (params: SendCall) => {
    calls.push(params);
    return typeof result === "function" ? await result() : result;
  }) as never);
  return { calls, transport };
}

describe("RuntimeDirectNotificationTransport", () => {
  afterEach(() => {
    setPluginRuntime(undefined);
    delete process.env.OPENCLAW_CODE_AGENT_BUTTON_DIAGNOSTICS;
  });

  it("sends Telegram topic text through the host durable outbound queue", async () => {
    const cfg = { channels: { telegram: { enabled: true } } };
    setPluginRuntime({}, cfg);
    const { calls, transport } = recordingTransport();

    await transport.send(TOPIC_ROUTE, "🚀 launched");

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      cfg,
      channel: "telegram",
      to: "-1001234567890",
      accountId: "default",
      threadId: "28",
      payloads: [{ text: "🚀 launched" }],
      durability: "required",
    });
  });

  it("uses runtime.config.current when no service config snapshot is stored", async () => {
    const cfg = { channels: { telegram: { enabled: true } }, source: "runtime-current" };
    setPluginRuntime({ config: { current: () => cfg } });
    const { calls, transport } = recordingTransport();

    await transport.send(TOPIC_ROUTE, "🚀 launched");

    assert.equal(calls[0]?.cfg, cfg);
  });

  it("forwards a durable admission observer only when requested", async () => {
    setPluginRuntime({}, {});
    const { calls, transport } = recordingTransport();
    let admissions = 0;

    await transport.send(TOPIC_ROUTE, "Reminder", undefined, {
      onDeliveryIntent: () => { admissions += 1; },
    });

    assert.equal(typeof calls[0]?.onDeliveryIntent, "function");
    calls[0]?.onDeliveryIntent({ id: "durable-intent" });
    assert.equal(admissions, 1);
  });

  it("caches a null runtime.config.current result", () => {
    let runtimeConfigReads = 0;
    setPluginRuntime({
      config: {
        current: (): null => {
          runtimeConfigReads += 1;
          return null;
        },
      },
    });

    assert.equal(getRuntimeConfig(), null);
    assert.equal(getRuntimeConfig(), null);
    assert.equal(runtimeConfigReads, 1);
  });

  it("preserves the service config when a later runtime-only registration occurs", async () => {
    const serviceCfg = { source: "service-start" };
    let runtimeConfigReads = 0;
    const runtime = {
      config: {
        current: () => {
          runtimeConfigReads += 1;
          return { source: "register" };
        },
      },
    };
    setPluginRuntime(runtime, serviceCfg);
    setPluginRuntime(runtime);
    const { calls, transport } = recordingTransport();

    await transport.send(TOPIC_ROUTE, "✅ completed");

    assert.equal(calls[0]?.cfg, serviceCfg);
    assert.equal(runtimeConfigReads, 0);
  });

  it("omits absent account and thread ids", async () => {
    setPluginRuntime({}, {});
    const { calls, transport } = recordingTransport();

    await transport.send({ channel: "discord", target: "channel:123" }, "Plain notification");

    assert.equal("accountId" in (calls[0] ?? {}), false);
    assert.equal("threadId" in (calls[0] ?? {}), false);
    assert.deepEqual(calls[0]?.payloads, [{ text: "Plain notification" }]);
  });

  it("delivers interactive buttons as a channel-agnostic presentation for core rendering", async () => {
    setPluginRuntime({}, {});
    const { calls, transport } = recordingTransport();

    await transport.send(TOPIC_ROUTE, "Plan ready", [[
      { label: "Approve", callbackData: "token-approve", style: "success" },
      { label: "Revise", callbackData: "code-agent:token-revise", style: "secondary" },
    ], [], [
      { label: "Reject", callbackData: "token-reject", style: "danger" },
    ]]);

    assert.deepEqual(calls[0]?.payloads, [{
      text: "Plan ready",
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Approve", value: "code-agent:token-approve", style: "success" },
              { label: "Revise", value: "code-agent:token-revise", style: "secondary" },
            ],
          },
          {
            type: "buttons",
            buttons: [{ label: "Reject", value: "code-agent:token-reject", style: "danger" }],
          },
        ],
      },
    }]);
  });

  it("sends generated plan-brief pages as text and keeps final controls on the last page", async () => {
    setPluginRuntime({}, {});
    const { calls, transport } = recordingTransport();
    const brief = buildWaitingForInputPayload({
      session: { id: "brief", name: "brief", pendingPlanApproval: true, planDecisionVersion: 1 } as any,
      preview: "", originThreadLine: "", planApprovalMode: "ask",
      planArtifact: { steps: [], markdown: "## Scope\n| File | Decision |\n|---|---|\n| video.ts | Local decoding |\n## Risks\n" + "Private frames may leak. ".repeat(250) },
      planApprovalButtons: [[{ label: "Approve", callbackData: "approve-token", style: "primary" },
        { label: "Revise", callbackData: "revise-token", style: "secondary" },
        { label: "Reject", callbackData: "reject-token", style: "danger" }]],
    });

    for (const message of brief.userMessages!) {
      await transport.send({ channel: "telegram", target: "test-target", accountId: "default" }, message.text, message.buttons);
    }

    const payloads = calls.map((call) => call.payloads[0]);
    assert.equal(payloads.length, brief.userMessages!.length);
    assert.ok(payloads.slice(0, -1).every((payload) => payload.presentation === undefined));
    assert.match(payloads.map((payload) => payload.text).join("\n"), /File: video.ts; Decision: Local decoding/);
    assert.deepEqual(
      payloads.at(-1).presentation.blocks[0].buttons.map((button: any) => button.label),
      ["Approve", "Revise", "Reject"],
    );
  });

  it("fails before sending when no runtime config snapshot is available", async () => {
    const { calls, transport } = recordingTransport();

    await assert.rejects(() => transport.send(TOPIC_ROUTE, "text"), DirectNotificationDeliveryError);
    assert.equal(calls.length, 0);
  });

  it("reports a failed durable send as a delivery error", async () => {
    setPluginRuntime({}, {});
    const { transport } = recordingTransport({
      status: "failed",
      error: new Error("chat not found"),
      stage: "platform_send",
    } as unknown as DurableMessageBatchSendResult);

    await assert.rejects(
      () => transport.send(TOPIC_ROUTE, "text"),
      /durable delivery to telegram failed: chat not found \(platform_send\)/,
    );
  });

  it("propagates sender exceptions", async () => {
    setPluginRuntime({}, {});
    const { transport } = recordingTransport(async () => {
      throw new Error("Reply delivery runtime could not load before dispatch");
    });

    await assert.rejects(() => transport.send(TOPIC_ROUTE, "text"), /could not load before dispatch/);
  });
});

describe("presentation contract", () => {
  it("only emits host button styles and Telegram-sized namespaced callback values", async () => {
    // Core renders the presentation: Telegram maps styles through
    // `toTelegramButtonStyle` (primary/success/danger; others are dropped) and
    // sends `value` as `callback_data`, which Telegram caps at 64 bytes.
    const hostStyles = new Set(["primary", "secondary", "success", "danger"]);
    setPluginRuntime({}, {});
    const { calls, transport } = recordingTransport();
    const payload = buildWaitingForInputPayload({
      session: { id: "contract", name: "contract", pendingPlanApproval: true, planDecisionVersion: 1 } as any,
      preview: "Plan", originThreadLine: "", planApprovalMode: "ask",
      planApprovalButtons: [[{ label: "Approve", callbackData: "a".repeat(21), style: "primary" },
        { label: "Revise", callbackData: "b".repeat(21), style: "secondary" },
        { label: "Reject", callbackData: "c".repeat(21), style: "danger" }]],
    });
    const last = payload.userMessages?.at(-1) ?? { text: payload.userMessage ?? "Plan", buttons: payload.buttons };

    await transport.send(TOPIC_ROUTE, last.text, last.buttons);

    const buttons = calls[0]?.payloads[0]?.presentation?.blocks.flatMap((block: any) => block.buttons) ?? [];
    assert.equal(buttons.length, 3);
    for (const button of buttons) {
      assert.ok(button.style === undefined || hostStyles.has(button.style), `unexpected style ${button.style}`);
      assert.match(button.value, /^code-agent:/);
      assert.ok(Buffer.byteLength(button.value, "utf8") <= 64, `callback value too long: ${button.value}`);
      assert.ok(button.label.trim().length > 0);
    }
  });
});

describe("classifyDurableSendResult", () => {
  it("never reports reached or intentionally suppressed sends as failures", () => {
    assert.deepEqual(classifyDurableSendResult(sentResult()), { delivered: true });
    assert.equal(classifyDurableSendResult({
      status: "partial_failed",
      results: [],
      receipt: {},
      error: new Error("second chunk failed"),
      sentBeforeError: true,
    } as unknown as DurableMessageBatchSendResult).delivered, true);
    assert.deepEqual(classifyDurableSendResult({
      status: "suppressed",
      results: [],
      receipt: {},
      reason: "cancelled_by_message_sending_hook",
    } as unknown as DurableMessageBatchSendResult), { delivered: true, reason: "suppressed: cancelled_by_message_sending_hook" });
    assert.equal(classifyDurableSendResult({
      status: "failed",
      error: new Error("x"),
    } as unknown as DurableMessageBatchSendResult).delivered, false);
  });
});

describe("RuntimeDirectNotificationTransport: internal chat (WebChat)", () => {
  const WEBCHAT_ROUTE = {
    channel: "webchat",
    target: "agent:main:ios-00000000-0000-4000-8000-000000000001",
    sessionKey: "agent:main:ios-00000000-0000-4000-8000-000000000001",
  };
  const realExecFile = directNotificationTransportInternals.execFile;
  afterEach(() => {
    directNotificationTransportInternals.execFile = realExecFile;
    setPluginRuntime(undefined);
  });

  function sendInternal(transport: RuntimeDirectNotificationTransport,
    ...[route, text, buttons, options]: Parameters<RuntimeDirectNotificationTransport["send"]>) {
    return transport.send(route, text, buttons, { beforeInternalChatSend: async () => {}, ...options });
  }

  function fakeExecFile(err: Error | null, stderr = "", stdout = JSON.stringify({ ok: true, messageId: "notice-1" })) {
    const calls: Array<{ file: string; args: string[] }> = [];
    directNotificationTransportInternals.execFile = ((file: string, args: string[], _opts: unknown, cb: Function) => {
      calls.push({ file, args });
      cb(err, stdout, stderr);
    }) as never;
    return calls;
  }

  it("appends the notice with chat.inject instead of the durable outbound queue", async () => {
    setPluginRuntime({}, { channels: {} });
    const calls = fakeExecFile(null);
    const { calls: durableCalls, transport } = recordingTransport();

    await sendInternal(transport, WEBCHAT_ROUTE, "🚀 [add-f4-foils] Launched");

    assert.equal(durableCalls.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, "openclaw");
    assert.deepEqual(calls[0].args.slice(0, 3), ["gateway", "call", "chat.inject"]);
    assert.ok(calls[0].args.includes("--json"));
    const params = JSON.parse(calls[0].args[calls[0].args.indexOf("--params") + 1]);
    assert.deepEqual(params, { sessionKey: WEBCHAT_ROUTE.sessionKey, message: "🚀 [add-f4-foils] Launched" });
  });

  it("rejects controls before appending text or reporting admission", async () => {
    const calls = fakeExecFile(null);
    const { calls: durableCalls, transport } = recordingTransport();
    let admitted = false;
    await assert.rejects(sendInternal(transport, WEBCHAT_ROUTE, "Plan ready", [[
      { label: "Approve", callbackData: "approve" },
      { label: "View PR", callbackData: "", url: "https://example.com/pr" },
    ]], { onDeliveryIntent: () => { admitted = true; } }), /cannot render notification buttons/);
    assert.equal(calls.length, 0);
    assert.equal(durableCalls.length, 0);
    assert.equal(admitted, false);
  });

  it("leaves a failed subprocess acknowledgement unknown when the append may have succeeded", async () => {
    const calls = fakeExecFile(new Error("connection closed after append"));
    const { transport } = recordingTransport();
    await assert.rejects(sendInternal(transport, WEBCHAT_ROUTE, "Already appended"), DirectNotificationDeliveryUnknownError);
    assert.equal(calls.length, 1);
  });

  it("requires the host's successful transcript identity instead of trusting exit zero", async () => {
    const { transport } = recordingTransport();
    for (const stdout of ["", "not JSON", "{}", '{"ok":false,"messageId":"x"}', '{"ok":true,"messageId":""}']) {
      const calls = fakeExecFile(null, "", stdout);
      await assert.rejects(sendInternal(transport, WEBCHAT_ROUTE, "Unconfirmed"), DirectNotificationDeliveryUnknownError);
      assert.equal(calls.length, 1);
    }
  });

  it("treats a missing CLI executable as a definite failure before submission", async () => {
    fakeExecFile(Object.assign(new Error("CLI missing"), { code: "ENOENT" }));
    const { transport } = recordingTransport();
    await assert.rejects(sendInternal(transport, WEBCHAT_ROUTE, "Never appended"), (error: unknown) =>
      error instanceof DirectNotificationDeliveryError && !(error instanceof DirectNotificationDeliveryUnknownError));
  });

  it("falls back to the target as the session key and reports a failed inject", async () => {
    fakeExecFile(new Error("exit 1"), "unknown session");
    const { transport } = recordingTransport();

    await assert.rejects(
      sendInternal(transport, { channel: "webchat", target: "agent:main:ios-x" }, "✅ done"),
      (err: unknown) => err instanceof DirectNotificationDeliveryError && /chat\.inject into agent:main:ios-x failed: unknown session/.test(err.message),
    );
  });
});
