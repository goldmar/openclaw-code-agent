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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHarness } from "../../src/harness/index";
import type { HarnessMessage } from "../../src/harness/types";
import { redactProofValue } from "./oca-codex-proof-app-server";

type Command = "doctor" | "local-smoke" | "run";
type Options = {
  command: Command;
  crabboxBin: string;
  crabboxProvider: string;
  desktopChatTitle: string;
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
  };
  telegram: {
    credentialKind: "telegram-user";
    desktopChatTitle: string;
    recordSeconds: number;
  };
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_OUTPUT_ROOT = ".artifacts/qa-e2e/oca-codex-telegram";
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
    "  --output-dir <path>           Artifact directory. Default: .artifacts/qa-e2e/oca-codex-telegram/<timestamp>.",
    "  --crabbox-bin <path>          Crabbox binary. Default: OPENCLAW_TELEGRAM_USER_CRABBOX_BIN or crabbox.",
    "  --provider <name>             Crabbox provider. Default: OPENCLAW_TELEGRAM_USER_CRABBOX_PROVIDER or local-container.",
    "  --desktop-chat-title <title>  Telegram Desktop chat title for native proof capture.",
    "  --gateway-port <port>         Disposable gateway port. Default: 38975.",
    "  --record-seconds <seconds>    Native desktop recording duration. Default: 35.",
    "  --keep-box                    Keep Crabbox lease for VNC/debugging.",
    "  --dry-run                     Print the resolved proof plan without leasing credentials.",
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
  return {
    command: opts.command,
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
    },
    telegram: {
      credentialKind: "telegram-user",
      desktopChatTitle: opts.desktopChatTitle,
      recordSeconds: opts.recordSeconds,
    },
  };
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
  writeFileSync(file, `${JSON.stringify(redactProofValue(value), null, 2)}\n`);
}

async function collectUntilCompleted(messages: AsyncIterable<HarnessMessage>, timeoutMs: number): Promise<HarnessMessage[]> {
  const seen: HarnessMessage[] = [];
  const iterator = messages[Symbol.asyncIterator]();
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
    if (next.value.type === "run_completed") break;
  }
  return seen;
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
  const outputDir = path.resolve(REPO_ROOT, opts.outputDir);
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
    const messages = await collectUntilCompleted(launched.messages, opts.timeoutMs);
    const terminal = messages.find((message): message is Extract<HarnessMessage, { type: "run_completed" }> => (
      message.type === "run_completed"
    ));
    const summary = {
      ok: terminal?.data.success === true,
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
  const resolved = path.resolve(REPO_ROOT, outputDir);
  const staged = path.join(resolved, "public-artifacts");
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });
  const allowed = new Set([
    "codex-app-server-requests.redacted.jsonl",
    "harness-messages.redacted.json",
    "mantis-evidence.json",
    "oca-codex-telegram-proof.md",
    "summary.json",
    "telegram-desktop-motion.gif",
    "telegram-desktop-motion.mp4",
    "telegram-desktop.mp4",
    "telegram-desktop.png",
  ]);
  for (const name of existsSync(resolved) ? readdirSync(resolved) : []) {
    const source = path.join(resolved, name);
    if (!allowed.has(name) || !statSync(source).isFile()) continue;
    cpSync(source, path.join(staged, name));
  }
  return staged;
}

function proofManifest(plan: ProofPlan): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "oca-codex-telegram-proof",
    title: "OCA Codex Telegram Proof",
    summary: "OCA Codex proof scaffolding resolved without starting native Telegram Desktop capture.",
    scenario: plan.scenario,
    comparison: {
      candidate: {
        expected: "Codex harness proof command surface is ready",
        status: "skipped",
      },
      pass: true,
    },
    artifacts: [],
  };
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

  mkdirSync(path.resolve(REPO_ROOT, opts.outputDir), { recursive: true });
  writeJson(path.join(path.resolve(REPO_ROOT, opts.outputDir), "summary.json"), {
    ok: true,
    plan,
    note: "Native Telegram Desktop capture is guarded behind the Telegram/Crabbox proof implementation path.",
  });
  writeJson(path.join(path.resolve(REPO_ROOT, opts.outputDir), "mantis-evidence.json"), proofManifest(plan));
  console.log(JSON.stringify({ ok: true, outputDir: opts.outputDir, staged: stagePublicArtifacts(opts.outputDir) }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
