import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTelegramCredentialCommandArgs,
  parseArgs,
  runNativeProof,
  stagePublicArtifacts,
} from "../scripts/e2e/oca-codex-telegram-proof";
import { validateReleaseMetadata } from "../scripts/validate-release-metadata.mjs";
import { resolveExistingTargetPrUpdateBranch } from "../src/tools/agent-pr";
import { createPR, formatWorktreeOutcomeLine } from "../src/worktree";
import { reconcilePersistedSessionTaskMirror } from "../src/session-task-lifecycle";
import { setPluginRuntime } from "../src/runtime-store";
import { SessionNotificationService } from "../src/session-notifications";
import { SessionWorktreeMessageService } from "../src/session-worktree-message-service";
import { buildCompletedPayload } from "../src/session-notification-builder";
import { SessionManager } from "../src/session-manager";
import { STORE_SCHEMA_VERSION } from "../src/session-store-normalization";
import type { PersistedSessionInfo } from "../src/types";

const repoRoot = join(import.meta.dirname, "..");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function initRepo(prefix: string): string {
  const repoDir = mkdtempSync(join(tmpdir(), prefix));
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "OpenClaw Tests");
  git(repoDir, "config", "user.email", "tests@example.com");
  writeFileSync(join(repoDir, "README.md"), "base\n", "utf8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");
  return repoDir;
}

