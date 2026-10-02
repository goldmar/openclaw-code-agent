// Synthetic source-role/attribution enforcement; never real host acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { actualToolPayload, assertActualSendResult } from "./oca501-config-receipt.mjs";
import { hostLogEvidence, assertSafeHostLog, assertCompletionTerminal } from "./oca501-lifecycle-protocol.mjs";
import { pinnedFileMessage, bindCanonicalFunctionTransportRequest } from "./oca501-host-log-projection.mjs";
import { sourceLogObservation, LOG_SOURCE_TABLE_SHA256 } from "./oca501-log-source-observation.mjs";
const started = performance.now(), sha = (value) => createHash("sha256").update(value).digest("hex"), copy = (value) => structuredClone(value);
let groups = 0, negatives = 0;
const authority = { candidateSha: "a".repeat(40), helperSha256: "b".repeat(64), hostCommit: "c074824a27c96d3983043f9eeb33823cd1772d8c", agentIds: ["own-agent"], sessionIds: ["own-session"], channels: ["telegram"], responsesStarts: [] };
const diagnostic = { component: "CodexHarness", event: "turn.terminal", kind: "user", outcome: "completed", hasThreadId: true, hasTurnId: true };
const logger = (...args) => { const row = { ...Object.fromEntries(args.map((value, index) => [index, value])), _meta: { logLevelId: 2, logLevelName: "DEBUG" } }; row.message = pinnedFileMessage(row); return row; };
const assess = (text) => { try { assertSafeHostLog(text); return { safe: true }; } catch { return { safe: false }; } };
const project = (row) => {
  const bytes = Buffer.from(JSON.stringify(row)), original = Buffer.from(bytes), result = hostLogEvidence(bytes, { sourceAuthority: authority });
  assert.equal(result.sourceProjectedComplete, true); assert.equal(result.completeStreamSafe, false); assert.deepEqual(bytes, original);
  assert.equal(result.original.sha256, sha(bytes)); assertSafeHostLog(result.projectedText); return result;
};
const refuse = (row) => { const result = hostLogEvidence(Buffer.from(typeof row === "string" ? row : JSON.stringify(row)), { sourceAuthority: authority }); assert.notEqual(result.sourceProjectedComplete, true); assert.equal(result.completeStreamSafe, false); negatives++; return result; };
const message = project(logger({ message: "Harmless é🐱 original message." })); assert.equal(JSON.parse(message.projectedText).message, "Harmless é🐱 original message."); groups++;
// A newly normalized JSON-looking string must preserve its MESSAGE role.
const edge = project(logger({ message: '{"module":"safe"}' })); assert.equal(JSON.parse(edge.projectedText).message, '{"module":"safe"}'); assert.equal(edge.audit.records[0].sourceRoles.bindingPosition, null); groups++;
for (const binding of [JSON.stringify({ plugin: "openclaw-code-agent", subsystem: "codex" }), JSON.stringify({ module: "safe", storeKey: "owned" })]) {
  const result = project(logger(binding, {}, { message: JSON.stringify(diagnostic) }));
  const normalized = JSON.parse(result.projectedText); assert.equal(normalized["0"], binding); assert.equal(Object.hasOwn(normalized, "1"), false); assert.equal(normalized.message, JSON.stringify(diagnostic));
  assert.equal(result.audit.retainedDiagnostics[0].diagnostic.kind, "user");
  assert.ok(result.audit.records[0].sourceCases.includes("EMPTY_METADATA_ZERO_FIELDS"));
}
groups++;
const capped = project(logger({ message: "x".repeat(4095) + "🐱tail" })); assert.equal(JSON.parse(capped.projectedText)["0"], "x".repeat(4095) + "🐱tail"); assert.equal(JSON.parse(capped.projectedText).message, "x".repeat(4095) + "...(truncated)"); groups++;
for (const row of [
  logger({ message: "safe", hidden: "SYNTHETIC_PRIVATE_VALUE" }), logger({ message: {} }), logger({ message: null }),
  logger({ message: '{"gateway":{"auth":{"token":"SYNTHETIC_PRIVATE_VALUE"}}}' }),
  logger({ message: String.raw`error "{\"gateway\":{\"auth\":{\"token\":\"SYNTHETIC_PRIVATE_VALUE\"}}}"` }),
  logger('{"module":"safe","gateway":{"auth":{"token":"SYNTHETIC_PRIVATE_VALUE"}}}', {}, { message: "safe" }),
  logger('{"plugin":"openclaw-code-agent","subsystem":"codex","foreign":"SYNTHETIC_PRIVATE_VALUE"}', {}, { message: "safe" }),
  { ...logger({ message: "safe" }), message: "Wrong original derivation" }, logger({ message: "safe" }, {}),
  { ...logger({ message: "safe" }), _meta: { logLevelId: 999, logLevelName: "DEBUG" } },
]) refuse(row);
groups++;
const all = [logger({ message: "safe" }), logger({ privateDynamicKey: "SYNTHETIC_PRIVATE_VALUE" }), logger('{"plugin":"openclaw-code-agent","subsystem":"codex"}', {}, JSON.stringify(diagnostic)), logger({ otherPrivateKey: [] })];
const mixed = refuse(all.map(JSON.stringify).join("\n") + "\n"), accounting = mixed.sourceProjectionAttempt.observations;
assert.equal(accounting.accountingComplete, true); assert.equal(accounting.recordCount, 5); assert.equal(accounting.projectedRecords, 2); assert.equal(accounting.blockedRecords, 2); assert.equal(accounting.safeRecords, 1);
assert.deepEqual(accounting.blockedDetails.map((row) => row.record), [1, 3]); assert.ok(!JSON.stringify(mixed).includes("SYNTHETIC_PRIVATE_VALUE") && !JSON.stringify(mixed).includes("privateDynamicKey"));
assert.equal(mixed.rejectedStreamDiagnostic.failedLineDetails.find((row) => row.line === 0).sourceObservation.status, "VALIDATED_SOURCE_PROJECTION; see complete record audit"); groups++;
const observe = (row) => sourceLogObservation(JSON.stringify(row), assess);
for (const [binding, expected] of [
  [{ plugin: "openclaw-code-agent", subsystem: "codex" }, "CANDIDATE_SOURCE_BINDING_MATCH"],
  [{ subsystem: "agent/embedded" }, "PINNED_AGENT_EMBEDDED_BINDING_MATCH"],
  [{ subsystem: "agents/harness" }, "PINNED_AGENTS_HARNESS_BINDING_MATCH"],
  [{ subsystem: "diagnostic" }, "PINNED_DIAGNOSTIC_BINDING_MATCH"],
]) assert.equal(observe(logger(JSON.stringify(binding), {})).binding, expected);
for (const binding of [{ plugin: "foreign", subsystem: "codex" }, { plugin: "openclaw-code-agent", subsystem: "foreign" }, { subsystem: "diagnostic", hidden: "SYNTHETIC_PRIVATE_VALUE" }]) { assert.equal(observe(logger(JSON.stringify(binding))).binding, "UNKNOWN_SOURCE_BINDING"); negatives++; }
groups++;
for (const [meta, name, id] of [
  [{}, "MISSING", "MISSING"], [{ logLevelId: 2, logLevelName: "noncanonical-private" }, "NONCANONICAL_STRING", 2],
  [{ logLevelId: 999, logLevelName: "DEBUG" }, "DEBUG", "OUT_OF_RANGE_INTEGER"], [{ logLevelId: null, logLevelName: {} }, "WRONG_TYPE", "WRONG_TYPE"],
]) { const result = observe({ ...logger({ unknownPrivateKey: "SYNTHETIC_PRIVATE_VALUE" }), _meta: meta }); assert.equal(result.levelName, name); assert.equal(result.levelId, id); assert.equal(result.levelPairMatches, false); assert.ok(!JSON.stringify(result).includes("unknownPrivateKey") && !JSON.stringify(result).includes("SYNTHETIC_PRIVATE_VALUE") && !JSON.stringify(result).includes("noncanonical-private")); negatives++; }
assert.equal(sourceLogObservation('{"broken":', assess).status, "INVALID_WHOLE_JSON");
assert.equal(observe(logger({ unknown: Array.from({ length: 130 }, () => ({})) })).status, "PARTIAL_OBSERVATION");
assert.equal(observe(logger(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`private${i}`, 0])))).status, "PARTIAL_OBSERVATION");
let deep = { unknownPrivateKey: "SYNTHETIC_PRIVATE_VALUE" }; for (let depth = 0; depth < 18; depth++) deep = { candidates: deep };
const depthBound = observe(logger(deep)); assert.equal(depthBound.status, "PARTIAL_OBSERVATION"); assert.equal(depthBound.visitedNodes, depthBound.nodes.length);
assert.equal(observe(logger({ candidates: [{ selectedHarnessId: "SYNTHETIC_PRIVATE_VALUE", selectedReason: "SYNTHETIC_PRIVATE_VALUE" }] })).nodes.find((node) => node.known?.STRING?.includes("selectedHarnessId")).known.STRING.includes("selectedHarnessId"), true); groups++;

