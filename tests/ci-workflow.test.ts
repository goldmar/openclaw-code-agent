import "./test-env";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

function job(name: string): string {
  const start = ci.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `ci.yml has no ${name} job`);
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/u);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("CI workflow", () => {
  it("cancels superseded pull request runs but never cancels runs on main", () => {
    assert.match(ci, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/u);
    assert.doesNotMatch(ci, /cancel-in-progress: true/u);
  });

  it("installs and builds once per Node version: the PR checks reuse the Node 24 Verify leg", () => {
    assert.equal(existsSync(join(repoRoot, ".github", "workflows", "pr-checks.yml")), false);
    assert.equal((ci.match(/run: pnpm install/gu) ?? []).length, 1);
    assert.equal((ci.match(/pnpm run verify/gu) ?? []).length, 1);
    const verify = job("verify");
    assert.match(verify, /node-version: \[24\.16\.0, 26\.1\.0\]/u);
    assert.match(ci, /REPORT_NODE_VERSION: 24\.16\.0/u);
    assert.match(verify, /createBundleSizeReport\('dist'\)/u);
    assert.match(verify, /- name: Verify packed npm consumer dependency graph\n\s+if: matrix\.node-version == env\.REPORT_NODE_VERSION\n\s+run: pnpm verify:npm-consumer/u);
    assert.match(verify, /- name: Upload CI report\n\s+if: always\(\) && matrix\.node-version == env\.REPORT_NODE_VERSION/u);
  });

  it("keeps the required check names as jobs that fail, not skip, when Verify fails", () => {
    for (const [key, name] of [["size-check", "Bundle Size Check"], ["lockfile-check", "Lockfile Integrity Check"]] as const) {
      const text = job(key);
      assert.match(text, new RegExp(`^  ${key}:\\n    name: ${name}\\n    needs: verify\\n    if: \\$\\{\\{ !cancelled\\(\\) \\}\\}\\n`, "u"), key);
      assert.doesNotMatch(text, /run: pnpm install|pnpm run build|pnpm run verify|actions\/checkout/u, `${key} must not install or build again`);
      assert.match(text, /name: ci-report/u);
    }
    assert.match(job("size-check"), /core\.setFailed\('No bundle size report/u);
    assert.match(job("size-check"), /Fail if bundle exceeds limit/u);
    assert.match(job("lockfile-check"), /if: steps\.lockfile\.outputs\.outcome != 'success'/u);
  });

  it("comments on pull requests only, never from pushes or forks", () => {
    const commentConditions = ci.match(/if: .*github\.event\.pull_request\.head\.repo\.fork == false/gu) ?? [];
    assert.equal(commentConditions.length, 2);
    for (const condition of commentConditions) assert.match(condition, /github\.event_name == 'pull_request'/u);
  });
});
