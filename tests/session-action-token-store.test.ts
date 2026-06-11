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

    assert.equal(store.purgeExpiredActionTokens((consumed?.consumedAt ?? 0) + 200), true);
    assert.equal(store.listForPersistence().length, 0);
    assert.equal(store.purgeExpiredActionTokens(Date.now()), false);

    const boundaryToken = store.createActionToken("session-1", "view-output");
    const consumedBoundary = store.consumeActionToken(boundaryToken.id);
    assert.ok(consumedBoundary?.consumedAt);
    assert.equal(store.nextExpiryAt(), consumedBoundary.consumedAt + 100);
    assert.equal(store.purgeExpiredActionTokens(consumedBoundary.consumedAt + 100), true);
    assert.equal(store.getActionToken(boundaryToken.id), undefined);

    const tokenA = store.createActionToken("session-2", "view-output");
    const tokenB = store.createActionToken("session-2", "session-resume");
    assert.equal(store.listForPersistence().length, 2);

    store.deleteActionTokensForSession("session-2");
    assert.equal(store.getActionToken(tokenA.id), undefined);
    assert.equal(store.getActionToken(tokenB.id), undefined);
    assert.equal(store.listForPersistence().length, 0);

    const policyToken = store.createActionToken("session-3", "repo-policy-set");
    const outputToken = store.createActionToken("session-3", "view-output");
    const otherPolicyToken = store.createActionToken("session-4", "repo-policy-set");
    assert.deepEqual(
      store.listActiveActionTokens("repo-policy-set").map((active) => active.id).sort(),
      [otherPolicyToken.id, policyToken.id].sort(),
    );

    store.deleteActionTokensForSessionByKind("session-3", "repo-policy-set");

    assert.equal(store.getActionToken(policyToken.id), undefined);
    assert.equal(store.getActionToken(outputToken.id)?.id, outputToken.id);
    assert.equal(store.getActionToken(otherPolicyToken.id)?.id, otherPolicyToken.id);
    assert.deepEqual(store.listActiveActionTokens("repo-policy-set").map((active) => active.id), [otherPolicyToken.id]);
  });
});
