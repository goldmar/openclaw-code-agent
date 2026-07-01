#!/usr/bin/env -S node --import tsx
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHarness } from "../../src/harness/index";
import type { HarnessMessage, HarnessResult, HarnessSession } from "../../src/harness/types";
import { redactProofValue } from "./oca-codex-proof-app-server";

type Command = "doctor" | "local-smoke" | "run";
type Options = {
  allowLive: boolean;
  command: Command;
  crabboxBin: string;
  crabboxProvider: string;
  desktopChatTitle: string;
  envFile?: string;
  dryRun: boolean;
  gatewayPort: number;
  keepBox: boolean;
  outputDir: string;
  recordSeconds: number;
  scenario: string;
  timeoutMs: number;
};

type DoctorCheck = {
  detail?: string;
  name: string;
  ok: boolean;
};

type ProofPlan = {
  command: Command;
  liveExecution: {
    allowFlag: boolean;
    env: "missing" | "set";
    enabled: boolean;
  };
  crabbox: {
    bin: string;
    keepBox: boolean;
    provider: string;
  };
  gateway: {
    port: number;
    isolatedHome: true;
  };
  outputDir: string;
  scenario: string;
  secrets: {
    convexSiteUrl: "missing" | "set";
    convexCiSecret: "missing" | "set";
    envFile: "default" | "provided";
  };
  telegram: {
    credentialKind: "telegram-user";
    desktopChatTitle: string;
    recordSeconds: number;
  };
};

type CredentialLease = {
  credentialId: string;
  desktopWorkdir: string;
  groupId: string;
  leaseFile: string;
  ownerId: string;
  sutUsername?: string;
  testerUserId: string;
  testerUsername: string;
  userDriverDir: string;
};

type CrabboxDesktop = {
  createdLease: boolean;
  id: string;
  provider: string;
  target: "linux";
};

type LocalProofSut = {
  gatewayPort: number;
  isolatedHome: string;
  requestLog?: string;
};

type EvidenceArtifact = {
  kind: "json" | "log" | "markdown" | "screenshot" | "video";
  path: string;
  public: boolean;
};

type NativeProofSession = {
  command: "oca-codex-telegram-native-session";
  createdAt: string;
  crabbox?: CrabboxDesktop;
  credential?: CredentialLease;
  localSut?: LocalProofSut;
  outputDir: string;
  scenario: string;
};

type NativeProofDeps = {
  acquireCredentialLease: (opts: Options, sessionDir: string) => Promise<CredentialLease>;
  captureEvidence: (params: {
    crabbox: CrabboxDesktop;
    credential: CredentialLease;
    localSut: LocalProofSut;
    opts: Options;
    outputDir: string;
  }) => Promise<EvidenceArtifact[]>;
  releaseCredentialLease: (lease: CredentialLease, opts: Options) => Promise<void>;
  startCrabboxDesktop: (opts: Options) => Promise<CrabboxDesktop>;
  startLocalSut: (params: { credential: CredentialLease; opts: Options; sessionDir: string }) => Promise<LocalProofSut>;
  stopCrabboxDesktop: (desktop: CrabboxDesktop, opts: Options) => Promise<void>;
  stopLocalSut: (sut: LocalProofSut, opts: Options) => Promise<void>;
};

