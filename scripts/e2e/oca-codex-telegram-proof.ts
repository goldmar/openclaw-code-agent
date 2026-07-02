#!/usr/bin/env -S node --import tsx
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
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
  tdlibArchive?: string;
  tdlibSha256?: string;
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
    tdlibArchive: "missing" | "provided";
    tdlibSha256: "missing" | "provided";
  };
};

type CredentialLease = {
  credentialId: string;
  desktopWorkdir: string;
  groupId: string;
  leaseFile: string;
  ownerId: string;
  sutToken?: string;
  sutUsername?: string;
  testerUserId: string;
  testerUsername: string;
  userDriverDir: string;
};

type CrabboxDesktop = {
  createdLease: boolean;
  id: string;
  inspect?: CrabboxInspect;
  provider: string;
  target: "linux";
};

type LocalProofSut = {
  gatewayPort: number;
  isolatedHome: string;
  localSmoke?: Record<string, unknown>;
  requestLog?: string;
};

type CrabboxInspect = {
  host?: string;
  id?: string;
  slug?: string;
  sshKey?: string;
  sshPort?: string;
  sshUser?: string;
  state?: string;
};

type TelegramBotResult = Record<string, unknown>;

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
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const REMOTE_SETUP_COMMAND_TIMEOUT_MS = 90 * 60 * 1000;
const REMOTE_ROOT = "/tmp/openclaw-oca-codex-telegram-proof";

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
    "  --tdlib-archive <path>        Prebuilt TDLib tarball with lib/libtdjson.so for Crabbox setup.",
    "  --tdlib-sha256 <sha256>       Expected SHA-256 for --tdlib-archive.",
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
    tdlibArchive: process.env.OPENCLAW_TDLIB_ARCHIVE?.trim() || undefined,
    tdlibSha256: process.env.OPENCLAW_TDLIB_SHA256?.trim() || undefined,
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
      case "--tdlib-archive":
        opts.tdlibArchive = value;
        break;
      case "--tdlib-sha256":
        opts.tdlibSha256 = value;
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
      tdlibArchive: opts.tdlibArchive ? "provided" : "missing",
      tdlibSha256: opts.tdlibSha256 ? "provided" : "missing",
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runCommandSync(params: {
  args: string[];
  command: string;
  cwd?: string;
  input?: string;
  timeoutMs?: number;
}): string {
  const result = spawnSync(params.command, params.args, {
    cwd: params.cwd ?? REPO_ROOT,
    encoding: "utf8",
    input: params.input,
    maxBuffer: 32 * 1024 * 1024,
    timeout: params.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
  if (result.status !== 0 || result.error) {
    const detail = result.error instanceof Error ? result.error.message : result.stderr || result.stdout;
    throw new Error(`${params.command} ${params.args.join(" ")} failed\n${redactProofText(detail || "")}`);
  }
  return result.stdout;
}

function sshArgs(inspect: CrabboxInspect): { base: string[]; scpBase: string[]; target: string } {
  if (!inspect.host || !inspect.sshKey || !inspect.sshUser) {
    throw new Error("Crabbox inspect output is missing SSH details.");
  }
  return {
    base: [
      "-i",
      inspect.sshKey,
      "-p",
      inspect.sshPort ?? "22",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-o",
      "ConnectTimeout=15",
    ],
    scpBase: [
      "-i",
      inspect.sshKey,
      "-P",
      inspect.sshPort ?? "22",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-o",
      "ConnectTimeout=15",
    ],
    target: `${inspect.sshUser}@${inspect.host}`,
  };
}

function scpToRemote(inspect: CrabboxInspect, local: string, remote: string): void {
  const ssh = sshArgs(inspect);
  runCommandSync({ command: "scp", args: [...ssh.scpBase, local, `${ssh.target}:${remote}`] });
}

function scpFromRemote(inspect: CrabboxInspect, remote: string, local: string): void {
  const ssh = sshArgs(inspect);
  mkdirSync(path.dirname(local), { recursive: true });
  runCommandSync({ command: "scp", args: [...ssh.scpBase, `${ssh.target}:${remote}`, local] });
}

function sshRun(inspect: CrabboxInspect, command: string, timeoutMs = COMMAND_TIMEOUT_MS): string {
  const ssh = sshArgs(inspect);
  return runCommandSync({
    command: "ssh",
    args: [...ssh.base, ssh.target, command],
    timeoutMs,
  });
}

function extractCrabboxLeaseId(output: string): string {
  const leaseId = output.match(/\b(?:cbx_[a-f0-9]+|tbx_[A-Za-z0-9_-]+)\b/u)?.[0];
  if (!leaseId) throw new Error("Crabbox warmup did not print a lease id.");
  return leaseId;
}

function renderRemoteSetup(opts: Options): string {
  const tdlibSha256 = opts.tdlibSha256 ?? "";
  return `#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/sbin:/usr/sbin:/sbin:$PATH"
root=${REMOTE_ROOT}
tdlib_expected_sha=${JSON.stringify(tdlibSha256)}
setup_step_timeout_kill_after="\${OPENCLAW_TELEGRAM_USER_SETUP_KILL_AFTER_SECONDS:-30}s"
apt_timeout="\${OPENCLAW_TELEGRAM_USER_APT_TIMEOUT_SECONDS:-900}s"
run_setup_step() {
  local label="$1"
  local timeout_value="$2"
  shift 2
  echo "==> $label" >&2
  timeout --kill-after="$setup_step_timeout_kill_after" "$timeout_value" "$@"
}
mkdir -p "$root"
tar -xzf "$root/state.tgz" -C "$root"
run_setup_step "apt-get update" "$apt_timeout" sudo apt-get update -y
run_setup_step "apt-get install" "$apt_timeout" sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y curl cmake g++ git gperf make zlib1g-dev libssl-dev python3 ffmpeg scrot xz-utils tar wmctrl xdotool x11-utils zbar-tools libopengl0 libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-shape0 libxcb-xfixes0 libxcb-xinerama0 libxkbcommon-x11-0 >/tmp/openclaw-oca-telegram-apt.log
if [ ! -x "$root/Telegram/Telegram" ]; then
  curl -fL --retry 3 --retry-delay 5 --retry-all-errors -o "$root/telegram.tar.xz" https://telegram.org/dl/desktop/linux
  tar -xJf "$root/telegram.tar.xz" -C "$root"
fi
if ! ldconfig -p | grep -q libtdjson.so && [ -f "$root/tdlib.tgz" ]; then
  if [ -n "$tdlib_expected_sha" ]; then
    printf '%s  %s\\n' "$tdlib_expected_sha" "$root/tdlib.tgz" | sha256sum -c -
  fi
  rm -rf "$root/tdlib-prebuilt"
  mkdir -p "$root/tdlib-prebuilt"
  tar -xzf "$root/tdlib.tgz" -C "$root/tdlib-prebuilt"
  tdjson_lib="$(find "$root/tdlib-prebuilt" \\( -name 'libtdjson.so' -o -name 'libtdjson.so.*' \\) -type f | sort | head -n 1)"
  if [ -z "$tdjson_lib" ]; then
    echo "tdlib archive did not contain libtdjson.so" >&2
    exit 1
  fi
  run_setup_step "tdlib install from archive" "$apt_timeout" sudo install -m 0755 "$tdjson_lib" /usr/local/lib/libtdjson.so
  sudo ldconfig
fi
if ! ldconfig -p | grep -q libtdjson.so; then
  rm -rf "$root/td" "$root/td-build"
  run_setup_step "tdlib clone" 600s git clone --depth 1 --branch v1.8.0 https://github.com/tdlib/td.git "$root/td"
  run_setup_step "tdlib configure" 1800s cmake -S "$root/td" -B "$root/td-build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DTD_ENABLE_JNI=OFF
  run_setup_step "tdlib build" 1800s cmake --build "$root/td-build" --target tdjson -j "$(nproc)"
  tdjson_lib="$(find "$root/td-build" -name 'libtdjson.so*' -type f | sort | head -n 1)"
  if [ -z "$tdjson_lib" ]; then
    echo "tdlib build did not produce libtdjson.so" >&2
    exit 1
  fi
  run_setup_step "tdlib install" "$apt_timeout" sudo install -m 0755 "$tdjson_lib" /usr/local/lib/libtdjson.so
  sudo ldconfig
fi
TELEGRAM_USER_DRIVER_STATE_DIR="$root/user-driver" python3 "$root/user-driver.py" status --json --timeout-ms 60000 >"$root/status.json"
TELEGRAM_USER_DRIVER_STATE_DIR="$root/user-driver" python3 "$root/user-driver.py" terminate-desktop-sessions --json --timeout-ms 60000 --output "$root/desktop-sessions-cleanup.json"
`;
}

function renderLaunchDesktop(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
root=${REMOTE_ROOT}
export DISPLAY="\${DISPLAY:-:99}"
pkill -f "$root/Telegram/Telegram" >/dev/null 2>&1 || true
nohup "$root/Telegram/Telegram" -workdir "$root/desktop" >"$root/telegram-desktop.log" 2>&1 &
pid=$!
sleep 8
kill -0 "$pid"
wmctrl -l | grep -i telegram >/dev/null
`;
}

function renderAuthorizeDesktop(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
root=${REMOTE_ROOT}
export DISPLAY="\${DISPLAY:-:99}"
win="$(wmctrl -l | awk 'tolower($0) ~ /telegram/ {print $1; exit}')"
test -n "$win"
xdotool windowactivate "$win"
sleep 2
click_window_ratio() {
  eval "$(xdotool getwindowgeometry --shell "$win")"
  xdotool windowactivate "$win"
  sleep 0.2
  xdotool mousemove "$((X + WIDTH / 2))" "$((Y + HEIGHT * $1 / 100))"
  sleep 0.2
  xdotool click 1
  sleep 1
}
read_qr_link() {
  scrot "$root/telegram-login-qr.png"
  { zbarimg --raw "$root/telegram-login-qr.png" 2>/dev/null || true; } | awk 'index($0, "tg://login?token=") == 1 {print; exit}'
}
click_window_ratio 69
sleep 3
click_window_ratio 80
link=""
for _ in $(seq 1 25); do
  link="$(read_qr_link)"
  [ -n "$link" ] && break
  sleep 1
done
if [ -n "$link" ]; then
  TELEGRAM_USER_DRIVER_STATE_DIR="$root/user-driver" python3 "$root/user-driver.py" confirm-qr --link "$link" --json --output "$root/desktop-session.json"
fi
sleep 6
`;
}

function renderSelectDesktopChat(chatTitle: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
chat_title=${shellQuote(chatTitle)}
export DISPLAY="\${DISPLAY:-:99}"
win="$(wmctrl -l | awk 'tolower($0) ~ /telegram/ {print $1; exit}')"
test -n "$win"
left=520
top=170
xdotool windowactivate --sync "$win"
xdotool windowsize "$win" 980 720
xdotool windowmove "$win" "$left" "$top"
sleep 1
xdotool mousemove "$((left + 180))" "$((top + 50))" click 1
xdotool key ctrl+a BackSpace
xdotool type --delay 5 -- "$chat_title"
sleep 2
xdotool mousemove "$((left + 150))" "$((top + 120))" click 1
sleep 1
`;
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

function redactProofText(value: string): string {
  return String(redactProofValue(value))
    .replace(/"((?:sut|tester)?Username|groupId|testerUserId|credentialId|ownerId)"\s*:\s*"[^"]*"/giu, '"$1": "[redacted id]"')
    .replace(/\bauthorization\b(?:(\s*[:=]\s*)|\s+)(?:"(?:Bearer\s+)?[^"]+"|'(?:Bearer\s+)?[^']+'|(?:Bearer\s+)?[A-Za-z0-9._~+/-]+=*)/giu, "authorization$1[redacted credential]")
    .replace(/\b(secret|password|api[-_ ]?key|credential|token)\b(?:(\s*[:=]\s*)|\s+)(?:"[^"]*"|'[^']*'|[^\s,;)}\]]+)/giu, "$1$2[redacted credential]")
    .replace(/\/(?:Users|home|tmp|private\/tmp|var\/folders|workspace|run\/user)\/[^\s"'<>),\]]+/gu, "[redacted path]")
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

function writeRedactedJsonText(file: string, value: string): void {
  try {
    writeJson(file, JSON.parse(value));
  } catch {
    writeRedactedText(file, value);
  }
}

function writeRedactedJsonLines(file: string, value: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const lines = value.split(/\r?\n/u);
  const redacted = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      return JSON.stringify(redactProofValue(JSON.parse(line)));
    } catch {
      return redactProofText(line);
    }
  });
  writeFileSync(file, redacted.join("\n"));
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

export function buildTelegramCredentialCommandArgs(opts: Options, command: "lease-restore" | "release", extra: string[] = []): string[] {
  const args = ["--import", "tsx", TELEGRAM_USER_CREDENTIAL, command, ...extra];
  args.push("--env-file", expandHome(opts.envFile ?? PRIVATE_CONVEX_ENV));
  return args;
}

async function telegramBotApi(token: string, method: string, body: Record<string, unknown> = {}): Promise<TelegramBotResult> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    throw new Error(`${method} failed: ${redactProofText(JSON.stringify(payload))}`);
  }
  return payload.result && typeof payload.result === "object" ? payload.result as TelegramBotResult : { value: payload.result };
}

function messageIdFromBotResult(value: TelegramBotResult): string {
  const messageId = value.message_id ?? value.messageId ?? value.id;
  if (typeof messageId === "number" || typeof messageId === "string") return String(messageId);
  throw new Error("Telegram sendMessage did not return a message id.");
}

function callbackQueryIdFromUpdate(update: Record<string, unknown>, expectedData: string): string | undefined {
  const query = update.callback_query;
  if (!query || typeof query !== "object" || Array.isArray(query)) return undefined;
  const record = query as Record<string, unknown>;
  if (record.data !== expectedData) return undefined;
  const id = record.id;
  return typeof id === "string" && id ? id : undefined;
}

async function answerExpectedCallback(params: {
  callbackData: string;
  stopWhen: () => boolean;
  token: string;
  timeoutMs: number;
}): Promise<{ answered: boolean; updatesSeen: number }> {
  let offset = 0;
  let updatesSeen = 0;
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline && !params.stopWhen()) {
    const result = await telegramBotApi(params.token, "getUpdates", {
      allowed_updates: ["callback_query"],
      offset,
      timeout: 2,
    });
    const updates = Array.isArray(result) ? result : [];
    for (const update of updates) {
      if (!update || typeof update !== "object" || Array.isArray(update)) continue;
      const record = update as Record<string, unknown>;
      if (typeof record.update_id === "number") offset = Math.max(offset, record.update_id + 1);
      updatesSeen += 1;
      const callbackQueryId = callbackQueryIdFromUpdate(record, params.callbackData);
      if (!callbackQueryId) continue;
      await telegramBotApi(params.token, "answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: "OCA Codex proof callback acknowledged",
        show_alert: false,
      });
      return { answered: true, updatesSeen };
    }
  }
  return { answered: false, updatesSeen };
}

async function clickCallbackWithBotAnswer(params: {
  callbackData: string;
  credential: CredentialLease;
  messageId: string;
  outputDir: string;
  token: string;
  timeoutMs: number;
}): Promise<{ callback: Record<string, unknown>; callbackAnswer: { answered: boolean; updatesSeen: number } }> {
  const callbackPath = path.join(params.outputDir, "telegram-callback.redacted.json");
  let clickDone = false;
  const child = spawn("python3", [
    TELEGRAM_USER_DRIVER,
    "click-callback",
    "--chat",
    params.credential.groupId,
    "--message-id",
    params.messageId,
    "--button-text",
    "Acknowledge",
    "--json",
    "--output",
    callbackPath,
    "--timeout-ms",
    String(params.timeoutMs),
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TELEGRAM_USER_DRIVER_STATE_DIR: params.credential.userDriverDir,
      TELEGRAM_USER_DRIVER_SUT_USERNAME: params.credential.sutUsername ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-12000);
  });
  const waitForClick = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      clickDone = true;
      if (code === 0) resolve();
      else reject(new Error(`telegram-user click-callback failed with exit code ${code ?? "unknown"}\n${redactProofText(stderr)}`));
    });
  });
  const callbackAnswer = await answerExpectedCallback({
    callbackData: params.callbackData,
    stopWhen: () => clickDone,
    token: params.token,
    timeoutMs: params.timeoutMs,
  });
  await waitForClick;
  return {
    callback: JSON.parse(readFileSync(callbackPath, "utf8")) as Record<string, unknown>,
    callbackAnswer,
  };
}

function runTelegramUserDriverJson(args: string[], timeoutMs: number): Record<string, unknown> {
  const output = runCommandSync({
    command: "python3",
    args: [TELEGRAM_USER_DRIVER, ...args, "--json"],
    cwd: REPO_ROOT,
    timeoutMs,
  });
  return JSON.parse(output) as Record<string, unknown>;
}

async function resolveTdlibMessageIdByTranscript(params: {
  credential: CredentialLease;
  marker: string;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + params.timeoutMs;
  let lastObserved = 0;
  while (Date.now() < deadline) {
    const transcript = runTelegramUserDriverJson([
      "transcript",
      "--chat",
      params.credential.groupId,
      "--limit",
      "30",
    ], Math.min(params.timeoutMs, 30_000));
    const messages = Array.isArray(transcript.messages) ? transcript.messages : [];
    lastObserved = Math.max(lastObserved, messages.length);
    for (const message of messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const record = message as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text : "";
      const messageId = record.messageId;
      if (!text.includes(params.marker)) continue;
      if (typeof messageId === "number" || typeof messageId === "string") return String(messageId);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `Timed out resolving Telegram proof message via TDLib transcript; marker=${params.marker}, observed=${lastObserved}`,
  );
}

async function defaultLiveDeps(): Promise<NativeProofDeps> {
  return {
    async acquireCredentialLease(opts, sessionDir) {
      assertNativeProofEnabled(opts);
      const userDriverDir = path.join(sessionDir, "user-driver");
      const desktopWorkdir = path.join(sessionDir, "desktop");
      const leaseFile = path.join(sessionDir, "lease.json");
      const payloadFile = path.join(sessionDir, "telegram-user-payload.json");
      const result = spawnSync(process.execPath, buildTelegramCredentialCommandArgs(opts, "lease-restore", [
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
        sutToken: String(payload.sutToken || ""),
        testerUserId: String(payload.testerUserId || ""),
        testerUsername: String(payload.testerUsername || ""),
        userDriverDir,
      };
    },
    async captureEvidence({ crabbox, credential, localSut, opts, outputDir }) {
      assertNativeProofEnabled(opts);
      if (!credential.sutToken) throw new Error("telegram-user payload is missing sutToken.");
      if (!crabbox.inspect) throw new Error("Crabbox inspect output is missing; cannot capture native proof evidence.");

      const runId = randomUUID().slice(0, 8);
      const callbackData = `oca-proof:${runId}`;
      const proofText = [
        `OCA Codex Telegram proof ${runId}`,
        `Scenario: ${opts.scenario}`,
        "Harness: Codex App Server local smoke",
        "Marker: OPENCLAW_OCA_CODEX_BASIC_OK",
        "Action: press Acknowledge to verify callback routing.",
      ].join("\n");

      const videoPath = path.join(outputDir, "telegram-desktop.mp4");
      const motionVideoPath = path.join(outputDir, "telegram-desktop-motion.mp4");
      const motionGifPath = path.join(outputDir, "telegram-desktop-motion.gif");
      const screenshotPath = path.join(outputDir, "telegram-desktop.png");
      const transcriptPath = path.join(outputDir, "telegram-transcript.redacted.json");
      const callbackPath = path.join(outputDir, "telegram-callback.redacted.json");
      const callbackAnswerPath = path.join(outputDir, "telegram-callback-answer.redacted.json");
      const desktopLogPath = path.join(outputDir, "telegram-desktop.log");
      const sessionDir = localSut.isolatedHome;
      const setupScript = path.join(sessionDir, "remote-setup.sh");
      const launchScript = path.join(sessionDir, "launch-desktop.sh");
      const authorizeScript = path.join(sessionDir, "authorize-desktop.sh");
      const selectChatScript = path.join(sessionDir, "select-desktop-chat.sh");
      writeFileSync(setupScript, renderRemoteSetup(opts));
      writeFileSync(launchScript, renderLaunchDesktop());
      writeFileSync(authorizeScript, renderAuthorizeDesktop());
      writeFileSync(selectChatScript, renderSelectDesktopChat(opts.desktopChatTitle));
      for (const script of [setupScript, launchScript, authorizeScript, selectChatScript]) chmodSync(script, 0o700);

      sshRun(crabbox.inspect, `rm -rf ${REMOTE_ROOT} && mkdir -p ${REMOTE_ROOT}`);
      scpToRemote(crabbox.inspect, path.join(sessionDir, "remote-state.tgz"), `${REMOTE_ROOT}/state.tgz`);
      if (opts.tdlibArchive) {
        const tdlibArchive = expandHome(opts.tdlibArchive);
        if (!existsSync(tdlibArchive)) throw new Error(`TDLib archive does not exist: ${tdlibArchive}`);
        scpToRemote(crabbox.inspect, tdlibArchive, `${REMOTE_ROOT}/tdlib.tgz`);
      }
      scpToRemote(crabbox.inspect, setupScript, `${REMOTE_ROOT}/remote-setup.sh`);
      scpToRemote(crabbox.inspect, launchScript, `${REMOTE_ROOT}/launch-desktop.sh`);
      scpToRemote(crabbox.inspect, authorizeScript, `${REMOTE_ROOT}/authorize-desktop.sh`);
      scpToRemote(crabbox.inspect, selectChatScript, `${REMOTE_ROOT}/select-desktop-chat.sh`);
      sshRun(crabbox.inspect, `bash ${REMOTE_ROOT}/remote-setup.sh`, REMOTE_SETUP_COMMAND_TIMEOUT_MS);
      sshRun(crabbox.inspect, `bash ${REMOTE_ROOT}/launch-desktop.sh`);
      sshRun(crabbox.inspect, `bash ${REMOTE_ROOT}/authorize-desktop.sh`);
      sshRun(crabbox.inspect, `bash ${REMOTE_ROOT}/select-desktop-chat.sh`);

      const sent = await telegramBotApi(credential.sutToken, "sendMessage", {
        chat_id: credential.groupId,
        disable_notification: true,
        reply_markup: {
          inline_keyboard: [[{ text: "Acknowledge", callback_data: callbackData }]],
        },
        text: proofText,
      });
      const messageId = messageIdFromBotResult(sent);
      const tdlibMessageId = await resolveTdlibMessageIdByTranscript({
        credential,
        marker: runId,
        timeoutMs: Math.min(opts.timeoutMs, 60_000),
      });

      const record = spawn(opts.crabboxBin, [
        "artifacts",
        "video",
        "--provider",
        opts.crabboxProvider,
        "--target",
        "linux",
        "--id",
        crabbox.id,
        "--duration",
        `${opts.recordSeconds}s`,
        "--output",
        videoPath,
      ], { cwd: REPO_ROOT, stdio: "ignore" });

      await new Promise((resolve) => setTimeout(resolve, 3000));
      const clicked = await clickCallbackWithBotAnswer({
        callbackData,
        credential,
        messageId: tdlibMessageId,
        outputDir,
        token: credential.sutToken,
        timeoutMs: Math.min(opts.timeoutMs, 60_000),
      });
      writeJson(callbackAnswerPath, clicked.callbackAnswer);
      writeJson(callbackPath, clicked.callback);

      const recordExit = await new Promise<number | null>((resolve) => {
        record.once("close", resolve);
      });
      if (recordExit !== 0) {
        throw new Error(`Crabbox video recording failed with exit code ${recordExit ?? "unknown"}.`);
      }

      runCommandSync({
        command: opts.crabboxBin,
        args: [
          "screenshot",
          "--provider",
          opts.crabboxProvider,
          "--target",
          "linux",
          "--id",
          crabbox.id,
          "--output",
          screenshotPath,
        ],
      });
      scpFromRemote(crabbox.inspect, `${REMOTE_ROOT}/telegram-desktop.log`, desktopLogPath);
      runCommandSync({
        command: opts.crabboxBin,
        args: [
          "media",
          "preview",
          "--input",
          videoPath,
          "--output",
          motionGifPath,
          "--fps",
          "12",
          "--width",
          "1280",
          "--trimmed-video-output",
          motionVideoPath,
          "--json",
        ],
      });
      const transcript = runCommandSync({
        command: "python3",
        args: [
          TELEGRAM_USER_DRIVER,
          "transcript",
          "--chat",
          credential.groupId,
          "--limit",
          "20",
          "--json",
        ],
        cwd: REPO_ROOT,
        timeoutMs: Math.min(opts.timeoutMs, 60_000),
      });
      writeRedactedJsonText(transcriptPath, transcript);

      writeRedactedText(
        path.join(outputDir, "oca-codex-telegram-proof.md"),
        [
          "# OCA Codex Telegram Proof",
          "",
          `Scenario: ${opts.scenario}`,
          "Status: PASS",
          `Telegram Bot API message id: ${messageId}`,
          `Telegram TDLib message id: ${tdlibMessageId}`,
          `Local smoke: ${(localSut.localSmoke as { ok?: boolean } | undefined)?.ok === true ? "PASS" : "UNKNOWN"}`,
          "Callback: Acknowledge button clicked and answered through Telegram.",
          "",
        ].join("\n"),
      );

      return [
        { kind: "markdown", path: path.join(outputDir, "oca-codex-telegram-proof.md"), public: true },
        { kind: "json", path: transcriptPath, public: true },
        { kind: "json", path: callbackPath, public: true },
        { kind: "json", path: callbackAnswerPath, public: true },
        { kind: "log", path: desktopLogPath, public: true },
        { kind: "screenshot", path: screenshotPath, public: false },
        { kind: "video", path: videoPath, public: false },
        { kind: "video", path: motionVideoPath, public: false },
        { kind: "video", path: motionGifPath, public: false },
      ];
    },
    async releaseCredentialLease(lease, opts) {
      if (!existsSync(lease.leaseFile)) {
        throw new Error(`telegram-user lease file is missing; cannot safely release credential: ${lease.leaseFile}`);
      }
      const result = spawnSync(process.execPath, buildTelegramCredentialCommandArgs(opts, "release", ["--lease-file", lease.leaseFile]), {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      if (result.status !== 0) {
        throw new Error(`telegram-user release failed\n${redactProofText(result.stderr || result.stdout)}`);
      }
    },
    async startCrabboxDesktop(opts) {
      assertNativeProofEnabled(opts);
      const leaseOutput = runCommandSync({
        command: opts.crabboxBin,
        args: [
          "warmup",
          "--provider",
          opts.crabboxProvider,
          "--target",
          "linux",
          "--desktop",
          "--idle-timeout",
          "60m",
          "--ttl",
          "120m",
        ],
      });
      const id = extractCrabboxLeaseId(leaseOutput);
      const inspect = JSON.parse(runCommandSync({
        command: opts.crabboxBin,
        args: ["inspect", "--provider", opts.crabboxProvider, "--target", "linux", "--id", id, "--json"],
      })) as CrabboxInspect;
      return { createdLease: true, id, inspect, provider: opts.crabboxProvider, target: "linux" };
    },
    async startLocalSut({ opts, sessionDir }) {
      assertNativeProofEnabled(opts);
      const smokeOutputDir = path.join(opts.outputDir, "local-smoke");
      const smoke = await runLocalSmoke(parseArgs([
        "local-smoke",
        "--scenario",
        opts.scenario,
        "--output-dir",
        smokeOutputDir,
        "--timeout-ms",
        String(opts.timeoutMs),
      ]));
      const remoteStateRoot = path.join(sessionDir, "remote-state");
      mkdirSync(remoteStateRoot, { recursive: true });
      copyFileSync(TELEGRAM_USER_DRIVER, path.join(remoteStateRoot, "user-driver.py"));
      runCommandSync({
        command: "tar",
        args: [
          "-C",
          sessionDir,
          "-czf",
          path.join(sessionDir, "remote-state.tgz"),
          "user-driver",
          "desktop",
          "-C",
          remoteStateRoot,
          "user-driver.py",
        ],
      });
      return {
        gatewayPort: opts.gatewayPort,
        isolatedHome: sessionDir,
        localSmoke: smoke,
        requestLog: path.join(REPO_ROOT, smokeOutputDir, "codex-app-server-requests.redacted.jsonl"),
      };
    },
    async stopCrabboxDesktop(desktop, opts) {
      if (desktop.createdLease) {
        runCommandSync({
          command: opts.crabboxBin,
          args: ["stop", "--provider", opts.crabboxProvider, desktop.id],
        });
      }
    },
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
    try {
      session.credential = await orchestrator.acquireCredentialLease(opts, sessionDir);
    } catch (error) {
      const partialLeaseFile = path.join(sessionDir, "lease.json");
      if (existsSync(partialLeaseFile)) {
        cleanup.push(async () => {
          await orchestrator.releaseCredentialLease(partialCredentialLease(sessionDir, partialLeaseFile), opts);
        });
      }
      throw error;
    }
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
    const publicArtifacts = artifacts.filter((artifact) => artifact.public && isStageablePublicArtifact(artifact.path));
    const cleanupOk = cleanupErrors.length === 0;
    result = {
      ...result,
      ok: result.ok && cleanupOk,
      cleanupErrors,
    };
    const retainSessionForCleanup = cleanupErrors.length > 0 || (!session.credential && sessionDirHasRecoveryArtifacts(sessionDir));
    const stagedPublicArtifacts = path.join(outputDir, "public-artifacts");
    const summary = {
      ok: result.ok,
      cleanupErrors,
      error: result.error,
      sessionRetainedForCleanup: retainSessionForCleanup,
      plan,
      session,
      artifacts: publicArtifacts.map((artifact) => ({ ...artifact, path: relativeArtifact(artifact.path) })),
      privateArtifactCount: artifacts.length - publicArtifacts.length,
      stagedPublicArtifacts: relativeArtifact(stagedPublicArtifacts),
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
    result = {
      ...result,
      staged: relativeArtifact(stagePublicArtifacts(opts.outputDir)),
    };
    if (!retainSessionForCleanup) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  }
  return result;
}

const STAGED_PUBLIC_TEXT_ARTIFACTS = new Set([
  "codex-app-server-requests.redacted.jsonl",
  "harness-messages.redacted.json",
  "mantis-evidence.json",
  "oca-codex-telegram-proof.md",
  "summary.json",
  "telegram-callback-answer.redacted.json",
  "telegram-callback.redacted.json",
  "telegram-desktop.log",
  "telegram-transcript.redacted.json",
]);

const PRIVATE_VISUAL_ARTIFACTS = new Set([
  "telegram-desktop-motion.gif",
  "telegram-desktop-motion.mp4",
  "telegram-desktop.mp4",
  "telegram-desktop.png",
]);

function isStageablePublicArtifact(file: string): boolean {
  return STAGED_PUBLIC_TEXT_ARTIFACTS.has(path.basename(file));
}

function partialCredentialLease(sessionDir: string, leaseFile: string): CredentialLease {
  return {
    credentialId: "partial-acquire-failure",
    desktopWorkdir: path.join(sessionDir, "desktop"),
    groupId: "",
    leaseFile,
    ownerId: "",
    testerUserId: "",
    testerUsername: "",
    userDriverDir: path.join(sessionDir, "user-driver"),
  };
}

function sessionDirHasRecoveryArtifacts(sessionDir: string): boolean {
  return existsSync(sessionDir) && readdirSync(sessionDir).length > 0;
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
  const omittedPrivateArtifacts: string[] = [];
  for (const name of existsSync(resolved) ? readdirSync(resolved) : []) {
    const source = path.join(resolved, name);
    if (!statSync(source).isFile()) continue;
    if (PRIVATE_VISUAL_ARTIFACTS.has(name)) {
      omittedPrivateArtifacts.push(name);
      continue;
    }
    if (!STAGED_PUBLIC_TEXT_ARTIFACTS.has(name)) continue;
    const target = path.join(staged, name);
    const text = readFileSync(source, "utf8");
    if (name.endsWith(".json")) writeRedactedJsonText(target, text);
    else if (name.endsWith(".jsonl")) writeRedactedJsonLines(target, text);
    else writeRedactedText(target, text);
  }
  if (omittedPrivateArtifacts.length > 0) {
    writeJson(path.join(staged, "omitted-private-artifacts.json"), {
      omitted: omittedPrivateArtifacts.sort().map((name) => ({
        name,
        reason: "visual Telegram proof artifacts are retained privately because rendered UI can contain identifiers",
      })),
    });
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
  console.log(JSON.stringify(redactProofValue({ ...result, staged: stagePublicArtifacts(opts.outputDir) }), null, 2));
  if ((result as { ok?: boolean }).ok !== true) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
