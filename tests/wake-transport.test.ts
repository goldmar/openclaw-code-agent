import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPresentation } from "../src/direct-notification-transport";
import { setPluginRuntime } from "../src/runtime-store";
import { RuntimeSystemEventTransport, WakeTransport } from "../src/wake-transport";

afterEach(() => {
  delete process.env.OPENCLAW_TEST_DISCORD_LOG;
});

describe("WakeTransport", () => {
  it("keeps chat.send payloads limited to the gateway-supported session wake shape", () => {
    const transport = new WakeTransport();
    const args = transport.buildChatSendArgs(
      "agent:main:telegram:group:-1001234567890:topic:13832",
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
    assert.equal(payload.sessionKey, "agent:main:telegram:group:-1001234567890:topic:13832");
    assert.equal(payload.message, "wake up");
    assert.equal(payload.deliver, true);
    assert.equal(payload.channel, undefined);
    assert.equal(payload.accountId, undefined);
    assert.equal(payload.target, undefined);
    assert.equal(payload.threadId, undefined);
  });

});

describe("buildPresentation", () => {
  it("encodes Telegram and Discord buttons as shared presentation blocks", () => {
    assert.deepEqual(buildPresentation([[
      { label: "Approve", callbackData: "token-approve", style: "primary" },
      { label: "Reject", callbackData: "token-reject", style: "danger" },
    ]]), {
      blocks: [{
        type: "buttons",
        buttons: [
          { label: "Approve", value: "code-agent:token-approve", style: "primary" },
          { label: "Reject", value: "code-agent:token-reject", style: "danger" },
        ],
      }],
    });
  });

  it("prefixes callback values once even when the token is already namespaced", () => {
    assert.deepEqual(buildPresentation([[
      { label: "Approve", callbackData: "code-agent:token-approve", style: "primary" },
    ]])?.blocks[0], {
      type: "buttons",
      buttons: [{ label: "Approve", value: "code-agent:token-approve", style: "primary" }],
    });
  });

  it("drops empty rows and omits presentation when no buttons remain", () => {
    assert.deepEqual(buildPresentation([
      [],
      [{ label: "Resume", callbackData: "token-resume", style: "success" }],
      [],
    ])?.blocks.length, 1);
    assert.equal(buildPresentation([[], []]), undefined);
    assert.equal(buildPresentation(undefined), undefined);
  });
});

describe("RuntimeSystemEventTransport", () => {
  function installSystem(overrides: { enqueueSystemEvent?: (text: string, options: Record<string, unknown>) => boolean } = {}) {
    const events: Array<{ text: string; options: Record<string, unknown> }> = [];
    const heartbeats: Array<Record<string, unknown>> = [];
    setPluginRuntime({
      system: {
        enqueueSystemEvent: overrides.enqueueSystemEvent ?? ((text: string, options: Record<string, unknown>) => {
          events.push({ text, options });
          return true;
        }),
        requestHeartbeat: (options: Record<string, unknown>) => {
          heartbeats.push(options);
        },
      },
    });
    return { events, heartbeats };
  }

  afterEach(() => {
    setPluginRuntime(undefined);
  });

  it("refuses a system event without an origin session key instead of using the main alias", async () => {
    const { events, heartbeats } = installSystem();

    await assert.rejects(
      () => new RuntimeSystemEventTransport().enqueue("Session finished", { sessionKey: " ", contextKey: "openclaw-code-agent:s1", wakeNow: true }),
      /requires the origin session key/,
    );

    assert.deepEqual(events, []);
    assert.deepEqual(heartbeats, []);
  });

  it("targets the origin session when a session key is known", async () => {
    const { events, heartbeats } = installSystem();
    const sessionKey = "agent:main:telegram:group:-1001234567890:topic:13832";

    await new RuntimeSystemEventTransport().enqueue("Wake", { sessionKey, wakeNow: true });

    assert.deepEqual(events, [{ text: "Wake", options: { sessionKey } }]);
    assert.deepEqual(heartbeats, [{ source: "notifications-event", intent: "immediate", reason: "wake", sessionKey }]);
  });

  it("enqueues a notice for the next turn without requesting a heartbeat", async () => {
    const { events, heartbeats } = installSystem();
    const sessionKey = "agent:main:telegram:group:-1001234567890:topic:13832";

    await new RuntimeSystemEventTransport().enqueue("Session started", {
      sessionKey,
      contextKey: "openclaw-code-agent:s1",
      wakeNow: false,
    });

    assert.deepEqual(events, [{ text: "Session started", options: { sessionKey, contextKey: "openclaw-code-agent:s1" } }]);
    assert.deepEqual(heartbeats, []);
  });

  it("does not reroute a refused session key to the main session", async () => {
    const attempted: Array<Record<string, unknown>> = [];
    const { heartbeats } = installSystem({
      enqueueSystemEvent: (_text, options) => {
        attempted.push(options);
        throw new Error("Multiple agents are configured, but session agent resolution has no explicit owner");
      },
    });

    await assert.rejects(
      () => new RuntimeSystemEventTransport().enqueue("Wake", { sessionKey: "agent:main:subagent:x", wakeNow: true }),
      /no explicit owner/,
    );

    assert.deepEqual(attempted, [{ sessionKey: "agent:main:subagent:x" }]);
    assert.deepEqual(heartbeats, []);
  });

  it("rejects when the runtime system surface is unavailable", async () => {
    setPluginRuntime({});
    await assert.rejects(
      () => new RuntimeSystemEventTransport().enqueue("Wake", { sessionKey: "agent:main:main", wakeNow: true }),
      /runtime system events are unavailable/,
    );
  });
});
