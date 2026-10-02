// Issue-501 lifecycle acceptance through the real owning Gateway's public APIs.
// The passed run is the actual disposable-host runner, never a mock host.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readNativeReview } from "./oca501-review-protocol.mjs";
import { projectConfigResponse, readOwnedConfig } from "./oca501-config-receipt.mjs";
import { assertNoNativeContinuation, messageText, nativeDiagnostics, assertVisibleCanonical, selectCanonicalProbe, currentRevisionSegments, revisionInstruction, assertOrdinaryCompleted, planPromptAuthority } from "./oca501-lifecycle-protocol.mjs";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function observe(label, probe) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await delay(100); }
  throw new Error(`Timed out: actual ${label}`);
}
const text = (response) => (response.output.result?.content ?? []).map((part) => part.text ?? "").join("\n");
function admitted(response) { assert.equal(response.status, 200); assert.equal(response.output.ok, true); assert.notEqual(response.output.result?.isError, true); assert.ok(!/^Error:/m.test(text(response))); }
function policyFailure(response) { assert.equal(response.status, 200); assert.match(text(response), /Goal verifier policy changed|stored suite does not match|complete operator-required suite/); }
const rowFor = (run, id) => run.sessions().find((row) => row.sessionId === id);
const taskFor = (run, name) => run.goals().find((row) => row.name === name.toLowerCase());
const tokensFor = (run, sessionId) => JSON.parse(readFileSync(run.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH, "utf8")).actionTokens.filter((token) => token.sessionId === sessionId);
const begin = (run, id) => { run.currentScenario = id; run.progress(id, "start"); };

