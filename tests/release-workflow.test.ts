import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

describe("release workflow", () => {
  it("waits for definitive ClawHub publication before verifying the artifact", () => {
    assert.match(workflow, /CLAWHUB_INSPECTOR_VERSION: "0\.23\.1"/);
    assert.match(workflow, /CLAWHUB_CLI_VERSION: "0\.23\.3"/);
    assert.match(
      workflow,
      /clawhub package publish "\$artifact"[\s\S]*--wait \\\n+[\s\S]*--wait-timeout 2400 \\\n+[\s\S]*--json\n\s+clawhub package verify/,
    );
  });

  it("keeps publication polling upgrades separate from inspector policy", () => {
    assert.match(
      workflow,
      /pnpm dlx "clawhub@\$CLAWHUB_INSPECTOR_VERSION" package validate/,
    );
    assert.match(workflow, /npm install --global "clawhub@\$CLAWHUB_CLI_VERSION"/);
  });

  it("does not substitute fixed sleeps for ClawHub publication state", () => {
    assert.doesNotMatch(workflow, /for delay in/);
    assert.doesNotMatch(workflow, /sleep "\$delay"/);
  });
});
