// Offline selector/receipt controls only; no Gateway/native fixture is started.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { L1_CASES, l1Assignment, l1Coverage, validateL1Coverage } from "./oca501-l1-cohort.mjs";
import { buildEvidence, frameEvidence, decodeEvidence } from "./oca501-evidence.mjs";

const negativeControls = [], deny = (label, action) => { assert.throws(action, undefined, label); negativeControls.push(label); };
assert.deepEqual(Object.values(L1_CASES).map((cases) => cases.length), [3, 5, 9, 9]);
assert.equal(l1Assignment("matrix-l1").assignedCaseIds.length, 26);
assert.equal(l1Assignment("matrix-l1", "smoke").assignedCaseIds.length, 0);
for (const cohort of Object.keys(L1_CASES)) assert.deepEqual(l1Assignment("matrix-l1", cohort).assignedCaseIds, L1_CASES[cohort]);
for (const selector of ["", "foreign", "H06,H07", "H0*", "Smoke", null]) deny("closed single cohort only", () => l1Assignment("matrix-l1", selector));
for (const phase of ["prerequisites", "matrix-h01-h05", "routed-negative", undefined]) deny("selector is not valid on another phase", () => l1Assignment(phase, "smoke"));
for (const cohort of ["smoke", ...Object.keys(L1_CASES), "all"]) {
  const assigned = l1Assignment("matrix-l1", cohort).assignedCaseIds;
  const complete = l1Coverage(cohort, [...assigned], 0); validateL1Coverage({ phase: "matrix-l1", scriptExitCode: 0, ...complete }, cohort);
  assert.equal(complete.selectedCohortResult.classification, "PASS");
  for (const item of complete.l1CohortResults) assert.equal(item.classification, complete.unassignedCohorts.includes(item.cohort) ? "UNPROVEN" : "PASS");
  const prefix = assigned.slice(0, assigned.length ? assigned.length - 1 : 0);
  const blocked = l1Coverage(cohort, prefix, 1); validateL1Coverage({ phase: "matrix-l1", scriptExitCode: 1, ...blocked }, cohort);
  assert.equal(blocked.selectedCohortResult.classification, "BLOCKED");
  if (assigned.length) deny("partial selected prefix cannot pass", () => l1Coverage(cohort, prefix, 0));
  deny("missing actual completed inventory", () => l1Coverage(cohort, undefined, 1));
  deny("unexpected completed primary case", () => l1Coverage(cohort, ["foreign"], 1));
  if (assigned.length) deny("duplicate actual completion", () => l1Coverage(cohort, [assigned[0], assigned[0]], 1));
}

