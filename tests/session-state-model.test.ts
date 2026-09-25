import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  applySessionControlPatch,
  reduceSessionControlState,
  SESSION_STATUS_TRANSITIONS,
  type SessionControlEvent,
  type SessionControlPatch,
  type SessionControlState,
} from "../src/session-state";
import type {
  PermissionMode,
  SessionApprovalState,
  SessionDeliveryState,
  SessionLifecycle,
  SessionStatus,
  SessionWorktreeState,
} from "../src/types";
import { propertyParams } from "./property-harness";

/**
 * Model-based tests for the session control reducer (src/session-state.ts).
 *
 * Commands dispatch reducer events and control patches the way their callers
 * do: `Session.transition` only takes transitions listed in
 * SESSION_STATUS_TRANSITIONS, `Session.sendMessage` starts turns only while
 * running, harness events (plan/input requests, mode changes) only arrive
 * while the backend is live, and a plan decision acts only on the actionable
 * version its button carries (see `validatePlanDecisionToken` in
 * src/callback-handler.ts and `buildPlanDecisionClosedPatch` in
 * src/actions/respond.ts). After every step the reducer state is checked
 * against the invariants below.
 */

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "plan", "bypassPermissions"];
const STATUSES: readonly SessionStatus[] = ["starting", "running", "completed", "failed", "killed"];
const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set(["completed", "failed", "killed"]);
const WORKTREE_STATES: readonly SessionWorktreeState[] = [
  "none",
  "provisioned",
  "pending_decision",
  "merge_conflict_resolving",
  "merge_in_progress",
  "pr_in_progress",
  "merged",
  "released",
  "pr_open",
  "dismissed",
  "cleanup_failed",
];
const RESOLVED_WORKTREE_STATES: ReadonlySet<SessionWorktreeState> = new Set([
  "merged",
  "released",
  "pr_open",
  "dismissed",
  "cleanup_failed",
]);
const DELIVERY_STATES: readonly SessionDeliveryState[] = ["idle", "notifying", "wake_pending", "failed"];
const PLAN_WAITING_LIFECYCLES: ReadonlySet<SessionLifecycle> = new Set(["awaiting_plan_decision"]);

function initialState(permissionMode: PermissionMode): SessionControlState {
  // Session's constructor: requested = current = the launch permission mode.
  return {
    status: "starting",
    lifecycle: "starting",
    approvalState: "not_required",
    approvalExecutionState: permissionMode === "plan" ? "awaiting_plan_output" : "not_plan_gated",
    worktreeState: "none",
    runtimeState: "live",
    deliveryState: "idle",
    requestedPermissionMode: permissionMode,
    currentPermissionMode: permissionMode,
    pendingPlanApproval: false,
    planApprovalContext: undefined,
    planDecisionVersion: 0,
    actionablePlanDecisionVersion: undefined,
    canonicalPlanPromptVersion: undefined,
    approvalPromptRequiredVersion: undefined,
    approvalPromptVersion: undefined,
    approvalPromptStatus: "not_sent",
    approvalPromptTransport: "none",
    approvalPromptMessageKind: "none",
    approvalPromptLastAttemptAt: undefined,
    approvalPromptDeliveredAt: undefined,
    approvalPromptFailedAt: undefined,
    planModeApproved: false,
  };
}

type Model = {
  /** Mirror of the reducer state, so command guards can read it. */
  state: SessionControlState;
  /** Plan versions a user rejected or sent back for changes. */
  closedVersions: Set<number>;
  /** Plan versions that were approved. */
  approvedVersions: Set<number>;
  /** Every actionable version seen so far, in order. */
  actionableHistory: number[];
  rejected: boolean;
};

type Real = { state: SessionControlState };

const isLive = (state: SessionControlState): boolean => state.status === "starting" || state.status === "running";

