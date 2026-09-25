#!/usr/bin/env node
// Regenerates the vendored Codex App Server protocol from the locally installed
// `codex` CLI:
//
// - src/harness/codex-app-server-protocol/: TypeScript wire types
//   (`codex app-server generate-ts --experimental`), only the transitive import
//   closure of ROOT_TYPES so the repository carries the protocol surface the
//   harness actually uses instead of the full ~870-file schema. Files are
//   copied byte-for-byte.
// - tests/protocol/codex-app-server.schema.json: JSON Schema
//   (`codex app-server generate-json-schema --experimental`) for the methods in
//   CLIENT_METHODS, SERVER_NOTIFICATIONS, and SERVER_REQUESTS plus the closure of
//   their definitions. Tests validate the frames the fake app server sends and
//   receives against it (tests/protocol-schema.ts).
//
// Usage: node scripts/sync-codex-protocol.mjs [--codex <bin>] [--check]
//
// Never edit the generated files by hand. `--check` fails when either vendored
// artifact differs from a fresh generation.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, posix } from "node:path";

const ROOT_TYPES = [
  "InitializeParams",
  "InitializeResponse",
  "ServerRequest",
  "CollaborationMode",
  "v2/ThreadStartParams",
  "v2/ThreadStartResponse",
  "v2/ThreadResumeParams",
  "v2/ThreadResumeResponse",
  "v2/ThreadForkParams",
  "v2/ThreadForkResponse",
  "v2/ThreadRevertParams",
  "v2/ThreadRevertResponse",
  "v2/ThreadTurnsListParams",
  "v2/ThreadTurnsListResponse",
  "v2/ThreadCompactStartParams",
  "v2/ThreadCompactStartResponse",
  "v2/TurnStartParams",
  "v2/TurnStartResponse",
  "v2/TurnSteerParams",
  "v2/TurnSteerResponse",
  "v2/TurnInterruptParams",
  "v2/TurnInterruptResponse",
  "v2/ReviewStartParams",
  "v2/ReviewStartResponse",
  "v2/ModelListParams",
  "v2/ModelListResponse",
  "v2/GetAccountParams",
  "v2/GetAccountResponse",
  "v2/GetAccountRateLimitsResponse",
  "v2/AccountRateLimitsUpdatedNotification",
  "v2/ThreadTokenUsageUpdatedNotification",
  "v2/ThreadSettingsUpdatedNotification",
  "v2/TurnStartedNotification",
  "v2/TurnCompletedNotification",
  "v2/ItemCompletedNotification",
  "v2/AgentMessageDeltaNotification",
  "v2/PlanDeltaNotification",
  "v2/TurnPlanUpdatedNotification",
  "v2/ModelReroutedNotification",
  "v2/ErrorNotification",
  "v2/ServerRequestResolvedNotification",
  "v2/CommandExecutionRequestApprovalResponse",
  "v2/FileChangeRequestApprovalResponse",
  "v2/PermissionsRequestApprovalResponse",
  "v2/ToolRequestUserInputResponse",
  "v2/McpServerElicitationRequestResponse",
  "v2/DynamicToolCallResponse",
];

// Client requests the harness sends (params and result are vendored).
const CLIENT_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/revert",
  "thread/turns/list",
  "thread/compact/start",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "review/start",
  "model/list",
  "account/read",
  "account/rateLimits/read",
];

// Server notifications the harness handles.
const SERVER_NOTIFICATIONS = [
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "serverRequest/resolved",
  "thread/tokenUsage/updated",
  "thread/settings/updated",
  "account/rateLimits/updated",
  "model/rerouted",
  "error",
];

// Server requests the harness answers (params and result are vendored).
const SERVER_REQUESTS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "item/tool/call",
  "mcpServer/elicitation/request",
  "account/chatgptAuthTokens/refresh",
  "currentTime/read",
];

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const targetRoot = join(repoRoot, "src", "harness", "codex-app-server-protocol");
const schemaTarget = join(repoRoot, "tests", "protocol", "codex-app-server.schema.json");

