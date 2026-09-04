import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("dependency artifact policy", () => {
  it("admits reproducible dependency updates without publication-age gates", () => {
    const workspace = read("pnpm-workspace.yaml");
    const packageJson = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    const dependabot = read(".github/dependabot.yml");

    assert.match(workspace, /^minimumReleaseAge: 0$/m);
    assert.doesNotMatch(workspace, /minimumReleaseAgeExclude|minimumReleaseAgeStrict/);
    assert.doesNotMatch(dependabot, /cooldown:|default-days:/);
    assert.equal(packageJson.scripts?.["check-static-guardrails"], "node scripts/check-static-guardrails.mjs && node scripts/check-npm-shrinkwrap.mjs");
    assert.equal(packageJson.scripts?.["verify:npm-consumer"], "node scripts/verify-npm-consumer-install.mjs");
  });

  it("keeps exact OpenClaw 2026.9.1 resolution in the generated pnpm lockfile", () => {
    const lockfile = read("pnpm-lock.yaml");

    assert.match(lockfile, /openclaw:\n\s+specifier: 2026\.9\.1\n\s+version: 2026\.9\.1/);
    assert.match(lockfile, /'@openclaw\/ai@2026\.9\.1':/);
  });
});