/** Invariants that hold after every step. */
function assertInvariants(before: SessionControlState, after: SessionControlState, model: Model, step: string): void {
  const where = `after ${step}`;

  // Terminal statuses absorb: nothing leaves them, and a terminal session is stopped.
  if (TERMINAL_STATUSES.has(before.status)) {
    assert.equal(after.status, before.status, `terminal status changed ${where}`);
  }
  if (TERMINAL_STATUSES.has(after.status)) {
    assert.equal(after.runtimeState, "stopped", `terminal session is live ${where}`);
    assert.ok(
      !["starting", "active"].includes(after.lifecycle),
      `terminal session lifecycle is ${after.lifecycle} ${where}`,
    );
  }

  // Plan versions only increase, by at most one per step.
  assert.ok(after.planDecisionVersion >= before.planDecisionVersion, `plan version decreased ${where}`);
  assert.ok(after.planDecisionVersion <= before.planDecisionVersion + 1, `plan version skipped ${where}`);

  // An actionable version is the current version of a pending plan.
  if (after.actionablePlanDecisionVersion !== undefined) {
    assert.equal(after.pendingPlanApproval, true, `actionable version without a pending plan ${where}`);
    assert.equal(after.approvalState, "pending", `actionable version while ${after.approvalState} ${where}`);
    assert.equal(after.actionablePlanDecisionVersion, after.planDecisionVersion, `stale actionable version ${where}`);
    assert.ok(!model.closedVersions.has(after.actionablePlanDecisionVersion), `a closed plan version became actionable again ${where}`);
    assert.ok(!model.approvedVersions.has(after.actionablePlanDecisionVersion), `an approved plan version became actionable again ${where}`);
  }
  if (after.pendingPlanApproval) {
    assert.ok(
      after.approvalState === "pending" || after.approvalState === "changes_requested",
      `pending plan with approvalState ${after.approvalState} ${where}`,
    );
  }

  // Approval is durable, and a rejected plan never becomes approved.
  if (before.planModeApproved) assert.equal(after.planModeApproved, true, `plan approval was lost ${where}`);
  if (after.planModeApproved) assert.equal(model.rejected, false, `a rejected session was approved ${where}`);
  for (const version of model.approvedVersions) {
    assert.ok(!model.closedVersions.has(version), `plan v${version} was both closed and approved`);
  }

  // approvalExecutionState is a function of the other fields.
  const execution = after.approvalExecutionState;
  if (after.requestedPermissionMode !== "plan") {
    assert.equal(execution, "not_plan_gated", where);
  } else if (after.pendingPlanApproval) {
    assert.equal(execution, "awaiting_approval", where);
  } else if (after.planModeApproved) {
    if (after.status === "running") assert.equal(execution, "approved_then_implemented", where);
    else if (after.status === "starting") assert.equal(execution, "awaiting_plan_output", where);
    else assert.ok(execution === "approved_then_implemented" || execution === "awaiting_plan_output", where);
  } else if (after.currentPermissionMode !== "plan") {
    assert.equal(execution, "implemented_without_required_approval", where);
  } else {
    assert.equal(execution, "awaiting_plan_output", where);
  }
}

class Step implements fc.Command<Model, Real> {
  constructor(
    readonly label: string,
    private readonly guard: (state: SessionControlState, model: Model) => boolean,
    private readonly apply: (state: SessionControlState, model: Model) => SessionControlState,
    private readonly verify?: Verify,
  ) {}

  check(model: Readonly<Model>): boolean {
    return this.guard(model.state, model as Model);
  }

  run(model: Model, real: Real): void {
    const before = real.state;
    const after = this.apply(before, model);
    real.state = after;
    model.state = after;
    this.verify?.(before, after, model);
    if (after.actionablePlanDecisionVersion !== undefined) model.actionableHistory.push(after.actionablePlanDecisionVersion);
    assertInvariants(before, after, model, this.label);
  }

  toString(): string {
    return this.label;
  }
}

type Verify = (before: SessionControlState, after: SessionControlState, model: Model) => void;

const event = (label: string, guard: (state: SessionControlState) => boolean, ev: SessionControlEvent, verify?: Verify) =>
  new Step(label, (state) => guard(state), (state) => reduceSessionControlState(state, ev), verify);

