import assert from "node:assert/strict";
import type { AgentHarness } from "../src/harness/types";

export function assertStructuredBackendContract(harness: AgentHarness): void {
  assert.ok(harness.supportedPermissionModes.includes("default"));
  assert.ok(harness.supportedPermissionModes.includes("plan"));
  assert.ok(harness.supportedPermissionModes.includes("bypassPermissions"));
  assert.equal(typeof harness.capabilities.nativePendingInput, "boolean");
  assert.equal(typeof harness.capabilities.nativePlanArtifacts, "boolean");
  // Every backend runs in OCA's plugin-managed worktrees; none advertise native worktrees.
  assert.equal(Object.hasOwn(harness.capabilities, "worktrees"), false);
  for (const action of harness.capabilities.threadActions ?? []) {
    assert.ok(["compact", "review"].includes(action));
    assert.equal(typeof harness.buildThreadActionMessage, "function");
  }
}
