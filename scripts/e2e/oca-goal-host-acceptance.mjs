#!/usr/bin/env node
// Representative real Gateway/native goal flows. Retired channel/debug claims are UNPROVEN.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedOpenClawEnv, validatePackedPluginRuntime } from "../check-plugin-security.mjs";
import { responsesFixture } from "./oca501-native-protocol.mjs";
import { assignments, excluded, frameReceipt, HOST_PIN, sha, requiredFact } from "./oca501-evidence.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODEL = "gpt-6-luna", A = ["bash ci.sh", "bash lint.sh", "bash ci.sh"], B = ["bash changed.sh"];
const POLICY_FAILURES = [
  "Goal verification policy or repository identity changed. Start a new goal; stored required and additional checks are never replaced.",
];
const FIELD = "plugins.entries.openclaw-code-agent.config.goalVerificationPolicies";
const POLICY_ARRAY = `${FIELD}.repositories`;
// The pinned host may spend 60s draining admitted plugin work, plus cleanup/activation.
// Keep the patch RPC bounded below command()'s unchanged 120s process deadline.
export const CONFIG_PATCH_RPC_TIMEOUT_MS = 90_000;
const delay = ms => new Promise(done => setTimeout(done, ms));
const json = path => JSON.parse(readFileSync(path, "utf8"));
const inside = (root, path) => { const r = relative(root, path);
  return r && !r.startsWith("..") && !isAbsolute(r);
  };
