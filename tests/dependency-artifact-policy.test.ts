import "./test-env";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateNpmShrinkwrap } from "../scripts/check-npm-shrinkwrap.mjs";
import {
  overridePackageName,
  pinnedOverrideErrors,
  pinnedRuntimeVersions,
  readPnpmWorkspaceOverrides,
} from "../scripts/lib/runtime-dependency-pins.mjs";

const repoRoot = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("dependency artifact policy", () => {
  it("delays automated updates with the Dependabot cooldown, not a pnpm publication-age gate", () => {
    const workspace = read("pnpm-workspace.yaml");
    const packageJson = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
    const dependabot = read(".github/dependabot.yml");

    // pnpm 11 checks every lockfile entry against minimumReleaseAge at install
    // time (frozen CI and release installs included), which would block
    // same-day OpenClaw compatibility releases.
    assert.match(workspace, /^minimumReleaseAge: 0$/m);
    assert.doesNotMatch(workspace, /minimumReleaseAgeExclude|minimumReleaseAgeStrict/);
    assert.match(dependabot, /cooldown:\n\s+default-days: 3/);
    assert.equal(packageJson.scripts?.["check-static-guardrails"], "node scripts/check-static-guardrails.mjs && node scripts/check-npm-shrinkwrap.mjs");
    assert.equal(packageJson.scripts?.["verify:npm-consumer"], "node scripts/verify-npm-consumer-install.mjs");
  });

  it("keeps pnpm overrides of pinned runtime dependencies equal to package.json", () => {
    const packageJson = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
    const pinned = pinnedRuntimeVersions(packageJson);
    const overrides = readPnpmWorkspaceOverrides(repoRoot);

    assert.deepEqual(pinnedOverrideErrors(overrides, pinned), []);
    assert.equal(overrides[`hono@<${pinned.hono}`], pinned.hono);
    assert.equal(overridePackageName("@hono/node-server@<2.1.1"), "@hono/node-server");
    assert.equal(overridePackageName("hono@<4.13.9"), "hono");
    assert.deepEqual(
      pinnedOverrideErrors({ "hono@<4.13.5": "4.13.7", "qs@<1.0.0": "1.0.0", "axios@<1.15.0": ">=1.15.0" }, { hono: "4.13.9", qs: "6.16.0" }),
      [
        'pnpm-workspace.yaml override "hono@<4.13.5: 4.13.7" must be "hono@<4.13.9: 4.13.9" to match package.json',
        'pnpm-workspace.yaml override "qs@<1.0.0: 1.0.0" must be "qs@<6.16.0: 6.16.0" to match package.json',
      ],
    );
    assert.throws(
      () => pinnedRuntimeVersions({ dependencies: { ...packageJson.dependencies, hono: "^4.13.9" } }),
      /exact runtime dependency hono/u,
    );
  });

  it("rejects a pnpm override that keeps a pinned runtime dependency below package.json", (t) => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "oca-shrinkwrap-override-drift-"));
    t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
    writeFileSync(join(fixtureDir, "package.json"), read("package.json"));
    writeFileSync(join(fixtureDir, "npm-shrinkwrap.json"), read("npm-shrinkwrap.json"));
    writeFileSync(
      join(fixtureDir, "pnpm-workspace.yaml"),
      read("pnpm-workspace.yaml").replace(/^ {2}hono@<[^:]+: .+$/mu, "  hono@<4.13.5: 4.13.7"),
    );

    assert.throws(() => validateNpmShrinkwrap(fixtureDir), /override "hono@<4\.13\.5: 4\.13\.7" must be/u);
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
