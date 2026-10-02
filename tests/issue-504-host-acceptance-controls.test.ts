import "./test-env";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { cpSync, truncateSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getSessionOutputText, getSessionsListingText } from "../src/application/session-view";
import { executeRespond } from "../src/actions/respond";
import { SessionStore } from "../src/session-store";
import { STORE_SCHEMA_VERSION } from "../src/session-store-normalization";
import { Session } from "../src/session";
import type { SessionManager } from "../src/session-manager";
import type { ServerResponse } from "node:http";
import { options, nativeResult, compositeToolCallId } from "../scripts/e2e/oca-issue-504-host-acceptance";
import { gitFixtureRow, requireGitFixtureIdentities, gitBarrierHook, observeGitCall, requireGitBarrier, gitCallResult, HostEvidence, repeatOutcome, settleRepeatCalls, repeatOutcomeCounts, repeatNativeObservation, HOST_COHORTS, hostCohort, hostCohortCoverage, requiredHostScenarios, runsHostCohort, replayObservedPlan, FIXTURE_PLAN, nativePlanBoundary, publicOutputObservation, waitingPlanObservation, hasLivePlanBoundary, requireAskPlanRefusal, publicAliasOwner, negativeSnapshot, assertNegativeWindow, projectNativePlanFrame, providerSseObservation, planRowObservation, hasNativePlanBoundary, responseFrames, messageItem, writeNativeRelay, responseResumeBoundary, requireResponseResume, seedObserverAllow, managedObserverAllow, generationObservation, stoppedGeneration, killResultClass, freshResume, aliasOwnerObservation, assertAliasProtection, requireHttpBefore, requireEmbeddedAfter, classifyProvider, selectedProvider, observerSourceProof, installObserver, verifyObserverInspection, sha256, subscribeFixtureMessages, projectFixtureHostEvent, hasFreshSubscribedTerminal, preparePackedInstaller, command, closeFailedProviderResponse, cleanupAll, currentDescendant, ignorableProcReadFailure, fixtureEnv, FIXTURE_MARKER, ownedPath, packedCandidateProof, expectedPublishedPackage, verifyPackedPluginInspection, freshPluginBootstrap, processIdentity, requireCandidate, sameProcess, sameProcessFields, stopNativeProcesses, trackOwnedChild, stopOwnedChild, until, validateNativeExecutable, writeHostObserver } from "../scripts/e2e/oca-issue-504-host-fixtures";

const archiveReader = join(process.cwd(), "scripts", "e2e", "oca-issue-504-archive-proof.py");
function readArchive(path: string) {
  return JSON.parse(execFileSync("/usr/bin/python3", ["-I", archiveReader, path], { encoding: "utf8", timeout: 30_000, maxBuffer: 2_097_152, stdio: ["ignore", "pipe", "pipe"] }));
}
function writeArchive(path: string, members: Array<{ name: string; bytes?: string; kind?: string; size?: number }>) {
  const script = "import base64,gzip,io,json,sys,tarfile\nwith open(sys.argv[1],'wb') as raw:\n with gzip.GzipFile(fileobj=raw,mode='wb',mtime=0) as gz:\n  with tarfile.open(fileobj=gz,mode='w',format=tarfile.PAX_FORMAT) as tf:\n   for item in json.loads(sys.stdin.read()):\n    member=tarfile.TarInfo(item['name']); data=base64.b64decode(item.get('bytes','')); member.size=item.get('size',len(data))\n    if item.get('kind')=='link': member.type=tarfile.SYMTYPE;member.linkname='../outside';member.size=0\n    tf.addfile(member,io.BytesIO(data) if member.isreg() else None)\n";
  execFileSync("/usr/bin/python3", ["-I", "-c", script, path], { input: JSON.stringify(members), timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] });
}
function syntheticPackedInstall() {
  const fixture = mkdtempSync(join(tmpdir(), "oca504-packed-control-"));
  writeFileSync(join(fixture, ".fixture-owner"), FIXTURE_MARKER);
  const candidate = join(fixture, "candidate"), tarball = join(fixture, "candidate.tgz");
  mkdirSync(join(candidate, "dist", "chunks"), { recursive: true });
  writeFileSync(join(candidate, "dist", "index.js"), "synthetic candidate bytes NEVER executed");
  writeFileSync(join(candidate, "dist", "chunks", "fixture.js"), "synthetic chunk NEVER executed");
  const source = { name: "openclaw-code-agent", version: "5.0.1", packageManager: "pnpm@11.15.1", scripts: { prepack: "pnpm build", test: "node inert-fixture-only" }, dependencies: { "inert-fixture": "1.2.3" }, openclaw: { extensions: ["./dist/index.js"], minHostVersion: "2026.9.7" }, publishConfig: { access: "public", provenance: true } };
  writeFileSync(join(candidate, "package.json"), JSON.stringify(source));
  writeFileSync(join(candidate, "openclaw.plugin.json"), JSON.stringify({ id: "openclaw-code-agent", version: "5.0.1" }));
  writeFileSync(join(candidate, "npm-shrinkwrap.json"), "{}");
  const published = expectedPublishedPackage(source);
  const members = ["package.json", "openclaw.plugin.json", "npm-shrinkwrap.json", "dist/index.js", "dist/chunks/fixture.js"].map((name) => ({ name: "package/" + name, bytes: (name === "package.json" ? published : readFileSync(join(candidate, name))).toString("base64") }));
  writeArchive(tarball, members);
  const archive = readArchive(tarball), proof = packedCandidateProof(candidate, tarball, archive);
  const states = ["state-a", "state-b"].map((name) => join(fixture, name));
  const reports = states.map((state) => {
    const installed = join(state, "installed-candidate"); cpSync(candidate, installed, { recursive: true });
    writeFileSync(join(installed, "package.json"), published);
    return { plugin: { id: proof.id, enabled: true, status: "loaded", imported: false, version: proof.version,
      rootDir: installed, source: join(installed, "dist", "index.js") },
      install: { source: "archive", sourcePath: tarball, installPath: installed, version: proof.version } };
  });
  return { fixture, candidate, tarball, proof, archive, members, source, states, reports };
}