/** Project only bounded acknowledgement facts; policy objects report changed child paths. */
export function patchAcknowledgementProof(ack, previousHash, requestedPaths) {
  const changedPaths = Array.isArray(ack?.changedPaths) ? Array.from(ack.changedPaths) : [];
  return {
    patchAckOk: ack?.ok === true,
    patchHashChanged: typeof previousHash === "string" && previousHash.length > 0
      && typeof ack?.hash === "string" && ack.hash.length > 0 && ack.hash !== previousHash,
    patchSelectedPathChanged: changedPaths.every(changed => typeof changed === "string" && changed.length > 0)
      && changedPaths.some(changed => requestedPaths.some(requested =>
      changed === requested || changed.startsWith(`${requested}.`))),
    patchNoRestart: ack?.sentinel?.payload?.stats?.requiresRestart === false,
  };
}
/** Preserve only fixed failure categories before a patch command can refuse. */
export function configPatchFailureProof(result) {
  let response;
  try { response = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))); } catch {}
  const parsed = !!response && typeof response === "object" && !Array.isArray(response);
  const code = parsed ? response.error?.code : undefined;
  const message = typeof response?.error?.message === "string" ? response.error.message : "";
  const errorCode = ["INVALID_REQUEST", "UNAVAILABLE", "CONFLICT", "RATE_LIMITED"].includes(code) ? code
    : parsed && !response.error && result.code === 0 ? "NONE" : "UNKNOWN";
  const errorType = ["gateway_request_error", "gateway_transport_error", "gateway_credentials_required", "cli_error"].includes(response?.error?.type)
    ? response.error.type : errorCode === "NONE" ? "NONE" : "UNKNOWN";
  const transportKind = errorType === "gateway_transport_error"
    ? ["timeout", "closed"].includes(response.error.kind) ? response.error.kind : "UNKNOWN" : "NONE";
  return {
    patchResponseParsed: parsed,
    patchErrorCode: errorCode,
    patchErrorType: errorType,
    patchTransportKind: transportKind,
    patchTransportTimeoutMs: transportKind === "timeout" && Number.isSafeInteger(response.error.timeoutMs)
      && response.error.timeoutMs > 0 && response.error.timeoutMs <= 120_000 ? response.error.timeoutMs : null,
    patchTransportCode: transportKind === "closed" && [1000, 1006, 1012].includes(response.error.code) ? response.error.code : null,
    patchArrayIntentDenied: errorCode === "INVALID_REQUEST" && message.includes("would remove entries from array path(s)"),
    patchRequiredCommandsSchemaDenied: errorCode === "INVALID_REQUEST" && /^invalid config(?::|$)/i.test(message)
      && message.includes("requiredCommands"),
    patchRateLimitDenied: /rate limit exceeded|rate-limited/i.test(message),
    patchBaseHashDenied: /base hash.*(?:required|mismatch)|config changed since/i.test(message),
  };
}
export function optionsFor(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(["--expected-sha", "--node-version", "--artifacts", "--scenario"].includes(args[i]) && !Object.hasOwn(options, args[i]));
    assert.ok(args[i + 1]);
    options[args[i]] = args[i + 1];
  }
  options["--scenario"] ??= "all";
  assert.ok(Object.hasOwn(assignments, options["--scenario"]));
  assert.match(options["--expected-sha"] ?? "", /^[a-f0-9]{40}$/);
  assert.ok(["24.16.0", "26.1.0"].includes(options["--node-version"]));
  assert.ok(isAbsolute(options["--artifacts"] ?? "") && !inside(ROOT, resolve(options["--artifacts"])) && resolve(options["--artifacts"]) !== ROOT);
  return options;
}
export async function until(probe, milliseconds = 90_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const value = await probe();
    if (value) return value;
    await delay(100);
    }
  throw new Error("REQUIRED_OBSERVATION_TIMEOUT");
}
export function visibleProof(result, history, requests, { runId, sessionId, sessionKey }) {
  assert.ok(runId && sessionId && sessionKey);
  assert.equal(result.runId, runId);
  assert.equal(result.status, "ok");
  assert.equal(result.terminalReply?.disposition, "visible");
  const text = result.terminalReply.text;
  assert.ok(typeof text === "string" && text.trim() && text.trim().toUpperCase() !== "NO_REPLY");
  for (const yielded of [result.yielded, result.terminalReply.yielded]) if (yielded !== undefined) { assert.equal(typeof yielded, "boolean");
    assert.equal(yielded, false);
    }
  assert.equal(history.sessionId, sessionId);
  assert.equal(history.sessionKey, sessionKey);
  assert.notEqual(history.truncated, true);
  const selected = history.messages.filter(m => m.role === "assistant" && m.__openclaw?.runId === runId);
  assert.equal(selected.length, 1);
  const record = selected[0];
  assert.notEqual(record.__openclaw?.truncated, true);
  const responseId = record.responseId;
  assert.ok(responseId);
  const matches = requests.filter(r => !r.native && r.completed && r.responseId === responseId);
  assert.equal(matches.length, 1);
  const canonical = (record.content ?? []).filter(c => c.type === "text" || c.type === "output_text").map(c => c.text).join("");
  assert.equal(canonical, text);
  assert.equal(text, matches[0].text);
  return { text, responseId };
}
export function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]), startTicks: fields[19], executable: readlinkSync(`/proc/${pid}/exe`) };
  } catch { return undefined;
    }
}
const childIdentities = new WeakMap(), childTargets = new WeakMap();
const sameProcess = (a, b) => Boolean(a && b && a.pid === b.pid && a.startTicks === b.startTicks && a.executable === b.executable);
export async function stopOwnedChild(child, { identity = childIdentities.get(child) ?? processIdentity(child.pid), graceMs = 30_000, killMs = 5000 } = {}) {
  const descendants = [], pending = sameProcess(identity, processIdentity(child.pid)) ? [identity.pid] : [];
  while (pending.length) {
    const parent = pending.pop();
    for (const name of readdirSync("/proc").filter(n => /^\d+$/.test(n))) {
      const current = processIdentity(Number(name));
      if (current?.parent === parent) { descendants.push(current); pending.push(current.pid); }
    }
  }
  if (identity && identity.group === identity.pid && (!processIdentity(identity.pid) || sameProcess(identity, processIdentity(identity.pid)))) {
    for (const name of readdirSync("/proc").filter(n => /^\d+$/.test(n))) {
      const current = processIdentity(Number(name));
      if (current?.group === identity.group && !descendants.some(p => p.pid === current.pid)) descendants.push(current);
    }
  }
  const targets = [...new Map([identity, ...descendants, ...(childTargets.get(child) ?? [])].filter(Boolean).map(p => [`${p.pid}:${p.startTicks}`, p])).values()];
  childTargets.set(child, targets);
  const alive = previous => { const current = processIdentity(previous.pid); return sameProcess(previous, current) && current.state !== "Z"; };
  const pipesClosed = () => [child.stdout, child.stderr].every(stream => !stream || stream.closed);
  const terminal = () => child.exitCode !== null || child.signalCode !== null || child.pid === undefined && pipesClosed();
  const complete = () => terminal() && targets.every(previous => !alive(previous)) && pipesClosed();
  const signal = sig => { for (const previous of targets) if (alive(previous)) { try { process.kill(previous.pid, sig); } catch {} } };
  if (identity && alive(identity)) { try { process.kill(identity.pid, "SIGTERM"); } catch {} }
  let graceful = true;
  try { await until(complete, graceMs); }
  catch {
    graceful = false; signal("SIGTERM");
    try { await until(complete, killMs); } catch { signal("SIGKILL"); }
    try { await until(complete, killMs); } catch {}
  }
  const stdioComplete = pipesClosed();
  if (!stdioComplete) { child.stdout?.destroy(); child.stderr?.destroy(); }
  return { complete: terminal() && targets.every(previous => !alive(previous)) && stdioComplete, graceful, stdioComplete,
    exitCode: child.exitCode, signal: child.signalCode, targets };
}
export function currentOwner(rows, listing, fixture, threadId, goal) {
  if (goal) {
    assert.equal(goal.name, fixture.name); assert.equal(goal.goal, fixture.intent.goal); assert.equal(goal.workdir, fixture.workdir);
    assert.equal(goal.loopMode, fixture.ralph ? "ralph" : "verifier"); assert.equal(goal.status, "running");
    assert.equal(goal.harnessSessionId, threadId); assert.ok(goal.sessionId && goal.sessionName);
    assert.ok(typeof goal.id === "string" && goal.id);
    if (fixture.goalId) assert.equal(goal.id, fixture.goalId);
    if (fixture.nativeSessionId) assert.equal(goal.sessionId, fixture.nativeSessionId);
  }
  const candidates = rows.filter(row => row.name === (goal?.sessionName ?? fixture.name) && row.workdir === fixture.workdir
    && row.backendRef?.conversationId === threadId && row.sessionId !== fixture.oldSessionId
    && (!goal || row.sessionId === goal.sessionId));
  assert.equal(candidates.length, 1, "Exactly one current native identity required");
  const row = candidates[0];
  if (goal && Object.hasOwn(row, "goalTaskId")) assert.equal(row.goalTaskId, goal.id);
  if (!goal) assert.equal(row.goalTaskId, undefined);
  const blocks = listing.split(/(?=^(?:🟡|🟢|✅|❌|⛔|📋|❓|🌿) [^\n]* \[[^\]\n]+\] — )/m).filter(block => block.startsWith(`🟢 ${row.name} [${row.sessionId}] — running · `));
  assert.equal(blocks.length, 1, "Exactly one current public native owner required");
  assert.ok(!blocks[0].includes("♻️ Recovered after a Gateway restart; no live process"));
  return row;
}
/** Compare only the registered goal and its actual replacement session, never a newest-row fallback. */
export function assertPolicyRestoreOwner(capability, goal, row, record) {
  const original = capability.original;
  assert.ok(["admitting", "admitted", "released"].includes(capability.phase));
  for (const field of ["id", "name", "goal", "workdir", "loopMode"]) assert.equal(goal[field], original[field]);
  assert.equal(goal.status, "running"); assert.equal(goal.iteration, original.iteration + 1);
  assert.deepEqual(goal.goalVerificationBinding, original.goalVerificationBinding);
  assert.deepEqual(goal.verifierCommands, original.verifierCommands);
  assert.equal(goal.harnessSessionId, original.harnessSessionId);
  assert.equal(record.threadId, original.harnessSessionId);
  assert.ok(typeof record.turnId === "string" && record.turnId);
  assert.notEqual(record.turnId, capability.originalTurn);
  if (capability.record) assert.equal(record, capability.record);
  assert.notEqual(goal.sessionId, original.sessionId);
  assert.equal(row.sessionId, goal.sessionId); assert.equal(row.name, goal.sessionName);
  assert.equal(row.goalTaskId, original.id); assert.equal(row.workdir, original.workdir);
  assert.equal(row.backendRef?.conversationId, original.harnessSessionId);
}
function tree(root) {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name); assert.ok(entry.isDirectory() || entry.isFile());
    return entry.isDirectory() ? Object.entries(tree(path)).map(([name, digest]) => [join(entry.name, name), digest]) : [[entry.name, sha(readFileSync(path))]];
  }));
}
export class FeatureRun {
  constructor(options) {
    this.options = options;
    this.stage = "identity";
    this.children = new Set();
    this.workdirs = [];
    this.raw = [];
    this.proofs = [];
    mkdirSync(options["--artifacts"], { recursive: true, mode: 0o700 });
    this.directory = mkdtempSync(join(options["--artifacts"], "oca501-host-"));
    this.env = createIsolatedOpenClawEnv(this.directory, { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC" });
    this.env.CODEX_HOME = join(this.directory, "codex");
    this.workspace = join(this.directory, "workspace");
    this.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH = join(this.directory, "sessions.json");
    this.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH = join(this.directory, "goals.json");
    for (const path of [this.workspace, this.env.CODEX_HOME, this.env.XDG_CACHE_HOME, this.env.XDG_DATA_HOME, this.env.XDG_STATE_HOME, this.env.XDG_CONFIG_HOME]) mkdirSync(path, { recursive: true, mode: 0o700 });
    this.keys = [randomBytes(24).toString("hex"), randomBytes(24).toString("hex")];
    this.receipt = { format: "oca-repo-goal-slim-v1", candidateSha: options["--expected-sha"], nodeVersion: options["--node-version"], hostVersion: "2026.9.8", hostCommit: HOST_PIN, nativeVersion: "0.160.0", scenario: options["--scenario"], assigned: assignments[options["--scenario"]], completed: [], disposition: "BLOCKED", complete: true, failure: null, cleanup: { complete: false, failures: [] }, excluded: this.raw, proofs: this.proofs, retiredHostClaims: ["Telegram/slash/callback interoperability", "idle/fork/pending native windows", "custody drain fence", "unprivileged archive EACCES", "debug producer/schema attribution", "late ABA generation pairing"] };
  }
  async command(program, args, { allowFailure = false, timeoutMs = 120_000, graceMs = 30_000, killMs = 5000, cwd = ROOT } = {}) {
    const child = spawn(program, args, { cwd, env: this.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.children.add(child);
    childIdentities.set(child, processIdentity(child.pid));
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), timedOut = false;
    child.stdout.on("data", bytes => { stdout = Buffer.concat([stdout, bytes]); });
    child.stderr.on("data", bytes => { stderr = Buffer.concat([stderr, bytes]); });
    let spawnError = false;
    child.once("error", () => { spawnError = true; });
    const identity = processIdentity(child.pid);
    let code;
    try {
      await until(() => spawnError || (child.exitCode !== null || child.signalCode !== null) && child.stdout.closed && child.stderr.closed, timeoutMs);
      code = child.exitCode;
    } catch { timedOut = true; }
    let cleanup;
    if (timedOut || spawnError) cleanup = await stopOwnedChild(child, { identity, graceMs, killMs });
    if (!cleanup || cleanup.complete) this.children.delete(child);
    const commandId = this.raw.length;
    this.raw.push(excluded(`command-${commandId}.stdout`, stdout), excluded(`command-${commandId}.stderr`, stderr));
    this.proofs.push({ commandId, exitCode: child.exitCode, signal: child.signalCode, timedOut, stdioComplete: cleanup?.stdioComplete ?? true });
    assert.equal(spawnError, false, "COMMAND_SPAWN_FAILED");
    assert.equal(timedOut, false, "COMMAND_TIMEOUT");
    if (!allowFailure) assert.equal(code, 0);
    return { code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") };
  }
  async cli(args, options) {
    if (args[0] !== "gateway" || args[1] !== "call" || args[2] !== "config.patch") {
      return this.command(process.execPath, [this.hostEntry, ...args], options);
    }
    const result = await this.command(process.execPath, [this.hostEntry, ...args, "--timeout", String(CONFIG_PATCH_RPC_TIMEOUT_MS)], { ...options, allowFailure: true });
    this.proofs.push(configPatchFailureProof(result));
    if (!options?.allowFailure) assert.equal(result.code, 0, "CONFIG_PATCH_EXIT_REQUIRED");
    return result;
  }
  async rpc(method, params = {}) {
    this.proofs.push({ rpcMethod: method });
    const result = await this.cli(["gateway", "call", method, "--params", JSON.stringify(params), "--json"]);
    return JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  }
  async invoke(name, args, accepted = true) {
    const result = await fetch(`${this.url}/tools/invoke`, { method: "POST", headers: { authorization: `Bearer ${this.keys[0]}`, "content-type": "application/json", "x-openclaw-message-channel": "webchat", "x-openclaw-message-to": this.sessionKey }, body: JSON.stringify({ name, args, sessionKey: this.sessionKey }), signal: AbortSignal.timeout(90_000) });
    const output = await result.json();
    this.proofs.push({ invokedTool: name, httpStatus: result.status, toolError: output.result?.isError === true });
    assert.equal(result.status, 200);
    assert.equal(output.ok, true);
    assert.equal(output.result?.isError === true, !accepted);
    return output.result;
  }
  goals() { return existsSync(this.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH) ? json(this.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH) : [];
    }
  sessions() { return existsSync(this.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH) ? json(this.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH).sessions : [];
    }
  effects() { return { goals: this.goals().map(g => g.id).sort(), sessions: this.sessions().map(s => s.sessionId).sort(), nativeRequests: this.fixture.requests.filter(r => r.native).length, checks: this.workdirs.map(path => existsSync(join(path, "checks.jsonl")) ? sha(readFileSync(join(path, "checks.jsonl"))) : null) };
    }
  async setup() {
    assert.equal(process.versions.node, this.receipt.nodeVersion);
    assert.equal(process.platform, "linux");
    assert.equal(process.arch, "x64");
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), this.receipt.candidateSha);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim(), "");
    this.proofs.push({ sourceArchiveSha256: sha(execFileSync("git", ["archive", "HEAD"], { cwd: ROOT, maxBuffer: 50_000_000 })) });
    this.stage = "acquisition";
    const hostRoot = realpathSync(join(ROOT, "node_modules/openclaw"));
    assert.equal(json(join(hostRoot, "package.json")).version, this.receipt.hostVersion);
    this.hostEntry = join(hostRoot, "openclaw.mjs");
    const tagResponse = await fetch("https://api.github.com/repos/openclaw/openclaw/git/ref/tags/v2026.9.8", { signal: AbortSignal.timeout(30_000) });
    assert.equal(tagResponse.status, 200);
    let object = (await tagResponse.json()).object;
    if (object.type === "tag") { const tag = await fetch(object.url, { signal: AbortSignal.timeout(30_000) });
      assert.equal(tag.status, 200);
      object = (await tag.json()).object;
      }
    assert.equal(object.type, "commit");
    assert.equal(object.sha, HOST_PIN);
    const validatorExport = json(join(hostRoot, "package.json")).exports["./plugin-sdk/json-schema-runtime"].default;
    assert.equal(validatorExport, "./dist/plugin-sdk/json-schema-runtime.js");
    const validator = await import(join(hostRoot, validatorExport));
    assert.equal(typeof validator.validateJsonSchemaValue, "function");
    await this.command("npm", ["install", "--prefix", join(this.directory, "native"), "--no-audit", "--no-fund", "@openai/codex@0.160.0"]);
    this.native = realpathSync(join(this.directory, "native/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"));
    assert.equal((await this.command(this.native, ["--version"])).stdout.trim(), "codex-cli 0.160.0");
    this.env.OPENCLAW_CODEX_APP_SERVER_COMMAND = this.native;
    this.fixture = await responsesFixture({ root: this.workspace, model: MODEL, key: this.keys[1], validate: validator.validateJsonSchemaValue, observeNative: (fixture, record) => this.nativeOwner(fixture, record), observeNativeRestore: (fixture, record) => this.nativePolicyRestore(fixture, record) });
    const nativeConfig = `model = "${MODEL}"\nmodel_provider = "oca501"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[model_providers.oca501]\nname = "OCA501 loopback fixture"\nbase_url = "${this.fixture.url}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
    writeFileSync(join(this.env.CODEX_HOME, "config.toml"), nativeConfig, { mode: 0o600 });
    mkdirSync(join(this.directory, ".codex"));
    writeFileSync(join(this.directory, ".codex/config.toml"), nativeConfig, { mode: 0o600 });
    await this.command("pnpm", ["pack", "--json", "--pack-destination", this.directory]);
    const tarballs = readdirSync(this.directory).filter(name => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    const tarball = join(this.directory, tarballs[0]);
    const unpacked = join(this.directory, "unpacked");
    mkdirSync(unpacked);
    await this.command("tar", ["-xzf", tarball, "-C", unpacked]);
    this.packedTree = tree(join(unpacked, "package/dist"));
    this.expectedTools = json(join(ROOT, "openclaw.plugin.json")).contracts.tools.filter(name => name !== "agent_send_plan_offer");
    const reservation = createServer();
    await new Promise(done => reservation.listen(0, "127.0.0.1", done));
    this.port = reservation.address().port;
    await new Promise(done => reservation.close(done));
    this.url = `http://127.0.0.1:${this.port}`;
    this.env.OPENCLAW_GATEWAY_PORT = String(this.port);
    this.repoA = this.workspace;
    this.repoB = join(this.workspace, "repository-b");
    await this.createRepository(this.repoA); await this.createRepository(this.repoB);
    this.currentPolicies = this.repoPolicies();
    const config = { gateway: { mode: "local", bind: "loopback", port: this.port, auth: { mode: "token", token: this.keys[0] }, reload: { mode: "hybrid" } }, logging: { file: join(this.directory, "runtime.log") },
      models: { mode: "replace", catalogRefresh: { enabled: false }, providers: { oca501: { baseUrl: `${this.fixture.url}/host/v1`, api: "openai-responses", auth: "api-key", apiKey: this.keys[1], request: { allowPrivateNetwork: true }, models: [{ id: MODEL, name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 }] } } },
      agents: { defaults: { workspace: this.workspace, model: { primary: `oca501/${MODEL}`, fallbacks: [] }, modelPolicy: { allow: [`oca501/${MODEL}`] }, utilityModel: `oca501/${MODEL}`, decisionModel: "", experimental: { decisionAssistance: false }, thinkingDefault: "off", heartbeat: { every: "0m" }, embeddedAgent: { cyberFailover: { mode: "off" } }, compaction: { enabled: false, memoryFlush: { enabled: false }, postIndexSync: "off" } } },
      memory: { search: { enabled: false } }, cron: { enabled: false }, discovery: { mdns: { mode: "off" } }, tools: { profile: "full", allow: this.expectedTools, deny: ["agent_goal"] },
      plugins: { allow: ["openclaw-code-agent"], slots: { memory: "none" }, entries: { "openclaw-code-agent": { enabled: true, config: { autoUpdate: false, defaultHarness: "codex", defaultWorktreeStrategy: "off", permissionMode: "bypassPermissions", goalVerificationPolicies: this.currentPolicies, trustedVerifierCommands: ["true", "bash ci.sh", "bash extra-a.sh", "bash extra-b.sh", "bash extra-fail.sh"], harnesses: { codex: { defaultModel: MODEL, allowedModels: [MODEL] } } } } } } };
    writeFileSync(this.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });
    const bin = join(this.directory, "bin");
    mkdirSync(bin);
    symlinkSync(this.hostEntry, join(bin, "openclaw"));
    this.env.PATH = `${bin}:${dirname(process.execPath)}:${this.env.PATH}`;
    assert.equal((await this.command("node", ["--version"])).stdout.trim(), `v${this.receipt.nodeVersion}`);
    await this.cli(["plugins", "install", tarball, "--force", "--accept-capabilities"]);
    await this.cli(["plugins", "enable", "openclaw-code-agent"]);
    this.installed = join(this.env.OPENCLAW_STATE_DIR, "extensions/openclaw-code-agent");
    assert.deepEqual(tree(join(this.installed, "dist")), this.packedTree);
    assert.equal(sha(readFileSync(join(this.installed, "openclaw.plugin.json"))), sha(readFileSync(join(unpacked, "package/openclaw.plugin.json"))));
    validatePackedPluginRuntime(JSON.parse((await this.cli(["plugins", "inspect", "openclaw-code-agent", "--runtime", "--json"])).stdout), json(join(ROOT, "package.json")).version, this.expectedTools);
    this.proofs.push({ hostEntrySha256: sha(readFileSync(this.hostEntry)), nativeExecutableSha256: sha(readFileSync(this.native)), packedSha256: sha(readFileSync(tarball)), installedEntrySha256: sha(readFileSync(join(this.installed, "dist/index.js"))) });
    await this.start();
    this.stage = "host-admission";
    const created = await this.rpc("sessions.create", { key: "agent:main:main", agentId: "main" });
    assert.equal(created.ok, true);
    assert.equal(created.runStarted, false);
    this.sessionKey = created.key;
    this.parentId = created.sessionId;
    const inventory = await this.rpc("tools.effective", { sessionKey: this.sessionKey });
    const entries = inventory.groups.flatMap(group => group.tools);
    assert.equal(entries.some(entry => entry.id === "agent_goal"), false);
    const before = this.effects();
    const denied = await fetch(`${this.url}/tools/invoke`, { method: "POST", headers: { authorization: `Bearer ${this.keys[0]}`, "content-type": "application/json" }, body: JSON.stringify({ name: "agent_goal", args: { action: "launch", goal: "Denied" }, sessionKey: this.sessionKey }) });
    assert.equal(denied.status, 404);
    assert.deepEqual(this.effects(), before);
    await this.patch({ tools: { deny: null } }, ["tools.deny"]);
    const enabled = (await this.rpc("tools.effective", { sessionKey: this.sessionKey })).groups.flatMap(group => group.tools).filter(entry => entry.pluginId === "openclaw-code-agent" && !entry.deniedBySession);
    assert.deepEqual(enabled.map(entry => entry.id).sort(), [...this.expectedTools].sort());
    const modelSession = (await this.rpc("sessions.list", { agentId: "main", limit: 10 })).sessions.find(s => s.key === this.sessionKey);
    assert.equal(modelSession.sessionId, this.parentId);
    assert.equal(modelSession.modelProvider, "oca501");
    assert.equal(modelSession.model, MODEL);
    this.stage = "parent-proof";
    const parentEffects = this.effects();
    const admitted = await this.rpc("chat.send", { sessionKey: this.sessionKey, message: "Reply with a harmless receipt. Use no tools.", deliver: false, idempotencyKey: randomBytes(12).toString("hex") });
    await this.visible(admitted.runId);
    assert.deepEqual(this.effects(), parentEffects);
    this.stage = "ordinary-native-proof";
    const ordinary = this.newCase("setup");
    ordinary.intent = { kind: "ordinary", prompt: `${ordinary.tag}: Run the harmless receipt command.` };
    await this.invoke("agent_launch", { name: ordinary.name, prompt: ordinary.intent.prompt, workdir: ordinary.workdir, harness: "codex", permission_mode: "bypassPermissions", worktree_strategy: "off" });
    await until(() => ordinary.executed);
    const owners = new Set(this.fixture.requests.filter(r => r.native && r.case === ordinary.tag && r.turnId === ordinary.turnId).map(r => r.owner?.sessionId));
    assert.equal(owners.size, 1); const owner = [...owners][0]; assert.ok(owner);
    const row = await until(() => this.sessions().find(s => s.sessionId === owner && s.status === "completed"));
    await this.publicOwner(owner, "completed", ordinary);
    await this.completion(row, true);
    this.proofs.push({ setupOnly: true, nativeThreadId: ordinary.threadId, nativeReceiptSha256: sha(readFileSync(join(ordinary.workdir, "native-receipt.txt"))), parentProof: true });
  }
  nativeProcesses(gateway = this.gatewayIdentity) {
    if (gateway) {
      assert.ok(sameProcess(gateway, processIdentity(gateway.pid)));
      assert.equal(readlinkSync(`/proc/${gateway.pid}/cwd`), this.workspace);
    }
    const native = [];
    for (const name of readdirSync("/proc").filter(n => /^\d+$/.test(n))) {
      if (Number(name) === gateway?.pid) continue;
      if (gateway) {
        let ancestor = Number(name);
        try {
          while (ancestor && ancestor !== gateway.pid) {
            const stat = readFileSync(`/proc/${ancestor}/stat`, "utf8");
            ancestor = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
          }
        } catch (error) {
          if (["ENOENT", "ESRCH"].includes(error.code)) continue;
          throw new Error("NATIVE_PROCESS_ANCESTRY_UNAVAILABLE");
        }
        if (ancestor !== gateway.pid) continue;
      }
      let executable;
      try { executable = readlinkSync(`/proc/${name}/exe`); }
      catch (error) {
        if (["ENOENT", "ESRCH"].includes(error.code) || !gateway && error.code === "EACCES") continue;
        throw new Error("NATIVE_PROCESS_IDENTITY_UNAVAILABLE");
      }
      if (executable !== this.native) continue;
      const current = processIdentity(Number(name));
      assert.ok(current, "NATIVE_PROCESS_IDENTITY_UNAVAILABLE");
      if (current.state === "Z") continue;
      if (gateway) assert.equal(readlinkSync(`/proc/${name}/cwd`), this.workspace);
      native.push(current);
    }
    if (gateway) assert.ok(sameProcess(gateway, processIdentity(gateway.pid)));
    return native;
  }
  async nativeOwner(fixture, record) {
    await until(() => this.gatewayReady);
    const goal = fixture.intent.kind === "ordinary" ? undefined : await until(() => {
      const matches = this.goals().filter(g => g.name === fixture.name || fixture.goalId && g.id === fixture.goalId);
      assert.ok(matches.length <= 1); if (!matches.length) return false;
      const task = matches[0];
      assert.equal(task.name, fixture.name); assert.equal(task.goal, fixture.intent.goal);
      assert.equal(task.workdir, fixture.workdir); assert.equal(task.loopMode, fixture.ralph ? "ralph" : "verifier");
      assert.ok(["waiting_for_session", "running"].includes(task.status));
      assert.ok(typeof task.id === "string" && task.id.trim());
      if (fixture.goalId) assert.equal(task.id, fixture.goalId); else fixture.goalId = task.id;
      const fields = ["sessionId", "sessionName", "harnessSessionId"];
      for (const field of fields) if (task[field] !== undefined) assert.ok(typeof task[field] === "string" && task[field].trim());
      if (task.harnessSessionId !== undefined) assert.equal(task.harnessSessionId, record.threadId);
      if (fixture.nativeSessionId && task.sessionId !== undefined) assert.equal(task.sessionId, fixture.nativeSessionId);
      if (fixture.nativeSessionName && task.sessionName !== undefined) assert.equal(task.sessionName, fixture.nativeSessionName);
      if (task.sessionId === fixture.oldSessionId && fixture.intent.kind === "restore") {
        if (task.sessionName !== undefined) assert.equal(task.sessionName, fixture.oldSessionName);
        return false;
      }
      if (fields.some(field => task[field] === undefined)) return false;
      assert.equal(task.status, "running");
      return task;
    });
    const listing = await this.invoke("agent_sessions", { status: "running", full: true });
    const row = currentOwner(this.sessions(), listing.content.map(c => c.text ?? "").join("\n"), fixture, record.threadId, goal);
    await this.publicOwner(row.sessionId, "running");
    assert.ok(sameProcess(fixture.nativeSnapshot?.gateway, this.gatewayIdentity));
    const census = this.nativeProcesses();
    const native = fixture.nativeProcess ? census.filter(p => sameProcess(p, fixture.nativeProcess))
      : census.filter(p => !fixture.nativeSnapshot.processes.some(previous => sameProcess(p, previous)));
    assert.equal(native.length, 1);
    fixture.nativeProcess ??= native[0];
    fixture.nativeSessionId ??= row.sessionId; fixture.nativeSessionName ??= row.name;
    return { sessionId: row.sessionId, nativeProcess: native[0] };
  }
  policyRestoreOwner(fixture, record) {
    const capability = fixture.policyRestore;
    const goal = this.goals().find(g => g.id === capability.original.id);
    assert.ok(goal);
    const row = this.sessions().find(s => s.sessionId === goal.sessionId);
    assert.ok(row);
    assertPolicyRestoreOwner(capability, goal, row, record);
    assert.equal(readFileSync(join(fixture.workdir, "native-receipt.txt"), "utf8"), "NATIVE-EXEC\n");
    assert.ok(sameProcess(capability.gateway, this.gatewayIdentity));
    return goal;
  }
  registerPolicyRestore(fixture, goal, check) {
    assert.equal(fixture.policyRestore, undefined);
    assert.equal(fixture.executed, true); assert.ok(fixture.call && fixture.nativeProcess);
    const original = structuredClone(this.goals().find(g => g.id === goal.id));
    assert.equal(original.status, "running"); assert.equal(original.goalVerificationBinding?.version, 1);
    assert.equal(original.sessionId, fixture.nativeSessionId); assert.equal(original.harnessSessionId, fixture.threadId);
    assert.ok(sameProcess(check, processIdentity(check.pid)));
    const capability = { phase: "registered", original, originalTurn: fixture.turnId, originalExecutionComplete: true,
      originalNative: fixture.nativeProcess, gateway: this.gatewayIdentity, check };
    capability.drained = new Promise(resolve => { capability.release = resolve; });
    capability.revalidate = async record => {
      this.policyRestoreOwner(fixture, record);
      assert.equal(capability.phase, "released");
      assert.ok(!sameProcess(check, processIdentity(check.pid)), "The retired admitted check must drain before restored work");
      await this.nativeOwner(fixture, record);
      this.policyRestoreOwner(fixture, record);
      return () => {
        assert.equal(fixture.policyRestore, capability);
        assert.equal(capability.phase, "released");
        const current = this.policyRestoreOwner(fixture, record);
        assert.equal(current.sessionId, record.owner.sessionId);
        assert.equal(current.sessionId, fixture.nativeSessionId);
        assert.ok(!sameProcess(check, processIdentity(check.pid)));
        assert.ok(sameProcess(record.owner.nativeProcess, fixture.nativeProcess));
        assert.ok(sameProcess(fixture.nativeProcess, processIdentity(fixture.nativeProcess.pid)));
        assert.ok(sameProcess(capability.gateway, processIdentity(this.gateway.pid)));
      };
    };
    fixture.policyRestore = capability;
    return capability;
  }
  async nativePolicyRestore(fixture, record) {
    const capability = fixture.policyRestore;
    assert.equal(capability.phase, "admitting");
    await until(() => {
      const goal = this.goals().find(g => g.id === capability.original.id);
      return goal?.status === "running" && goal.sessionId && goal.sessionId !== capability.original.sessionId;
    });
    this.policyRestoreOwner(fixture, record);
    const previous = processIdentity(capability.originalNative.pid);
    assert.ok(!sameProcess(capability.originalNative, previous) || previous.state === "Z");
    fixture.oldSessionId = capability.original.sessionId;
    fixture.nativeSnapshot = { gateway: this.gatewayIdentity, processes: [...fixture.nativeSnapshot.processes, capability.originalNative] };
    fixture.nativeProcess = undefined; fixture.nativeSessionId = undefined; fixture.nativeSessionName = undefined;
  }
  async drainPolicyRestore(fixture) {
    const capability = fixture.policyRestore;
    assert.ok(["registered", "admitting", "admitted"].includes(capability?.phase));
    await until(() => capability.phase === "admitted" && capability.record?.owner);
    this.policyRestoreOwner(fixture, capability.record);
    assert.ok(sameProcess(capability.check, processIdentity(capability.check.pid)), "The original admitted check survives the B reload");
    writeFileSync(join(fixture.workdir, "release"), "release\n");
    await until(() => !sameProcess(capability.check, processIdentity(capability.check.pid)));
    const checks = readFileSync(join(fixture.workdir, "checks.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(checks, [{ ordinal: 1, kind: "CI", exit: 0 }]);
    this.policyRestoreOwner(fixture, capability.record);
    capability.phase = "released"; capability.release();
  }
  async start() {
    this.stage = "gateway-start";
    assert.deepEqual(tree(join(this.installed, "dist")), this.packedTree);
    const child = spawn(process.execPath, [this.hostEntry, "gateway", "run", "--bind", "loopback", "--port", String(this.port)], { cwd: this.workspace, env: this.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.gateway = child;
    this.gatewayReady = false;
    this.gatewayIdentity = undefined;
    this.children.add(child);
    childIdentities.set(child, processIdentity(child.pid));
    const buffers = { stdout: [], stderr: [] };
    child.stdout.on("data", data => buffers.stdout.push(data));
    child.stderr.on("data", data => buffers.stderr.push(data));
    child.once("close", () => { for (const [name, chunks] of Object.entries(buffers)) this.raw.push(excluded(`gateway-${this.raw.length}.${name}`, Buffer.concat(chunks))); });
    this.gatewayIdentity = processIdentity(child.pid);
    assert.ok(this.gatewayIdentity);
    assert.equal(readlinkSync(`/proc/${child.pid}/cwd`), this.workspace);
    for (const fixture of this.fixture.cases.values()) if (fixture.nativeSnapshot && !fixture.nativeSnapshot.gateway) {
      assert.equal(fixture.intent.kind, "restore");
      assert.equal(fixture.nativeSnapshot.processes.length, 0);
      fixture.nativeSnapshot.gateway = this.gatewayIdentity;
    }
    await until(async () => { assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); try { return (await fetch(`${this.url}/readyz`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } });
    this.gatewayReady = true;
    assert.ok(sameProcess(this.gatewayIdentity, processIdentity(child.pid)));
    assert.equal(realpathSync(this.gatewayIdentity.executable), realpathSync(process.execPath));
    const cfg = await this.rpc("config.get");
    assert.equal(cfg.valid, true);
    assert.equal(cfg.config.models.providers.oca501.baseUrl, `${this.fixture.url}/host/v1`);
    this.proofs.push({ gateway: this.gatewayIdentity, appliedRevision: cfg.appliedConfigHash, configRevision: cfg.configRevisionHash });
  }
  async patch(fields, paths) {
    const before = await this.rpc("config.get"), identity = this.gatewayIdentity;
    const ack = await this.rpc("config.patch", { raw: JSON.stringify(fields), baseHash: before.hash, replacePaths: paths });
    const acknowledgement = patchAcknowledgementProof(ack, before.hash, paths);
    this.proofs.push(acknowledgement);
    assert.equal(acknowledgement.patchAckOk, true, "PATCH_ACK_OK_REQUIRED");
    assert.equal(acknowledgement.patchHashChanged, true, "PATCH_ACK_HASH_CHANGE_REQUIRED");
    assert.equal(acknowledgement.patchSelectedPathChanged, true, "PATCH_ACK_SELECTED_PATH_REQUIRED");
    assert.equal(acknowledgement.patchNoRestart, true, "PATCH_ACK_NO_RESTART_REQUIRED");
    const after = await this.rpc("config.get");
    assert.equal(after.valid, true);
    assert.equal(after.hash, ack.hash);
    assert.equal(after.configRevisionHash, after.appliedConfigHash);
    assert.ok(after.appliedConfigHash);
    assert.ok(sameProcess(identity, processIdentity(this.gateway.pid)));
    this.proofs.push({ mutation: paths, beforeRevision: before.hash, afterRevision: ack.hash, appliedRevision: after.appliedConfigHash });
    return after;
  }
  async createRepository(path) {
    mkdirSync(path, { recursive: true });
    await this.command("git", ["init", "-b", "main"], { cwd: path });
    writeFileSync(join(path, "identity-fixture.txt"), "owned native repository fixture\n");
    await this.command("git", ["add", "identity-fixture.txt"], { cwd: path });
    await this.command("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture identity"], { cwd: path });
  }
  repoPolicies(a = A, b = B) {
    return { repositories: [ { repository: this.repoA, requiredCommands: [...a] }, { repository: this.repoB, requiredCommands: [...b] } ] };
  }
  async setPolicies(policies) {
    const cfg = await this.rpc("config.get"), source = json(this.env.OPENCLAW_CONFIG_PATH).plugins.entries["openclaw-code-agent"].config;
    if (JSON.stringify(source.goalVerificationPolicies) === JSON.stringify(policies)) {
      assert.deepEqual(cfg.config.plugins.entries["openclaw-code-agent"].config.goalVerificationPolicies, policies);
      assert.equal(cfg.valid, true); assert.equal(cfg.configRevisionHash, cfg.appliedConfigHash);
      assert.ok(sameProcess(this.gatewayIdentity, processIdentity(this.gateway.pid)));
      this.proofs.push({ alreadySetReadbackOnly: true, sourceSha256: sha(JSON.stringify(policies)), unchangedRevision: cfg.hash });
    } else {
      const after = await this.patch({ plugins: { entries: { "openclaw-code-agent": { config: { goalVerificationPolicies: policies } } } } }, [POLICY_ARRAY]);
      assert.deepEqual(after.config.plugins.entries["openclaw-code-agent"].config.goalVerificationPolicies, policies);
    }
    this.currentPolicies = structuredClone(policies);
  }
  async suite(commands, repository = "a") {
    const policies = structuredClone(this.currentPolicies);
    const path = repository === "a" ? this.repoA : this.repoB;
    const selected = policies.repositories.find(policy => policy.repository === path);
    assert.ok(selected); selected.requiredCommands = [...commands]; await this.setPolicies(policies);
  }
  newCase(name, { ralph = false, hold = false, lintFailure = false, barrier = false, repository = "a", root, additionalCommands = [] } = {}) {
    const tag = `OCA501_CASE_${name}`, workdir = join(root ?? (repository === "b" ? this.repoB : this.repoA), name);
    mkdirSync(workdir);
    this.workdirs.push(workdir);
    const fixture = { tag, name: `oca501-${name}`, workdir, ralph, hold, barrier, additionalCommands,
      requiredCommands: [...this.currentPolicies.repositories.find(policy => policy.repository === (repository === "b" ? this.repoB : this.repoA)).requiredCommands],
      nativeSnapshot: { gateway: this.gatewayIdentity, processes: this.nativeProcesses() } };
    this.fixture.cases.set(tag, fixture);
    const script = kind => `index=$(wc -l < checks.jsonl 2>/dev/null || printf 0)\nindex=$((index+1))\nprintf '{"ordinal":%s,"kind":"${kind}","pid":%s,"event":"start"}\\n' "$index" "$$" >> starts.jsonl\n` + (barrier && kind === "CI" ? `if [ "$index" = 1 ]; then echo "$$" > barrier.pid; while [ ! -f release ]; do sleep 0.05; done; fi\n` : "") + `printf '{"ordinal":%s,"kind":"${kind}","exit":${lintFailure && kind === "LINT" ? 3 : 0}}\\n' "$index" >> checks.jsonl\nexit ${lintFailure && kind === "LINT" ? 3 : 0}\n`;
    writeFileSync(join(workdir, "ci.sh"), script("CI"));
    writeFileSync(join(workdir, "lint.sh"), script("LINT"));
    writeFileSync(join(workdir, "changed.sh"), script("B"));
    for (const [file, kind, exit] of [["extra-a.sh", "EXTRA_A", 0], ["extra-b.sh", "EXTRA_B", 0], ["extra-fail.sh", "EXTRA_FAIL", 7]]) {
      writeFileSync(join(workdir, file), `index=$(wc -l < checks.jsonl 2>/dev/null || printf 0)\nindex=$((index+1))\nprintf '{"ordinal":%s,"kind":"${kind}","exit":${exit}}\\n' "$index" >> checks.jsonl\nexit ${exit}\n`);
    }
    return fixture;
  }
  async launch(fixture, max = 1) {
    fixture.intent = { kind: "launch", ralph: fixture.ralph, goal: `${fixture.tag}: Run the harmless receipt command and finish.` };
    await this.invoke("agent_goal", { action: "launch", name: fixture.name, goal: fixture.intent.goal, workdir: fixture.workdir, harness: "codex", permission_mode: "bypassPermissions", goal_mode: fixture.ralph ? "ralph" : "verifier", max_iterations: max, ...(fixture.additionalCommands.length ? { verifier_commands: fixture.additionalCommands } : {}), ...(fixture.ralph ? { completion_promise: "DONE" } : {}) });
    return until(() => this.goals().find(g => g.name === fixture.name));
  }
  async visible(runId) {
    assert.ok(runId);
    const result = await this.rpc("agent.wait", { runId, timeoutMs: 90_000 });
    const history = await this.rpc("chat.history", { sessionKey: this.sessionKey, limit: 100 });
    const proof = visibleProof(result, history, this.fixture.requests, { runId, sessionId: this.parentId, sessionKey: this.sessionKey });
    const { text, responseId } = proof;
    this.proofs.push({ ownRunId: runId, responseId, canonicalSha256: sha(text), visible: true });
  }
  async completion(row, required) {
    const journal = await until(() => { const saved = this.sessions().find(s => s.sessionId === row.sessionId); return saved?.completionWakeSucceededAt && saved; });
    assert.equal(journal.completionWakeSummaryFact?.outcomeKey, journal.completionWakeOutcomeKey);
    assert.equal(journal.completionWakeSummaryFact?.producer, row.goalTaskId ? "goal" : "terminal");
    if (row.goalTaskId) assert.equal(journal.completionWakeOutcomeKey, `goal:${row.goalTaskId}`);
    assert.equal(journal.deliveryState, "idle");
    assert.ok(journal.notificationDedupe?.some(n => n.label === (row.goalTaskId ? "goal-task-succeeded" : "completed") && n.status === "delivered"));
    if (required) { assert.equal(journal.completionWakeSummaryFact?.required, true);
      assert.ok(journal.completionWakeIssuedAt);
      assert.equal(journal.completionWakeSummaryRequired, undefined);
      }
    assert.ok(!journal.completionWakeFailedAt && !journal.completionWakeSkippedAt && !journal.completionWakeSkipReason);
    assert.equal(journal.completionWakeRoutedReply, false);
    await this.visible(journal.completionWakeRunId);
    this.proofs.push({ sessionId: row.sessionId, outcomeKey: journal.completionWakeOutcomeKey, ownRunId: journal.completionWakeRunId,
      requiredAdmissionFact: requiredFact(journal.completionWakeSummaryFact), issuedAt: journal.completionWakeIssuedAt, succeededAt: journal.completionWakeSucceededAt,
      notificationKeys: journal.notificationDedupe.filter(n => n.status === "delivered").map(n => ({ key: n.key, label: n.label })), deliveryState: journal.deliveryState });
  }
  async publicOwner(id, status, fixture) {
    const row = this.sessions().find(s => s.sessionId === id);
    assert.ok(row);
    if (status === "completed") {
      assert.equal(row.status, "completed"); assert.equal(row.workdir, fixture.workdir);
      assert.equal(row.backendRef?.conversationId, fixture.threadId);
      const goal = fixture.intent.kind === "ordinary" ? undefined : this.goals().find(g => g.name === fixture.name && g.goal === fixture.intent.goal);
      if (fixture.intent.kind !== "ordinary") assert.ok(goal && goal.sessionId === id);
      assert.equal(row.name, goal?.sessionName ?? fixture.name);
      assert.equal(row.goalTaskId, goal?.id);
      const listing = await this.invoke("agent_sessions", { status: "all", full: true });
      const blocks = listing.content.map(c => c.text ?? "").join("\n").split("\n\n").filter(block => block.startsWith(`✅ ${row.name} [${id}] — completed · `));
      assert.equal(blocks.length, 1);
      assert.ok(!blocks[0].includes("♻️ Recovered after a Gateway restart; no live process"));
    } else {
      const output = await this.invoke("agent_output", { session: id, full: true });
      const first = output.content.map(c => c.text ?? "").join("\n").split("\n")[0];
      assert.ok(first.startsWith(`Session: ${row.name} [${id}] | Status: ${status.toUpperCase()} |`));
    }
    this.proofs.push({ publicOwnerId: id, publicOwnerStatus: status, activePublicView: true });
  }
  async terminal(goal, fixture, status) {
    const current = await until(() => this.goals().find(g => g.id === goal.id && ["succeeded", "failed", "stopped"].includes(g.status)));
    assert.equal(current.status, status);
    const binding = current.goalVerificationBinding;
    assert.equal(binding?.version, 1);
    assert.deepEqual(binding.requiredCommands, fixture.requiredCommands ?? A);
    assert.deepEqual(binding.additionalCommands, fixture.additionalCommands ?? []);
    assert.deepEqual(current.verifierCommands.map(spec => spec.command), [...binding.requiredCommands, ...binding.additionalCommands]);
    assert.equal(fixture.executed, true);
    const row = await until(() => this.sessions().find(s => s.sessionId === current.sessionId && s.backendRef?.conversationId === fixture.threadId));
    assert.equal(row.goalTaskId, current.id); assert.equal(row.name, current.sessionName); assert.equal(row.workdir, fixture.workdir);
    if (status === "succeeded") await this.completion(row, true);
    else { const dedupe = await until(() => (this.sessions().find(s => s.sessionId === row.sessionId)?.notificationDedupe ?? []).find(n => n.label === "goal-task-failed" && n.status === "delivered"));
      this.proofs.push({ sessionId: row.sessionId, failedNotificationKey: dedupe.key, delivered: true });
      }
    const listing = await this.invoke("agent_sessions", { status: "all", full: true });
    const headers = listing.content.map(c => c.text ?? "").join("\n").split("\n").filter(line => line.includes(` ${row.name} [${row.sessionId}] — `));
    assert.equal(headers.length, 1);
    this.proofs.push({ goalId: current.id, sessionId: row.sessionId, nativeThreadId: fixture.threadId, terminalStatus: current.status, terminalRowSha256: sha(JSON.stringify(current)), requiredCommands: binding.requiredCommands, additionalCommands: binding.additionalCommands, effectiveCommands: current.verifierCommands.map(spec => spec.command), bindingSha256: sha(JSON.stringify(binding)), policyFingerprint: binding.policyFingerprint, repositoryIdentitySha256: sha(JSON.stringify(binding.identity)), selectedPolicy: binding.source, operatorTrustedExtras: true, verifierCommands: current.verifierCommands.map(({ label, command }) => ({ label, command })), iteration: current.iteration });
    return current;
  }
  checks(fixture, expected, retired = []) {
    const checks = readFileSync(join(fixture.workdir, "checks.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(checks, [...retired, ...expected].map(([kind, exit], i) => ({ ordinal: i + 1, kind, exit })));
    this.proofs.push({ case: fixture.tag, retiredChecks: checks.slice(0, retired.length), checks: checks.slice(retired.length), nativeReceiptSha256: sha(readFileSync(join(fixture.workdir, "native-receipt.txt"))) });
  }
  async releaseBarrier(fixture) {
    const path = join(fixture.workdir, "barrier.pid");
    await until(() => existsSync(path));
    const identity = processIdentity(Number(readFileSync(path, "utf8"))); assert.ok(identity && identity.executable.endsWith("/bash"));
    let ancestor = identity;
    while (ancestor && ancestor.pid !== this.gateway.pid) ancestor = processIdentity(ancestor.parent);
    assert.ok(ancestor && sameProcess(ancestor, this.gatewayIdentity));
    fixture.barrierProcess = identity; fixture.barrierScriptSha256 = sha(readFileSync(join(fixture.workdir, "ci.sh")));
    return identity;
  }
  async offlinePolicies(policies) {
    assert.equal(this.gateway, undefined);
    const source = json(this.env.OPENCLAW_CONFIG_PATH);
    source.plugins.entries["openclaw-code-agent"].config.goalVerificationPolicies = policies;
    writeFileSync(this.env.OPENCLAW_CONFIG_PATH, JSON.stringify(source), { mode: 0o600 });
    await this.cli(["config", "validate"]);
    this.currentPolicies = structuredClone(policies);
  }
  async restartHeld(fixture, goal, policies) {
    await until(() => fixture.held && fixture.threadId);
    const original = structuredClone(this.goals().find(g => g.id === goal.id));
    fixture.oldSessionId = original.sessionId; fixture.oldSessionName = original.sessionName;
    fixture.shutdownExpected = true; await this.shutdown();
    const saved = this.goals().find(g => g.id === goal.id);
    assert.ok(["running", "waiting_for_session"].includes(saved.status));
    assert.equal(saved.harnessSessionId, fixture.threadId);
    assert.deepEqual(saved.goalVerificationBinding, original.goalVerificationBinding);
    await this.offlinePolicies(policies);
    fixture.intent = { ...fixture.intent, kind: "restore" };
    fixture.oldTurns = [fixture.turnId]; fixture.turnId = undefined; fixture.call = undefined;
    for (const previous of this.fixture.cases.values()) if (previous.nativeProcess) {
      const current = processIdentity(previous.nativeProcess.pid);
      assert.ok(current || !existsSync(`/proc/${previous.nativeProcess.pid}`));
      assert.ok(!sameProcess(previous.nativeProcess, current) || current.state === "Z");
    }
    fixture.nativeProcess = undefined; fixture.nativeSessionId = undefined; fixture.nativeSessionName = undefined;
    fixture.nativeSnapshot = { processes: this.nativeProcesses(null) }; assert.equal(fixture.nativeSnapshot.processes.length, 0);
    return original;
  }
  async rejectEmptyPolicy() {
    const cfg = await this.rpc("config.get"), before = this.effects();
    const refused = await this.cli(["gateway", "call", "config.patch", "--params", JSON.stringify({ raw: JSON.stringify({ plugins: { entries: { "openclaw-code-agent": { config: { goalVerificationPolicies: { repositories: [{ repository: this.repoA, requiredCommands: [] }] } } } } } }), baseHash: cfg.hash, replacePaths: [POLICY_ARRAY] }), "--json"], { allowFailure: true });
    const failure = configPatchFailureProof(refused);
    assert.notEqual(refused.code, 0);
    assert.equal(failure.patchErrorCode, "INVALID_REQUEST");
    assert.equal(failure.patchRequiredCommandsSchemaDenied, true, "EMPTY_REQUIRED_COMMANDS_SCHEMA_DENIAL_REQUIRED");
    assert.equal(failure.patchArrayIntentDenied, false, "ARRAY_INTENT_DENIAL_IS_NOT_SCHEMA_PROOF");
    assert.equal((await this.rpc("config.get")).hash, cfg.hash);
    assert.deepEqual(this.effects(), before);
  }
  async runCases() {
    const selected = this.receipt.scenario;
    if (selected === "smoke") return;
    if (["admission", "all"].includes(selected)) {
      this.stage = "admission";
      await this.rejectEmptyPolicy();
      const before = this.effects();
      const unmatched = join(this.workspace, "unmapped-repository"); await this.createRepository(unmatched);
      const denied = await this.invoke("agent_goal", { action: "launch", goal: "Unmapped repository", workdir: unmatched }, false);
      assert.match(denied.content[0].text, /No goal verification policy matches/); assert.deepEqual(this.effects(), before);
      const alias = join(this.workspace, "repository-alias"); symlinkSync(this.repoA, alias);
      await this.setPolicies({ repositories: [ ...this.repoPolicies().repositories, { repository: alias, requiredCommands: A } ] });
      const ambiguous = await this.invoke("agent_goal", { action: "launch", goal: "Duplicate identity", workdir: this.repoA }, false);
      assert.match(ambiguous.content[0].text, /Duplicate canonical/); assert.deepEqual(this.effects(), before);
      await this.setPolicies(this.repoPolicies());
      this.proofs.push({ deniedBeforeEffects: true, case: "unmapped-and-duplicate-canonical" });
      this.receipt.completed.push("admission");
    }
    if (["gates", "all"].includes(selected)) {
      this.stage = "whole-gate"; await this.setPolicies(this.repoPolicies());
      const linked = join(this.workspace, "linked-a");
      await this.command("git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", "native-linked", linked], { cwd: this.repoA });
      for (const options of [
        { name: "a-addition", additionalCommands: ["bash extra-a.sh", "bash ci.sh", "bash extra-a.sh"] },
        { name: "b-addition", repository: "b", additionalCommands: ["bash extra-b.sh"] },
        { name: "linked-subdir", root: linked, additionalCommands: ["bash extra-a.sh"] },
        { name: "caller-true", additionalCommands: ["true"] },
        { name: "ralph-addition-fail", ralph: true, additionalCommands: ["bash extra-fail.sh"] },
      ]) {
        const fixture = this.newCase(options.name, options), goal = await this.launch(fixture);
        const failed = options.name === "ralph-addition-fail";
        const terminal = await this.terminal(goal, fixture, failed ? "failed" : "succeeded");
        const required = options.repository === "b" ? [["B", 0]] : [["CI", 0], ["LINT", 0], ["CI", 0]];
        const extra = options.additionalCommands.filter(command => command !== "true").map(command => [command === "bash ci.sh" ? "CI" : failed ? "EXTRA_FAIL" : options.repository === "b" ? "EXTRA_B" : "EXTRA_A", failed ? 7 : 0]);
        this.checks(fixture, [...required, ...extra]);
        if (options.name === "caller-true") assert.match(terminal.lastVerifierSummary, /PASS check-4/);
        if (failed) assert.match(terminal.lastVerifierSummary, /FAIL check-4/);
      }
      this.receipt.completed.push("whole-gate");
    }
    if (["live", "all"].includes(selected)) {
      this.stage = "live-policy"; await this.setPolicies(this.repoPolicies());
      const unrelated = this.newCase("live-unrelated", { barrier: true, additionalCommands: ["bash extra-a.sh"] });
      const unrelatedGoal = await this.launch(unrelated, 3), unaffectedCheck = await this.releaseBarrier(unrelated);
      const unaffected = structuredClone(this.goals().find(g => g.id === unrelatedGoal.id));
      const restoration = this.registerPolicyRestore(unrelated, unrelatedGoal, unaffectedCheck);
      await this.suite(["bash changed.sh", "bash changed.sh"], "b");
      await this.drainPolicyRestore(unrelated);
      const passed = await this.terminal(unrelatedGoal, unrelated, "succeeded");
      assert.deepEqual(passed.goalVerificationBinding, unaffected.goalVerificationBinding);
      assert.equal(restoration.phase, "consumed");
      this.checks(unrelated, [["CI", 0], ["LINT", 0], ["CI", 0], ["EXTRA_A", 0]], [["CI", 0]]);
      this.proofs.push({ unrelatedPolicyChanged: true, restoredBindingUnchanged: true, retiredAdmittedCheckDrained: true, restoredEffectiveSuitePassed: true, case: "live-unrelated-B" });
      const fixture = this.newCase("live-affected", { barrier: true, additionalCommands: ["bash extra-a.sh"] });
      const goal = await this.launch(fixture, 3), check = await this.releaseBarrier(fixture);
      const own = structuredClone(this.goals().find(g => g.id === goal.id)), effects = this.effects();
      await this.publicOwner(own.sessionId, "completed", fixture);
      await this.suite(B); await this.suite(A);
      assert.ok(sameProcess(check, processIdentity(check.pid))); assert.deepEqual(this.effects(), effects);
      writeFileSync(join(fixture.workdir, "release"), "release\n");
      await until(() => !processIdentity(check.pid));
      const failed = await this.terminal(goal, fixture, "failed");
      assert.ok(POLICY_FAILURES.includes(failed.failureReason)); assert.deepEqual(failed.goalVerificationBinding, own.goalVerificationBinding);
      for (const field of ["id", "name", "goal", "workdir", "iteration", "sessionId", "sessionName", "harnessSessionId"]) assert.equal(failed[field], own[field]);
      this.checks(fixture, [["CI", 0]]);
      assert.deepEqual(readFileSync(join(fixture.workdir, "starts.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [{ ordinal: 1, kind: "CI", pid: check.pid, event: "start" }]);
      const finalEffects = this.effects(); for (const field of ["goals", "sessions", "nativeRequests"]) assert.deepEqual(finalEffects[field], effects[field]);
      this.proofs.push({ verifierProcess: check, policyFailure: true, affectedPolicyABA: true });
      this.receipt.completed.push("live-policy");
    }
    if (["restore", "all"].includes(selected)) {
      this.stage = "organic-restore"; await this.setPolicies(this.repoPolicies());
      const history = this.goals().filter(g => ["succeeded", "failed", "stopped"].includes(g.status));
      const fixture = this.newCase("restore-unchanged", { ralph: true, hold: true, additionalCommands: ["bash extra-a.sh"] });
      const goal = await this.launch(fixture, 3);
      const original = await this.restartHeld(fixture, goal, this.repoPolicies(A, ["bash changed.sh", "bash changed.sh"]));
      fixture.hold = false; await this.start();
      const resumed = await until(() => { const current = this.goals().find(g => g.id === goal.id); return current?.sessionId !== original.sessionId && current; });
      assert.equal(resumed.harnessSessionId, fixture.threadId); assert.deepEqual(resumed.goalVerificationBinding, original.goalVerificationBinding);
      await this.terminal(resumed, fixture, "succeeded");
      this.checks(fixture, [["CI", 0], ["LINT", 0], ["CI", 0], ["EXTRA_A", 0]]);
      this.proofs.push({ sameGoalId: goal.id, sameNativeThreadId: fixture.threadId, oldSessionId: original.sessionId, restoredSessionId: resumed.sessionId, restoredBindingUnchanged: true });
      const immutable = [...history, structuredClone(this.goals().find(g => g.id === goal.id))];
      const blockedFixture = this.newCase("restore-changed", { hold: true, additionalCommands: ["bash extra-a.sh"] });
      const blockedGoal = await this.launch(blockedFixture, 3);
      const blockedOriginal = await this.restartHeld(blockedFixture, blockedGoal, this.repoPolicies(B));
      const nativeRequests = this.fixture.requests.filter(r => r.native).length;
      blockedFixture.hold = false; await this.start();
      const blocked = await until(() => this.goals().find(g => g.id === blockedGoal.id && g.status === "failed"));
      assert.ok(POLICY_FAILURES.includes(blocked.failureReason)); assert.deepEqual(blocked.goalVerificationBinding, blockedOriginal.goalVerificationBinding);
      assert.equal(blocked.sessionId, blockedOriginal.sessionId); assert.equal(this.fixture.requests.filter(r => r.native).length, nativeRequests);
      assert.equal(existsSync(join(blockedFixture.workdir, "checks.jsonl")), false); assert.equal(existsSync(join(blockedFixture.workdir, "native-receipt.txt")), false);
      this.proofs.push({ case: "changed-A-restore-refused", goalId: blocked.id, terminalStatus: blocked.status, bindingSha256: sha(JSON.stringify(blocked.goalVerificationBinding)), deniedBeforeEffects: true });
      for (const previous of immutable) assert.deepEqual(this.goals().find(g => g.id === previous.id), previous);
      this.proofs.push({ historicalRowsCompared: immutable.map(g => ({ id: g.id, sha256: sha(JSON.stringify(g)) })) });
      this.receipt.completed.push("organic-restore"); if (selected === "all") this.receipt.completed.push("immutable-history");
    }
  }

  async shutdown() {
    const gateway = this.gateway;
    if (!gateway) return;
    const stopped = await stopOwnedChild(gateway, { identity: this.gatewayIdentity, ...this.shutdownOptions });
    if (stopped.complete) this.children.delete(gateway);
    this.gateway = undefined;
    this.gatewayReady = false;
    assert.equal(stopped.complete, true, "OWNED_PROCESS_OR_STDIO_SHUTDOWN_FAILED");
    assert.equal(stopped.graceful, true, "GRACEFUL_SHUTDOWN_FAILED");
    await until(() => new Promise(done => { const connection = createConnection({ host: "127.0.0.1", port: this.port }); connection.once("error", () => done(true)); connection.once("connect", () => { connection.destroy(); done(false); }); }));
    this.proofs.push({ ownedShutdown: true, gateway: stopped.targets[0], descendants: stopped.targets.slice(1).map(p => ({ pid: p.pid, startTicks: p.startTicks, executable: p.executable })), listenerClosed: true });
    this.gateway = undefined;
    this.gatewayIdentity = undefined;
  }
  async settleParentReplies() {
    const history = await this.rpc("chat.history", { sessionKey: this.sessionKey, limit: 100 });
    assert.equal(history.sessionId, this.parentId); assert.equal(history.sessionKey, this.sessionKey); assert.notEqual(history.truncated, true);
    const rows = this.sessions();
    for (const proof of this.proofs.filter(p => p.requiredAdmissionFact || p.failedNotificationKey)) {
      const row = rows.find(r => r.sessionId === proof.sessionId); assert.ok(row);
      if (proof.requiredAdmissionFact) assert.equal(row.completionWakeSummaryFact?.required, true);
      if (proof.failedNotificationKey) assert.ok(row.notificationDedupe?.some(n => n.key === proof.failedNotificationKey && n.label === "goal-task-failed" && n.status === "delivered"));
    }
    for (const row of rows) {
      assert.ok(!["failed", "notifying", "wake_pending"].includes(row.deliveryState));
      assert.ok(!(row.notificationDedupe ?? []).some(n => n.status === "in_flight"));
      if (row.completionWakeSummaryRequired === true) assert.equal(row.completionWakeSummaryFact?.required, true);
      if (!row.completionWakeSummaryFact?.required) continue;
      assert.equal(row.deliveryState, "idle"); assert.equal(row.completionWakeSummaryRequired, undefined); assert.equal(row.completionWakeRoutedReply, false);
      assert.ok(row.completionWakeIssuedAt && row.completionWakeSucceededAt);
      assert.ok(!row.completionWakeFailedAt && !row.completionWakeSkippedAt && !row.completionWakeSkipReason);
      const fact = requiredFact(row.completionWakeSummaryFact);
      assert.equal(fact.producer, row.goalTaskId ? "goal" : "terminal"); assert.equal(fact.outcomeKey, row.completionWakeOutcomeKey);
      const proved = this.proofs.filter(p => p.sessionId === row.sessionId && p.ownRunId === row.completionWakeRunId && p.outcomeKey === row.completionWakeOutcomeKey
        && p.issuedAt === row.completionWakeIssuedAt && p.succeededAt === row.completionWakeSucceededAt && JSON.stringify(p.requiredAdmissionFact) === JSON.stringify(fact));
      assert.equal(proved.length, 1, "A new or changed required obligation needs its own contemporaneous proof");
      const label = row.goalTaskId ? "goal-task-succeeded" : "completed";
      assert.ok(row.notificationDedupe?.some(n => n.label === label && n.status === "delivered" && proved[0].notificationKeys.some(p => p.key === n.key && p.label === n.label)));
      const visible = this.proofs.filter(p => p.visible === true && p.ownRunId === row.completionWakeRunId);
      assert.equal(visible.length, 1);
      const canonical = history.messages.filter(m => m.role === "assistant" && m.__openclaw?.runId === row.completionWakeRunId);
      assert.equal(canonical.length, 1); assert.notEqual(canonical[0].__openclaw.truncated, true); assert.equal(canonical[0].responseId, visible[0].responseId);
      const text = (canonical[0].content ?? []).filter(c => c.type === "text" || c.type === "output_text").map(c => c.text).join("");
      assert.equal(sha(text), visible[0].canonicalSha256);
    }
  }
  async cleanup() {
    const failures = [];
    if (this.fixture) for (const fixture of this.fixture.cases.values()) {
      fixture.shutdownExpected = true;
      if (!fixture.barrier || !fixture.barrierProcess) continue;
      try {
        const current = processIdentity(fixture.barrierProcess.pid);
        assert.ok(current || !existsSync(`/proc/${fixture.barrierProcess.pid}`), "OWNED_BARRIER_IDENTITY_UNAVAILABLE");
        if (!sameProcess(current, fixture.barrierProcess) || current.state === "Z") continue;
        assert.ok(this.workdirs.includes(fixture.workdir) && inside(this.workspace, fixture.workdir));
        assert.equal(realpathSync(fixture.workdir), fixture.workdir); assert.equal(readlinkSync(`/proc/${current.pid}/cwd`), fixture.workdir);
        assert.equal(sha(readFileSync(join(fixture.workdir, "ci.sh"))), fixture.barrierScriptSha256);
        writeFileSync(join(fixture.workdir, "release"), "cleanup release\n");
      } catch { failures.push("OWNED_CHILD_SHUTDOWN_FAILED"); }
    }
    if (this.fixture) for (const fixture of this.fixture.cases.values()) fixture.shutdownExpected = true;
    try { if (this.gateway) await this.shutdown();
      } catch { failures.push("OWNED_GATEWAY_SHUTDOWN_FAILED");
      }
    for (const child of this.children) {
      try { const stopped = await stopOwnedChild(child);
        if (!stopped.complete || !stopped.graceful) failures.push("OWNED_CHILD_SHUTDOWN_FAILED");
      } catch { failures.push("OWNED_CHILD_SHUTDOWN_FAILED"); }
    }
    try { if (this.fixture) { for (const fixture of this.fixture.cases.values()) fixture.shutdownExpected = true;
        await this.fixture.close();
        assert.deepEqual(this.fixture.failures, []);
        } } catch { failures.push("FIXTURE_PROTOCOL_OR_SHUTDOWN_FAILED");
      }
    for (const name of ["runtime.log", "config.json", "codex/config.toml", "goals.json", "sessions.json"]) if (existsSync(join(this.directory, name))) this.raw.push(excluded(name.replaceAll("/", "."), readFileSync(join(this.directory, name))));
    if (this.fixture) this.proofs.push({ providerRequests: this.fixture.requests, fixtureFailures: this.fixture.failures });
    this.receipt.cleanup = { complete: failures.length === 0, failures };
    return failures.length === 0;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let run;
  try { run = new FeatureRun(optionsFor(process.argv.slice(2)));
    await run.setup();
    await run.runCases();
    run.stage = "completion-settlement";
    await run.settleParentReplies();
    }
  catch { if (run) run.receipt.failure = { stage: run.stage, code: "REQUIRED_FEATURE_PROOF_FAILED" };
    process.exitCode = 1;
    }
  finally {
    if (run) { if (!await run.cleanup()) process.exitCode = 1;
      if (!process.exitCode) { if (run.receipt.scenario === "all") run.receipt.completed.push("end-to-end-cleanup");
        run.receipt.disposition = "PASS";
        }
      try { const frame = frameReceipt(run.receipt, run.keys);
        if (run.receipt.disposition === "BLOCKED") process.exitCode = 1;
        writeFileSync(join(run.directory, "receipt.frame"), frame, { mode: 0o600 });
        await new Promise((done, reject) => process.stdout.write(frame, error => error ? reject(error) : done()));
        }
      catch { process.exitCode = 1;
        console.error("STRUCTURED_RECEIPT_EXPORT_BLOCKED");
        }
    } else { process.exitCode = 1;
      console.error("PRE_EFFECT_OPTIONS_REFUSED");
      }
  }
}
