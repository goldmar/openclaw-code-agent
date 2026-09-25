import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const dependabot = readFileSync(join(repoRoot, ".github", "dependabot.yml"), "utf8");
const workflow = readFileSync(
  join(repoRoot, ".github", "workflows", "dependabot-automerge.yml"),
  "utf8",
);

describe("Dependabot maintenance policy", () => {
  it("uses weekly updates with a 3-day cooldown and keeps CodeQL actions together", () => {
    const entries = dependabot.split(/\n  - package-ecosystem: /).slice(1);
    assert.equal(entries.length, 3);
    for (const entry of entries) {
      assert.match(entry, /interval: weekly/);
      assert.match(entry, /cooldown:\n\s+default-days: 3\n/);
    }
    assert.match(dependabot, /codeql:\n\s+patterns:\n\s+- github\/codeql-action\/\*/);
    assert.match(dependabot, /low-risk-development:[\s\S]*dependency-type: development/);
    assert.match(dependabot, /update-types:\n\s+- minor\n\s+- patch/);
    assert.match(dependabot, /directory: \/\.github\/release-tools/);
  });

  it("keeps the bundle toolchain out of the grouped low-risk development updates", () => {
    const group = dependabot.split("low-risk-development:")[1]?.split("open-pull-requests-limit")[0] ?? "";
    for (const name of ["esbuild", "typescript", "tsx", "typebox"]) {
      assert.match(group, new RegExp(`exclude-patterns:[\\s\\S]*- ${name}\\n`), name);
    }
  });

  it("uses a pinned, least-privilege privileged workflow without checking out PR code", () => {
    assert.match(workflow, /pull_request_target:/);
    assert.match(workflow, /issue_comment:/);
    assert.match(workflow, /permissions:\n  contents: read\n  issues: read\n  pull-requests: write/);
    assert.doesNotMatch(workflow, /contents: write/);
    assert.doesNotMatch(workflow, /actions\/checkout/);
    assert.match(
      workflow,
      /dependabot\/fetch-metadata@25dd0e34f4fe68f24cc83900b1fe3fe149efef98 # v3\.1\.0/,
    );
    assert.match(workflow, /if \[\[ "\$\(jq -r '\.user\.login'/);
    assert.match(workflow, /!= "dependabot\[bot\]"/);
    assert.equal((workflow.match(/if: steps\.pr\.outputs\.dependabot == 'true'/g) ?? []).length, 2);
    assert.ok(
      workflow.indexOf("Identify Dependabot PR") < workflow.indexOf("dependabot/fetch-metadata@"),
      "the workflow must reject ordinary PRs before invoking Dependabot metadata",
    );
  });

  it("limits auto-merge to low-risk exact heads after Greptile and protection gates", () => {
    assert.match(workflow, /version-update:semver-patch\|version-update:semver-minor/);
    assert.match(workflow, /direct:development/);
    assert.match(workflow, /anthropic\*\|\*claude\*\|\*openclaw\*/);
    assert.match(workflow, /\*esbuild\*\|\*typescript\*\|\*tsx\*\|\*typebox\*\)\n\s+echo "Manual review required for build toolchain dependency/);
    assert.ok(
      workflow.indexOf("*esbuild*|*typescript*|*tsx*|*typebox*") < workflow.indexOf('"$DEPENDENCY_TYPE" == "direct:development"'),
      "toolchain updates must stop before the development-dependency auto-merge path",
    );
    assert.match(workflow, /greptile-apps\[bot\]/);
    assert.match(workflow, /Confidence Score: 5\/5/);
    assert.match(workflow, /No blocking issues found/);
    assert.match(workflow, /contains\(\$sha\)/);
    assert.match(workflow, /autoMergeRequest/);
    assert.match(workflow, /gh pr merge --disable-auto/);
    assert.match(workflow, /gh pr merge --auto --squash/);
    assert.doesNotMatch(workflow, /--admin|--force/);
    assert.ok(
      workflow.indexOf("gh pr merge --disable-auto") < workflow.indexOf('case "$UPDATE_TYPE"'),
      "stale auto-merge must be revoked before replacement-head eligibility checks",
    );
  });
});
