import "./test-env";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
const toolsPackage = JSON.parse(
  readFileSync(join(repoRoot, ".github", "release-tools", "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };
const toolsLock = JSON.parse(
  readFileSync(join(repoRoot, ".github", "release-tools", "package-lock.json"), "utf8"),
) as { lockfileVersion?: number; packages?: Record<string, { version?: string; integrity?: string; resolved?: string }> };

/** The text of one top-level job, from its key to the next job key. */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `release.yml has no ${name} job`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/u);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** Every `run:` block of the workflow, with its continuation lines. */
function runBlocks(): string[] {
  return [...workflow.matchAll(/^( +)run: [|>]?.*\n((?:\1 {2}.*\n|\s*\n)*)/gmu)].map((match) => match[0]);
}

describe("release workflow", () => {
  it("runs the ClawHub static scan on the exact packed artifact", () => {
    assert.match(
      workflow,
      /npm pack --json --pack-destination artifact[\s\S]*node scripts\/check-clawhub-scan\.mjs "--tarball=artifact\/\$TARBALL"/,
    );
  });

  it("validates the inputs before anything else and never interpolates them into shell steps", () => {
    const verify = job("verify");
    const firstStep = verify.slice(verify.indexOf("steps:"));
    assert.match(firstStep, /^steps:\n\s+- name: Validate inputs\n/u);
    assert.match(verify, /\[\[ "\$COMMIT" =~ \^\[0-9a-f\]\{40\}\$ \]\]/u);
    assert.match(verify, /semver='\^\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)/u);
    assert.match(workflow, /^ {2}VERSION: \$\{\{ inputs\.version \}\}$/mu);
    assert.match(workflow, /^ {2}COMMIT: \$\{\{ inputs\.commit \}\}$/mu);
    for (const block of runBlocks()) {
      assert.doesNotMatch(block, /\$\{\{/u, `run block interpolates an expression:\n${block}`);
    }
  });

  it("accepts only strict semantic versions", () => {
    const pattern = /semver='([^']+)'/u.exec(workflow)?.[1];
    assert.ok(pattern);
    const semver = new RegExp(pattern, "u");
    for (const good of ["5.0.0", "0.1.2", "5.0.0-rc.1", "5.0.0-beta.0.alpha-1"]) assert.match(good, semver, good);
    for (const bad of ["v5.0.0", "5.0", "05.0.0", "5.0.0-01", "5.0.0+build.1", "5.0.0\nx", "5.0.0; rm -rf /", "5.0.0-"]) {
      assert.doesNotMatch(bad, semver, JSON.stringify(bad));
    }
  });

  it("uses no dependency cache in the release workflow", () => {
    assert.doesNotMatch(workflow, /cache: pnpm|actions\/cache@/u);
  });

  it("installs one pinned ClawHub CLI from a committed lockfile with integrity hashes", () => {
    assert.equal(toolsPackage.dependencies?.clawhub, "0.23.3");
    assert.equal(toolsLock.lockfileVersion, 3);
    assert.equal(toolsLock.packages?.["node_modules/clawhub"]?.version, "0.23.3");
    for (const [path, entry] of Object.entries(toolsLock.packages ?? {})) {
      if (!path) continue;
      assert.match(entry.integrity ?? "", /^sha512-/u, `${path} has no integrity hash`);
      assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//u, `${path} does not resolve from the npm registry`);
    }
    assert.doesNotMatch(workflow, /pnpm dlx|npx |npm install --global|npm i -g|CLAWHUB_INSPECTOR_VERSION|CLAWHUB_CLI_VERSION/u);
    assert.equal((workflow.match(/npm ci --prefix "\$RELEASE_TOOLS_DIR" --ignore-scripts --no-audit --no-fund/gu) ?? []).length, 2);
    assert.match(job("verify"), /"\$RELEASE_TOOLS_DIR\/node_modules\/\.bin\/clawhub" package validate/u);
    assert.match(job("verify"), /"\$RELEASE_TOOLS_DIR\/node_modules\/\.bin\/clawhub" package publish "\$PWD"[\s\S]*--dry-run --json/u);
  });

  it("publishes to npm with only an OIDC token and nothing third-party installed", () => {
    const npm = job("publish-npm");
    assert.match(npm, /environment: release/u);
    assert.match(npm, /permissions:\n\s+contents: read\n\s+id-token: write\n/u);
    assert.doesNotMatch(npm, /contents: write|secrets\.|actions\/checkout|npm (ci|install)|clawhub|pnpm/u);
    assert.match(npm, /npm publish "\.\/artifact\/\$TARBALL" --access public --provenance/u);
    assert.match(npm, /Reverify artifact digest/u);
  });

  it("publishes to ClawHub from its own job with the environment token and no OIDC or write access", () => {
    const clawhub = job("publish-clawhub");
    assert.match(clawhub, /environment: release/u);
    assert.match(clawhub, /permissions:\n\s+contents: read\n\s+steps:/u);
    assert.doesNotMatch(clawhub, /id-token|contents: write/u);
    assert.match(clawhub, /persist-credentials: false/u);
    assert.match(clawhub, /CLAWHUB_TOKEN: \$\{\{ secrets\.CLAWHUB_TOKEN \}\}/u);
    assert.match(clawhub, /Remove ClawHub token config\n\s+if: always\(\)/u);
    assert.equal((workflow.match(/secrets\./gu) ?? []).length, 1, "only the ClawHub job reads a secret");
  });

  it("waits for definitive ClawHub publication before verifying the artifact", () => {
    assert.match(
      job("publish-clawhub"),
      /"\$clawhub" package publish "\$artifact"[\s\S]*--source-ref "v\$VERSION" \\\n[\s\S]*--wait \\\n+[\s\S]*--wait-timeout 2400 \\\n+[\s\S]*--json\n\s+"\$clawhub" package verify/,
    );
  });

  it("creates the immutable tag only after environment approval and before either registry publish", () => {
    const tag = job("tag");
    assert.match(tag, /needs: verify\n/u);
    assert.match(tag, /environment: release/u);
    assert.match(tag, /permissions:\n\s+contents: write\n/u);
    assert.doesNotMatch(tag, /actions\/checkout|id-token/u);
    assert.match(tag, /test "\$existing" = "\$COMMIT"/u);
    assert.match(job("publish-npm"), /needs: \[verify, tag\]/u);
    assert.match(job("publish-clawhub"), /needs: \[verify, tag\]/u);
  });

  it("creates the GitHub release after both registries without persisted credentials", () => {
    const release = job("github-release");
    assert.match(release, /needs: \[verify, publish-npm, publish-clawhub\]/u);
    assert.match(release, /persist-credentials: false/u);
    assert.doesNotMatch(release, /id-token|environment:/u);
    assert.match(release, /gh release create "\$TAG" "artifact\/\$TARBALL" --verify-tag/u);
  });

  it("checks out only the dispatch ref and moves to the selected commit after proving it is on main", () => {
    assert.doesNotMatch(workflow, /ref: \$\{\{ inputs\.commit \}\}/u);
    assert.match(
      job("verify"),
      /git merge-base --is-ancestor "\$COMMIT" origin\/main\n\s+git switch --detach "\$COMMIT"\n\s+test "\$\(git rev-parse HEAD\)" = "\$COMMIT"/u,
    );
    assert.match(
      job("github-release"),
      /git merge-base --is-ancestor "\$COMMIT" origin\/main\n\s+git show "\$COMMIT:CHANGELOG\.md"/u,
    );
  });

  it("never persists checkout credentials", () => {
    const checkouts = workflow.match(/uses: actions\/checkout@[\s\S]*?(?=\n\s+- name:|\n {2}[a-z])/gu) ?? [];
    assert.ok(checkouts.length >= 3);
    for (const checkout of checkouts) assert.match(checkout, /persist-credentials: false/u);
  });

  it("does not substitute fixed sleeps for ClawHub publication state", () => {
    assert.doesNotMatch(workflow, /for delay in/);
    assert.doesNotMatch(workflow, /sleep "\$delay"/);
  });
});