const commandArbs: fc.Arbitrary<fc.Command<Model, Real>>[] = [
  fc.constantFrom(...STATUSES).map((status) => event(
    `transition(${status})`,
    (state) => SESSION_STATUS_TRANSITIONS[state.status].includes(status),
    { type: "status.transition", status },
    (_before, after) => {
      assert.equal(after.status, status);
      if (TERMINAL_STATUSES.has(status)) assert.equal(after.runtimeState, "stopped");
      else assert.equal(after.runtimeState, "live");
    },
  )),
  fc.constantFrom(...PERMISSION_MODES).map((mode) => event(
    `modeChanged(${mode})`,
    isLive,
    { type: "permission.mode_changed", currentPermissionMode: mode },
    (_before, after) => assert.equal(after.currentPermissionMode, mode),
  )),
  fc.constant(event("turnStarted", (state) => state.status === "running", { type: "turn.started" }, (_before, after) => {
    assert.equal(after.lifecycle, "active");
    assert.equal(after.runtimeState, "live");
  })),
  fc.constant(event("inputRequested", isLive, { type: "input.requested" }, (before, after) => {
    assert.equal(after.lifecycle, before.pendingPlanApproval ? "awaiting_plan_decision" : "awaiting_user_input");
  })),
  fc.constant(event("planRequested", isLive, { type: "plan.requested", context: "plan-mode" }, (before, after) => {
    if (before.planModeApproved) {
      assert.deepEqual(after, before, "a plan request after approval is ignored");
      return;
    }
    assert.equal(after.pendingPlanApproval, true);
    assert.equal(after.approvalState, "pending");
    assert.ok(PLAN_WAITING_LIFECYCLES.has(after.lifecycle));
    assert.equal(after.actionablePlanDecisionVersion, after.planDecisionVersion);
    assert.ok(after.planDecisionVersion > 0, "a plan request has a positive version");
  })),
  fc.constant(event("planCleared", isLive, { type: "plan.cleared" }, (_before, after) => {
    assert.equal(after.pendingPlanApproval, false);
    assert.equal(after.actionablePlanDecisionVersion, undefined);
  })),
  // A button or approve=true acts only on the actionable version it carries.
  fc.nat({ max: 6 }).map((version) => new Step(
    `approve(v${version})`,
    (state) => state.pendingPlanApproval
      && state.approvalState === "pending"
      && state.actionablePlanDecisionVersion === version,
    (state, model) => {
      model.approvedVersions.add(version);
      return reduceSessionControlState(state, { type: "plan.approved" });
    },
    (_before, after) => {
      assert.equal(after.planModeApproved, true);
      assert.equal(after.approvalState, "approved");
      assert.equal(after.pendingPlanApproval, false);
      assert.equal(after.actionablePlanDecisionVersion, undefined);
    },
  )),
  // Session.sendMessage sends revision feedback for an unapproved pending plan.
  fc.constant(new Step(
    "reviseByMessage",
    (state) => state.status === "running"
      && state.pendingPlanApproval
      && state.approvalState !== "changes_requested"
      && !state.planModeApproved,
    (state, model) => {
      model.closedVersions.add(state.planDecisionVersion);
      return reduceSessionControlState(state, { type: "plan.changes_requested" });
    },
    (before, after) => {
      assert.equal(after.approvalState, "changes_requested");
      assert.equal(after.planDecisionVersion, before.planDecisionVersion + 1);
    },
  )),
  // Revise/Reject buttons close the actionable version with a control patch.
  fc.tuple(fc.constantFrom<"changes_requested" | "rejected">("changes_requested", "rejected"), fc.nat({ max: 6 })).map(([decision, version]) => new Step(
    `${decision === "rejected" ? "reject" : "revise"}Button(v${version})`,
    (state) => state.pendingPlanApproval
      && state.approvalState === "pending"
      && state.actionablePlanDecisionVersion === version,
    (state, model) => {
      model.closedVersions.add(version);
      const closed = applySessionControlPatch(state, closedPlanPatch(state, decision));
      if (decision !== "rejected") return closed;
      model.rejected = true;
      // rejectPlanDecision then kills the live session.
      return SESSION_STATUS_TRANSITIONS[closed.status].includes("killed")
        ? reduceSessionControlState(closed, { type: "status.transition", status: "killed" })
        : closed;
    },
    (_before, after) => {
      assert.equal(after.approvalState, decision);
      assert.equal(after.pendingPlanApproval, false);
      // A pending worktree decision keeps the session waiting on it.
      const worktreeLifecycle = after.worktreeState === "pending_decision"
        ? "awaiting_worktree_decision"
        : (RESOLVED_WORKTREE_STATES.has(after.worktreeState) ? "terminal" : undefined);
      if (decision === "rejected") {
        assert.ok(after.lifecycle === "terminal" || after.lifecycle === worktreeLifecycle, after.lifecycle);
        assert.equal(after.runtimeState, "stopped");
      } else {
        assert.equal(after.lifecycle, worktreeLifecycle ?? "awaiting_user_input");
      }
    },
  )),
  fc.boolean().map((suspended) => event(
    `terminalEntered(${suspended ? "suspended" : "done"})`,
    () => true,
    { type: "terminal.entered", suspended },
    (_before, after) => {
      assert.equal(after.lifecycle, suspended ? "suspended" : "terminal");
      assert.equal(after.runtimeState, "stopped");
    },
  )),
  fc.constant(event("worktreeDecisionRequested", (state) => state.worktreeState !== "none", { type: "worktree.decision_requested" }, (_before, after) => {
    assert.equal(after.worktreeState, "pending_decision");
    assert.equal(after.lifecycle, "awaiting_worktree_decision");
  })),
  fc.constantFrom(...WORKTREE_STATES.filter((state) => state !== "none")).map((worktreeState) => event(
    `worktreeState(${worktreeState})`,
    (state) => state.worktreeState !== "none",
    { type: "worktree.state_set", worktreeState },
    (before, after) => {
      assert.equal(after.worktreeState, worktreeState);
      if (worktreeState === "pending_decision") assert.equal(after.lifecycle, "awaiting_worktree_decision");
      else if (RESOLVED_WORKTREE_STATES.has(worktreeState)) assert.equal(after.lifecycle, "terminal");
      else assert.equal(after.lifecycle, before.lifecycle);
    },
  )),
  fc.constantFrom(...DELIVERY_STATES).map((deliveryState) => event(
    `delivery(${deliveryState})`,
    () => true,
    { type: "delivery.state_set", deliveryState },
    (before, after) => {
      assert.equal(after.deliveryState, deliveryState);
      assert.deepEqual({ ...after, deliveryState: before.deliveryState }, before, "delivery changes only deliveryState");
    },
  )),
];

