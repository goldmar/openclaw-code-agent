import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getHarness } from "../src/harness";

describe("backend contract smoke", () => {
  it("keeps both built-in backends on the shared structured contract", () => {
    const codex = getHarness("codex");
    const claude = getHarness("claude-code");

    for (const harness of [codex, claude]) {
      assert.ok(harness.supportedPermissionModes.includes("default"));
      assert.ok(harness.supportedPermissionModes.includes("plan"));
      assert.ok(harness.supportedPermissionModes.includes("bypassPermissions"));
      assert.equal(typeof harness.capabilities.nativePendingInput, "boolean");
      assert.equal(typeof harness.capabilities.nativePlanArtifacts, "boolean");
      assert.ok(["plugin-managed", "native-execution", "native-restore"].includes(harness.capabilities.worktrees));
    }

    assert.equal(codex.backendKind, "codex-app-server");
    assert.equal(codex.capabilities.nativePendingInput, true);
    assert.equal(codex.capabilities.nativePlanArtifacts, true);
    assert.equal(codex.capabilities.worktrees, "native-restore");

    assert.equal(claude.backendKind, "claude-code");
    assert.equal(claude.capabilities.nativePendingInput, false);
    assert.equal(claude.capabilities.nativePlanArtifacts, false);
    assert.equal(claude.capabilities.worktrees, "plugin-managed");
  });
});
