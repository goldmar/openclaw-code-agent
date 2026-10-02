// Offline actual artifact serialization/registration/export controls only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { hostLogEvidence } from "./oca501-lifecycle-protocol.mjs";
import { pinnedFileMessage, hostLogArtifactPlan, serializeHostLogArtifact } from "./oca501-host-log-projection.mjs";
import { buildEvidence } from "./oca501-evidence.mjs";
const start = performance.now(), sha = (x) => createHash("sha256").update(x).digest("hex"), fileCap = 4 * 1024 * 1024;
const authority = { candidateSha: "a".repeat(40), helperSha256: "b".repeat(64), hostCommit: "c074824a27c96d3983043f9eeb33823cd1772d8c", agentIds: [], sessionIds: [], channels: [], responsesStarts: [] };
const guardSource = { helper: "scripts/e2e/oca501-lifecycle-protocol.mjs", helperSha256: "c".repeat(64), candidateSha: authority.candidateSha };
const logger = (payload, meta = { logLevelId: 2, logLevelName: "DEBUG" }) => { const row = { "0": payload, _meta: meta }; row.message = pinnedFileMessage(row); return row; };
const options = { serialize: serializeHostLogArtifact, redact: (text) => text, guardSource, assertProjectedSafe: (text) => assert.equal(hostLogEvidence(text).completeStreamSafe, true) };
const parent = resolve(".artifacts/oca501-log-export-boundary-controls"); mkdirSync(parent, { recursive: true, mode: 0o700 });
const root = mkdtempSync(join(parent, "owned-")); let groups = 0, negatives = 0;
function capture(bytes, label, override = {}) {
  const input = Buffer.from(bytes), before = Buffer.from(input), receipt = hostLogEvidence(input, { sourceAuthority: authority });
  const plan = hostLogArtifactPlan("runtime.log", receipt, input.toString("utf8"), { ...options, ...override });
  assert.deepEqual(input, before); assert.equal(plan.receipt.original.sha256, sha(input));
  const dir = join(root, label); mkdirSync(dir, { mode: 0o700 }); const entries = [];
  // Same consuming boundary as main: exact PREPARED strings, no later
  // serialization/redaction/wrapper additions before registration.
  for (const file of plan.files) {
    assert.ok(Buffer.byteLength(file.text) <= fileCap);
    writeFileSync(join(dir, file.name), file.text, { mode: 0o600 }); entries.push({ name: file.name, alreadyRedacted: true });
    assert.equal(readFileSync(join(dir, file.name)).length, Buffer.byteLength(file.text));
  }
  // Preserve ordinary failure/cleanup evidence in the owning complete bundle.
  writeFileSync(join(dir, "cleanup.json"), serializeHostLogArtifact({ scope: "Offline export control", classification: "PASS", noRuntimeStarted: true }), { mode: 0o600 }); entries.push({ name: "cleanup.json" });
  const bundle = buildEvidence(dir, entries, { scope: "Offline actual file export; no host acceptance", classification: plan.blocked ? "BLOCKED" : "PASS" }, []);
  assert.equal(bundle.manifest.complete, true); assert.equal(bundle.manifest.fileCount, entries.length);
  assert.ok(bundle.manifest.files.every((file) => file.originalBytes <= fileCap && file.sanitizedBytes <= fileCap));
  assert.ok(bundle.manifest.files.some((file) => file.name === "cleanup.json"));
  if (plan.receipt.rejectedStreamDiagnostic) assert.ok(Buffer.byteLength(serializeHostLogArtifact({ rejectedStreamDiagnostic: plan.receipt.rejectedStreamDiagnostic, sourceIdentity: "runtime.log", guardSource })) <= 65536);
  return { receipt, plan, bundle };
}
try {
  const prefix = logger({ message: "Safe original text" });
  const mixed = Buffer.from([prefix, ...Array.from({ length: 80 }, () => logger("Safe original text", { logLevelId: 7 }))].map(JSON.stringify).join("\n"));
  const counted = capture(mixed, "mixed"); const original = counted.receipt.rejectedStreamDiagnostic, final = counted.plan.receipt.rejectedStreamDiagnostic;
  assert.equal(counted.receipt.sourceProjectionAttempt.observations.blockedRecords, 80);
  assert.equal(counted.receipt.sourceProjectionAttempt.observations.blockedRecordIndices.length, 80);
  assert.equal(original.projectionBlockedGuardSafeLines, 80); assert.equal(original.omittedProjectionOnlyDetails, 17); assert.equal(original.failedLineDetails.filter((detail) => detail.originalLineGuardSafe).length, 63);
  assert.equal(final.projectionBlockedGuardSafeLines, 80); assert.equal(final.inspectedLines, 81);
  if (final.detailContentExcluded) { assert.equal(final.diagnosticStatus, "DIAGNOSTIC_OUTPUT_BOUND_EXCEEDED"); assert.equal(final.omittedProjectionOnlyDetails, 80); assert.equal(final.omittedFailedLineDetails, 1); }
  else assert.equal(final.omittedProjectionOnlyDetails, 17);
  assert.equal(Object.values(final.failureHistogram).reduce((sum, count) => sum + count, 0), 81);
  assert.equal(counted.plan.blocked, true); groups++; negatives++;
  const raw = Array.from({ length: 6020 }, () => JSON.stringify(logger({ message: "Safe text" })));
  const below = capture(Buffer.from(raw.slice(0, 6012).join("\n")), "below");
  assert.equal(below.plan.blocked, false); assert.equal(below.plan.receipt.sourceProjectedComplete, true);
  const actualAudit = below.plan.files.find((file) => file.name === "runtime.log.source-audit.json"); assert.ok(actualAudit); assert.ok(Buffer.byteLength(actualAudit.text) > 4_180_000 && Buffer.byteLength(actualAudit.text) <= fileCap); assert.ok(actualAudit.text.endsWith("\n")); groups++;
  const threshold = capture(Buffer.from(raw.slice(0, 6013).join("\n")), "threshold"); assert.equal(threshold.plan.blocked, true); assert.equal(threshold.plan.receipt.sourceProjectionAttempt.observations.recordCount, 6013); negatives++;
  const above = capture(Buffer.from(raw.join("\n")), "above");
  assert.equal(above.plan.blocked, true); assert.notEqual(above.plan.receipt.sourceProjectedComplete, true);
  assert.equal(above.plan.receipt.sourceProjectionAttempt.observations.recordCount, 6020);
  assert.equal(above.plan.files.length, 1); assert.equal(above.bundle.manifest.fileCount, 2); groups++; negatives++;
  const bad = { "0": { unknown: "Safe text" }, _meta: { logLevelId: 2, logLevelName: "DEBUG" }, message: '{"unknown":"Safe text"}' };
  const rejected = capture(Buffer.from([...Array.from({ length: 8344 }, () => raw[0]), JSON.stringify(bad)].join("\n")), "rejected");
  assert.equal(rejected.receipt.original.bytes, 834517); assert.equal(rejected.plan.blocked, true);
  assert.equal(rejected.plan.receipt.sourceProjectionAttempt.observations.recordCount, 8345);
  assert.equal(rejected.plan.receipt.sourceProjectionAttempt.observations.projectedRecords, 8344);
  assert.equal(rejected.plan.receipt.sourceProjectionAttempt.observations.blockedRecords, 1);
  assert.equal(rejected.receipt.sourceProjectionAttempt.observations.validatedRegistryExcluded, true);
  assert.equal(rejected.plan.files.length, 1); groups++; negatives++;
  // The final consumer check also accounts for ACTUAL redaction expansion and
  // its wrapper, even when the earlier source audit itself would fit.
  const expand = (text) => text.replaceAll("Every original LF record; source projection, not raw-safe evidence", "Safe actual redaction replacement ".repeat(1000));
  const expanded = capture(Buffer.from(raw.slice(0, 6012).join("\n")), "expanded", { serialize: (value) => serializeHostLogArtifact(value, expand), redact: expand });
  assert.equal(expanded.plan.blocked, true); assert.equal(expanded.plan.receipt.sourceProjectionAttempt.reason, "HOST_LOG_FINAL_ARTIFACT_BOUND");
  assert.equal(expanded.plan.receipt.sourceProjectionAttempt.observations.recordCount, 6012);
  assert.ok(expanded.plan.receipt.finalArtifactBoundary.oversizedFiles.some((file) => file.bytes > fileCap));
  assert.equal(expanded.plan.files.length, 1); groups++; negatives++;
  const safe = capture(Buffer.from("Safe original text.\n"), "raw-safe"); assert.equal(safe.plan.blocked, false); assert.equal(safe.plan.files[0].text, "Safe original text.\n"); groups++;
  console.log(JSON.stringify({ scope: "OFFLINE_ACTUAL_HOST_LOG_ARTIFACT_BOUNDARY_CONTROLS_ONLY", positiveGroups: groups, negativeControls: negatives, originalMixedFinalCompactBytes: Buffer.byteLength(JSON.stringify(original)), actualMixedSerializedDiagnosticBytes: Buffer.byteLength(serializeHostLogArtifact({ rejectedStreamDiagnostic: final, sourceIdentity: "runtime.log", guardSource })), belowActualAuditBytes: Buffer.byteLength(actualAudit.text), elapsedMs: performance.now() - start }));
} finally { rmSync(root, { recursive: true, force: true }); }
