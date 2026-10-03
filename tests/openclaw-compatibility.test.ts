import "./test-env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateDiscoveryRejection, validateHostMinimumRejection } from "../scripts/check-openclaw-compatibility.mjs";

const incompatible = "plugin requires plugin API >=2099.1.1, but this host is 2026.9.8;";
const invalid = "invalid package plugin API metadata:";
const rejected = {
  plugins: [] as Array<{ id: string; status: string }>,
  diagnostics: [{ pluginId: "openclaw-code-agent", configDisposition: "preserve",
    message: `${incompatible} skipping discovery (check "openclaw --version")` }],
};

describe("compatibility discovery acceptance", () => {
  it("requires an explicit unchanged-artifact rejection on the older host", () => {
    const result = { ...rejected, diagnostics: [{ pluginId: "openclaw-code-agent",
      message: "plugin requires OpenClaw >=2026.9.8, but this host is 2026.9.7; skipping load" }] };
    validateHostMinimumRejection(result, "configured", "configured", ">=2026.9.8", "2026.9.7");
    assert.throws(() => validateHostMinimumRejection({}, "configured", "configured", ">=2026.9.8", "2026.9.7"));
    assert.throws(() => validateHostMinimumRejection(result, "configured", "changed", ">=2026.9.8", "2026.9.7"));
    assert.throws(() => validateHostMinimumRejection(result, "configured", "configured", ">=2026.9.8", "2026.9.6"));
    assert.throws(() => validateHostMinimumRejection({ ...result,
      plugins: [{ id: "openclaw-code-agent", status: "loaded" }],
    }, "configured", "configured", ">=2026.9.8", "2026.9.7"));
  });

  it("accepts an explicit preserved discovery rejection", () => {
    validateDiscoveryRejection(rejected, "configured", "configured", incompatible);
    validateDiscoveryRejection({ ...rejected, diagnostics: [{ ...rejected.diagnostics[0],
      message: `${invalid} bad range; skipping discovery (check package.json openclaw.compat.pluginApi)` }],
    }, "configured", "configured", invalid);
  });

  it("refuses the diagnostic of a different rejected declaration", () => {
    assert.throws(() => validateDiscoveryRejection(rejected, "configured", "configured", invalid));
    assert.throws(() => validateDiscoveryRejection({ ...rejected, diagnostics: [{ ...rejected.diagnostics[0],
      message: `${incompatible} loaded anyway` }],
    }, "configured", "configured", incompatible));
  });

  it("refuses an empty report or an unrelated diagnostic", () => {
    assert.throws(() => validateDiscoveryRejection({}, "configured", "configured", incompatible));
    assert.throws(() => validateDiscoveryRejection({ ...rejected,
      diagnostics: [{ ...rejected.diagnostics[0], pluginId: "other-plugin" }],
    }, "configured", "configured", incompatible));
  });

  it("refuses a loaded plugin even if an earlier diagnostic says it was skipped", () => {
    assert.throws(() => validateDiscoveryRejection({ ...rejected,
      plugins: [{ id: "openclaw-code-agent", status: "loaded" }],
    }, "configured", "configured", incompatible));
    assert.throws(() => validateDiscoveryRejection({ ...rejected,
      plugins: [{ id: "openclaw-code-agent", status: "error", toolNames: ["agent_launch"] }],
    }, "configured", "configured", incompatible));
  });

  it("refuses lost configuration or a diagnostic without preservation", () => {
    assert.throws(() => validateDiscoveryRejection(rejected, "configured", "removed", incompatible));
    assert.throws(() => validateDiscoveryRejection({ ...rejected,
      diagnostics: [{ ...rejected.diagnostics[0], configDisposition: "remove" }],
    }, "configured", "configured", incompatible));
  });
});
