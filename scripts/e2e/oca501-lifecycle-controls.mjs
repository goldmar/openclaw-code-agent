// Offline issue-501 lifecycle assertion controls. Never host/native acceptance.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { assertConfigSchemaRefusal, assertNoNativeContinuation, assertQuestionAnswer, latestParentUser, nativeDiagnostics, questionCall, selectNativeCase, assertSafeHostLog, selectOrdinaryCompletion } from "./oca501-lifecycle-protocol.mjs";
import { reviewDelegate, projectNativeReview, assertFullReviewOutput, readNativeReview } from "./oca501-review-protocol.mjs";
import { nativeInventory } from "./oca501-native-protocol.mjs";
import { projectConfigCommand } from "./oca501-config-receipt.mjs";
const argv = process.argv.slice(2); assert.equal(argv.length, 2); assert.equal(argv[0], "--request");
const bytes = readFileSync(argv[1]); const golden = JSON.parse(bytes).input;
const questionTool = nativeInventory(golden).find(({ namespace, tool }) => namespace === "functions" && tool.name === "request_user_input"); assert.ok(questionTool);
const tag = "OCA501_CASE_offline", fixture = { tag, permissionMode: "plan" }, cases = new Map([[tag, fixture]]);
const user = { type: "message", role: "user", content: [{ type: "input_text", text: `${tag}: harmless offline fixture` }] };
const request = { ...golden, input: [...golden.input.filter((entry) => entry.role === "developer"), user] };
assert.equal(selectNativeCase(request, cases), fixture);
assert.equal(selectNativeCase({ input: [{ ...user, content: "Return the prerequisite marker." }] }, cases), undefined);
const negatives = [], refuse = (label, action) => { assert.throws(action, undefined, label); negatives.push(label); };
for (const [label, change] of [["unknown case", (copy) => { copy.input.at(-1).content = "OCA501_CASE_foreign: foreign"; }], ["ambiguous cases", (copy) => { copy.input.push({ ...user, content: "OCA501_CASE_second: foreign" }); }], ["unmatched native", (copy) => { copy.input.at(-1).content = "unknown request"; }], ["quoted developer tag", (copy) => { copy.input.at(-1).role = "developer"; }]]) { const copy = structuredClone(request); change(copy); refuse(label, () => selectNativeCase(copy, cases)); }
const options = { callId: "own-question-call", itemId: "own-item", validate: ({ schema, value }) => ({ ok: schema === questionTool.tool.parameters && value.questions[0].id === "fixture_choice" }) };
const call = questionCall(request, fixture, options);
assert.equal(call.item.type, "function_call"); assert.equal(call.item.namespace, "functions"); assert.equal(call.item.name, "request_user_input"); assert.equal(JSON.parse(call.item.arguments).questions[0].id, "fixture_choice");
refuse("question outside Plan", () => questionCall(request, { ...fixture, permissionMode: "bypassPermissions" }, options));
refuse("actual schema refusal", () => questionCall(request, fixture, { ...options, validate: () => ({ ok: false }) }));
refuse("no genuine question advertisement", () => questionCall({ input: [user] }, fixture, options));
const output = { type: "function_call_output", call_id: call.callId, output: JSON.stringify({ answers: { fixture_choice: { answers: ["Choice A"] } } }) };
assertQuestionAnswer(output, call, "Choice A"); assertQuestionAnswer({ ...output, output: [{ type: "input_text", text: output.output }] }, call, "Choice A");
for (const change of [{ call_id: "foreign" }, { type: "custom_tool_call_output" }, { isError: true }, { output: JSON.stringify({ error: "actual error" }) }, { output: "plain marker" }, { output: [] }, { output: [{ type: "input_image", text: output.output }] }]) refuse("foreign/error/malformed answer", () => assertQuestionAnswer({ ...output, ...change }, call, "Choice A"));
refuse("wrong submitted answer", () => assertQuestionAnswer(output, call, "Choice B"));
const parent = { input: [{ role: "user", content: "old" }, { role: "user", content: "Reply exactly own-probe. Use no tools." }, { role: "user", content: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> auxiliary" }] }; assert.equal(latestParentUser(parent).content, "Reply exactly own-probe. Use no tools.");
const before = { goalIds: ["g"], sessionIds: ["s"], nativeRequests: 1, nativeProcesses: 1, receipts: { own: "CI\n" }, parentRequests: 1 };
assertNoNativeContinuation(before, { ...before, parentRequests: 5, tokenConsumed: true });
for (const field of ["goalIds", "sessionIds", "nativeRequests", "nativeProcesses", "receipts"]) refuse(`actual ${field} side effect`, () => assertNoNativeContinuation(before, { ...before, [field]: Array.isArray(before[field]) ? [...before[field], "new"] : typeof before[field] === "number" ? before[field] + 1 : { own: "CI\nCI\n" } }));
const path = "plugins.entries.openclaw-code-agent.config.requiredGoalVerifierCommands";
const error = { ok: false, error: { type: "gateway_request_error", code: "INVALID_REQUEST", details: { issues: [{ path: `${path}.0`, message: "PRIVATE_CONFIG_NOT_EXPORTABLE" }] }, message: "PRIVATE_CONFIG_NOT_EXPORTABLE" } };
const receipt = { exit: { code: 1, signal: null }, stdout: JSON.stringify(error), stderr: "PRIVATE_CONFIG_NOT_EXPORTABLE", streamsComplete: true, closeObserved: true, timedOut: false, errors: [] };
const refusal = assertConfigSchemaRefusal(receipt, path); assert.equal(refusal.classification, "HOST_SCHEMA_REJECTION");
assertConfigSchemaRefusal({ ...receipt, stdout: JSON.stringify({ ...error, error: { ...error.error, details: { issues: [{ path: path.split(".") }] } } }) }, path);
for (const changed of [{ exit: { code: 0, signal: null } }, { streamsComplete: false }, { timedOut: true }, { stdout: "bad json" }, { stdout: JSON.stringify({ ...error, error: { ...error.error, code: "UNAVAILABLE" } }) }, { stdout: JSON.stringify({ ...error, error: { ...error.error, details: { issues: [{ path: "other" }] } } }) }]) refuse("non-schema failure cannot become expected refusal", () => assertConfigSchemaRefusal({ ...receipt, ...changed }, path));
const projected = projectConfigCommand("config.apply", ["gateway", "call", "config.apply", "--params", JSON.stringify({ raw: "PRIVATE_CONFIG_NOT_EXPORTABLE" })], receipt);
assert.ok(!JSON.stringify({ refusal, projected }).includes("PRIVATE_CONFIG_NOT_EXPORTABLE")); assert.equal(projected.originalStdout.bytes, Buffer.byteLength(receipt.stdout)); assert.equal(projected.originalStdout.sha256, createHash("sha256").update(receipt.stdout).digest("hex"));
const diagnostics = nativeDiagnostics(`${JSON.stringify({ "0": JSON.stringify({ component: "CodexHarness", event: "turn.terminal", hasThreadId: true, hasTurnId: true, kind: "review", outcome: "completed" }) })}\nnot-json\n${JSON.stringify({ "0": "unknown" })}`); assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].threadId, undefined);
assertSafeHostLog(JSON.stringify({ "0": JSON.stringify({ component: "CodexHarness", event: "turn.terminal", hasThreadId: true }) }));
for (const raw of [JSON.stringify({ channels: { telegram: { botToken: "PRIVATE_CONFIG_NOT_EXPORTABLE" } } }), JSON.stringify({ "0": JSON.stringify({ models: { providers: { own: { apiKey: "PRIVATE_CONFIG_NOT_EXPORTABLE" } } } }) })]) refuse("raw config debug export blocked", () => assertSafeHostLog(raw));
const ordinary = { fixture: { ordinary: true, sessionId: "stable", tag }, row: { name: "ordinary", sessionId: "stable", status: "running", lifecycle: "awaiting_user_input", pendingPlanApproval: false, backendRef: { conversationId: "native-thread", runId: "native-turn" }, route: { provider: "telegram", target: "501002", accountId: "default" } }, completion: { nativeCompleted: true, caseTag: tag, threadId: "native-thread", turnId: "native-turn" } };
const wake = `Coding agent session turn ended.\nName: ordinary\nID: stable\nStatus: running\nLifecycle: awaiting_user_input\noriginRoute: ${JSON.stringify(ordinary.row.route)}\nTo tell the user anything, use message(action='send', final=true) to originRoute`;
const parentRequest = { tools: [{ type: "function", name: "tool_search" }], input: [{ role: "user", content: wake }] };
const selected = selectOrdinaryCompletion(parentRequest, [ordinary]); assert.equal(selected.cycle, "stable/native-turn/turn-ended"); assert.equal(selected.ordinary, ordinary.row);
const completed = structuredClone(ordinary); completed.row.status = "done"; completed.row.lifecycle = "terminal";
assert.equal(selectOrdinaryCompletion({ ...parentRequest, input: [{ role: "user", content: `[ordinary] Completed. ID: stable\noriginRoute: ${JSON.stringify(ordinary.row.route)}\nTo tell the user anything, use message(action='send', final=true) to originRoute` }] }, [completed]).cycle, "stable/native-turn/completed");
assert.equal(selectOrdinaryCompletion({ ...parentRequest, tools: [] }, [ordinary]), undefined);
assert.equal(selectOrdinaryCompletion({ ...parentRequest, input: [{ role: "user", content: `Quoted previous wake:\n${wake}` }] }, [ordinary]), undefined);
assert.equal(selectOrdinaryCompletion({ ...parentRequest, input: [{ role: "user", content: wake }, { role: "user", content: "new ordinary user message" }] }, [ordinary]), undefined);
for (const [label, change] of [["foreign owner ID", (copy) => { copy.row.sessionId = "other"; }], ["foreign owner name", (copy) => { copy.row.name = "other"; }], ["goal owner", (copy) => { copy.row.goalTaskId = "g"; }], ["unregistered ordinary", (copy) => { copy.fixture.ordinary = false; }], ["missing native completion", (copy) => { copy.completion.nativeCompleted = false; }], ["different backend", (copy) => { copy.completion.threadId = "foreign"; }], ["different current cycle", (copy) => { copy.completion.turnId = "foreign"; }], ["wrong native case", (copy) => { copy.completion.caseTag = "foreign"; }], ["foreign actual route", (copy) => { copy.row.route.accountId = "foreign"; }], ["hidden original thread", (copy) => { copy.row.route.threadId = "foreign"; }], ["changed actual status", (copy) => { copy.row.status = "done"; }], ["still awaiting plan", (copy) => { copy.row.pendingPlanApproval = true; }]]) { const copy = structuredClone(ordinary); change(copy); refuse(label, () => selectOrdinaryCompletion(parentRequest, [copy])); }
refuse("duplicate registered ordinary owners", () => selectOrdinaryCompletion(parentRequest, [ordinary, ordinary]));
refuse("duplicate route lines", () => selectOrdinaryCompletion({ ...parentRequest, input: [{ role: "user", content: `${wake}\noriginRoute: ${JSON.stringify(ordinary.row.route)}` }] }, [ordinary]));
for (const changedRoute of [{ provider: "telegram", target: "other", accountId: "default" }, { provider: "telegram", target: "501002", accountId: null }, { provider: "telegram", target: "501002", accountId: "default", threadId: "foreign" }]) refuse("wake actual route mismatch", () => selectOrdinaryCompletion({ ...parentRequest, input: [{ role: "user", content: wake.replace(JSON.stringify(ordinary.row.route), JSON.stringify(changedRoute)) }] }, [ordinary]));
const rootThread = "01a00000-0000-7000-8000-000000000001", childThread = "01a00000-0000-7000-8000-000000000002";
const reviewExpected = { instructions: `${tag}: unique offline review action`, startedAt: "2026-10-01T00:00:00.000Z", threadId: rootThread };
const canonical = { thread_id: childThread, turn_id: "child-turn", parent_thread_id: rootThread, parent_turn_id: "outer-review-turn", request_kind: "turn", subagent_kind: "review" };
const reviewInput = { client_metadata: { "x-codex-turn-metadata": JSON.stringify(canonical), thread_id: childThread, turn_id: "child-turn", "x-codex-parent-thread-id": rootThread, "x-openai-subagent": "review" }, input: [{ role: "user", content: reviewExpected.instructions }] };
const relation = reviewDelegate(reviewInput, reviewExpected); assert.equal(relation.originalThreadId, rootThread); assert.equal(relation.childThreadId, childThread);
for (const [label, field, value] of [["wrong parent", "parent_thread_id", childThread], ["not a review", "subagent_kind", "other"], ["original inference is not delegate", "thread_id", rootThread], ["missing parent turn", "parent_turn_id", ""], ["wrong request kind", "request_kind", "other"]]) { const changed = { ...canonical, [field]: value }; refuse(label, () => reviewDelegate({ ...reviewInput, client_metadata: { ...reviewInput.client_metadata, "x-codex-turn-metadata": JSON.stringify(changed) } }, reviewExpected)); }
for (const changed of [{ thread_id: rootThread }, { turn_id: "other" }, { "x-codex-parent-thread-id": childThread }, { "x-openai-subagent": "other" }, { "x-codex-turn-metadata": undefined }]) refuse("conflicting/missing canonical review authority", () => reviewDelegate({ ...reviewInput, client_metadata: { ...reviewInput.client_metadata, ...changed } }, reviewExpected));
refuse("quoted review instruction", () => reviewDelegate({ ...reviewInput, input: [{ role: "user", content: `> ${reviewExpected.instructions}` }] }, reviewExpected));
refuse("stale prior review instruction", () => reviewDelegate({ ...reviewInput, input: [...reviewInput.input, { role: "user", content: "new unrelated user action" }] }, reviewExpected));
const reviewOutput = { findings: [], overall_correctness: "patch is correct", overall_explanation: "own-action-nonce review completed", overall_confidence_score: 1 };
const nativeExpected = { ...relation, workdir: "/owned/cwd", output: reviewOutput };
const event = (payload) => ({ type: "event_msg", payload });
const nativeLines = [{ type: "session_meta", payload: { id: rootThread, cwd: "/owned/cwd", cli_version: "0.159.3", base_instructions: "PRIVATE_ROLLOUT_NOT_EXPORTABLE" } }, event({ type: "task_started", turn_id: relation.originalTurnId }), event({ type: "entered_review_mode", turn_id: relation.originalTurnId, target: { type: "custom", instructions: relation.instructions } }), event({ type: "exited_review_mode", turn_id: relation.originalTurnId, review_output: reviewOutput }), event({ type: "task_complete", turn_id: relation.originalTurnId })];
const projection = projectNativeReview(nativeLines, nativeExpected, true); assert.equal(projection.nativeReviewCompleted, true); assert.ok(!JSON.stringify(projection).includes("PRIVATE_ROLLOUT_NOT_EXPORTABLE"));
const paginated = structuredClone(nativeLines); paginated[2] = event({ type: "item_completed", thread_id: rootThread, turn_id: relation.originalTurnId, item: { type: "EnteredReviewMode", id: "real-item", target: { type: "custom", instructions: relation.instructions } } }); paginated[3] = event({ type: "item_completed", thread_id: rootThread, turn_id: relation.originalTurnId, item: { type: "ExitedReviewMode", id: "real-exit", review_output: reviewOutput } });
projectNativeReview(paginated, nativeExpected, true); projectNativeReview(nativeLines.slice(0, 3), nativeExpected, false);
for (const [label, change] of [["wrong original rollout ID", (copy) => { copy[0].payload.id = childThread; }], ["wrong owned cwd", (copy) => { copy[0].payload.cwd = "foreign"; }], ["wrong native version", (copy) => { copy[0].payload.cli_version = "other"; }], ["replayed start", (copy) => { copy.push(copy[1]); }], ["wrong current review turn", (copy) => { copy[2].payload.turn_id = "old"; }], ["wrong action nonce", (copy) => { copy[2].payload.target.instructions = "other"; }], ["missing actual exit", (copy) => { copy.splice(3, 1); }], ["native fallback", (copy) => { copy[3].payload.review_output = { ...reviewOutput, overall_explanation: JSON.stringify(reviewOutput) }; }], ["missing actual outer completion", (copy) => { copy.pop(); }], ["actual native failure", (copy) => { copy.at(-1).payload.error = { message: "real failure" }; }]]) { const copy = structuredClone(nativeLines); change(copy); refuse(label, () => projectNativeReview(copy, nativeExpected, true)); }
for (const field of Object.keys(reviewOutput)) { const copy = structuredClone(reviewOutput); delete copy[field]; refuse("missing full review schema field", () => assertFullReviewOutput(copy, reviewOutput)); }
for (const changed of [{ findings: "" }, { findings: [{}] }, { overall_correctness: "unknown" }, { overall_explanation: "different-nonce" }, { overall_confidence_score: "1" }, { overall_confidence_score: 0 }, { extra: "unknown" }]) refuse("partial/malformed/mismatched full review", () => assertFullReviewOutput({ ...reviewOutput, ...changed }, reviewOutput));
// Actual owned filesystem controls exercise the bounded reader, not a native session.
const directory = mkdtempSync(join(tmpdir(), "oca501-review-control-"));
try {
  const root = join(directory, "codex"), sessions = join(root, "sessions"); mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const rollout = join(sessions, `rollout-offline-${rootThread}.jsonl`);
  const raw = nativeLines.map((line) => JSON.stringify(line)).join("\n") + "\n"; writeFileSync(rollout, raw, { mode: 0o600 });
  const readback = readNativeReview(root, nativeExpected, true);
  assert.equal(readback.originalBytes, Buffer.byteLength(raw)); assert.equal(readback.originalSha256, createHash("sha256").update(raw).digest("hex"));
  assert.equal(readback.relativePath, `sessions/rollout-offline-${rootThread}.jsonl`); assert.ok(!JSON.stringify(readback).includes("PRIVATE_ROLLOUT_NOT_EXPORTABLE"));
  writeFileSync(rollout, paginated.map((line) => JSON.stringify(line)).join("\n") + "\n"); readNativeReview(root, nativeExpected, true);
  writeFileSync(rollout, raw);
  const duplicate = join(sessions, `rollout-second-${rootThread}.jsonl`); writeFileSync(duplicate, raw);
  refuse("actual duplicate native rollout", () => readNativeReview(root, nativeExpected, true)); rmSync(duplicate);
  const linkedRoot = join(directory, "linked-root"); symlinkSync(root, linkedRoot);
  refuse("actual symlink CODEX_HOME", () => readNativeReview(linkedRoot, nativeExpected, true));
  const outside = join(directory, "outside.jsonl"); renameSync(rollout, outside); symlinkSync(outside, rollout);
  refuse("actual symlink native file", () => readNativeReview(root, nativeExpected, true)); rmSync(rollout); renameSync(outside, rollout);
  const linkedDirectory = join(sessions, "linked-directory"); symlinkSync(directory, linkedDirectory);
  refuse("actual symlink native directory", () => readNativeReview(root, nativeExpected, true)); rmSync(linkedDirectory);
  writeFileSync(rollout, "PRIVATE_ROLLOUT_NOT_EXPORTABLE malformed json");
  let retained; try { readNativeReview(root, nativeExpected, true); } catch (error) { retained = error; }
  assert.ok(retained); assert.ok(!String(retained).includes("PRIVATE_ROLLOUT_NOT_EXPORTABLE")); assert.match(String(retained), /raw rollout excluded; bytes=\d+; sha256=[a-f0-9]{64}/); negatives.push("malformed actual native file retains safe hash only");
  writeFileSync(rollout, Buffer.alloc(4 * 1024 * 1024 + 1, 32)); refuse("actual native file bound without truncation", () => readNativeReview(root, nativeExpected, true));
  rmSync(rollout); refuse("actual missing native file", () => readNativeReview(root, nativeExpected, true));
  refuse("malformed original UUID before readback", () => readNativeReview(root, { ...nativeExpected, originalThreadId: "../foreign" }, true));
} finally { rmSync(directory, { recursive: true, force: true }); }
console.log(JSON.stringify({ classification: "OFFLINE_ASSERTION_CONTROLS_ONLY", goldenRequestSha256: createHash("sha256").update(bytes).digest("hex"), positiveGroups: 15, negativeControls: negatives.length, negatives }));
