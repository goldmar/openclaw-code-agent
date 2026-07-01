import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const workflowPath = join(repoRoot, ".github", "workflows", "oca-codex-telegram-proof.yml");
const packageJsonPath = join(repoRoot, "package.json");

describe("OCA Codex Telegram proof workflow", () => {
  it("is manual-only and does not become a PR or push gate", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    assert.match(workflow, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /\n  pull_request:/);
    assert.doesNotMatch(workflow, /\n  push:/);
    assert.doesNotMatch(workflow, /\n  schedule:/);
  });

  it("uses narrow permissions and serializes Telegram-account proof runs", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    assert.match(workflow, /permissions:\n  actions: read\n  contents: read/);
    assert.doesNotMatch(workflow, /issues: write/);
    assert.doesNotMatch(workflow, /pull-requests: write/);
    assert.match(workflow, /Wait for older OCA Telegram proof run/);
    assert.match(workflow, /oca-codex-telegram-proof\.yml/);
    assert.match(workflow, /for status in queued in_progress waiting pending requested/);
    assert.match(workflow, /sleep 60/);
  });

  it("runs the deterministic local Codex proof before native Telegram capture is made mandatory", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    assert.equal(
      packageJson.scripts?.["proof:codex-local"],
      "node --import tsx scripts/e2e/oca-codex-telegram-proof.ts local-smoke",
    );
    assert.equal(
      packageJson.scripts?.["proof:codex-telegram"],
      "node --import tsx scripts/e2e/oca-codex-telegram-proof.ts run",
    );
    assert.match(workflow, /pnpm proof:codex-local/);
    assert.match(workflow, /pnpm proof:codex-telegram --dry-run/);
    assert.match(workflow, /--scenario "\$\{\{ inputs\.scenario \}\}"/);
    assert.match(workflow, /Upload OCA Codex proof artifacts/);
  });

  it("contains a cleanup step for future Telegram user leases", () => {
    const workflow = readFileSync(workflowPath, "utf8");

    assert.match(workflow, /Release leaked Telegram proof leases/);
    assert.match(workflow, /OPENCLAW_QA_CONVEX_SECRET_CI/);
    assert.match(workflow, /OPENCLAW_QA_CONVEX_SITE_URL/);
    assert.match(workflow, /\*\/\.session\/lease\.json/);
  });
});
