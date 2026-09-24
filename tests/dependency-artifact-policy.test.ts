import "./test-env";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateNpmShrinkwrap } from "../scripts/check-npm-shrinkwrap.mjs";

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

  it("keeps the exact OpenClaw build target resolution in the generated pnpm lockfile", () => {
    const lockfile = read("pnpm-lock.yaml");
    const packageJson = JSON.parse(read("package.json")) as { openclaw?: { build?: { openclawVersion?: string } } };
    const target = packageJson.openclaw?.build?.openclawVersion ?? "";
    const version = target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

    assert.match(target, /^\d{4}\.\d+\.\d+$/u);
    assert.match(lockfile, new RegExp(`openclaw:\\n\\s+specifier: ${version}\\n\\s+version: ${version}`));
    assert.match(lockfile, new RegExp(`'@openclaw/ai@${version}':`));
  });

  it("rejects generated shrinkwrap engine metadata that drifts from package.json", (t) => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "oca-shrinkwrap-engine-drift-"));
    t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
    const packageJson = JSON.parse(read("package.json")) as Record<string, unknown>;
    const shrinkwrap = JSON.parse(read("npm-shrinkwrap.json")) as {
      packages: Record<string, { engines?: Record<string, string> }>;
    };
    shrinkwrap.packages[""].engines = { node: ">=24.0.0" };
    writeFileSync(join(fixtureDir, "package.json"), JSON.stringify(packageJson));
    writeFileSync(join(fixtureDir, "npm-shrinkwrap.json"), JSON.stringify(shrinkwrap));

    assert.throws(
      () => validateNpmShrinkwrap(fixtureDir),
      /root engines do not exactly match package\.json/u,
    );
  });
});