type NativeProofResult = Record<string, unknown> & {
  ok: boolean;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_OUTPUT_ROOT = ".artifacts/qa-e2e/oca-codex-telegram";
const DEFAULT_OUTPUT_ROOT_ABS = path.resolve(REPO_ROOT, DEFAULT_OUTPUT_ROOT);
const FAKE_CODEX_SERVER = path.join(SCRIPT_DIR, "oca-codex-proof-app-server.ts");
const TELEGRAM_USER_DRIVER = path.join(SCRIPT_DIR, "telegram-user-driver.py");
const TELEGRAM_USER_CREDENTIAL = path.join(SCRIPT_DIR, "telegram-user-credential.ts");
const PRIVATE_CONVEX_ENV = "~/.codex/skills/custom/telegram-e2e-bot-to-bot/convex.local.env";
const TCP_PORT_RE = /^[1-9]\d*$/u;

export function usageText(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/e2e/oca-codex-telegram-proof.ts doctor",
    "  node --import tsx scripts/e2e/oca-codex-telegram-proof.ts local-smoke [--scenario basic]",
    "  node --import tsx scripts/e2e/oca-codex-telegram-proof.ts run [--dry-run]",
    "",
    "Options:",
    "  --scenario <name>             basic, plan, pending-question, approval, worktree, fail, interrupted.",
    "  --output-dir <path>           Artifact directory under .artifacts/qa-e2e/oca-codex-telegram.",
    "  --crabbox-bin <path>          Crabbox binary. Default: OPENCLAW_TELEGRAM_USER_CRABBOX_BIN or crabbox.",
    "  --provider <name>             Crabbox provider. Default: OPENCLAW_TELEGRAM_USER_CRABBOX_PROVIDER or local-container.",
    "  --desktop-chat-title <title>  Telegram Desktop chat title for native proof capture.",
    "  --env-file <path>             Convex env file for live proof release/acquire helpers.",
    "  --gateway-port <port>         Disposable gateway port. Default: 38975.",
    "  --record-seconds <seconds>    Native desktop recording duration. Default: 35.",
    "  --keep-box                    Keep Crabbox lease for VNC/debugging.",
    "  --dry-run                     Print the resolved proof plan without leasing credentials.",
    "  --allow-live                  Permit native orchestration when OPENCLAW_RUN_LIVE_TELEGRAM_PROOF=1.",
  ].join("\n");
}