/** The patch `rejectPlanDecision` / `requestPlanDecisionChanges` apply (src/actions/respond.ts). */
function closedPlanPatch(state: SessionControlState, decision: "changes_requested" | "rejected"): SessionControlPatch {
  return {
    approvalState: decision,
    lifecycle: decision === "rejected" ? "terminal" : "awaiting_user_input",
    pendingPlanApproval: false,
    planApprovalContext: undefined,
    planDecisionVersion: state.planDecisionVersion + 1,
    actionablePlanDecisionVersion: undefined,
    canonicalPlanPromptVersion: undefined,
    approvalPromptRequiredVersion: undefined,
    approvalPromptVersion: undefined,
    approvalPromptStatus: "not_sent",
    approvalPromptTransport: "none",
    approvalPromptMessageKind: "none",
    approvalPromptLastAttemptAt: undefined,
    approvalPromptDeliveredAt: undefined,
    approvalPromptFailedAt: undefined,
    ...(decision === "rejected" ? { runtimeState: "stopped" as const } : {}),
  };
}

/** Worktree events are the only ones that change worktreeState (after initialize). */
function assertWorktreeOnlyChangedByWorktreeEvents(label: string, before: SessionControlState, after: SessionControlState): void {
  if (label.startsWith("worktree")) return;
  assert.equal(after.worktreeState, before.worktreeState, `${label} changed the worktree state`);
}

describe("session control reducer (model-based)", () => {
  it("keeps its invariants over random event sequences", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PERMISSION_MODES),
        fc.boolean(),
        fc.commands(commandArbs, { maxCommands: 40 }),
        (permissionMode, hasWorktree, commands) => {
          const model: Model = { state: initialState(permissionMode), closedVersions: new Set(), approvedVersions: new Set(), actionableHistory: [], rejected: false };
          const start = initialState(permissionMode);
          const initialized = reduceSessionControlState(start, { type: "initialize", hasWorktree });
          assert.equal(initialized.worktreeState, hasWorktree ? "provisioned" : "none");
          assert.equal(initialized.lifecycle, "starting");
          model.state = initialized;
          const real: Real = { state: initialized };
          fc.modelRun(() => ({ model, real }), [...commands].map((command) => wrapWorktreeCheck(command)));
          // Actionable versions never go backwards.
          for (let index = 1; index < model.actionableHistory.length; index += 1) {
            assert.ok(model.actionableHistory[index] >= model.actionableHistory[index - 1], "actionable plan version went backwards");
          }
        },
      ),
      propertyParams(300),
    );
  });

  it("re-initializing never downgrades a worktree", () => {
    fc.assert(
      fc.property(fc.constantFrom(...WORKTREE_STATES), fc.boolean(), fc.constantFrom(...STATUSES), (worktreeState, hasWorktree, status) => {
        const state = { ...initialState("default"), status, worktreeState };
        const next = reduceSessionControlState(state, { type: "initialize", hasWorktree });
        const expected = hasWorktree && worktreeState === "none" ? "provisioned" : worktreeState;
        assert.equal(next.worktreeState, expected);
        if (status !== "starting") {
          assert.equal(next.lifecycle, state.lifecycle);
          assert.equal(next.runtimeState, state.runtimeState);
        }
      }),
      propertyParams(100),
    );
  });
});