function parseArgs(argv) {
  const args = { codex: "codex", check: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--codex") args.codex = argv[++i];
    else if (argv[i] === "--check") args.check = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function importsOf(source, fromFile) {
  const out = [];
  for (const match of source.matchAll(/import type \{[^}]*\} from "([^"]+)";/g)) {
    const spec = match[1];
    out.push(posix.normalize(posix.join(posix.dirname(fromFile), spec)));
  }
  return out;
}

function collectClosure(generatedRoot) {
  const seen = new Set();
  const queue = [...ROOT_TYPES];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const file = join(generatedRoot, `${name}.ts`);
    if (!existsSync(file)) throw new Error(`Generated protocol is missing ${name}.ts`);
    seen.add(name);
    for (const dep of importsOf(readFileSync(file, "utf8"), name)) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return [...seen].sort();
}

function listFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) listFiles(path, acc);
    else acc.push(path);
  }
  return acc;
}

function buildTree(codexBin) {
  const version = execFileSync(codexBin, ["--version"], { encoding: "utf8" }).trim();
  const tmp = mkdtempSync(join(tmpdir(), "oca-codex-protocol-"));
  try {
    execFileSync(codexBin, ["app-server", "generate-ts", "--experimental", "--out", tmp], { stdio: "inherit" });
    const files = new Map();
    for (const name of collectClosure(tmp)) {
      files.set(`${name}.ts`, readFileSync(join(tmp, `${name}.ts`), "utf8"));
    }
    const rootExports = ROOT_TYPES
      .map((name) => `export type { ${name.split("/").pop()} } from "./${name}";`)
      .join("\n");
    files.set("index.ts", [
      "// GENERATED CODE! DO NOT MODIFY BY HAND!",
      `// Generated by scripts/sync-codex-protocol.mjs from \`${version}\``,
      "// (`codex app-server generate-ts --experimental`, import closure of the harness root types).",
      "",
      `export const CODEX_PROTOCOL_SOURCE_VERSION = ${JSON.stringify(version)};`,
      "",
      rootExports,
      "",
    ].join("\n"));
    return files;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function refTarget(ref) {
  const match = /^#\/definitions\/(?:(v2)\/)?([^/]+)$/.exec(ref);
  if (!match) throw new Error(`Unsupported $ref in Codex JSON Schema: ${ref}`);
  return { namespace: match[1], name: match[2] };
}

function firstRef(node) {
  if (!node || typeof node !== "object") return undefined;
  if (typeof node.$ref === "string") return node.$ref;
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    for (const entry of node[key] ?? []) {
      const found = firstRef(entry);
      if (found) return found;
    }
  }
  return undefined;
}

function variantsByMethod(union, unionName) {
  const byMethod = new Map();
  for (const variant of union?.oneOf ?? []) {
    const method = variant?.properties?.method?.enum?.[0];
    if (typeof method === "string") byMethod.set(method, variant);
  }
  if (byMethod.size === 0) throw new Error(`Codex JSON Schema has no ${unionName} variants`);
  return byMethod;
}

/**
 * Prune the generated schema bundle to the methods the harness uses. Refs keep
 * the bundle's `#/definitions/<Name>` and `#/definitions/v2/<Name>` layout.
 */
function buildSchema(codexBin, version) {
  const tmp = mkdtempSync(join(tmpdir(), "oca-codex-schema-"));
  try {
    execFileSync(codexBin, ["app-server", "generate-json-schema", "--experimental", "--out", tmp], { stdio: "inherit" });
    const bundle = JSON.parse(readFileSync(join(tmp, "codex_app_server_protocol.schemas.json"), "utf8"));
    const defs = bundle.definitions;
    const lookup = (ref) => {
      const { namespace, name } = refTarget(ref);
      return namespace ? defs.v2?.[name] : defs[name];
    };
    const responseRef = (paramsRef) => {
      const { namespace, name } = refTarget(paramsRef);
      const candidate = `#/definitions/${namespace ? `${namespace}/` : ""}${name.replace(/Params$/, "Response")}`;
      if (!lookup(candidate)) throw new Error(`Codex JSON Schema has no response for ${paramsRef}`);
      return candidate;
    };
    const pickMethods = (unionName, methods, withResult) => {
      const variants = variantsByMethod(defs[unionName], unionName);
      const out = {};
      for (const method of methods) {
        const variant = variants.get(method);
        if (!variant) throw new Error(`Codex JSON Schema ${unionName} has no ${method}`);
        const params = variant.properties.params ?? { type: "null" };
        const paramsRef = firstRef(params);
        const required = (variant.required ?? []).includes("params");
        out[method] = withResult
          ? { params, paramsRequired: required, result: { $ref: responseRef(paramsRef) } }
          : { params, paramsRequired: required };
      }
      return out;
    };
    const clientRequests = pickMethods("ClientRequest", CLIENT_METHODS, true);
    const serverNotifications = pickMethods("ServerNotification", SERVER_NOTIFICATIONS, false);
    const serverRequests = pickMethods("ServerRequest", SERVER_REQUESTS, true);

    const kept = { root: new Set(), v2: new Set() };
    const queue = [clientRequests, serverNotifications, serverRequests];
    while (queue.length > 0) {
      const node = queue.pop();
      if (Array.isArray(node)) { queue.push(...node); continue; }
      if (!node || typeof node !== "object") continue;
      if (typeof node.$ref === "string") {
        const { namespace, name } = refTarget(node.$ref);
        const set = namespace ? kept.v2 : kept.root;
        if (!set.has(name)) {
          const target = lookup(node.$ref);
          if (!target) throw new Error(`Codex JSON Schema is missing ${node.$ref}`);
          set.add(name);
          queue.push(target);
        }
      }
      for (const value of Object.values(node)) if (value && typeof value === "object") queue.push(value);
    }
    const sortedPick = (source, names) => Object.fromEntries([...names].sort().map((name) => [name, source[name]]));
    const document = {
      $comment: "GENERATED CODE! DO NOT MODIFY BY HAND! Generated by scripts/sync-codex-protocol.mjs (`codex app-server generate-json-schema --experimental`, pruned to the methods the harness uses).",
      $schema: "http://json-schema.org/draft-07/schema#",
      sourceVersion: version,
      clientRequests,
      serverNotifications,
      serverRequests,
      definitions: { ...sortedPick(defs, kept.root), v2: sortedPick(defs.v2, kept.v2) },
    };
    return `${JSON.stringify(document, null, 2)}\n`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const args = parseArgs(process.argv.slice(2));
const version = execFileSync(args.codex, ["--version"], { encoding: "utf8" }).trim();
const files = buildTree(args.codex);
const schema = buildSchema(args.codex, version);

if (args.check) {
  const existing = new Map(listFiles(targetRoot).map((path) => [relative(targetRoot, path), readFileSync(path, "utf8")]));
  const problems = [];
  for (const [path, content] of files) {
    if (!existing.has(path)) problems.push(`missing ${path}`);
    else if (existing.get(path) !== content) problems.push(`differs ${path}`);
  }
  for (const path of existing.keys()) if (!files.has(path)) problems.push(`extra ${path}`);
  const schemaPath = relative(repoRoot, schemaTarget);
  if (!existsSync(schemaTarget)) problems.push(`missing ${schemaPath}`);
  else if (readFileSync(schemaTarget, "utf8") !== schema) problems.push(`differs ${schemaPath}`);
  if (problems.length > 0) {
    console.error(`Vendored Codex protocol is stale (${problems.length} differences):\n${problems.slice(0, 40).join("\n")}`);
    process.exit(1);
  }
  console.log(`Vendored Codex protocol matches (${files.size} type files and the JSON Schema).`);
} else {
  rmSync(targetRoot, { recursive: true, force: true });
  for (const [path, content] of files) {
    const full = join(targetRoot, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  mkdirSync(dirname(schemaTarget), { recursive: true });
  writeFileSync(schemaTarget, schema);
  console.log(`Wrote ${files.size} files to ${relative(repoRoot, targetRoot)} and ${relative(repoRoot, schemaTarget)}`);
}