const directory = mkdtempSync(join(tmpdir(), "oca501-cohort-controls-"));
try {
  writeFileSync(join(directory, "receipt.json"), '{"classification":"OFFLINE_CONTROL_ONLY"}\n');
  const candidateSha = "a".repeat(40), nodeVersion = "24.16.0";
  const original = { candidateSha, nodeVersion, phase: "matrix-l1", expectedHostVersion: "2026.9.7", expectedNativeVersion: "0.159.3", scriptExitCode: 1, primaryFailure: "actual prefix failure retained", cleanup: { classification: "PASS", failures: [] }, ...l1Coverage("H06", ["H06-stale-run"], 1) };
  const bundle = buildEvidence(directory, [{ name: "receipt.json", alreadyRedacted: true }], original, []);
  const expected = { candidateSha, nodeVersion, phase: "matrix-l1", selectedL1Cohort: "H06" };
  const reframe = (changed) => frameEvidence({ ...changed, digest: createHash("sha256").update(JSON.stringify({ manifest: changed.manifest, files: changed.files })).digest("hex") });
  assert.deepEqual(decodeEvidence(frameEvidence(bundle), expected).manifest.remainingAssignedCaseIds, ["H06-cancel", "H06-matching-run"]);
  for (const change of [
    (m) => { m.selectedL1Cohort = "H07"; }, (m) => { delete m.selectedL1Cohort; },
    (m) => { m.assignedCaseIds.pop(); }, (m) => { m.assignedCaseIds.push("foreign"); }, (m) => { m.assignedCaseIds.push(m.assignedCaseIds[0]); },
    (m) => { delete m.assignedCaseIds; }, (m) => { delete m.completedCaseIds; },
    (m) => { m.completedCaseIds.push(m.completedCaseIds[0]); }, (m) => { m.completedCaseIds.push("H07-approve"); },
    (m) => { m.completedCaseIds = ["H06-cancel"]; }, (m) => { m.selectedCohortResult.classification = "PASS"; },
    (m) => { m.l1CohortResults[1].classification = "PASS"; }, (m) => { m.remainingAssignedCaseIds = []; },
    (m) => { m.unassignedCohorts = []; }, (m) => { m.scriptExitCode = 0; },
    (m) => { m.candidateSha = "b".repeat(40); }, (m) => { m.nodeVersion = "26.1.0"; }, (m) => { m.phase = "prerequisites"; },
  ]) { const changed = structuredClone(bundle); change(changed.manifest); deny("rehashed foreign/incomplete cohort identity refused before writing", () => decodeEvidence(reframe(changed), expected)); }
  deny("default all expectation cannot accept a single cohort", () => decodeEvidence(frameEvidence(bundle), { candidateSha, nodeVersion, phase: "matrix-l1" }));
  const completed = { ...original, scriptExitCode: 0, primaryFailure: null, ...l1Coverage("smoke", [], 0), hostVersion: "2026.9.7", upstreamTagCommit: "c074824a27c96d3983043f9eeb33823cd1772d8c", nativeVersion: "0.159.3", parentModel: "oca501/gpt-6-luna", officialCli: { nodeVersion: "v24.16.0", entryHash: "c".repeat(64), nodeHash: "c".repeat(64) } };
  for (const field of ["sourceArchiveHash", "hostEntryHash", "hostPackageHash", "nativeExecutableHash", "packageHash", "installedEntryHash", "acceptanceScriptHash", "evidenceHelperHash", "commandReceiptHelperHash"]) completed[field] = "c".repeat(64);
  const smoke = buildEvidence(directory, [{ name: "receipt.json", alreadyRedacted: true }], completed, []);
  assert.equal(decodeEvidence(frameEvidence(smoke), { ...expected, selectedL1Cohort: "smoke" }).manifest.selectedCohortResult.classification, "PASS", "Identity shape only, never genuine smoke acceptance");
  const source = join(directory, "job.stdout"); writeFileSync(source, frameEvidence(bundle));
  const decoder = new URL("./oca501-evidence.mjs", import.meta.url).pathname;
  const flags = ["--decode", source, "--out", join(directory, "decoded"), "--expected-sha", candidateSha, "--node-version", nodeVersion, "--phase", "matrix-l1", "--l1-cohort", "H06"];
  assert.equal(spawnSync(process.execPath, [decoder, ...flags], { encoding: "utf8" }).status, 0);
  for (const changed of [flags.slice(0, -2), [...flags, "--l1-cohort", "H06"], flags.map((v) => v === "H06" ? "H07" : v), flags.map((v) => v === "H06" ? "H06,H07" : v), flags.map((v) => v === "matrix-l1" ? "prerequisites" : v)]) {
    const out = join(directory, `refused-${negativeControls.length}`), args = changed.map((v) => v === join(directory, "decoded") ? out : v);
    assert.notEqual(spawnSync(process.execPath, [decoder, ...args], { encoding: "utf8" }).status, 0); assert.equal(existsSync(out), false); negativeControls.push("decoder cohort identity rejects before mkdir/writes");
  }
  const main = new URL("./oca-goal-host-acceptance.mjs", import.meta.url).pathname;
  for (const [phase, selector, extra] of [["matrix-l1", "", []], ["matrix-l1", "foreign", []], ["matrix-l1", "H06,H07", []], ["prerequisites", "smoke", []], ["matrix-l1", "smoke", ["--l1-cohort", "smoke"]]]) {
    const artifacts = join(directory, `uncreated-${negativeControls.length}`);
    const args = [main, "--expected-sha", candidateSha, "--node-version", nodeVersion, "--artifacts", artifacts, "--phase", phase, "--l1-cohort", selector, ...extra];
    const result = spawnSync(process.execPath, args, { encoding: "utf8" }); assert.notEqual(result.status, 0); assert.equal(existsSync(artifacts), false); assert.ok(!result.stdout.includes("OCA501_EVIDENCE"));
    assert.match(result.stderr, /closed L1 cohort|selector is valid only|Duplicate option|Missing value for --l1-cohort/); negativeControls.push("main closed/duplicate selector fails before acquisition or fixture side effects");
  }
  console.log(JSON.stringify({ classification: "OFFLINE_COHORT_CONTROLS_ONLY", positiveGroups: 10, negativeCount: negativeControls.length, negativeControls, primaryCounts: Object.values(L1_CASES).map((cases) => cases.length) }));
} finally { rmSync(directory, { recursive: true, force: true }); }
