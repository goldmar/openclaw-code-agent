import "./test-env";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPluginConfig, getGoalVerifierPolicyRevision } from "../src/config";
import { runGit } from "../src/git-exec";
import { GoalController } from "../src/goal-controller";
import { GoalTaskStore } from "../src/goal-store";
import { Session } from "../src/session";
import { SessionManager } from "../src/session-manager";
import { registerHarness } from "../src/harness";
import { executeRespond, requestPlanDecisionChanges } from "../src/actions/respond";
import { resolveGoalRepositoryIdentity } from "../src/goal-repository-identity";
import { effectiveGoalVerifiers, GoalVerificationAuthority, resolveGoalVerification } from "../src/goal-verifier-policy";
import type { GoalTaskState } from "../src/types";
import { createFakeHarness, createStubSession, tick } from "./helpers";

let dir: string, repoA: string, repoB: string;
const savedEnv = { PATH: process.env.PATH, GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
async function git(cwd: string, ...args: string[]): Promise<string> { return runGit(args, { cwd, timeout: 10_000 }); }
async function repository(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  await git(path, "init", "-b", "main");
  writeFileSync(join(path, "fixture"), "repository identity\n");
  await git(path, "add", "fixture");
  await git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture");
}
function policies(a = ["baseline A", "baseline A"], b = ["baseline B"]) {
  return { goalVerificationPolicies: { repositories: [
    { repository: repoA, requiredCommands: a }, { repository: repoB, requiredCommands: b },
  ] } };
}
async function admitted(workdir: string, additions: string[] = []) {
  const selection = await resolveGoalVerification(workdir, additions.map(command => ({ label: "addition", command })));
  const task: GoalTaskState = { id: "goal", name: "goal", goal: "Verify", workdir, status: "running", createdAt: 1, updatedAt: 1,
    iteration: 1, maxIterations: 2, loopMode: "verifier", repeatedFailureCount: 0,
    goalVerificationBinding: selection.binding, verifierCommands: effectiveGoalVerifiers(selection.binding) };
  const authority = new GoalVerificationAuthority(); authority.admit(task, selection.revision);
  return { task, authority };
}
async function waitFor(path: string): Promise<void> {
  for (let i = 0; i < 400; i++) { if (existsSync(path)) return; await tick(5); }
  assert.fail("Git identity fixture never reached its held lookup");
}
/** Hold only the first real Git lookup; later policy transitions still use authentic Git. */
function heldGit() {
  const bin = join(dir, "bin"), started = join(dir, "started"), release = join(dir, "release");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ ! -f '${started}' ]; then touch '${started}'; while [ ! -f '${release}' ]; do sleep 0.01; done; fi\nexec /usr/bin/git "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${savedEnv.PATH}`;
  return { started, release };
}
function controllerFixture() {
  const store = new GoalTaskStore({ OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH: join(dir, "goals.json") });
  let launches = 0;
  const manager = { emitGoalTaskUpdate: () => {}, resolve: (): undefined => undefined, sendGoalVerifierConfirmation: () => {}, kill: () => {},
    launchAndAwaitRunning: async () => { launches++; return createStubSession({ workdir: repoA, status: "running", on: (): undefined => undefined }); } };
  const controller = new GoalController(manager as any); (controller as any).store = store;
  return { controller, store, launches: () => launches };
}
beforeEach(async () => {
  setPluginConfig({}); dir = mkdtempSync(join(tmpdir(), "goal-repository-policy-"));
  repoA = join(dir, "a"); repoB = join(dir, "b");
  await repository(repoA); await repository(repoB);
});
afterEach(() => {
  setPluginConfig({});
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(dir, { recursive: true, force: true });
});