async function callback(run, message, label, expected) {
  const start = run.botRequests.length;
  const update = await run.click(structuredClone(message), label);
  const reply = await observe(`${label} callback user-facing result`, () => run.botRequests.slice(start).find((entry) => entry.method === "sendMessage" && expected.test(entry.result?.text ?? "")));
  assert.equal(reply.result.chat.id, 501002); assert.ok(reply.respondedAt);
  return { update, actualReply: reply };
}
async function stop(run, sessionId, completed = false) {
  const result = await run.invoke("agent_kill", { session: sessionId, ...(completed ? { reason: "completed" } : {}) }, { channel: "telegram", target: "501002" }); admitted(result);
  await observe("owned session stopped", async () => { const view = await run.publicSession(sessionId); return view.terminalListing && rowFor(run, sessionId)?.lifecycle === "terminal" ? view : false; });
  return result;
}
async function settleParentReplies(run, requestStart) {
  const requests = run.modelRequests.slice(requestStart).filter((entry) => entry.transport === "host-parent" && entry.hasParentTools && entry.responseCompleted && entry.emittedType === "message" && !entry.parentDelivery);
  const receipts = [];
  for (const request of requests) {
    const history = await observe("actual parent response in canonical history", async () => {
      const value = await run.rpc("chat.history", { sessionKey: run.sessionKey, limit: 200, maxBytes: 2_000_000, maxChars: 500_000 });
      const message = value.messages.find((entry) => entry.role === "assistant" && entry.responseId === request.responseId);
      return message?.__openclaw?.runId ? { value, message } : false;
    });
    assert.equal(history.message.__openclaw.truncated, undefined, "Complete parent marker receipt is required");
    assert.ok(messageText(history.message).includes(request.emittedText));
    const runId = history.message.__openclaw.runId;
    const terminal = await observe("actual parent own-run terminal", async () => {
      const value = await run.rpc("agent.wait", { runId, timeoutMs: 1000 }); return ["pending", "timeout"].includes(value.status) ? false : value;
    });
    assertVisibleCanonical(terminal, runId, request.responseId, history.message, request.emittedText);
    receipts.push({ request: request.requestIndex, responseId: request.responseId, runId, terminal, canonicalMessage: history.message });
  }
  run.artifact(`lifecycle-parent-settlement-${requestStart}.json`, receipts);
  return receipts;
}
async function confirmPending(run, id, commands) {
  begin(run, id); const workdir = await run.workdir(id); const before = run.effects(); const messages = run.botMessages.length;
  run.nativeFixture = { tag: `OCA501_CASE_${id}`, workdir, text: `${id}_NATIVE_OK` };
  const admission = await run.invoke("agent_goal", run.goalArgs(id, workdir, { verifier_commands: commands }), { channel: "telegram", target: "501002" }); admitted(admission);
  const task = await observe("confirmation-pending goal", () => { const row = taskFor(run, id); return row?.status === "awaiting_verifier_confirmation" ? row : false; });
  assert.equal(task.sessionId, undefined);
  const message = await observe("original Run/Cancel wire buttons", () => run.botMessages.slice(messages).find((entry) => entry.text.includes(id.toLowerCase()) && entry.reply_markup?.inline_keyboard?.flat().some((button) => button.text === "Run these checks")));
  const after = run.effects(); assertNoNativeContinuation({ ...before, goalIds: [...before.goalIds, task.id].toSorted() }, after);
  return { id, workdir, task, admission, capturedMessage: structuredClone(message), originalTokens: tokensFor(run, task.id), before, after };
}
async function confirmations(run) {
  await run.suite(undefined);
  const stale = await confirmPending(run, "H06-stale-run", ["bash weak.sh"]);
  const cancel = await confirmPending(run, "H06-cancel", ["bash weak.sh"]);
  await run.suite(["bash ci.sh"]);
  const before = run.effects();
  const denied = await callback(run, stale.capturedMessage, "Run these checks", /Goal verifier policy changed|operator-required suite/);
  const failed = taskFor(run, stale.id); assert.equal(failed.status, "failed"); assert.match(failed.failureReason, /policy changed|operator-required suite/);
  assert.deepEqual(failed.verifierCommands, stale.task.verifierCommands); assert.equal(failed.requiredVerifierCommands, undefined);
  assertNoNativeContinuation(before, run.effects());
  const repeated = await callback(run, stale.capturedMessage, "Run these checks", /already|expired|no longer|stale/i);
  assert.notEqual(repeated.update.update_id, denied.update.update_id); assert.notEqual(repeated.update.callback_query.id, denied.update.callback_query.id); assertNoNativeContinuation(before, run.effects());
  run.recordCase(stale.id, { ...stale, denied, repeated, failed, assertions: ["real pending original opaque token", "specific operator-policy failure", "zero native/session/check side effects", "fresh wire replay inert; immutable selected checks"] });
  const cancelBefore = run.effects(); const cancelled = await callback(run, cancel.capturedMessage, "Cancel", /cancel|stopped|declin/i);
  assert.equal(taskFor(run, cancel.id).status, "stopped"); assertNoNativeContinuation(cancelBefore, run.effects());
  run.recordCase(cancel.id, { ...cancel, cancelled, assertions: ["separate still-pending goal", "cancellation remains available after policy change", "zero native/check effects", "actual user-facing callback receipt"] });
  await run.suite(undefined);
  const compatible = await confirmPending(run, "H06-matching-run", ["bash ci.sh"]);
  await run.suite(["bash ci.sh"]);
  const accepted = await run.click(compatible.capturedMessage, "Run these checks");
  const terminal = await run.terminal(compatible.id, compatible.workdir, { commands: ["bash ci.sh"] });
  run.recordCase(compatible.id, { ...compatible, accepted, terminal, assertions: ["legacy selected full suite binds only after validation", "actual original Run callback", "genuine native/check/source completion"] });
}
async function publicPlan(run, session, fixture, messageStart = 0) {
  const actualNative = await observe("own genuine native proposed Plan", () => run.modelRequests.findLast((request) => request.case === fixture.tag && request.nativePlanModelText));
  assert.equal(actualNative.nativeIdentity.thread_id, session.backendRef.conversationId);
  const message = await observe("original canonical versioned Plan prompt/buttons", () => run.botMessages.slice(messageStart).findLast((entry) => entry.text.startsWith(`📋 [${session.name}] Plan v`) && entry.reply_markup?.inline_keyboard?.flat().some((button) => button.text === "Approve")));
  const view = await observe("own active public pending Plan", async () => {
    try { return await run.publicSession(session.sessionId, { waitingKind: "plan" }); } catch { return false; }
  });
  const originalTokens = tokensFor(run, session.sessionId);
  const authority = planPromptAuthority({ message, tokens: originalTokens, view, markdown: fixture.planMarkdown, route: session.route, nativeRequest: actualNative, threadId: session.backendRef.conversationId, caseTag: fixture.tag });
  return { actualNative, publicView: view, planAuthority: authority, planVersion: authority.version, capturedMessage: structuredClone(message), originalTokens: authority.originalTokens };
}
async function pendingPlan(run, id) {
  begin(run, id); const workdir = await run.workdir(id); const messages = run.botMessages.length;
  const fixture = { tag: `OCA501_CASE_${id}`, workdir, mode: "plan", permissionMode: "plan", text: `${id}_NATIVE_OK`, planMarkdown: `# ${id} actual plan\n- Complete the harmless required CI gate after user approval.` };
  run.nativeFixture = fixture;
  const admission = await run.invoke("agent_goal", run.goalArgs(id, workdir, { permission_mode: "plan", max_iterations: 3 }), { channel: "telegram", target: "501002" }); admitted(admission);
  const task = await observe("real goal waiting for native plan", () => { const value = taskFor(run, id); return value?.status === "waiting_for_plan_approval" ? value : false; });
  const session = rowFor(run, task.sessionId); assert.equal(session.requestedPermissionMode, "plan");
  const plan = await publicPlan(run, session, fixture, messages); assert.ok(fixture.planSent);
  return { id, workdir, fixture, task, session, admission, ...plan };
}
async function parentProbe(run, id, requestStart) {
  const marker = `OCA501_PARENT_PROBE_${id}`; run.parentProbes.set(id, { id, marker });
  const created = (await run.rpc("sessions.list", { agentId: "main", limit: 200 })).sessions.filter((row) => row.key === run.sessionKey); assert.equal(created.length, 1);
  const admissionBoundary = run.modelRequests.length;
  const admission = await run.rpc("chat.send", { sessionKey: run.sessionKey, agentId: "main", message: `Reply exactly ${marker}. Use no tools.`, thinking: "off", deliver: false, idempotencyKey: `oca501-probe-${randomBytes(12).toString("hex")}` });
  assert.ok(admission.runId);
  const terminal = await observe("same-origin parent probe terminal", async () => { const value = await run.rpc("agent.wait", { runId: admission.runId, timeoutMs: 1000 }); return ["pending", "timeout"].includes(value.status) ? false : value; });
  assert.equal(terminal.runId, admission.runId); assert.equal(terminal.status, "ok");
  const history = await run.rpc("chat.history", { sessionKey: run.sessionKey, limit: 200, maxBytes: 2_000_000, maxChars: 500_000 });
  const requests = run.modelRequests.slice(requestStart).filter((request) => request.transport === "host-parent");
  const attribution = selectCanonicalProbe(history, run.modelRequests.slice(admissionBoundary).filter((request) => request.transport === "host-parent"), terminal, { sessionKey: run.sessionKey, sessionId: created[0].sessionId, runId: admission.runId, marker, probeId: id });
  const canonical = attribution.canonical, actualProbe = attribution.request;
  const inputs = requests.map((request) => JSON.parse(readFileSync(join(run.directory, `responses-request-${request.requestIndex}.json`), "utf8")).input);
  const proof = { admission, terminal, history, canonical, actualProbe, attribution, admissionBoundary, requests, inputs };
  run.artifact(`parent-probe-${id}.json`, proof); return proof;
}
async function plans(run) {
  await run.suite(["bash ci.sh"]);
  const allowed = await pendingPlan(run, "H07-approve"); const beforeAgent = run.effects();
  const agentApproval = await run.invoke("agent_respond", { session: allowed.task.sessionId, message: "Approved. Go ahead.", approve: true });
  assert.match(text(agentApproval), /only.*user|user.*approv|planApproval.*ask/i); assertNoNativeContinuation(beforeAgent, run.effects());
  const accepted = await run.click(allowed.capturedMessage, "Approve");
  const terminal = await run.terminal(allowed.id, allowed.workdir, { commands: ["bash ci.sh"] });
  assert.ok(allowed.fixture.approvalObserved); assert.equal(rowFor(run, terminal.sessionId).backendRef.conversationId, allowed.session.backendRef.conversationId);
  run.recordCase(allowed.id, { ...allowed, agentApproval, accepted, terminal, assertions: ["actual finalized native Plan artifact and wire buttons", "agent-facing ask approval refused", "real user callback second turn on same native thread", "full mandatory CI and source completion"] });

  const revise = await pendingPlan(run, "H07-revise-positive"); const reviseStart = run.modelRequests.length; const reviseBefore = run.effects();
  const changed = await callback(run, revise.capturedMessage, "Revise", /changes.*want|revision|revise/i);
  const revisedPublic = await run.publicSession(revise.task.sessionId, { waitingKind: "revise" }); assertNoNativeContinuation(reviseBefore, run.effects());
  const probe = await parentProbe(run, "H07-revise-positive", reviseStart);
  const instruction = revisionInstruction(revise.task.name, revise.task.sessionId, revise.planVersion);
  assert.equal(currentRevisionSegments(probe.actualProbe.actualProbeInput, instruction).length, 1, "Whole exact queued instruction belongs to one current context segment");
  assert.ok(!probe.requests.filter((request) => request.requestIndex < probe.actualProbe.requestIndex).some((request) => currentRevisionSegments(JSON.parse(readFileSync(join(run.directory, `responses-request-${request.requestIndex}.json`), "utf8")).input, instruction).length), "Fresh no-tool-call probe must be the next turn consuming this positive revision context");
  await stop(run, revise.task.sessionId); await run.settleGoalDelivery(taskFor(run, revise.id));
  run.recordCase(revise.id, { ...revise, changed, revisedPublic, probe, assertions: ["actual valid Revise callback", "same-origin next assembled no-tool-call probe contains exact session/version instruction", "real own-run/canonical terminal receipt", "no native work merely from requesting revision"] });

  const staleApprove = await pendingPlan(run, "H07-stale-approve"); const staleRevise = await pendingPlan(run, "H07-stale-revise"); const reject = await pendingPlan(run, "H07-reject");
  await run.suite(["bash lint.sh"]);
  for (const [pending, label] of [[staleApprove, "Approve"], [staleRevise, "Revise"]]) {
    const before = run.effects(); const requestStart = run.modelRequests.length;
    const beforePublic = await run.publicSession(pending.task.sessionId, { waitingKind: "plan" });
    const denied = await callback(run, pending.capturedMessage, label, /Goal verifier policy changed|operator-required suite/);
    const failed = taskFor(run, pending.id); assert.equal(failed.status, "failed"); assert.match(failed.failureReason, /policy changed|operator-required suite/);
    const after = rowFor(run, pending.task.sessionId);
    const afterPublic = await run.publicSession(pending.task.sessionId, { waitingKind: "plan" });
    assert.equal(afterPublic.phase, beforePublic.phase); assert.equal(afterPublic.waitingKind, beforePublic.waitingKind);
    assert.ok(afterPublic.outputText.includes(pending.fixture.planMarkdown));
    const appended = afterPublic.outputText.match(/^Pending plan \(v([1-9][0-9]*)\):$/m); if (appended) assert.equal(Number(appended[1]), pending.planVersion);
    assertNoNativeContinuation(before, run.effects());
    const artifact = afterPublic;
    let probe;
    if (label === "Revise") { probe = await parentProbe(run, pending.id, requestStart); const instruction = revisionInstruction(pending.task.name, pending.task.sessionId, pending.planVersion); assert.ok(probe.inputs.every((input) => currentRevisionSegments(input, instruction).length === 0), "Every actual current parent carrier lacks the whole denied targeted instruction"); }
    await run.settleGoalDelivery(failed); await run.click(pending.capturedMessage, "Reject");
    await observe("rejected failed owner's native session stopped", async () => { const view = await run.publicSession(pending.task.sessionId); return view.terminalListing && rowFor(run, pending.task.sessionId)?.lifecycle === "terminal" ? view : false; });
    assert.equal(taskFor(run, pending.id).status, "failed");
    run.recordCase(pending.id, { ...pending, denied, failed, after, beforePublic, afterPublic, artifact, probe, assertions: ["policy-specific stale continuation refusal", "native plan/version/state preserved", "zero native/check/repair", ...(probe ? ["all actual same-origin parent inputs lack targeted queued revision; positive probe control exists"] : [])] });
  }
  const beforeReject = run.effects(); const rejected = await callback(run, reject.capturedMessage, "Reject", /rejected|stopped/i);
  await observe("genuine plan rejection stopped native owner", async () => { const view = await run.publicSession(reject.task.sessionId); return view.terminalListing && rowFor(run, reject.task.sessionId)?.lifecycle === "terminal" ? view : false; });
  assert.equal(rowFor(run, reject.task.sessionId).approvalState, "rejected"); assertNoNativeContinuation(beforeReject, run.effects());
  const repeat = await callback(run, reject.capturedMessage, "Reject", /already|expired|stale|no longer/i); assertNoNativeContinuation(beforeReject, run.effects());
  await run.settleGoalDelivery(taskFor(run, reject.id));
  run.recordCase(reject.id, { ...reject, rejected, repeat, assertions: ["Reject remains allowed cancellation after changed policy", "real native stopped", "fresh opaque token replay cannot resurrect work"] });
}

