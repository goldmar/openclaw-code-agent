import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setPluginConfig } from "../src/config";
import { executeRespond } from "../src/actions/respond";
import { BACKEND_NAMES, waitUntil, type BackendName, type PlanDecisionOutcome } from "./harness-backends";
import {
  buttonNamed,
  clickButton,
  startInteractionFixture,
  type FixtureOptions,
  type InteractionFixture,
} from "./user-interaction-fixture";

let fixture: InteractionFixture | undefined;

afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
  setPluginConfig({});
});

const PLAN_V1 = "1. Add the migration\n2. Update the model\n3. Add tests";
const PLAN_V2 = "1. Add the migration behind a feature flag\n2. Update the model\n3. Add tests";
const APPROVED_PREFIX = "[SYSTEM: The user has approved your plan.";
const REVISION_PREFIX = "[SYSTEM: The user wants changes to your plan.";

type PlanRound = { decision: Promise<PlanDecisionOutcome> | undefined; turnsBefore: number; version: number };

async function start(name: BackendName, options: FixtureOptions = {}): Promise<InteractionFixture> {
  return await startInteractionFixture(name, { permissionMode: "plan", planApproval: "ask", ...options });
}

/** Submit a plan and wait until the session awaits a decision on it. */
async function proposePlan(markdown = PLAN_V1): Promise<PlanRound> {
  const f = fixture!;
  const decision = f.backend.proposePlan(markdown);
  await waitUntil(() => f.session.pendingPlanApproval === true, "pending plan approval");
  return {
    decision,
    turnsBefore: f.backend.turns.length,
    version: f.session.actionablePlanDecisionVersion ?? f.session.planDecisionVersion,
  };
}

async function planButtons(after = 0) {
  const f = fixture!;
  await waitUntil(
    () => f.notifications.slice(after).some((entry) => entry.request.label === "plan-approval" && f.buttons("plan-approval").length > 0),
    "plan approval buttons",
  );
  return f.buttons("plan-approval");
}

