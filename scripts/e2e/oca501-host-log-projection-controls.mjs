import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hostLogEvidence, assertSafeHostLog, nativeDiagnostics, assertCompletionTerminal, assertVisibleCanonical } from "./oca501-lifecycle-protocol.mjs";
import { pinnedFileMessage, renderResponsesStart, expectedEmbeddedStarts, sourceSdkTimeout, bindCanonicalTransportRequest } from "./oca501-host-log-projection.mjs";

const started = performance.now(), sha = (value) => createHash("sha256").update(value).digest("hex");
let groups = 0, negatives = 0;
const body = { model: "gpt-6-luna", input: [{ type: "message", role: "user", content: "Own harmless fixture text." }], stream: true, max_output_tokens: 240, store: true };
const args = { body, bodySha256: sha(JSON.stringify(body)), provider: "oca501", model: body.model, baseUrl: "http://127.0.0.1:12345/host/v1", presence: "present" };
const start = renderResponsesStart(args);
const authority = { candidateSha: "a".repeat(40), helperSha256: "b".repeat(64), hostCommit: "c074824a27c96d3983043f9eeb33823cd1772d8c", agentIds: ["main"], sessionIds: ["own-session"], channels: ["telegram"], responsesStarts: [start] };
const terminal = { component: "CodexHarness", event: "turn.terminal", at: "2026-10-02T09:00:00.000Z", kind: "user", outcome: "completed", hasThreadId: true, hasTurnId: true };
const header = (level = "DEBUG") => ({ runtime: "Nodejs", runtimeVersion: "24.16.0", logLevelId: ["SILLY", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"].indexOf(level), logLevelName: level, name: "owned-log" });
function logger(payload, extras = {}, level = "DEBUG") {
  const record = { "0": JSON.stringify({ subsystem: "agent/embedded" }), "1": payload, _meta: header(level), ...extras };
  record.message = pinnedFileMessage(record); return record;
}
const observe = (record, ownAuthority = authority) => hostLogEvidence(Buffer.from(typeof record === "string" ? record : JSON.stringify(record)), { sourceAuthority: ownAuthority });
function rejected(record, ownAuthority = authority) {
  const result = observe(record, ownAuthority); assert.equal(result.completeStreamSafe, false); assert.notEqual(result.sourceProjectedComplete, true); assert.equal(result.rawCompleteStreamExcluded, true); negatives++;
  assert.ok(Buffer.byteLength(JSON.stringify(result.rejectedStreamDiagnostic)) <= 65536);
  return result;
}
function projected(record) {
  const original = Buffer.from(typeof record === "string" ? record : JSON.stringify(record)), copy = Buffer.from(original), result = observe(original.toString());
  assert.equal(result.sourceProjectedComplete, true); assert.equal(result.completeStreamSafe, false); assert.equal(result.rawContentExcluded, true); assert.equal(result.original.sha256, sha(original)); assert.deepEqual(original, copy);
  assertSafeHostLog(result.projectedText); assert.equal(result.projected.sha256, sha(result.projectedText));
  return result;
}

const contextRecord = logger(JSON.stringify(terminal), { agent_id: "main", session_id: "own-session", channel: "telegram" });
const context = projected(contextRecord); assert.equal(nativeDiagnostics(context.projectedText)[0].kind, "user"); assert.deepEqual(context.audit.records[0].omittedContextFields, ["AGENT_ID", "SESSION_ID", "CHANNEL"]); groups++;
for (const key of ["agent_id", "session_id", "channel"]) rejected({ ...contextRecord, [key]: "foreign" });
for (const [key, value] of [["session_id", {}], ["foreignHeader", true], ["agent_id", null]]) rejected({ ...contextRecord, [key]: value });
for (const level of ["UNKNOWN", "", undefined]) rejected({ ...contextRecord, _meta: { ...contextRecord._meta, logLevelName: level } });
rejected({ ...contextRecord, _meta: { ...contextRecord._meta, logLevelId: 3 } });

const detailsRecord = logger({ details: [terminal, { component: "CodexHarness", event: "turn.error", at: terminal.at, errorCode: "owned_expected_failure", reason: "Expected harmless fixture refusal" }] });
const details = projected(detailsRecord); assert.equal(details.audit.retainedDiagnostics.length, 2); assert.equal(details.audit.retainedDiagnostics[0].diagnostic.outcome, "completed"); assert.equal(details.audit.retainedDiagnostics[1].diagnostic.event, "turn.error"); groups++;
const nestedDetails = projected(logger(JSON.stringify({ details: [terminal] }))); assert.equal(nestedDetails.audit.retainedDiagnostics[0].diagnostic.kind, "user"); assert.ok(nestedDetails.rawGuardFailureDiagnostic); groups++;
for (const invalid of [{ details: [] }, { details: {} }, { details: [terminal], foreign: true }, { details: [{ unknownPrivateField: "SYNTHETIC_PRIVATE" }] }, { details: [{ gateway: { auth: { token: "SYNTHETIC_PRIVATE" } } }] }, { details: Array(65).fill(terminal) }, { details: [{ component: "CodexHarness", event: "turn.error", foreign: "SYNTHETIC_PRIVATE" }] }]) rejected(logger(invalid));
for (const invalid of ['{"details":', JSON.stringify({ details: [terminal], foreign: true }), JSON.stringify({ details: [{ unknownPrivateField: "SYNTHETIC_PRIVATE" }] })]) rejected(logger(invalid));
rejected({ ...detailsRecord, message: "Unexplained original message SYNTHETIC_PRIVATE" });
rejected(logger({ details: [terminal] }, { "2": '{"auth":{"token":"SYNTHETIC_PRIVATE"}}' }));
rejected(logger({ details: [terminal] }, { "2": '{"unknownPrivateField":"SYNTHETIC_PRIVATE"}' }));

const transportRecord = logger(start.text), transport = projected(transportRecord); assert.equal(transport.audit.records[0].transport[0].presence, "PRESENT_MARKER"); assert.ok(!transport.projectedText.includes("apiKey=")); groups++;
assert.throws(() => assertSafeHostLog(JSON.stringify(transportRecord)));
const missingStart = renderResponsesStart({ ...args, presence: "missing" });
const missingProjection = observe(logger(missingStart.text), { ...authority, responsesStarts: [missingStart] });
assert.equal(missingProjection.sourceProjectedComplete, true); assert.equal(missingProjection.audit.records[0].transport[0].presence, "MISSING_MARKER");
for (const kind of ["user", "compact", "review"]) { const receipt = projected(logger({ details: [{ ...terminal, kind }] })); assert.equal(receipt.audit.retainedDiagnostics[0].diagnostic.kind, kind); assert.equal(receipt.audit.retainedDiagnostics[0].diagnostic.outcome, "completed"); }
groups++;
for (const change of [start.text + " payload=secret", start.text + " apiKey=present", start.text.replace("apiKey=present", "apiKey=SYNTHETIC_PRIVATE"), start.text.replace("127.0.0.1", "foreign.invalid"), start.text.replace("inputItems=1", "inputItems=2"), start.text.replace("[responses] start", "[responses] prefix")]) rejected(logger(change, { agent_id: "main" }));
for (const level of ["WARN", "ERROR", "FATAL"]) rejected(logger(start.text, {}, level));
rejected(transportRecord, { ...authority, responsesStarts: [] });
rejected(transportRecord, { ...authority, responsesStarts: [start, start] });
for (const modified of [{ ...args, baseUrl: "https://foreign.invalid/host/v1" }, { ...args, presence: "SYNTHETIC_PRIVATE" }, { ...args, body: { ...body, metadata: { private: "SYNTHETIC_PRIVATE" } }, bodySha256: sha(JSON.stringify({ ...body, metadata: { private: "SYNTHETIC_PRIVATE" } })) }, { ...args, body: { ...body, input: [{ type: "compaction" }] } }, { ...args, body: { ...body, model: "foreign" } }]) { assert.throws(() => renderResponsesStart(modified)); negatives++; }

// Actual registered body provenance cannot make source-rendered summary
// assignments/roles/tool names or unknown schemas safe by equality alone.
for (const bad of [
  { reasoning: { effort: "low apiKey=SYNTHETIC_PRIVATE" } }, { reasoning: { summary: "auto unknown=value" } },
  { text: { verbosity: "low apiKey=present" } }, { service_tier: "auto apiKey=present" }, { store: "apiKey=present" },
  { tools: [{ type: "function", name: "tool_call apiKey=present", description: "Owned", parameters: { type: "object" } }] },
  { tools: [{ type: "function", name: "unknown", description: "Owned", parameters: { type: "object" } }] },
  { tools: [{ type: "unknown", name: "tool_call", description: "Owned", parameters: { type: "object" } }] },
  { tools: [{ type: "function", name: "tool_call", description: "Owned", parameters: { type: "object" }, foreign: true }] },
  { input: [{ type: "message", role: "user apiKey=present", content: "Safe" }] },
  { input: [{ type: "unknown apiKey=present", role: "user", content: "Safe" }] },
  { input: [{ type: "message", role: "user", content: [{ type: "unknown", text: "Safe" }] }] },
  { input: [{ type: "message", role: "user", content: "Safe", foreign: "SYNTHETIC_PRIVATE" }] },
]) { assert.throws(() => renderResponsesStart({ ...args, body: { ...body, ...bad }, bodySha256: sha(JSON.stringify({ ...body, ...bad })) })); negatives++; }
groups++;
const ownRequest = { ownCanonicalBinding: true, uniqueBody: true, runId: "own-canonical-run", body, bodySha256: args.bodySha256 }, ownOptions = { ...args, requestPopulation: 3 };
const actualRequest = { transport: "host-parent", parentRequestClassification: { kind: "embedded-parent" }, hasParentTools: true, emittedType: "message", emittedText: "Own fixture result.", responseId: "own-response", responseCompleted: true, parentProbe: "own-probe", bodyHash: args.bodySha256 };
const canonical = { role: "assistant", responseId: "own-response", __openclaw: { runId: ownRequest.runId }, content: "Own fixture result." };
const history = { method: "chat.history", params: { sessionKey: "own-key" }, value: { sessionKey: "own-key", sessionId: "own-parent", messages: [canonical] } };
const wait = { method: "agent.wait", params: { runId: ownRequest.runId }, value: { runId: ownRequest.runId, status: "ok", terminalReply: { disposition: "visible", text: "Own fixture result." } } };
const admission = { method: "chat.send", params: { sessionKey: "own-key" }, value: { runId: ownRequest.runId } };
const binding = { receipts: [history, wait, admission], requests: [actualRequest], sessionKey: "own-key", sessionId: "own-parent", body };
assert.equal(bindCanonicalTransportRequest(actualRequest, binding, assertCompletionTerminal, assertVisibleCanonical).runId, ownRequest.runId); groups++;
for (const [request, observation] of [
  [{ ...actualRequest, responseCompleted: false }, binding], [{ ...actualRequest, parentRequestClassification: { kind: "activity-recap" } }, binding], [{ ...actualRequest, responseId: "foreign" }, binding],
  [actualRequest, { ...binding, sessionId: "foreign" }], [actualRequest, { ...binding, sessionKey: "foreign" }],
  [actualRequest, { ...binding, receipts: [history] }], [actualRequest, { ...binding, receipts: [admission, history, { ...wait, params: { runId: "foreign" } }] }],
  [actualRequest, { ...binding, receipts: [admission, history, { ...wait, value: { ...wait.value, status: "error" } }] }],
  [actualRequest, { ...binding, receipts: [admission, history, { ...wait, value: { ...wait.value, terminalReply: { disposition: "silent", text: "Own fixture result." } } }] }],
  [actualRequest, { ...binding, receipts: [{ ...history, value: { ...history.value, messages: [canonical, canonical] } }, wait, admission] }],
  [actualRequest, { ...binding, receipts: [{ ...history, value: { ...history.value, messages: [{ ...canonical, __openclaw: { runId: ownRequest.runId, truncated: true } }] } }, wait, admission] }],
  [actualRequest, { ...binding, requests: [actualRequest, actualRequest] }],
]) { assert.equal(bindCanonicalTransportRequest(request, observation, assertCompletionTerminal, assertVisibleCanonical), undefined); negatives++; }
assert.equal(bindCanonicalTransportRequest(actualRequest, { ...binding, receipts: [history, wait], completedRunIds: [ownRequest.runId] }, assertCompletionTerminal, assertVisibleCanonical).runId, ownRequest.runId);
for (const observation of [{ ...binding, receipts: [history, wait] }, { ...binding, body: { ...body, store: false } }, { ...binding, receipts: [admission, history, { ...wait, value: { ...wait.value, terminalReply: { disposition: "visible", text: "Foreign result" } } }] }]) { assert.equal(bindCanonicalTransportRequest(actualRequest, observation, assertCompletionTerminal, assertVisibleCanonical), undefined); negatives++; }
const expected = renderResponsesStart({ ...args, requestId: "own-canonical-run:model:2" });
const embeddedAuthority = { ...authority, responsesStarts: expectedEmbeddedStarts(ownRequest, ownOptions) };
const embedded = hostLogEvidence(Buffer.from(JSON.stringify(logger(expected.text))), { sourceAuthority: embeddedAuthority });
assert.equal(embedded.sourceProjectedComplete, true); assert.equal(embedded.audit.records[0].transport[0].ordinal, 2); assert.match(embedded.audit.records[0].transport[0].ordinalEvidence, /^HASH_DERIVED_SOURCE_ORDINAL/); groups++;
for (const changed of [expected.text.replace(/sha256:[a-f0-9]{64}/, `sha256:${"a".repeat(64)}`), renderResponsesStart({ ...args, requestId: "foreign:model:2" }).text, renderResponsesStart({ ...args, requestId: "own-canonical-run:model:4" }).text, start.text, expected.text.replace("timeoutMs=undefined", "timeoutMs=30000")]) rejected(logger(changed), embeddedAuthority);
rejected(logger(expected.text), { ...embeddedAuthority, responsesStarts: [...embeddedAuthority.responsesStarts, ...embeddedAuthority.responsesStarts] });
for (const bad of [{ ...ownRequest, ownCanonicalBinding: false }, { ...ownRequest, uniqueBody: false }, { ...ownRequest, runId: "" }]) { assert.throws(() => expectedEmbeddedStarts(bad, ownOptions)); negatives++; }
assert.equal(sourceSdkTimeout({ optionAbsenceProven: true, modelAbsenceProven: true }), undefined);
assert.equal(sourceSdkTimeout({ explicitOption: 3000000000 }), 3000000000, "Explicit package stream option is returned without host clamp");
assert.equal(sourceSdkTimeout({ optionAbsenceProven: true, modelValue: 3000000000 }), 2147483647);
assert.equal(sourceSdkTimeout({ optionAbsenceProven: true, modelValue: 12.8 }), 12); groups++;
for (const bad of [{}, { optionAbsenceProven: true }, { explicitOption: "30000" }, { explicitOption: -1 }, { optionAbsenceProven: true, modelValue: Infinity }, { modelValue: 30000 }]) { assert.throws(() => sourceSdkTimeout(bad)); negatives++; }

const input = Buffer.from(`${JSON.stringify(contextRecord)}\n${JSON.stringify(detailsRecord)}\n${JSON.stringify(transportRecord)}\n`), result = projected(input.toString());
assert.equal(result.audit.recordCount, 4); let offset = 0;
for (const item of result.audit.records) { assert.equal(item.byteStart, offset); assert.equal(item.originalSha256, sha(input.subarray(item.byteStart, item.byteEndExclusive))); offset = item.byteEndExclusive; }
assert.equal(offset, input.length); assert.equal(result.audit.records.at(-1).trailingEmpty, true); groups++;
const unicode = projected(logger({ details: [terminal] }, { "2": "Harmless é🐱 text" })); assert.equal(unicode.original.bytes, Buffer.byteLength(JSON.stringify(logger({ details: [terminal] }, { "2": "Harmless é🐱 text" })))); groups++;
rejected(Buffer.from([0xff]).toString() + JSON.stringify(contextRecord));
const invalidBytes = hostLogEvidence(Buffer.concat([Buffer.from(JSON.stringify(contextRecord)), Buffer.from([0xff])]), { sourceAuthority: authority }); assert.notEqual(invalidBytes.sourceProjectedComplete, true); negatives++;
assert.equal(hostLogEvidence(Buffer.from([0xff])).completeStreamSafe, false); negatives++;
for (const invalid of [{ ...authority, candidateSha: "bad" }, { ...authority, helperSha256: "bad" }, { ...authority, hostCommit: "a".repeat(40) }]) rejected(contextRecord, invalid);
rejected(`${JSON.stringify(contextRecord)}\nunknown {"private":"SYNTHETIC_PRIVATE"}`);
rejected(`${JSON.stringify(contextRecord)}\n${"x".repeat(4 * 1024 * 1024)}`);
rejected(`${JSON.stringify(contextRecord)}\n${"\n".repeat(10000)}`);
const truncated = { ...detailsRecord, message: "x".repeat(4096) + "...(truncated)" }; rejected(truncated);
const cappedRecord = logger({ details: [terminal] }, { "2": "x".repeat(4095) + "🐱extra" }); assert.ok(cappedRecord.message.endsWith("...(truncated)")); projected(cappedRecord); groups++;
rejected(`${JSON.stringify(contextRecord)}\ngateway=\n{}`);
const cappedAuthority = { ...embeddedAuthority, responsesStarts: Array(11).fill(expectedEmbeddedStarts(ownRequest, { ...ownOptions, requestPopulation: 10000 })[0]) };
rejected(logger(expected.text), cappedAuthority);
const mixedUnknown = logger(JSON.stringify(terminal)); mixedUnknown._meta.logLevelName = "UNKNOWN"; rejected(`${JSON.stringify(contextRecord)}\n${JSON.stringify(mixedUnknown)}`);

// Valid logs stay byte-preserving RAW_SAFE; projections are attempted only
// after the unchanged guard refuses the original.
for (const text of ["Harmless plain lifecycle text.\n", JSON.stringify(logger(JSON.stringify(terminal))), JSON.stringify(logger({ phaseDurationsMs: { run: 1 } }))]) { const safe = observe(text); assert.equal(safe.completeStreamSafe, true); assert.equal(safe.projectedText, undefined); }
groups++;
const safeLogs = [], capturedRequests = []; for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i], path = process.argv[++i]; assert.ok(path);
  if (flag === "--safe-log") { const bytes = readFileSync(path); assert.equal(hostLogEvidence(bytes).completeStreamSafe, true); assert.equal(hostLogEvidence(bytes, { sourceAuthority: authority }).completeStreamSafe, true); safeLogs.push({ bytes: bytes.length, sha256: sha(bytes) }); }
  else {
    assert.equal(flag, "--parent-receipts");
    const fixtures = JSON.parse(readFileSync(join(path, "fixtures.json"))), created = JSON.parse(readFileSync(join(path, "host-session-created.json")));
    const models = JSON.parse(readFileSync(join(path, "model-isolation-config.json"))), receipts = [];
    for (const file of readdirSync(path).filter((name) => /^command-\d+\.json$/.test(name))) {
      const command = JSON.parse(readFileSync(join(path, file))), method = command.args?.find((arg) => ["chat.send", "chat.history", "agent.wait"].includes(arg)); if (!method) continue;
      const index = command.args.indexOf("--params"); if (index < 0) continue;
      receipts.push({ method, params: JSON.parse(command.args[index + 1]), value: JSON.parse(command.stdout) });
    }
    const rows = JSON.parse(readFileSync(join(path, "sessions.json"))).sessions;
    const completedRunIds = rows.filter((row) => row.originSessionKey === created.key && row.completionWakeIssuedAt && row.completionWakeSucceededAt && !row.completionWakeFailedAt && !row.completionWakeSkippedAt).map((row) => row.completionWakeRunId);
    for (const request of fixtures.modelRequests.filter((entry) => entry.transport === "host-parent")) {
      const bytes = readFileSync(join(path, `responses-request-${request.requestIndex}.json`)), input = JSON.parse(bytes).input; assert.equal(sha(JSON.stringify(input)), request.bodyHash);
      const options = { ...args, body: input, bodySha256: request.bodyHash, baseUrl: models.parentBaseUrl, requestPopulation: fixtures.modelRequests.filter((entry) => entry.transport === "host-parent").length };
      const bound = bindCanonicalTransportRequest(request, { receipts, requests: fixtures.modelRequests, sessionKey: created.key, sessionId: created.sessionId, body: input, completedRunIds }, assertCompletionTerminal, assertVisibleCanonical);
      const rendered = renderResponsesStart({ ...options, requestId: bound ? `${bound.runId}:model:1` : undefined });
      assert.ok(request.parentRequestClassification.kind === "activity-recap" || bound, "All recorded embedded smoke bodies have exact independent own canonical/issued/terminal association");
      capturedRequests.push({ requestIndex: request.requestIndex, requestArtifactSha256: sha(bytes), bodySha256: request.bodyHash, sourceClass: bound ? "OWN_CANONICAL_EMBEDDED_REQUEST" : "EXACT_ACTIVITY_RECAP", sourceRenderSha256: sha(rendered.text), proofScope: "Offline body/association replay; ordinal1 and undefined timeout are source-render control inputs, no lost runtime template equality or runtime acceptance claim" });
    }
    groups++;
  }
}
if (safeLogs.length) groups++;
for (const source of [JSON.stringify(logger({ details: [{ unknownPrivateField: "SYNTHETIC_PRIVATE" }] })), JSON.stringify(logger(start.text.replace("apiKey=present", "apiKey=SYNTHETIC_PRIVATE")))]) { const receipt = observe(source); assert.ok(!JSON.stringify(receipt).includes("SYNTHETIC_PRIVATE")); assert.ok(!JSON.stringify(receipt).includes("unknownPrivateField")); }
groups++;
console.log(JSON.stringify({ scope: "Offline source projection controls only; no host/native/delivery acceptance", positiveGroups: groups, negativeControls: negatives, safeLogs, capturedRequests, elapsedMs: performance.now() - started }));
