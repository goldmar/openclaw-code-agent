import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeFromOriginMetadata } from "../src/session-route";

describe("session-route", () => {
  it("defaults bare numeric discord targets to channel routes", () => {
    const route = routeFromOriginMetadata("discord|1481874223294054540");
    assert.deepEqual(route, {
      provider: "discord",
      accountId: undefined,
      target: "channel:1481874223294054540",
      threadId: undefined,
      sessionKey: undefined,
    });
  });

  it("keeps discord dm session keys normalized to user routes", () => {
    const route = routeFromOriginMetadata(
      "discord|1481874223294054540",
      undefined,
      "agent:main:discord:dm:1481874223294054540",
    );
    assert.deepEqual(route, {
      provider: "discord",
      accountId: undefined,
      target: "user:1481874223294054540",
      threadId: undefined,
      sessionKey: "agent:main:discord:dm:1481874223294054540",
    });
  });

  it("maps discord group session keys to channel routes", () => {
    const route = routeFromOriginMetadata(
      "discord|1481874223294054540",
      undefined,
      "agent:main:discord:group:1481874223294054540",
    );
    assert.deepEqual(route, {
      provider: "discord",
      accountId: undefined,
      target: "channel:1481874223294054540",
      threadId: undefined,
      sessionKey: "agent:main:discord:group:1481874223294054540",
    });
  });

  it("recovers Telegram topic routing from session keys when originChannel is weak", () => {
    const route = routeFromOriginMetadata(
      "telegram",
      undefined,
      "agent:main:telegram:group:-100123:topic:77",
    );
    assert.deepEqual(route, {
      provider: "telegram",
      target: "-100123",
      threadId: "77",
      sessionKey: "agent:main:telegram:group:-100123:topic:77",
    });
  });

  it("keeps generic thread suffix parsing available for non-Telegram providers", () => {
    const route = routeFromOriginMetadata(
      "slack|general",
      undefined,
      "agent:main:slack:channel:general:thread:1699999999.0001",
    );
    assert.deepEqual(route, {
      provider: "slack",
      accountId: undefined,
      target: "general",
      threadId: "1699999999.0001",
      sessionKey: "agent:main:slack:channel:general:thread:1699999999.0001",
    });
  });
});
