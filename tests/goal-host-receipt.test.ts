import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assignments, decodeReceipt, excluded, frameReceipt, FILE_LIMIT, HOST_PIN, requiredFact } from "../scripts/e2e/oca501-evidence.mjs";
import { optionsFor, visibleProof, stopOwnedChild, processIdentity, currentOwner, FeatureRun } from "../scripts/e2e/oca-goal-host-acceptance.mjs";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { currentNativeIntent, nativeExecutionCall, matchingNativeOutput } from "../scripts/e2e/oca501-native-protocol.mjs";
import { Session } from "../src/session";
import { SessionStore } from "../src/session-store";
import { GoalController } from "../src/goal-controller";
import { GoalTaskStore } from "../src/goal-store";
import { SessionRuntimeRegistry } from "../src/session-runtime-registry";
import { SessionHarnessEventApplier } from "../src/session-harness-event-applier";
import type { SessionManager } from "../src/session-manager";
import type { SessionConfig } from "../src/types";
import { getSessionOutputText, getSessionsListingText } from "../src/application/session-view";
const expected = { candidateSha: "a".repeat(40), nodeVersion: "24.16.0", scenario: "smoke" };
const receipt = (): any => ({ ...expected, format: "oca501-slim-v1", complete: true, hostVersion: "2026.9.7", hostCommit: HOST_PIN, nativeVersion: "0.159.3", assigned: [], completed: [], disposition: "PASS", failure: null, cleanup: { complete: true, failures: [] }, excluded: [], proofs: [] });
describe("bounded representative host receipts", () => {
  it("requires exact external identity even on BLOCKED evidence", () => {
    const r = receipt(); r.disposition = "BLOCKED";
    const frame = frameReceipt(r); assert.deepEqual(decodeReceipt(frame, expected).receipt, r);
    for (const override of [{ candidateSha: "b".repeat(40) }, { nodeVersion: "26.1.0" }, { scenario: "all" }]) assert.throws(() => decodeReceipt(frame, { ...expected, ...override }));
    assert.throws(() => decodeReceipt(frame + frame, expected));
    assert.throws(() => decodeReceipt(frame.slice(0, -10), expected));
  });
  it("never calls an incomplete scenario or failed cleanup PASS", () => {
    const r = receipt(); r.scenario = "all"; r.assigned = [...assignments.all];
    assert.throws(() => frameReceipt(r));
    r.completed = [...assignments.all]; assert.doesNotThrow(() => frameReceipt(r));
    r.cleanup.complete = false; r.cleanup.failures = ["OWNED_CHILD_SHUTDOWN_FAILED"]; assert.throws(() => frameReceipt(r));
    r.disposition = "BLOCKED"; assert.doesNotThrow(() => frameReceipt(r));
    r.completed.push("foreign"); assert.throws(() => frameReceipt(r));
  });
  it("exports raw excluded stream identity without raw credentials or configuration", () => {
    const privateValue = "SYNTHETIC_PRIVATE_CREDENTIAL";
    const r = receipt(); r.excluded = [excluded("runtime.log", Buffer.from(`apiKey=${privateValue}`))] as any;
    const framed = frameReceipt(r); const decoded = decodeReceipt(framed, expected);
    assert.equal(JSON.stringify(decoded.receipt).includes(privateValue), false);
    assert.equal(decoded.receipt.excluded[0].bytes, Buffer.byteLength(`apiKey=${privateValue}`));
    for (const key of ["auth", "apiKey", "defaults", "bindings", "transcript", "environment"]) assert.throws(() => frameReceipt({ ...receipt(), proofs: [{ [key]: privateValue }] }));
    const redacted = decodeReceipt(frameReceipt({ ...receipt(), proofs: [{ ownRunId: privateValue }] }, [privateValue]), expected);
    assert.equal(JSON.stringify(redacted.receipt).includes(privateValue), false);
    assert.throws(() => frameReceipt({ ...receipt(), proofs: [{ safe: "x".repeat(FILE_LIMIT) }] }));
    const large = { ...receipt(), proofs: Array.from({ length: 1100 }, () => ({ ownRunId: "x".repeat(4096) })) };
    const bounded = decodeReceipt(frameReceipt(large), expected); assert.equal(bounded.receipt.disposition, "BLOCKED");
    assert.equal(bounded.receipt.failure.code, "STRUCTURED_PROOF_BOUND_EXCEEDED"); assert.ok(bounded.bytes.length <= FILE_LIMIT);
  });
  it("rejects unknown or repeated selectors before any host effects", () => {
    const args = ["--expected-sha", expected.candidateSha, "--node-version", expected.nodeVersion, "--artifacts", "/tmp/oca501-owned"];
    assert.equal((optionsFor(args) as Record<string, string>)["--scenario"], "all");
    for (const scenario of Object.keys(assignments)) assert.equal((optionsFor([...args, "--scenario", scenario]) as Record<string, string>)["--scenario"], scenario);
    for (const extra of [["--scenario", "foreign"], ["--scenario", "gates,live"], ["--scenario", ""], ["--scenario", "smoke", "--scenario", "all"], ["--command", "anything"]]) assert.throws(() => optionsFor([...args, ...extra]));
  });
  it("joins a visible own run to exactly one canonical response and actual provider result", () => {
    const identity = { runId: "own-run", sessionId: "own-session", sessionKey: "own-key" };
    const result = { runId: identity.runId, status: "ok", terminalReply: { disposition: "visible", text: "Harmless receipt" } };
    const message = { role: "assistant", responseId: "resp_1", __openclaw: { runId: identity.runId }, content: [{ type: "text", text: result.terminalReply.text }] };
    const history = { sessionId: identity.sessionId, sessionKey: identity.sessionKey, messages: [message] };
    const requests = [{ native: false, completed: true, responseId: "resp_1", text: result.terminalReply.text }];
    assert.doesNotThrow(() => visibleProof(result, history, requests, identity));
    for (const mutate of [
      (r: any, h: any) => { r.runId = "foreign"; }, (r: any) => { r.status = "error"; },
      (r: any) => { r.terminalReply.disposition = "silent"; }, (r: any) => { r.terminalReply.text = " no_reply "; },
      (r: any) => { r.yielded = true; }, (r: any) => { r.terminalReply.yielded = "false"; },
      (_r: any, h: any) => { h.sessionId = "foreign"; }, (_r: any, h: any) => { h.messages.push(h.messages[0]); },
      (_r: any, h: any) => { h.messages[0].__openclaw.truncated = true; },
      (_r: any, h: any) => { h.messages[0].responseId = "foreign"; },
      (_r: any, h: any) => { h.messages[0].content[0].text = "different"; },
    ]) { const r = structuredClone(result), h = structuredClone(history); mutate(r, h); assert.throws(() => visibleProof(r, h, requests, identity)); }
    assert.throws(() => visibleProof(result, history, [...requests, requests[0]], identity));
  });

  it("exports a closed required fact and refuses unknown nested proof fields even during decode", () => {
    const extra = { required: true, producer: "goal", outcomeKey: "goal:owned", credentials: { password: "SYNTHETIC_PRIVATE_VALUE" }, unknownDetail: "SYNTHETIC_PRIVATE_VALUE" };
    assert.deepEqual(requiredFact(extra), { required: true, producer: "goal", outcomeKey: "goal:owned" });
    assert.doesNotThrow(() => frameReceipt({ ...receipt(), proofs: [{ requiredAdmissionFact: requiredFact(extra) }] }));
    for (const proofs of [[{ requiredAdmissionFact: extra }], [{ unknownDetail: extra }], [{ gateway: { pid: 1, unknownDetail: extra } }]]) {
      assert.throws(() => frameReceipt({ ...receipt(), proofs }));
      const bytes = Buffer.from(JSON.stringify({ ...receipt(), proofs }) + "\n");
      const frame = `OCA501_SLIM ${JSON.stringify({ content: bytes.toString("base64"), bytes: bytes.length, sha256: excluded("proof.json", bytes).sha256 })}\n`;
      assert.throws(() => decodeReceipt(frame, expected));
    }
    assert.throws(() => frameReceipt({ ...receipt(), cleanup: { complete: true, failures: ["OWNED_CHILD_SHUTDOWN_FAILED"] } }));
  });
  it("requires the latest registered native intent and the exact current turn/call", () => {
    const tag = "OCA501_CASE_control", prompt = `${tag}: Run the harmless receipt command.`;
    const message = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    const body = { tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      client_metadata: { thread_id: "own-thread", turn_id: "own-turn" }, input: [message("<environment_context><cwd>/tmp/own/case</cwd></environment_context>"), message(prompt)] };
    const options = { transport: "native-codex", caseTag: tag, workdir: "/tmp/own/case", ownedRoot: "/tmp/own", callId: "oca501_exec_1", itemId: "item", validate: () => ({ ok: true }), intent: { kind: "ordinary", prompt }, expectedIdentity: body.client_metadata };
    const call = nativeExecutionCall(body, options);
    for (const latest of ["Unrelated current request", "<environment_context><cwd>/tmp/own/case</cwd></environment_context>", `Quoted: ${prompt}`, `\x60\x60\x60\n${prompt}\n\x60\x60\x60`]) assert.throws(() => nativeExecutionCall({ ...body, input: [...body.input, message(latest)] }, options));
    assert.throws(() => nativeExecutionCall({ ...body, client_metadata: { ...body.client_metadata, turn_id: "foreign" } }, options));
    const restart = { kind: "restore", goal: `${tag}: Finish.`, ralph: true };
    assert.doesNotThrow(() => currentNativeIntent({ input: [message(`The OpenClaw gateway restarted while this Ralph-style goal task was running.\nResume from the prior session context and continue immediately.\n\nGoal:\n${restart.goal}\n\nInstructions:\n- Continue.`)] }, { caseTag: tag, intent: restart }));
    const result = { type: "function_call_output", call_id: call.callId, output: "real result" };
    assert.equal(matchingNativeOutput({ ...body, input: [...body.input, result] }, call), result);
    for (const change of [{ turn_id: "foreign" }, { thread_id: "foreign" }]) assert.throws(() => matchingNativeOutput({ ...body, client_metadata: { ...body.client_metadata, ...change }, input: [result] }, call));
    assert.throws(() => matchingNativeOutput({ ...body, input: [{ ...result, call_id: "foreign" }] }, call));
  });
  it("joins actual running recovery rows through the controller's current task association", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oca501-goal-owner-"));
    const fixture = { name: "own", workdir: directory, intent: { kind: "launch", goal: "Own intent" }, ralph: false };
    const store = new SessionStore({ indexPath: join(directory, "sessions.json"), env: {} });
    const registry = new SessionRuntimeRegistry();
    const earlier = new Session({ prompt: "Earlier", workdir: directory, harness: "codex" }, fixture.name);
    earlier.transition("running"); registry.add(earlier);
    let live!: Session;
    const manager = { setGoalTaskAuthorizer: () => {}, emitGoalTaskUpdate: () => {}, resolve: (id: string) => registry.sessions.get(id),
      launchAndAwaitRunning: async (config: SessionConfig) => {
        live = new Session({ ...config, backendRef: { kind: "codex-app-server", conversationId: "thread" } }, registry.uniqueName(config.name!));
        registry.add(live);
        (live as unknown as { harnessEvents: SessionHarnessEventApplier }).harnessEvents.applyMessage({ type: "backend_ref", ref: { kind: "codex-app-server", conversationId: "thread" } },
          { pendingPlanApproval: false, currentPermissionMode: "bypassPermissions", permissionMode: "bypassPermissions", planModeApproved: false });
        store.markRunning(live); return live;
      } };
    const controller = new GoalController(manager as unknown as SessionManager);
    (controller as unknown as { store: GoalTaskStore }).store = new GoalTaskStore({ OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH: join(directory, "goals.json") });
    try {
      const goal = await controller.launchTask({ name: fixture.name, goal: fixture.intent.goal, workdir: directory, verifierCommands: [{ label: "check", command: "true" }],
        loopMode: "verifier", permissionMode: "bypassPermissions", route: { provider: "webchat", target: "owned-parent" } });
      assert.equal(goal.sessionId, live.id); assert.equal(goal.sessionName, live.name); assert.notEqual(live.name, fixture.name);
      const row = store.getPersistedSession(live.id)!; assert.equal(Object.hasOwn(row, "goalTaskId"), false);
      const listing = getSessionsListingText({ list: () => [live], listPersistedSessions: () => store.listPersistedSessions() } as unknown as SessionManager, "running", undefined, { full: true });
      const bound = { ...fixture, goalId: goal.id, nativeSessionId: live.id };
      assert.equal(currentOwner([row], listing, bound, "thread", goal), row);
      assert.doesNotThrow(() => currentOwner([{ ...row, goalTaskId: goal.id }], listing, bound, "thread", goal));
      for (const change of [{ goalTaskId: "foreign" }, { goalTaskId: null }, { goalTaskId: "" }, { name: fixture.name }, { workdir: "/tmp/foreign" }, { backendRef: { conversationId: "foreign" } }])
        assert.throws(() => currentOwner([{ ...row, ...change }], listing, bound, "thread", goal));
      for (const change of [{ id: "foreign" }, { name: "foreign" }, { goal: "foreign" }, { workdir: "/tmp/foreign" }, { loopMode: "ralph" }, { status: "failed" }, { sessionId: "foreign" }, { sessionName: fixture.name }, { harnessSessionId: "foreign" }])
        assert.throws(() => currentOwner([row], listing, bound, "thread", { ...goal, ...change }));
      assert.throws(() => currentOwner([row, row], listing, bound, "thread", goal));
      for (const text of [listing + "\n\n" + listing, listing + "\n   ♻️ Recovered after a Gateway restart; no live process", listing.replace(`[${live.id}]`, "[foreign]")])
        assert.throws(() => currentOwner([row], text, bound, "thread", goal));
      assert.throws(() => currentOwner([row], listing, { ...bound, oldSessionId: live.id }, "thread", goal));
      let observedTasks: Array<typeof goal> = [{ ...goal, sessionName: undefined }], publicReads = 0, taskReads = 0;
      const identity = processIdentity(process.pid)!;
      const nativeFixture = { ...bound, nativeSnapshot: { gateway: identity, processes: [] } };
      const run = Object.assign(Object.create(FeatureRun.prototype), { gatewayReady: true, gatewayIdentity: identity, proofs: [],
        goals: () => { taskReads++; return observedTasks; }, sessions: () => [row], nativeProcesses: () => [identity],
        invoke: async (name: string) => { publicReads++; assert.ok(observedTasks[0].sessionName); return { content: [{ text: name === "agent_sessions" ? listing : getSessionOutputText(manager as unknown as SessionManager, live.id) }] }; } });
      const waiting = run.nativeOwner(nativeFixture, { threadId: "thread" });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(taskReads > 0); assert.equal(publicReads, 0); observedTasks = [{ ...goal }];
      assert.equal((await waiting).sessionId, live.id);
      const before = publicReads;
      const contradictions: Array<Array<typeof goal>> = [[{ ...goal }, { ...goal }], [{ ...goal, harnessSessionId: "foreign" }], [{ ...goal, status: "failed" }]];
      for (const tasks of contradictions) {
        observedTasks = tasks; await assert.rejects(run.nativeOwner(nativeFixture, { threadId: "thread" })); assert.equal(publicReads, before);
      }
      const missingAndInvalid: Array<Partial<typeof goal>> = [{ sessionId: undefined, sessionName: null }, { sessionId: undefined, sessionName: " " },
        { sessionId: undefined, harnessSessionId: "foreign" }, { sessionName: undefined, sessionId: "foreign" },
        { sessionId: undefined, id: null }, { sessionId: undefined, id: " " }];
      for (const change of missingAndInvalid) {
        let reads = 0;
        run.goals = () => { reads++; return reads === 1 ? [{ ...goal, ...change }] : [{ ...goal }]; };
        await assert.rejects(run.nativeOwner({ ...nativeFixture, goalId: change.id === undefined ? goal.id : undefined }, { threadId: "thread" }));
        assert.equal(reads, 1); assert.equal(publicReads, before, "Invalid present fields cannot be retried away before public output");
      }
      const terminal = { ...row, status: "completed", goalTaskId: goal.id };
      assert.throws(() => currentOwner([terminal], listing, { ...fixture, name: live.name }, "thread", undefined), "Ordinary cannot borrow a goal owner");
    } finally {
      controller.stop(); earlier.kill("shutdown"); if (live) live.kill("shutdown");
      await Promise.all([earlier.waitForTeardown(), live?.waitForTeardown()]); rmSync(directory, { recursive: true, force: true });
    }
  });
  it("observes natural completion through the real listing without claiming the outcome", async () => {
    const origin = "agent:main:main", fixture: any = { name: "natural", workdir: "/tmp/owned-case", threadId: "thread", intent: { kind: "ordinary" } };
    const session = new Session({ prompt: "Receipt", workdir: fixture.workdir, harness: "codex", permissionMode: "bypassPermissions", worktreeStrategy: "off",
      originSessionKey: origin, backendRef: { kind: "codex-app-server", conversationId: fixture.threadId } }, fixture.name);
    session.transition("running");
    (session as any).turnRuntime.finishSuccessfulTurn({ currentPermissionMode: "bypassPermissions", permissionMode: "bypassPermissions", pendingPlanApproval: false, planModeApproved: false, hasPendingMessages: false });
    assert.equal(session.status, "completed"); assert.equal(session.phase, "terminal");
    const manager: any = { list: () => [session], listPersistedSessions: (): never[] => [], resolve: (id: string) => id === session.id ? session : undefined };
    let row: any = { sessionId: session.id, name: session.name, status: session.status, workdir: session.workdir, backendRef: session.backendRef };
    let listing = () => getSessionsListingText(manager, "all", undefined, { full: true });
    const calls: string[] = [], run = Object.assign(Object.create(FeatureRun.prototype), { proofs: [], sessions: () => [row], goals: () => [{ id: "goal", sessionId: session.id, sessionName: fixture.name, name: fixture.name, goal: "Finish" }],
      invoke: async (name: string) => { calls.push(name); return { content: [{ text: name === "agent_sessions" ? listing() : getSessionOutputText(manager, session.id, { readerSessionKey: origin }) }] }; } });
    await run.publicOwner(session.id, "completed", fixture);
    assert.deepEqual(calls, ["agent_sessions"]); assert.equal(session.outcomeSeenAt, undefined);
    for (const change of [{ status: "running" }, { status: "failed" }, { status: "killed" }, { name: "foreign" }, { workdir: "/tmp/foreign" }, { backendRef: { kind: "codex-app-server", conversationId: "foreign" } }, { goalTaskId: "foreign" }]) {
      const original = row; row = { ...row, ...change }; await assert.rejects(run.publicOwner(session.id, "completed", fixture)); row = original;
    }
    await assert.rejects(run.publicOwner("foreign", "completed", fixture));
    const originalListing = listing;
    for (const text of [originalListing().replace(`[${session.id}]`, "[foreign]"), originalListing() + "\n   ♻️ Recovered after a Gateway restart; no live process", `${originalListing()}\n\n${originalListing()}`, "Persisted output only"]) {
      listing = () => text; await assert.rejects(run.publicOwner(session.id, "completed", fixture));
    }
    listing = originalListing; fixture.intent = { kind: "launch", goal: "Finish" }; row.goalTaskId = "goal";
    await run.publicOwner(session.id, "completed", fixture); // A running GoalTask may own a terminal native Session.
    row.goalTaskId = "foreign"; await assert.rejects(run.publicOwner(session.id, "completed", fixture)); delete row.goalTaskId;
    await assert.rejects(run.publicOwner(session.id, "running"));
    assert.equal(typeof session.outcomeSeenAt, "number", "The old terminal agent_output read would consume the short-launch outcome");
    await session.waitForTeardown();
  });
  it("binds the sole newly admitted native instance and never reselects an earlier or replacement child", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oca501-native-owner-")), executable = join(directory, "native");
    const workspace = readlinkSync(`/proc/${process.pid}/cwd`), gateway = processIdentity(process.pid);
    const fixture: any = { name: "owned", workdir: join(directory, "logical-case"), intent: { kind: "ordinary" } };
    const row = { ...fixture, sessionId: "owner", backendRef: { conversationId: "thread" } };
    const run = Object.assign(Object.create(FeatureRun.prototype), { native: executable, workspace, gatewayIdentity: gateway, gatewayReady: true,
      sessions: () => [row], invoke: async () => ({ content: [{ text: "🟢 owned [owner] — running · 1s" }] }), publicOwner: async () => {} });
    const children: any[] = []; let primary: unknown, cleanupFailed = false;
    const start = async (cwd = workspace) => {
      const child = Object.assign(spawn(executable, ["-e", "console.log('ready');setInterval(()=>{},1000)"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] }), { ownedIdentity: undefined as ReturnType<typeof processIdentity> });
      children.push(child);
      await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
      child.ownedIdentity = processIdentity(child.pid);
      return child;
    };
    try {
      copyFileSync(readlinkSync(`/proc/${process.pid}/exe`), executable);
      chmodSync(executable, 0o700);
      const earlier = await start();
      fixture.nativeSnapshot = { gateway, processes: run.nativeProcesses() };
      assert.ok(fixture.nativeSnapshot.processes.some((p: NonNullable<ReturnType<typeof processIdentity>>) => p.pid === earlier.pid));
      const current = await start(), request = { threadId: "thread" };
      assert.equal(run.nativeProcesses(null).length, 2);
      const first = await run.nativeOwner(fixture, request);
      assert.equal(first.nativeProcess.pid, current.pid);
      const repeated = (await run.nativeOwner(fixture, request)).nativeProcess;
      for (const field of ["pid", "startTicks", "executable"]) assert.equal(repeated[field], first.nativeProcess[field]);
      fixture.nativeProcess = { ...first.nativeProcess, startTicks: `${first.nativeProcess.startTicks}-reused` };
      await assert.rejects(run.nativeOwner(fixture, request)); fixture.nativeProcess = first.nativeProcess;
      run.gatewayIdentity = { ...gateway, startTicks: `${gateway.startTicks}-foreign` };
      await assert.rejects(run.nativeOwner(fixture, request)); run.gatewayIdentity = gateway;
      await assert.rejects(run.nativeOwner(fixture, { threadId: "foreign" }));
      const another = await start();
      await assert.rejects(run.nativeOwner({ ...fixture, nativeProcess: undefined }, request)); // Two new instances.
      const foreignBaseline = { ...fixture, nativeProcess: undefined, nativeSnapshot: { gateway: earlier.ownedIdentity, processes: [] } };
      run.gatewayIdentity = earlier.ownedIdentity;
      await assert.rejects(run.nativeOwner(foreignBaseline, request)); run.gatewayIdentity = gateway;
      const wrongCwd = await start(directory);
      assert.throws(() => run.nativeProcesses());
      assert.equal((await stopOwnedChild(wrongCwd, { identity: wrongCwd.ownedIdentity, graceMs: 100, killMs: 100 })).complete, true);
      run.native = "/oca501-foreign-executable"; await assert.rejects(run.nativeOwner(fixture, request)); run.native = executable;
      assert.equal((await stopOwnedChild(current, { identity: current.ownedIdentity, graceMs: 100, killMs: 100 })).complete, true);
      await assert.rejects(run.nativeOwner(fixture, request)); // The live replacement must not be selected.
      assert.ok(processIdentity(another.pid));
    } catch (error) { primary = error; }
    finally {
      for (const child of children) try { if (!(await stopOwnedChild(child, { identity: child.ownedIdentity, graceMs: 100, killMs: 100 })).complete) cleanupFailed = true; } catch { cleanupFailed = true; }
      if (!cleanupFailed) try { assert.deepEqual(run.nativeProcesses(null), []); } catch (error) { primary ??= error; cleanupFailed = true; }
      if (!cleanupFailed) rmSync(directory, { recursive: true, force: true });
    }
    if (primary) throw primary;
    assert.equal(cleanupFailed, false);
  });
  it("bounds stubborn child and inherited-pipe cleanup and preserves the primary failure", async () => {
    const child = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process'); const writer=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>process.stdout.write('writer\\n'),20)"],{stdio:['ignore','inherit','inherit']}); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); console.log(writer.pid);`], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => {});
    const writerPid = await new Promise<number>(resolve => child.stdout.once("data", bytes => resolve(Number(bytes.toString().split("\n")[0]))));
    const writer = processIdentity(writerPid), primary = new Error("PRIMARY_FEATURE_FAILURE");
    let saved: Error | undefined;
    try { throw primary; } catch (error) { saved = error as Error; }
    const result = await stopOwnedChild(child, { graceMs: 100, killMs: 100 });
    assert.equal(saved, primary); assert.equal(result.complete, true); assert.equal(result.graceful, false);
    assert.equal(result.signal, "SIGKILL"); assert.equal(result.stdioComplete, true);
    const remaining = processIdentity(writerPid); assert.ok(!remaining || remaining.startTicks !== writer.startTicks || remaining.state === "Z");
    const r = receipt(); r.disposition = "BLOCKED"; r.failure = { stage: "native", code: "REQUIRED_FEATURE_PROOF_FAILED" };
    r.cleanup = { complete: false, failures: ["OWNED_CHILD_SHUTDOWN_FAILED"] }; r.proofs = [{ exitCode: result.exitCode, signal: result.signal, timedOut: true, stdioComplete: result.stdioComplete }];
    assert.equal(decodeReceipt(frameReceipt(r), expected).receipt.failure.code, "REQUIRED_FEATURE_PROOF_FAILED");
  });
  it("cleans an early Gateway start failure before its identity was recorded", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise(resolve => child.stdout.once("data", resolve));
    const run = Object.assign(Object.create(FeatureRun.prototype), { gateway: child, gatewayIdentity: undefined, children: new Set([child]), shutdownOptions: { graceMs: 100, killMs: 100 } });
    const shutdown = run.shutdown();
    await assert.rejects(shutdown, /GRACEFUL_SHUTDOWN_FAILED|OWNED_PROCESS_OR_STDIO_SHUTDOWN_FAILED/);
    assert.equal(child.stdout.closed, true); assert.equal(child.stderr.closed, true);
  });

  it("captures failed spawn and timed-out command outcomes before cleanup", async () => {
    const run = Object.assign(Object.create(FeatureRun.prototype), { env: process.env, children: new Set(), raw: [], proofs: [] });
    await assert.rejects(run.command("/oca501-owned-absent-command", []), /COMMAND_SPAWN_FAILED/);
    assert.equal(run.children.size, 0); assert.equal(run.raw.length, 2);
    assert.equal(run.proofs[0].stdioComplete, true);
    await assert.rejects(run.command(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { timeoutMs: 150, graceMs: 100, killMs: 100 }), /COMMAND_TIMEOUT/);
    assert.equal(run.children.size, 0); assert.equal(run.raw.length, 4);
    const last = run.proofs.at(-1); assert.equal(last.timedOut, true); assert.equal(last.signal, "SIGKILL"); assert.equal(last.stdioComplete, true);
  });

  it("retains a live command after both output pipes close until terminal cleanup", async () => {
    const run = Object.assign(Object.create(FeatureRun.prototype), { env: process.env, children: new Set(), raw: [], proofs: [] });
    const outcome = run.command(process.execPath, ["-e", "console.log(process.pid);setTimeout(()=>{require('node:fs').closeSync(1);require('node:fs').closeSync(2)},50);setInterval(()=>{},1000)"], { allowFailure: true, timeoutMs: 500, graceMs: 100, killMs: 100 }).then((): null => null, (error: Error): Error => error);
    const child: any = [...run.children][0], identity = processIdentity(child.pid);
    try {
      await Promise.all([child.stdout, child.stderr].map((stream: Readable) => stream.closed ? Promise.resolve() : new Promise<void>(resolve => stream.once("close", resolve))));
      assert.equal(child.stderr.closed, true); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
      assert.equal(run.children.has(child), true); assert.ok(processIdentity(child.pid));
      const error = await outcome; assert.match(error.message, /COMMAND_TIMEOUT/);
      assert.equal(run.children.size, 0); assert.equal(child.signalCode, "SIGTERM");
      assert.equal(run.proofs.at(-1).timedOut, true); assert.equal(run.proofs.at(-1).stdioComplete, true);
      assert.equal(run.raw.length, 2);
    } finally {
      await stopOwnedChild(child, { identity, graceMs: 100, killMs: 100 });
      for (const owned of run.children) if (owned !== child) await stopOwnedChild(owned, { graceMs: 100, killMs: 100 });
      await outcome;
    }
  });

});