const runId = "own-run", sessionKey = "own-parent-key", sessionId = "own-physical-parent", ownerSession = "own-native-session", goalId = "own-goal";
const tool = { id: "own-tool-id", name: "message", source: "openclaw", sourceName: "core" };
const description = { ...tool, parameters: { type: "object", properties: { action: { type: "string" } } } };
const route = { provider: "telegram", target: "501002" };
const summary = "Own source summary.";
const sendArgs = { action: "send", channel: "telegram", target: "501002", message: summary, final: true };
const sendResult = { tool, result: { details: { ok: true } } };
const calls = [
  { id: "search-call", itemId: "search-item", name: "tool_search", stage: "search", args: { query: "message send", limit: 5 }, request: 1 },
  { id: "describe-call", itemId: "describe-item", name: "tool_describe", stage: "describe", args: { id: tool.id }, request: 2 },
  { id: "send-call", itemId: "send-item", name: "tool_call", stage: "send", args: { id: tool.id, args: sendArgs }, request: 3 },
];
for (const [index, output] of [[0, [tool]], [1, description]]) calls[index].actualOutput = { type: "function_call_output", call_id: calls[index].id, output: JSON.stringify(output) };
const state = { ownerId: goalId, goalId, sessionId: ownerSession, wakeHash: sha("Own original wake"), route, summary, calls, tool, description };
const requests = calls.map((call, index) => {
  const body = { model: "gpt-6-luna", stream: true, input: [{ type: "message", role: "user", content: "Own current wake" }], tools: [{ type: "function", name: call.name, parameters: { type: "object" } }] };
  return { body, request: { transport: "host-parent", parentRequestClassification: { kind: "embedded-parent" }, hasParentTools: true, responseCompleted: true, emittedType: "function_call", responseId: `own-response-${index}`, requestIndex: index + 1, bodyHash: sha(JSON.stringify(body)), parentCall: call, parentDelivery: { goalId, sessionId: ownerSession, wakeHash: state.wakeHash }, emittedFunctionCall: { id: call.itemId, call_id: call.id, type: "function_call", name: call.name, arguments: JSON.stringify(call.args) } } };
});
const assistant = calls.map((call, index) => ({ role: "assistant", responseId: requests[index].request.responseId, __openclaw: { runId, id: `physical-${index}`, recordTimestampMs: index, transcriptPosition: index, seq: index }, content: [{ type: "toolCall", id: `${call.id}|${call.itemId}`, name: call.name, arguments: call.args }] }));
const finalResult = { role: "toolResult", toolName: "tool_call", toolCallId: "send-call|send-item", __openclaw: { runId, id: "physical-result" }, content: [{ type: "text", text: JSON.stringify(sendResult) }], isError: false };
const canonicalHistory = { sessionKey, sessionId, messages: [...assistant, finalResult] };
const row = { sessionId: ownerSession, goalTaskId: goalId, route, completionWakeRunId: runId, completionWakeIssuedAt: 1, completionWakeSucceededAt: 2, completionWakeRoutedReply: true, completionWakeOutcomeKey: `goal:${goalId}`, completionWakeSummaryFact: { required: true, producer: "goal", outcomeKey: `goal:${goalId}` }, completionWakeSubmissionState: "unknown" };
const proof = { runId, sessionKey, sessionId, state, row, task: { id: goalId, sessionId: ownerSession, status: "succeeded" }, terminal: { runId, status: "ok", terminalReceipt: { runId, sourceReplyDelivered: true } }, wire: [{ method: "sendMessage", respondedAt: "actual-own-time", params: JSON.stringify({ chat_id: 501002, text: summary }), result: { text: summary, chat: { id: 501002 }, message_id: 1 } }], canonicalHistory };
function fixture(index = 0) { return copy({ request: requests[index].request, binding: { receipts: [{ method: "chat.history", params: { sessionKey }, value: canonicalHistory }], requests: requests.map((entry) => entry.request), sessionKey, sessionId, body: requests[index].body, settlements: [proof] } }); }
const bind = ({ request, binding }) => bindCanonicalFunctionTransportRequest(request, binding, assertCompletionTerminal);
for (let index = 0; index < 3; index++) assert.equal(bind(fixture(index)).runId, runId); groups++;
const reread = fixture(); reread.binding.receipts.push(copy(reread.binding.receipts[0])); assert.equal(bind(reread).runId, runId); groups++;
const ordinary = fixture(2); const p = ordinary.binding.settlements[0]; delete p.state.goalId; p.state.ordinarySessionId = ownerSession; p.state.ownerId = ownerSession; p.state.ordinaryCycle = "current-own-cycle/turn-ended"; p.state.actualNativeCompletion = { nativeCompleted: true, threadId: "own-thread", turnId: "own-live-turn", operation: "user" }; p.row = { sessionId: ownerSession, route, backendRef: { conversationId: "own-thread", runId: "old-recovery-turn" } }; p.kind = "turn-ended"; p.ordinaryCycle = p.state.ordinaryCycle; p.wakeHash = p.state.wakeHash; delete ordinary.request.parentDelivery.goalId; ordinary.request.parentDelivery.ordinarySessionId = ownerSession; assert.equal(bind(ordinary).runId, runId); groups++;
const deny = (change, base = fixture()) => { change(base); assert.equal(bind(base), undefined); negatives++; };
for (const change of [
  (f) => f.request.responseCompleted = false, (f) => f.request.emittedType = "message", (f) => delete f.request.emittedFunctionCall,
  (f) => f.request.emittedFunctionCall.call_id = "foreign", (f) => f.request.emittedFunctionCall.id = "foreign", (f) => f.request.emittedFunctionCall.name = "foreign",
  (f) => f.request.emittedFunctionCall.arguments = '{}', (f) => f.request.emittedFunctionCall.foreign = true, (f) => f.request.parentCall.stage = "send",
  (f) => f.request.requestIndex = 99, (f) => f.request.responseId = "foreign", (f) => f.request.parentDelivery.wakeHash = "foreign",
  (f) => f.binding.sessionId = "foreign", (f) => f.binding.sessionKey = "foreign", (f) => f.binding.requests.push(copy(f.request)),
  (f) => f.binding.body.input[0].content = "Foreign replay", (f) => f.binding.body.tools = [], (f) => f.binding.settlements = [],
  (f) => f.binding.receipts[0].value.messages.push(copy(f.binding.receipts[0].value.messages[0])),
  (f) => f.binding.receipts[0].value.messages[0].__openclaw.truncated = true, (f) => delete f.binding.receipts[0].value.messages[0].__openclaw.id,
  (f) => f.binding.receipts[0].value.messages[0].content[0].id = "search-call", (f) => f.binding.receipts[0].value.messages[0].content[0].arguments = {},
  (f) => { const h = copy(f.binding.receipts[0]); h.value.messages[0].__openclaw.seq = 999; f.binding.receipts.push(h); },
  (f) => f.binding.settlements[0].state.calls.push(copy(f.request.parentCall)),
  (f) => f.binding.settlements[0].terminal.status = "error", (f) => f.binding.settlements[0].terminal.terminalReceipt.sourceReplyDelivered = false,
  (f) => f.binding.settlements[0].wire = [], (f) => f.binding.settlements[0].wire.push(copy(f.binding.settlements[0].wire[0])),
  (f) => f.binding.settlements[0].wire[0].result.chat.id = 999, (f) => f.binding.settlements[0].wire[0].params = '{"reply_to_message_id":1}',
  (f) => f.binding.settlements[0].row.completionWakeSummaryFact.required = false, (f) => f.binding.settlements[0].row.completionWakeSummaryFact.producer = "terminal",
  (f) => f.binding.settlements[0].row.completionWakeSkippedAt = 3, (f) => f.binding.settlements[0].row.completionWakeFailedAt = 3,
  (f) => delete f.binding.settlements[0].row.completionWakeIssuedAt, (f) => delete f.binding.settlements[0].row.completionWakeSucceededAt,
  (f) => f.binding.settlements[0].row.completionWakeSummaryRequired = true,
  (f) => f.binding.settlements[0].row.completionWakeSummaryRequired = null, (f) => f.binding.settlements[0].row.completionWakeSummaryRequired = false,
  (f) => delete f.binding.settlements[0].row.completionWakeSummaryFact, (f) => f.binding.settlements[0].row.completionWakeSubmissionState = "not_submitted",
  (f) => f.binding.settlements[0].row.completionWakeSkipReason = "skipped",
  (f) => f.binding.settlements[0].row.completionWakeRunId = "foreign",
  (f) => f.binding.settlements[0].canonicalHistory.messages.at(-1).toolCallId = "send-call",
  (f) => f.binding.settlements[0].canonicalHistory.messages.at(-1).content[0].text = "Display capped preview", (f) => f.binding.settlements[0].row.completionWakeOutcomeKey = "foreign",
  (f) => f.binding.settlements[0].canonicalHistory.messages.at(-1).__openclaw.truncated = true,
  (f) => f.binding.settlements[0].canonicalHistory.messages.at(-1).isError = true,
  (f) => f.binding.settlements[0].canonicalHistory.messages.at(-1).content[0].text = '{"status":"error","error":"SYNTHETIC_PRIVATE_VALUE"}',
  (f) => { f.request.parentCall.actualOutput.output = '{"status":"error","error":"SYNTHETIC_PRIVATE_VALUE"}'; f.binding.settlements[0].state.calls[0] = copy(f.request.parentCall); },
  (f) => { delete f.request.parentCall.actualOutput; f.binding.settlements[0].state.calls[0] = copy(f.request.parentCall); },
]) deny(change);
for (const change of [(f) => f.binding.settlements[0].state.actualNativeCompletion.nativeCompleted = false, (f) => f.binding.settlements[0].state.actualNativeCompletion.threadId = "foreign", (f) => f.binding.settlements[0].ordinaryCycle = "foreign"]) deny(change, copy(ordinary));
groups++;

