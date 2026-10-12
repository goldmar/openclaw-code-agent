import "./test-env";
import { it } from "node:test";
import { makeAgentRespondTool } from "../src/tools/agent-respond";
import { setSessionManager } from "../src/singletons";
import type { SessionManager } from "../src/session-manager";
/**
 * Opt-in synthetic transport proof against the actual pinned host package.
 * Run: pnpm test:file tests/session-reference-transport.test.ts
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

type ProbeArgs = { ocaSessionId?: string; session?: string; message: string; approve?: boolean; userInitiated?: boolean };
type Transcript = { role: string; content: Array<{ type: string; id: string; name: string; arguments: { id: string; args: ProbeArgs } }> };
type HostControl = { name: string; execute: (id: string, input: unknown) => Promise<{ isError?: boolean; details?: { result?: { isError?: boolean } } }> };

it("published tool_call preserves exact OCA references independently of display redaction", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const candidateTrackedClean = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).trim() === "";
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const core = join(root, "node_modules", "openclaw");
  const expectedHost = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies.openclaw;
  assert.equal(JSON.parse(readFileSync(join(core, "package.json"), "utf8")).version, expectedHost);
  const dist = join(core, "dist");
  const scratch = mkdtempSync(join(tmpdir(), "oca-reference-transport-"));
  for (const key of ["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) process.env[key] = scratch;
  process.env.OPENCLAW_CONFIG_PATH = join(scratch, "absent-config.json");
  const modules: Record<string, { file: string; sha256: string }> = {};

  async function exported<T>(name: string): Promise<T> {
    for (const file of readdirSync(dist).filter((file) => file.endsWith(".mjs"))) {
      const source = readFileSync(join(dist, file), "utf8");
      const match = source.slice(source.lastIndexOf("export {")).match(new RegExp("(?:\\{|,)\\s*" + name + " as (\\w+)"));
      if (!match) continue;
      modules[name] = { file, sha256: createHash("sha256").update(source).digest("hex") };
      const value = (await import(join(dist, file)))[match[1]];
      assert.equal(typeof value, "function", `Host export ${name} must be callable`);
      return value as T;
    }
    throw new Error(`Missing host export ${name}`);
  }

  let clearManager: (() => void) | undefined;
  try {
    const create = await exported<(ctx: { catalogRef: unknown; config: object }) => HostControl[]>("createToolSearchTools");
    const refFactory = await exported<() => unknown>("createToolSearchCatalogRef");
    const register = await exported<(params: { catalogRef: unknown; tools: ReturnType<typeof makeAgentRespondTool>[] }) => void>("registerHeadlessToolSearchCatalog");
    const redact = await exported<(message: Transcript, config: object) => Transcript>("redactTranscriptMessage");
    clearManager = () => setSessionManager(null);
    const received: unknown[] = [], sends: Array<{ target: string; message: string }> = [];
    const older = {
      id: "oca-older-target", name: "older", status: "running", startedAt: 1,
      currentPermissionMode: "default", autoRespondCount: 0, incrementAutoRespond() {},
      sendMessage: async (message: string) => { sends.push({ target: "older", message }); },
    };
    const newer = {
      ...older, id: "oca-newer-target", name: "newer", startedAt: 2,
      sendMessage: async (message: string) => { sends.push({ target: "newer", message }); },
    };
    setSessionManager({
      resolve: (ref: string) => ref === older.id ? older : ref === newer.id ? newer : undefined,
      getPersistedSession: (): undefined => undefined,
    } as unknown as SessionManager); // The fake supplies only response-targeting methods; it owns no stores.
    const target = makeAgentRespondTool();
    const capture = {
      ...target, label: "Synthetic OCA response",
      execute: async (id: string, input: unknown) => {
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
      assert.equal(result.details?.result?.isError, false, JSON.stringify(result));
      assert.deepEqual(received.at(-1), input);
      assert.deepEqual(sends.at(-1), { target: "older", message: input.message });
      const original: Transcript = { role: "assistant", content: [{
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
      candidateSha, candidateTrackedClean, host: expectedHost, modules, acceptedExactReferences: 3, refusedReferences: 3,
      newerSessionEffects: 0, legacyDisplayMasked: true, canonicalDisplayPreserved: true,
      originalAndDispatchedReferencesUnchanged: true,
      limits: "Published tool_call + synthetic OCA manager; no production Gateway, model, native backend or reporter-host reproduction.",
    }));
  } finally {
    clearManager?.();
    rmSync(scratch, { recursive: true, force: true });
  }

});
