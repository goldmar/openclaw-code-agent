import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findUnexpectedPluginSafetyFindings } from "../scripts/check-plugin-security.mjs";

const expectedFinding = {
  checkId: "plugins.code_safety",
  title: 'Plugin "openclaw-code-agent" contains dangerous code patterns',
  detail: [
    "Found 1 critical issue(s) in 1 scanned file(s):",
    "  - dist/index.js:1 [dangerous-exec] Shell command execution detected (child_process)",
    "  - dist/index.js:2 [env-harvesting] Environment variable access combined with network send — possible credential harvesting",
  ].join("\n"),
};

describe("packed-plugin security finding validation", () => {
  it("accepts only the reviewed child_process and bundled env/network findings", () => {
    assert.deepEqual(findUnexpectedPluginSafetyFindings({ findings: [expectedFinding] }), []);
  });

  it("rejects additional dangerous-code patterns", () => {
    const finding = {
      ...expectedFinding,
      detail: `${expectedFinding.detail}\n  - dist/index.js:2 [dynamic-code-execution] Dynamic code execution detected`,
    };
    assert.match(findUnexpectedPluginSafetyFindings({ findings: [finding] })[0], /dynamic-code/);
  });

  it("fails when the expected plugin scan result is absent or incomplete", () => {
    assert.equal(findUnexpectedPluginSafetyFindings({ findings: [] }).length, 1);
    assert.equal(
      findUnexpectedPluginSafetyFindings({
        findings: [{ checkId: "plugins.code_safety.scan_failed", title: 'Plugin "openclaw-code-agent" code scan failed' }],
      }).length,
      2,
    );
  });
});
