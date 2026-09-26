import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { callbackMatchesTokenRoute } from "../src/callback-route-binding";
import { SessionActionTokenStore } from "../src/session-action-token-store";

const CHAT = "-1001234567890";
const OTHER_CHAT = "-1009876543210";

describe("callback route binding (N2)", () => {
  it("accepts the same Telegram chat, any topic of it, and a prefixed target", () => {
    const route = { provider: "telegram", target: CHAT, threadId: "42" };
    assert.equal(callbackMatchesTokenRoute({ channel: "telegram", conversationId: `${CHAT}:topic:42`, parentConversationId: CHAT, chatId: CHAT }, route), true);
    assert.equal(callbackMatchesTokenRoute({ channel: "telegram", conversationId: `${CHAT}:topic:7`, chatId: CHAT }, route), true);
    assert.equal(callbackMatchesTokenRoute({ channel: "telegram", conversationId: CHAT }, { provider: "telegram", target: `telegram:${CHAT}` }), true);
  });

  it("refuses another Telegram chat and another channel", () => {
    const route = { provider: "telegram", target: CHAT };
    assert.equal(callbackMatchesTokenRoute({ channel: "telegram", conversationId: OTHER_CHAT, chatId: OTHER_CHAT }, route), false);
    assert.equal(callbackMatchesTokenRoute({ channel: "discord", conversationId: "channel:111111111111111111" }, route), false);
  });

  it("matches Discord channels, their threads, and DMs", () => {
    const route = { provider: "discord", target: "channel:111111111111111111" };
    assert.equal(callbackMatchesTokenRoute({ channel: "discord", conversationId: "channel:111111111111111111" }, route), true);
    assert.equal(callbackMatchesTokenRoute({ channel: "discord", conversationId: "channel:333333333333333333", parentConversationId: "111111111111111111" }, route), true);
    assert.equal(callbackMatchesTokenRoute({ channel: "discord", conversationId: "channel:222222222222222222" }, route), false);
    assert.equal(callbackMatchesTokenRoute({ channel: "discord", conversationId: "user:444444444444444444" }, { provider: "discord", target: "user:444444444444444444" }), true);
    assert.equal(callbackMatchesTokenRoute({ channel: "discord", conversationId: "user:555555555555555555" }, { provider: "discord", target: "user:444444444444444444" }), false);
  });

  it("lets unbound tokens (older builds) and callbacks without conversation details through", () => {
    assert.equal(callbackMatchesTokenRoute({ channel: "telegram", conversationId: OTHER_CHAT }, undefined), true);
    assert.equal(callbackMatchesTokenRoute({ channel: "discord" }, { provider: "discord", target: "channel:111111111111111111" }), true);
  });

  it("the token store binds unbound tokens once and keeps a minted route", () => {
    const store = new SessionActionTokenStore(() => undefined, 60_000);
    const plain = store.createActionToken("s", "worktree-merge");
    const offered = store.createActionToken("s", "plan-offer-start", { route: { provider: "telegram", target: CHAT } });
    store.bindActionTokensToRoute([plain.id, offered.id, "missing"], { provider: "telegram", target: OTHER_CHAT });
    assert.equal(store.tokens.get(plain.id)?.route?.target, OTHER_CHAT);
    assert.equal(store.tokens.get(offered.id)?.route?.target, CHAT);
  });
});
