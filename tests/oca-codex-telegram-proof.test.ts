import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProofPlan,
  collectDoctorChecks,
  parseArgs,
  renderRemoteSetup,
  resolveProofOutputDir,
  runNativeProof,
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
      "--env-file",
      ".private/convex.env",
      "--tdlib-archive",
      "/tmp/tdlib.tgz",
      "--tdlib-sha256",
      "943518ad39f67e20f843713ba5c88fedbd06111fbc314c61bfb2fc3f1a45743e",
      "--allow-live",
      "--keep-box",
    ]);

    assert.equal(opts.command, "local-smoke");
    assert.equal(opts.scenario, "plan");
    assert.equal(opts.outputDir, ".artifacts/qa-e2e/oca-codex-telegram/custom-proof");
    assert.equal(opts.gatewayPort, 39001);
    assert.equal(opts.recordSeconds, 12);
    assert.equal(opts.keepBox, true);
    assert.equal(opts.envFile, ".private/convex.env");
    assert.equal(opts.tdlibArchive, "/tmp/tdlib.tgz");
    assert.equal(opts.tdlibSha256, "943518ad39f67e20f843713ba5c88fedbd06111fbc314c61bfb2fc3f1a45743e");
    assert.equal(opts.allowLive, true);

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
      assert.equal(plan.liveExecution.enabled, false);
      assert.equal(JSON.stringify(plan).includes("super-secret-value"), false);
      assert.equal(plan.telegram.credentialKind, "telegram-user");
      assert.equal(plan.gateway.isolatedHome, true);
      assert.equal(plan.telegram.tdlibArchive, "missing");
      assert.equal(plan.telegram.tdlibSha256, "missing");
    } finally {
      if (originalSecret === undefined) delete process.env.OPENCLAW_QA_CONVEX_SECRET_CI;
      else process.env.OPENCLAW_QA_CONVEX_SECRET_CI = originalSecret;
      if (originalSite === undefined) delete process.env.OPENCLAW_QA_CONVEX_SITE_URL;
      else process.env.OPENCLAW_QA_CONVEX_SITE_URL = originalSite;
    }
  });

  it("runs password login before remote status without exposing the password in argv", () => {
    const script = renderRemoteSetup(parseArgs(["run"]));
    const loginIndex = script.indexOf('python3 "$root/user-driver.py" login');
    const statusIndex = script.indexOf('python3 "$root/user-driver.py" status');

    assert.ok(loginIndex > 0);
    assert.ok(statusIndex > loginIndex);
    assert.match(script, /TELEGRAM_USER_DRIVER_PASSWORD="\$telegram_password"/);
    assert.doesNotMatch(script, /login --password/);
    assert.match(script, /telegram-user-payload\.json/);
    assert.match(script, /telegram-user-password/);
  });

  it("refuses native Telegram proof unless both the env gate and live flag are present", async () => {
    const original = process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
    try {
      delete process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
      await assert.rejects(
        runNativeProof(parseArgs(["run", "--allow-live"])),
        /Native Telegram Desktop proof is disabled by default/,
      );

      process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = "1";
      await assert.rejects(
        runNativeProof(parseArgs(["run"])),
        /Native Telegram Desktop proof is disabled by default/,
      );
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
      else process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = original;
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
      assert.equal(existsSync(join(repoRoot, outputDir, "public-artifacts", "summary.json")), true);
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
      writeFileSync(
        join(artifactDir, "summary.json"),
        JSON.stringify({
          secret: "super-secret",
          password: "hunter2",
          apiKey: "abc123",
          credential: "lease-secret",
          error: "forced failure token=inline-secret",
        }),
      );
      writeFileSync(join(artifactDir, "harness-messages.redacted.json"), "[]");
      writeFileSync(join(artifactDir, "codex-app-server-requests.redacted.jsonl"), "not json password hunter2 apiKey abc123 credential lease-secret\n");
      writeFileSync(join(artifactDir, "mantis-evidence.json"), '{"note":"apiKey abc123 credential lease-secret"}');
      writeFileSync(join(artifactDir, "telegram-transcript.redacted.json"), '{"messages":[{"text":"token=abc123 user @qa_secret_user"}]}');
      writeFileSync(join(artifactDir, "telegram-callback.redacted.json"), '{"button":{"data":"secret-callback-token"},"messageId":"9988776655"}');
      writeFileSync(join(artifactDir, "telegram-callback-answer.redacted.json"), '{"answered":true,"updatesSeen":1}');
      writeFileSync(join(artifactDir, "oca-codex-telegram-proof.md"), 'secret=super-secret password hunter2 apiKey abc123 credential lease-secret authorization: "Bearer abc123"');
      writeFileSync(
        join(artifactDir, "telegram-desktop.log"),
        "token 123456789:abcdefghijklmnopqrstuvwxyzABCDE user @qa_secret_user group -1003863755361 file /tmp/oca-proof/session.log home /home/runner/work/openclaw-code-agent/proof.log mac /Users/runner/work/proof.log workspace /workspace/openclaw/proof.log runtime /run/user/1001/proof.log token=log-secret password hunter2 apiKey abc123 credential lease-secret",
      );
      writeFileSync(join(artifactDir, "telegram-desktop.png"), "fake rendered @qa_secret_user");
      writeFileSync(join(artifactDir, "session.json"), '{"secret":"x"}');
      writeFileSync(join(artifactDir, "lease.json"), '{"secret":"x"}');
      writeFileSync(join(artifactDir, "telegram-user-payload.json"), '{"secret":"x"}');

      const staged = stagePublicArtifacts(outputDir);

      assert.equal(existsSync(join(staged, "summary.json")), true);
      assert.equal(existsSync(join(staged, "harness-messages.redacted.json")), true);
      assert.equal(existsSync(join(staged, "codex-app-server-requests.redacted.jsonl")), true);
      assert.equal(existsSync(join(staged, "mantis-evidence.json")), true);
      assert.equal(existsSync(join(staged, "telegram-transcript.redacted.json")), true);
      assert.equal(existsSync(join(staged, "telegram-callback.redacted.json")), true);
      assert.equal(existsSync(join(staged, "telegram-callback-answer.redacted.json")), true);
      assert.equal(existsSync(join(staged, "oca-codex-telegram-proof.md")), true);
      assert.equal(existsSync(join(staged, "telegram-desktop.log")), true);
      const stagedSummary = readFileSync(join(staged, "summary.json"), "utf8");
      assert.doesNotThrow(() => JSON.parse(stagedSummary));
      assert.doesNotMatch(stagedSummary, /super-secret|hunter2|abc123|lease-secret|inline-secret/);
      const stagedLog = readFileSync(join(staged, "telegram-desktop.log"), "utf8");
      assert.doesNotMatch(stagedLog, /123456789:abcdefghijklmnopqrstuvwxyzABCDE/);
      assert.doesNotMatch(stagedLog, /qa_secret_user/);
      assert.doesNotMatch(stagedLog, /-1003863755361/);
      assert.doesNotMatch(stagedLog, /\/tmp\/oca-proof/);
      assert.doesNotMatch(stagedLog, /\/home\/runner\/work/);
      assert.doesNotMatch(stagedLog, /\/Users\/runner\/work/);
      assert.doesNotMatch(stagedLog, /\/workspace\/openclaw/);
      assert.doesNotMatch(stagedLog, /\/run\/user\/1001/);
      assert.doesNotMatch(stagedLog, /log-secret|hunter2|abc123|lease-secret/);
      const stagedMarkdown = readFileSync(join(staged, "oca-codex-telegram-proof.md"), "utf8");
      assert.doesNotMatch(stagedMarkdown, /super-secret|hunter2|abc123/);
      const stagedEvidence = readFileSync(join(staged, "mantis-evidence.json"), "utf8");
      assert.doesNotMatch(stagedEvidence, /abc123|lease-secret/);
      const stagedJsonl = readFileSync(join(staged, "codex-app-server-requests.redacted.jsonl"), "utf8");
      assert.doesNotMatch(stagedJsonl, /hunter2|abc123|lease-secret/);
      const stagedTranscript = readFileSync(join(staged, "telegram-transcript.redacted.json"), "utf8");
      assert.doesNotMatch(stagedTranscript, /abc123|qa_secret_user/);
      const stagedCallback = readFileSync(join(staged, "telegram-callback.redacted.json"), "utf8");
      assert.doesNotMatch(stagedCallback, /secret-callback-token|9988776655/);
      assert.equal(existsSync(join(staged, "telegram-desktop.png")), false);
      assert.match(readFileSync(join(staged, "omitted-private-artifacts.json"), "utf8"), /telegram-desktop\.png/);
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

  it("runs native proof orchestration with local fakes and redacts public evidence", async () => {
    const original = process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
    const outputDir = join(".artifacts", "qa-e2e", "oca-codex-telegram", `native-fake-${Date.now()}`);
    const artifactDir = join(repoRoot, outputDir);
    const events: string[] = [];
    try {
      process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = "1";
      const result = await runNativeProof(parseArgs([
        "run",
        "--allow-live",
        "--output-dir",
        outputDir,
      ]), {
        async acquireCredentialLease(_opts, sessionDir) {
          events.push("acquire");
          const leaseFile = join(sessionDir, "lease.json");
          writeFileSync(leaseFile, '{"leaseToken":"123456789:abcdefghijklmnopqrstuvwxyzABCDE"}');
          return {
            credentialId: "credential-123456789",
            desktopWorkdir: join(sessionDir, "desktop"),
            groupId: "-1003863755361",
            leaseFile,
            ownerId: "telegram-user-owner",
            sutUsername: "sut_bot_secret",
            testerUserId: "9988776655",
            testerUsername: "qa_secret_user",
            userDriverDir: join(sessionDir, "user-driver"),
          };
        },
        async startLocalSut() {
          events.push("start-sut");
          return { gatewayPort: 38975, isolatedHome: "/home/openclaw/private-proof-home" };
        },
        async startCrabboxDesktop() {
          events.push("start-crabbox");
          return { createdLease: true, id: "cbx-secret-123456789", provider: "local-container", target: "linux" };
        },
        async captureEvidence({ outputDir: absoluteOutputDir }) {
          events.push("capture");
          const publicLog = join(absoluteOutputDir, "telegram-desktop.log");
          const publicPng = join(absoluteOutputDir, "telegram-desktop.png");
          const privateSession = join(absoluteOutputDir, "session.json");
          writeFileSync(publicLog, "token 123456789:abcdefghijklmnopqrstuvwxyzABCDE user @qa_secret_user group -1003863755361 path /tmp/openclaw-proof/desktop.log password=hunter2");
          writeFileSync(publicPng, "fake png");
          writeFileSync(privateSession, '{"botToken":"123456789:abcdefghijklmnopqrstuvwxyzABCDE"}');
          return [
            { kind: "log", path: publicLog, public: true },
            { kind: "screenshot", path: publicPng, public: true },
            { kind: "json", path: privateSession, public: false },
          ];
        },
        async stopCrabboxDesktop() {
          events.push("stop-crabbox");
        },
        async stopLocalSut() {
          events.push("stop-sut");
        },
        async releaseCredentialLease() {
          events.push("release");
        },
      });

      assert.equal(result.ok, true);
      assert.deepEqual(events, ["acquire", "start-sut", "start-crabbox", "capture", "stop-crabbox", "stop-sut", "release"]);
      assert.equal(existsSync(join(repoRoot, outputDir, ".session")), false);

      const summaryText = readFileSync(join(repoRoot, outputDir, "summary.json"), "utf8");
      assert.doesNotMatch(summaryText, /123456789:abcdefghijklmnopqrstuvwxyzABCDE/);
      assert.doesNotMatch(summaryText, /qa_secret_user/);
      assert.doesNotMatch(summaryText, /-1003863755361/);
      assert.doesNotMatch(summaryText, /telegram-desktop\.png/);

      assert.equal(result.staged, join(outputDir, "public-artifacts"));
      const staged = join(repoRoot, outputDir, "public-artifacts");
      assert.equal(existsSync(join(staged, "telegram-desktop.log")), true);
      assert.equal(existsSync(join(staged, "telegram-desktop.png")), false);
      assert.match(readFileSync(join(staged, "omitted-private-artifacts.json"), "utf8"), /telegram-desktop\.png/);
      assert.equal(existsSync(join(staged, "session.json")), false);
      const stagedLog = readFileSync(join(staged, "telegram-desktop.log"), "utf8");
      assert.doesNotMatch(stagedLog, /123456789:abcdefghijklmnopqrstuvwxyzABCDE/);
      assert.doesNotMatch(stagedLog, /qa_secret_user/);
      assert.doesNotMatch(stagedLog, /-1003863755361/);
      assert.doesNotMatch(stagedLog, /\/tmp\/openclaw-proof/);
      assert.doesNotMatch(stagedLog, /hunter2/);
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
      else process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = original;
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("releases credential and stops local SUT when Crabbox startup fails", async () => {
    const original = process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
    const outputDir = join(".artifacts", "qa-e2e", "oca-codex-telegram", `native-failure-${Date.now()}`);
    const artifactDir = join(repoRoot, outputDir);
    const events: string[] = [];
    try {
      process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = "1";
      const result = await runNativeProof(parseArgs([
        "run",
        "--allow-live",
        "--output-dir",
        outputDir,
      ]), {
        async acquireCredentialLease(_opts, sessionDir) {
          events.push("acquire");
          return {
            credentialId: "credential-1",
            desktopWorkdir: join(sessionDir, "desktop"),
            groupId: "-1001234567890",
            leaseFile: join(sessionDir, "lease.json"),
            ownerId: "owner",
            testerUserId: "123456789",
            testerUsername: "tester",
            userDriverDir: join(sessionDir, "user-driver"),
          };
        },
        async startLocalSut() {
          events.push("start-sut");
          return { gatewayPort: 38975, isolatedHome: "/tmp/openclaw-proof-home" };
        },
        async startCrabboxDesktop() {
          events.push("start-crabbox");
          throw new Error("crabbox unavailable token=inline-secret");
        },
        async captureEvidence() {
          events.push("capture");
          return [];
        },
        async stopCrabboxDesktop() {
          events.push("stop-crabbox");
        },
        async stopLocalSut() {
          events.push("stop-sut");
        },
        async releaseCredentialLease() {
          events.push("release");
        },
      });

      assert.equal(result.ok, false);
      assert.match(String(result.error), /crabbox unavailable/);
      assert.deepEqual(events, ["acquire", "start-sut", "start-crabbox", "stop-sut", "release"]);
      assert.equal(existsSync(join(repoRoot, outputDir, ".session")), false);
      const summaryText = readFileSync(join(artifactDir, "summary.json"), "utf8");
      assert.doesNotThrow(() => JSON.parse(summaryText));
      assert.doesNotMatch(summaryText, /inline-secret/);
      const manifest = JSON.parse(readFileSync(join(artifactDir, "mantis-evidence.json"), "utf8")) as {
        comparison?: { pass?: boolean; candidate?: { status?: string } };
      };
      assert.equal(manifest.comparison?.pass, false);
      assert.equal(manifest.comparison?.candidate?.status, "fail");
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
      else process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = original;
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("reports missing lease files as cleanup failures and preserves the session directory", async () => {
    const original = process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
    const outputDir = join(".artifacts", "qa-e2e", "oca-codex-telegram", `missing-lease-${Date.now()}`);
    const artifactDir = join(repoRoot, outputDir);
    try {
      process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = "1";
      const result = await runNativeProof(parseArgs([
        "run",
        "--allow-live",
        "--output-dir",
        outputDir,
      ]), {
        async acquireCredentialLease(_opts, sessionDir) {
          return {
            credentialId: "credential-1",
            desktopWorkdir: join(sessionDir, "desktop"),
            groupId: "-1001234567890",
            leaseFile: join(sessionDir, "missing-lease.json"),
            ownerId: "owner",
            testerUserId: "123456789",
            testerUsername: "tester",
            userDriverDir: join(sessionDir, "user-driver"),
          };
        },
        async startLocalSut() {
          return { gatewayPort: 38975, isolatedHome: "/tmp/openclaw-proof-home" };
        },
        async startCrabboxDesktop() {
          return { createdLease: true, id: "cbx-secret-123456789", provider: "local-container", target: "linux" };
        },
        async captureEvidence() {
          return [];
        },
        async stopCrabboxDesktop() {},
        async stopLocalSut() {},
        async releaseCredentialLease(lease) {
          if (!existsSync(lease.leaseFile)) {
            throw new Error("telegram-user lease file is missing; cannot safely release credential");
          }
        },
      });

      assert.equal(result.ok, false);
      const summary = JSON.parse(readFileSync(join(artifactDir, "summary.json"), "utf8")) as {
        cleanupErrors?: string[];
        sessionRetainedForCleanup?: boolean;
      };
      assert.equal(summary.sessionRetainedForCleanup, true);
      assert.match(String(summary.cleanupErrors?.[0]), /lease file is missing/);
      assert.equal(existsSync(join(artifactDir, ".session")), true);
      const manifest = JSON.parse(readFileSync(join(artifactDir, "mantis-evidence.json"), "utf8")) as {
        comparison?: { pass?: boolean };
      };
      assert.equal(manifest.comparison?.pass, false);
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
      else process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = original;
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("preserves acquisition recovery artifacts when credential acquisition fails", async () => {
    const original = process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
    const outputDir = join(".artifacts", "qa-e2e", "oca-codex-telegram", `acquire-failure-${Date.now()}`);
    const artifactDir = join(repoRoot, outputDir);
    const events: string[] = [];
    try {
      process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = "1";
      const result = await runNativeProof(parseArgs([
        "run",
        "--allow-live",
        "--output-dir",
        outputDir,
      ]), {
        async acquireCredentialLease(_opts, sessionDir) {
          events.push("acquire");
          writeFileSync(join(sessionDir, "lease.json"), '{"credential":"lease-secret"}');
          writeFileSync(join(sessionDir, "telegram-user-payload.json"), '{"password":"hunter2"}');
          throw new Error("credential helper failed after lease restore");
        },
        async startLocalSut() {
          events.push("start-sut");
          throw new Error("unexpected start");
        },
        async startCrabboxDesktop() {
          events.push("start-crabbox");
          throw new Error("unexpected desktop");
        },
        async captureEvidence() {
          events.push("capture");
          return [];
        },
        async stopCrabboxDesktop() {
          events.push("stop-crabbox");
        },
        async stopLocalSut() {
          events.push("stop-sut");
        },
        async releaseCredentialLease(lease) {
          assert.match(lease.leaseFile, /lease\.json$/);
          events.push("release");
        },
      });

      assert.equal(result.ok, false);
      assert.deepEqual(events, ["acquire", "release"]);
      assert.equal(existsSync(join(artifactDir, ".session", "lease.json")), true);
      assert.equal(existsSync(join(artifactDir, ".session", "telegram-user-payload.json")), true);
      assert.equal(existsSync(join(artifactDir, "public-artifacts", "summary.json")), true);
      const summary = JSON.parse(readFileSync(join(artifactDir, "summary.json"), "utf8")) as {
        sessionRetainedForCleanup?: boolean;
      };
      assert.equal(summary.sessionRetainedForCleanup, true);
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
      else process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = original;
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("stops a started reusable desktop unless keep-box is requested", async () => {
    const original = process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
    const outputDir = join(".artifacts", "qa-e2e", "oca-codex-telegram", `reusable-desktop-${Date.now()}`);
    const artifactDir = join(repoRoot, outputDir);
    const events: string[] = [];
    try {
      process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = "1";
      const result = await runNativeProof(parseArgs([
        "run",
        "--allow-live",
        "--output-dir",
        outputDir,
      ]), {
        async acquireCredentialLease(_opts, sessionDir) {
          const leaseFile = join(sessionDir, "lease.json");
          writeFileSync(leaseFile, "{}");
          return {
            credentialId: "credential-1",
            desktopWorkdir: join(sessionDir, "desktop"),
            groupId: "-1001234567890",
            leaseFile,
            ownerId: "owner",
            testerUserId: "123456789",
            testerUsername: "tester",
            userDriverDir: join(sessionDir, "user-driver"),
          };
        },
        async startLocalSut() {
          events.push("start-sut");
          return { gatewayPort: 38975, isolatedHome: "/tmp/openclaw-proof-home" };
        },
        async startCrabboxDesktop() {
          events.push("start-crabbox");
          return { createdLease: false, id: "reused-desktop", provider: "local-container", target: "linux" };
        },
        async captureEvidence() {
          events.push("capture");
          return [];
        },
        async stopCrabboxDesktop() {
          events.push("stop-crabbox");
        },
        async stopLocalSut() {
          events.push("stop-sut");
        },
        async releaseCredentialLease() {
          events.push("release");
        },
      });

      assert.equal(result.ok, true);
      assert.deepEqual(events, ["start-sut", "start-crabbox", "capture", "stop-crabbox", "stop-sut", "release"]);
    } finally {
      if (original === undefined) delete process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
      else process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = original;
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });
});
