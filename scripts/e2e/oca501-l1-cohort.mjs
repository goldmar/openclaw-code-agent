// Fixed L1 primary inventory. Subsidiary controls stay in their owning routine.
import assert from "node:assert/strict";

export const L1_CASES = Object.freeze({
  H06: Object.freeze(["H06-stale-run", "H06-cancel", "H06-matching-run"]),
  H07: Object.freeze(["H07-approve", "H07-revise-positive", "H07-stale-approve", "H07-stale-revise", "H07-reject"]),
  H09: Object.freeze(["H09-question-button", "H09-question-text", "H09-steer-positive", "H09-compact-positive", "H09-review-positive", "H09-deny-text", "H09-deny-compact", "H09-deny-review", "H09-deny-question"]),
  V1: Object.freeze(["V1-empty", "V1-blank", "V1-white", "V1-mixed", "V1-string", "V1-object", "V1-boolean", "V1-null-apply", "V1-removal"]),
});
export function l1Assignment(phase, selector) {
  if (phase !== "matrix-l1") { assert.equal(selector, undefined, "L1 selector is valid only for matrix-l1"); return; }
  const selectedL1Cohort = selector === undefined ? "all" : selector;
  assert.ok(["smoke", ...Object.keys(L1_CASES), "all"].includes(selectedL1Cohort), "Use one closed L1 cohort, never an empty/list/glob selector");
  const selected = selectedL1Cohort === "all" ? Object.keys(L1_CASES) : selectedL1Cohort === "smoke" ? [] : [selectedL1Cohort];
  return { selectedL1Cohort, assignedCaseIds: selected.flatMap((id) => L1_CASES[id]), selected, unassignedCohorts: Object.keys(L1_CASES).filter((id) => !selected.includes(id)) };
}
export function l1Coverage(selector, completedCaseIds, scriptExitCode) {
  const assignment = l1Assignment("matrix-l1", selector);
  assert.ok(Array.isArray(completedCaseIds) && new Set(completedCaseIds).size === completedCaseIds.length, "Completed primary inventory is present and unique");
  assert.ok(completedCaseIds.every((id) => assignment.assignedCaseIds.includes(id)), "No unassigned/unknown primary case can satisfy this cohort");
  // Real routines emit primary completions in this fixed sequence. A blocked
  // prefix is valid failure transport; zero exit requires the whole inventory.
  assert.deepEqual(completedCaseIds, assignment.assignedCaseIds.slice(0, completedCaseIds.length));
  assert.ok(Number.isSafeInteger(scriptExitCode) && scriptExitCode >= 0);
  if (scriptExitCode === 0) assert.deepEqual(completedCaseIds, assignment.assignedCaseIds, "A partial selected cohort cannot pass");
  return { selectedL1Cohort: assignment.selectedL1Cohort, assignedCaseIds: assignment.assignedCaseIds, completedCaseIds,
    selectedCohortResult: { cohort: assignment.selectedL1Cohort, classification: scriptExitCode === 0 ? "PASS" : "BLOCKED" },
    l1CohortResults: Object.keys(L1_CASES).map((cohort) => ({ cohort, classification: assignment.selected.includes(cohort) ? scriptExitCode === 0 ? "PASS" : "BLOCKED" : "UNPROVEN" })),
    remainingAssignedCaseIds: assignment.assignedCaseIds.filter((id) => !completedCaseIds.includes(id)), unassignedCohorts: assignment.unassignedCohorts };
}
export function validateL1Coverage(manifest, expectedSelector) {
  const assignment = l1Assignment(manifest.phase, expectedSelector);
  const fields = ["selectedL1Cohort", "assignedCaseIds", "completedCaseIds", "selectedCohortResult", "l1CohortResults", "remainingAssignedCaseIds", "unassignedCohorts"];
  if (!assignment) { for (const field of fields) assert.equal(manifest[field], undefined, "Other phases cannot carry L1 selector coverage"); return; }
  assert.equal(manifest.selectedL1Cohort, assignment.selectedL1Cohort, "External expected L1 cohort mismatch");
  const required = l1Coverage(assignment.selectedL1Cohort, manifest.completedCaseIds, manifest.scriptExitCode);
  for (const field of fields) assert.deepEqual(manifest[field], required[field], `Exact L1 ${field} mismatch`);
}
