#!/usr/bin/env node
// OpenCode 2.0.29 protocol generator. No Effect dependency enters the plugin.
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "2.0.29";
const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const check = args.includes("--check");
const scratch = mkdtempSync(join(tmpdir(), "oca-opencode-protocol-"));
let child;
async function document() {
  const source = option("--source");
  if (source)
    return source.startsWith("http")
      ? await (await fetch(source)).json()
      : JSON.parse(readFileSync(source, "utf8"));
  const password = crypto.randomUUID();
  child = spawn(
    option("--opencode", "opencode2"),
    ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: scratch,
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        XDG_CONFIG_HOME: join(scratch, "config"),
        XDG_DATA_HOME: join(scratch, "data"),
        OPENCODE_DB: join(scratch, "opencode.db"),
        OPENCODE_PASSWORD: password,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const url = await new Promise((accept, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("OpenCode startup timed out")),
      60000,
    );
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("OpenCode exited during startup"));
    });
    child.stdout.on("data", (bytes) => {
      output += bytes.toString();
      for (const line of output.split("\n")) {
        try {
          const item = JSON.parse(line);
          if (item.url) {
            clearTimeout(timer);
            accept(item.url);
          }
        } catch {
          /* incomplete line */
        }
      }
    });
  });
  const headers = {
    Authorization:
      "Basic " + Buffer.from("opencode:" + password).toString("base64"),
  };
  const info = await (await fetch(url + "/api/info", { headers })).json();
  if ((info.data ?? info).version !== version)
    throw new Error(`Expected OpenCode ${version}`);
  const response = await fetch(url + "/openapi.json", { headers });
  if (!response.ok) throw new Error(`OpenAPI: HTTP ${response.status}`);
  return response.json();
}
const suffixes = [
  "",
  "/agent",
  "/model",
  "/prompt",
  "/synthetic",
  "/compact",
  "/interrupt",
  "/message",
  "/message/{messageID}",
  "/inbox",
  "/inbox/{inboxID}",
  "/permission",
  "/permission/{requestID}/reply",
  "/form",
  "/form/{formID}",
  "/form/{formID}/reply",
  "/fork",
  "/revert/stage",
  "/revert/commit",
];
const pathsWanted = new Set([
  "/api/event",
  "/api/info",
  "/api/model",
  "/api/session",
  "/api/session/active",
  ...suffixes.map((x) => "/api/session/{sessionID}" + x),
  "/api/experimental/session/{sessionID}/log",
  "/api/experimental/session/{sessionID}/instructions/entries/{key}",
]);
const name = (x) => "S_" + x.replaceAll(/[^a-zA-Z0-9_]/g, "_");
function ts(s) {
  if (s === false || (s?.not && Object.keys(s.not).length === 0))
    return "never";
  if (!s || s === true) return "unknown";
  if (s.$ref)
    return name(
      decodeURIComponent(s.$ref.split("/").at(-1))
        .replaceAll("~1", "/")
        .replaceAll("~0", "~"),
    );
  if (Object.hasOwn(s, "const")) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((x) => JSON.stringify(x)).join(" | ");
  if (s.anyOf || s.oneOf)
    return "(" + (s.anyOf ?? s.oneOf).map(ts).join(" | ") + ")";
  if (s.allOf) return "(" + s.allOf.map(ts).join(" & ") + ")";
  if (s.type === "array") return `Array<${ts(s.items)}>`;
  if (s.type === "object" || s.properties) {
    const fields = Object.entries(s.properties ?? {})
      .map(
        ([k, v]) =>
          `${JSON.stringify(k)}${s.required?.includes(k) ? "" : "?"}: ${ts(v)}`,
      )
      .join("; ");
    if (s.patternProperties && !fields)
      return `Record<string, ${Object.values(s.patternProperties).map(ts).join(" | ")}>`;
    return s.additionalProperties && !fields
      ? `Record<string, ${ts(s.additionalProperties)}>`
      : `{ ${fields} }`;
  }
  if (s.type === "integer" || s.type === "number") return "number";
  if (s.type === "null") return "null";
  if (["string", "boolean"].includes(s.type)) return s.type;
  return "unknown";
}
function emit(file, content) {
  const target = join(root, file);
  if (check) {
    if (readFileSync(target, "utf8") !== content)
      throw new Error(`${file} is stale; run pnpm sync:opencode-openapi`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
try {
  const doc = await document();
  const paths = Object.fromEntries(
    Object.entries(doc.paths).filter(([p]) => pathsWanted.has(p)),
  );
  for (const p of pathsWanted)
    if (!paths[p]) throw new Error(`Missing route ${p}`);
  const schemas = {};
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.$ref?.startsWith("#/components/schemas/")) {
      const k = node.$ref.slice(21);
      if (!schemas[k]) {
        schemas[k] = doc.components.schemas[k];
        if (!schemas[k]) throw new Error(`Missing ${k}`);
        visit(schemas[k]);
      }
    }
    Object.values(node).forEach(visit);
  };
  visit(paths);
  const banner = {
    "x-oca-source-version": version,
    "x-oca-comment":
      "GENERATED by scripts/sync-opencode-openapi.mjs. Source: anomalyco/opencode (MIT).",
  };
  emit(
    "tests/protocol/opencode-openapi.json",
    JSON.stringify(
      {
        ...banner,
        openapi: doc.openapi,
        info: doc.info,
        paths,
        components: { schemas },
      },
      null,
      2,
    ) + "\n",
  );
  const installed = option("--schema-dir");
  const modules = installed ?? scratch;
  if (!installed)
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        scratch,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `@opencode/schema@${version}`,
      ],
      { stdio: "inherit" },
    );
  const { Schema } = await import(
    pathToFileURL(join(modules, "node_modules/effect/dist/index.js"))
  );
  const manifest = await import(
    pathToFileURL(
      join(modules, "node_modules/@opencode/schema/dist/event-manifest.js"),
    )
  );
  const events = [...manifest.Latest.values()].filter((e) =>
    /^(session\.|permission\.|form\.|server\.connected|log\.)/.test(e.type),
  );
  const schemaDoc = Schema.toJsonSchemaDocument(Schema.Union(events));
  // The HTTP handler deliberately emits connected without created, unlike the
  // EventManifest definition. Source: packages/server/src/handlers/event.ts v2.0.29.
  schemaDoc.definitions["server.connected"].required = schemaDoc.definitions[
    "server.connected"
  ].required.filter((k) => k !== "created");
  const { EventLog } = await import(
    pathToFileURL(
      join(modules, "node_modules/@opencode/schema/dist/event-log.js"),
    )
  );
  const logDoc = Schema.toJsonSchemaDocument(EventLog.Synced);
  const logSchema = { ...logDoc.schema, $defs: logDoc.definitions };
  const eventSchema = {
    ...banner,
    ...schemaDoc.schema,
    $defs: schemaDoc.definitions,
    "x-oca-log-synced": logSchema,
  };
  emit(
    "tests/protocol/opencode-events.schema.json",
    JSON.stringify(eventSchema, null, 2) + "\n",
  );
  const header = `// GENERATED by scripts/sync-opencode-openapi.mjs. DO NOT EDIT.\n// x-oca-source-version: ${version}; anomalyco/opencode, MIT.\n`;
  const definitions = Object.entries(schemas)
    .map(([k, v]) => `export type ${name(k)} = ${ts(v)};`)
    .join("\n");
  const operations = Object.entries(paths)
    .flatMap(([p, methods]) =>
      Object.entries(methods)
        .filter(([m]) => ["get", "post", "put", "patch", "delete"].includes(m))
        .map(([m, o]) => {
          const request = o.requestBody?.content?.["application/json"]?.schema;
          const response = Object.entries(o.responses ?? {}).find(([s]) =>
            /^2/.test(s),
          )?.[1]?.content?.["application/json"]?.schema;
          return `${JSON.stringify(m.toUpperCase() + " " + p)}: { request: ${request ? ts(request) : "undefined"}; response: ${response ? ts(response) : "void"} }`;
        }),
    )
    .join(";\n");
  emit(
    "src/harness/opencode/protocol/api.ts",
    header +
      definitions +
      "\nexport interface Operations {\n" +
      operations +
      "\n}\n",
  );
  emit(
    "src/harness/opencode/protocol/events.ts",
    header +
      Object.entries(schemaDoc.definitions)
        .map(([k, v]) => `type ${name(k)} = ${ts(v)};`)
        .join("\n") +
      "\nexport type OpenCodeEvent = " +
      ts(schemaDoc.schema) +
      ";\n",
  );
  console.log(
    `OpenCode ${version} protocol ${check ? "matches" : "generated"}.`,
  );
} finally {
  child?.stdin.end();
  child?.kill("SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
}
