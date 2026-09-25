import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import {
  normalizeActionToken,
  normalizePersistedEntry,
  normalizeRepoPolicyRecord,
} from "../src/session-store-normalization";
import { propertyParams } from "./property-harness";

/**
 * Properties of persisted-row normalization (src/session-store-normalization.ts):
 * loading never throws on any row, and a normalized row is a fixed point, so
 * a load/save/load cycle never changes it. Rows are seeded from the 4.7.20
 * store fixture and mutated with missing fields, legacy values, and junk.
 */

type Row = Record<string, unknown>;
type Fixture = { sessions: Row[]; actionTokens: Row[]; repoPolicies: Row[] };

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/session-store-4.7.20.json"), "utf8"),
) as Fixture;

/** What a save writes and the next load reads. */
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const ENUM_VALUES: Record<string, readonly unknown[]> = {
  status: ["running", "completed", "failed", "killed", "starting", "paused"],
  lifecycle: ["starting", "active", "awaiting_plan_decision", "awaiting_user_input", "awaiting_worktree_decision", "suspended", "terminal", "legacy"],
  approvalState: ["not_required", "pending", "approved", "changes_requested", "rejected", "maybe"],
  worktreeState: ["none", "provisioned", "pending_decision", "merge_conflict_resolving", "merged", "released", "pr_open", "dismissed", "cleanup_failed", "gone"],
  worktreeDisposition: ["active", "pr-opened", "merged", "dismissed", "no-change-cleaned", "archived"],
  runtimeState: ["live", "stopped", "zombie"],
  deliveryState: ["idle", "notifying", "wake_pending", "failed"],
  approvalPromptTransport: ["none", "direct-message", "wake-only", "direct-telegram"],
  approvalPromptStatus: ["not_sent", "sending", "delivered", "fallback_delivered", "failed"],
  approvalExecutionState: ["awaiting_plan_output", "awaiting_approval", "approved_then_implemented", "not_plan_gated"],
  requestedPermissionMode: ["default", "plan", "bypassPermissions", "acceptEdits"],
  currentPermissionMode: ["default", "plan", "bypassPermissions", "acceptEdits"],
  planApprovalContext: ["plan-mode", "soft-plan"],
  harness: ["claude-code", "codex", "opencode"],
  killReason: ["user", "idle-timeout", "done", "crash"],
  worktreeStrategy: ["off", "ask", "delegate", "auto-merge", "auto-pr", "legacy"],
  reasoningEffort: ["low", "medium", "high", "xhigh", "turbo"],
};

const junkArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant(""),
  fc.constant("   "),
  fc.boolean(),
  fc.integer({ min: -5, max: 2_000_000_000_000 }),
  fc.double(),
  fc.string({ maxLength: 12 }),
  fc.constantFrom("2026-09-22T10:10:00.000Z", "not-a-date", "1790000000000"),
  fc.anything({ maxDepth: 2 }),
);

const routeArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.record({
    provider: fc.constantFrom("telegram", "Discord", "slack", "system", ""),
    accountId: fc.option(fc.constantFrom("default", "bot", ""), { nil: undefined }),
    target: fc.constantFrom("-1001234567890", "123456789", "channel:998877", "998877", "system", "C0ABC", ""),
    threadId: fc.option(fc.oneof(fc.constantFrom("77", "", "1700000000.1"), fc.integer({ min: 1, max: 99 })), { nil: undefined }),
    sessionKey: fc.option(fc.constantFrom(
      "agent:main:telegram:group:-1001234567890:topic:77",
      "agent:main:discord:channel:998877",
      "agent:main:discord:bot:direct:998877",
      "agent:main:slack:channel:c0abc:thread:1700000000.1",
      "agent:main:main",
      "",
    ), { nil: undefined }),
  }, { requiredKeys: [] }),
  junkArb,
);

const backendRefArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.record({
    kind: fc.constantFrom("claude-code", "codex-app-server", "opencode-server", "codex-native"),
    conversationId: fc.constantFrom("conv-1", "", "0b7c1c1e"),
    runId: fc.option(fc.string({ maxLength: 6 }), { nil: undefined }),
    worktreePath: fc.option(fc.constantFrom("/srv/wt/a", "/srv/wt/b"), { nil: undefined }),
    worktreeId: fc.option(fc.constantFrom("wt-1"), { nil: undefined }),
  }, { requiredKeys: [] }),
  junkArb,
);

const worktreeLifecycleArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.record({
    state: fc.constantFrom("provisioned", "pending_decision", "merged", "dismissed", "no_change", "pr_open", "bogus"),
    updatedAt: fc.constantFrom("2026-09-22T10:10:00.000Z", ""),
    resolvedAt: fc.option(fc.constantFrom("2026-09-22T10:11:00.000Z"), { nil: undefined }),
    resolutionSource: fc.option(fc.constantFrom("agent_merge", "dismiss", "manual"), { nil: undefined }),
    notes: fc.option(fc.array(fc.oneof(fc.string({ maxLength: 5 }), fc.integer())), { nil: undefined }),
  }, { requiredKeys: [] }),
  junkArb,
);

