import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionActionTokenStore } from "../src/session-action-token-store";

describe("SessionActionTokenStore", () => {
  it("creates, consumes, deletes, and purges tokens without changing serialized shape", () => {
    let changeCount = 0;
    const store = new SessionActionTokenStore(() => { changeCount++; }, 100);

    const token = store.createActionToken("session-1", "plan-approve", {
      label: "Approve",
      expiresAt: Date.now() + 1_000,
    });

    assert.equal(token.sessionId, "session-1");
    assert.equal(token.kind, "plan-approve");
    assert.equal(store.listForPersistence().length, 1);
    assert.equal(changeCount, 1);

    const consumed = store.consumeActionToken(token.id);
    assert.equal(consumed?.id, token.id);
    assert.ok(consumed?.consumedAt);

    store.purgeExpiredActionTokens((consumed?.consumedAt ?? 0) + 200);
    assert.equal(store.listForPersistence().length, 0);

    const tokenA = store.createActionToken("session-2", "view-output");
    const tokenB = store.createActionToken("session-2", "session-resume");
    assert.equal(store.listForPersistence().length, 2);

    store.deleteActionTokensForSession("session-2");
    assert.equal(store.getActionToken(tokenA.id), undefined);
    assert.equal(store.getActionToken(tokenB.id), undefined);
    assert.equal(store.listForPersistence().length, 0);
  });
});
