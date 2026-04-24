import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { WakeTransport } from "../src/wake-transport";

afterEach(() => {
  delete process.env.OPENCLAW_TEST_DISCORD_LOG;
});

describe("WakeTransport", () => {
  it("keeps chat.send payloads limited to the gateway-supported session wake shape", () => {
    const transport = new WakeTransport();
    const args = transport.buildChatSendArgs(
      "agent:main:telegram:group:-1003863755361:topic:13832",
      "wake up",
      true,
    );

    assert.deepEqual(args.slice(0, 6), [
      "gateway",
      "call",
      "chat.send",
      "--expect-final",
      "--timeout",
      "30000",
    ]);
    const payload = JSON.parse(args[7] ?? "{}") as Record<string, unknown>;
    assert.equal(payload.sessionKey, "agent:main:telegram:group:-1003863755361:topic:13832");
    assert.equal(payload.message, "wake up");
    assert.equal(payload.deliver, true);
    assert.equal(payload.channel, undefined);
    assert.equal(payload.accountId, undefined);
    assert.equal(payload.target, undefined);
    assert.equal(payload.threadId, undefined);
  });

  it("encodes interactive notifications through shared presentation blocks", () => {
    const transport = new WakeTransport();
    const args = transport.buildDirectNotificationArgs({
      channel: "telegram",
      target: "-1003863755361",
      threadId: "28",
    } as any, "Plan ready", [[
      { label: "Approve", callbackData: "token-approve", style: "primary" },
      { label: "Reject", callbackData: "token-reject", style: "danger" },
    ]]);

    assert.deepEqual(args.slice(0, 8), [
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      "-1003863755361",
      "--message",
      "Plan ready",
    ]);
    assert.equal(args[8], "--thread-id");
    assert.equal(args[9], "28");
    assert.equal(args[10], "--presentation");
    assert.deepEqual(JSON.parse(args[11] ?? "{}"), {
      blocks: [{
        type: "buttons",
        buttons: [
          { label: "Approve", value: "code-agent:token-approve", style: "primary" },
          { label: "Reject", value: "code-agent:token-reject", style: "danger" },
        ],
      }],
    });
  });

  it("uses the same presentation payload shape for Discord interactive notifications", () => {
    const transport = new WakeTransport();
    const args = transport.buildDirectNotificationArgs({
      channel: "discord",
      target: "channel:123",
      accountId: "bot-account",
      threadId: "456",
    } as any, "Decision needed", [[
      { label: "Resume", callbackData: "token-resume", style: "success" },
      { label: "Later", callbackData: "token-later", style: "secondary" },
    ]]);

    assert.equal(args[8], "--account");
    assert.equal(args[9], "bot-account");
    assert.equal(args[10], "--thread-id");
    assert.equal(args[11], "456");
    assert.equal(args[12], "--presentation");
    assert.deepEqual(JSON.parse(args[13] ?? "{}"), {
      blocks: [{
        type: "buttons",
        buttons: [
          { label: "Resume", value: "code-agent:token-resume", style: "success" },
          { label: "Later", value: "code-agent:token-later", style: "secondary" },
        ],
      }],
    });
  });

  it("omits presentation for non-interactive direct notifications", () => {
    const transport = new WakeTransport();
    const args = transport.buildDirectNotificationArgs({
      channel: "discord",
      target: "channel:123",
    } as any, "Plain notification");

    assert.deepEqual(args, [
      "message",
      "send",
      "--channel",
      "discord",
      "--target",
      "channel:123",
      "--message",
      "Plain notification",
    ]);
  });

  it("prefixes callback values once even when the token is already namespaced", () => {
    const transport = new WakeTransport();
    const args = transport.buildDirectNotificationArgs({
      channel: "telegram",
      target: "-1003863755361",
    } as any, "Plan ready", [[
      { label: "Approve", callbackData: "code-agent:token-approve", style: "primary" },
    ]]);

    assert.deepEqual(JSON.parse(args[9] ?? "{}"), {
      blocks: [{
        type: "buttons",
        buttons: [
          { label: "Approve", value: "code-agent:token-approve", style: "primary" },
        ],
      }],
    });
  });

  it("drops empty button rows instead of sending empty presentation blocks", () => {
    const transport = new WakeTransport();
    const args = transport.buildDirectNotificationArgs({
      channel: "discord",
      target: "channel:123",
      threadId: "456",
    } as any, "Decision needed", [
      [],
      [{ label: "Resume", callbackData: "token-resume", style: "success" }],
      [],
    ]);

    assert.equal(args[10], "--presentation");
    assert.deepEqual(JSON.parse(args[11] ?? "{}"), {
      blocks: [{
        type: "buttons",
        buttons: [
          { label: "Resume", value: "code-agent:token-resume", style: "success" },
        ],
      }],
    });
  });

  it("omits presentation entirely when button rows are structurally empty", () => {
    const transport = new WakeTransport();
    const args = transport.buildDirectNotificationArgs({
      channel: "telegram",
      target: "-1003863755361",
      threadId: "28",
    } as any, "Plan ready", [[], []]);

    assert.deepEqual(args, [
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      "-1003863755361",
      "--message",
      "Plan ready",
      "--thread-id",
      "28",
    ]);
  });
});