async function ordinary(run, id, options = {}) {
  begin(run, id); const workdir = await run.workdir(id); const requestStart = run.modelRequests.length;
  const fixture = { tag: `OCA501_CASE_${id}`, workdir, text: `${id}_NATIVE_OK`, ordinary: true, originSessionKey: run.sessionKey, admissionRequestBoundary: requestStart, ...options }; run.nativeFixture = fixture;
  const admission = await run.invoke("agent_launch", { name: id.toLowerCase(), prompt: `${fixture.tag}: Perform only the harmless fixture task.`, workdir, harness: "codex", permission_mode: options.permissionMode ?? "bypassPermissions", force_new_session: true, worktree_strategy: "off" }, options.mode === "question" ? { channel: "telegram", target: "501002" } : {}); admitted(admission);
  const session = await observe("real ordinary native conversation", () => run.sessions().find((row) => row.name === id.toLowerCase() && row.backendRef?.conversationId));
  fixture.sessionId = session.sessionId;
  assert.equal(session.route.provider, options.mode === "question" ? "telegram" : "webchat");
  const publicView = await run.publicSession(session.sessionId); assert.equal(publicView.status, "running");
  return { id, workdir, fixture, admission, session, publicView, requestStart };
}
// Native diagnostics deliberately redact IDs. Identity is proved separately by
// the actual provider conversation, owning row and serialized public action.
function diagnostics(run) { return nativeDiagnostics(existsSync(join(run.directory, "openclaw-runtime.log")) ? readFileSync(join(run.directory, "openclaw-runtime.log"), "utf8") : ""); }
async function nativeTerminal(run, session, after, kind = "user") {
  return observe(`native ${kind} completed on owning conversation`, () => diagnostics(run).find((event) => event.event === "turn.terminal" && event.hasThreadId === true && event.hasTurnId === true && event.kind === kind && event.outcome === "completed" && event.at >= after));
}
async function outputContains(run, sessionId, marker) {
  return observe("actual native public output", async () => { const view = await run.publicSession(sessionId); return view.outputText?.includes(marker) ? view : false; });
}
async function ordinaryWebchatSettlement(run, pending, kind, requestStart) {
  const row = rowFor(run, pending.session.sessionId); assert.equal(row.route.provider, "webchat");
  const request = await observe("actual ordinary WebChat parent follow-through", () => run.modelRequests.slice(requestStart).find((request) => {
    if (request.transport !== "host-parent" || !request.hasParentTools || !request.responseCompleted || request.emittedType !== "message" || request.ordinarySessionId !== row.sessionId || !request.ordinaryCycle?.endsWith(`/${kind}`) || !request.actualNativeCompletion) return false;
    const input = JSON.parse(readFileSync(join(run.directory, `responses-request-${request.requestIndex}.json`), "utf8")).input;
    const user = input.input.findLast((entry) => entry.role === "user" && !messageText(entry).trim().startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>"));
    const wake = user ? messageText(user) : "", first = wake.split("\n")[0].replace(/^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\] /, "");
    return kind === "completed" ? first === `[${row.name}] Completed. ID: ${row.sessionId}` : first === "Coding agent session turn ended." && wake.split("\n")[1] === `Name: ${row.name}` && wake.split("\n")[2] === `ID: ${row.sessionId}`;
  }));
  const history = await observe("ordinary WebChat own-run canonical result", async () => {
    const value = await run.rpc("chat.history", { sessionKey: run.sessionKey, limit: 200, maxBytes: 2_000_000, maxChars: 500_000 });
    const message = value.messages.find((entry) => entry.role === "assistant" && entry.responseId === request.responseId && entry.__openclaw?.runId);
    return message ? { value, message } : false;
  });
  const runId = history.message.__openclaw.runId;
  const terminal = await observe("ordinary WebChat own-run terminal", async () => { const value = await run.rpc("agent.wait", { runId, timeoutMs: 1000 }); return ["pending", "timeout"].includes(value.status) ? false : value; });
  assertVisibleCanonical(terminal, runId, request.responseId, history.message, request.emittedText);
  let completedProof;
  if (kind === "completed") await observe("ordinary WebChat required completion persisted", () => {
    const current = rowFor(run, row.sessionId);
    try { completedProof = assertOrdinaryCompleted(current, { sessionId: row.sessionId, threadId: request.actualNativeCompletion.threadId, turnId: request.actualNativeCompletion.turnId, runId, routedReply: false, pendingSnapshot: request.actualOrdinaryAdmission }); return current; } catch { return false; }
  });
  const proof = { sessionId: row.sessionId, kind, sourceRoute: row.route, actualParentRequest: request, completedProof, runId, terminal, canonicalMessage: history.message }; run.artifact(`ordinary-webchat-${row.sessionId}-${kind}-${request.requestIndex}.json`, proof); return proof;
}
async function questionPending(run, pending) {
  const message = await observe("native question wire buttons", () => run.botMessages.findLast((entry) => entry.text.includes(pending.fixture.tag) && entry.reply_markup?.inline_keyboard?.flat().some((button) => button.text === "Choice A")));
  const row = rowFor(run, pending.session.sessionId); const tokens = tokensFor(run, pending.session.sessionId).filter((token) => token.kind === "question-answer");
  assert.ok(tokens.length >= 2); assert.ok(tokens.every((token) => token.pendingInputRequestId && token.pendingInputQuestionId === "fixture_choice"));
  assert.ok(pending.fixture.question); assert.equal(pending.fixture.questionNativeThread, pending.session.backendRef.conversationId);
  const questionTokens = ["Choice A", "Choice B"].map((label, optionIndex) => {
    const buttons = message.reply_markup.inline_keyboard.flat().filter((button) => button.text === label); assert.equal(buttons.length, 1);
    const matched = tokens.filter((token) => buttons[0].callback_data === `code-agent:${token.id}`); assert.equal(matched.length, 1);
    assert.equal(matched[0].optionIndex, optionIndex); assert.equal(matched[0].route?.provider, "telegram"); assert.equal(matched[0].route?.target, "501002"); return matched[0];
  });
  assert.equal(questionTokens[0].pendingInputRequestId, questionTokens[1].pendingInputRequestId);
  const publicView = await run.publicSession(pending.session.sessionId, { waitingKind: "question" });
  return { capturedMessage: structuredClone(message), row, tokens, questionTokens, publicView };
}
async function heldGoal(run, id, { question = false } = {}) {
  begin(run, id); const workdir = await run.workdir(id);
  const fixture = { tag: `OCA501_CASE_${id}`, workdir, text: `${id}_NATIVE_OK`, hold: true, ...(question ? { mode: "question", permissionMode: "plan", expectedAnswer: "Choice A" } : {}) }; run.nativeFixture = fixture;
  const admission = await run.invoke("agent_goal", run.goalArgs(id, workdir, { max_iterations: 3, ...(question ? { permission_mode: "plan" } : {}) }), { channel: "telegram", target: "501002" }); admitted(admission);
  const task = await observe("held real goal running", () => { const task = taskFor(run, id); return task?.status === "running" && fixture.heldRequest ? task : false; });
  const session = rowFor(run, task.sessionId); assert.ok(session.backendRef?.conversationId); assert.deepEqual(task.requiredVerifierCommands, ["bash ci.sh"]);
  const actual = run.modelRequests.find((request) => request.requestIndex === fixture.heldRequest); assert.ok(actual.externalHeld); assert.equal(actual.nativeIdentity.thread_id, session.backendRef.conversationId);
  const publicView = await run.publicSession(task.sessionId); assert.equal(publicView.status, "running"); assert.ok(["active", "running"].includes(publicView.phase));
  return { id, workdir, fixture, task, session, admission, heldRequest: actual, publicView };
}
async function pendingInputAndControls(run) {
  await run.suite(["bash ci.sh"]);
  for (const [suffix, answer] of [["button", "Choice A"], ["text", "Choice B"]]) {
    const pending = await ordinary(run, `H09-question-${suffix}`, { mode: "question", permissionMode: "plan", expectedAnswer: answer, planAfterAnswer: true, planMarkdown: `# H09 ${suffix} question answered\n- Complete the harmless approved fixture.` });
    const question = await questionPending(run, pending); const started = new Date().toISOString();
    const response = suffix === "button" ? await run.click(question.capturedMessage, answer) : await run.invoke("agent_respond", { session: pending.session.sessionId, message: answer, userInitiated: true }, { channel: "telegram", target: "501002" });
    if (suffix === "text") admitted(response);
    await observe("actual question function output on same native thread", () => pending.fixture.answerObserved);
    const planOutput = await outputContains(run, pending.session.sessionId, pending.fixture.planMarkdown);
    const plan = await publicPlan(run, pending.session, pending.fixture);
    const approval = await run.click(plan.capturedMessage, "Approve");
    const output = await outputContains(run, pending.session.sessionId, pending.fixture.text); const terminal = await nativeTerminal(run, pending.session, started);
    assert.equal(pending.fixture.approvalObserved, true);
    const sourceTurn = await run.ordinarySourceSettlement(pending.session.sessionId, "turn-ended");
    await stop(run, pending.session.sessionId, true); const sourceCompleted = await run.ordinarySourceSettlement(pending.session.sessionId, "completed");
    run.recordCase(pending.id, { ...pending, question, response, planOutput, plan, approval, output, terminal, sourceTurn, sourceCompleted, assertions: ["actual Plan-native question and request/options", "genuine public answer", "matching native function_call_output", "same native conversation completed"] });
  }
  const steer = await ordinary(run, "H09-steer-positive", { hold: true });
  await observe("ordinary actual provider stream held", () => steer.fixture.heldRequest);
  const started = new Date().toISOString(), instruction = `OCA501_STEER_${steer.id}`;
  const response = await run.invoke("agent_respond", { session: steer.session.sessionId, message: instruction, userInitiated: true }); admitted(response);
  const accepted = await observe("real native steer accepted", () => diagnostics(run).find((event) => event.event === "turn.steer.done" && event.hasThreadId === true && event.hasTurnId === true && event.at >= started));
  run.releaseExternal(steer.fixture);
  const consumed = await observe("real native provider input consumes steer", () => run.modelRequests.find((request) => request.transport === "native-codex" && request.case === steer.fixture.tag && JSON.stringify(JSON.parse(readFileSync(join(run.directory, `responses-request-${request.requestIndex}.json`), "utf8")).input).includes(instruction)));
  assert.equal(consumed.nativeIdentity.thread_id, steer.session.backendRef.conversationId);
  const output = await outputContains(run, steer.session.sessionId, steer.fixture.text); const terminal = await nativeTerminal(run, steer.session, started);
  const parentTurn = await ordinaryWebchatSettlement(run, steer, "turn-ended", steer.requestStart); const completedStart = run.modelRequests.length;
  await stop(run, steer.session.sessionId, true); const parentCompleted = await ordinaryWebchatSettlement(run, steer, "completed", completedStart);
  run.recordCase(steer.id, { ...steer, response, accepted, consumed, output, terminal, parentTurn, parentCompleted, assertions: ["actual live turn.steer accepted", "same-conversation provider input contains real user instruction", "native completed; no mock steer frame"] });
  for (const action of ["compact", "review"]) {
    const pending = await ordinary(run, `H09-${action}-positive`); await outputContains(run, pending.session.sessionId, pending.fixture.text);
    await nativeTerminal(run, pending.session, "", "user");
    const initialParent = await ordinaryWebchatSettlement(run, pending, "turn-ended", pending.requestStart); const requestStart = run.modelRequests.length;
    const started = new Date().toISOString(); pending.fixture.operation = action; pending.fixture.operationStartedAt = started; pending.fixture.operationRequestBoundary = requestStart;
    if (action === "review") {
      const nonce = randomBytes(12).toString("hex"); pending.fixture.reviewStartedAt = started;
      pending.fixture.reviewInstructions = `${pending.fixture.tag}: Harmless review action ${nonce}.`;
      pending.fixture.reviewOutput = { findings: [], overall_correctness: "patch is correct", overall_explanation: `${pending.fixture.text}: completed harmless review action ${nonce}`, overall_confidence_score: 1 };
    }
    const response = await run.invoke("agent_session_action", { session: pending.session.sessionId, action, ...(action === "review" ? { review_target: "custom", instructions: pending.fixture.reviewInstructions } : {}) }); admitted(response); pending.fixture.operationAdmission = response;
    const terminal = await nativeTerminal(run, pending.session, started, action);
    const output = await outputContains(run, pending.session.sessionId, action === "compact" ? "Conversation context compacted" : pending.fixture.text);
    const actual = run.modelRequests.filter((request) => request.case === pending.fixture.tag && request.responseCompleted && request.receivedAt >= started);
    assert.ok(actual.length);
    let originalReview;
    if (action === "review") {
      assert.ok(pending.fixture.reviewRelation); assert.ok(actual.every((request) => request.actualReviewRelation?.originalThreadId === pending.session.backendRef.conversationId));
      let lastIncompleteObservation;
      try { originalReview = await observe("original native structured review exit and successful outer completion", () => { try { return readNativeReview(run.env.CODEX_HOME, pending.fixture.reviewExpected, true); } catch (error) { lastIncompleteObservation = String(error); return false; } }); }
      catch (error) { run.artifact(`native-review-exit-${pending.id}.json`, { error: String(error), lastIncompleteObservation, projection: true, rawRolloutExcluded: true }); throw error; }
      assert.equal(rowFor(run, pending.session.sessionId).backendRef.conversationId, pending.session.backendRef.conversationId);
    } else assert.ok(actual.every((request) => request.nativeIdentity.thread_id === pending.session.backendRef.conversationId));
    const parentTurn = await ordinaryWebchatSettlement(run, pending, "turn-ended", requestStart); const completedStart = run.modelRequests.length;
    await stop(run, pending.session.sessionId, true); const parentCompleted = await ordinaryWebchatSettlement(run, pending, "completed", completedStart);
    run.recordCase(pending.id, { ...pending, response, terminal, output, initialParent, parentTurn, parentCompleted, originalReview, assertions: ["public native action admitted", "actual action-kind terminal on original thread", "real provider and public native output"] });
  }
  const controls = [];
  for (const action of ["text", "compact", "review"]) controls.push({ action, pending: await heldGoal(run, `H09-deny-${action}`) });
  const questionGoal = await heldGoal(run, "H09-deny-question", { question: true });
  await run.suite(["bash lint.sh"]);
  for (const { action, pending } of controls) {
    assert.equal(taskFor(run, pending.id).status, "running", "First guarded action must exercise active policy, not a prior terminal owner");
    const activeBefore = await run.publicSession(pending.task.sessionId); assert.equal(activeBefore.status, "running"); assert.ok(["active", "running"].includes(activeBefore.phase));
    assert.ok(!pending.heldRequest.externalAbortedAt && !pending.heldRequest.externalReleasedAt && !pending.heldRequest.responseCompleted, "Original real native stream is still held before the guard");
    const before = run.effects();
    const response = action === "text" ? await run.invoke("agent_respond", { session: pending.task.sessionId, message: "Continue the harmless fixture", userInitiated: true }) : await run.invoke("agent_session_action", { session: pending.task.sessionId, action, ...(action === "review" ? { review_target: "custom", instructions: "Harmless fixture review" } : {}) });
    policyFailure(response); assertNoNativeContinuation(before, run.effects());
    const failed = taskFor(run, pending.id); assert.equal(failed.status, "failed"); assert.match(failed.failureReason, /policy changed|operator-required suite/);
    await stop(run, pending.task.sessionId); await run.settleGoalDelivery(failed);
    run.recordCase(pending.id, { ...pending, activeBefore, response, failed, assertions: ["independent active bound goal", "policy-specific refusal before native input/action", "zero execution/check/repair", "ordinary actual support control exists"] });
  }
  assert.equal(taskFor(run, questionGoal.id).status, "running");
  const questionActiveBefore = await run.publicSession(questionGoal.task.sessionId); assert.equal(questionActiveBefore.status, "running"); assert.ok(["active", "running"].includes(questionActiveBefore.phase));
  assert.ok(!questionGoal.heldRequest.externalAbortedAt && !questionGoal.heldRequest.responseCompleted); run.releaseExternal(questionGoal.fixture);
  const question = await questionPending(run, { ...questionGoal, session: questionGoal.session });
  const failed = await observe("policy-specific owning goal failure from real input turn", () => { const task = taskFor(run, questionGoal.id); return task.status === "failed" ? task : false; });
  assert.match(failed.failureReason, /policy changed|operator-required suite/);
  const before = run.effects(); const deniedButton = await callback(run, question.capturedMessage, "Choice A", /policy|goal.*failed|already failed/i);
  const deniedText = await run.invoke("agent_respond", { session: questionGoal.task.sessionId, message: "Choice A", userInitiated: true }); assert.match(text(deniedText), /policy|goal.*failed|already failed/i);
  assertNoNativeContinuation(before, run.effects()); assert.equal(questionGoal.fixture.answerObserved, undefined);
  await stop(run, questionGoal.task.sessionId); await run.settleGoalDelivery(failed);
  run.recordCase(questionGoal.id, { ...questionGoal, questionActiveBefore, question, failed, deniedButton, deniedText, assertions: ["held real Plan request while goal active", "accepted mandatory policy change before genuine question frame", "initial goal failure specifically policy, not generic manual-question failure", "subsequent terminal-owner public answer refusal; no native answer", "ordinary button/text answer positives exist"] });
}
async function operatorSchema(run) {
  await run.suite(["bash ci.sh"]); const path = "plugins.entries.openclaw-code-agent.config.requiredGoalVerifierCommands";
  for (const [suffix, value] of [["empty", []], ["blank", [""]], ["white", [" "]], ["mixed", ["bash ci.sh", 1]], ["string", "bash ci.sh"], ["object", {}], ["boolean", false], ["null-apply", null]]) {
    const id = `V1-${suffix}`; begin(run, id);
    const before = await run.rpc("config.get"), owner = await run.hostIdentity(), effects = run.effects(); const source = readOwnedConfig(run.env.OPENCLAW_CONFIG_PATH, run.directory);
    const method = value === null ? "config.apply" : "config.patch";
    const raw = value === null ? structuredClone(source.config) : { plugins: { entries: { "openclaw-code-agent": { config: { requiredGoalVerifierCommands: value } } } } };
    if (value === null) raw.plugins.entries["openclaw-code-agent"].config.requiredGoalVerifierCommands = null;
    const params = { raw: JSON.stringify(raw), baseHash: before.hash, ...(method === "config.patch" ? { replacePaths: [path] } : {}) };
    const result = await run.command(process.execPath, [run.hostEntry, "gateway", "call", method, "--params", JSON.stringify(params), "--json"], { expectedConfigSchemaError: path });
    const after = await run.rpc("config.get"), sourceAfter = readOwnedConfig(run.env.OPENCLAW_CONFIG_PATH, run.directory);
    for (const field of ["hash", "configRevisionHash", "appliedConfigHash"]) assert.equal(after[field], before[field]);
    assert.ok(source.bytes.equals(sourceAfter.bytes)); assert.deepEqual(await run.hostIdentity(), owner); assertNoNativeContinuation(effects, run.effects());
    const weak = await run.deniedCase(`${id}-policy-retained`, ["true"]);
    run.recordCase(id, { classification: "HOST_SCHEMA_REJECTION", result, before: projectConfigResponse("config.get", before), after: projectConfigResponse("config.get", after), ownedSourceHash: source.sha256, weak, assertions: ["actual complete nonzero official CLI INVALID_REQUEST/settings issue", "operator invalid setting rejected before commit/application", "unchanged raw/resolved/applied revisions/source bytes/process/execution", "subsequent weak goal still refused", "full profile/streams excluded from export"] });
  }
  await run.suite(undefined); const applied = await run.rpc("config.get");
  assert.equal(Object.hasOwn(applied.config.plugins.entries["openclaw-code-agent"].config, "requiredGoalVerifierCommands"), false);
  const terminal = await run.launchCase("V1-absent-new-goal", { extra: { goal_mode: "ralph", completion_promise: "DONE" }, text: "<promise>DONE</promise>", expected: { receipt: "" } });
  run.recordCase("V1-removal", { applied: projectConfigResponse("config.get", applied), terminal, assertions: ["merge-patch null removes property, distinct from invalid literal-null apply", "new-goal verifier-free Ralph compatibility", "old bound restore/removal proof remains required separately in H10"] });
}

