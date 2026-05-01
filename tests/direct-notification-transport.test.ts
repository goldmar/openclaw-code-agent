import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RuntimeDirectNotificationTransport,
  directNotificationTransportInternals,
} from "../src/direct-notification-transport";
import { setPluginRuntime } from "../src/runtime-store";

describe("RuntimeDirectNotificationTransport", () => {
  afterEach(() => {
    setPluginRuntime(undefined);
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
        channelData: { rendered: true },
      },
    ]);
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
      /channel outbound surface is unavailable.*runtimeVersion=2026\.4\.21.*bounded openclaw message send fallback failed after 5000ms/s,
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
