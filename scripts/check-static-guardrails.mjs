import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, join, relative, sep } from "path";

const root = process.cwd();
const srcDir = join(root, "src");
const testsDir = join(root, "tests");

/**
 * Repository files: tracked plus untracked-but-not-ignored (so a new file is
 * checked before its first commit), from `git ls-files`. Ignored build output,
 * installed packages, and local scratch files are never scanned. Falls back to
 * a directory walk outside a git checkout (for example an unpacked tarball).
 */
function listRepositoryFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean).map((file) => join(root, file)).filter((path) => existsSync(path));
  } catch {
    return undefined;
  }
}
const repositoryFiles = listRepositoryFiles();

function collectFiles(dir, predicate, acc = []) {
  if (repositoryFiles) {
    const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
    for (const path of repositoryFiles) {
      if (path.startsWith(prefix) && predicate(path)) acc.push(path);
    }
    return acc;
  }
  return walkFiles(dir, predicate, acc);
}

function walkFiles(dir, predicate, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // Installed packages (for example .github/release-tools/node_modules) are not repository content.
    if (entry.isDirectory() && entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      walkFiles(path, predicate, acc);
    } else if (predicate(path)) {
      acc.push(path);
    }
  }
  return acc;
}

function stripCommentsAndStrings(source) {
  let output = "";
  let i = 0;
  let state = "code";
  let quote = "";
  let templateDepth = 0;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (state === "line-comment") {
      output += char === "\n" ? "\n" : " ";
      if (char === "\n") state = "code";
      i += 1;
      continue;
    }

    if (state === "block-comment") {
      output += char === "\n" ? "\n" : " ";
      if (char === "*" && next === "/") {
        output += " ";
        i += 2;
        state = "code";
      } else {
        i += 1;
      }
      continue;
    }

    if (state === "string") {
      output += char === "\n" ? "\n" : " ";
      if (char === "\\") {
        output += next === "\n" ? "\n" : " ";
        i += 2;
      } else if (char === quote) {
        state = "code";
        quote = "";
        i += 1;
      } else {
        i += 1;
      }
      continue;
    }

    if (state === "template") {
      output += char === "\n" ? "\n" : " ";
      if (char === "\\") {
        output += next === "\n" ? "\n" : " ";
        i += 2;
      } else if (char === "`" && templateDepth === 0) {
        state = "code";
        i += 1;
      } else {
        i += 1;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      output += "  ";
      state = "line-comment";
      i += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      output += "  ";
      state = "block-comment";
      i += 2;
      continue;
    }
    if (char === "\"" || char === "'") {
      output += " ";
      quote = char;
      state = "string";
      i += 1;
      continue;
    }
    if (char === "`") {
      output += " ";
      templateDepth = 0;
      state = "template";
      i += 1;
      continue;
    }

    output += char;
    i += 1;
  }

  return output;
}

function stripComments(source) {
  let output = "";
  let i = 0;
  let state = "code";

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (state === "line-comment") {
      output += char === "\n" ? "\n" : " ";
      if (char === "\n") state = "code";
      i += 1;
      continue;
    }

    if (state === "block-comment") {
      output += char === "\n" ? "\n" : " ";
      if (char === "*" && next === "/") {
        output += " ";
        i += 2;
        state = "code";
      } else {
        i += 1;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      output += "  ";
      state = "line-comment";
      i += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      output += "  ";
      state = "block-comment";
      i += 2;
      continue;
    }

    output += char;
    i += 1;
  }

  return output;
}

function lineForIndex(source, index) {
  return source.slice(0, index).split("\n").length;
}

