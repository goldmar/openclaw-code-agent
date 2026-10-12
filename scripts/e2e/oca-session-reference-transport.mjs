/**
 * Opt-in synthetic transport proof against the actual pinned host package.
 * Run: node --import tsx scripts/e2e/oca-session-reference-transport.mjs
 * Uses owned temporary state and a synthetic manager; no model, native backend,
 * production Gateway, channel, or credentials. Internal export discovery is
 * diagnostic and fails closed when the host stops exposing the tested surface.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(), "", "Transport proof requires a clean committed candidate");
const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const core = join(root, "node_modules", "openclaw");
const expectedHost = JSON.parse(readFileSync(join(root, "package.json"))).devDependencies.openclaw;
assert.equal(JSON.parse(readFileSync(join(core, "package.json"))).version, expectedHost);
const dist = join(core, "dist");
const scratch = mkdtempSync(join(tmpdir(), "oca-reference-transport-"));
for (const key of ["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) process.env[key] = scratch;
process.env.OPENCLAW_CONFIG_PATH = join(scratch, "absent-config.json");
const modules = {};

async function exported(name) {
  for (const file of readdirSync(dist).filter((file) => file.endsWith(".mjs"))) {
    const source = readFileSync(join(dist, file), "utf8");
    const match = source.slice(source.lastIndexOf("export {")).match(new RegExp("(?:\\{|,)\\s*" + name + " as (\\w+)"));
    if (!match) continue;
    modules[name] = { file, sha256: createHash("sha256").update(source).digest("hex") };
    const value = (await import(join(dist, file)))[match[1]];
    assert.equal(typeof value, "function", `Host export ${name} must be callable`);
    return value;
  }
  throw new Error(`Missing host export ${name}`);
}

let clearManager;
try {
  const create = await exported("createToolSearchTools");
  const refFactory = await exported("createToolSearchCatalogRef");
  const register = await exported("registerHeadlessToolSearchCatalog");
  const redact = await exported("redactTranscriptMessage");
  const { makeAgentRespondTool } = await import("../../src/tools/agent-respond.ts");
  const { setSessionManager } = await import("../../src/singletons.ts");
  clearManager = () => setSessionManager(null);
  const received = [], sends = [];
  const older = {
    id: "oca-older-target", name: "older", status: "running", startedAt: 1,
    currentPermissionMode: "default", autoRespondCount: 0, incrementAutoRespond() {},
    sendMessage: async (message) => { sends.push({ target: "older", message }); },
  };
  const newer = {
    ...older, id: "oca-newer-target", name: "newer", startedAt: 2,
    sendMessage: async (message) => { sends.push({ target: "newer", message }); },
  };
  setSessionManager({
    resolve: (ref) => ref === older.id ? older : ref === newer.id ? newer : undefined,
    getPersistedSession: () => undefined,
  });
  const target = makeAgentRespondTool();
  const capture = {
    ...target, label: "Synthetic OCA response",
    execute: async (id, input) => {
      received.push(structuredClone(input));
      return target.execute(id, input);
    },
  };
  const catalogRef = refFactory();
  register({ catalogRef, tools: [capture] });
  const control = create({ catalogRef, config: {} }).find((tool) => tool.name === "tool_call");
  assert.ok(control);
  for (const refs of [{ ocaSessionId: older.id }, { session: older.id }, { ocaSessionId: older.id, session: older.id }]) {
    const input = { ...refs, message: "SYNTHETIC_EXACT_REFERENCE", approve: false, userInitiated: false };
    const result = await control.execute("synthetic-call", { id: "agent_respond", args: input });
    assert.equal(result.details.result.isError, false, JSON.stringify(result));
    assert.deepEqual(received.at(-1), input);
    assert.deepEqual(sends.at(-1), { target: "older", message: input.message });
    const original = { role: "assistant", content: [{
      type: "toolCall", id: "synthetic", name: "tool_call", arguments: { id: "agent_respond", args: input },
    }] };
    const rendered = redact(original, {});
    assert.deepEqual(original.content[0].arguments.args, input);
    if ("ocaSessionId" in input) assert.equal(rendered.content[0].arguments.args.ocaSessionId, older.id);
    if ("session" in input) assert.equal(rendered.content[0].arguments.args.session, "***");
  }
  assert.equal(sends.length, 3);
  for (const input of [
    { ocaSessionId: older.id, session: newer.id, message: "REFUSE" },
    { ocaSessionId: "***", message: "REFUSE" },
    { ocaSessionId: "unknown-target", message: "REFUSE" },
  ]) {
    const result = await control.execute("synthetic-refusal", { id: "agent_respond", args: input });
    assert.equal((result.details?.result ?? result).isError, true, JSON.stringify(result));
    assert.equal(sends.length, 3);
  }
  console.log(JSON.stringify({
    candidateSha, host: expectedHost, modules, acceptedExactReferences: 3, refusedReferences: 3,
    newerSessionEffects: 0, legacyDisplayMasked: true, canonicalDisplayPreserved: true,
    originalAndDispatchedReferencesUnchanged: true,
    limits: "Published tool_call + synthetic OCA manager; no production Gateway, model, native backend or reporter-host reproduction.",
  }));
} finally {
  clearManager?.();
  rmSync(scratch, { recursive: true, force: true });
}