function valueArbFor(key: string): fc.Arbitrary<unknown> {
  const enumValues = ENUM_VALUES[key];
  const specific = key === "route" ? routeArb
    : key === "backendRef" ? backendRefArb
      : key === "worktreeLifecycle" ? worktreeLifecycleArb
        : enumValues ? fc.constantFrom(...enumValues)
          : undefined;
  return specific ? fc.oneof({ weight: 3, arbitrary: specific }, { weight: 1, arbitrary: junkArb }) : junkArb;
}

const MUTABLE_KEYS = [
  ...new Set([
    ...fixture.sessions.flatMap((session) => Object.keys(session)),
    ...Object.keys(ENUM_VALUES),
    "worktreeLifecycle",
    "runtimeRecovery",
    "completionWakeSummaryRequired",
    "completionWakeSkippedAt",
    "completionSummaryDedupe",
    "pendingWorktreeDecisionSince",
    "worktreeMerged",
  ]),
];

/** A fixture row with some fields removed and some replaced. */
const rowArb: fc.Arbitrary<Row> = fc.tuple(
  fc.constantFrom(...fixture.sessions),
  fc.subarray(MUTABLE_KEYS, { maxLength: 6 }),
  fc.subarray(MUTABLE_KEYS, { maxLength: 8 }).chain((keys) => fc.tuple(...keys.map((key) => valueArbFor(key).map((value) => [key, value] as const)))),
).map(([base, removed, replaced]) => {
  const row: Row = structuredClone(base);
  for (const key of removed) delete row[key];
  for (const [key, value] of replaced) row[key] = value;
  return row;
});

describe("normalizePersistedEntry (properties)", () => {
  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.oneof(fc.anything({ maxDepth: 3 }), rowArb), (input) => {
        normalizePersistedEntry(input);
      }),
      propertyParams(300),
    );
  });

  it("is idempotent across a save and reload", () => {
    fc.assert(
      fc.property(rowArb, (row) => {
        const first = normalizePersistedEntry(row);
        if (!first) return;
        const saved = roundTrip(first);
        const second = normalizePersistedEntry(saved);
        assert.ok(second, "a normalized row still loads");
        assert.deepEqual(roundTrip(second), saved);
      }),
      propertyParams(400),
    );
  });

  it("recovers a row persisted as running as a resumable suspended session", () => {
    fc.assert(
      fc.property(rowArb, (row) => {
        const entry = normalizePersistedEntry({ ...row, status: "running" });
        if (!entry) return;
        assert.equal(entry.status, "killed");
        assert.equal(entry.lifecycle, "suspended");
        assert.equal(entry.runtimeState, "stopped");
        assert.equal(entry.resumable, true);
        assert.equal(entry.runtimeRecovery?.reason, "persisted-running-without-runtime");
      }),
      propertyParams(100),
    );
  });
});

describe("action token and repo policy normalization (properties)", () => {
  it("never throws and is idempotent", () => {
    const tokenArb = fc.tuple(
      fc.constantFrom(...fixture.actionTokens),
      fc.dictionary(
        fc.constantFrom("id", "sessionId", "kind", "createdAt", "expiresAt", "consumedAt", "route", "launchAllowedTools", "launchRewindTurns", "planDecisionVersion", "optionIndex"),
        fc.oneof(junkArb, routeArb, fc.constantFrom("worktree-merge", "plan-approve", "question-answer"), fc.array(fc.oneof(fc.string({ maxLength: 4 }), fc.integer()))),
        { maxKeys: 4 },
      ),
    ).map(([base, overrides]) => ({ ...base, ...overrides }));
    const policyArb = fc.tuple(
      fc.constantFrom(...fixture.repoPolicies),
      fc.dictionary(fc.constantFrom("key", "policy", "repoRoot", "provider", "createdAt", "updatedAt", "source"), junkArb, { maxKeys: 3 }),
    ).map(([base, overrides]) => ({ ...base, ...overrides }));

    fc.assert(
      fc.property(fc.oneof(tokenArb, fc.anything({ maxDepth: 2 })), policyArb, (token, policy) => {
        const normalizedToken = normalizeActionToken(token);
        if (normalizedToken) {
          const saved = roundTrip(normalizedToken);
          assert.deepEqual(roundTrip(normalizeActionToken(saved)), saved);
        }
        const normalizedPolicy = normalizeRepoPolicyRecord(policy);
        if (normalizedPolicy) {
          const saved = roundTrip(normalizedPolicy);
          assert.deepEqual(roundTrip(normalizeRepoPolicyRecord(saved)), saved);
        }
      }),
      propertyParams(300),
    );
  });
});

describe("store normalization regressions", () => {
  it("loads a legacy row whose timestamps are outside the Date range", () => {
    const legacy = structuredClone(fixture.sessions.find((session) => session.worktreeDisposition === "dismissed"));
    assert.ok(legacy, "the fixture has a dismissed legacy row");
    delete legacy.worktreeLifecycle;
    delete legacy.worktreeDismissedAt;
    legacy.completedAt = 8.64e15 + 1;
    legacy.createdAt = Number.MAX_VALUE;
    const entry = normalizePersistedEntry(legacy);
    assert.ok(entry, "the row still loads");
    assert.equal(entry.worktreeLifecycle?.state, "dismissed");
    assert.ok(Number.isFinite(Date.parse(entry.worktreeLifecycle?.updatedAt ?? "")), "a valid lifecycle timestamp is used instead");
  });
});
