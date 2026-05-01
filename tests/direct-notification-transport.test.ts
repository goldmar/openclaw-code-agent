import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { RuntimeDirectNotificationTransport } from "../src/direct-notification-transport";
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
});