function wrapWorktreeCheck(command: fc.Command<Model, Real>): fc.Command<Model, Real> {
  return {
    check: (model) => command.check(model),
    run: (model, real) => {
      const before = real.state;
      command.run(model, real);
      assertWorktreeOnlyChangedByWorktreeEvents(command.toString(), before, real.state);
    },
    toString: () => command.toString(),
  };
}

// -- control patches ---------------------------------------------------------

const approvalStates: readonly SessionApprovalState[] = ["not_required", "pending", "approved", "changes_requested", "rejected"];
const lifecycles: readonly SessionLifecycle[] = [
  "starting",
  "active",
  "awaiting_plan_decision",
  "awaiting_user_input",
  "awaiting_worktree_decision",
  "suspended",
  "terminal",
];

const stateArb: fc.Arbitrary<SessionControlState> = fc.record({
  status: fc.constantFrom(...STATUSES),
  lifecycle: fc.constantFrom(...lifecycles),
  approvalState: fc.constantFrom(...approvalStates),
  worktreeState: fc.constantFrom(...WORKTREE_STATES),
  requestedPermissionMode: fc.constantFrom(...PERMISSION_MODES),
  currentPermissionMode: fc.constantFrom(...PERMISSION_MODES),
  pendingPlanApproval: fc.boolean(),
  planDecisionVersion: fc.nat({ max: 5 }),
  planModeApproved: fc.boolean(),
}).map((fields) => ({ ...initialState(fields.requestedPermissionMode), ...fields }));

const patchArb: fc.Arbitrary<SessionControlPatch> = fc.record({
  lifecycle: fc.constantFrom(...lifecycles),
  approvalState: fc.constantFrom(...approvalStates),
  worktreeState: fc.constantFrom(...WORKTREE_STATES),
  currentPermissionMode: fc.constantFrom(...PERMISSION_MODES),
  pendingPlanApproval: fc.boolean(),
  planDecisionVersion: fc.nat({ max: 5 }),
  actionablePlanDecisionVersion: fc.option(fc.nat({ max: 5 }), { nil: undefined }),
  planModeApproved: fc.boolean(),
  pendingWorktreeDecisionSince: fc.constant("2026-09-25T00:00:00.000Z"),
}, { requiredKeys: [] });

describe("applySessionControlPatch (properties)", () => {
  it("normalizes plan and worktree fields and is idempotent", () => {
    fc.assert(
      fc.property(stateArb, patchArb, (state, patch) => {
        const next = applySessionControlPatch(state, patch);
        assert.deepEqual(applySessionControlPatch(next, patch), next, "applying a patch twice changes the state");

        if (next.pendingPlanApproval) {
          assert.equal(next.approvalState, "pending");
          assert.notEqual(next.actionablePlanDecisionVersion, undefined);
        }
        if (patch.approvalState === "changes_requested" && patch.pendingPlanApproval === undefined) {
          assert.equal(next.pendingPlanApproval, false, "changes requested without an explicit pending flag closes the plan");
        }
        if (next.worktreeState === "pending_decision" || patch.pendingWorktreeDecisionSince !== undefined) {
          assert.equal(next.worktreeState, "pending_decision");
          assert.equal(next.lifecycle, "awaiting_worktree_decision");
        } else if (RESOLVED_WORKTREE_STATES.has(next.worktreeState)) {
          assert.equal(next.lifecycle, "terminal");
        } else if (next.pendingPlanApproval) {
          assert.equal(next.lifecycle, "awaiting_plan_decision");
        } else if (next.approvalState === "changes_requested") {
          assert.equal(next.lifecycle, "awaiting_user_input");
        }
        // Fields the patch leaves out are kept (other than the derived ones).
        if (!Object.hasOwn(patch, "planDecisionVersion")) assert.equal(next.planDecisionVersion, state.planDecisionVersion);
        if (!Object.hasOwn(patch, "planModeApproved")) assert.equal(next.planModeApproved, state.planModeApproved);
        if (!Object.hasOwn(patch, "currentPermissionMode")) assert.equal(next.currentPermissionMode, state.currentPermissionMode);
        assert.equal(next.status, state.status, "a control patch never changes the status");
      }),
      propertyParams(300),
    );
  });
});
