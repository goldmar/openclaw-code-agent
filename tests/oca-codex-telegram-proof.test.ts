import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProofPlan,
  collectDoctorChecks,
  parseArgs,
  resolveProofOutputDir,
  runLocalSmoke,
  stagePublicArtifacts,
  writeGuardedRunScaffold,
} from "../scripts/e2e/oca-codex-telegram-proof";

const repoRoot = join(import.meta.dirname, "..");

describe("OCA Codex Telegram proof runner", () => {
  it("parses proof controls and rejects duplicate single-value options", () => {
    const opts = parseArgs([
      "local-smoke",
      "--scenario",
      "plan",
      "--output-dir",
      ".artifacts/qa-e2e/oca-codex-telegram/custom-proof",
      "--gateway-port",
      "39001",
      "--record-seconds",
      "12",
      "--provider",
      "local-container",
      "--keep-box",
    ]);

    assert.equal(opts.command, "local-smoke");
    assert.equal(opts.scenario, "plan");
    assert.equal(opts.outputDir, ".artifacts/qa-e2e/oca-codex-telegram/custom-proof");
    assert.equal(opts.gatewayPort, 39001);
    assert.equal(opts.recordSeconds, 12);
    assert.equal(opts.keepBox, true);

    assert.throws(() => parseArgs(["--output-dir", "one", "--output-dir", "two"]), /--output-dir was provided more than once/);
    assert.throws(() => parseArgs(["--gateway-port", "65536"]), /TCP port/);
    assert.throws(() => parseArgs(["--record-seconds", "1e3"]), /positive integer/);
  });

  it("rejects output directories outside the proof artifact root", () => {
    const outside = mkdtempSync(join(tmpdir(), "oca-codex-proof-outside-test-"));
    try {
      assert.throws(() => resolveProofOutputDir(outside), /--output-dir must resolve inside/);
      assert.throws(() => resolveProofOutputDir("../../tmp/oca-codex-proof-outside"), /--output-dir must resolve inside/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("prints a redacted proof plan without exposing Convex secret values", () => {
    const originalSecret = process.env.OPENCLAW_QA_CONVEX_SECRET_CI;
    const originalSite = process.env.OPENCLAW_QA_CONVEX_SITE_URL;
    try {
      process.env.OPENCLAW_QA_CONVEX_SECRET_CI = "super-secret-value";
      process.env.OPENCLAW_QA_CONVEX_SITE_URL = "https://example.test";
      const plan = buildProofPlan(parseArgs(["run", "--dry-run", "--scenario", "basic"]));

      assert.equal(plan.secrets.convexCiSecret, "set");
      assert.equal(plan.secrets.convexSiteUrl, "set");
      assert.equal(JSON.stringify(plan).includes("super-secret-value"), false);
      assert.equal(plan.telegram.credentialKind, "telegram-user");
      assert.equal(plan.gateway.isolatedHome, true);
    } finally {
      if (originalSecret === undefined) delete process.env.OPENCLAW_QA_CONVEX_SECRET_CI;
      else process.env.OPENCLAW_QA_CONVEX_SECRET_CI = originalSecret;
      if (originalSite === undefined) delete process.env.OPENCLAW_QA_CONVEX_SITE_URL;
      else process.env.OPENCLAW_QA_CONVEX_SITE_URL = originalSite;
    }
  });

  it("collects readiness checks without printing raw secret values", () => {
    const checks = collectDoctorChecks(parseArgs(["doctor", "--crabbox-bin", "/missing/crabbox"]));
    assert.ok(checks.some((check) => check.name === "fake Codex proof app server" && check.ok));
    assert.ok(checks.some((check) => check.name === "Crabbox binary" && !check.ok));
    assert.doesNotMatch(JSON.stringify(checks), /OPENCLAW_QA_CONVEX_SECRET_CI=.*[A-Za-z]/);
  });

  it("runs a deterministic local Codex proof smoke and writes redacted artifacts", async () => {
    const temp = mkdtempSync(join(tmpdir(), "oca-codex-proof-local-smoke-test-"));
    const outputDir = join(".artifacts", "qa-e2e", "oca-codex-telegram", `local-smoke-${Date.now()}`);
    try {
      const summary = await runLocalSmoke(parseArgs([
        "local-smoke",
        "--scenario",
        "worktree",
        "--output-dir",
        outputDir,
      ]));

      assert.equal(summary.ok, true);
      const messageTypes = summary.messageTypes as string[];
      assert.ok(messageTypes.includes("backend_ref"));
      assert.ok(messageTypes.includes("run_started"));
      assert.ok(messageTypes.includes("text_delta"));
      assert.equal(messageTypes.at(-1), "run_completed");
      const summaryPath = join(repoRoot, outputDir, "summary.json");
      assert.equal(existsSync(summaryPath), true);
      const summaryText = readFileSync(summaryPath, "utf8");
      assert.match(summaryText, /worktree/);
      assert.doesNotMatch(summaryText, /\/(?:home|tmp)\/[^"]+/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
      rmSync(join(repoRoot, outputDir), { recursive: true, force: true });
    }
  });

  it("treats the interrupted scenario as an expected local proof outcome", async () => {
    const outputDir = join(".artifacts", "qa-e2e", "oca-codex-telegram", `interrupted-${Date.now()}`);
    try {
      const summary = await runLocalSmoke(parseArgs([
        "local-smoke",
        "--scenario",
        "interrupted",
        "--output-dir",
        outputDir,
      ]));

      assert.equal(summary.ok, true);
      assert.equal((summary.terminal as { outcome?: string } | undefined)?.outcome, "interrupted");
    } finally {
      rmSync(join(repoRoot, outputDir), { recursive: true, force: true });
    }
  });

  it("stages only public proof artifacts and excludes session controls", () => {
    const temp = mkdtempSync(join(tmpdir(), "oca-codex-proof-stage-test-"));
    const outputDir = join(".artifacts", "qa-e2e", "oca-codex-telegram", `stage-${Date.now()}`);
    const artifactDir = join(repoRoot, outputDir);
    try {
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, "summary.json"), "{}");
      writeFileSync(join(artifactDir, "harness-messages.redacted.json"), "[]");
      writeFileSync(join(artifactDir, "session.json"), '{"secret":"x"}');
      writeFileSync(join(artifactDir, "lease.json"), '{"secret":"x"}');
      writeFileSync(join(artifactDir, "telegram-user-payload.json"), '{"secret":"x"}');

      const staged = stagePublicArtifacts(outputDir);

      assert.equal(existsSync(join(staged, "summary.json")), true);
      assert.equal(existsSync(join(staged, "harness-messages.redacted.json")), true);
      assert.equal(existsSync(join(staged, "session.json")), false);
      assert.equal(existsSync(join(staged, "lease.json")), false);
      assert.equal(existsSync(join(staged, "telegram-user-payload.json")), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("does not delete public artifacts for an unsafe output path", () => {
    const temp = mkdtempSync(join(tmpdir(), "oca-codex-proof-stage-outside-test-"));
    const marker = join(temp, "public-artifacts", "keep.txt");
    try {
      mkdirSync(join(temp, "public-artifacts"), { recursive: true });
      writeFileSync(marker, "keep");

      assert.throws(() => stagePublicArtifacts(temp), /--output-dir must resolve inside/);
      assert.equal(readFileSync(marker, "utf8"), "keep");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("validates run output before writing guarded native proof artifacts", () => {
    const temp = mkdtempSync(join(tmpdir(), "oca-codex-proof-run-outside-test-"));
    try {
      assert.throws(() => writeGuardedRunScaffold(parseArgs([
        "run",
        "--output-dir",
        temp,
      ])), /--output-dir must resolve inside/);

      assert.equal(existsSync(join(temp, "summary.json")), false);
      assert.equal(existsSync(join(temp, "mantis-evidence.json")), false);
      assert.equal(existsSync(join(temp, "public-artifacts")), false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