function withMockGh(scriptLines: string[], run: (logPath: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), "oca-crabbox-gh-"));
  const binDir = join(tempDir, "bin");
  const logPath = join(tempDir, "gh-args.log");
  const originalPath = process.env.PATH;
  try {
    mkdirSync(binDir);
    const ghPath = join(binDir, "gh");
    writeFileSync(ghPath, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$GH_ARGS_LOG\"",
      "if [ \"$1\" = \"--version\" ]; then",
      "  echo 'gh version 2.0.0'",
      "  exit 0",
      "fi",
      ...scriptLines,
      "exit 1",
      "",
    ].join("\n"));
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    process.env.GH_ARGS_LOG = logPath;
    run(logPath);
  } finally {
    process.env.PATH = originalPath;
    delete process.env.GH_ARGS_LOG;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function withLiveProofEnv<T>(run: () => Promise<T>): Promise<T> {
  const original = process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
  process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = "1";
  return run().finally(() => {
    if (original === undefined) delete process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF;
    else process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF = original;
  });
}

describe("OCA Codex Crabbox integration harness", () => {
  it("does not acquire telegram-user leases or start Crabbox without both live gates", async () => {
    let acquired = false;
    const outputDir = join(".artifacts", "qa-e2e", "oca-codex-telegram", `guard-${Date.now()}`);
    try {
      await assert.rejects(
        runNativeProof(parseArgs(["run", "--output-dir", outputDir]), {
          async acquireCredentialLease() {
            acquired = true;
            throw new Error("should not acquire");
          },
          async captureEvidence() {
            return [];
          },
          async releaseCredentialLease() {},
          async startCrabboxDesktop() {
            throw new Error("should not start");
          },
          async startLocalSut() {
            throw new Error("should not start");
          },
          async stopCrabboxDesktop() {},
          async stopLocalSut() {},
        }),
        /Native Telegram Desktop proof is disabled by default/,
      );

      assert.equal(acquired, false);
      assert.equal(existsSync(join(repoRoot, outputDir)), false);
    } finally {
      rmSync(join(repoRoot, outputDir), { recursive: true, force: true });
    }
  });

  it("builds credential helper commands with explicit env-file placement and no secret values", () => {
    const opts = parseArgs([
      "run",
      "--env-file",
      ".private/convex.local.env",
      "--output-dir",
      ".artifacts/qa-e2e/oca-codex-telegram/command-shape",
    ]);
    const leaseArgs = buildTelegramCredentialCommandArgs(opts, "lease-restore", [
      "--lease-file",
      "/tmp/private/lease.json",
    ]);
    const releaseArgs = buildTelegramCredentialCommandArgs(opts, "release", [
      "--lease-file",
      "/tmp/private/lease.json",
    ]);

    assert.deepEqual(leaseArgs.slice(0, 4), ["--import", "tsx", leaseArgs[2], "lease-restore"]);
    assert.match(leaseArgs[2], /telegram-user-credential\.ts$/);
    assert.deepEqual(leaseArgs.slice(-2), ["--env-file", ".private/convex.local.env"]);
    assert.deepEqual(releaseArgs.slice(-2), ["--env-file", ".private/convex.local.env"]);
    assert.doesNotMatch(JSON.stringify({ leaseArgs, releaseArgs }), /OPENCLAW_QA_CONVEX_SECRET_CI|hunter2|bot-token/u);
  });

  it("runs the native Crabbox orchestration path with fakes, redacts artifacts, and cleans session state", async () => {
    const outputDir = join(".artifacts", "qa-e2e", "oca-codex-telegram", `integ-native-${Date.now()}`);
    const artifactDir = join(repoRoot, outputDir);
    const events: string[] = [];
    try {
      const result = await withLiveProofEnv(() => runNativeProof(parseArgs([
        "run",
        "--allow-live",
        "--provider",
        "local-container",
        "--output-dir",
        outputDir,
      ]), {
        async acquireCredentialLease(_opts, sessionDir) {
          events.push("acquire");
          const leaseFile = join(sessionDir, "lease.json");
          writeFileSync(leaseFile, '{"token":"123456789:abcdefghijklmnopqrstuvwxyzABCDE"}');
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
          return { gatewayPort: 38975, isolatedHome: "/tmp/private-openclaw-home" };
        },
        async startCrabboxDesktop(opts) {
          events.push(`start-crabbox:${opts.crabboxProvider}`);
          return { createdLease: true, id: "cbx-secret-123456789", provider: opts.crabboxProvider, target: "linux" };
        },
        async captureEvidence({ outputDir: absoluteOutputDir }) {
          events.push("capture");
          const logPath = join(absoluteOutputDir, "telegram-desktop.log");
          const pngPath = join(absoluteOutputDir, "telegram-desktop.png");
          writeFileSync(logPath, "token 123456789:abcdefghijklmnopqrstuvwxyzABCDE user @qa_secret_user group -1003863755361 path /tmp/proof password=hunter2");
          writeFileSync(pngPath, "private rendered Telegram pixels");
          return [
            { kind: "log", path: logPath, public: true },
            { kind: "screenshot", path: pngPath, public: true },
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
      }));

      assert.equal(result.ok, true);
      assert.deepEqual(events, ["acquire", "start-sut", "start-crabbox:local-container", "capture", "stop-crabbox", "stop-sut", "release"]);
      assert.equal(existsSync(join(artifactDir, ".session")), false);
      const staged = join(artifactDir, "public-artifacts");
      assert.equal(existsSync(join(staged, "telegram-desktop.log")), true);
      assert.equal(existsSync(join(staged, "telegram-desktop.png")), false);
      const stagedLog = readFileSync(join(staged, "telegram-desktop.log"), "utf8");
      assert.doesNotMatch(stagedLog, /123456789:abcdefghijklmnopqrstuvwxyzABCDE|qa_secret_user|-1003863755361|hunter2|\/tmp\/proof/u);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("stages only public redacted proof artifacts and preserves unsafe outside paths", () => {
    const outputDir = join(".artifacts", "qa-e2e", "oca-codex-telegram", `stage-integ-${Date.now()}`);
    const artifactDir = join(repoRoot, outputDir);
    const outside = mkdtempSync(join(tmpdir(), "oca-crabbox-stage-outside-"));
    try {
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(join(artifactDir, "summary.json"), '{"token":"sk-private-token","outputDir":"/tmp/private-proof"}');
      writeFileSync(join(artifactDir, "telegram-desktop.log"), "bot 123456789:abcdefghijklmnopqrstuvwxyzABCDE user @qa_secret_user group -1003863755361");
      writeFileSync(join(artifactDir, "session.json"), '{"credential":"private"}');
      writeFileSync(join(artifactDir, "telegram-desktop.png"), "private pixels");

      const staged = stagePublicArtifacts(outputDir);
      const stagedSummary = readFileSync(join(staged, "summary.json"), "utf8");
      assert.doesNotMatch(stagedSummary, /sk-private-token|\/tmp\/private-proof/u);
      assert.equal(existsSync(join(staged, "session.json")), false);
      assert.equal(existsSync(join(staged, "telegram-desktop.png")), false);
      assert.match(readFileSync(join(staged, "omitted-private-artifacts.json"), "utf8"), /telegram-desktop\.png/u);

      mkdirSync(join(outside, "public-artifacts"), { recursive: true });
      writeFileSync(join(outside, "public-artifacts", "keep.txt"), "keep");
      assert.throws(() => stagePublicArtifacts(outside), /--output-dir must resolve inside/u);
      assert.equal(readFileSync(join(outside, "public-artifacts", "keep.txt"), "utf8"), "keep");
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("updates the original existing PR branch from follow-up work and refuses sibling divergence", () => {
    const repoDir = initRepo("oca-crabbox-existing-pr-");
    try {
      git(repoDir, "checkout", "-b", "agent/original-pr");
      writeFileSync(join(repoDir, "proof.txt"), "original\n", "utf8");
      git(repoDir, "add", "proof.txt");
      git(repoDir, "commit", "-m", "Original PR work");
      git(repoDir, "checkout", "-b", "agent/review-follow-up");
      writeFileSync(join(repoDir, "review.txt"), "follow-up\n", "utf8");
      git(repoDir, "add", "review.txt");
      git(repoDir, "commit", "-m", "Address review feedback");
      const helperHead = git(repoDir, "rev-parse", "agent/review-follow-up");

      const updated = resolveExistingTargetPrUpdateBranch({
        repoDir,
        sourceBranch: "agent/review-follow-up",
        targetPrStatus: {
          exists: true,
          state: "open",
          url: "https://github.com/goldmar/openclaw-code-agent/pull/322",
          number: 322,
          headRefName: "agent/original-pr",
          baseRefName: "main",
        },
      });
      assert.deepEqual(updated, { success: true, branchName: "agent/original-pr", alreadyRepresented: false });
      assert.equal(git(repoDir, "rev-parse", "agent/original-pr"), helperHead);

      git(repoDir, "checkout", "main");
      git(repoDir, "checkout", "-b", "agent/divergent-pr");
      writeFileSync(join(repoDir, "divergent.txt"), "divergent\n", "utf8");
      git(repoDir, "add", "divergent.txt");
      git(repoDir, "commit", "-m", "Divergent target update");
      git(repoDir, "checkout", "agent/review-follow-up");

      const rejected = resolveExistingTargetPrUpdateBranch({
        repoDir,
        sourceBranch: "agent/review-follow-up",
        targetPrStatus: {
          exists: true,
          state: "open",
          url: "https://github.com/goldmar/openclaw-code-agent/pull/323",
          number: 323,
          headRefName: "agent/divergent-pr",
          baseRefName: "main",
        },
      });
      assert.equal(rejected.success, false);
      assert.match("error" in rejected ? rejected.error : "", /Refusing to create a sibling PR/u);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("reuses an existing open PR when GitHub rejects duplicate creation", () => {
    withMockGh([
      "if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"create\" ]; then",
      "  echo 'GraphQL: A pull request already exists for goldmar:agent/existing-pr. (createPullRequest)' >&2",
      "  exit 1",
      "fi",
      "if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"list\" ]; then",
      "  printf '%s\\n' '[{\"url\":\"https://github.com/goldmar/openclaw-code-agent/pull/331\",\"number\":331,\"title\":\"Existing\",\"state\":\"OPEN\",\"headRepositoryOwner\":{\"login\":\"goldmar\"},\"headRefName\":\"agent/existing-pr\",\"baseRefName\":\"main\"}]'",
      "  exit 0",
      "fi",
    ], (logPath) => {
      const repoDir = mkdtempSync(join(tmpdir(), "oca-crabbox-create-pr-existing-"));
      try {
        git(repoDir, "init", "-b", "main");
        git(repoDir, "remote", "add", "origin", "https://github.com/goldmar/openclaw-code-agent.git");

        const result = createPR(
          repoDir,
          "agent/existing-pr",
          "main",
          "Existing PR",
          "Body",
          "goldmar/openclaw-code-agent",
        );

        assert.deepEqual(result, {
          success: true,
          prUrl: "https://github.com/goldmar/openclaw-code-agent/pull/331",
          warnings: ["A PR already exists for this branch; reused the existing open PR."],
        });
        const calls = readFileSync(logPath, "utf8").trim().split("\n");
        assert.equal(calls.filter((call) => call.startsWith("pr create ")).length, 1);
        assert.ok(calls.some((call) => call.startsWith("pr list --head agent/existing-pr ")));
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  it("shares terminal stat formatting and omits missing values cleanly", () => {
    assert.equal(
      formatWorktreeOutcomeLine({
        kind: "merge",
        branch: "agent/stat-proof",
        base: "main",
        filesChanged: 2,
        insertions: 10,
        deletions: 1,
      }),
      "✅ Merged: agent/stat-proof → main (2 files, +10/-1)",
    );
    assert.equal(
      formatWorktreeOutcomeLine({
        kind: "pr-updated",
        branch: "agent/stat-proof",
        prUrl: "https://github.com/goldmar/openclaw-code-agent/pull/328",
        filesChanged: 2,
        insertions: 10,
        deletions: 1,
      }),
      "✅ PR updated: https://github.com/goldmar/openclaw-code-agent/pull/328 (2 files, +10/-1)",
    );
    assert.equal(
      formatWorktreeOutcomeLine({
        kind: "pr-updated",
        branch: "agent/stat-proof",
        prUrl: "https://github.com/goldmar/openclaw-code-agent/pull/328",
      }),
      "✅ PR updated: https://github.com/goldmar/openclaw-code-agent/pull/328",
    );
  });

  it("formats notification payloads consistently across PR, merge, no-change, and completed paths", () => {
    const requests: Array<Record<string, unknown>> = [];
    const patches: Array<{ ref: string; patch: Record<string, unknown> }> = [];
    const dispatcher = {
      dispatchSessionNotification(_session: unknown, request: Record<string, unknown> & { hooks?: Record<string, () => void> }) {
        requests.push(request);
        request.hooks?.onNotifyStarted?.();
        request.hooks?.onNotifySucceeded?.();
        if (request.wakeMessage || request.wakeMessageOnNotifySuccess || request.wakeMessageOnNotifyFailed) {
          request.hooks?.onWakeStarted?.();
          request.hooks?.onWakeSucceeded?.();
        }
      },
      dispose() {},
    };
    const service = new SessionNotificationService(
      dispatcher as any,
      (ref, patch) => patches.push({ ref, patch: patch as Record<string, unknown> }),
    );
    const session = {
      id: "session-notify-integ",
      harnessSessionId: "h-notify-integ",
      name: "notify-integ",
      route: {
        provider: "telegram",
        accountId: "bot",
        target: "-100123",
        threadId: "32947",
        sessionKey: "agent:main:telegram:group:-100123:topic:32947",
      },
    } as any;

    service.notifyWorktreeOutcome(
      session,
      formatWorktreeOutcomeLine({
        kind: "pr-updated",
        branch: "agent/notify-integ",
        prUrl: "https://github.com/goldmar/openclaw-code-agent/pull/331",
        filesChanged: 3,
        insertions: 14,
        deletions: 2,
      }),
      {
        completionWakeOutcomeKey: "worktree-pr:updated:goldmar/openclaw-code-agent:#331:agent/notify-integ:abc1234",
        detailLines: [
          "Updated PR for branch agent/notify-integ into main.",
          "PR URL: https://github.com/goldmar/openclaw-code-agent/pull/331.",
          "Pushed 2 new commits (+14/-2).",
        ],
      },
    );
    service.notifyWorktreeOutcome(
      { ...session, id: "session-merge-integ" },
      formatWorktreeOutcomeLine({
        kind: "merge",
        branch: "agent/notify-integ",
        base: "main",
        filesChanged: 3,
        insertions: 14,
        deletions: 2,
      }),
      { completionWakeOutcomeKey: "worktree-merge:session-merge-integ:agent/notify-integ:main" },
    );

    const noChange = new SessionWorktreeMessageService().buildNoChangeNotification({
      session: {
        id: "session-no-change-integ",
        name: "no-change-integ",
        requestedPermissionMode: "plan",
        currentPermissionMode: "plan",
        approvalExecutionState: "awaiting_plan_output",
        approvalState: "not_required",
        planApproval: "ask",
        approvalPromptStatus: "not_sent",
        approvalPromptMessageKind: "none",
        approvalPromptDeliveredAt: undefined,
        startedAt: 1780000000000,
      } as any,
      nativeBackendWorktree: false,
      cleanupSucceeded: true,
      worktreePath: "/tmp/oca-no-change",
      worktreeBranch: "agent/no-change",
      preview: "",
    });
    assert.match(noChange.userMessage, /no worktree changes to merge .* worktree cleaned up/u);
    assert.doesNotMatch(noChange.userMessage, /undefined|NaN|\(\d+ files/u);
    assert.doesNotMatch(noChange.wakeMessage ?? "", /undefined|NaN/u);

    const completed = buildCompletedPayload({
      session: {
        id: "session-completed-integ",
        name: "completed-integ",
        status: "completed",
        costUsd: undefined,
        duration: undefined,
        requestedPermissionMode: "default",
        currentPermissionMode: "default",
        approvalExecutionState: "not_required",
        approvalState: "not_required",
        planApproval: "ask",
        approvalPromptStatus: "not_sent",
        approvalPromptMessageKind: "none",
        approvalPromptDeliveredAt: undefined,
        harnessName: "codex",
        model: undefined,
      } as any,
      originThreadLine: "",
      preview: "Completed without persisted cost or duration stats.",
    });
    assert.match(
      completed.userMessage,
      /^✅ \[completed-integ\] Completed(?: \| \$0\.00 \| 0s)? \| codex(?: \| default)?/u,
    );
    assert.doesNotMatch(completed.userMessage, /undefined|NaN/u);

    assert.equal(requests.length, 2);
    assert.equal(
      requests[0]?.userMessage,
      "✅ PR updated: https://github.com/goldmar/openclaw-code-agent/pull/331 (3 files, +14/-2)",
    );
    assert.match(String(requests[0]?.wakeMessageOnNotifySuccess), /Canonical outcome status:\n✅ PR updated: .* \(3 files, \+14\/-2\)/u);
    assert.doesNotMatch(String(requests[0]?.wakeMessageOnNotifySuccess), /https:\/\/github\.com\/goldmar\/openclaw-code-agent\/pull\/331\./u);
    assert.equal(requests[1]?.userMessage, "✅ Merged: agent/notify-integ → main (3 files, +14/-2)");
    assert.equal(patches.some(({ patch }) => patch.completionWakeSummaryRequired === true), true);
  });

  it("reconciles orphan running TaskFlow mirrors after runtime recovery", () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    setPluginRuntime({
      taskFlow: {
        fromToolContext() {
          return {
            setWaiting(params: Record<string, unknown>) {
              calls.push({ method: "setWaiting", params });
              return { applied: true, flow: { flowId: "flow-1", revision: 8 } };
            },
            finish(params: Record<string, unknown>) {
              calls.push({ method: "finish", params });
              return { applied: true, flow: { flowId: "flow-1", revision: 8 } };
            },
            fail(params: Record<string, unknown>) {
              calls.push({ method: "fail", params });
              return { applied: true, flow: { flowId: "flow-1", revision: 8 } };
            },
          };
        },
      },
    });
    try {
      const session = {
        sessionId: "session-orphan",
        harnessSessionId: "h-orphan",
        backendRef: { kind: "codex-app-server", conversationId: "h-orphan" },
        name: "orphan",
        prompt: "p",
        workdir: "/tmp",
        status: "killed",
        lifecycle: "terminal",
        killReason: "unknown",
        runtimeState: "stopped",
        runtimeRecovery: {
          recoveredAt: "2026-07-01T00:00:00.000Z",
          reason: "persisted-running-without-runtime",
          rawStatus: "running",
          rawLifecycle: "active",
          rawRuntimeState: "live",
          normalizedStatus: "killed",
          normalizedLifecycle: "suspended",
          normalizedRuntimeState: "stopped",
        },
        costUsd: 0,
        route: { provider: "telegram", target: "123", sessionKey: "agent:main:telegram:group:123" },
        taskFlowMirror: { flowId: "flow-1", revision: 7, status: "running" },
      } satisfies PersistedSessionInfo;

      const reconciled = reconcilePersistedSessionTaskMirror(session);
      assert.deepEqual(calls.map((call) => call.method), ["fail"]);
      assert.equal(calls[0].params.expectedRevision, 7);
      assert.equal(calls[0].params.blockedSummary, "Lost after OCA restart without live process");
      assert.equal(reconciled?.revision, 8);
    } finally {
      setPluginRuntime(undefined);
    }
  });

  it("reconciles persisted running TaskFlow mirrors through SessionManager after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "oca-crabbox-manager-restart-"));
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    try {
      const indexPath = join(dir, "sessions.json");
      writeFileSync(indexPath, JSON.stringify({
        schemaVersion: STORE_SCHEMA_VERSION,
        sessions: [{
          sessionId: "session-restart-orphan",
          harnessSessionId: "h-restart-orphan",
          backendRef: { kind: "codex-app-server", conversationId: "thread-restart-orphan" },
          name: "restart-orphan",
          prompt: "p",
          workdir: "/tmp",
          status: "running",
          lifecycle: "active",
          runtimeState: "live",
          costUsd: 0,
          route: {
            provider: "telegram",
            target: "123",
            sessionKey: "agent:main:telegram:group:123",
          },
          taskFlowMirror: { flowId: "flow-restart", revision: 4, status: "running" },
        }],
        actionTokens: [],
        repoPolicies: [],
      }));
      setPluginRuntime({
        taskFlow: {
          fromToolContext() {
            return {
              setWaiting(params: Record<string, unknown>) {
                calls.push({ method: "setWaiting", params });
                return { applied: true, flow: { flowId: "flow-restart", revision: 5 } };
              },
              finish(params: Record<string, unknown>) {
                calls.push({ method: "finish", params });
                return { applied: true, flow: { flowId: "flow-restart", revision: 5 } };
              },
              fail(params: Record<string, unknown>) {
                calls.push({ method: "fail", params });
                return { applied: true, flow: { flowId: "flow-restart", revision: 5 } };
              },
            };
          },
        },
      });

      const manager = new SessionManager(5, 50, { store: { indexPath, env: {} } });
      try {
        const persisted = manager.getPersistedSession("session-restart-orphan");
        assert.equal(persisted?.status, "killed");
        assert.equal(persisted?.runtimeState, "stopped");
        assert.equal(persisted?.runtimeRecovery?.reason, "persisted-running-without-runtime");
        assert.equal(persisted?.taskFlowMirror?.revision, 5);
        assert.deepEqual(calls.map((call) => call.method), ["fail"]);
        assert.equal(calls[0].params.flowId, "flow-restart");
        assert.equal(calls[0].params.expectedRevision, 4);
      } finally {
        manager.dispose();
      }
    } finally {
      setPluginRuntime(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catches release metadata drift before deploy or release", () => {
    const temp = mkdtempSync(join(tmpdir(), "oca-release-drift-"));
    try {
      writeFileSync(join(temp, "package.json"), JSON.stringify({
        version: "4.5.9",
        openclaw: {
          build: { openclawVersion: "2026.6.11", pluginSdkVersion: "2026.6.10" },
          install: { npmSpec: "openclaw-code-agent", defaultChoice: "npm", minHostVersion: ">=2026.4.21" },
        },
      }));
      writeFileSync(join(temp, "openclaw.plugin.json"), JSON.stringify({ version: "4.5.8" }));

      assert.throws(() => validateReleaseMetadata({ baseDir: temp }), /Version mismatch/u);
      writeFileSync(join(temp, "openclaw.plugin.json"), JSON.stringify({ version: "4.5.9" }));
      assert.throws(() => validateReleaseMetadata({ baseDir: temp }), /OpenClaw build metadata mismatch/u);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
