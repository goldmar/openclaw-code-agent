import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RuntimeDirectNotificationTransport,
  directNotificationTransportInternals,
} from "../src/direct-notification-transport";
import { getRuntimeConfig, setPluginRuntime } from "../src/runtime-store";

describe("RuntimeDirectNotificationTransport", () => {
  afterEach(() => {
    setPluginRuntime(undefined);
    delete process.env.OPENCLAW_CODE_AGENT_BUTTON_DIAGNOSTICS;
  });

  it("sends Telegram topic text through the in-process outbound adapter", async () => {
    const calls: Array<Record<string, unknown>> = [];
    setPluginRuntime({
      channel: {
        outbound: {
          loadAdapter: async (channelId: string) => {
            assert.equal(channelId, "telegram");
            return {
              sendText: async (ctx: Record<string, unknown>) => {
                calls.push(ctx);
              },
            };
          },
        },
      },
    }, { channels: { telegram: { enabled: true } } });

    await new RuntimeDirectNotificationTransport().send(
      {
        channel: "telegram",
        accountId: "default",
        target: "-1003863755361",
        threadId: "28",
        sessionKey: "agent:main:telegram:group:-1003863755361:topic:28",
      },
      "🚀 launched",
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.to, "-1003863755361");
    assert.equal(calls[0]?.text, "🚀 launched");
    assert.equal(calls[0]?.accountId, "default");
    assert.equal(calls[0]?.threadId, "28");
  });

  it("uses runtime.config.current when no service config snapshot is stored", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const cfg = { channels: { telegram: { enabled: true } }, source: "runtime-current" };
    setPluginRuntime({
      config: {
        current: () => cfg,
      },
      channel: {
        outbound: {
          loadAdapter: async (channelId: string) => {
            assert.equal(channelId, "telegram");
            return {
              sendText: async (ctx: Record<string, unknown>) => {
                calls.push(ctx);
              },
            };
          },
        },
      },
    });

    await new RuntimeDirectNotificationTransport().send(
      {
        channel: "telegram",
        accountId: "default",
        target: "-1003863755361",
        threadId: "28",
        sessionKey: "agent:main:telegram:group:-1003863755361:topic:28",
      },
      "🚀 launched",
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cfg, cfg);
    assert.equal(calls[0]?.to, "-1003863755361");
    assert.equal(calls[0]?.accountId, "default");
    assert.equal(calls[0]?.threadId, "28");
  });

  it("caches a null runtime.config.current result", async () => {
    let runtimeConfigReads = 0;
    setPluginRuntime({
      config: {
        current: () => {
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
    const calls: Array<Record<string, unknown>> = [];
    const serviceCfg = { channels: { telegram: { enabled: true } }, source: "service-start" };
    const runtimeCfg = { channels: { telegram: { enabled: true } }, source: "register" };
    let runtimeConfigReads = 0;
    const runtime = {
      config: {
        current: () => {
          runtimeConfigReads += 1;
          return runtimeCfg;
        },
      },
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async (ctx: Record<string, unknown>) => {
              calls.push(ctx);
            },
          }),
        },
      },
    };

    setPluginRuntime(runtime, serviceCfg);
    setPluginRuntime(runtime);

    await new RuntimeDirectNotificationTransport().send(
      {
        channel: "telegram",
        accountId: "default",
        target: "-1003863755361",
        threadId: "28",
        sessionKey: "agent:main:telegram:group:-1003863755361:topic:28",
      },
      "✅ completed",
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.cfg, serviceCfg);
    assert.equal(runtimeConfigReads, 0);
  });

  it("preserves interactive buttons through presentation payload delivery", async () => {
    const payloads: unknown[] = [];
    setPluginRuntime({
      channel: {
        outbound: {
          loadAdapter: async () => ({
            renderPresentation: ({ payload }: { payload: unknown }) => ({
              ...(payload as Record<string, unknown>),
              channelData: { rendered: true },
            }),
            sendPayload: async (ctx: { payload: unknown }) => {
              payloads.push(ctx.payload);
            },
          }),
        },
      },
    }, { channels: { telegram: { enabled: true } } });

    await new RuntimeDirectNotificationTransport().send(
      {
        channel: "telegram",
        accountId: "default",
        target: "-1003863755361",
        threadId: "28",
      },
      "Plan needs approval",
      [[{ label: "Approve", callbackData: "token-approve", style: "success" }]],
    );

    assert.deepEqual(payloads, [
      {
        text: "Plan needs approval",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Approve",
                  value: "code-agent:token-approve",
                  style: "success",
                },
              ],
            },
          ],
        },
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Approve",
                  value: "code-agent:token-approve",
                  style: "success",
                },
              ],
            },
          ],
        },
        channelData: {
          rendered: true,
          telegram: {
            buttons: [[
              {
                text: "Approve",
                callback_data: "code-agent:token-approve",
              },
            ]],
          },
        },
      },
    ]);
  });

  it("adds interactive buttons when the runtime adapter sends payloads without rendering presentation", async () => {
    const payloads: unknown[] = [];
    setPluginRuntime({
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendPayload: async (ctx: { payload: unknown }) => {
              payloads.push(ctx.payload);
            },
          }),
        },
      },
    }, { channels: { telegram: { enabled: true } } });

    await new RuntimeDirectNotificationTransport().send(
      {
        channel: "telegram",
        accountId: "default",
        target: "-1003863755361",
        threadId: "28",
      },
      "Plan needs approval",
      [[
        { label: "Approve", callbackData: "approve-token", style: "primary" },
        { label: "Revise", callbackData: "revise-token", style: "secondary" },
        { label: "Reject", callbackData: "reject-token", style: "danger" },
      ]],
    );

    assert.deepEqual(payloads[0], {
      text: "Plan needs approval",
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Approve", value: "code-agent:approve-token", style: "primary" },
              { label: "Revise", value: "code-agent:revise-token", style: "secondary" },
              { label: "Reject", value: "code-agent:reject-token", style: "danger" },
            ],
          },
        ],
      },
      interactive: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Approve", value: "code-agent:approve-token", style: "primary" },
              { label: "Revise", value: "code-agent:revise-token", style: "secondary" },
              { label: "Reject", value: "code-agent:reject-token", style: "danger" },
            ],
          },
        ],
      },
      channelData: {
        telegram: {
          buttons: [[
            { text: "Approve", callback_data: "code-agent:approve-token" },
            { text: "Revise", callback_data: "code-agent:revise-token" },
            { text: "Reject", callback_data: "code-agent:reject-token" },
          ]],
        },
      },
    });
  });

  it("repairs rendered payloads that accidentally drop interactive button data", async () => {
    const payloads: unknown[] = [];
    setPluginRuntime({
      channel: {
        outbound: {
          loadAdapter: async () => ({
            renderPresentation: ({ payload }: { payload: unknown }) => {
              const { interactive: _interactive, ...rest } = payload as Record<string, unknown>;
              return { ...rest, channelData: { telegram: {} } };
            },
            sendPayload: async (ctx: { payload: unknown }) => {
              payloads.push(ctx.payload);
            },
          }),
        },
      },
    }, { channels: { telegram: { enabled: true } } });

    await new RuntimeDirectNotificationTransport().send(
      {
        channel: "telegram",
        accountId: "default",
        target: "-1003863755361",
        threadId: "28",
      },
      "Plan needs approval",
      [[{ label: "Reject", callbackData: "reject-token", style: "danger" }]],
    );

    assert.deepEqual((payloads[0] as any).interactive, {
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Reject", value: "code-agent:reject-token", style: "danger" },
          ],
        },
      ],
    });
    assert.deepEqual((payloads[0] as any).channelData.telegram.buttons, [[
      { text: "Reject", callback_data: "code-agent:reject-token" },
    ]]);
  });

  it("repairs rendered payloads that initialize Telegram buttons to an empty array", async () => {
    const payloads: unknown[] = [];
    setPluginRuntime({
      channel: {
        outbound: {
          loadAdapter: async () => ({
            renderPresentation: ({ payload }: { payload: unknown }) => ({
              ...(payload as Record<string, unknown>),
              channelData: { telegram: { buttons: [] } },
            }),
            sendPayload: async (ctx: { payload: unknown }) => {
              payloads.push(ctx.payload);
            },
          }),
        },
      },
    }, { channels: { telegram: { enabled: true } } });

    await new RuntimeDirectNotificationTransport().send(
      {
        channel: "telegram",
        accountId: "default",
        target: "-1003863755361",
        threadId: "28",
      },
      "Plan needs approval",
      [[{ label: "Approve", callbackData: "approve-token", style: "primary" }]],
    );

    assert.deepEqual((payloads[0] as any).channelData.telegram.buttons, [[
      { text: "Approve", callback_data: "code-agent:approve-token" },
    ]]);
  });

  it("omits generated Telegram callback buttons that exceed the 64-byte callback_data limit", async () => {
    const payloads: unknown[] = [];
    setPluginRuntime({
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendPayload: async (ctx: { payload: unknown }) => {
              payloads.push(ctx.payload);
            },
          }),
        },
      },
    }, { channels: { telegram: { enabled: true } } });

    await new RuntimeDirectNotificationTransport().send(
      {
        channel: "telegram",
        accountId: "default",
        target: "-1003863755361",
        threadId: "28",
      },
      "Plan needs approval",
      [[
        { label: "Approve", callbackData: "a".repeat(53), style: "primary" },
        { label: "Too long", callbackData: "b".repeat(54), style: "secondary" },
      ]],
    );

    assert.deepEqual((payloads[0] as any).channelData.telegram.buttons, [[
      { text: "Approve", callback_data: `code-agent:${"a".repeat(53)}` },
    ]]);
  });

  it("sends Telegram plan-offer buttons as native callback_data, not text payload buttons", async () => {
    const payloads: unknown[] = [];
    setPluginRuntime({
      channel: {
        outbound: {
          loadAdapter: async () => ({
            renderPresentation: ({ payload }: { payload: unknown }) => payload,
            sendPayload: async (ctx: { payload: unknown }) => {
              payloads.push(ctx.payload);
            },
          }),
        },
      },
    }, { channels: { telegram: { enabled: true } } });

    await new RuntimeDirectNotificationTransport().send(
      {
        channel: "telegram",
        accountId: "default",
        target: "-1003863755361",
        threadId: "13832",
      },
      "Release monitor plan offer",
      [[
        { label: "Start Plan", callbackData: "26620ba6-719b-491e-bbe3-9b9f49ce293c", style: "primary" },
        { label: "Dismiss", callbackData: "9c26cebd-caf4-4551-bc9e-f52146a328dc", style: "secondary" },
      ]],
    );

    assert.deepEqual((payloads[0] as any).channelData.telegram.buttons, [[
      {
        text: "Start Plan",
        callback_data: "code-agent:26620ba6-719b-491e-bbe3-9b9f49ce293c",
      },
      {
        text: "Dismiss",
        callback_data: "code-agent:9c26cebd-caf4-4551-bc9e-f52146a328dc",
      },
    ]]);
  });

  it("emits privacy-safe diagnostics for the runtime presentation path", async (t) => {
    process.env.OPENCLAW_CODE_AGENT_BUTTON_DIAGNOSTICS = "1";
    const logs: string[] = [];
    t.mock.method(console, "info", ((message?: unknown) => {
      logs.push(String(message));
    }) as typeof console.info);
    setPluginRuntime({
      channel: {
        outbound: {
          loadAdapter: async () => ({
            renderPresentation: ({ payload, presentation }: { payload: unknown; presentation: unknown }) => ({
              ...(payload as Record<string, unknown>),
              interactive: presentation,
            }),
            sendPayload: async () => ({
              channel: "telegram",
              messageId: "123",
              chatId: "-1003863755361",
              messageThreadId: "13832",
            }),
          }),
        },
      },
    }, { channels: { telegram: { enabled: true } } });

    await new RuntimeDirectNotificationTransport().send(
      {
        channel: "telegram",
        accountId: "default",
        target: "-1003863755361",
        threadId: "13832",
        sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
      },
      "Plan needs approval",
      [[{ label: "Approve", callbackData: "secret-token-approve", style: "primary" }]],
    );

    assert.ok(logs.some((line) => line.includes('"event":"presentation_render_completed"')));
    assert.ok(logs.some((line) => line.includes('"event":"presentation_send_payload_completed"')));
    const joined = logs.join("\n");
    assert.match(joined, /"threadId":"13832"/);
    assert.match(joined, /"buttonLabels":\["Approve"\]/);
    assert.match(joined, /"callbackHashes":\["[a-f0-9]{12}"\]/);
    assert.match(joined, /"messageId":"123"/);
    assert.doesNotMatch(joined, /secret-token-approve/);
    assert.doesNotMatch(joined, /Plan needs approval/);
  });

  it("fails clearly when runtime delivery cannot preserve buttons", async () => {
    setPluginRuntime({
      channel: {
        outbound: {
          loadAdapter: async () => ({
            sendText: async () => {},
          }),
        },
      },
    }, { channels: { telegram: { enabled: true } } });

    await assert.rejects(
      () => new RuntimeDirectNotificationTransport().send(
        {
          channel: "telegram",
          target: "-1003863755361",
          threadId: "28",
        },
        "Plan needs approval",
        [[{ label: "Approve", callbackData: "token-approve" }]],
      ),
      /cannot preserve interactive presentation/,
    );
  });

  it("falls back to a bounded CLI send when the runtime outbound surface is missing", async (t) => {
    const calls: Array<{ file: string; args: string[]; timeout?: number }> = [];
    setPluginRuntime({ version: "2026.4.21", channel: {} }, { channels: { telegram: { enabled: true } } });
    t.mock.method(directNotificationTransportInternals, "execFile", ((file, args, options, callback) => {
      calls.push({ file, args: args as string[], timeout: options?.timeout });
      callback?.(null, "", "");
      return {} as any;
    }) as typeof directNotificationTransportInternals.execFile);

    await new RuntimeDirectNotificationTransport().send(
      {
        channel: "telegram",
        accountId: "default",
        target: "-1003863755361",
        threadId: "28",
      },
      "🚀 launched",
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.file, "openclaw");
    assert.equal(calls[0]?.timeout, 5_000);
    assert.deepEqual(calls[0]?.args, [
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      "-1003863755361",
      "--message",
      "🚀 launched",
      "--account",
      "default",
      "--thread-id",
      "28",
    ]);
  });

  it("includes the precise missing runtime capability when the bounded fallback fails", async (t) => {
    setPluginRuntime({ version: "2026.4.21", channel: {} }, { channels: { telegram: { enabled: true } } });
    t.mock.method(directNotificationTransportInternals, "execFile", ((_file, _args, _options, callback) => {
      callback?.(new Error("Command timed out after 5000ms"), "", "timeout");
      return {} as any;
    }) as typeof directNotificationTransportInternals.execFile);

    await assert.rejects(
      () => new RuntimeDirectNotificationTransport().send(
        {
          channel: "telegram",
          target: "-1003863755361",
          threadId: "28",
        },
        "🚀 launched",
      ),
      /channel outbound surface is unavailable.*runtimeVersion=2026\.4\.21.*bounded openclaw message send fallback failed within 5000ms timeout/s,
    );
  });

  it("reports absent plugin runtime before missing runtime config", async (t) => {
    setPluginRuntime(undefined);
    t.mock.method(directNotificationTransportInternals, "execFile", ((_file, _args, _options, callback) => {
      callback?.(new Error("spawn openclaw ENOENT"), "", "");
      return {} as any;
    }) as typeof directNotificationTransportInternals.execFile);

    await assert.rejects(
      () => new RuntimeDirectNotificationTransport().send(
        {
          channel: "telegram",
          target: "-1003863755361",
          threadId: "28",
        },
        "🚀 launched",
      ),
      /OpenClaw plugin runtime is unavailable for direct notification delivery.*fallback failed within 5000ms timeout/s,
    );
  });

  it("uses the lazily injected plugin runtime proxy from the runtime store", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let channelAccesses = 0;
    const runtime = new Proxy({ version: "2026.4.29" }, {
      get(target, prop, receiver) {
        if (prop !== "channel") return Reflect.get(target, prop, receiver);
        channelAccesses += 1;
        return {
          outbound: {
            loadAdapter: async () => ({
              sendText: async (ctx: Record<string, unknown>) => {
                calls.push(ctx);
              },
            }),
          },
        };
      },
    });
    setPluginRuntime(runtime, { channels: { telegram: { enabled: true } } });

    await new RuntimeDirectNotificationTransport().send(
      {
        channel: "telegram",
        accountId: "default",
        target: "-1003863755361",
        threadId: "28",
      },
      "✅ completed",
    );

    assert.equal(channelAccesses > 0, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.threadId, "28");
  });
});
