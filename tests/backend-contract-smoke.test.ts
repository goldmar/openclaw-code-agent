import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getHarness } from "../src/harness";
import { assertStructuredBackendContract } from "./backend-contract-fixture";

describe("backend contract smoke", () => {
  it("keeps built-in backends on the shared structured contract", () => {
    const codex = getHarness("codex");
    const claude = getHarness("claude-code");
    const opencode = getHarness("opencode");

    for (const harness of [codex, claude, opencode]) {
      assertStructuredBackendContract(harness);
    }

    assert.equal(codex.backendKind, "codex-app-server");
    assert.equal(codex.capabilities.nativePendingInput, true);
    assert.equal(codex.capabilities.nativePlanArtifacts, true);
    assert.equal(codex.capabilities.worktrees, "native-restore");

    assert.equal(claude.backendKind, "claude-code");
    assert.equal(claude.capabilities.nativePendingInput, false);
    assert.equal(claude.capabilities.nativePlanArtifacts, false);
    assert.equal(claude.capabilities.worktrees, "plugin-managed");

    assert.equal(opencode.backendKind, "opencode-server");
    assert.equal(opencode.capabilities.nativePendingInput, true);
    assert.equal(opencode.capabilities.nativePlanArtifacts, false);
    assert.equal(opencode.capabilities.worktrees, "plugin-managed");
  });
});