function usage(): never {
  throw new Error(usageText());
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parsePort(value: string, label: string): number {
  if (!TCP_PORT_RE.test(value)) throw new Error(`${label} must be a TCP port from 1 to 65535.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${label} must be a TCP port from 1 to 65535.`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, label: string): number {
  if (!TCP_PORT_RE.test(value)) throw new Error(`${label} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function takeValue(args: string[], index: number, label: string): string {
  const value = args[index + 1];
  if (!value || value === "-h" || value.startsWith("--")) usage();
  return value;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): Options {
  const first = argv[0];
  const command: Command = first === "doctor" || first === "local-smoke" || first === "run"
    ? first
    : "run";
  const args = command === first ? argv.slice(1) : argv;
  const seen = new Set<string>();
  const opts: Options = {
    allowLive: false,
    command,
    crabboxBin: process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN?.trim() || "crabbox",
    crabboxProvider: process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_PROVIDER?.trim() || "local-container",
    desktopChatTitle: "OpenClaw QA Telegram Proof",
    dryRun: false,
    gatewayPort: 38975,
    keepBox: false,
    outputDir: path.join(DEFAULT_OUTPUT_ROOT, `${timestamp()}-${randomUUID().slice(0, 8)}`),
    recordSeconds: 35,
    scenario: "basic",
    timeoutMs: 120_000,
  };

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") {
      console.log(usageText());
      process.exit(0);
    }
    if (key === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (key === "--keep-box") {
      opts.keepBox = true;
      continue;
    }
    if (key === "--allow-live") {
      opts.allowLive = true;
      continue;
    }
    if (!key.startsWith("--")) usage();
    if (seen.has(key)) throw new Error(`${key} was provided more than once`);
    seen.add(key);
    const value = takeValue(args, index, key);
    index += 1;
    switch (key) {
      case "--crabbox-bin":
        opts.crabboxBin = value;
        break;
      case "--desktop-chat-title":
        opts.desktopChatTitle = value;
        break;
      case "--env-file":
        opts.envFile = value;
        break;
      case "--gateway-port":
        opts.gatewayPort = parsePort(value, key);
        break;
      case "--output-dir":
        opts.outputDir = value;
        break;
      case "--provider":
        opts.crabboxProvider = value;
        break;
      case "--record-seconds":
        opts.recordSeconds = parsePositiveInteger(value, key);
        break;
      case "--scenario":
        opts.scenario = value;
        break;
      case "--timeout-ms":
        opts.timeoutMs = parsePositiveInteger(value, key);
        break;
      default:
        usage();
    }
  }
  return opts;
}

export function buildProofPlan(opts: Options): ProofPlan {
  const liveEnvSet = process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF === "1";
  return {
    command: opts.command,
    liveExecution: {
      allowFlag: opts.allowLive,
      env: liveEnvSet ? "set" : "missing",
      enabled: opts.allowLive && liveEnvSet,
    },
    crabbox: {
      bin: opts.crabboxBin,
      keepBox: opts.keepBox,
      provider: opts.crabboxProvider,
    },
    gateway: {
      isolatedHome: true,
      port: opts.gatewayPort,
    },
    outputDir: opts.outputDir,
    scenario: opts.scenario,
    secrets: {
      convexCiSecret: process.env.OPENCLAW_QA_CONVEX_SECRET_CI ? "set" : "missing",
      convexSiteUrl: process.env.OPENCLAW_QA_CONVEX_SITE_URL ? "set" : "missing",
      envFile: opts.envFile ? "provided" : "default",
    },
    telegram: {
      credentialKind: "telegram-user",
      desktopChatTitle: opts.desktopChatTitle,
      recordSeconds: opts.recordSeconds,
    },
  };
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = path.relative(parent, child);
  return relativePath === "" || (!!relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function resolveProofOutputDir(outputDir: string): string {
  const resolved = path.resolve(REPO_ROOT, outputDir);
  if (!isPathInside(DEFAULT_OUTPUT_ROOT_ABS, resolved)) {
    throw new Error(`--output-dir must resolve inside ${DEFAULT_OUTPUT_ROOT}`);
  }
  return resolved;
}

function commandExists(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(expandHome(command));
  const result = spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function checkNodeScript(name: string, file: string): DoctorCheck {
  return { name, ok: existsSync(file), detail: path.relative(REPO_ROOT, file) };
}

export function collectDoctorChecks(opts: Options): DoctorCheck[] {
  return [
    { name: "node", ok: commandExists(process.execPath), detail: process.version },
    { name: "pnpm", ok: commandExists("pnpm") },
    checkNodeScript("fake Codex proof app server", FAKE_CODEX_SERVER),
    checkNodeScript("Telegram user driver", TELEGRAM_USER_DRIVER),
    checkNodeScript("Telegram user credential helper", TELEGRAM_USER_CREDENTIAL),
    { name: "Crabbox binary", ok: commandExists(opts.crabboxBin), detail: opts.crabboxBin },
    { name: "media ffmpeg", ok: commandExists("ffmpeg") },
    { name: "media ffprobe", ok: commandExists("ffprobe") },
    { name: "Convex site env", ok: Boolean(process.env.OPENCLAW_QA_CONVEX_SITE_URL), detail: "OPENCLAW_QA_CONVEX_SITE_URL" },
    { name: "Convex CI secret env", ok: Boolean(process.env.OPENCLAW_QA_CONVEX_SECRET_CI), detail: "OPENCLAW_QA_CONVEX_SECRET_CI" },
    {
      name: "private Convex env fallback",
      ok: existsSync(expandHome(PRIVATE_CONVEX_ENV)),
      detail: PRIVATE_CONVEX_ENV,
    },
    {
      name: "local-container runtime",
      ok: opts.crabboxProvider !== "local-container" || commandExists("docker") || commandExists("podman"),
      detail: opts.crabboxProvider,
    },
  ];
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, redactProofText(`${JSON.stringify(redactProofValue(value), null, 2)}\n`));
}

function redactProofText(value: string): string {
  return String(redactProofValue(value))
    .replace(/"((?:sut|tester)?Username|groupId|testerUserId|credentialId|ownerId)"\s*:\s*"[^"]*"/giu, '"$1": "[redacted id]"')
    .replace(/(?:\/private\/tmp|\/var\/folders|\/tmp)\/[^\s"'<>),\]]+/gu, "[redacted path]")
    .replace(/\b\d{7,}:[A-Za-z0-9_-]{20,}\b/gu, "[redacted credential]")
    .replace(/\b\d{6,}\b/gu, "[redacted id]")
    .replace(/@[A-Za-z][A-Za-z0-9_]{4,}\b/gu, "@[redacted username]")
    .replace(/\+?\d[\d .().-]{7,}\d/gu, "[redacted phone]");
}

function writeRedactedText(file: string, value: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, redactProofText(value));
}

function relativeArtifact(file: string): string {
  const relative = path.relative(REPO_ROOT, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : path.basename(file);
}

function assertNativeProofEnabled(opts: Options): void {
  if (!opts.allowLive || process.env.OPENCLAW_RUN_LIVE_TELEGRAM_PROOF !== "1") {
    throw new Error(
      [
        "Native Telegram Desktop proof is disabled by default.",
        "Run with --dry-run for a safe plan, or set OPENCLAW_RUN_LIVE_TELEGRAM_PROOF=1 and pass --allow-live to use live Telegram/Crabbox infrastructure.",
      ].join(" "),
    );
  }
}

function liveCommandArgs(opts: Options, command: "lease-restore" | "release", extra: string[] = []): string[] {
  const args = ["--import", "tsx", TELEGRAM_USER_CREDENTIAL, command, ...extra];
  if (opts.envFile) args.push("--env-file", opts.envFile);
  return args;
}

async function defaultLiveDeps(): Promise<NativeProofDeps> {
  return {
    async acquireCredentialLease(opts, sessionDir) {
      assertNativeProofEnabled(opts);
      const userDriverDir = path.join(sessionDir, "user-driver");
      const desktopWorkdir = path.join(sessionDir, "desktop");
      const leaseFile = path.join(sessionDir, "lease.json");
      const payloadFile = path.join(sessionDir, "telegram-user-payload.json");
      const result = spawnSync(process.execPath, liveCommandArgs(opts, "lease-restore", [
        "--user-driver-dir",
        userDriverDir,
        "--desktop-workdir",
        desktopWorkdir,
        "--lease-file",
        leaseFile,
        "--payload-output",
        payloadFile,
      ]), { cwd: REPO_ROOT, encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`telegram-user lease-restore failed\n${redactProofText(result.stderr || result.stdout)}`);
      }
      const acquired = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
      const payload = JSON.parse(readFileSync(payloadFile, "utf8")) as Record<string, unknown>;
      return {
        credentialId: String(acquired.credentialId || "telegram-user"),
        desktopWorkdir,
        groupId: String(payload.groupId || ""),
        leaseFile,
        ownerId: String(acquired.ownerId || ""),
        testerUserId: String(payload.testerUserId || ""),
        testerUsername: String(payload.testerUsername || ""),
        userDriverDir,
      };
    },
    async captureEvidence({ opts }) {
      assertNativeProofEnabled(opts);
      throw new Error("Native Telegram Desktop capture is intentionally not implemented without the OpenClaw proof runner bridge.");
    },
    async releaseCredentialLease(lease, opts) {
      if (!existsSync(lease.leaseFile)) {
        throw new Error(`telegram-user lease file is missing; cannot safely release credential: ${lease.leaseFile}`);
      }
      const result = spawnSync(process.execPath, liveCommandArgs(opts, "release", ["--lease-file", lease.leaseFile]), {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      if (result.status !== 0) {
        throw new Error(`telegram-user release failed\n${redactProofText(result.stderr || result.stdout)}`);
      }
    },
    async startCrabboxDesktop(opts) {
      assertNativeProofEnabled(opts);
      throw new Error("Native Crabbox start requires the full Telegram Desktop proof bridge.");
    },
    async startLocalSut(params) {
      assertNativeProofEnabled(params.opts);
      throw new Error("Native local SUT start requires the full Telegram Desktop proof bridge.");
    },
    async stopCrabboxDesktop() {},
    async stopLocalSut() {},
  };
}

export async function runNativeProof(
  opts: Options,
  deps?: NativeProofDeps,
): Promise<NativeProofResult> {
  assertNativeProofEnabled(opts);
  const outputDir = resolveProofOutputDir(opts.outputDir);
  const sessionDir = path.join(outputDir, ".session");
  rmSync(sessionDir, { recursive: true, force: true });
  mkdirSync(sessionDir, { mode: 0o700, recursive: true });

  const plan = buildProofPlan(opts);
  const session: NativeProofSession = {
    command: "oca-codex-telegram-native-session",
    createdAt: new Date().toISOString(),
    outputDir,
    scenario: opts.scenario,
  };
  const cleanup: Array<() => Promise<void>> = [];
  const cleanupErrors: string[] = [];
  const orchestrator = deps ?? await defaultLiveDeps();
  const artifacts: EvidenceArtifact[] = [];
  let result: NativeProofResult = {
    ok: false,
    plan,
    session,
    artifacts: [],
  };

  try {
    session.credential = await orchestrator.acquireCredentialLease(opts, sessionDir);
    cleanup.push(async () => {
      await orchestrator.releaseCredentialLease(session.credential!, opts);
    });
    session.localSut = await orchestrator.startLocalSut({ credential: session.credential, opts, sessionDir });
    cleanup.push(async () => {
      await orchestrator.stopLocalSut(session.localSut!, opts);
    });
    session.crabbox = await orchestrator.startCrabboxDesktop(opts);
    if (!opts.keepBox) {
      cleanup.push(async () => {
        await orchestrator.stopCrabboxDesktop(session.crabbox!, opts);
      });
    }
    artifacts.push(...await orchestrator.captureEvidence({
      crabbox: session.crabbox,
      credential: session.credential,
      localSut: session.localSut,
      opts,
      outputDir,
    }));
    result = {
      ok: true,
      plan,
      session,
      artifacts: artifacts.map((artifact) => ({ ...artifact, path: relativeArtifact(artifact.path) })),
    };
  } catch (error) {
    result = {
      ok: false,
      plan,
      session,
      artifacts: artifacts.map((artifact) => ({ ...artifact, path: relativeArtifact(artifact.path) })),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    while (cleanup.length) {
      const fn = cleanup.pop()!;
      try {
        await fn();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const publicArtifacts = artifacts.filter((artifact) => artifact.public);
    const cleanupOk = cleanupErrors.length === 0;
    result = {
      ...result,
      ok: result.ok && cleanupOk,
      cleanupErrors,
    };
    const summary = {
      ok: result.ok,
      cleanupErrors,
      error: result.error,
      sessionRetainedForCleanup: cleanupErrors.length > 0,
      plan,
      session,
      artifacts: publicArtifacts.map((artifact) => ({ ...artifact, path: relativeArtifact(artifact.path) })),
      privateArtifactCount: artifacts.length - publicArtifacts.length,
    };
    writeJson(path.join(outputDir, "summary.json"), summary);
    writeJson(path.join(outputDir, "mantis-evidence.json"), proofManifest(plan, publicArtifacts, result.ok));
    writeRedactedText(
      path.join(outputDir, "oca-codex-telegram-proof.md"),
      [
        "# OCA Codex Telegram Proof",
        "",
        `Scenario: ${opts.scenario}`,
        `Status: ${summary.ok ? "PASS" : "FAIL"}`,
        `Credential kind: ${plan.telegram.credentialKind}`,
        "",
      ].join("\n"),
    );
    if (cleanupErrors.length === 0) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }
  return result;
}

async function collectUntilCompleted(session: HarnessSession, timeoutMs: number): Promise<HarnessMessage[]> {
  const seen: HarnessMessage[] = [];
  const iterator = session.messages[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("OCA Codex proof smoke timed out")), remaining);
        timer.unref?.();
      }),
    ]);
    if (next.done) break;
    seen.push(next.value);
    if (next.value.type === "pending_input" && next.value.state.options.length > 0) {
      await session.submitPendingInputOption?.(0, { requestId: next.value.state.requestId });
    }
    if (next.value.type === "run_completed") break;
  }
  return seen;
}

function expectedTerminalSuccess(scenario: string, terminal: HarnessResult | undefined): boolean {
  if (!terminal) return false;
  if (terminal.success === true) return true;
  return scenario === "interrupted" && terminal.outcome === "interrupted";
}

function createCodexWrapper(tempRoot: string): string {
  const wrapper = path.join(tempRoot, "oca-fake-codex");
  writeFileSync(
    wrapper,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ \"${1:-}\" == \"app-server\" ]]; then",
      "  shift",
      "fi",
      `exec ${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(FAKE_CODEX_SERVER)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

export async function runLocalSmoke(opts: Options): Promise<Record<string, unknown>> {
  const outputDir = resolveProofOutputDir(opts.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "oca-codex-proof-"));
  const requestLog = path.join(outputDir, "codex-app-server-requests.redacted.jsonl");
  const originalEnv = {
    args: process.env.OPENCLAW_CODEX_APP_SERVER_ARGS,
    command: process.env.OPENCLAW_CODEX_APP_SERVER_COMMAND,
    log: process.env.OCA_CODEX_PROOF_REQUEST_LOG,
    scenario: process.env.OCA_CODEX_PROOF_SCENARIO,
  };
  try {
    process.env.OPENCLAW_CODEX_APP_SERVER_COMMAND = createCodexWrapper(tempRoot);
    process.env.OPENCLAW_CODEX_APP_SERVER_ARGS = "--listen,stdio://";
    process.env.OCA_CODEX_PROOF_REQUEST_LOG = requestLog;
    process.env.OCA_CODEX_PROOF_SCENARIO = opts.scenario;

    const codex = getHarness("codex");
    const launched = codex.launch({
      cwd: REPO_ROOT,
      permissionMode: opts.scenario === "plan" ? "plan" : "default",
      prompt: "Run the OCA Codex proof scenario and stop.",
      worktreeStrategy: opts.scenario === "worktree" ? "ask" : "off",
      originalWorkdir: REPO_ROOT,
    });
    const messages = await collectUntilCompleted(launched, opts.timeoutMs);
    const terminal = messages.find((message): message is Extract<HarnessMessage, { type: "run_completed" }> => (
      message.type === "run_completed"
    ));
    const summary = {
      ok: expectedTerminalSuccess(opts.scenario, terminal?.data),
      scenario: opts.scenario,
      outputDir,
      messageTypes: messages.map((message) => message.type),
      terminal: terminal?.data,
      backendRef: messages.find((message) => message.type === "backend_ref"),
      hasPlanArtifact: messages.some((message) => message.type === "plan_artifact"),
      hasPendingInput: messages.some((message) => message.type === "pending_input"),
    };
    writeJson(path.join(outputDir, "summary.json"), summary);
    writeJson(path.join(outputDir, "harness-messages.redacted.json"), messages);
    writeFileSync(
      path.join(outputDir, "oca-codex-telegram-proof.md"),
      [
        "# OCA Codex Proof Local Smoke",
        "",
        `Scenario: ${opts.scenario}`,
        `Status: ${summary.ok ? "PASS" : "FAIL"}`,
        "",
      ].join("\n"),
    );
    stagePublicArtifacts(opts.outputDir);
    return summary;
  } finally {
    if (originalEnv.command === undefined) delete process.env.OPENCLAW_CODEX_APP_SERVER_COMMAND;
    else process.env.OPENCLAW_CODEX_APP_SERVER_COMMAND = originalEnv.command;
    if (originalEnv.args === undefined) delete process.env.OPENCLAW_CODEX_APP_SERVER_ARGS;
    else process.env.OPENCLAW_CODEX_APP_SERVER_ARGS = originalEnv.args;
    if (originalEnv.log === undefined) delete process.env.OCA_CODEX_PROOF_REQUEST_LOG;
    else process.env.OCA_CODEX_PROOF_REQUEST_LOG = originalEnv.log;
    if (originalEnv.scenario === undefined) delete process.env.OCA_CODEX_PROOF_SCENARIO;
    else process.env.OCA_CODEX_PROOF_SCENARIO = originalEnv.scenario;
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function stagePublicArtifacts(outputDir: string): string {
  const resolved = resolveProofOutputDir(outputDir);
  const staged = path.join(resolved, "public-artifacts");
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });
  const allowed = new Set([
    "codex-app-server-requests.redacted.jsonl",
    "harness-messages.redacted.json",
    "mantis-evidence.json",
    "oca-codex-telegram-proof.md",
    "summary.json",
    "telegram-desktop.log",
    "telegram-desktop-motion.gif",
    "telegram-desktop-motion.mp4",
    "telegram-desktop.mp4",
    "telegram-desktop.png",
  ]);
  for (const name of existsSync(resolved) ? readdirSync(resolved) : []) {
    const source = path.join(resolved, name);
    if (!allowed.has(name) || !statSync(source).isFile()) continue;
    const target = path.join(staged, name);
    if (/\.(json|jsonl|log|md)$/u.test(name)) {
      writeRedactedText(target, readFileSync(source, "utf8"));
    } else {
      cpSync(source, target);
    }
  }
  return staged;
}

function proofManifest(plan: ProofPlan, artifacts: EvidenceArtifact[] = [], pass = true): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "oca-codex-telegram-proof",
    title: "OCA Codex Telegram Proof",
    summary: plan.liveExecution.enabled
      ? "OCA Codex native Telegram Desktop proof orchestration completed."
      : "OCA Codex proof scaffolding resolved without starting native Telegram Desktop capture.",
    scenario: plan.scenario,
    comparison: {
      candidate: {
        expected: "Codex harness proof command surface is ready",
        status: pass ? "pass" : "fail",
      },
      pass,
    },
    artifacts: artifacts.map((artifact) => ({
      kind: artifact.kind,
      path: relativeArtifact(artifact.path),
    })),
  };
}

export function writeGuardedRunScaffold(opts: Options): Record<string, unknown> {
  const outputDir = resolveProofOutputDir(opts.outputDir);
  const plan = buildProofPlan(opts);
  mkdirSync(outputDir, { recursive: true });
  writeJson(path.join(outputDir, "summary.json"), {
    ok: true,
    plan,
    note: "Native Telegram Desktop capture is guarded behind the Telegram/Crabbox proof implementation path.",
  });
  writeJson(path.join(outputDir, "mantis-evidence.json"), proofManifest(plan));
  return { ok: true, outputDir: opts.outputDir, staged: stagePublicArtifacts(opts.outputDir) };
}

function printDoctor(opts: Options): void {
  const checks = collectDoctorChecks(opts);
  const ok = checks.every((check) => check.ok || check.name === "private Convex env fallback");
  console.log(JSON.stringify({ ok, checks }, null, 2));
  if (!ok) process.exit(1);
}

async function main(): Promise<void> {
  const opts = parseArgs();
  if (opts.command === "doctor") {
    printDoctor(opts);
    return;
  }
  const plan = buildProofPlan(opts);
  if (opts.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (opts.command === "local-smoke") {
    const summary = await runLocalSmoke(opts);
    console.log(JSON.stringify(summary, null, 2));
    if ((summary as { ok?: boolean }).ok !== true) process.exit(1);
    return;
  }

  const result = await runNativeProof(opts);
  console.log(JSON.stringify({ ...result, staged: stagePublicArtifacts(opts.outputDir) }, null, 2));
  if ((result as { ok?: boolean }).ok !== true) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
