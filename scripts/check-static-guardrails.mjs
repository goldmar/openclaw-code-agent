import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, join, relative, sep } from "path";

const root = process.cwd();
const srcDir = join(root, "src");
const testsDir = join(root, "tests");

function collectFiles(dir, predicate, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(path, predicate, acc);
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

for (const path of testFiles) {
  const source = readFileSync(path, "utf8");
  if (/SessionManager\[[^\]]*["'][A-Za-z0-9_]+["'][^\]]*\]/.test(source)) {
    failures.push(`${rel(path)} indexes SessionManager private API by string; prefer public service behavior tests`);
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