function rel(path) {
  return relative(root, path);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nearestClassNameBefore(source, index) {
  let className;
  const classPattern = /\bclass\s+([A-Za-z_]\w*)\b/g;
  for (const match of source.slice(0, index).matchAll(classPattern)) {
    className = match[1];
  }
  return className;
}

function classTypedAliases(source, className) {
  const aliases = new Set();
  const typedAliasPattern = new RegExp(`\\b([A-Za-z_]\\w*)\\s*:\\s*${escapeRegExp(className)}\\b`, "g");
  for (const match of source.matchAll(typedAliasPattern)) {
    aliases.add(match[1]);
  }
  return [...aliases];
}

const failures = [];
const srcFiles = collectFiles(srcDir, (path) => path.endsWith(".ts"));
const testFiles = collectFiles(testsDir, (path) => path.endsWith(".ts"));

for (const path of srcFiles) {
  const source = readFileSync(path, "utf8");
  const stripped = stripCommentsAndStrings(source);
  const privateReferenceSource = stripComments(source);
  const explicitAnyPattern = /(?:\bas\s+any\b|:\s*any\b|:\s*any\[\]\b|<\s*any\b|,\s*any\b|\(\s*any\b|\bextends\s+any\b)/g;
  for (const match of stripped.matchAll(explicitAnyPattern)) {
    failures.push(`${rel(path)}:${lineForIndex(stripped, match.index ?? 0)} explicit any is not allowed in src`);
  }

  const privateMethodPattern = /\bprivate\s+(static\s+)?(?:async\s+)?([A-Za-z_]\w*)\s*\(/g;
  for (const match of stripped.matchAll(privateMethodPattern)) {
    const name = match[2];
    const receivers = ["this"];
    const className = nearestClassNameBefore(stripped, match.index ?? 0);
    if (className) receivers.push(className, ...classTypedAliases(privateReferenceSource, className));
    const receiverPattern = receivers.map(escapeRegExp).join("|");
    const memberReferencePattern = new RegExp(`\\b(?:${receiverPattern})\\s*\\.\\s*${escapeRegExp(name)}\\b`, "g");
    const references = privateReferenceSource.match(memberReferencePattern)?.length ?? 0;
    if (references === 0) {
      failures.push(`${rel(path)}:${lineForIndex(stripped, match.index ?? 0)} private method "${name}" appears unused`);
    }
  }
}

for (const path of collectFiles(join(srcDir, "commands"), (file) => /^goal-.*\.ts$/.test(basename(file)))) {
  const source = readFileSync(path, "utf8");
  if (source.includes("../tools/")) {
    failures.push(`${rel(path)} imports from tools; goal command/tool presentation should go through src/application/goal-view.ts`);
  }
}

const agentPrSource = readFileSync(join(srcDir, "tools", "agent-pr.ts"), "utf8");
for (const forbidden of ["redactSensitiveText", "validateGeneratedPrMetadata", "OPAQUE_TOKEN_MIN_LENGTH", "promptLeakFragments"]) {
  if (agentPrSource.includes(forbidden)) {
    failures.push(`src/tools/agent-pr.ts contains ${forbidden}; PR metadata safety belongs in src/worktree-pr-metadata.ts`);
  }
}

const notificationSource = readFileSync(join(srcDir, "session-notifications.ts"), "utf8");
if (
  notificationSource.includes("[SessionNotification]")
  && !notificationSource.includes("OPENCLAW_CODE_AGENT_NOTIFICATION_DIAGNOSTICS")
) {
  failures.push("src/session-notifications.ts writes notification diagnostics without the notification diagnostics gate");
}

// Hermetic tests: every test file must import tests/test-env.ts before anything
// else, so running a file directly (node --test, tsx, an IDE) can never resolve
// the real ~/.openclaw state. See docs/DEVELOPMENT.md "Test isolation".
const testEnvModule = join(testsDir, "test-env");
for (const path of testFiles.filter((file) => file.endsWith(".test.ts"))) {
  const source = stripComments(readFileSync(path, "utf8")).trimStart();
  let specifier = relative(dirname(path), testEnvModule).split(sep).join("/");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  const firstStatement = /^import\s*(["'])([^"']+)\1\s*;?/.exec(source);
  const imported = firstStatement?.[2]?.replace(/\.(?:ts|js|mjs)$/, "");
  if (imported !== specifier) {
    failures.push(`${rel(path)} must start with \`import "${specifier}";\` so tests never touch real OpenClaw state`);
  }
}

// Scripts (e2e/proof helpers) run outside the test harness, so they must not
// load OCA's state-owning modules (session/goal stores, output files). They
// may drive a harness directly, which keeps no plugin state.
const scriptsDir = join(root, "scripts");
const scriptFiles = collectFiles(scriptsDir, (path) => /\.(?:ts|mjs|js)$/.test(path) && !path.includes(`${sep}vendor${sep}`));
for (const path of scriptFiles) {
  const source = stripComments(readFileSync(path, "utf8"));
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\1/g)) {
    const specifier = match[2];
    if (!/(?:^|\/)src\//.test(specifier) || /(?:^|\/)src\/harness\//.test(specifier)) continue;
    failures.push(`${rel(path)} imports ${specifier}; scripts may import only src/harness/** so they never open OCA state stores`);
  }
}

// Tests create files only under the per-run temp dir from tests/test-env.ts
// (os.tmpdir() inside a test). A literal "/tmp/openclaw-" path would write to
// (or look like it writes to) the real /tmp; use tmpdir() or a /nonexistent/ path.
for (const path of testFiles) {
  const source = stripComments(readFileSync(path, "utf8"));
  for (const match of source.matchAll(/["'`]\/tmp\/openclaw-/g)) {
    failures.push(`${rel(path)}:${lineForIndex(source, match.index ?? 0)} literal "/tmp/openclaw-" path; build paths from tmpdir() (per-run temp dir) or use a /nonexistent/ placeholder`);
  }
}

for (const path of testFiles) {
  const source = readFileSync(path, "utf8");
  if (/SessionManager\[[^\]]*["'][A-Za-z0-9_]+["'][^\]]*\]/.test(source)) {
    failures.push(`${rel(path)} indexes SessionManager private API by string; prefer public service behavior tests`);
  }
}

// Privacy: the repository is public. Tests, docs, and fixtures use synthetic
// identifiers only. A Telegram chat id must be one of the fakes below, and
// token-shaped strings must be known fixture fakes (tests that check redaction
// need a token-shaped input). This list names fakes only; it never names a real
// value to look for.
const FAKE_TELEGRAM_CHAT_IDS = new Set([
  "-1001234567890",
  "-1009876543210",
]);
const FAKE_TOKEN_FIXTURES = new Set([
  "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
  "ghp_abcdefghijklmnopqrstuvwxyz123456",
  "sk-abcdefghijklmnopqrstuvwxyz123456",
  "sk-test-secret1234567890",
]);
const TELEGRAM_CHAT_ID_PATTERN = /(?<![\w-])-100\d{10}(?!\d)/g;
const TOKEN_PATTERNS = [
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ["OpenAI-style API key", /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{16,}/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g],
  ["private key block", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
  ["Telegram bot token", /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g],
];
// Home directories: only these synthetic (or CI / system) user names may appear
// in a /home/<user> or /Users/<user> path. A real account name in a path
// identifies a host; use /home/alice/... or /home/user/... in fixtures.
const FAKE_HOME_USERS = new Set(["user", "u", "me", "alice", "bob", "example", "runner", "linuxbrew"]);
const HOME_PATH_PATTERN = /(?<![\w.-])\/(?:home|Users)\/([A-Za-z0-9._-]+)/g;
// Telegram user ids (senders, direct chats) and Discord snowflakes (users,
// channels, guilds). Fixtures use the fakes below or an obviously synthetic
// number (at most four distinct digits, or an ascending 1234… run).
const FAKE_NUMERIC_IDS = new Set([
  "12345", "123456", "5551234", "123456789", "9988776655", "1111111111", "2222222222",
  "1234567890123456789", "998877665544332211", "1481999999999999999",
]);
function isSyntheticNumericId(value) {
  if (FAKE_NUMERIC_IDS.has(value)) return true;
  if (new Set(value).size <= 4) return true;
  return "12345678901234567890".startsWith(value);
}
const TELEGRAM_USER_ID_PATTERNS = [
  /\b(?:sender|user|from)_?id["']?\s*[:=]\s*["']?(\d{5,12})(?!\d)/gi,
  /\btelegram(?::(?:direct|dm|user|group):|\|(?:[\w-]+\|)?)(\d{5,12})(?!\d)/gi,
];
const DISCORD_SNOWFLAKE_PATTERN = /(?<![\w.-])(\d{17,20})(?![\d])/g;
// Generated or third-party files that are not written by hand.
const PRIVACY_SKIP = new Set(["npm-shrinkwrap.json", "pnpm-lock.yaml"]);
const PRIVACY_TEXT_FILE = /\.(?:[cm]?[jt]s|json|md|ya?ml|txt|sh|html)$/;
const privacyFiles = repositoryFiles
  ? repositoryFiles.filter((path) => PRIVACY_TEXT_FILE.test(path) && !PRIVACY_SKIP.has(rel(path)))
  : [
  ...collectFiles(srcDir, (path) => PRIVACY_TEXT_FILE.test(path)),
  ...collectFiles(testsDir, (path) => PRIVACY_TEXT_FILE.test(path)),
  ...collectFiles(join(root, "docs"), (path) => PRIVACY_TEXT_FILE.test(path)),
  ...collectFiles(scriptsDir, (path) => PRIVACY_TEXT_FILE.test(path)),
  ...collectFiles(join(root, "skills"), (path) => PRIVACY_TEXT_FILE.test(path)),
  ...collectFiles(join(root, ".github"), (path) => PRIVACY_TEXT_FILE.test(path)),
  ...["README.md", "CHANGELOG.md", "openclaw.plugin.json", "package.json"]
    .map((file) => join(root, file))
    .filter((path) => existsSync(path)),
];
for (const path of privacyFiles) {
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(TELEGRAM_CHAT_ID_PATTERN)) {
    if (FAKE_TELEGRAM_CHAT_IDS.has(match[0])) continue;
    failures.push(`${rel(path)}:${lineForIndex(source, match.index ?? 0)} Telegram chat id that is not a known fake; use -1001234567890 (see scripts/check-static-guardrails.mjs)`);
  }
  for (const [kind, pattern] of TOKEN_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (FAKE_TOKEN_FIXTURES.has(match[0])) continue;
      failures.push(`${rel(path)}:${lineForIndex(source, match.index ?? 0)} ${kind}-shaped string; use a fixture fake listed in scripts/check-static-guardrails.mjs`);
    }
  }
  if (rel(path) === "scripts/check-static-guardrails.mjs") continue;
  for (const match of source.matchAll(HOME_PATH_PATTERN)) {
    if (FAKE_HOME_USERS.has(match[1])) continue;
    failures.push(`${rel(path)}:${lineForIndex(source, match.index ?? 0)} home path of a real-looking account; use /home/alice/... (see scripts/check-static-guardrails.mjs)`);
  }
  for (const pattern of TELEGRAM_USER_ID_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (isSyntheticNumericId(match[1])) continue;
      failures.push(`${rel(path)}:${lineForIndex(source, match.index ?? 0)} Telegram user id that is not a known fake; use 123456789 (see scripts/check-static-guardrails.mjs)`);
    }
  }
  for (const match of source.matchAll(DISCORD_SNOWFLAKE_PATTERN)) {
    if (isSyntheticNumericId(match[1])) continue;
    failures.push(`${rel(path)}:${lineForIndex(source, match.index ?? 0)} Discord snowflake-shaped id that is not synthetic; use 111111111111111111 (see scripts/check-static-guardrails.mjs)`);
  }
}

// N4: OCA never runs an unqualified `git checkout <name>` (a name that is both
// a branch and a path is ambiguous, and a branch switch moves the user's
// checkout). Use `git switch` for branches and `git restore` for files.
for (const path of srcFiles) {
  const source = stripComments(readFileSync(path, "utf8"));
  for (const match of source.matchAll(/["'`]checkout["'`]/g)) {
    failures.push(`${rel(path)}:${lineForIndex(source, match.index ?? 0)} git "checkout" subcommand; use "switch" (branches) or "restore" (files)`);
  }
}

if (failures.length > 0) {
  console.error("Static guardrail check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Static guardrail check passed.");
