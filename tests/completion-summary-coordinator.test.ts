import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CompletionSummaryCoordinator,
  PRIOR_VISIBLE_SUMMARY_SKIP_REASON,
} from "../src/completion-summary-coordinator";

describe("CompletionSummaryCoordinator", () => {
  it("allows one visible follow-up for goal-owned terminal, goal, and worktree facts", () => {
    const coordinator = new CompletionSummaryCoordinator();
    const session = {
      id: "goal-owned-session",
      harnessSessionId: "h-goal-owned-session",
      goalTaskId: "goal-123",
      route: {
        provider: "telegram",
        target: "group-fixture",
        threadId: "13832",
      },
    };

    const goalDecision = coordinator.decide(session, {
      required: true,
      producer: "goal",
      outcomeKey: "goal:goal-123",
    });
    coordinator.finish(goalDecision.key, true);

    const terminalDecision = coordinator.decide(session, {
      required: true,
      producer: "terminal",
      outcomeKey: "terminal:goal-owned-session",
    });
    const worktreeDecision = coordinator.decide(session, {
      required: true,
      producer: "worktree-pr",
      outcomeKey: "worktree-pr:opened:example/repo:#1:agent/example",
    });

    assert.equal(goalDecision.allowed, true);
    assert.equal(terminalDecision.allowed, false);
    assert.equal(worktreeDecision.allowed, false);
    assert.equal(terminalDecision.skipReason, "duplicate completion follow-up wake already handled");
  });

  it("allows retry after a claimed completion summary wake fails", () => {
    const coordinator = new CompletionSummaryCoordinator();
    const session = { id: "retry-session" };

    const first = coordinator.decide(session, {
      required: true,
      producer: "terminal",
      outcomeKey: "terminal:retry-session",
    });
    coordinator.finish(first.key, false);

    const second = coordinator.decide(session, {
      required: true,
      producer: "terminal",
      outcomeKey: "terminal:retry-session",
    });

    assert.equal(first.allowed, true);
    assert.equal(second.allowed, true);
  });

  it("does not let denied claimers release another in-flight completion summary", () => {
    const coordinator = new CompletionSummaryCoordinator();
    const route = {
      provider: "telegram",
      target: "topic-fixture",
      threadId: "13832",
    };
    const firstSession = { id: "first-session", route };
    const duplicateSession = { id: "duplicate-session", route };
    const thirdSession = { id: "third-session", route };
    const fact = {
      required: true,
      producer: "worktree-pr" as const,
      outcomeKey: "worktree-pr:opened:example/repo:#172:agent/example",
    };

    const first = coordinator.decide(firstSession, fact);
    const duplicate = coordinator.decide(duplicateSession, fact);
    coordinator.finish(duplicate.key, false);
    const third = coordinator.decide(thirdSession, fact);

    assert.equal(first.allowed, true);
    assert.equal(typeof first.key, "string");
    assert.equal(duplicate.allowed, false);
    assert.equal(duplicate.key, undefined);
    assert.equal(third.allowed, false);
  });

  it("bounds abandoned in-flight claim aliases with the completed-key cap", () => {
    const coordinator = new CompletionSummaryCoordinator({ maxCompletedKeys: 1 });
    const route = {
      provider: "telegram",
      target: "topic-fixture",
      threadId: "13832",
    };

    const abandoned = coordinator.decide(
      { id: "abandoned-session", route },
      {
        required: true,
        producer: "terminal",
        outcomeKey: "terminal:abandoned-session",
      },
    );
    const newer = coordinator.decide(
      { id: "newer-session", route },
      {
        required: true,
        producer: "terminal",
        outcomeKey: "terminal:newer-session",
      },
    );
    const abandonedRetry = coordinator.decide(
      { id: "abandoned-session", route },
      {
        required: true,
        producer: "terminal",
        outcomeKey: "terminal:abandoned-session",
      },
    );

    assert.equal(abandoned.allowed, true);
    assert.equal(newer.allowed, true);
    assert.equal(abandonedRetry.allowed, true);
  });

  it("deduplicates ordinary terminal/manual completions by fallback fingerprint", () => {
    const coordinator = new CompletionSummaryCoordinator();
    const session = { id: "manual-terminal-session" };

    const first = coordinator.decide(session, {
      required: true,
      producer: "terminal",
      fallbackFingerprint: "completed\nwake summary",
    });
    coordinator.finish(first.key, true);

    const duplicate = coordinator.decide(session, {
      required: true,
      producer: "terminal",
      fallbackFingerprint: "completed\nwake summary",
    });
    const materiallyNew = coordinator.decide(session, {
      required: true,
      producer: "terminal",
      fallbackFingerprint: "completed\nnew wake summary",
    });

    assert.equal(first.allowed, true);
    assert.equal(duplicate.allowed, false);
    assert.equal(materiallyNew.allowed, true);
  });

  it("scopes explicit visible completion summaries by Telegram topic", () => {
    const coordinator = new CompletionSummaryCoordinator();
    const outcomeKey = "worktree-pr:opened:example/repo:#171:agent/example";
    const makeSession = (id: string, threadId: "13832" | "32947") => ({
      id,
      route: {
        provider: "telegram",
        target: "group-fixture",
        threadId,
      },
    });

    const openClawFirst = coordinator.decide(makeSession("openclaw-first", "13832"), {
      required: true,
      producer: "worktree-pr",
      outcomeKey,
    });
    coordinator.finish(openClawFirst.key, true);
    const openClawDuplicate = coordinator.decide(makeSession("openclaw-duplicate", "13832"), {
      required: true,
      producer: "worktree-pr",
      outcomeKey,
    });

    const tradingFirst = coordinator.decide(makeSession("trading-first", "32947"), {
      required: true,
      producer: "worktree-pr",
      outcomeKey,
    });
    coordinator.finish(tradingFirst.key, true);
    const tradingDuplicate = coordinator.decide(makeSession("trading-duplicate", "32947"), {
      required: true,
      producer: "worktree-pr",
      outcomeKey,
    });

    assert.equal(openClawFirst.allowed, true);
    assert.equal(openClawDuplicate.allowed, false);
    assert.equal(tradingFirst.allowed, true);
    assert.equal(tradingDuplicate.allowed, false);
  });

  it("skips later routed follow-ups after a prior human-visible PR summary in topic 13832", () => {
    const coordinator = new CompletionSummaryCoordinator();
    const session = {
      id: "pr-172-session",
      route: {
        provider: "telegram",
        target: "topic-fixture",
        threadId: "13832",
      },
    };
    const fact = {
      required: true,
      producer: "worktree-pr" as const,
      outcomeKey: "worktree-pr:updated:goldmar/openclaw-code-agent:#172:agent/centralize-completion-summary-owner:commit-fixture",
    };

    const foregroundClaim = coordinator.recordVisibleDelivery(session, fact);
    const routedFollowup = coordinator.decide(
      { ...session, id: "pr-172-routed-followup" },
      fact,
    );

    assert.equal(foregroundClaim.allowed, true);
    assert.equal(routedFollowup.allowed, false);
    assert.equal(routedFollowup.skipReason, PRIOR_VISIBLE_SUMMARY_SKIP_REASON);
  });

  it("normalizes opened, updated, and draft-opened PR outcomes to one follow-up identity", () => {
    const coordinator = new CompletionSummaryCoordinator();
    const session = {
      id: "pr-185-session",
      route: {
        provider: "telegram",
        target: "topic-fixture",
        threadId: "13832",
      },
    };

    const updated = coordinator.decide(session, {
      required: true,
      producer: "worktree-pr",
      outcomeKey: "worktree-pr:updated:goldmar/openclaw-code-agent:#185:agent/format-launch-notification-model-separator:d10aac0",
    });
    coordinator.finish(updated.key, true);

    const staleOpened = coordinator.decide(
      { ...session, id: "pr-185-stale-opened" },
      {
        required: true,
        producer: "worktree-pr",
        outcomeKey: "worktree-pr:opened:goldmar/openclaw-code-agent:#185:agent/format-launch-notification-model-separator:created",
      },
    );
    const staleDraftOpened = coordinator.decide(
      { ...session, id: "pr-185-stale-draft-opened" },
      {
        required: true,
        producer: "worktree-pr",
        outcomeKey: "worktree-pr:draft-opened:goldmar/openclaw-code-agent:#185:agent/format-launch-notification-model-separator:created",
      },
    );

    assert.equal(updated.allowed, true);
    assert.equal(staleOpened.allowed, false);
    assert.equal(staleDraftOpened.allowed, false);
  });

  it("keeps normalized PR follow-up identities independent by route", () => {
    const coordinator = new CompletionSummaryCoordinator();
    const first = coordinator.decide(
      {
        id: "pr-185-route-a",
        route: { provider: "telegram", target: "topic-fixture", threadId: "13832" },
      },
      {
        required: true,
        producer: "worktree-pr",
        outcomeKey: "worktree-pr:updated:goldmar/openclaw-code-agent:#185:agent/format-launch-notification-model-separator:d10aac0",
      },
    );
    coordinator.finish(first.key, true);

    const secondRoute = coordinator.decide(
      {
        id: "pr-185-route-b",
        route: { provider: "telegram", target: "topic-fixture", threadId: "32947" },
      },
      {
        required: true,
        producer: "worktree-pr",
        outcomeKey: "worktree-pr:opened:goldmar/openclaw-code-agent:#185:agent/format-launch-notification-model-separator:created",
      },
    );

    assert.equal(first.allowed, true);
    assert.equal(secondRoute.allowed, true);
  });

  it("does not derive PR identity from trailing digits when the PR identity field is missing", () => {
    const coordinator = new CompletionSummaryCoordinator();
    const session = {
      id: "malformed-pr-outcome",
      route: {
        provider: "telegram",
        target: "topic-fixture",
        threadId: "13832",
      },
    };

    const malformed = coordinator.decide(session, {
      required: true,
      producer: "worktree-pr",
      outcomeKey: "worktree-pr:updated:goldmar/openclaw-code-agent::agent/example:d10aac0",
    });
    coordinator.finish(malformed.key, true);
    const realPrZero = coordinator.decide(
      { ...session, id: "real-pr-zero" },
      {
        required: true,
        producer: "worktree-pr",
        outcomeKey: "worktree-pr:opened:goldmar/openclaw-code-agent:#0:agent/example:created",
      },
    );

    assert.equal(malformed.allowed, true);
    assert.equal(realPrZero.allowed, true);
  });

  it("skips a later terminal wake after a prior visible worktree merge summary", () => {
    const coordinator = new CompletionSummaryCoordinator();
    const session = {
      id: "include-harness-in-oca-notifications",
      harnessSessionId: "h-include-harness-in-oca-notifications",
      route: {
        provider: "telegram",
        target: "openclaw-topic-fixture",
        threadId: "13832",
      },
    };

    const visibleMergeSummary = coordinator.recordVisibleDelivery(session, {
      required: true,
      producer: "worktree",
      outcomeKey: "terminal:include-harness-in-oca-notifications",
    });
    const duplicateTerminalWake = coordinator.decide(
      { ...session, id: "include-harness-in-oca-notifications-retry" },
      {
        required: true,
        producer: "terminal",
        outcomeKey: "terminal:include-harness-in-oca-notifications-retry",
      },
    );

    assert.equal(visibleMergeSummary.allowed, true);
    assert.equal(duplicateTerminalWake.allowed, false);
    assert.equal(duplicateTerminalWake.skipReason, PRIOR_VISIBLE_SUMMARY_SKIP_REASON);
  });

  it("skips a later terminal wake after a prior visible PR-open summary", () => {
    const coordinator = new CompletionSummaryCoordinator();
    const session = {
      id: "fix-duplicate-completion-notifications",
      harnessSessionId: "h-fix-duplicate-completion-notifications",
      route: {
        provider: "telegram",
        target: "openclaw-topic-fixture",
        threadId: "13832",
      },
    };

    const visiblePrSummary = coordinator.recordVisibleDelivery(session, {
      required: true,
      producer: "worktree-pr",
      outcomeKey: "worktree-pr:opened:goldmar/openclaw-code-agent:#171:agent/fix-duplicate-completion-notifications:created",
    });
    const duplicateTerminalWake = coordinator.decide(
      { ...session, id: "fix-duplicate-completion-notifications-terminal-retry" },
      {
        required: true,
        producer: "terminal",
        outcomeKey: "terminal:fix-duplicate-completion-notifications-terminal-retry",
      },
    );

    assert.equal(visiblePrSummary.allowed, true);
    assert.equal(duplicateTerminalWake.allowed, false);
    assert.equal(duplicateTerminalWake.skipReason, PRIOR_VISIBLE_SUMMARY_SKIP_REASON);
  });

  it("lets a foreground goal summary supersede an in-flight goal wake claim", () => {
    const coordinator = new CompletionSummaryCoordinator();
    const session = {
      id: "trading-platform-review-session",
      goalTaskId: "goal-trading-platform-full-repo-review-20-iter",
      route: {
        provider: "telegram",
        target: "trading-topic-fixture",
        threadId: "32947",
      },
    };
    const fact = {
      required: true,
      producer: "goal" as const,
      outcomeKey: "goal:goal-trading-platform-full-repo-review-20-iter",
    };

    const goalWakeClaim = coordinator.decide(session, fact);
    const foregroundClaim = coordinator.recordVisibleDelivery(session, fact);
    coordinator.finish(goalWakeClaim.key, true);
    const laterGoalWake = coordinator.decide(
      { ...session, id: "trading-platform-later-goal-wake" },
      fact,
    );

    assert.equal(goalWakeClaim.allowed, true);
    assert.equal(foregroundClaim.allowed, true);
    assert.equal(laterGoalWake.allowed, false);
    assert.equal(laterGoalWake.skipReason, PRIOR_VISIBLE_SUMMARY_SKIP_REASON);
  });

  it("lets a same-route visible terminal summary suppress a later goal success wake without goalTaskId", () => {
    const coordinator = new CompletionSummaryCoordinator();
    const route = {
      provider: "telegram",
      target: "trading-topic-fixture",
      threadId: "review-topic-fixture",
    };
    const visibleSummarySession = {
      id: "trading-platform-full-repo-review-2-20-iter",
      name: "trading-platform-full-repo-review-2-20-iter",
      route,
    };
    const goalRoutingProxy = {
      id: "trading-platform-full-repo-review-2-20-iter",
      name: "trading-platform-full-repo-review-2-20-iter",
      route,
    };

    const visibleClaim = coordinator.recordVisibleDelivery(visibleSummarySession, {
      required: true,
      producer: "terminal",
      outcomeKey: "terminal:trading-platform-full-repo-review-2-20-iter",
    });
    const laterGoalWake = coordinator.decide(goalRoutingProxy, {
      required: true,
      producer: "goal",
      outcomeKey: "goal:goal-trading-platform-full-repo-review-2-20-iter",
    });

    assert.equal(visibleClaim.allowed, true);
    assert.equal(laterGoalWake.allowed, false);
    assert.equal(laterGoalWake.skipReason, PRIOR_VISIBLE_SUMMARY_SKIP_REASON);
  });

  it("keeps valid persisted records when raw input also contains invalid records", () => {
    const coordinator = new CompletionSummaryCoordinator({ maxCompletedKeys: 2 });
    const session = {
      id: "raw-persisted-record-session",
      route: {
        provider: "telegram",
        target: "openclaw-topic-fixture",
        threadId: "13832",
      },
    };
    const fact = {
      required: true,
      producer: "worktree-pr" as const,
      outcomeKey: "worktree-pr:updated:goldmar/openclaw-code-agent:#184:agent/fix-duplicate-oca-notification-logging:commit-fixture",
    };

    const visibleClaim = coordinator.recordVisibleDelivery(session, fact);
    assert.ok(visibleClaim.records?.length);

    const duplicate = new CompletionSummaryCoordinator({ maxCompletedKeys: 2 }).decide(
      { ...session, id: "raw-persisted-record-session-duplicate" },
      fact,
      [
        { key: "", recordedAt: new Date().toISOString() },
        { key: "invalid-date-key", recordedAt: "not-a-date" },
        visibleClaim.records[0],
      ],
    );

    assert.equal(duplicate.allowed, false);
    assert.equal(duplicate.skipReason, PRIOR_VISIBLE_SUMMARY_SKIP_REASON);
  });
});