describe("actual repository goal policies", () => {
  it("selects canonical main, subdirectory, symlink and linked worktree identity; a separate clone selects its own policy", async () => {
    const sub = join(repoA, "sub"), alias = join(dir, "alias"), linked = join(dir, "linked"), clone = join(dir, "clone");
    mkdirSync(sub); symlinkSync(repoA, alias); await git(repoA, "worktree", "add", "-b", "linked", linked);
    await git(dir, "clone", repoA, clone);
    setPluginConfig(policies());
    const a = (await resolveGoalVerification(repoA)).binding;
    for (const path of [sub, alias, linked]) {
      const binding = (await resolveGoalVerification(path)).binding;
      assert.deepEqual(binding.identity, a.identity); assert.deepEqual(binding.requiredCommands, ["baseline A", "baseline A"]);
    }
    await assert.rejects(resolveGoalVerification(clone), /No goal verification policy matches/);
    setPluginConfig({ goalVerificationPolicies: { repositories: [
      ...policies().goalVerificationPolicies.repositories, { repository: clone, requiredCommands: ["clone baseline"] },
    ] } });
    assert.deepEqual((await resolveGoalVerification(clone)).binding.requiredCommands, ["clone baseline"]);
    assert.notDeepEqual((await resolveGoalVerification(clone)).binding.identity, a.identity);
    assert.deepEqual((await resolveGoalVerification(repoB)).binding.requiredCommands, ["baseline B"]);
  });

  it("ignores mutable remote URLs and ambient Git redirection variables", async () => {
    setPluginConfig(policies()); const original = (await resolveGoalVerification(repoA)).binding;
    await git(repoA, "remote", "add", "origin", repoB);
    await git(repoA, "remote", "set-url", "origin", "https://example.invalid/other.git");
    process.env.GIT_DIR = join(repoB, ".git"); process.env.GIT_WORK_TREE = repoB;
    assert.deepEqual((await resolveGoalVerification(repoA)).binding, original);
  });

  it("rejects duplicate canonical operator entries through symlinks or linked worktrees", async () => {
    const alias = join(dir, "alias"), linked = join(dir, "linked");
    symlinkSync(repoA, alias); await git(repoA, "worktree", "add", "-b", "linked", linked);
    for (const duplicate of [alias, linked]) {
      setPluginConfig({ goalVerificationPolicies: { repositories: [
        { repository: repoA, requiredCommands: ["true"] }, { repository: duplicate, requiredCommands: ["false"] },
      ] } });
      await assert.rejects(resolveGoalVerification(repoA), /Duplicate canonical/);
    }
  });

  it("requires an explicit default for unmatched and true nonrepository directories; absent feature retains caller checks", async () => {
    const nonrepo = join(dir, "plain"); mkdirSync(nonrepo);
    setPluginConfig({ goalVerificationPolicies: { repositories: [{ repository: repoA, requiredCommands: ["A"] }] } });
    for (const path of [repoB, nonrepo]) await assert.rejects(resolveGoalVerification(path), /No goal verification policy matches/);
    setPluginConfig({ goalVerificationPolicies: { repositories: [{ repository: repoA, requiredCommands: ["A"] }], defaultRequiredCommands: ["default"] } });
    for (const path of [repoB, nonrepo]) { const binding = (await resolveGoalVerification(path)).binding; assert.equal(binding.source, "default"); assert.deepEqual(binding.requiredCommands, ["default"]); }
    setPluginConfig({}); const caller = (await resolveGoalVerification(nonrepo, [{ label: "caller", command: " true " }])).binding;
    assert.equal(caller.source, "none"); assert.deepEqual(caller.additionalCommands, ["true"]);
  });

  it("keeps absent, null, legacy-null and unknown own properties distinct in the transition journal", async () => {
    setPluginConfig({}); const absent = getGoalVerifierPolicyRevision();
    setPluginConfig({ goalVerificationPolicies: null } as any);
    assert.ok(getGoalVerifierPolicyRevision() > absent); await assert.rejects(resolveGoalVerification(repoA), /Invalid goalVerificationPolicies/);
    setPluginConfig({}); const reset = getGoalVerifierPolicyRevision();
    setPluginConfig({ requiredGoalVerifierCommands: null });
    assert.ok(getGoalVerifierPolicyRevision() > reset); await assert.rejects(resolveGoalVerification(repoA), /was removed.*Migrate/);
    setPluginConfig({ goalVerificationPolicies: { defaultRequiredCommands: ["true"] } });
    const { task, authority } = await admitted(repoA);
    setPluginConfig({ goalVerificationPolicies: { defaultRequiredCommands: ["true"], unknown: undefined } } as any);
    setPluginConfig({ goalVerificationPolicies: { defaultRequiredCommands: ["true"] } });
    await assert.rejects(authority.validate(task), /Invalid goalVerificationPolicies/);
  });

  it("fails closed for invalid operator paths, dense command arrays and malformed policy objects", async () => {
    for (const raw of [false, null, {}, { repositories: [] }, { defaultRequiredCommands: [] }, { defaultRequiredCommands: Array(1) },
      { defaultRequiredCommands: [" "] }, { defaultRequiredCommands: ["true", null] }, { repositories: Array(1) },
      { repositories: [{ repository: "relative", requiredCommands: ["true"] }] },
      { repositories: [{ repository: dir, requiredCommands: ["true"] }] },
      { repositories: [{ repository: repoA, requiredCommands: Array(1) }] }]) {
      setPluginConfig({ goalVerificationPolicies: raw } as any);
      await assert.rejects(resolveGoalVerification(repoA), /Invalid goalVerificationPolicies/);
    }
    setPluginConfig({ goalVerificationPolicies: { repositories: [{ repository: join(dir, "missing"), requiredCommands: ["true"] }], defaultRequiredCommands: ["default"] } });
    await assert.rejects(resolveGoalVerification(repoA), /Cannot verify/);
  });

  it("refuses missing/replaced repositories, new nested repositories and linked .git retargets while retaining the original binding", async () => {
    setPluginConfig(policies());
    const linked = join(dir, "linked"); await git(repoA, "worktree", "add", "-b", "linked", linked);
    const linkedGoal = await admitted(linked), original = structuredClone(linkedGoal.task.goalVerificationBinding);
    writeFileSync(join(linked, ".git"), `gitdir: ${join(repoB, ".git")}\n`);
    await assert.rejects(linkedGoal.authority.validate(linkedGoal.task), /identity changed/);
    assert.deepEqual(linkedGoal.task.goalVerificationBinding, original);
    assert.deepEqual((await resolveGoalVerification(repoA)).binding.requiredCommands, ["baseline A", "baseline A"]);
    const nested = join(repoA, "nested"); mkdirSync(nested); const nestedGoal = await admitted(nested);
    await repository(nested); await assert.rejects(nestedGoal.authority.validate(nestedGoal.task), /identity changed/);
    const replaced = await admitted(repoA); renameSync(repoA, join(dir, "original-a"));
    await assert.rejects(replaced.authority.validate(replaced.task), /Cannot verify/);
    await repository(repoA); await assert.rejects(replaced.authority.validate(replaced.task), /identity changed/);
  });

  it("never treats broken Git markers, unexpected Git errors or timeout as nonrepository fallback", async () => {
    const plain = join(dir, "plain"); mkdirSync(plain);
    setPluginConfig({ goalVerificationPolicies: { defaultRequiredCommands: ["default"] } });
    writeFileSync(join(plain, ".git"), "gitdir: /does-not-exist\n");
    await assert.rejects(resolveGoalVerification(plain), /Cannot verify/);
    rmSync(join(plain, ".git"));
    const bin = join(dir, "bin"); mkdirSync(bin); process.env.PATH = `${bin}:${savedEnv.PATH}`;
    for (const body of ["echo 'fatal: permission denied' >&2; exit 128", "sleep 2; exit 0"]) {
      writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, "git"), 0o755);
      await assert.rejects(resolveGoalVerification(plain), /Cannot verify/);
    }
    writeFileSync(join(plain, ".git"), "gitdir: /does-not-exist\n");
    writeFileSync(join(bin, "git"), "#!/bin/sh\necho 'fatal: not a git repository (or any of the parent directories): .git' >&2; exit 128\n");
    await assert.rejects(resolveGoalVerification(plain), /Cannot verify/);
  });

  it("preserves selected-policy authority across unrelated B changes, including restart-style fresh validation", async () => {
    setPluginConfig(policies()); const { task, authority } = await admitted(repoA, ["extra"]), binding = structuredClone(task.goalVerificationBinding);
    setPluginConfig(policies(undefined, ["different B"]));
    await authority.validate(task); await new GoalVerificationAuthority().validate(task);
    assert.deepEqual(task.goalVerificationBinding, binding); assert.deepEqual(task.verifierCommands.map(step => step.command), ["baseline A", "baseline A", "extra"]);
  });

  for (const transition of ["commands", "default-map", "duplicate-alias"] as const) {
    it(`detects selected-policy ${transition} ABA while leaving the original binding unchanged`, async () => {
      const alias = join(dir, "alias"); symlinkSync(repoA, alias);
      const initial = transition === "default-map" ? { goalVerificationPolicies: { defaultRequiredCommands: ["baseline A", "baseline A"] } } : policies();
      setPluginConfig(initial); const { task, authority } = await admitted(repoA), binding = structuredClone(task.goalVerificationBinding);
      if (transition === "commands") setPluginConfig(policies(["different A"]));
      else if (transition === "default-map") setPluginConfig(policies());
      else setPluginConfig({ goalVerificationPolicies: { repositories: [
        ...policies().goalVerificationPolicies.repositories, { repository: alias, requiredCommands: ["baseline A", "baseline A"] },
      ] } });
      setPluginConfig(initial);
      await assert.rejects(authority.validate(task), /policy.*changed|Duplicate canonical/i);
      assert.deepEqual(task.goalVerificationBinding, binding);
    });
  }

  it("captures every affected transition during the first restored async identity lookup", async () => {
    setPluginConfig(policies()); const { task } = await admitted(repoA), authority = new GoalVerificationAuthority();
    const hold = heldGit(), pending = authority.validate(task);
    try {
      await waitFor(hold.started); setPluginConfig(policies(["changed A"])); setPluginConfig(policies());
      writeFileSync(hold.release, "release\n"); await assert.rejects(pending, /policy.*changed/i);
    } finally { writeFileSync(hold.release, "cleanup\n"); await pending.catch((): void => undefined); }
  });

  it("fails old active bindings explicitly and refuses changed additional/effective suites", async () => {
    setPluginConfig(policies()); const { task, authority } = await admitted(repoA, ["extra"]);
    const legacy: GoalTaskState = { ...task, goalVerificationBinding: undefined, requiredVerifierCommands: ["baseline A"] };
    await assert.rejects(authority.validate(legacy), /legacy.*binding.*Start a new goal/);
    task.goalVerificationBinding!.additionalCommands = ["different"];
    await assert.rejects(authority.validate(task), /binding|changed/);
  });

  it("checks the actual prepared runtime repository before registration, retaining the requested original checkout", async () => {
    setPluginConfig(policies(["true"], ["true"])); const { controller } = controllerFixture();
    const goal = await controller.launchTask({ goal: "Runtime identity", workdir: repoA });
    const binding = structuredClone(goal.goalVerificationBinding);
    const manager = new SessionManager(2, 5, { store: { indexPath: join(dir, "sessions.json") } });
    manager.setGoalTaskAuthorizer((id, workdir) => controller.assertTaskAuthorized(id, workdir));
    (manager as any).checkRepoPolicyForLaunch = async () => ({ ok: true, resolution: { source: "none", provider: "unsupported" } });
    (manager as any).restore.prepareSpawn = async () => ({ actualWorkdir: repoB, originalWorkdir: repoA });
    let initialized = 0; (manager as any).runtimeBootstrap.initializeSession = async () => { initialized++; };
    await assert.rejects(manager.launchSession({ prompt: "Resume", workdir: repoA, goalTaskId: goal.id,
      route: { provider: "system", target: "system" }, worktreeStrategy: "off" }), /session repository identity changed/);
    assert.equal(initialized, 0); assert.equal(manager.list().length, 0);
    assert.deepEqual(goal.goalVerificationBinding, binding); assert.equal(goal.status, "failed");
    assert.deepEqual(await resolveGoalRepositoryIdentity(repoA), binding!.identity);
  });

  it("guards a direct Session's current workdir rather than the original task checkout", async () => {
    setPluginConfig(policies(["true"], ["true"])); const { controller } = controllerFixture();
    const goal = await controller.launchTask({ goal: "Actual session directory", workdir: repoA });
    const harness = createFakeHarness("repository-session-identity"); registerHarness(harness);
    const session = new Session({ prompt: "Work", workdir: repoB, harness: harness.name, goalTaskId: goal.id,
      assertGoalTaskAuthorized: actual => controller.assertTaskAuthorized(goal.id, actual) }, "actual-workdir");
    await session.start();
    assert.equal(session.status, "failed"); assert.equal(harness.lastLaunchOptions, undefined);
    assert.equal(goal.status, "failed");
  });

  for (const affected of [false, true]) {
    it(`rechecks the returned authorization ticket across its microtask gap (${affected ? "affected ABA denies" : "unrelated B retries"})`, async () => {
      setPluginConfig(policies(["true"], ["true"])); const { controller } = controllerFixture();
      const goal = await controller.launchTask({ goal: "Ticket gap", workdir: repoA });
      const harness = createFakeHarness(`authorization-ticket-${affected}`); registerHarness(harness);
      let first = true;
      const session = new Session({ prompt: "Work", workdir: repoA, harness: harness.name, goalTaskId: goal.id,
        assertGoalTaskAuthorized: async actual => {
          const ticket = await controller.assertTaskAuthorized(goal.id, actual);
          if (first) { first = false; queueMicrotask(() => {
            setPluginConfig(affected ? policies(["false"], ["true"]) : policies(["true"], ["false"]));
            if (affected) setPluginConfig(policies(["true"], ["true"]));
          }); }
          return ticket;
        } }, "ticket-gap");
      try {
        await session.start();
        assert.equal(Boolean(harness.lastLaunchOptions), !affected);
        assert.equal(goal.status, affected ? "failed" : "running");
      } finally { if (session.status === "running" || session.status === "starting") session.kill("user"); harness.endMessages(); }
    });
  }

  for (const option of [false, true]) {
    it(`never submits ${option ? "an option" : "text"} to a replaced pending request during async admission`, async () => {
      const harness = createFakeHarness(`pending-request-identity-${option}`); registerHarness(harness);
      const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(); let hold = false, effects = 0;
      const session = new Session({ prompt: "Work", workdir: repoA, harness: harness.name, multiTurn: true, goalTaskId: "goal",
        assertGoalTaskAuthorized: async () => { if (hold) { entered.resolve(); await released.promise; } return { isCurrent: () => true }; } }, "pending-identity");
      await session.start(); session.transition("running");
      session.pendingInputState = { requestId: "original", kind: "question", promptText: "Original?", options: [], allowsFreeText: true };
      Object.assign((session as any).harnessHandle, { submitPendingInputText: async () => { effects++; return true; }, submitPendingInputOption: async () => { effects++; return true; } });
      hold = true; const action = option ? session.submitPendingInputOption(0) : session.submitPendingInputText("yes");
      try {
        await entered.promise;
        session.pendingInputState = { requestId: "replacement", kind: "question", promptText: "Replacement?", options: [], allowsFreeText: true };
        released.resolve(); assert.equal(await action, false); assert.equal(effects, 0);
        assert.equal(session.pendingInputState.requestId, "replacement");
      } finally { released.resolve(); await action; session.kill("user"); harness.endMessages(); }
    });
  }

  for (const boundary of ["initial", "declined", "final", "interrupt"] as const) {
    it(`refuses a replaced request/plan at the outer respond ${boundary} await without fallback delivery`, async () => {
      const manager = new SessionManager(2, 5, { store: { indexPath: join(dir, `respond-${boundary}.json`) } });
      const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(); let calls = 0, effects = 0;
      manager.setGoalTaskAuthorizer(async () => {
        calls++;
        if ((boundary === "initial" && calls === 1) || (boundary === "final" && calls === 2)) { entered.resolve(); await released.promise; }
        return { isCurrent: () => true };
      });
      const session = createStubSession({ id: "respond", goalTaskId: "goal", workdir: repoA,
        pendingInputState: boundary === "initial" || boundary === "declined" ? { requestId: "original", kind: "question", options: [], allowsFreeText: true } : undefined,
        pendingPlanApproval: boundary === "interrupt", planDecisionVersion: boundary === "interrupt" ? 1 : 0,
        actionablePlanDecisionVersion: boundary === "interrupt" ? 1 : undefined,
        submitPendingInputText: async () => { if (boundary === "declined") { entered.resolve(); await released.promise; return false; } effects++; return true; },
        interrupt: async () => { entered.resolve(); await released.promise; return true; },
        switchPermissionMode: () => { effects++; }, sendMessage: async () => { effects++; return "sent"; },
      });
      (manager as any).sessions.set(session.id, session);
      const action = executeRespond(manager, { session: session.id, message: "Original answer", userInitiated: true,
        fromGoalController: boundary === "final", interrupt: boundary === "interrupt", approve: boundary === "interrupt", userApproval: "button" });
      await entered.promise;
      if (boundary === "interrupt") session.planDecisionVersion = 2;
      else session.pendingInputState = { requestId: "replacement", kind: "question", options: [], allowsFreeText: true };
      released.resolve(); const result = await action;
      assert.equal(result.isError, true); assert.match(result.text, /request changed|plan or session changed/); assert.equal(effects, 0);
      (manager as any).sessions.clear();
    });
  }

  for (const replacement of ["session", "request", "answered"] as const) {
    it(`keeps replacement question ownership intact during ${replacement} manager authorization`, async () => {
      const manager = new SessionManager(2, 5, { store: { indexPath: join(dir, `question-${replacement}.json`) } });
      const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(); let calls = 0, notifications = 0;
      manager.setGoalTaskAuthorizer(async () => { calls++; if (calls === (replacement === "answered" ? 2 : 1)) { entered.resolve(); await released.promise; } return { isCurrent: () => true }; });
      (manager as any).questions.dispatchSessionNotification = () => { notifications++; };
      const session = createStubSession({ id: "question", goalTaskId: "goal", workdir: repoA,
        pendingInputState: { requestId: "original", kind: "question", options: [], allowsFreeText: true } });
      (manager as any).sessions.set(session.id, session);
      const action = manager.handleAskUserQuestion(session.id, { questions: [{ question: "Original?", options: [{ label: "yes" }] }] }, { requestId: "original" });
      if (replacement === "answered") {
        for (let count = 0; !(manager as any).pendingAskUserQuestions.has(session.id) && count < 400; count++) await tick(5);
        assert.equal((manager as any).questions.resolveAskUserQuestion(session.id, 0), true);
      }
      await entered.promise;
      const replacementQuestion = { requestId: "replacement", questions: [{ question: "Replacement?" }], resolve: () => {}, reject: () => { notifications++; } };
      (manager as any).pendingAskUserQuestions.set(session.id, replacementQuestion);
      if (replacement === "session") (manager as any).sessions.set(session.id, createStubSession({ id: session.id, goalTaskId: "other", workdir: repoB }));
      else session.pendingInputState = { requestId: "replacement", kind: "question", options: [], allowsFreeText: true };
      released.resolve();
      try {
        const outcome = await Promise.race([action.then(() => ({ allowed: true }), (error: Error) => ({ error })), tick(1_000).then(() => ({ timedOut: true }))]);
        assert.ok("error" in outcome, "Stale caller must be refused without waiting for the replacement question");
        assert.match(outcome.error.message, /question.*changed|session or request changed/);
        assert.equal((manager as any).pendingAskUserQuestions.get(session.id), replacementQuestion); assert.equal(notifications, 0);
      } finally {
        const pending = (manager as any).pendingAskUserQuestions.get(session.id);
        if (pending && pending !== replacementQuestion) pending.resolve({ behavior: "allow", updatedInput: {} });
        (manager as any).pendingAskUserQuestions.clear(); (manager as any).sessions.clear();
        await action.catch((): void => undefined);
      }
    });
  }

  it("admits the original named native question when its Session state appears during authorization", async () => {
    const manager = new SessionManager(2, 5, { store: { indexPath: join(dir, "question-appeared.json") } });
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(); let first = true;
    manager.setGoalTaskAuthorizer(async () => { if (first) { first = false; entered.resolve(); await released.promise; } return { isCurrent: () => true }; });
    const session = createStubSession({ id: "question-appeared", goalTaskId: "goal", workdir: repoA });
    (manager as any).sessions.set(session.id, session);
    const action = manager.handleAskUserQuestion(session.id, { questions: [{ question: "Original?", options: [{ label: "yes" }] }] }, { requestId: "original" });
    await entered.promise; session.pendingInputState = { requestId: "original", kind: "question", options: [], allowsFreeText: true }; released.resolve();
    for (let count = 0; !(manager as any).pendingAskUserQuestions.has(session.id) && count < 400; count++) await tick(5);
    assert.equal((manager as any).pendingAskUserQuestions.get(session.id)?.requestId, "original");
    assert.equal((manager as any).questions.resolveAskUserQuestion(session.id, 0), true); assert.equal((await action).behavior, "allow");
    (manager as any).sessions.clear();
  });

  for (const stopped of [false, true]) {
    for (const path of ["idle", "ralph", "repair"] as const) {
      it(`suppresses ${path} progress/evaluation after assignment authorization is ${stopped ? "stopped" : "revoked"}`, async () => {
        setPluginConfig(policies([path === "repair" ? "exit 7" : "true"], ["true"])); const f = controllerFixture();
        const goal = await f.controller.launchTask({ goal: "Assignment admission", workdir: repoA, maxIterations: 8, loopMode: path === "ralph" ? "ralph" : "verifier" });
        const notices: string[] = [], evaluations: string[] = [];
        (f.controller as any).sessionManager.emitGoalTaskUpdate = (_task: unknown, _text: string, label: string) => { notices.push(label); };
        (f.controller as any).scheduleTaskEvaluation = (_id: string, reason: string) => { evaluations.push(reason); };
        const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(); let assignment = false;
        const authority = (f.controller as any).verificationAuthority, validate = authority.validate.bind(authority);
        authority.validate = async (task: GoalTaskState) => { if (assignment) { entered.resolve(); await released.promise; } return validate(task); };
        (f.controller as any).resumeTaskSession = async () => { assignment = true; return createStubSession({ id: "resumed", workdir: repoA, status: "running" }); };
        const previous = createStubSession({ id: goal.sessionId, status: "completed", getOutput: () => ["Continue working"] });
        const action = path === "idle" ? (f.controller as any).resumeAfterIdleTimeout(goal, previous, "Continue")
          : (f.controller as any).handleTerminalSession(goal, previous);
        await entered.promise;
        if (stopped) f.controller.stopTask(goal.id); else setPluginConfig(policies(["false"], ["true"]));
        released.resolve(); await action;
        assert.equal(goal.status, stopped ? "stopped" : "failed");
        assert.deepEqual(notices, [stopped ? "goal-task-stopped" : "goal-task-failed"]); assert.deepEqual(evaluations, []);
      });
    }
  }

  it("refuses a replacement plan version during Revise admission without clearing or rewriting it", async () => {
    const manager = new SessionManager(2, 5, { store: { indexPath: join(dir, "plan-sessions.json") } });
    const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    manager.setGoalTaskAuthorizer(async () => { entered.resolve(); await released.promise; return { isCurrent: () => true }; });
    const session = createStubSession({ id: "plan", goalTaskId: "goal", workdir: repoA, pendingPlanApproval: true, planDecisionVersion: 1, approvalState: "pending" });
    (manager as any).sessions.set(session.id, session);
    let effects = 0; manager.clearPlanDecisionTokens = () => { effects++; }; manager.updatePersistedSession = () => { effects++; return true; };
    const action = requestPlanDecisionChanges(manager, session.id);
    await entered.promise; session.planDecisionVersion = 2; released.resolve();
    const result = await action; assert.equal(result.isError, true); assert.match(result.text, /plan decision changed/);
    assert.equal(effects, 0); assert.equal(session.approvalState, "pending");
    (manager as any).sessions.clear();
  });

  for (const surface of ["native", "send"] as const) {
    it(`refuses replacement approval plans during ${surface} async admission before backend release`, async () => {
      const harness = createFakeHarness(`approval-plan-identity-${surface}`); registerHarness(harness);
      const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(); let hold = false, effects = 0;
      const session = new Session({ prompt: "Work", workdir: repoA, harness: harness.name, multiTurn: true, goalTaskId: "goal",
        assertGoalTaskAuthorized: async () => { if (hold) { entered.resolve(); await released.promise; } return { isCurrent: () => true }; } }, "approval-identity");
      await session.start(); session.transition("running");
      session.pendingPlanApproval = true; session.planDecisionVersion = 1; (session as any).pendingModeSwitch = "bypassPermissions";
      Object.assign((session as any).harnessHandle, { resolvePlanDecision: async () => { effects++; return true; }, setPermissionMode: async () => { effects++; } });
      hold = true;
      const action = surface === "native" ? (session as any).resolveNativePlanDecision({ kind: "approve", permissionMode: "bypassPermissions" }, true)
        : session.sendMessage("Approved. Go ahead.");
      try {
        await entered.promise; session.planDecisionVersion = 2; released.resolve();
        await assert.rejects(action, /plan or session changed/); assert.equal(effects, 0);
        assert.equal(session.planDecisionVersion, 2); assert.equal(session.pendingPlanApproval, true);
        assert.equal(session.currentPermissionMode, "plan");
      } finally { released.resolve(); await action.catch((): void => undefined); session.kill("user"); harness.endMessages(); }
    });
  }

  it("starts only one session for concurrently admitted confirmation callbacks", async () => {
    setPluginConfig(policies(["true"], ["true"])); const f = controllerFixture();
    const task = await f.controller.launchTask({ goal: "Concurrent confirmation", workdir: repoA,
      verifierCommands: [{ label: "extra", command: "true" }], requireVerifierConfirmation: true });
    const decisions = await Promise.all([f.controller.confirmVerifierCommands(task.id), f.controller.confirmVerifierCommands(task.id)]);
    assert.deepEqual(decisions.map(result => result!.action).sort(), ["not_waiting", "started"]);
    assert.equal(f.launches(), 1); assert.equal(task.status, "running");
  });

  for (const replacement of ["backend", "owner", "workdir"] as const) {
    it(`refuses a persisted-only Revise target replaced by ${replacement} during admission`, async () => {
      const manager = new SessionManager(2, 5, { store: { indexPath: join(dir, "persisted-plan.json") } });
      const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
      manager.setGoalTaskAuthorizer(async () => { entered.resolve(); await released.promise; return { isCurrent: () => true }; });
      let saved: any = { sessionId: "stable", goalTaskId: "goal", name: "plan", workdir: repoA, createdAt: 1,
        backendRef: { kind: "codex-app-server", conversationId: "original" }, pendingPlanApproval: true, planDecisionVersion: 1, approvalState: "pending" };
      manager.getPersistedSession = () => saved;
      let effects = 0; manager.clearPlanDecisionTokens = () => { effects++; }; manager.updatePersistedSession = () => { effects++; return true; };
      const action = requestPlanDecisionChanges(manager, "stable");
      await entered.promise;
      saved = { ...saved, ...(replacement === "backend" ? { backendRef: { kind: "codex-app-server", conversationId: "replacement" } }
        : replacement === "owner" ? { goalTaskId: "replacement" } : { workdir: repoB }) };
      released.resolve(); const result = await action;
      assert.equal(result.isError, true); assert.match(result.text, /plan decision changed/); assert.equal(effects, 0);
      assert.equal(saved.approvalState, "pending");
    });
  }

  it("uses the persisted-only runtime workdir, admitting linked identity and denying another repository before Revise patches", async () => {
    const linked = join(dir, "persisted-linked"); await git(repoA, "worktree", "add", "-b", "persisted-linked", linked);
    for (const workdir of [linked, repoB]) {
      setPluginConfig(policies(["true"], ["true"])); const f = controllerFixture();
      const goal = await f.controller.launchTask({ goal: "Persisted runtime identity", workdir: repoA });
      const manager = new SessionManager(2, 5, { store: { indexPath: join(dir, "persisted-workdir.json") } });
      manager.setGoalTaskAuthorizer((id, actualWorkdir) => f.controller.assertTaskAuthorized(id, actualWorkdir));
      const saved: any = { sessionId: "persisted-runtime", goalTaskId: goal.id, name: "plan", workdir, createdAt: 1,
        backendRef: { kind: "codex-app-server", conversationId: "owned" }, pendingPlanApproval: true, planDecisionVersion: 1, approvalState: "pending" };
      manager.getPersistedSession = () => saved;
      let patches = 0; manager.clearPlanDecisionTokens = () => {}; manager.updatePersistedSession = () => { patches++; return true; };
      manager.queueOrchestratorContext = () => true;
      const result = await requestPlanDecisionChanges(manager, saved.sessionId);
      if (workdir === linked) { assert.equal(result.isError, undefined); assert.equal(patches, 1); assert.equal(goal.status, "running"); }
      else { assert.equal(result.isError, true); assert.match(result.text, /session repository identity changed/); assert.equal(patches, 0); assert.equal(goal.status, "failed"); }
      assert.equal((await resolveGoalRepositoryIdentity(repoA)).kind, "git", "Original checkout remains available");
    }
  });
});
