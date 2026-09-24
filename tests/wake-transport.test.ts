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

  it("enqueues to the main session and requests an immediate wake like `system event --mode now`", async () => {
    const { events, heartbeats } = installSystem();

    await new RuntimeSystemEventTransport().enqueue("Session finished", { contextKey: "openclaw-code-agent:s1" });

    assert.deepEqual(events, [{ text: "Session finished", options: { sessionKey: "main", contextKey: "openclaw-code-agent:s1" } }]);
    assert.deepEqual(heartbeats, [{ source: "notifications-event", intent: "immediate", reason: "wake" }]);
  });

  it("targets the origin session when a session key is known", async () => {
    const { events, heartbeats } = installSystem();
    const sessionKey = "agent:main:telegram:group:-1003863755361:topic:13832";

    await new RuntimeSystemEventTransport().enqueue("Wake", { sessionKey });

    assert.deepEqual(events, [{ text: "Wake", options: { sessionKey } }]);
    assert.deepEqual(heartbeats, [{ source: "notifications-event", intent: "immediate", reason: "wake", sessionKey }]);
  });

  it("falls back to the main session when the host rejects the targeted key", async () => {
    const events: Array<Record<string, unknown>> = [];
    const { heartbeats } = installSystem({
      enqueueSystemEvent: (_text, options) => {
        if (options.sessionKey !== "main") throw new Error("system events require an agent-qualified sessionKey");
        events.push(options);
        return true;
      },
    });

    await new RuntimeSystemEventTransport().enqueue("Wake", { sessionKey: "agent:main:subagent:x" });

    assert.deepEqual(events, [{ sessionKey: "main" }]);
    assert.deepEqual(heartbeats, [{ source: "notifications-event", intent: "immediate", reason: "wake" }]);
  });

  it("rejects when the runtime system surface is unavailable", async () => {
    setPluginRuntime({});
    await assert.rejects(
      () => new RuntimeSystemEventTransport().enqueue("Wake"),
      /runtime system events are unavailable/,
    );
  });
});
