// Bounded structured feature receipts; raw config, logs and model bodies are excluded.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const sha = value => createHash("sha256").update(value).digest("hex");
export const FILE_LIMIT = 4 * 1024 * 1024;
export const HOST_PIN = "fc23bc864e4553c2d215e479eeec47b67a0bf943";
export const assignments = Object.freeze({ smoke: [], admission: ["admission"], gates: ["whole-gate"], live: ["live-policy"], restore: ["organic-restore"], all: ["admission", "whole-gate", "live-policy", "organic-restore", "immutable-history", "end-to-end-cleanup"] });
export function excluded(name, bytes, domain = "original captured bytes") {
  assert.ok(/^[a-z][a-z0-9.-]*$/.test(name));
  return { name, disposition: "EXCLUDED", bytes: bytes.length, sha256: sha(bytes), domain };
}
function closed(value, fields) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  for (const key of Object.keys(value)) assert.ok(fields.includes(key), "Unknown structured proof field");
}
export function requiredFact(fact) {
  assert.equal(fact?.required, true);
  assert.ok(["goal", "terminal"].includes(fact.producer));
  assert.ok(typeof fact.outcomeKey === "string" && fact.outcomeKey);
  return { required: true, producer: fact.producer, outcomeKey: fact.outcomeKey };
}
const scalarObject = (value, fields) => { closed(value, fields); for (const item of Object.values(value)) assert.ok(item === null || ["string", "number", "boolean"].includes(typeof item)); };
const processFields = ["pid", "state", "parent", "group", "startTicks", "executable"];
const patchProofFields = new Set(["patchAckOk", "patchHashChanged", "patchSelectedPathChanged", "patchNoRestart", "patchResponseParsed", "patchArrayIntentDenied", "patchRequiredCommandsSchemaDenied", "patchRateLimitDenied", "patchBaseHashDenied", "retiredAdmittedCheckDrained", "restoredEffectiveSuitePassed"]);
const proofScalars = new Set("commandId exitCode signal timedOut stdioComplete rpcMethod invokedTool httpStatus toolError sourceArchiveSha256 hostEntrySha256 nativeExecutableSha256 packedSha256 installedEntrySha256 appliedRevision configRevision beforeRevision afterRevision alreadySetReadbackOnly sourceSha256 unchangedRevision setupOnly nativeThreadId nativeReceiptSha256 parentProof ownRunId responseId canonicalSha256 visible sessionId outcomeKey issuedAt succeededAt deliveryState publicOwnerId publicOwnerStatus activePublicView failedNotificationKey delivered goalId terminalStatus terminalRowSha256 iteration case policyFailure sameGoalId sameNativeThreadId oldSessionId restoredSessionId ownedShutdown listenerClosed bindingSha256 policyFingerprint repositoryIdentitySha256 selectedPolicy operatorTrustedExtras unrelatedPolicyChanged affectedPolicyABA restoredBindingUnchanged deniedBeforeEffects".split(" "));
const proofArrays = { mutation: null, requiredVerifierCommands: null, requiredCommands: null, additionalCommands: null, effectiveCommands: null, verifierCommands: ["label", "command"], checks: ["ordinal", "kind", "exit"], retiredChecks: ["ordinal", "kind", "exit"], notificationKeys: ["key", "label"], descendants: processFields, historicalRowsCompared: ["id", "sha256"], fixtureFailures: null };
function proof(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  for (const [key, item] of Object.entries(value)) {
    if (key === "patchErrorCode") { assert.ok(["NONE", "INVALID_REQUEST", "UNAVAILABLE", "CONFLICT", "RATE_LIMITED", "UNKNOWN"].includes(item)); continue; }
    if (key === "patchErrorType") { assert.ok(["NONE", "gateway_request_error", "gateway_transport_error", "gateway_credentials_required", "cli_error", "UNKNOWN"].includes(item)); continue; }
    if (key === "patchTransportKind") { assert.ok(["NONE", "timeout", "closed", "UNKNOWN"].includes(item)); continue; }
    if (key === "patchTransportTimeoutMs") { assert.ok(item === null || Number.isSafeInteger(item) && item > 0 && item <= 120_000); continue; }
    if (key === "patchTransportCode") { assert.ok(item === null || [1000, 1006, 1012].includes(item)); continue; }
    if (patchProofFields.has(key)) { assert.equal(typeof item, "boolean"); continue; }
    if (proofScalars.has(key)) { assert.ok(item === null || ["string", "boolean", "number"].includes(typeof item)); continue; }
    if (["gateway", "verifierProcess"].includes(key)) { scalarObject(item, processFields); continue; }
    if (key === "requiredAdmissionFact") { closed(item, ["required", "producer", "outcomeKey"]); requiredFact(item); continue; }
    if (Object.hasOwn(proofArrays, key)) {
      assert.ok(Array.isArray(item));
      for (const entry of item) if (proofArrays[key]) scalarObject(entry, proofArrays[key]); else assert.equal(typeof entry, "string");
      continue;
    }
    assert.equal(key, "providerRequests", "Unknown feature proof field"); assert.ok(Array.isArray(item));
    for (const request of item) {
      closed(request, ["index", "native", "bytes", "sha256", "responseId", "completed", "case", "threadId", "turnId", "owner", "deliberatelyAborted", "call", "executionExit", "matchedCallId", "receiptSha256", "text", "fixtureFailureCode"]);
      if (request.owner) { closed(request.owner, ["sessionId", "nativeProcess"]); assert.equal(typeof request.owner.sessionId, "string"); scalarObject(request.owner.nativeProcess, processFields); }
      if (request.call) scalarObject(request.call, ["id", "type", "name", "advertisedSource", "receiptMode"]);
      if (request.call?.receiptMode !== undefined) assert.ok(["create", "read-existing"].includes(request.call.receiptMode));
      if (request.fixtureFailureCode !== undefined) assert.ok(["FIXTURE_REQUEST_INVALID", "FIXTURE_INTENT_INVALID", "FIXTURE_NATIVE_IDENTITY_INVALID", "FIXTURE_NATIVE_OWNER_INVALID", "FIXTURE_NATIVE_EXECUTION_INVALID", "FIXTURE_SHUTDOWN_INVALID"].includes(request.fixtureFailureCode));
      for (const [field, scalar] of Object.entries(request)) if (!["owner", "call"].includes(field)) assert.ok(["string", "number", "boolean"].includes(typeof scalar));
    }
  }
}
function privacy(value, secrets) {
  if (Array.isArray(value)) return value.map(item => privacy(item, secrets));
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) assert.ok(!/^(?:auth|token|apiKey|botToken|environment|config|providers|defaults|bindings|transcript|raw)$/i.test(key), "Raw profile or transcript field refused");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, privacy(item, secrets)]));
  }
  if (typeof value === "string") {
    for (const secret of secrets) { assert.ok(secret.length >= 8);
      value = value.replaceAll(secret, "[fixture credential]");
      }
    assert.ok(value.length <= 4096, "Unbounded text is not a structured proof");
  }
  return value;
}
export function validateReceipt(receipt, expected) {
  closed(receipt, ["format", "complete", "candidateSha", "nodeVersion", "scenario", "hostVersion", "hostCommit", "nativeVersion", "assigned", "completed", "disposition", "failure", "cleanup", "excluded", "proofs", "retiredHostClaims"]);
  assert.equal(receipt.format, "oca-repo-goal-slim-v1");
  assert.equal(receipt.complete, true);
  for (const field of ["candidateSha", "nodeVersion", "scenario"]) assert.equal(receipt[field], expected[field]);
  assert.match(receipt.candidateSha, /^[a-f0-9]{40}$/);
  assert.ok(["24.16.0", "26.1.0"].includes(receipt.nodeVersion));
  assert.equal(receipt.hostVersion, "2026.9.8");
  assert.equal(receipt.hostCommit, HOST_PIN);
  assert.equal(receipt.nativeVersion, "0.160.0");
  assert.ok(Object.hasOwn(assignments, receipt.scenario));
  assert.deepEqual(receipt.assigned, assignments[receipt.scenario]);
  assert.equal(new Set(receipt.completed).size, receipt.completed.length);
  for (const id of receipt.completed) assert.ok(receipt.assigned.includes(id));
  assert.ok(["PASS", "BLOCKED"].includes(receipt.disposition));
  if (receipt.disposition === "PASS") { assert.deepEqual(receipt.completed, receipt.assigned);
    assert.equal(receipt.cleanup.complete, true);
    assert.deepEqual(receipt.cleanup.failures, []);
    assert.equal(receipt.failure, null);
    }
  assert.ok(receipt.cleanup && Array.isArray(receipt.cleanup.failures));
  closed(receipt.cleanup, ["complete", "failures"]);
  assert.equal(typeof receipt.cleanup.complete, "boolean");
  for (const code of receipt.cleanup.failures) assert.ok(["OWNED_GATEWAY_SHUTDOWN_FAILED", "OWNED_CHILD_SHUTDOWN_FAILED", "FIXTURE_PROTOCOL_OR_SHUTDOWN_FAILED"].includes(code));
  if (receipt.failure) { scalarObject(receipt.failure, ["stage", "code"]); assert.equal(typeof receipt.failure.stage, "string"); assert.equal(typeof receipt.failure.code, "string"); }
  if (receipt.retiredHostClaims) { assert.ok(Array.isArray(receipt.retiredHostClaims)); receipt.retiredHostClaims.forEach(value => assert.equal(typeof value, "string")); }
  assert.ok(Array.isArray(receipt.proofs)); receipt.proofs.forEach(proof);
  assert.ok(Array.isArray(receipt.excluded));
  for (const item of receipt.excluded) { closed(item, ["name", "disposition", "bytes", "sha256", "domain"]); assert.equal(item.disposition, "EXCLUDED");
    assert.match(item.name, /^[a-z][a-z0-9.-]*$/); assert.equal(typeof item.domain, "string");
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0);
    }
  privacy(receipt, []);
  return receipt;
}
export function frameReceipt(receipt, secrets = []) {
  let safe = privacy(receipt, secrets);
  validateReceipt(safe, safe);
  let bytes = Buffer.from(JSON.stringify(safe) + "\n");
  if (bytes.length > FILE_LIMIT) {
    safe = { ...safe, disposition: "BLOCKED", failure: safe.failure ?? { stage: "export", code: "STRUCTURED_PROOF_BOUND_EXCEEDED" },
      proofs: [], excluded: [...safe.excluded, excluded("oversized-proof.json", bytes, "complete sanitized receipt before bounded exclusion")] };
    receipt.disposition = "BLOCKED"; receipt.failure = safe.failure;
    validateReceipt(safe, safe); bytes = Buffer.from(JSON.stringify(safe) + "\n");
  }
  assert.ok(bytes.length <= FILE_LIMIT);
  return `OCA501_SLIM ${JSON.stringify({ sha256: sha(bytes), bytes: bytes.length, content: bytes.toString("base64") })}\n`;
}
export function decodeReceipt(stdout, expected) {
  const frames = stdout.split("\n").filter(line => line.startsWith("OCA501_SLIM "));
  assert.equal(frames.length, 1, "Exactly one complete owning-job receipt required");
  const frame = JSON.parse(frames[0].slice(12));
  assert.ok(Number.isInteger(frame.bytes) && frame.bytes > 0 && frame.bytes <= FILE_LIMIT);
  assert.ok(typeof frame.content === "string" && frame.content.length <= 2 * FILE_LIMIT);
  const bytes = Buffer.from(frame.content, "base64");
  assert.equal(bytes.length, frame.bytes);
  assert.equal(sha(bytes), frame.sha256);
  assert.deepEqual(Buffer.from(bytes.toString("utf8")), bytes);
  const receipt = validateReceipt(JSON.parse(bytes), expected);
  return { receipt, bytes, sha256: frame.sha256 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}, args = process.argv.slice(2);
  assert.equal(args.length, 10);
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(["--decode", "--out", "--expected-sha", "--node-version", "--scenario"].includes(args[i]) && !Object.hasOwn(options, args[i]));
    assert.ok(args[i + 1]);
    options[args[i]] = args[i + 1];
  }
  assert.ok(isAbsolute(options["--decode"]) && isAbsolute(options["--out"]));
  assert.equal(existsSync(options["--out"]), false, "Decode into a new directory only");
  const decoded = decodeReceipt(readFileSync(options["--decode"], "utf8"), { candidateSha: options["--expected-sha"], nodeVersion: options["--node-version"], scenario: options["--scenario"] });
  mkdirSync(options["--out"], { mode: 0o700 });
  writeFileSync(resolve(options["--out"], "receipt.json"), decoded.bytes, { mode: 0o600 });
  console.log(JSON.stringify({ disposition: decoded.receipt.disposition, scenario: decoded.receipt.scenario, completed: decoded.receipt.completed, sha256: decoded.sha256 }));
}