// Utility controls only. These tests provide no real-host/native acceptance receipt.
describe("issue 504 real-host acceptance controls", () => {
  it("proves cloned storage-key collision through actual SessionStore and independent Git fixtures survive reload", () => {
    const root = mkdtempSync(join(tmpdir(), "oca504-git-rows-"));
    writeFileSync(join(root, ".fixture-owner"), FIXTURE_MARKER);
    try {
      const repo = join(root, "repo"); mkdirSync(repo);
      const rows = [0, 1, 2].map((i) => gitFixtureRow(root, { repo, path: join(root, `worktree-${i}`), branch: `branch-${i}`, name: `alias-${i}` }));
      requireGitFixtureIdentities(rows, { sessionId: "native-id", harnessSessionId: "native-storage", backendRef: { conversationId: "native-thread" } });
      const indexPath = join(root, "sessions.json");
      const load = (items: typeof rows) => {
        writeFileSync(indexPath, JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, sessions: items, actionTokens: [], repoPolicies: [] }));
        return new SessionStore({ indexPath, env: {} });
      };
      const clones = rows.map((row) => ({ ...row, harnessSessionId: rows[0].harnessSessionId, backendRef: rows[0].backendRef }));
      const collided = load(clones);
      assert.equal(collided.getSessionGeneration({ kind: "oca", sessionId: clones[0].sessionId! }), undefined);
      assert.equal(collided.getSessionGeneration({ kind: "oca", sessionId: clones[1].sessionId! }), undefined);
      assert.equal(collided.getSessionGeneration({ kind: "oca", sessionId: clones[2].sessionId! })?.sessionId, clones[2].sessionId);
      for (let pass = 0; pass < 2; pass++) {
        const corrected = load(rows);
        for (const row of rows) {
          const exact = corrected.getSessionGeneration({ kind: "oca", sessionId: row.sessionId! });
          assert.ok(exact); assert.equal(corrected.getPersistedSession(row.name)?.sessionId, row.sessionId);
          assert.deepEqual([exact.workdir, exact.worktreePath, exact.worktreeBranch, exact.worktreeBaseBranch], [repo, row.worktreePath, row.worktreeBranch, "main"]);
          assert.equal(exact.runtimeOwner, undefined); assert.equal(exact.outputPath, undefined); assert.equal(exact.taskFlowMirror, undefined);
          assert.equal(exact.pendingPlanApproval, false); assert.equal(exact.approvalState, "not_required");
        }
      }
      assert.throws(() => requireGitFixtureIdentities(clones, {}));
      assert.throws(() => requireGitFixtureIdentities(rows, rows[0]));
      assert.throws(() => gitFixtureRow(root, { repo, path: join(root, "..", "foreign"), branch: "b", name: "bad" }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("records early public refusal and transport rejection before barrier failure without dispatching a second call", async () => {
    for (const call of [Promise.resolve({ content: [{ text: "Error: exact fixture refusal" }], isError: true }), Promise.reject(new Error("synthetic transport rejection"))]) {
      const events: Record<string, any>[] = [];
      const observed = observeGitCall(call, "alias", "first", "synthetic-selected", (value) => events.push(value));
      await observed.done;
      await assert.rejects(requireGitBarrier(observed, () => false, (value) => events.push(value), 100), /settled before/);
      assert.equal(events[0].phase, "git-public-outcome"); assert.equal(events[1].phase, "git-barrier-not-entered");
      assert.equal(events[1].publicOutcome, "SETTLED"); assert.equal(events.filter((event) => event.position === "second").length, 0);
      if (observed.error) assert.throws(() => gitCallResult(observed), /synthetic transport/);
      else assert.match(gitCallResult(observed).content[0].text, /exact fixture refusal/);
    }
  });

  it("retains pending deadline honesty and known release while preserving the original barrier failure", async () => {
    const events: Record<string, any>[] = []; let release!: () => void;
    const observed = observeGitCall(new Promise((done) => { release = () => done({ content: [{ text: "Merged fixture" }] }); }), "alias", "first", "synthetic-selected", (value) => events.push(value));
    let original: unknown;
    try { await requireGitBarrier(observed, () => false, (value) => events.push(value), 30); }
    catch (error) { original = error; }
    finally { release(); await observed.done; }
    assert.match(String(original), /within 30 ms/); assert.equal(events[0].publicOutcome, "PENDING_UNPROVEN");
    assert.equal(events[1].phase, "git-public-outcome"); assert.match(gitCallResult(observed).content[0].text, /Merged/);
  });

  it("actual advanced-base rebase enters the generated owned hook and completes only after release", async () => {
    const root = mkdtempSync(join(tmpdir(), "oca504-git-hook-"));
    writeFileSync(join(root, ".fixture-owner"), FIXTURE_MARKER);
    const repo = join(root, "repo"), path = join(root, "worktree"), entered = join(root, "entered"), release = join(root, "release");
    mkdirSync(repo); const env = fixtureEnv(root); let child: ReturnType<typeof spawn> | undefined;
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
      writeFileSync(join(repo, "base"), "base"); git(repo, "add", "base"); git(repo, "commit", "-m", "base");
      git(repo, "worktree", "add", "-b", "fixture-branch", path, "main");
      writeFileSync(join(path, "branch"), "branch"); git(path, "add", "branch"); git(path, "commit", "-m", "branch");
      writeFileSync(join(repo, "advanced"), "advanced"); git(repo, "add", "advanced"); git(repo, "commit", "-m", "advance");
      writeFileSync(join(repo, ".git", "hooks", "pre-rebase"), gitBarrierHook(path, entered, release), { mode: 0o700 });
      child = spawn("git", ["-C", path, "rebase", "main"], { env, detached: true, stdio: "ignore" }); trackOwnedChild(child);
      const done = new Promise<Record<string, any>>((resolve, reject) => { child!.once("error", reject); child!.once("close", (code) => code === 0 ? resolve({ content: [{ text: "Merged prerequisite rebase" }] }) : reject(new Error(`Fixture rebase exit ${code}`))); });
      const events: Record<string, any>[] = [], observed = observeGitCall(done, "alias", "first", "synthetic-selected", (value) => events.push(value));
      await requireGitBarrier(observed, () => { try { return readFileSync(entered, "utf8") === "entered"; } catch { return false; } }, (value) => events.push(value));
      assert.equal(observed.settled, false); writeFileSync(release, "release");
      await until(() => observed.settled ? true : undefined, "actual prerequisite rebase settlement"); await observed.done;
      assert.match(gitCallResult(observed).content[0].text, /Merged/); assert.equal(events[0].phase, "git-public-outcome");
      assert.equal(readFileSync(join(path, "advanced"), "utf8"), "advanced");
    } finally {
      writeFileSync(release, "release"); if (child) await stopOwnedChild(child);
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("validates fixed cohorts before setup and distinguishes partial coverage from complete one-floor coverage", () => {
    const provenance = ["--expected-sha", "a".repeat(40), "--codex-bin", "/fixture/native", "--codex-version", "0.159.3"];
    assert.equal(hostCohort(options(provenance)["--cohort"]), "all");
    for (const cohort of HOST_COHORTS) {
      assert.equal(options([...provenance, "--cohort", cohort])["--cohort"], cohort);
      assert.equal(runsHostCohort(cohort, "plan"), ["all", "plan"].includes(cohort));
      const requirements = requiredHostScenarios(cohort);
      const first = hostCohortCoverage(cohort, [{ scenario: requirements[0], status: "BLOCKED" }]);
      assert.equal(first.completedScenarios.length, 0); assert.deepEqual(first.remainingRequiredScenarios, requirements);
      for (const requirement of requirements) assert.ok(first.not_run.includes(requirement));
      if (cohort === "smoke") assert.ok(hostCohortCoverage(cohort, []).not_run.includes("setup-native-protocol-smoke"));
      const complete = hostCohortCoverage(cohort, requirements.map((scenario) => ({ scenario, status: "PASS" })));
      assert.deepEqual(complete.remainingRequiredScenarios, []); assert.equal(complete.finalAcceptance, false);
      assert.equal(complete.coverageScope, cohort === "all" ? "ONE_FLOOR_COMPLETE_HOST_MATRIX" : "PARTIAL");
      if (cohort !== "all") assert.ok(complete.not_run.length > 0); else assert.deepEqual(complete.not_run, []);
      for (const requirement of requirements) assert.ok(!complete.not_run.includes(requirement));
      assert.throws(() => hostCohortCoverage(cohort, [{ scenario: "unselected-credit", status: "PASS" }]));
      assert.throws(() => hostCohortCoverage(cohort, [{ scenario: requirements[0], status: "PASS" }, { scenario: requirements[0], status: "PASS" }]));
    }
    for (const invalid of ["", "ALL", "plan,git", "../plan", "undefined"]) assert.throws(() => options([...provenance, "--cohort", invalid]));
    assert.throws(() => options([...provenance, "--cohort"]));
    assert.throws(() => options([...provenance, "--cohort", "plan", "--cohort", "git"]));
  });

  it("replays immutable observed plan facts separately from source-derived normalization without historical backfill", () => {
    const threadId = "offline-fixture-thread", turnId = "offline-fixture-turn", relayPid = 10;
    const request = { direction: "request", method: "turn/start", id: 1, relayPid, threadId, collaborationMode: "plan", executionProfile: ":read-only", approvalPolicy: "never", requestedModelMatches: true };
    const ack = { direction: "response", id: 1, relayPid, turnId, error: false };
    const item = { direction: "response", method: "item/completed", relayPid, threadId, turnId, itemType: "plan", genuineNativePlanItem: true, textNonempty: true, textBytes: 65, textSha256: sha256(`${FIXTURE_PLAN}\n`) };
    const terminal = { direction: "response", method: "turn/completed", relayPid, threadId, turnId, status: "completed", error: false };
    const events = [request, ack, item, terminal];
    const observations = [{ output: { selectedReferenceMatches: true, live: true, status: "running", phase: "awaiting_plan_decision", exactPlanPresent: true }, listing: { selectedEntries: 1, selectedReferenceMatches: true, recovered: false, userPlanNextStep: true } }];
    const original = JSON.stringify({ events, observations });
    const replay = replayObservedPlan(events, observations);
    assert.equal(replay.label, "OFFLINE_SOURCE_DERIVED_REPLAY"); assert.equal(replay.historicalStatus, "BLOCKED");
    assert.equal(replay.historicalObservedNative.trimPlanSha256, null);
    assert.deepEqual(replay.matches, [{ historicalPredicate: false, sourceDerivedPredicate: true }]);
    assert.equal(JSON.stringify({ events, observations }), original);
    for (const changed of [{ ...item, textBytes: 64 }, { ...item, textSha256: sha256(FIXTURE_PLAN) }, { ...item, trimTextSha256: sha256(FIXTURE_PLAN), trimTextBytes: 64 }, { ...item, threadId: "other-thread" }, { ...item, turnId: "other-turn" }]) assert.throws(() => replayObservedPlan([request, ack, changed, terminal], observations));
    assert.throws(() => replayObservedPlan([request, ack, terminal], observations));
    assert.throws(() => replayObservedPlan(events, []));
    for (const output of [{ ...observations[0].output, exactPlanPresent: false }, { ...observations[0].output, selectedReferenceMatches: false }, { ...observations[0].output, phase: "terminal" }]) assert.throws(() => replayObservedPlan(events, [{ ...observations[0], output }]));
    assert.throws(() => replayObservedPlan(events, [{ ...observations[0], listing: { ...observations[0].listing, recovered: true } }]));
  });

  it("admits only entire selected-generation public resume guard templates", () => {
    const target = { sessionId: "selected", name: "fixture-selected", backendRef: { conversationId: "original-thread" } };
    const guard = (reason: string) => ({ isError: true, content: [{ type: "text", text: `Resume unavailable for session ${target.name} [${target.sessionId}] (missing_backend_state). Backend resume failed: ${reason} No resumable backend state is available. Launch a fresh session, or fork from prior context with agent_launch(resume_session_id='${target.sessionId}', fork_session=true, prompt='<new task>').` }] });
    const active = guard("Cannot resume backend thread original-thread: session selected still owns its active writer.");
    for (const result of [active, guard("Cannot reuse session ID selected: that session is still starting."), guard("Cannot reuse session ID selected: that session is still running.")]) assert.equal(repeatOutcome(result, target), "guard");
    for (const replacement of [["original-thread", "other-thread"], ["fixture-selected", "other-name"], ["session selected still", "session other still"], ["missing_backend_state", "completed"], ["active writer.", "active writer. extra"]]) {
      const result = structuredClone(active); result.content[0].text = result.content[0].text.replace(replacement[0], replacement[1]); assert.equal(repeatOutcome(result, target), "unknown");
    }
    for (const extra of ["\n", "\r\n", "\u2028"]) assert.equal(repeatOutcome({ ...active, content: [{ type: "text", text: active.content[0].text + extra }] }, target), "unknown");
    for (const result of [guard("Cannot reuse session ID selected: that session is still completed."), guard("arbitrary backend failure"), { ...active, details: { code: "other" } }, { ...active, details: { status: "success" } }, { isError: true, content: [{ type: "text", text: "Error sending response" }] }, { content: {} }, { content: [{ type: "text", text: 1 }] }, undefined]) assert.equal(repeatOutcome(result, target), "unknown");
    assert.equal(repeatOutcome({ content: [{ type: "text", text: "Resume started for session fixture-selected [selected]. Use agent_output to see the response." }] }, target), "success");
    const unconfirmed = { isError: true, content: [{ type: "text", text: "Delivery unconfirmed" }], details: { status: "error", code: "response_delivery_unconfirmed", targetSelected: true } };
    assert.equal(repeatOutcome(unconfirmed, target), "unconfirmed");
    const { targetSelected: _selected, ...withoutSelected } = unconfirmed.details;
    assert.equal(repeatOutcome({ ...unconfirmed, details: withoutSelected }, target), "unknown");
    for (const targetSelected of [undefined, false, "true", 1, null]) assert.equal(repeatOutcome({ ...unconfirmed, details: { ...unconfirmed.details, targetSelected } }, target), "unknown");
    assert.equal(repeatOutcome({ ...unconfirmed, details: { ...unconfirmed.details, operationStarted: false } }, target), "unknown");
  });

  it("settles both started public calls and retains outcomes before the first assertion", async () => {
    const target = { sessionId: "selected", name: "fixture", backendRef: { conversationId: "thread" } };
    const observations: any[] = []; let secondSettled = false;
    const settled = await settleRepeatCalls([async () => { throw new TypeError("transport fixture only"); }, async () => { await Promise.resolve(); secondSettled = true; return { content: [{ type: "text", text: "accepted" }] }; }], target, (record) => { assert.equal(secondSettled, true); observations.push(record); });
    assert.equal(observations.length, 2); assert.deepEqual(observations.map((item) => item.callIndex), [0, 1]);
    assert.equal(observations[0].outcomeClass, "transport-exception"); assert.equal(observations[0].exceptionTextSha256, sha256("transport fixture only")); assert.equal(observations[1].outcomeClass, "success");
    assert.match(observations[1].resultSha256, /^[a-f0-9]{64}$/); assert.match(observations[1].textSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => repeatOutcomeCounts(settled.map((item) => item.classification)), /Unknown/); assert.equal(observations.length, 2);
  });

  it("accounts success, unconfirmed and guards against all actual native attempts and accepted terminals", () => {
    const target = { backendRef: { conversationId: "thread" } }, message = "REPEAT-fixture";
    const input = (id: number, method = "turn/start") => ({ direction: "request", method, threadId: "thread", id, relayPid: 10, nativeInput: [{ sha256: sha256(message) }], expectedTurnId: "turn" });
    const ack = (id: number, turnId = "turn") => ({ direction: "response", id, relayPid: 10, turnId, error: false });
    const terminal = (turnId = "turn") => ({ method: "turn/completed", relayPid: 10, threadId: "thread", turnId, status: "completed", error: false });
    const one = [input(1), ack(1), terminal()];
    const guardCounts = repeatOutcomeCounts(["success", "guard"]), successCounts = repeatOutcomeCounts(["success", "success"]);
    assert.equal(repeatNativeObservation(one, target, message, guardCounts).ready, true);
    assert.equal(repeatNativeObservation(one, target, message, successCounts).ready, false);
    const resumed = [{ direction: "request", method: "thread/resume", id: 9, relayPid: 10, threadId: "thread" }, { direction: "response", id: 9, relayPid: 10, threadId: "thread", error: false }, ...one];
    const boundary = responseResumeBoundary({ sessionId: "selected", backendRef: target.backendRef, status: "completed", lifecycle: "terminal", runtimeState: "stopped" }, { sessionId: "selected", backendRef: target.backendRef }, 0);
    requireResponseResume(resumed, boundary, "thread"); assert.throws(() => requireResponseResume(one, boundary, "thread"));
    const two = [...one, input(2, "turn/steer"), ack(2)];
    assert.equal(repeatNativeObservation(two, target, message, successCounts).ready, true, "Accepted steer may share one terminal turn");
    assert.equal(repeatNativeObservation([...one, input(2), ack(2, "turn2")], target, message, successCounts).ready, false);
    assert.equal(repeatNativeObservation([...one, input(2), ack(2, "turn2"), terminal("turn2")], target, message, successCounts).ready, true);
    const rejected = { direction: "response", id: 2, relayPid: 10, error: true, errorCode: -32600, errorDataPresent: false, noActiveTurn: true };
    const queued = [input(2, "turn/steer"), rejected, ...one, input(3), ack(3, "turn3"), terminal("turn3")];
    assert.equal(repeatNativeObservation(queued, target, message, successCounts).ready, true);
    assert.equal(repeatNativeObservation(queued, target, message, successCounts).rejected.length, 1);
    const ambiguous = [...one, input(2, "turn/steer"), { ...rejected, errorCode: -32000 }];
    assert.equal(repeatNativeObservation(ambiguous, target, message, successCounts).ready, false);
    assert.equal(repeatNativeObservation(ambiguous, target, message, repeatOutcomeCounts(["success", "unconfirmed"])).ready, true);
    const unconfirmedCounts = repeatOutcomeCounts(["success", "unconfirmed"]);
    assert.equal(repeatNativeObservation([...ambiguous, input(3)], target, message, unconfirmedCounts).ready, false, "One public unconfirmed cannot account for two unresolved inputs");
    assert.equal(repeatNativeObservation([...ambiguous, input(3, "turn/steer"), ack(3, "other-turn")], target, message, unconfirmedCounts).ready, false, "One public unconfirmed cannot account for two unknown acceptances");
    for (const events of [[], [input(1)], [input(1), ack(1)], [input(1), ack(1), { ...terminal(), relayPid: 20 }]]) assert.equal(repeatNativeObservation(events, target, message, guardCounts).ready, false);
    for (const events of [[{ ...input(1), threadId: "other" }, ack(1), terminal()], [{ ...input(1), nativeInput: [{ sha256: sha256("other") }] }, ack(1), terminal()]]) assert.throws(() => repeatNativeObservation(events, target, message, guardCounts));
    assert.throws(() => repeatOutcomeCounts(["success"])); assert.throws(() => repeatOutcomeCounts(["success", "transport-exception"]));
    selectedProvider([{ requestClass: "native-generation", fixtureGeneration: "selected", latestInputHash: sha256(message), fixtureOutputMarkers: ["OCA504_BACKEND_OK:selected:"] }], "selected", message);
    for (const request of [{ requestClass: "unknown" }, { requestClass: "native-generation", fixtureGeneration: "other", latestInputHash: sha256(message), fixtureOutputMarkers: ["OCA504_BACKEND_OK:other:"] }]) assert.throws(() => selectedProvider([request], "selected", message));
  });

  it("uses the actual message subscription seam and refuses invalid acknowledgements before follow-ons", async () => {
    const counts = { requests: 0, inspection: 0, tool: 0, chat: 0, native: 0 };
    const ack = { subscribed: true, key: "agent:main:main", agentId: "main" };
    const proceed = async (value: unknown, rejects = false) => {
      const result = await subscribeFixtureMessages(async (method, params) => {
        counts.requests++; assert.equal(method, "sessions.messages.subscribe"); assert.deepEqual(params, { key: "agent:main:main" });
        if (rejects) throw new Error("Synthetic SDK subscription rejection"); return value;
      }, "fixture-connection-a");
      counts.inspection++; counts.tool++; counts.chat++; counts.native++; return result;
    };
    assert.equal((await proceed(ack)).localConnectionCorrelation, "fixture-connection-a");
    for (const invalid of [null, [], {}, { ...ack, subscribed: false }, { ...ack, subscribed: "true" }, { ...ack, key: "other-session" }, { ...ack, agentId: "other-owner" }, { subscribed: true, key: ack.key }]) await assert.rejects(proceed(invalid));
    await assert.rejects(proceed(ack, true), /Synthetic SDK subscription rejection/);
    assert.deepEqual(counts, { requests: 10, inspection: 1, tool: 1, chat: 1, native: 1 });
  });

  it("matches only fresh actual projected terminal events from the acknowledged connection/session/run without raw routes", async () => {
    const subscription = await subscribeFixtureMessages(async () => ({ subscribed: true, key: "agent:main:main", agentId: "main" }), "fixture-connection-a");
    const project = (event: string, payload: Record<string, unknown>, connection = "fixture-connection-a") => projectFixtureHostEvent(event, payload, connection, subscription);
    const terminal = { sessionKey: "agent:main:main", runId: "fresh-run", state: "final" };
    const chat = project("chat", terminal), lifecycle = project("agent", { sessionKey: terminal.sessionKey, runId: terminal.runId, stream: "lifecycle", data: { phase: "end" } });
    for (const event of [chat, lifecycle]) assert.equal(hasFreshSubscribedTerminal([event], 0, subscription, "fresh-run"), true);
    assert.equal(hasFreshSubscribedTerminal([chat], 1, subscription, "fresh-run"), false);
    for (const event of [project("chat", { ...terminal, sessionKey: "another-session" }), project("chat", { runId: "fresh-run", state: "final" }),
      project("chat", terminal, "fixture-connection-b"), project("chat", { ...terminal, runId: "stale-run" }), project("sessions.changed", terminal),
      project("chat", { ...terminal, state: "delta" }), project("chat", { ...terminal, state: "error" }), project("chat", { ...terminal, state: "aborted" }),
      project("agent", { ...terminal, stream: "lifecycle", data: { phase: "error" } }),
      project("agent", { ...terminal, state: "error", stream: "lifecycle", data: { phase: "end" } }),
      project("agent", { ...terminal, stream: "lifecycle", data: { phase: "end", isError: true } })]) {
      assert.equal(hasFreshSubscribedTerminal([event], 0, subscription, "fresh-run"), false);
    }
    assert.ok(!JSON.stringify(chat).includes("sessionKey")); assert.ok(!JSON.stringify(chat).includes("agent:main:main"));
    assert.equal(hasFreshSubscribedTerminal([projectFixtureHostEvent("chat", terminal, "fixture-connection-a")], 0, subscription, "fresh-run"), false);
  });

  it("admits unchanged reader proof then freshly refuses a later replaced archive before any installer or follow-on", async () => {
    const s = syntheticPackedInstall(); const original = readFileSync(s.tarball);
    const counts = { install: 0, enable: 0, inspect: 0, gateway: 0 };
    try {
      const admission = await preparePackedInstaller(s.candidate, s.fixture, s.tarball,
        () => command("/usr/bin/python3", ["-I", archiveReader, s.tarball], { cwd: s.fixture, env: fixtureEnv(s.fixture), timeoutMs: 30_000 }),
        async (path) => { assert.equal(path, s.tarball); counts.install++; });
      const startState = async () => { await admission.install(); counts.enable++; counts.inspect++; counts.gateway++; };
      await startState(); assert.deepEqual(counts, { install: 1, enable: 1, inspect: 1, gateway: 1 });
      writeFileSync(s.tarball, Buffer.concat([original, Buffer.from("altered")]));
      await assert.rejects(startState(), /Archive admission hash differs/);
      assert.deepEqual(counts, { install: 1, enable: 1, inspect: 1, gateway: 1 });
      writeFileSync(s.tarball, original); await startState();
      assert.deepEqual(counts, { install: 2, enable: 2, inspect: 2, gateway: 2 });
      rmSync(s.tarball); symlinkSync(join(s.candidate, "package.json"), s.tarball);
      await assert.rejects(startState(), /cannot redirect/); rmSync(s.tarball);
      mkdirSync(s.tarball); await assert.rejects(startState(), /bounded owned regular/); rmSync(s.tarball, { recursive: true });
      writeFileSync(s.tarball, original); truncateSync(s.tarball, 33_554_433);
      await assert.rejects(startState(), /bounded owned regular/);
      assert.deepEqual(counts, { install: 2, enable: 2, inspect: 2, gateway: 2 });
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("promptly refuses an actual no-writer FIFO in the same install seam; supervision timeout is failure", async () => {
    const s = syntheticPackedInstall(); const original = readFileSync(s.tarball);
    try {
      const helper = join(process.cwd(), "scripts/e2e/oca-issue-504-host-fixtures.ts");
      const script = `import { preparePackedInstaller, command, fixtureEnv } from ${JSON.stringify("file://" + helper)};
        import { rmSync } from 'node:fs'; import { execFileSync } from 'node:child_process';
        const [candidate, fixture, tarball, reader] = process.argv.slice(1);
        const counts = { install: 0, enable: 0, inspect: 0, gateway: 0 };
        const admitted = await preparePackedInstaller(candidate, fixture, tarball,
          () => command('/usr/bin/python3', ['-I', reader, tarball], { cwd: fixture, env: fixtureEnv(fixture), timeoutMs: 30000 }),
          async () => { counts.install++; });
        rmSync(tarball); execFileSync('/usr/bin/mkfifo', [tarball]);
        let refused = false;
        try { await admitted.install(); counts.enable++; counts.inspect++; counts.gateway++; }
        catch (error) { if (!/bounded owned regular file/.test(error.message)) throw error; refused = true; }
        if (!refused) throw new Error('FIFO was incorrectly admitted');
        console.log(JSON.stringify({ refused, counts }));`;
      // A blocking open is a real supervised child timeout and fails this assertion.
      const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, s.candidate, s.fixture, s.tarball, archiveReader],
        { cwd: process.cwd(), encoding: "utf8", timeout: 5_000, maxBuffer: 65_536, stdio: ["ignore", "pipe", "pipe"] });
      assert.deepEqual(JSON.parse(output), { refused: true, counts: { install: 0, enable: 0, inspect: 0, gateway: 0 } });
      rmSync(s.tarball); writeFileSync(s.tarball, original);
      let restoredInstalls = 0;
      const restored = await preparePackedInstaller(s.candidate, s.fixture, s.tarball, async () => JSON.stringify(readArchive(s.tarball)), async () => { restoredInstalls++; });
      await restored.install(); assert.equal(restoredInstalls, 1);
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("refuses actual malformed-reader, child timeout and output overflow before installer and follow-on dispatch", async () => {
    const s = syntheticPackedInstall();
    const counts = { install: 0, enable: 0, inspect: 0, gateway: 0 };
    const run = async (read: () => Promise<string>) => {
      const admitted = await preparePackedInstaller(s.candidate, s.fixture, s.tarball, read, async () => { counts.install++; });
      await admitted.install(); counts.enable++; counts.inspect++; counts.gateway++;
    };
    try {
      writeFileSync(s.tarball, "not a gzip archive");
      await assert.rejects(run(() => command("/usr/bin/python3", ["-I", archiveReader, s.tarball], { cwd: s.fixture, env: fixtureEnv(s.fixture), timeoutMs: 30_000 })), /failed/);
      await assert.rejects(run(() => command(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { cwd: s.fixture, env: fixtureEnv(s.fixture), timeoutMs: 100 })), /deadline/);
      await assert.rejects(run(() => command(process.execPath, ["-e", "process.stdout.write('x'.repeat(1048577))"], { cwd: s.fixture, env: fixtureEnv(s.fixture), timeoutMs: 5_000 })), /output-cap/);
      assert.deepEqual(counts, { install: 0, enable: 0, inspect: 0, gateway: 0 });
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("accepts current public install metadata without config installs, while requiring import for runtime inspection", () => {
    const s = syntheticPackedInstall();
    try {
      assert.equal(freshPluginBootstrap({ file: join(s.fixture, "fixture.log") }, 12_345).plugins, undefined);
      assert.notEqual(s.proof.sourcePackageSha256, s.proof.manifestHashes["package.json"]);
      assert.equal(s.proof.expectedPublicationSha256, s.proof.manifestHashes["package.json"]);
      const result = verifyPackedPluginInspection(s.reports[0], s.fixture, s.states[0], s.tarball, s.proof);
      assert.equal(result.installedPath, s.reports[0].install.installPath); assert.equal(result.imported, false);
      assert.throws(() => verifyPackedPluginInspection(s.reports[0], s.fixture, s.states[0], s.tarball, s.proof, true));
      assert.equal(verifyPackedPluginInspection({ ...s.reports[0], plugin: { ...s.reports[0].plugin, imported: true } }, s.fixture, s.states[0], s.tarball, s.proof, true).imported, true);
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("refuses missing or ambiguous records and wrong public identity, enabled status, source and version", () => {
    const s = syntheticPackedInstall();
    try {
      const valid = s.reports[0];
      const bad: unknown[] = [null, [], {}, { plugin: valid.plugin }, { plugin: valid.plugin, install: [] }];
      for (const patch of [{ id: "other" }, { enabled: false }, { status: "disabled" }, { status: "error" }, { error: "failure" }, { version: "wrong" }, { packageName: "other" }, { packageName: null }, { packageName: 1 }, { packageVersion: "wrong" }, { packageVersion: null }, { packageVersion: 1 }]) bad.push({ ...valid, plugin: { ...valid.plugin, ...patch } });
      for (const patch of [{ source: "path" }, { version: "wrong" }, { sourcePath: "relative.tgz" }, { installPath: "relative-root" }, { resolvedName: "other" }, { resolvedVersion: "wrong" }]) bad.push({ ...valid, install: { ...valid.install, ...patch } });
      for (const report of bad) assert.throws(() => verifyPackedPluginInspection(report, s.fixture, s.states[0], s.tarball, s.proof));
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("requires each selected state to supply its own successful packed install and inspect provenance", () => {
    const s = syntheticPackedInstall();
    try {
      for (let i = 0; i < 2; i++) assert.equal(verifyPackedPluginInspection(s.reports[i], s.fixture, s.states[i], s.tarball, s.proof).installedPath, s.reports[i].install.installPath);
      assert.throws(() => verifyPackedPluginInspection(s.reports[0], s.fixture, s.states[1], s.tarball, s.proof));
      assert.throws(() => verifyPackedPluginInspection(s.reports[1], s.fixture, s.states[0], s.tarball, s.proof));
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("refuses another archive, workspace/root/entrypoint switches and redirected candidate code", () => {
    const s = syntheticPackedInstall();
    try {
      const valid = s.reports[0], other = join(s.fixture, "other.tgz"); writeFileSync(other, "other archive");
      for (const report of [
        { ...valid, install: { ...valid.install, sourcePath: other } },
        { ...valid, plugin: { ...valid.plugin, rootDir: s.reports[1].plugin.rootDir } },
        { ...valid, plugin: { ...valid.plugin, source: join(s.candidate, "dist", "index.js") } },
        { ...valid, plugin: { ...valid.plugin, source: join(valid.plugin.rootDir, "dist", "chunks", "fixture.js") } },
      ]) assert.throws(() => verifyPackedPluginInspection(report, s.fixture, s.states[0], s.tarball, s.proof));
      const entrypoint = valid.plugin.source; rmSync(entrypoint); symlinkSync(join(s.candidate, "dist", "index.js"), entrypoint);
      assert.throws(() => verifyPackedPluginInspection(valid, s.fixture, s.states[0], s.tarball, s.proof));
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("rejects changed or missing/extra packed chunks, changed manifests and altered original tarball", () => {
    const s = syntheticPackedInstall();
    try {
      const valid = s.reports[0], dist = join(valid.plugin.rootDir, "dist"), chunk = join(dist, "chunks", "fixture.js");
      const check = () => verifyPackedPluginInspection(valid, s.fixture, s.states[0], s.tarball, s.proof);
      const installedPackage = join(valid.plugin.rootDir, "package.json"), originalPackage = readFileSync(installedPackage);
      const parsedPackage = JSON.parse(originalPackage.toString());
      for (const mutation of [{ ...parsedPackage, name: "other-installed-package" }, { ...parsedPackage, version: "other-installed-version" }]) {
        writeFileSync(installedPackage, JSON.stringify(mutation));
        assert.throws(check, /Installed candidate manifest differs from packed source/);
        writeFileSync(installedPackage, originalPackage); assert.doesNotThrow(check);
      }
      writeFileSync(installedPackage, Buffer.concat([originalPackage, Buffer.from("\n")]));
      assert.deepEqual(JSON.parse(readFileSync(installedPackage, "utf8")), parsedPackage);
      assert.throws(check, /Installed candidate manifest differs from packed source/);
      writeFileSync(installedPackage, originalPackage); assert.doesNotThrow(check);
      writeFileSync(chunk, "changed chunk"); assert.throws(check);
      writeFileSync(chunk, "synthetic chunk NEVER executed"); writeFileSync(join(dist, "extra.js"), "unexpected"); assert.throws(check);
      rmSync(join(dist, "extra.js")); rmSync(chunk); assert.throws(check);
      writeFileSync(chunk, "synthetic chunk NEVER executed"); writeFileSync(join(valid.plugin.rootDir, "npm-shrinkwrap.json"), "changed manifest"); assert.throws(check);
      writeFileSync(join(valid.plugin.rootDir, "npm-shrinkwrap.json"), "{}"); writeFileSync(s.tarball, "changed original archive"); assert.throws(check);
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("starts each install state with fresh local logging and port, without previous plugin paths or auth", () => {
    const config = freshPluginBootstrap({ file: "/synthetic-owned/log" }, 12_345);
    assert.deepEqual(Object.keys(config).sort(), ["gateway", "logging"]);
    assert.deepEqual(config.gateway, { mode: "local", bind: "loopback", port: 12_345 });
    assert.equal(config.plugins, undefined); assert.equal(config.gateway!.auth, undefined);
    assert.throws(() => freshPluginBootstrap({ file: "/synthetic-owned/log" }, 0));
    assert.throws(() => freshPluginBootstrap({ file: "/synthetic-owned/log" }, 65_536));
  });

  it("rejects unreviewed packed identity, dependency, compatibility, entrypoint, scripts and bytes transforms", () => {
    const s = syntheticPackedInstall();
    try {
      const original = JSON.parse(Buffer.from(s.members[0].bytes, "base64").toString());
      const mutations = [{ ...original, name: "other" }, { ...original, version: "other" }, { ...original, dependencies: { "inert-fixture": "9.9.9" } }, { ...original, openclaw: { ...original.openclaw, minHostVersion: "other" } }, { ...original, openclaw: { ...original.openclaw, extensions: ["./dist/other.js"] } }, { ...original, scripts: { ...original.scripts, prepack: "unreviewed" } }];
      for (const mutation of mutations) {
        writeArchive(s.tarball, [{ ...s.members[0], bytes: Buffer.from(JSON.stringify(mutation, null, 2)).toString("base64") }, ...s.members.slice(1)]);
        assert.throws(() => packedCandidateProof(s.candidate, s.tarball, readArchive(s.tarball)), /Actual packed package differs/);
      }
      writeArchive(s.tarball, [{ ...s.members[0], bytes: Buffer.concat([Buffer.from(s.members[0].bytes, "base64"), Buffer.from("\n")]).toString("base64") }, ...s.members.slice(1)]);
      assert.throws(() => packedCandidateProof(s.candidate, s.tarball, readArchive(s.tarball)), /Actual packed package differs/);
      for (const source of [{ ...s.source, publishConfig: { directory: "other" } }, { ...s.source, scripts: { ...s.source.scripts, beforePacking: "other" } }, { ...s.source, dependencies: { fixture: "workspace:*" } }]) assert.throws(() => expectedPublishedPackage(source));
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("rejects missing, changed and extra actual packed chunks or source manifests", () => {
    const s = syntheticPackedInstall();
    try {
      for (const members of [s.members.slice(0, -1), [...s.members.slice(0, -1), { ...s.members.at(-1)!, bytes: Buffer.from("other").toString("base64") }], [...s.members, { name: "package/dist/extra.js", bytes: Buffer.from("other").toString("base64") }], s.members.map((member) => member.name.endsWith("npm-shrinkwrap.json") ? { ...member, bytes: Buffer.from("other").toString("base64") } : member)]) {
        writeArchive(s.tarball, members); assert.throws(() => packedCandidateProof(s.candidate, s.tarball, readArchive(s.tarball)));
      }
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("fails closed on missing, duplicate, traversing, linked, oversized, truncated and corrupt archive members", () => {
    const s = syntheticPackedInstall();
    try {
      for (const members of [s.members.slice(1), [...s.members, s.members[0]], [...s.members, { name: "package/../escape", bytes: "" }], [...s.members, { name: "package/link", kind: "link" }], s.members.map((member) => member.name.endsWith("package.json") ? { ...member, bytes: Buffer.alloc(1_048_577).toString("base64") } : member)]) {
        writeArchive(s.tarball, members); assert.throws(() => readArchive(s.tarball));
      }
      writeArchive(s.tarball, s.members); const valid = readFileSync(s.tarball);
      writeFileSync(s.tarball, valid.subarray(0, valid.length - 6)); assert.throws(() => readArchive(s.tarball));
      const corrupt = Buffer.from(valid); corrupt[corrupt.length - 8] ^= 255; writeFileSync(s.tarball, corrupt); assert.throws(() => readArchive(s.tarball));
      writeFileSync(s.tarball, "not gzip"); assert.throws(() => readArchive(s.tarball));
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("requires exact candidate identity, clean tracked source and complete options", () => {
    const head = "a".repeat(40);
    requireCandidate(`${head}\n`, head, "");
    assert.throws(() => requireCandidate(head, "b".repeat(40), ""));
    assert.throws(() => requireCandidate(head, head, " M src/session.ts"));
    assert.throws(() => options(["--expected-sha", head]));
    assert.throws(() => options(["--expected-sha", head, "--codex-bin", "/fixture", "--codex-version", "0.159.3", "--unknown", "x"]));
  });

  it("rejects a script or substituted native ELF before execution", () => {
    assert.throws(() => validateNativeExecutable(Buffer.from("#!/bin/sh\necho codex-cli 0.159.3\n"), "0.159.3"), /ELF/);
    const forged = Buffer.alloc(64); Buffer.from("7f454c46", "hex").copy(forged); forged[4] = 2; forged[5] = 1; forged.writeUInt16LE(62, 18);
    assert.throws(() => validateNativeExecutable(forged, "0.159.3"), /official archive member/);
    assert.throws(() => validateNativeExecutable(forged, "0.159.4"), /reviewed native version/);
  });

  it("rejects markerless roots, lexical escapes and symlink escapes", () => {
    const root = mkdtempSync(join(tmpdir(), "oca504-controls-"));
    const foreign = mkdtempSync(join(tmpdir(), "oca504-control-foreign-"));
    try {
      assert.throws(() => ownedPath(root, join(root, "file")));
      writeFileSync(join(root, ".fixture-owner"), FIXTURE_MARKER);
      assert.equal(ownedPath(root, join(root, "nested", "file")), join(root, "nested", "file"));
      assert.throws(() => ownedPath(root, join(root, "..", "escape")));
      symlinkSync(foreign, join(root, "redirect"));
      assert.throws(() => ownedPath(root, join(root, "redirect", "file")));
      const env = fixtureEnv(root, { PATH: "/fixture/bin", OPENAI_API_KEY: "must-not-inherit", CODEX_HOME: "/foreign", OPENCLAW_GATEWAY_TOKEN: "must-not-inherit", HTTPS_PROXY: "must-not-inherit" });
      assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.OPENCLAW_GATEWAY_TOKEN, undefined); assert.equal(env.HTTPS_PROXY, undefined);
      assert.equal(env.NPM_CONFIG_USERCONFIG, join(root, "npm-user.conf")); assert.equal(env.NPM_CONFIG_GLOBALCONFIG, join(root, "npm-global.conf"));
      assert.equal(env.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org/");
      assert.equal(env.CODEX_HOME, join(root, "codex")); assert.equal(env.HOME, join(root, "home"));
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(foreign, { recursive: true, force: true }); }
  });

  it("attempts every cleanup after earlier failures and rejects PID reuse evidence", async () => {
    const attempted: string[] = [];
    await assert.rejects(cleanupAll([
      () => { attempted.push("client"); throw new Error("client failed"); },
      () => { attempted.push("native"); },
      () => { attempted.push("gateway"); throw new Error("gateway failed"); },
      () => { attempted.push("provider"); },
    ]), (error: AggregateError) => error.errors.length === 2);
    assert.deepEqual(attempted, ["client", "native", "gateway", "provider"]);
    const own = processIdentity(process.pid)!; assert.ok(own); assert.equal(sameProcess(own), true);
    assert.equal(sameProcess({ ...own, startTicks: "not-the-same-process" }), false);
    assert.equal(sameProcess({ ...own, executable: "/different-exec", group: -1 }), true, "Exec/group changes do not terminate owned kernel lifetime");
  });

  it("stops a captured detached root and its actual descendant without group guessing", async () => {
    const child = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{},stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);`], { env: {}, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    trackOwnedChild(child);
    let output = "", descendant: number;
    child.stdout.on("data", (chunk) => { output += chunk; });
    try { descendant = Number(await until(() => /^\d+\n$/.test(output) ? output.trim() : undefined, "control descendant receipt", 5_000)); assert.ok(processIdentity(descendant)); }
    finally { await stopOwnedChild(child); }
    assert.equal(processIdentity(descendant), undefined);
    assert.equal(processIdentity(child.pid!), undefined);
  });

  it("treats an exited zombie as unsignalable without dropping lifetime checks", () => {
    const fields = Array<string>(20).fill("0"); fields[0] = "S"; fields[19] = "captured";
    assert.equal(sameProcessFields(fields, "captured"), true);
    fields[0] = "Z"; assert.equal(sameProcessFields(fields, "captured"), false);
    fields[0] = "S"; assert.equal(sameProcessFields(fields, "reused"), false);
  });

  it("retains a failed ownership check while still stopping another proven child", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: {}, detached: true, stdio: "ignore" });
    trackOwnedChild(child);
    const ended = new Promise<void>((done) => child.once("close", () => done()));
    const readFailure = Object.assign(new Error("synthetic ownership read failed"), { code: "EACCES" });
    const unproved = { ...processIdentity(process.pid)! };
    // Failure precedes the live identity comparison, so this PID must never be signaled.
    Object.defineProperty(unproved, "startTicks", { get() { throw readFailure; } });
    try {
      const proven = await until(() => processIdentity(child.pid!), "control owned root", 5_000);
      await assert.rejects(stopNativeProcesses(new Map([[proven.pid, proven], [unproved.pid, unproved]])),
        (error: AggregateError) => error.errors.includes(readFailure));
      await ended;
      assert.equal(processIdentity(child.pid!), undefined);
      assert.ok(processIdentity(process.pid), "Unproved PID remains untouched");
    } finally { await stopOwnedChild(child); }
  });

  it("projects actual native plan metadata without raw plan, instructions, paths or synthesized absent posture", () => {
    const frame = { method: "turn/start", params: { collaborationMode: { mode: "plan", settings: { model: "gpt-6.1-sol", developer_instructions: "PRIVATE-INSTRUCTIONS" } }, model: "gpt-6.1-sol", permissions: ":read-only", approvalPolicy: "never" } };
    const projection = projectNativePlanFrame(frame, sha256);
    assert.equal(projection.collaborationMode, "plan"); assert.equal(projection.executionProfile, ":read-only"); assert.equal(projection.approvalPolicy, "never"); assert.equal(projection.requestedModelMatches, true);
    assert.equal(projectNativePlanFrame({}, sha256).collaborationMode, "absent");
    assert.equal(projectNativePlanFrame({ params: { permissions: "PRIVATE-PATH", collaborationMode: { mode: "unexpected" } } }, sha256).executionProfile, "other");
    const text = "<proposed_plan>PRIVATE-PLAN</proposed_plan>";
    const item = projectNativePlanFrame({ method: "item/completed", params: { item: { type: "plan", text, phase: "final_answer" } } }, sha256);
    assert.equal(item.genuineNativePlanItem, true); assert.equal(item.textNonempty, true); assert.equal(item.textBytes, Buffer.byteLength(text)); assert.equal(item.textSha256, sha256(text));
    assert.equal(item.proposedPlanOpen, true); assert.equal(item.proposedPlanClose, true);
    for (const raw of [`${FIXTURE_PLAN}\n`, FIXTURE_PLAN]) {
      const actual = projectNativePlanFrame({ method: "item/completed", params: { item: { type: "plan", text: raw } } }, sha256);
      assert.equal(actual.textBytes, Buffer.byteLength(raw)); assert.equal(actual.textSha256, sha256(raw));
      assert.equal(actual.trimTextBytes, 64); assert.equal(actual.trimTextSha256, "ddfaeef6b7cbae51d4e8bf8c9333fcf9c7861b9b2ba6d5ab1a25bf3dbf4ea5b2");
      assert.doesNotMatch(JSON.stringify(actual), /Disposable fixture plan/);
    }
    const absent = projectNativePlanFrame({}, sha256); assert.equal(absent.trimTextBytes, null); assert.equal(absent.trimTextSha256, null);
    assert.doesNotMatch(JSON.stringify([projection, item]), /PRIVATE-|developer_instructions|"text":/);
  });

  it("requires a fresh exact native plan turn while retaining recovery-only row diagnostics", () => {
    const target = { sessionId: "plan-a", backendRef: { conversationId: "thread-a" } };
    const row = { ...target, status: "running", lifecycle: "awaiting_plan_decision", runtimeState: "live", currentPermissionMode: "plan", planApproval: "ask", pendingPlanApproval: true, planModeApproved: false, approvalState: "pending", planDecisionVersion: 1, actionablePlanDecisionVersion: 1 };
    const request = { direction: "request", method: "turn/start", id: 1, relayPid: 10, threadId: "thread-a", ...projectNativePlanFrame({ params: { collaborationMode: { mode: "plan", settings: { model: "gpt-6.1-sol" } }, model: "gpt-6.1-sol", permissions: ":read-only", approvalPolicy: "never" } }, sha256) };
    const ack = { direction: "response", id: 1, relayPid: 10, turnId: "turn-a" };
    const item = { direction: "response", relayPid: 10, method: "item/completed", threadId: "thread-a", turnId: "turn-a", ...projectNativePlanFrame({ params: { item: { type: "plan", text: "Actual synthetic native plan" } } }, sha256) };
    const terminal = { direction: "response", relayPid: 10, method: "turn/completed", threadId: "thread-a", turnId: "turn-a", status: "completed" };
    const events = [request, ack, item, terminal]; assert.equal(hasNativePlanBoundary(events, 0, target), true);
    assert.equal(hasNativePlanBoundary(events, events.length, target), false);
    for (const wrong of [{ ...request, collaborationMode: "absent" }, { ...request, collaborationMode: "default" }, { ...request, executionProfile: ":workspace" }, { ...request, approvalPolicy: "on-request" }, { ...request, requestedModelMatches: false }, { ...request, threadId: "other" }]) assert.equal(hasNativePlanBoundary([wrong, ack, item, terminal], 0, target), false);
    for (const wrong of [{ ...item, itemType: "agentMessage" }, { ...item, textNonempty: false, textBytes: 0 }, { ...item, threadId: "other" }, { ...item, turnId: "old" }, { ...item, direction: "request" }]) assert.equal(hasNativePlanBoundary([request, ack, wrong, terminal], 0, target), false);
    const facts = planRowObservation(row, target); assert.equal(facts.selectedIdMatches, true); assert.doesNotMatch(JSON.stringify(facts), /plan-a|thread-a/);
    for (const state of ["not_required", "pending", "approved", "changes_requested", "rejected"]) {
      const observed = { ...row, approvalState: state };
      assert.equal(planRowObservation(observed, target).approvalState, state);
      assert.equal(hasNativePlanBoundary(events, 0, target), true, "Recovery approval state cannot veto a genuine native boundary");
    }
    for (const mode of ["default", "plan", "bypassPermissions"]) {
      const observed = { ...row, currentPermissionMode: mode };
      assert.equal(planRowObservation(observed, target).currentPermissionMode, mode);
      assert.equal(hasNativePlanBoundary(events, 0, target), true, "Recovery permission state is observation only");
    }
    for (const unknown of [{ ...row, approvalState: "none" }, { ...row, currentPermissionMode: "acceptEdits" }]) {
      assert.equal(hasNativePlanBoundary(events, 0, target), true);
    }
    assert.equal(planRowObservation({ ...row, approvalState: "none" }, target).approvalState, "UNPROVEN");
    assert.equal(planRowObservation({ ...row, currentPermissionMode: "acceptEdits" }, target).currentPermissionMode, "UNPROVEN");
  });

  it("joins owning live output/listing and exact user-only refusal despite a stale recovery row, retaining report custody", async () => {
    const id = `hp3-${randomUUID()}`, target = { sessionId: id, name: "ask-plan", backendRef: { conversationId: "thread-hp3" } };
    const counters = { backend: 0, git: 0, approval: 0 };
    const forbidden = (kind: keyof typeof counters) => () => { counters[kind]++; throw new Error("Fixture side effect forbidden"); };
    const live = { id, name: target.name, status: "running", _status: "running", phase: "awaiting_plan_decision", lifecycle: "awaiting_plan_decision", duration: 1, costUsd: 0, startedAt: Date.now(), completedAt: Date.now(), prompt: "fixture", workdir: "/isolated/fixture", multiTurn: true,
      originSessionKey: "fixture-owner", pendingPlanApproval: true, planApproval: "ask", planModeApproved: false, approvalState: "pending", currentPermissionMode: "plan", planDecisionVersion: 1, actionablePlanDecisionVersion: 1,
      latestPlanArtifact: { markdown: FIXTURE_PLAN }, latestPlanArtifactVersion: 1, getOutput: () => [] as string[],
      noteOutcomeSeen: function (reader: string): boolean { return Session.prototype.noteOutcomeSeen.call(this as unknown as Session, reader); },
      sendMessage: forbidden("backend"), interrupt: forbidden("backend"), approvePlan: forbidden("approval"), outcomeSeenAt: undefined as number | undefined };
    const stale = { ...target, status: "running", lifecycle: "active", pendingPlanApproval: false, approvalState: "not_required", planDecisionVersion: 0, actionablePlanDecisionVersion: 0, prompt: "fixture", workdir: "/isolated/fixture", createdAt: Date.now() };
    const sm = { resolve: (ref: string) => ref === id ? live : undefined, list: () => [live], listPersistedSessions: () => [stale], getPersistedSession: () => stale,
      launchAndAwaitRunning: forbidden("backend"), notifySession: forbidden("approval"), updatePersistedSession: forbidden("git") } as unknown as SessionManager;
    const tool = (text: string) => ({ isError: false, content: [{ type: "text", text }] });
    const output = tool(getSessionOutputText(sm, id, { full: true, readerSessionKey: "fixture-owner" }));
    const listing = tool(getSessionsListingText(sm, "waiting", undefined, { full: true }));
    const request = { direction: "request", method: "turn/start", id: 1, relayPid: 10, threadId: "thread-hp3", collaborationMode: "plan", executionProfile: ":read-only", approvalPolicy: "never", requestedModelMatches: true };
    const ack = { direction: "response", id: 1, relayPid: 10, turnId: "turn-hp3", error: false };
    const item = { direction: "response", relayPid: 10, method: "item/completed", threadId: "thread-hp3", turnId: "turn-hp3", ...projectNativePlanFrame({ params: { item: { type: "plan", text: `${FIXTURE_PLAN}\n` } } }, sha256) };
    const terminal = { direction: "response", relayPid: 10, method: "turn/completed", threadId: "thread-hp3", turnId: "turn-hp3", status: "completed" };
    const events = [request, ack, item, terminal];
    assert.equal(item.textBytes, 65); assert.equal(item.textSha256, "85498ded1c118e3ad9f0a00c8c6b84d2978571ada6f54746b87a16ea50c9121a");
    assert.deepEqual(nativePlanBoundary(events, 0, target), { matched: true, planBytes: 65, planSha256: item.textSha256, trimPlanBytes: 64, trimPlanSha256: sha256(FIXTURE_PLAN) });
    const compact = { ...item, ...projectNativePlanFrame({ params: { item: { type: "plan", text: FIXTURE_PLAN } } }, sha256) };
    assert.equal(hasLivePlanBoundary([request, ack, compact, terminal], 0, output, listing, target), true, "Unchanged valid64 native compatibility");
    assert.equal(hasLivePlanBoundary(events, 0, output, listing, target), true); assert.equal(planRowObservation(stale, target).pendingPlanApproval, false);
    assert.equal(live.outcomeSeenAt, undefined, "Running plan output cannot acknowledge a completed outcome");
    const refusal = await executeRespond(sm, { session: id, message: "approved", approve: true });
    requireAskPlanRefusal({ isError: refusal.isError, content: [{ type: "text", text: refusal.text }] }, target);
    assert.deepEqual(counters, { backend: 0, git: 0, approval: 0 });
    const rawOutput = output.content[0].text, rawListing = listing.content[0].text;
    for (const wrong of [tool(rawOutput.replace(id, "wrong-id")), tool(rawOutput.replace(target.name, "other-name")), tool(rawOutput.replace("awaiting_plan_decision", "active")), tool(rawOutput.replace(" | Phase: awaiting_plan_decision", "")), tool(rawOutput.replace(FIXTURE_PLAN, "# Another plan")), tool(rawOutput + "\n(showing persisted output)"), { ...output, isError: true }, { content: [] as Array<{ type: string; text: string }> }, undefined]) assert.equal(hasLivePlanBoundary(events, 0, wrong, listing, target), false);
    const other = rawListing.replaceAll(id, "other-id").replaceAll(target.name, "other-name");
    for (const wrong of [tool(rawListing + "\n\n" + rawListing), tool(rawListing.replace(target.name, "other-name")), tool(rawListing.replace("Plan waiting for the user", "Plan waiting for the orchestrator")), tool(rawListing.replace("   👉", "   omitted") + "\n\n" + other), tool(rawListing + "\n   ♻️ Recovered after a Gateway restart; no live process"), { ...listing, isError: true }, { content: [] as Array<{ type: string; text: string }> }, undefined]) assert.equal(hasLivePlanBoundary(events, 0, output, wrong, target), false);
    for (const wrong of [
      { ...item, textSha256: sha256("another plan") }, { ...item, textBytes: 64 }, { ...item, textBytes: 66 },
      { ...item, trimTextSha256: sha256("another plan") }, { ...item, trimTextBytes: 65 }, { ...item, trimTextBytes: null }, { ...item, trimTextSha256: undefined },
      { ...item, textBytes: item.trimTextBytes, textSha256: item.trimTextSha256, trimTextBytes: item.textBytes, trimTextSha256: item.textSha256 },
      { ...item, ...projectNativePlanFrame({ params: { item: { type: "plan", text: ` ${FIXTURE_PLAN}\n` } } }, sha256) },
      ...["", "Another nonempty native plan"].map((text) => ({ ...item, ...projectNativePlanFrame({ params: { item: { type: "plan", text } } }, sha256) })),
      { ...item, itemType: "agentMessage", genuineNativePlanItem: false }, { ...item, relayPid: 11 }, { ...item, threadId: "other" }, { ...item, turnId: "old" },
    ]) assert.equal(hasLivePlanBoundary([request, ack, wrong, terminal], 0, output, listing, target), false);
    for (const wrong of [[{ ...request, requestedModelMatches: false }, ack, item, terminal], [request, { ...ack, error: true }, item, terminal], [request, ack, item, { ...terminal, turnId: "old" }], [request, ack, item]]) assert.equal(hasLivePlanBoundary(wrong, 0, output, listing, target), false);
    assert.equal(hasLivePlanBoundary(events, events.length, output, listing, target), false);
    assert.throws(() => requireAskPlanRefusal({ isError: true, content: [{ type: "text", text: "Ask the user to approve" }] }, target));
    for (const status of ["starting", "running", "completed", "killed"]) {
      const view = tool(rawOutput.replace("Status: RUNNING", `Status: ${status.toUpperCase()}`));
      const owner = publicAliasOwner(view, target); assert.equal(owner.active, ["starting", "running"].includes(status));
      assert.equal(publicOutputObservation(view, { ...target, sessionId: "wrong" }).live, false);
    }
    assert.equal(publicAliasOwner(tool(rawOutput + "\n(showing persisted output)"), target).active, null);
    assert.match(assertAliasProtection(publicAliasOwner(undefined, target), { name: target.name }, target.name), /UNPROVEN/);
    assert.doesNotMatch(JSON.stringify([publicOutputObservation(output, target), waitingPlanObservation(listing, target), nativePlanBoundary(events, 0, target)]), /thread-hp3|ask-plan|hp3-/);
    live.status = live._status = "completed"; live.phase = live.lifecycle = "terminal"; live.pendingPlanApproval = false;
    getSessionOutputText(sm, id, { full: true, readerSessionKey: "another-requester" }); assert.equal(live.outcomeSeenAt, undefined);
    assert.match(getSessionOutputText(sm, id, { full: true, readerSessionKey: "fixture-owner" }), /no separate wake follows/); assert.equal(typeof live.outcomeSeenAt, "number");
  });

  it("keeps strict native/Git negatives while retaining entry-sequenced background overlap without causal claims", () => {
    const background = (sequence: number) => ({ requestSequence: sequence, requestClass: "host-background", schemaNames: ["agent_output"], fixtureOutputMarkers: [] as string[] });
    const snapshot = (provider: number, records: Array<Record<string, any>>, git = 0, backend = 0) => negativeSnapshot(git, backend, provider, records);
    const empty = snapshot(0, []); assert.equal(assertNegativeWindow(empty, empty, []).observedBackgroundCount, 0);
    const records = [background(1), background(2)];
    const observed = assertNegativeWindow(empty, snapshot(2, records), records); assert.equal(observed.observedBackgroundCount, 2); assert.equal(records.length, 2);
    assert.equal(observed.correlation, "entry-sequence-only-not-causal-receipt");
    assert.equal(observed.zeroBackendGit, true); assert.equal(observed.noNativeProviderContinuation, true);
    assert.equal(Object.hasOwn(observed, "zeroGitBackendProvider"), false);
    assert.equal(observed.providerBefore, 0); assert.equal(observed.providerAfter, 2);
    const delayed = assertNegativeWindow(snapshot(1, []), snapshot(2, records), records); assert.equal(delayed.preWindowBackgroundAdmissions, 1); assert.equal(delayed.observedBackgroundCount, 1);
    for (const wrong of [[{ ...background(1), requestClass: "native-generation", fixtureGeneration: "unexpected" }], [{ ...background(1), requestClass: "embedded-scenario" }], [{ ...background(1), requestClass: "unknown" }], [{ ...background(1), fixtureGeneration: "unexpected" }], [{ ...background(1), schemaNames: ["unknown-tool"] }], [{ ...background(1), fixtureOutputMarkers: ["OCA504_EMBED_DONE:wrong"] }], [], [background(1), background(1)], [background(2)], [{ ...background(1), requestSequence: false }]]) assert.throws(() => assertNegativeWindow(empty, snapshot(1, wrong), wrong));
    assert.throws(() => assertNegativeWindow(empty, snapshot(2, [background(2)]), [background(2)]));
    for (const current of [snapshot(0, [], 1), snapshot(0, [], 0, 1), snapshot(-1, [])]) assert.throws(() => assertNegativeWindow(empty, current, []));
    const before = snapshot(1, [background(1)]), changed = [{ ...background(1), requestClass: "native-generation" }];
    assert.throws(() => assertNegativeWindow(before, snapshot(1, changed), changed));
    assert.throws(() => assertNegativeWindow(snapshot(1, []), snapshot(1, [{ ...background(1), requestClass: "unknown" }]), [{ ...background(1), requestClass: "unknown" }]));
    assert.deepEqual(observed.providerClassesAfter, { native: 0, background: 2, embedded: 0, unknown: 0 });
  });

  it("records actual responseFrames events and hashes without changing model text or claiming native parser success", () => {
    const text = "<proposed_plan>Disposable model plan</proposed_plan>";
    const output = [messageItem(text)], sse = responseFrames(output, "fixture-model"), before = JSON.stringify(output);
    const observed = providerSseObservation(sse, output);
    assert.equal(observed.sseSha256, sha256(sse)); assert.equal(observed.sseBytes, Buffer.byteLength(sse)); assert.equal(observed.eventCount, 8);
    assert.equal(observed.eventNames[0], "response.created"); assert.equal(observed.eventNames.at(-1), "response.completed"); assert.equal(observed.items[0].textSha256, sha256(text));
    assert.equal(observed.items[0].proposedPlanOpen, true); assert.equal(observed.evidenceKind, "simulated-provider-output-not-native-plan");
    assert.equal(JSON.stringify(output), before); assert.doesNotMatch(JSON.stringify(observed), /Disposable model plan/);
  });

  it("keeps ordinary raw stdio byte-identical through the transparent relay while capturing bounded synthetic metadata", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "oca504-plan-relay-control-"));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      writeFileSync(join(fixture, ".fixture-owner"), FIXTURE_MARKER);
      const echo = join(fixture, "ordinary-echo.mjs"); writeFileSync(echo, "process.stdin.pipe(process.stdout);", { mode: 0o600 });
      const relay = writeNativeRelay(fixture, process.execPath);
      const raw = JSON.stringify({ method: "item/completed", params: { threadId: "synthetic-thread", turnId: "synthetic-turn", item: { type: "plan", text: "PRIVATE-SYNTHETIC-PLAN" } } }) + "\n";
      child = spawn(process.execPath, [relay, echo], { detached: true, stdio: ["pipe", "pipe", "pipe"] }); trackOwnedChild(child);
      let stdout = "", stderr = ""; child.stdout!.on("data", (bytes) => { stdout += bytes; }); child.stderr!.on("data", (bytes) => { stderr += bytes; });
      const ended = new Promise<void>((done) => child!.once("close", () => done())); child.stdin!.end(raw); await ended;
      assert.equal(child.exitCode, 0); assert.equal(stdout, raw); assert.equal(stderr, "");
      const captured = readFileSync(join(fixture, "native-events.jsonl"), "utf8");
      assert.doesNotMatch(captured, /PRIVATE-SYNTHETIC-PLAN/);
      const incoming = captured.trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.direction === "response");
      assert.equal(incoming.itemType, "plan"); assert.equal(incoming.textSha256, sha256("PRIVATE-SYNTHETIC-PLAN")); assert.equal(incoming.turnId, "synthetic-turn");
    } finally { if (child) await stopOwnedChild(child); rmSync(fixture, { recursive: true, force: true }); }
  });

  it("requires exact stopped generations and fresh successful resume on completed and killed rows", () => {
    const target = { sessionId: "older-id", name: "alias", backendRef: { conversationId: "original-thread" } };
    const row = { ...target, status: "completed", lifecycle: "terminal", runtimeState: "stopped" };
    for (const status of ["completed", "killed"]) {
      assert.equal(stoppedGeneration({ ...row, status }, target), true);
      assert.throws(() => freshResume([], "original-thread", true));
      const request = { direction: "request", method: "thread/resume", id: 1, relayPid: 1, threadId: "original-thread" };
      const ack = { direction: "response", id: 1, relayPid: 1, threadId: "original-thread" };
      assert.doesNotThrow(() => freshResume([request, ack], "original-thread", true));
      for (const wrong of [{ ...ack, error: true }, { ...ack, threadId: "other" }, { ...ack, id: 0 }, { ...ack, relayPid: 2 }]) assert.throws(() => freshResume([request, wrong], "original-thread", true));
      assert.throws(() => freshResume([{ ...request, threadId: "other" }, ack], "original-thread", true));
    }
    for (const status of ["starting", "running"]) assert.equal(stoppedGeneration({ ...row, status }, target), false);
    for (const wrong of [undefined, { ...row, status: "failed" }, { ...row, status: "unknown" }, { ...row, sessionId: "newer" }, { ...row, backendRef: { conversationId: "other" } }, { ...row, lifecycle: "suspended" }, { ...row, runtimeState: "live" }]) assert.throws(() => stoppedGeneration(wrong, target));
    assert.equal(generationObservation(undefined, target).exists, false);
    for (const [value, expected] of [["Session synthetic has been terminated.", "terminated"], ["Session synthetic is already completed. No action needed.", "already-completed"], ["Session synthetic is already killed. No action needed.", "already-killed"], ["Error: refused", "error"], ["unexpected", "other"]]) assert.equal(killResultClass({ content: [{ text: value }] }), expected);
  });

  it("requires each positive response's fresh window while permitting honestly shared overlapping resume observation", () => {
    const target = { sessionId: "exact-a", backendRef: { conversationId: "thread-a" } };
    const row = { ...target, status: "completed", lifecycle: "terminal", runtimeState: "stopped" };
    const request = { direction: "request", method: "thread/resume", id: 1, relayPid: 1, threadId: "thread-a" };
    const response = { direction: "response", id: 1, relayPid: 1, threadId: "thread-a" };
    const events = [request, response];
    const first = responseResumeBoundary(row, target, 0), overlapping = responseResumeBoundary(row, target, 0);
    assert.doesNotThrow(() => requireResponseResume(events, first, "thread-a"));
    assert.doesNotThrow(() => requireResponseResume(events, overlapping, "thread-a"));
    for (const status of ["completed", "killed"]) {
      const sequential = responseResumeBoundary({ ...row, status }, target, 2);
      assert.throws(() => requireResponseResume(events, sequential, "thread-a"), "Old success cannot satisfy later sequential or embedded window");
      const fresh = [...events, { ...request, id: 2 }, { ...response, id: 2 }];
      assert.doesNotThrow(() => requireResponseResume(fresh, sequential, "thread-a"));
    }
    assert.throws(() => responseResumeBoundary(undefined, target, 0));
    assert.throws(() => responseResumeBoundary({ ...row, status: "failed" }, target, 0));
  });

  it("keeps fresh bootstrap unchanged and relies on managed installer append after the baseline grant", () => {
    assert.equal(freshPluginBootstrap({ file: "owned-fixture.log" }, 12_345).plugins, undefined);
    for (const initial of [{ logging: { file: "owned.log" } }, { plugins: { entries: { "openclaw-code-agent": { enabled: true } }, allow: [] as string[] } }]) {
      const seeded = seedObserverAllow(initial);
      assert.deepEqual(seeded.plugins.allow, ["openclaw-code-agent", "openai"]);
      const installed = { ...seeded, plugins: { ...seeded.plugins, allow: [...seeded.plugins.allow, "oca504-observer"] } };
      assert.equal(managedObserverAllow(installed), installed.plugins.allow);
      for (const allow of [undefined, [], ["openclaw-code-agent", "openai"], ["openclaw-code-agent", "openai", "*"], ["openclaw-code-agent", "oca504-observer", "oca504-observer"], ["openclaw-code-agent", "openai", "oca504-observer", "unexpected"], ["openclaw-code-agent", "openai", false]]) assert.throws(() => managedObserverAllow({ plugins: { allow } }));
    }
  });

  it("protects only a currently active alias owner and truthfully allows terminal reuse", () => {
    const target = { sessionId: "newer", name: "shared", backendRef: { conversationId: "thread-newer" } };
    for (const status of ["starting", "running", "completed", "killed"]) {
      const owner = aliasOwnerObservation({ ...target, status }, target);
      if (owner.active) { assert.throws(() => assertAliasProtection(owner, { name: "shared" }, "shared")); assert.equal(assertAliasProtection(owner, { name: "shared-2" }, "shared"), "runtime-active-owner-protected"); }
      else assert.match(assertAliasProtection(owner, { name: "shared" }, "shared"), /plugin-fixture-only/);
    }
    for (const row of [undefined, { ...target, status: "failed" }, { ...target, status: "completed", sessionId: "other" }, { ...target, status: "running", name: "changed" }]) assert.throws(() => aliasOwnerObservation(row, target));
  });

  it("accepts genuine before-only HTTP evidence without manufacturing an after receipt", () => {
    const hook = { phase: "before", toolName: "agent_respond", toolCallId: "actual-id", session: "exact-target", inputHash: sha256("1") };
    assert.equal(requireHttpBefore([hook], "agent_respond", "exact-target", "1"), hook);
    assert.throws(() => requireEmbeddedAfter([hook], "agent_respond", "actual-id"));
    const after = { ...hook, phase: "after" };
    assert.equal(requireEmbeddedAfter([hook, after], "agent_respond", "actual-id"), after);
    assert.throws(() => requireEmbeddedAfter([{ ...after, toolCallId: "wrong" }], "agent_respond", "actual-id"));
    for (const events of [[], [{ ...hook, phase: "after" }], [{ ...hook, toolCallId: "" }], [{ ...hook, session: "other" }], [{ ...hook, inputHash: sha256("changed") }], [hook, hook]]) assert.throws(() => requireHttpBefore(events, "agent_respond", "exact-target", "1"));
  });

  it("classifies every known native, embedded and background provider request without borrowing payload proof", () => {
    const generations = new Set(["generation-a", "generation-b"]), scenarios = new Set(["direct"]);
    assert.equal(classifyProvider("generation-a", undefined, [], generations, scenarios), "native-generation");
    assert.equal(classifyProvider(undefined, "direct", ["agent_output"], generations, scenarios), "embedded-scenario");
    assert.equal(classifyProvider(undefined, undefined, ["agent_respond"], generations, scenarios), "host-background");
    for (const [generation, marker, names] of [["unknown", undefined, []], [undefined, "unknown", []], ["generation-a", "direct", []], [undefined, undefined, ["unrecognized"]]] as Array<[string | undefined, string | undefined, string[]]>) assert.throws(() => classifyProvider(generation, marker, names, generations, scenarios));
    const native = { requestClass: "native-generation", fixtureGeneration: "generation-a", latestInputHash: sha256("1"), fixtureOutputMarkers: ["OCA504_BACKEND_OK:generation-a:"] };
    const background = { requestClass: "host-background", latestInputHash: sha256("notification") };
    const all = [native, background]; assert.deepEqual(selectedProvider(all, "generation-a", "1"), [native]); assert.equal(all.length, 2);
    for (const requests of [[background], [{ ...native, fixtureGeneration: "generation-b" }, background], [{ ...native, latestInputHash: sha256("other") }], [{ ...native, fixtureOutputMarkers: [] }], [native, { requestClass: "unknown" }]]) assert.throws(() => selectedProvider(requests, "generation-a", "1"));
  });

  it("admits only startup-enabled exact generated observers and verifies managed selected-state copies", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "oca504-managed-observer-"));
    try {
      writeFileSync(join(fixture, ".fixture-owner"), FIXTURE_MARKER); mkdirSync(join(fixture, "host-observer"));
      const observer = writeHostObserver(fixture), manifestPath = join(observer.path, "openclaw.plugin.json"), original = readFileSync(manifestPath);
      let installs = 0, followons = 0;
      const install = () => installObserver(fixture, observer, async () => { installs++; followons++; });
      for (const activation of [undefined, false, [], { onStartup: false }, { onStartup: "true" }, null] as unknown[]) {
        const manifest = JSON.parse(original.toString()); if (activation === undefined) delete manifest.activation; else manifest.activation = activation;
        writeFileSync(manifestPath, JSON.stringify(manifest)); await assert.rejects(install()); assert.equal(installs, 0); assert.equal(followons, 0);
      }
      writeFileSync(manifestPath, original); await install(); assert.equal(installs, 1);
      const state = join(fixture, "state"), installed = join(state, "extensions", "oca504-observer"); mkdirSync(join(state, "extensions"), { recursive: true }); cpSync(observer.path, installed, { recursive: true });
      const proof = observerSourceProof(fixture, observer.path);
      const report = { plugin: { id: "oca504-observer", version: "0.0.0", enabled: true, status: "loaded", source: join(installed, "index.mjs"), rootDir: installed }, install: { source: "path", sourcePath: observer.path, installPath: installed } };
      assert.equal(verifyObserverInspection(report, fixture, state, proof).imported, false);
      assert.throws(() => verifyObserverInspection(report, fixture, state, proof, true));
      assert.equal(verifyObserverInspection({ ...report, plugin: { ...report.plugin, imported: true } }, fixture, state, proof, true).imported, true);
      mkdirSync(join(fixture, "other-state", "extensions"), { recursive: true }); cpSync(observer.path, join(fixture, "other-state", "extensions", "oca504-observer"), { recursive: true });
      for (const bad of [
        { ...report, plugin: { ...report.plugin, enabled: false } }, { ...report, plugin: { ...report.plugin, status: "error" } },
        { ...report, plugin: { ...report.plugin, version: "other" } }, { ...report, plugin: { ...report.plugin, source: join(observer.path, "index.mjs") } },
        { ...report, plugin: { ...report.plugin, rootDir: observer.path } }, { ...report, install: { ...report.install, sourcePath: installed } },
        { ...report, install: { ...report.install, source: "archive" } }, { ...report, install: { ...report.install, installPath: observer.path } },
        { ...report, plugin: { ...report.plugin, packageName: "wrong" } },
      ]) assert.throws(() => verifyObserverInspection(bad, fixture, state, proof));
      assert.throws(() => verifyObserverInspection(report, fixture, join(fixture, "other-state"), proof));
      writeFileSync(join(installed, "index.mjs"), "changed"); assert.throws(() => verifyObserverInspection(report, fixture, state, proof));
      assert.equal(followons, 1);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("observes exact tool IDs without returning mutations or recording requester routes", async () => {
    const root = mkdtempSync(join(tmpdir(), "oca504-observer-control-"));
    try {
      writeFileSync(join(root, ".fixture-owner"), FIXTURE_MARKER); mkdirSync(join(root, "host-observer"));
      const observer = writeHostObserver(root);
      const module = await import(join(observer.path, "index.mjs"));
      const callbacks = new Map<string, Function>();
      module.default.register({ on: (name: string, callback: Function) => callbacks.set(name, callback) });
      const params = { session: "synthetic-504", message: "1" };
      const callback = callbacks.get("before_tool_call")!;
      assert.equal(callback({ toolName: "agent_respond", toolCallId: "actual-synthetic-id", params }, { sessionKey: "PRIVATE-ROUTE" }), undefined);
      assert.deepEqual(params, { session: "synthetic-504", message: "1" });
      const capture = readFileSync(join(root, "host-tools.jsonl"), "utf8");
      assert.doesNotMatch(capture, /PRIVATE-ROUTE|sessionKey|"message"/);
      assert.equal(JSON.parse(capture).toolCallId, "actual-synthetic-id");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reads native failures through actual envelope shapes without inventing status from text", () => {
    const error = { isError: true, details: { status: "error", code: "session_not_found", targetSelected: false, operationStarted: false } };
    assert.deepEqual(nativeResult(JSON.stringify({ tool: { id: "plugin:fixture" }, result: error })), error);
    assert.equal(nativeResult({ content: [{ text: "Error: unrelated" }] }), undefined);
    assert.equal(nativeResult({ isError: true, details: { code: "unknown" } }), undefined);
  });

  it("keeps bare provider IDs distinct from exact composite host IDs", () => {
    assert.equal(compositeToolCallId("call-one", "item-one"), "call-one|item-one");
    assert.notEqual(compositeToolCallId("call-one", "item-two"), "call-one|item-one");
    assert.notEqual(compositeToolCallId("call-two", "item-one"), "call-one|item-one");
    assert.throws(() => compositeToolCallId("call-one ", "item-one"));
    assert.throws(() => compositeToolCallId("call-one", ""));
    assert.throws(() => compositeToolCallId("call-one|suffix", "item-one"));
  });

  it("does not admit reused or reparented descendant snapshots and fails closed on owned read errors", () => {
    const parent = processIdentity(process.pid)!;
    const snapshot = { pid: 123, parentPid: parent.pid, startTicks: "first" };
    const identity = { ...snapshot, group: parent.group, executable: parent.executable };
    assert.equal(currentDescendant(snapshot, identity, parent), true);
    assert.equal(currentDescendant(snapshot, { ...identity, startTicks: "replacement" }, parent), false);
    assert.equal(currentDescendant(snapshot, { ...identity, parentPid: 999 }, parent), false);
    assert.equal(currentDescendant(snapshot, identity, { ...parent, startTicks: "replacement" }), false);
    for (const code of ["EACCES", "EPERM"]) { assert.equal(ignorableProcReadFailure(code, false), true); assert.equal(ignorableProcReadFailure(code, true), false); }
    assert.equal(ignorableProcReadFailure("ENOENT", true), true);
    assert.equal(ignorableProcReadFailure("EIO", false), false);
  });

  it("retains sanitized bounded success and failure receipts, including failed cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "oca504-receipt-controls-"));
    try {
      for (const failed of [false, true]) {
        const evidence = new HostEvidence(root, "v26.1.0", "a".repeat(40));
        evidence.secrets.push("PRIVATE_TOKEN"); evidence.paths.push("/private/fixture");
        evidence.append("command-1-stderr.log", "PRIVATE_TOKEN Bearer OTHER_TOKEN /private/fixture/path\n", "diagnostic");
        let original = "original-failure", cleanup = "";
        if (failed) { try { await cleanupAll([() => { throw new Error("cleanup-failure"); }, () => { cleanup = "all attempted"; }]); } catch { /* receipt retains failure */ } }
        evidence.record("run-summary.json", { original: failed ? original : null, cleanup: failed ? cleanup : null });
        const receipt = evidence.persist("v26.1.0", failed ? "BLOCKED" : "PASS", !failed);
        const bytes = readFileSync(join(receipt.path, "manifest.json"));
        assert.equal(receipt.manifestSha256, (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"));
        const manifest = JSON.parse(bytes.toString()); assert.equal(manifest.status, failed ? "BLOCKED" : "PASS"); assert.equal(manifest.teardownVerified, !failed);
        const log = readFileSync(join(receipt.path, "command-1-stderr.log"), "utf8"); assert.doesNotMatch(log, /PRIVATE_TOKEN|OTHER_TOKEN|\/private\/fixture/);
        assert.match(log, /fixture-credential/);
        if (failed) assert.match(readFileSync(join(receipt.path, "run-summary.json"), "utf8"), /original-failure.*all attempted/);
      }
      const bounded = new HostEvidence(root, "v26.1.0", "b".repeat(40));
      bounded.append("command-1-stdout.log", "x".repeat(100_000), "diagnostic");
      bounded.append("native-events.jsonl", "x".repeat(1_048_577));
      const receipt = bounded.persist("v26.1.0", "PASS", true), manifest = JSON.parse(readFileSync(join(receipt.path, "manifest.json"), "utf8"));
      assert.equal(manifest.status, "BLOCKED"); assert.ok(manifest.errors.includes("proof-overflow:native-events.jsonl"));
      const diagnostic = manifest.files.find((file: any) => file.file === "command-1-stdout.log");
      assert.equal(diagnostic.truncated, true); assert.equal(diagnostic.totalBytes, 100_000); assert.ok(diagnostic.bytes <= 65_536);
      assert.ok(manifest.files.every((file: any) => file.bytes <= 1_048_576));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("retains bounded protocol causes separately from later runtime and cleanup failures", () => {
    const root = mkdtempSync(join(tmpdir(), "oca504-error-receipt-controls-"));
    try {
      const evidence = new HostEvidence(root, "v26.1.0", "c".repeat(40));
      const cause = Object.assign(new Error("PRIVATE_BODY /private/path Bearer PRIVATE_TOKEN"), { code: "EACCES" });
      evidence.failure("provider-json", new SyntaxError("PRIVATE_REQUEST_BODY", { cause }));
      evidence.failure("native-observer", cause);
      evidence.record("run-summary.json", { originalFailures: ["later-runtime-timeout"], cleanupFailures: ["later-cleanup-failure"], fixtureFailures: evidence.failures });
      const receipt = evidence.persist("v26.1.0", "BLOCKED", false);
      const proof = readFileSync(join(receipt.path, "provider.jsonl"), "utf8") + readFileSync(join(receipt.path, "host-events.jsonl"), "utf8") + readFileSync(join(receipt.path, "run-summary.json"), "utf8");
      assert.doesNotMatch(proof, /PRIVATE_|\/private\/|Bearer/);
      assert.match(proof, /SyntaxError.*Error/); assert.match(proof, /EACCES/);
      assert.match(proof, /later-runtime-timeout/); assert.match(proof, /later-cleanup-failure/);
      for (let i = 0; i < 128; i++) evidence.failure("provider-stream", new Error("never captured raw input"));
      assert.equal(evidence.failures.length, 128); assert.ok(evidence.errors.includes("failure-record-count-overflow"));
      assert.ok(evidence.failures.every((failure) => Buffer.byteLength(failure.message) <= 1_024));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("closes failed local provider responses without rewriting sent headers or losing secondary causes", () => {
    const root = mkdtempSync(join(tmpdir(), "oca504-provider-close-controls-"));
    try {
      for (const mode of ["before", "after", "ended", "destroyed", "write-fault", "close-fault"]) {
        const evidence = new HostEvidence(root, "v26.1.0", "d".repeat(40));
        evidence.failure("provider-json", new SyntaxError("original raw body is private"));
        const calls: string[] = [];
        const response = { headersSent: mode === "after" || mode === "close-fault", writableEnded: mode === "ended", destroyed: mode === "destroyed",
          writeHead: () => { calls.push("writeHead"); if (mode === "write-fault") throw new TypeError("secondary write fault"); },
          end: (text: string) => { calls.push(`end:${text}`); },
          destroy: () => { calls.push("destroy"); if (mode === "close-fault") throw new RangeError("secondary close fault"); },
        } as unknown as ServerResponse;
        assert.doesNotThrow(() => closeFailedProviderResponse(response, evidence));
        assert.equal(evidence.failures[0].errorClass, "SyntaxError");
        assert.ok(!JSON.stringify(evidence.failures).includes("raw body"));
        if (mode === "before") assert.deepEqual(calls, ["writeHead", "end:fixture protocol failure"]);
        else if (mode === "destroyed") assert.deepEqual(calls, []);
        else if (mode === "write-fault") { assert.deepEqual(calls, ["writeHead", "destroy"]); assert.equal(evidence.failures[1].errorClass, "TypeError"); }
        else if (mode === "close-fault") { assert.ok(calls.every((call) => call === "destroy")); assert.equal(evidence.failures[1].errorClass, "RangeError"); }
        else assert.deepEqual(calls, ["destroy"]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