export async function runL1(run) {
  await run.settleGoalDelivery(run.goals().find((goal) => goal.name === "host-prerequisite"));
  const publicConfig = await run.rpc("config.get"); const ownedSource = readOwnedConfig(run.env.OPENCLAW_CONFIG_PATH, run.directory);
  assert.equal(publicConfig.config.logging.level, "debug"); assert.equal(ownedSource.config.logging.level, "debug");
  run.artifact("lifecycle-observability.json", { loggingLevel: "debug", ownedLogFile: join(run.directory, "openclaw-runtime.log"), publicAndOwnedSourceAgree: true, projection: true, rawFullConfigExcluded: true, identityLimit: "Native diagnostic IDs are presence booleans; actual provider metadata/backend/public output independently prove conversation association" });
  const requestStart = run.modelRequests.length;
  await confirmations(run); await plans(run);
  await pendingInputAndControls(run); await operatorSchema(run);
  await settleParentReplies(run, requestStart);
  for (const scenario of ["H06", "H07", "H09", "V1"]) {
    run.results = run.results.filter((row) => !(row.scenario === scenario && row.classification === "UNPROVEN"));
    run.results.push({ ...run.provenance, scenario, classification: "PASS", assertions: run.results.filter((row) => row.scenario.startsWith(`${scenario}-`)).map((row) => row.scenario), exitCode: 0, remaining: "H08/H10-H12 and final exact-head cumulative both-floor acceptance remain UNPROVEN" });
  }
  await run.finalDrain();
}
