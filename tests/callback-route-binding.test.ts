import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { callbackMatchesTokenRoute, type CallbackConversation } from "../src/callback-route-binding";
import { SessionActionTokenStore } from "../src/session-action-token-store";

const CHAT = "-1001234567890";
const OTHER_CHAT = "-1009876543210";

describe("callback route binding (N2)", () => {
  it("accepts only the saved Telegram topic, and accepts a prefixed plain-chat target", () => {
    const route = { provider: "telegram", target: CHAT, threadId: "42" };
    assert.equal(callbackMatchesTokenRoute({ channel: "telegram", conversationId: `${CHAT}:topic:42`, parentConversationId: CHAT, chatId: CHAT }, route), true);
    assert.equal(callbackMatchesTokenRoute({ channel: "telegram", conversationId: `${CHAT}:topic:7`, chatId: CHAT }, route), false);
    assert.equal(callbackMatchesTokenRoute({ channel: "telegram", conversationId: CHAT }, { provider: "telegram", target: `telegram:${CHAT}` }), true);
  });

  it("normalizes the host's numeric topic alias while preserving topic binding", () => {
    const route = { provider: "telegram", target: `telegram:${CHAT}:42`, accountId: "bot" };
    const callback = { channel: "telegram", accountId: "bot", chatId: CHAT,
      conversationId: `${CHAT}:topic:42`, threadId: 42, isForum: true };
    assert.equal(callbackMatchesTokenRoute(callback, route), true);
    assert.equal(callbackMatchesTokenRoute({ ...callback, conversationId: `${CHAT}:42` }, route), true);
    assert.equal(callbackMatchesTokenRoute({ ...callback, conversationId: `${CHAT}:7`, threadId: 7 }, route), false);
    assert.equal(callbackMatchesTokenRoute(callback, { ...route, threadId: "7" }), false);
    assert.equal(callbackMatchesTokenRoute(callback, { ...route, target: `${CHAT}:direct-topic:42` }), false);
  });

  it("requires the recorded account and rejects missing topic or contradictory chat/thread metadata", () => {
    const route = { provider: "telegram", accountId: "bot", target: CHAT, threadId: "42" };
    const callback = { channel: "telegram", accountId: "bot", chatId: CHAT,
      conversationId: `${CHAT}:topic:42`, threadId: 42, isForum: true };
    assert.equal(callbackMatchesTokenRoute(callback, route), true);
    const patches: Partial<CallbackConversation>[] = [
      { accountId: "other" }, { accountId: undefined }, { chatId: OTHER_CHAT },
      { parentConversationId: OTHER_CHAT }, { threadId: 7 }, { threadId: "invalid" },
      { conversationId: `${CHAT}:direct-topic:42` }, { isForum: false },
      { conversationId: "unreadable" }, { threadId: undefined, conversationId: CHAT },
    ];
    for (const patch of patches) {
      assert.equal(callbackMatchesTokenRoute({ ...callback, ...patch }, route), false, JSON.stringify(patch));
    }
    // Accountless historical routes still enforce their saved topic.
    assert.equal(callbackMatchesTokenRoute({ ...callback, accountId: undefined }, { ...route, accountId: undefined }), true);
    assert.equal(callbackMatchesTokenRoute({ ...callback, threadId: 7, conversationId: `${CHAT}:topic:7` },
      { ...route, accountId: undefined }), false);
  });

  it("normalizes General without letting a plain-chat token act from another forum topic", () => {
    const general = { channel: "telegram", chatId: CHAT, isForum: true };
    const plainRoute = { provider: "telegram", target: CHAT };
    assert.equal(callbackMatchesTokenRoute(general, plainRoute), true);
    assert.equal(callbackMatchesTokenRoute({ ...general, conversationId: `${CHAT}:topic:1`, threadId: 1 }, plainRoute), true);
    assert.equal(callbackMatchesTokenRoute(general, { ...plainRoute, threadId: "1" }), true);
    assert.equal(callbackMatchesTokenRoute({ ...general, threadId: 42 }, plainRoute), false);
    assert.equal(callbackMatchesTokenRoute({ ...general, conversationId: `${CHAT}:topic:42` }, plainRoute), false);
  });

  it("keeps direct-message topics distinct from forum and ordinary DM threads", () => {
    const route = { provider: "telegram", target: "telegram:1234:direct-topic:42" };
    const callback = { channel: "telegram", chatId: "1234", conversationId: "1234:direct-topic:42", isForum: false };
    assert.equal(callbackMatchesTokenRoute(callback, route), true);
    assert.equal(callbackMatchesTokenRoute({ ...callback, threadId: 42 }, route), true);
    assert.equal(callbackMatchesTokenRoute({ ...callback, isForum: true }, route), false);
    assert.equal(callbackMatchesTokenRoute({ channel: "telegram", chatId: "1234", threadId: 42, isForum: false },
      { provider: "telegram", target: "1234:topic:42" }), false);
    for (const conversationId of ["1234", "1234:topic:42", "1234:direct-topic:7"]) {
      assert.equal(callbackMatchesTokenRoute({ ...callback, conversationId }, route), false);
    }
    assert.equal(callbackMatchesTokenRoute(callback, { provider: "telegram", target: "1234", threadId: "42" }), false);
    assert.equal(callbackMatchesTokenRoute({ channel: "telegram", chatId: "1234", threadId: 42, isForum: false },
      { provider: "telegram", target: "1234", threadId: "42" }), true);
    assert.equal(callbackMatchesTokenRoute(callback, { provider: "telegram", target: "1234:direct-topic:0" }), false);
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

  it("lets unbound tokens (older builds) through, but refuses a bound token when the callback's chat is unknown", () => {
    assert.equal(callbackMatchesTokenRoute({ channel: "telegram", conversationId: OTHER_CHAT }, undefined), true);
    assert.equal(callbackMatchesTokenRoute({ channel: "discord" }, { provider: "discord", target: "channel:111111111111111111" }), false);
    assert.equal(callbackMatchesTokenRoute({ channel: "telegram" }, { provider: "telegram", target: CHAT }), false);
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
