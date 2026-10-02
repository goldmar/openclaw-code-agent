// Offline rejection diagnostics only; never Gateway/native acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertSafeHostLog, hostLogEvidence, rejectedHostLogDiagnostic } from "./oca501-lifecycle-protocol.mjs";
const hash = (x) => createHash("sha256").update(x).digest("hex");
let positiveGroups = 0, negativeControls = 0;
const check = (input) => {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input), original = Buffer.from(bytes), receipt = rejectedHostLogDiagnostic(bytes);
  assert.deepEqual(bytes, original); assert.equal(receipt.original.sha256, hash(bytes)); assert.equal(receipt.original.bytes, bytes.length);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 64 * 1024);
  assert.ok(!JSON.stringify(receipt).includes("SYNTHETIC_PRIVATE_VALUE") && !JSON.stringify(receipt).includes("privateDynamicKey"));
  for (const detail of [...(receipt.failedLineDetails ?? []), ...(receipt.lexicalDetails ?? [])]) {
    assert.equal(detail.bytes, detail.byteEndExclusive - detail.byteStart);
    assert.equal(detail.sha256, hash(bytes.subarray(detail.byteStart, detail.byteEndExclusive)));
    assert.ok(!Object.hasOwn(detail, "message") && !Object.hasOwn(detail, "stack"));
    if (detail.containingLine) assert.equal(detail.containingLine.sha256, hash(bytes.subarray(detail.containingLine.byteStart, detail.containingLine.byteEndExclusive)));
  }
  return receipt;
};
const names = "gateway auth token agents defaults bindings channels accounts credentials models providers plugins entries config environment env profile botToken apiKey tokenFile authProfiles".split(" ");
for (const name of names) {
  for (const quote of ['"', "'"]) {
    const raw = `é🙂 prefix ${quote}${name.toUpperCase()}${quote}: {SYNTHETIC_PRIVATE_VALUE}`;
    assert.throws(() => assertSafeHostLog(raw)); const d = check(raw);
    const match = d.lexicalDetails.find((m) => m.rule === name && m.context === "quoted-property-like"); assert.ok(match);
    assert.equal(match.byteStart, Buffer.byteLength("é🙂 prefix ")); assert.equal(match.byteEndExclusive, match.byteStart + Buffer.byteLength(`${quote}${name.toUpperCase()}${quote}:`));
    negativeControls++;
  }
}
positiveGroups++;
for (const [raw, rule, context] of [["gateway = {", "gateway", "assignment-object-like"], ["token = SYNTHETIC_PRIVATE_VALUE", "token", "auth-assignment-like"], ["gateway.auth = SYNTHETIC_PRIVATE_VALUE", "gateway.auth", "dotted-assignment-like"], ["safe é🙂\n  botToken:\n", "botToken", "line-property-like"]]) {
  const r = check(raw); assert.ok(r.lexicalDetails.some((d) => d.rule === rule && d.context === context)); negativeControls++;
}
for (const rule of ["gateway.auth", "agents.defaults", "models.providers", "plugins.entries", "process.env"]) assert.ok(check(`${rule}: SYNTHETIC_PRIVATE_VALUE`).lexicalDetails.some((d) => d.rule === rule));
positiveGroups++;
const utf8 = Buffer.from("safe é🙂\n" + '{"gateway":{"auth":{"token":"SYNTHETIC_PRIVATE_VALUE"}}}' + "\n");
const line = check(utf8); assert.equal(line.capturedLines, 3); assert.equal(line.failedLineDetails[0].line, 1); assert.equal(line.failedLineDetails[0].byteStart, Buffer.byteLength("safe é🙂\n")); assert.equal(line.failedLineDetails[0].byteEndExclusive, utf8.length); assert.equal(line.failedLineDetails[0].includesLF, true); assert.equal(line.inspectedLines, 3);
const unterminated = check('token: SYNTHETIC_PRIVATE_VALUE'); assert.equal(unterminated.failedLineDetails[0].unterminated, true);
positiveGroups++;
const escaped = check(String.raw`error "{\"gateway\":{\"auth\":{\"token\":\"SYNTHETIC_PRIVATE_VALUE\"}}}"`); assert.equal(escaped.lexicalMatches, 0); assert.equal(escaped.wholeFailure.code, "PROHIBITED_PROFILE_AUTH");
for (const input of ['{"phaseDurationsMs":{"credentials":0}}', 'phaseDurationsMs={"gateway.auth":0}', '{"privateDynamicKey":{"secret":"SYNTHETIC_PRIVATE_VALUE"}}', String.raw`error "{\"gateway\":`]) { assert.equal(hostLogEvidence(input).completeStreamSafe, false); check(input); negativeControls++; }
const crossing = check('{\n  "reason": {\n    "reason": "safe"\n  }\n}'); assert.equal(crossing.crossingLineUnresolved, true); assert.equal(crossing.failedLines, 0);
positiveGroups++;
const logger = (payload, id = 2, name = "DEBUG", meta = {}) => JSON.stringify({ "0": payload, _meta: { runtime: "Nodejs", runtimeVersion: "24.16.0", logLevelId: id, logLevelName: name, name: "SYNTHETIC_PRIVATE_VALUE", ...meta } });
for (const [id, severity] of ["SILLY", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"].entries()) {
  const string = check(logger('token: SYNTHETIC_PRIVATE_VALUE', id, severity)); assert.equal(string.failedLineDetails[0].severity, severity); assert.equal(string.failedLineDetails[0].envelope, "PINNED_LOGGER_STRING_PAYLOADS");
  const object = check(logger({ gateway: { auth: { token: "SYNTHETIC_PRIVATE_VALUE" } } }, id, severity)); assert.equal(object.failedLineDetails[0].envelope, "PINNED_LOGGER_OBJECT_PAYLOAD");
}
for (const [id, name] of [[1, "ERROR"], [9, "DEBUG"], ["2", "DEBUG"]]) { assert.equal(check(logger("token: SYNTHETIC_PRIVATE_VALUE", id, name)).failedLineDetails[0].severity, "UNKNOWN_SEVERITY"); negativeControls++; }
for (const meta of [{ privateDynamicKey: "SYNTHETIC_PRIVATE_VALUE" }, { parentNames: [{}] }, { path: { privateDynamicKey: "SYNTHETIC_PRIVATE_VALUE" } }]) { assert.equal(check(logger("token: SYNTHETIC_PRIVATE_VALUE", 2, "DEBUG", meta)).failedLineDetails[0].header, "UNKNOWN_ENVELOPE"); negativeControls++; }
const foreignOuter = JSON.stringify({ "0": "token: SYNTHETIC_PRIVATE_VALUE", privateDynamicKey: "SYNTHETIC_PRIVATE_VALUE", _meta: { logLevelId: 2, logLevelName: "DEBUG" } }); assert.equal(check(foreignOuter).failedLineDetails[0].header, "UNKNOWN_ENVELOPE"); negativeControls++;
positiveGroups++;
const many = check(Array.from({ length: 90 }, () => '{"privateDynamicKey":"SYNTHETIC_PRIVATE_VALUE"}').join("\n")); assert.equal(many.failedLines, 90); assert.equal(many.failedLineDetails.length, 64); assert.equal(many.omittedFailedLineDetails, 26);
const matches = check("auth: ".repeat(10001)); assert.equal(matches.lexicalScanCapped, true); assert.equal(matches.lexicalMatches, 10000); assert.equal(matches.lexicalDetails.length, 64); assert.equal(matches.inspectionComplete, false);
const lines = check("token: value\n".repeat(10000)); assert.equal(lines.diagnosticStatus, "DIAGNOSTIC_BOUND_EXCEEDED"); assert.equal(lines.uninspectedLines, 10001);
assert.equal(check(Buffer.alloc(4 * 1024 * 1024 + 1)).diagnosticStatus, "DIAGNOSTIC_BOUND_EXCEEDED");
assert.equal(check(Buffer.from([0xff])).diagnosticStatus, "DIAGNOSTIC_INVALID_UTF8");
positiveGroups++;
const extraPayloads = [{ unknown: { value: 1 } }, { phaseDurationsMs: { run: -1 } }, { phaseDurationsMs: { "1invalid": 0 } }, { reason: {} }, { component: "CodexHarness", event: "turn.terminal", foreign: 1 }, [{}], 'bad {"safe":', String.raw`bad "{\"safe\":`];
const oversizedDetails = Array.from({ length: 64 }, (_, i) => logger(i % 2 ? "plugins.entries: value" : { gateway: {} }, i % 7, ["SILLY", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"][i % 7]));
for (const payload of extraPayloads) for (const [id, severity] of ["SILLY", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"].entries()) oversizedDetails.push(logger(payload, id, severity));
// The actual exported wrapper includes the newly retained source observations
// and domain labels inside its unchanged cap/digest. The prior 79/80-record
// specimens remain overflow negatives; 39/40 now bracket the larger receipt.
const boundaryInput = (count) => "x".repeat(100000) + "\n" + oversizedDetails.slice(0, count).join("\n");
const below = hostLogEvidence(boundaryInput(39)); assert.equal(below.completeStreamSafe, false);
const actualBelow = below.rejectedStreamDiagnostic; assert.equal(actualBelow.diagnosticStatus, "REJECTED_STREAM_OBSERVED");
assert.ok(Buffer.byteLength(JSON.stringify(actualBelow)) <= 65536 && Buffer.byteLength(JSON.stringify(actualBelow)) > 65000);
const { projectedDiagnosticSha256, projectedDigestScope, ...digestedPayload } = actualBelow;
assert.equal(projectedDiagnosticSha256, hash(JSON.stringify(digestedPayload))); assert.match(digestedPayload.inputIdentityDomain, /undecoded byte validity unavailable/);
for (const input of [boundaryInput(40), boundaryInput(79), boundaryInput(80), boundaryInput(81), Buffer.from(boundaryInput(84))]) {
  const receipt = hostLogEvidence(input); assert.equal(receipt.completeStreamSafe, false); assert.equal(receipt.rawCompleteStreamExcluded, true);
  const actual = receipt.rejectedStreamDiagnostic; assert.equal(actual.diagnosticStatus, "DIAGNOSTIC_OUTPUT_BOUND_EXCEEDED"); assert.equal(actual.inspectionComplete, false);
  assert.ok(Buffer.byteLength(JSON.stringify(actual)) <= 65536); assert.equal(actual.original.sha256, hash(input));
  assert.ok(!JSON.stringify(actual).includes("SYNTHETIC_PRIVATE_VALUE")); negativeControls++;
}
positiveGroups++;
const overflow = check("x".repeat(1000000) + "\n" + oversizedDetails.join("\n")); assert.equal(overflow.diagnosticStatus, "DIAGNOSTIC_OUTPUT_BOUND_EXCEEDED"); assert.equal(overflow.inspectionComplete, false); negativeControls++;
const otherPayload = check(JSON.stringify({ "0": 0, message: "token: SYNTHETIC_PRIVATE_VALUE", _meta: { logLevelId: 2, logLevelName: "DEBUG" } })); assert.equal(otherPayload.failedLineDetails[0].envelope, "PINNED_LOGGER_OTHER_PAYLOAD");
const nestedMeta = check(logger("token: SYNTHETIC_PRIVATE_VALUE", 2, "DEBUG", { runtime: {} })); assert.equal(nestedMeta.failedLineDetails[0].header, "UNKNOWN_ENVELOPE"); negativeControls++;
positiveGroups++;
const rawRejected = hostLogEvidence(utf8); assert.equal(rawRejected.original.identityDomain, "original captured stream bytes"); assert.equal(rawRejected.original.sha256, hash(utf8)); assert.equal(rawRejected.rejectedStreamDiagnostic.original.sha256, hash(utf8));
const textRejected = hostLogEvidence(utf8.toString("utf8")); assert.match(textRejected.original.identityDomain, /undecoded byte validity unavailable/);
const invalidRaw = Buffer.from([0xff, ...Buffer.from("token: value")]); const invalidRawReceipt = hostLogEvidence(invalidRaw); assert.equal(invalidRawReceipt.rejectedStreamDiagnostic.diagnosticStatus, "DIAGNOSTIC_INVALID_UTF8"); assert.equal(invalidRawReceipt.original.sha256, hash(invalidRaw));
positiveGroups++;
const unsafeOptions = { get commandStream() { throw new Error("SYNTHETIC_PRIVATE_VALUE"); } }; const unknown = rejectedHostLogDiagnostic("safe", unsafeOptions); assert.equal(unknown.diagnosticStatus, "DIAGNOSTIC_UNKNOWN_FAILURE"); assert.ok(!JSON.stringify(unknown).includes("SYNTHETIC_PRIVATE_VALUE")); negativeControls++;
for (const safe of ["harmless completed\n", 'phaseDurationsMs={"prepare":0,"run":2015}', JSON.stringify({ component: "CodexHarness", event: "turn.terminal", kind: "user", outcome: "completed", hasThreadId: true, hasTurnId: true })]) {
  assertSafeHostLog(safe); const evidence = hostLogEvidence(safe); assert.equal(evidence.completeStreamSafe, true); assert.equal(evidence.rejectedStreamDiagnostic, undefined); assert.equal(check(safe).diagnosticStatus, "NOT_REJECTED");
}
positiveGroups++;
// Optional immutable actual safe-log replay; never actual host PASS from replay.
const argv = process.argv.slice(2); let actualSafeLogs = 0;
for (let index = 0; index < argv.length; index += 2) { assert.equal(argv[index], "--safe-log"); assert.ok(argv[index + 1]); const bytes = readFileSync(argv[index + 1]); assertSafeHostLog(bytes.toString("utf8")); const receipt = hostLogEvidence(bytes); assert.equal(receipt.completeStreamSafe, true); assert.equal(receipt.original.sha256, hash(bytes)); assert.equal(receipt.original.identityDomain, "original captured stream bytes"); actualSafeLogs++; }
console.log(JSON.stringify({ classification: "OFFLINE_REJECTION_DIAGNOSTIC_CONTROLS_ONLY", positiveGroups, negativeControls, actualSafeLogs }));