// The known Q35 grouping is reproduced only structurally using synthetic
// values. Original byte spans/hashes are never assigned to generated lines.
const qShapes = [
  ...Array.from({ length: 12 }, () => logger({ message: "Harmless synthetic source message." })),
  ...Array.from({ length: 2 }, () => logger('{"module":"safe","storeKey":"owned"}', {}, "Synthetic harmless metadata")),
  ...Array.from({ length: 5 }, () => logger({ unknown1: "SYNTHETIC_PRIVATE_VALUE", unknown2: "SYNTHETIC_PRIVATE_VALUE", unknown3: 1, unknown4: false, unknown5: [] })),
  ...Array.from({ length: 4 }, () => logger({ unknown: Array.from({ length: 129 }, () => ({ unknownPrivate: "SYNTHETIC_PRIVATE_VALUE" })) })),
  ...Array.from({ length: 2 }, () => ({ ...logger({ provider: "SYNTHETIC_PRIVATE_VALUE", modelId: "SYNTHETIC_PRIVATE_VALUE", sessionKey: "SYNTHETIC_PRIVATE_VALUE", agentId: "SYNTHETIC_PRIVATE_VALUE", selectedHarnessId: "SYNTHETIC_PRIVATE_VALUE", selectedReason: "SYNTHETIC_PRIVATE_VALUE", candidates: [] }), agent_id: "own-agent", session_id: "own-session", _meta: { logLevelId: 2, logLevelName: "SYNTHETIC_PRIVATE_VALUE" } })),
  ...Array.from({ length: 2 }, () => logger("[responses] start apiKey=SYNTHETIC_PRIVATE_VALUE")),
  ...Array.from({ length: 2 }, () => logger(Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`unknown${index}`, index < 6 ? "SYNTHETIC_PRIVATE_VALUE" : index < 8 ? null : index === 8 ? [] : index])))),
  ...Array.from({ length: 6 }, () => logger('{"plugin":"openclaw-code-agent","subsystem":"codex"}', JSON.stringify(diagnostic))),
];
assert.equal(qShapes.length, 35); assert.equal(qShapes.filter((row) => observe(row).status === "PARTIAL_OBSERVATION").length, 4);
const qText = "Harmless original record.\n".repeat(3300) + qShapes.map(JSON.stringify).join("\n") + "\n", qResult = hostLogEvidence(Buffer.from(qText), { sourceAuthority: authority });
assert.equal(qResult.completeStreamSafe, false); assert.equal(qResult.sourceProjectionAttempt.observations.accountingComplete, true);
assert.ok(Buffer.byteLength(JSON.stringify(qResult.rejectedStreamDiagnostic)) <= 65536);
assert.ok(!JSON.stringify(qResult).includes("SYNTHETIC_PRIVATE_VALUE")); groups++;
// The final wrapper caps all new observations/digest fields. A real detail
// overflow retains finite complete traversal counts while excluding details.
const overflowing = hostLogEvidence(Buffer.from(Array.from({ length: 64 }, () => JSON.stringify(qShapes[19])).join("\n")), { sourceAuthority: authority });
assert.equal(overflowing.rejectedStreamDiagnostic.diagnosticStatus, "DIAGNOSTIC_OUTPUT_BOUND_EXCEEDED"); assert.equal(overflowing.rejectedStreamDiagnostic.failedLines, 64); assert.equal(overflowing.rejectedStreamDiagnostic.capturedLines, 64); assert.equal(overflowing.rejectedStreamDiagnostic.inspectedLines, 64); assert.equal(overflowing.rejectedStreamDiagnostic.uninspectedLines, 0); assert.equal(overflowing.rejectedStreamDiagnostic.detailContentExcluded, true); assert.ok(Buffer.byteLength(JSON.stringify(overflowing.rejectedStreamDiagnostic)) <= 65536); assert.ok(!JSON.stringify(overflowing).includes("SYNTHETIC_PRIVATE_VALUE")); negatives++; groups++;
const severityOnly = logger(JSON.stringify(diagnostic)); severityOnly._meta = { logLevelId: 999 };
const safeSeverityFailure = refuse(JSON.stringify(logger({ message: "safe" })) + "\n" + JSON.stringify(severityOnly));
assert.equal(safeSeverityFailure.rejectedStreamDiagnostic.projectionBlockedGuardSafeLines, 1);
const observedSafe = safeSeverityFailure.rejectedStreamDiagnostic.failedLineDetails.find((detail) => detail.originalLineGuardSafe);
assert.equal(observedSafe.sourceObservation.levelId, "OUT_OF_RANGE_INTEGER"); assert.equal(observedSafe.sourceObservation.levelName, "MISSING"); groups++;
let originalQ, actualSourceReference;
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index], path = process.argv[index + 1]; assert.ok(path);
  if (flag === "--q-observations") {
    const bytes = readFileSync(path), receipts = bytes.toString("utf8").split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).filter((value) => value.status === "READ_ONLY_CLASSIFICATION_NOT_ACCEPTANCE");
    assert.equal(receipts.length, 1); const q = receipts[0];
    assert.equal(q.failures.length, 35); assert.equal(q.capturedLines, 3389); assert.equal(q.failures.filter((failure) => failure.observation.inspectionComplete).length, 31); assert.equal(q.failures.filter((failure) => !failure.observation.inspectionComplete).length, 4);
    originalQ = { closedReceiptSha256: sha(bytes), originalFailedRecords: q.failures.length, scope: "Original closed identities/counts only; synthetic structure replay is not original-value replay or runtime acceptance" }; groups++;
  } else {
    assert.equal(flag, "--source-reference");
    const files = readdirSync(path).filter((name) => /^source-delivery-.*\.json$/.test(name)); assert.ok(files.length);
    let actualPairedCalls = 0, actualCompleteOutputs = 0;
    for (const name of files) {
      const reference = JSON.parse(readFileSync(join(path, name))), state = reference.protocol;
      for (const call of state.calls) {
        const pair = `${call.id}|${call.itemId}`;
        const canonical = reference.canonicalHistory.messages.filter((entry) => entry.role === "assistant" && entry.__openclaw?.runId === reference.retainedRunId && entry.content?.some((part) => part.type === "toolCall" && part.id === pair));
        assert.equal(canonical.length, 1); const part = canonical[0].content.find((part) => part.type === "toolCall" && part.id === pair); assert.equal(part.name, call.name); assert.deepEqual(part.arguments, call.args); actualPairedCalls++;
        if (call.actualOutput) { assert.equal(call.actualOutput.call_id, call.id); const output = actualToolPayload(call.actualOutput); if (call.stage === "describe") assert.deepEqual(output, state.description); if (call.stage === "send") assertActualSendResult(output, call.name, state.tool, call.id); actualCompleteOutputs++; }
      }
    }
    actualSourceReference = { files: files.length, actualPairedCalls, actualCompleteOutputs, scope: "Only genuinely recorded R6 call/args/canonical/output fields; absent newer SSE metadata not created, no new binder or host acceptance claim" }; groups++;
  }
}
console.log(JSON.stringify({ scope: "Offline C10R source-role/finite discriminator/E2 enforcement only", positiveGroups: groups, negativeControls: negatives, sourceTableSha256: LOG_SOURCE_TABLE_SHA256, qStructuralReplay: { records: qShapes.length, finalDiagnosticBytes: Buffer.byteLength(JSON.stringify(qResult.rejectedStreamDiagnostic)), diagnosticStatus: qResult.rejectedStreamDiagnostic.diagnosticStatus, accounting: { projected: qResult.sourceProjectionAttempt.observations.projectedRecords, blocked: qResult.sourceProjectionAttempt.observations.blockedRecords } }, originalQ, actualSourceReference, elapsedMs: performance.now() - started }));