/** The backend received the approval and now implements outside plan mode. */
async function expectImplementationStarted(round: PlanRound): Promise<void> {
  const f = fixture!;
  if (f.backend.name === "claude-code") {
    // Claude: the held ExitPlanMode request is allowed and switches the session mode.
    assert.deepEqual(await round.decision, { kind: "approve", permissionMode: "bypassPermissions" });
    return;
  }
  await waitUntil(() => f.backend.turns.length > round.turnsBefore, "implementation turn");
  const turn = f.backend.turns.at(-1)!;
  assert.equal(turn.planMode, false, "the implementation turn leaves plan mode");
  if (f.backend.nativePlanDecisions) {
    // OpenCode: the switch from the plan agent to the build agent carries the approval.
    assert.doesNotMatch(turn.text, /\[SYSTEM:/);
  } else {
    // Codex: the plan collaboration mode ends and the approval travels as a prompt.
    assert.ok(turn.text.startsWith(APPROVED_PREFIX), turn.text);
  }
}

/** The backend received revision feedback and keeps planning. */
async function expectRevisionRequested(round: PlanRound, feedback: string): Promise<void> {
  const f = fixture!;
  if (f.backend.name === "claude-code") {
    const decision = await round.decision;
    assert.equal(decision?.kind, "revise");
    assert.match(decision?.kind === "revise" ? decision.feedback : "", new RegExp(feedback));
    return;
  }
  await waitUntil(() => f.backend.turns.length > round.turnsBefore, "revision turn");
  const turn = f.backend.turns.at(-1)!;
  assert.equal(turn.planMode, true, "revision stays in plan mode");
  assert.match(turn.text, new RegExp(feedback));
  if (f.backend.nativePlanDecisions) assert.doesNotMatch(turn.text, /\[SYSTEM:/);
  else assert.ok(turn.text.startsWith(REVISION_PREFIX), turn.text);
}

/** The backend was never asked to implement. */
async function expectStopped(round: PlanRound): Promise<void> {
  const f = fixture!;
  await waitUntil(() => f.session.status === "killed", "session stopped");
  if (f.backend.name === "claude-code") {
    assert.equal((await round.decision)?.kind, "cancelled");
  }
  assert.equal(f.backend.turns.length, round.turnsBefore, "no implementation turn");
}

async function nextPlanRound(markdown: string): Promise<PlanRound> {
  const f = fixture!;
  if (f.backend.name !== "claude-code") await f.backend.waitForTurns(f.backend.turns.length);
  return await proposePlan(markdown);
}

for (const name of BACKEND_NAMES) {
  describe(`${name}: plan approval`, () => {
    it("asks the user with Approve / Revise / Reject buttons and approves the current plan version", async () => {
      fixture = await start(name);
      if (name !== "claude-code") assert.equal(fixture.backend.turns[0]?.planMode, true, "planning runs read-only");
      const round = await proposePlan();
      const prompt = fixture.lastNotification("plan-approval")!;
      assert.equal(prompt.request.notifyUser, "always");
      const buttons = await planButtons();
      assert.deepEqual(buttons.map((button) => button.label), ["Approve", "Revise", "Reject"]);

      await clickButton(buttonNamed(buttons, "Approve"));
      await expectImplementationStarted(round);
      assert.equal(fixture.session.approvalState, "approved");
      assert.equal(fixture.session.pendingPlanApproval, false);

      const again = await clickButton(buttonNamed(buttons, "Approve"));
      assert.match(again.replies.join("\n"), /already approved|stale|no longer awaiting approval/);
      if (name === "claude-code") await fixture.backend.endTurn("Implemented.");
    });

    it("approves from a Discord button", async () => {
      fixture = await start(name);
      const round = await proposePlan();
      await clickButton(buttonNamed(await planButtons(), "Approve"), "discord");
      await expectImplementationStarted(round);
    });

    it("revises: feedback reaches the agent, the old version's buttons go stale, and the new version is approved", async () => {
      fixture = await start(name);
      const v1 = await proposePlan();
      const v1Buttons = await planButtons();
      const revise = await clickButton(buttonNamed(v1Buttons, "Revise"));
      assert.match(revise.replies.join("\n"), /Reply with the changes you want/);
      assert.equal(fixture.session.approvalState, "changes_requested");

      const feedback = "Put the migration behind a feature flag";
      const sent = await executeRespond(fixture.sm, { session: fixture.session.id, message: feedback, userInitiated: true });
      assert.equal(sent.isError, undefined, sent.text);
      await expectRevisionRequested(v1, feedback);

      const staleBeforeV2 = await clickButton(buttonNamed(v1Buttons, "Approve"));
      assert.match(staleBeforeV2.replies.join("\n"), /stale|no longer|expired/);

      const before = fixture.notifications.length;
      const v2 = await nextPlanRound(PLAN_V2);
      assert.ok(v2.version > v1.version, `plan version advances (v${v1.version} -> v${v2.version})`);
      const v2Buttons = await planButtons(before);
      assert.notDeepEqual(v2Buttons.map((button) => button.callbackData), v1Buttons.map((button) => button.callbackData));

      const staleV1 = await clickButton(buttonNamed(v1Buttons, "Approve"));
      assert.match(staleV1.replies.join("\n"), /stale|no longer|expired/, "approving v1 after v2 exists fails as stale");
      assert.equal(fixture.session.pendingPlanApproval, true, "the stale click leaves v2 pending");

      await clickButton(buttonNamed(v2Buttons, "Approve"));
      await expectImplementationStarted(v2);
    });

    it("rejects from a button and stops the session", async () => {
      fixture = await start(name);
      const round = await proposePlan();
      const reject = await clickButton(buttonNamed(await planButtons(), "Reject"));
      assert.match(reject.replies.join("\n"), /Plan rejected for \[.+\]\. Session stopped\./);
      await expectStopped(round);
      assert.equal(fixture.sm.getPersistedSession(fixture.session.id)?.approvalState, "rejected");
    });

    for (const userInitiated of [true, false]) {
      it(`rejects on a plain "Reject" reply (userInitiated=${userInitiated})`, async () => {
        fixture = await start(name);
        const round = await proposePlan();
        const result = await executeRespond(fixture.sm, { session: fixture.session.id, message: "Reject", userInitiated });
        assert.match(result.text, /Plan rejected/);
        await expectStopped(round);
      });
    }

    it("falls back to plain-text replies when the buttons cannot be delivered", async () => {
      fixture = await start(name, { planPromptDelivery: "failed" });
      const round = await proposePlan();
      const fallback = await fixture.waitForNotification("plan-approval-fallback");
      const text = fallback.request.userMessages?.map((message) => message.text).join("\n") ?? "";
      assert.match(text, /buttons could not be delivered/);
      assert.match(text, /Reply "approve"/);
      assert.match(text, /Reply "reject"/);

      const result = await executeRespond(fixture.sm, { session: fixture.session.id, message: "Approve", userInitiated: true });
      assert.equal(result.isError, undefined, result.text);
      await expectImplementationStarted(round);
    });

    it("treats a plain \"Revise\" reply as a change request and forwards the next reply as feedback", async () => {
      fixture = await start(name, { planPromptDelivery: "failed" });
      const round = await proposePlan();
      const revise = await executeRespond(fixture.sm, { session: fixture.session.id, message: "Revise", userInitiated: true });
      assert.match(revise.text, /Reply with the changes you want/);
      assert.equal(fixture.session.approvalState, "changes_requested");
      await executeRespond(fixture.sm, { session: fixture.session.id, message: "Drop step 3", userInitiated: true });
      await expectRevisionRequested(round, "Drop step 3");
    });

    it("delegates the review to the orchestrator, which approves it directly", async () => {
      fixture = await start(name, { planApproval: "delegate" });
      const round = await proposePlan();
      const wake = fixture.lastNotification("plan-approval")!;
      assert.equal(wake.request.notifyUser, "never");
      assert.match(wake.request.wakeMessage ?? "", /Plan v1 ready\. ID: .+ You review it \(planApproval: delegate\)/);
      assert.equal(fixture.buttons("plan-approval").length, 0, "the user gets no buttons yet");

      const result = await executeRespond(fixture.sm, {
        session: fixture.session.id,
        message: "Approved. Go ahead.",
        approve: true,
        approvalRationale: "Scope matches the task and the change is low risk.",
      });
      assert.match(result.text, /Plan approved/);
      await expectImplementationStarted(round);
      assert.match(fixture.lastNotification("plan-approved")?.request.userMessage ?? "", /Plan approved[^\n]*\nWhy: Scope matches the task and the change is low risk\./);
    });

    for (const mode of ["delegate", "approve"] as const) {
      it(`lets the orchestrator hand a ${mode}-mode review to the user with buttons`, async () => {
        fixture = await start(name, { planApproval: mode });
        const round = await proposePlan();
        const before = fixture.notifications.length;
        const handedOver = fixture.sm.requestPlanApprovalFromUser(fixture.session.id, "Touches the billing schema; please confirm.");
        assert.match(handedOver, /Canonical plan approval prompt queued/);
        const buttons = await planButtons(before);
        assert.deepEqual(buttons.map((button) => button.label), ["Approve", "Revise", "Reject"]);

        await clickButton(buttonNamed(buttons, "Approve"));
        await expectImplementationStarted(round);
      });
    }

    it("wakes the orchestrator in approve mode with verification instructions and accepts its approval", async () => {
      fixture = await start(name, { planApproval: "approve" });
      const round = await proposePlan();
      const wake = fixture.lastNotification("plan-approval")!;
      assert.equal(wake.request.notifyUser, "never");
      assert.equal(fixture.buttons("plan-approval").length, 0);
      const text = wake.request.wakeMessage ?? "";
      assert.match(text, /Plan v1 ready\..*only after verifying the plan/);
      assert.match(text, /agent_output\(session='.+', full=true\)/);
      assert.match(text, /agent_escalate\(session='.+', kind='plan'/);
      assert.match(text, /approval_rationale/);

      await executeRespond(fixture.sm, {
        session: fixture.session.id,
        message: "Approved. Go ahead.",
        approve: true,
        approvalRationale: "Read the full plan; it only touches the task's files.",
      });
      await expectImplementationStarted(round);
    });

    it("resumes an idle-suspended session in implementation mode when its plan is approved", async () => {
      fixture = await start(name);
      await proposePlan();
      const buttons = await planButtons();
      const turnsBefore = fixture.backend.turns.length;
      fixture.session.kill("idle-timeout");
      await waitUntil(() => fixture!.sm.getPersistedSession(fixture!.session.id)?.status === "killed", "session suspended");
      assert.equal(fixture.sm.getPersistedSession(fixture.session.id)?.pendingPlanApproval, true, "the plan decision survives suspension");

      await clickButton(buttonNamed(buttons, "Approve"));
      await waitUntil(() => fixture!.backend.turns.length > turnsBefore, "resumed turn");
      const turn = fixture.backend.turns.at(-1)!;
      assert.equal(turn.planMode, false, "the resumed session implements");
      assert.match(turn.text, /The user approved your plan while this session was suspended/);
      const resumed = fixture.sm.resolve(fixture.session.id);
      assert.equal(resumed?.status, "running");
      assert.equal(resumed?.approvalState, "approved");

      const again = await clickButton(buttonNamed(buttons, "Approve"));
      assert.match(again.replies.join("\n"), /already approved|stale|no longer/);
    });

    it("resumes in implementation mode when the plan is approved after a Gateway restart", async () => {
      fixture = await start(name);
      await proposePlan();
      const buttons = await planButtons();
      const turnsBefore = fixture.backend.turns.length;
      await fixture.restartGateway();
      assert.equal(fixture.sm.getPersistedSession(fixture.session.id)?.pendingPlanApproval, true, "the plan decision survives the restart");

      await clickButton(buttonNamed(buttons, "Approve"));
      await waitUntil(() => fixture!.backend.turns.length > turnsBefore, "resumed turn");
      const turn = fixture.backend.turns.at(-1)!;
      assert.equal(turn.planMode, false);
      assert.match(turn.text, /The user approved your plan while this session was suspended/);
    });
  });
}
