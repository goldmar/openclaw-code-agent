import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assignments, decodeReceipt, excluded, frameReceipt, FILE_LIMIT, HOST_PIN, requiredFact } from "../scripts/e2e/oca501-evidence.mjs";
import { optionsFor, visibleProof, stopOwnedChild, processIdentity, currentOwner, FeatureRun } from "../scripts/e2e/oca-goal-host-acceptance.mjs";
import { spawn } from "node:child_process";
import { currentNativeIntent, nativeExecutionCall, matchingNativeOutput } from "../scripts/e2e/oca501-native-protocol.mjs";
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
    assert.equal(optionsFor(args)["--scenario"], "all");
    for (const scenario of Object.keys(assignments)) assert.equal(optionsFor([...args, "--scenario", scenario])["--scenario"], scenario);
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
  it("chooses a restored active public owner independently of persisted row order", () => {
    const fixture = { name: "own", workdir: "/tmp/own", oldSessionId: "old" };
    const old = { name: fixture.name, workdir: fixture.workdir, sessionId: "old", goalTaskId: "goal", backendRef: { conversationId: "thread" } };
    const live = { ...old, sessionId: "new" }, listing = "🟢 own [new] — running · 1s\n   📁 /tmp/own";
    for (const rows of [[old, live], [live, old]]) assert.equal(currentOwner(rows, listing, fixture, "thread", "goal"), live);
    for (const text of ["🟢 other [new] — running · 1s", listing + "\n   ♻️ Recovered after a Gateway restart; no live process", "Persisted output own [new]", listing + "\n\n🟢 own [other] — running · 1s"]) {
      assert.throws(() => currentOwner([old, live, { ...live, sessionId: "other" }], text, fixture, "thread", "goal"));
    }
    assert.throws(() => currentOwner([live], listing, fixture, "foreign", "goal"));
    assert.throws(() => currentOwner([live], listing, fixture, "thread", "foreign"));
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

});
