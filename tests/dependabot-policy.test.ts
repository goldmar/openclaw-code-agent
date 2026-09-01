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
  it("uses weekly updates without a publication-age cooldown and keeps CodeQL actions together", () => {
    assert.equal((dependabot.match(/interval: weekly/g) ?? []).length, 2);
    assert.doesNotMatch(dependabot, /cooldown:|default-days:/);
    assert.match(dependabot, /codeql:\n\s+patterns:\n\s+- github\/codeql-action\/\*/);
    assert.match(dependabot, /low-risk-development:[\s\S]*dependency-type: development/);
    assert.match(dependabot, /update-types:\n\s+- minor\n\s+- patch/);
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
  });

  it("limits auto-merge to low-risk exact heads after Greptile and protection gates", () => {
    assert.match(workflow, /version-update:semver-patch\|version-update:semver-minor/);
    assert.match(workflow, /direct:development/);
    assert.match(workflow, /anthropic\*\|\*claude\*\|\*openclaw\*/);
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
