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
const FIELD = "plugins.entries.openclaw-code-agent.config.requiredGoalVerifierCommands";
const delay = ms => new Promise(done => setTimeout(done, ms));
const json = path => JSON.parse(readFileSync(path, "utf8"));
const inside = (root, path) => { const r = relative(root, path);
  return r && !r.startsWith("..") && !isAbsolute(r);
  };
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
export function currentOwner(rows, listing, fixture, threadId, goalId) {
  const candidates = rows.filter(row => row.name === fixture.name && row.workdir === fixture.workdir && row.backendRef?.conversationId === threadId
    && row.goalTaskId === goalId && row.sessionId !== fixture.oldSessionId);
  const selected = candidates.filter(row => listing.split("\n\n").some(block => block.startsWith(`🟢 ${row.name} [${row.sessionId}] — running · `)
    && !block.includes("♻️ Recovered after a Gateway restart; no live process")));
  assert.equal(selected.length, 1, "Exactly one current public native owner required");
  return selected[0];
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
    this.receipt = { format: "oca501-slim-v1", candidateSha: options["--expected-sha"], nodeVersion: options["--node-version"], hostVersion: "2026.9.7", hostCommit: HOST_PIN, nativeVersion: "0.159.3", scenario: options["--scenario"], assigned: assignments[options["--scenario"]], completed: [], disposition: "BLOCKED", complete: true, failure: null, cleanup: { complete: false, failures: [] }, excluded: this.raw, proofs: this.proofs, retiredHostClaims: ["Telegram/slash/callback interoperability", "idle/fork/pending native windows", "custody drain fence", "unprivileged archive EACCES", "debug producer/schema attribution", "late ABA generation pairing"] };
  }
  async command(program, args, { allowFailure = false, timeoutMs = 120_000, graceMs = 30_000, killMs = 5000 } = {}) {
    const child = spawn(program, args, { cwd: ROOT, env: this.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
  async cli(args, options) { return this.command(process.execPath, [this.hostEntry, ...args], options);
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
    const tagResponse = await fetch("https://api.github.com/repos/openclaw/openclaw/git/ref/tags/v2026.9.7", { signal: AbortSignal.timeout(30_000) });
    assert.equal(tagResponse.status, 200);
    let object = (await tagResponse.json()).object;
    if (object.type === "tag") { const tag = await fetch(object.url, { signal: AbortSignal.timeout(30_000) });
      assert.equal(tag.status, 200);
      object = (await tag.json()).object;
      }
    assert.equal(object.type, "commit");
    assert.equal(object.sha, HOST_PIN);
    const validator = await import(join(hostRoot, "dist/schema-validator-BP6RVpTv.mjs"));
    assert.equal(typeof validator.validateJsonSchemaValue, "function");
    await this.command("npm", ["install", "--prefix", join(this.directory, "native"), "--no-audit", "--no-fund", "@openai/codex@0.159.3"]);
    this.native = realpathSync(join(this.directory, "native/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"));
    assert.equal((await this.command(this.native, ["--version"])).stdout.trim(), "codex-cli 0.159.3");
    this.env.OPENCLAW_CODEX_APP_SERVER_COMMAND = this.native;
    this.fixture = await responsesFixture({ root: this.workspace, model: MODEL, key: this.keys[1], validate: validator.validateJsonSchemaValue, observeNative: (fixture, record) => this.nativeOwner(fixture, record) });
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
    const config = { gateway: { mode: "local", bind: "loopback", port: this.port, auth: { mode: "token", token: this.keys[0] }, reload: { mode: "hybrid" } }, logging: { file: join(this.directory, "runtime.log") },
      models: { mode: "replace", catalogRefresh: { enabled: false }, providers: { oca501: { baseUrl: `${this.fixture.url}/host/v1`, api: "openai-responses", auth: "api-key", apiKey: this.keys[1], request: { allowPrivateNetwork: true }, models: [{ id: MODEL, name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 }] } } },
      agents: { defaults: { workspace: this.workspace, model: { primary: `oca501/${MODEL}`, fallbacks: [] }, modelPolicy: { allow: [`oca501/${MODEL}`] }, utilityModel: `oca501/${MODEL}`, decisionModel: "", experimental: { decisionAssistance: false }, thinkingDefault: "off", heartbeat: { every: "0m" }, embeddedAgent: { cyberFailover: { mode: "off" } }, compaction: { enabled: false, memoryFlush: { enabled: false }, postIndexSync: "off" } } },
      memory: { search: { enabled: false } }, cron: { enabled: false }, discovery: { mdns: { mode: "off" } }, tools: { profile: "full", allow: this.expectedTools, deny: ["agent_goal"] },
      plugins: { allow: ["openclaw-code-agent"], slots: { memory: "none" }, entries: { "openclaw-code-agent": { enabled: true, config: { autoUpdate: false, defaultHarness: "codex", defaultWorktreeStrategy: "off", permissionMode: "bypassPermissions", requiredGoalVerifierCommands: A, harnesses: { codex: { defaultModel: MODEL, allowedModels: [MODEL] } } } } } } };
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
    assert.ok(entries.some(entry => entry.id === "agent_goal" && entry.pluginId === "openclaw-code-agent" && entry.deniedBySession === true));
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
    const admittedOwner = await until(() => this.sessions().find(s => s.name === ordinary.name));
    await this.publicOwner(admittedOwner.sessionId, "running");
    const stopped = await this.invoke("agent_kill", { session: admittedOwner.sessionId, reason: "completed" });
    assert.ok(stopped.content[0].text.includes("marked as completed"));
    const row = await until(() => this.sessions().find(s => s.sessionId === admittedOwner.sessionId && s.status === "completed"));
    assert.equal(row.backendRef.conversationId, ordinary.threadId);
    await this.completion(row, true);
    this.proofs.push({ setupOnly: true, nativeThreadId: ordinary.threadId, nativeReceiptSha256: sha(readFileSync(join(ordinary.workdir, "native-receipt.txt"))), parentProof: true });
  }
  async nativeOwner(fixture, record) {
    const goal = fixture.intent.kind === "ordinary" ? undefined : await until(() => this.goals().find(g => g.name === fixture.name && g.goal === fixture.intent.goal));
    const listing = await this.invoke("agent_sessions", { status: "running", full: true });
    const row = currentOwner(this.sessions(), listing.content.map(c => c.text ?? "").join("\n"), fixture, record.threadId, goal?.id);
    await this.publicOwner(row.sessionId, "running");
    const native = readdirSync("/proc").filter(n => /^\d+$/.test(n)).map(n => processIdentity(Number(n))).filter(p => p?.executable === this.native).filter(p => {
      try { return readlinkSync(`/proc/${p.pid}/cwd`) === fixture.workdir; } catch { return false; }
    });
    assert.equal(native.length, 1);
    let ancestor = native[0];
    while (ancestor && ancestor.pid !== this.gateway.pid) ancestor = processIdentity(ancestor.parent);
    assert.ok(sameProcess(ancestor, this.gatewayIdentity));
    return { sessionId: row.sessionId, nativeProcess: native[0] };
  }
  async start() {
    this.stage = "gateway-start";
    assert.deepEqual(tree(join(this.installed, "dist")), this.packedTree);
    const child = spawn(process.execPath, [this.hostEntry, "gateway", "run", "--bind", "loopback", "--port", String(this.port)], { cwd: this.workspace, env: this.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.gateway = child;
    this.children.add(child);
    childIdentities.set(child, processIdentity(child.pid));
    const buffers = { stdout: [], stderr: [] };
    child.stdout.on("data", data => buffers.stdout.push(data));
    child.stderr.on("data", data => buffers.stderr.push(data));
    child.once("close", () => { for (const [name, chunks] of Object.entries(buffers)) this.raw.push(excluded(`gateway-${this.raw.length}.${name}`, Buffer.concat(chunks))); });
    await until(async () => { assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); try { return (await fetch(`${this.url}/readyz`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } });
    this.gatewayIdentity = processIdentity(child.pid);
    assert.ok(this.gatewayIdentity);
    assert.equal(realpathSync(this.gatewayIdentity.executable), realpathSync(process.execPath));
    const cfg = await this.rpc("config.get");
    assert.equal(cfg.valid, true);
    assert.equal(cfg.config.models.providers.oca501.baseUrl, `${this.fixture.url}/host/v1`);
    this.proofs.push({ gateway: this.gatewayIdentity, appliedRevision: cfg.appliedConfigHash, configRevision: cfg.configRevisionHash });
  }
  async patch(fields, paths) {
    const before = await this.rpc("config.get"), identity = this.gatewayIdentity;
    const ack = await this.rpc("config.patch", { raw: JSON.stringify(fields), baseHash: before.hash, replacePaths: paths });
    assert.equal(ack.ok, true);
    assert.notEqual(ack.hash, before.hash);
    assert.ok(ack.changedPaths.some(path => paths.includes(path)));
    assert.equal(ack.sentinel.payload.stats.requiresRestart, false);
    const after = await this.rpc("config.get");
    assert.equal(after.valid, true);
    assert.equal(after.hash, ack.hash);
    assert.equal(after.configRevisionHash, after.appliedConfigHash);
    assert.ok(after.appliedConfigHash);
    assert.ok(sameProcess(identity, processIdentity(this.gateway.pid)));
    this.proofs.push({ mutation: paths, beforeRevision: before.hash, afterRevision: ack.hash, appliedRevision: after.appliedConfigHash });
    return after;
  }
  async suite(commands) {
    const cfg = await this.rpc("config.get"), source = json(this.env.OPENCLAW_CONFIG_PATH).plugins.entries["openclaw-code-agent"].config;
    if (JSON.stringify(source.requiredGoalVerifierCommands) === JSON.stringify(commands)) {
      assert.deepEqual(cfg.config.plugins.entries["openclaw-code-agent"].config.requiredGoalVerifierCommands, commands);
      assert.equal(cfg.valid, true);
      assert.ok(cfg.appliedConfigHash);
      assert.equal(cfg.configRevisionHash, cfg.appliedConfigHash);
      const bytes = sha(readFileSync(this.env.OPENCLAW_CONFIG_PATH)), after = await this.rpc("config.get");
      assert.equal(sha(readFileSync(this.env.OPENCLAW_CONFIG_PATH)), bytes);
      assert.equal(after.hash, cfg.hash);
      assert.equal(after.valid, true);
      assert.equal(after.configRevisionHash, cfg.configRevisionHash);
      assert.equal(after.appliedConfigHash, cfg.appliedConfigHash);
      assert.ok(sameProcess(this.gatewayIdentity, processIdentity(this.gateway.pid)));
      this.proofs.push({ alreadySetReadbackOnly: true, requiredVerifierCommands: commands, sourceSha256: bytes, unchangedRevision: cfg.hash });
      return;
    }
    const after = await this.patch({ plugins: { entries: { "openclaw-code-agent": { config: { requiredGoalVerifierCommands: commands } } } } }, [FIELD]);
    assert.deepEqual(after.config.plugins.entries["openclaw-code-agent"].config.requiredGoalVerifierCommands, commands);
  }
  newCase(name, { ralph = false, hold = false, lintFailure = false, barrier = false } = {}) {
    const tag = `OCA501_CASE_${name}`, workdir = join(this.workspace, name);
    mkdirSync(workdir);
    this.workdirs.push(workdir);
    const fixture = { tag, name: `oca501-${name}`, workdir, ralph, hold };
    this.fixture.cases.set(tag, fixture);
    const script = kind => `index=$(wc -l < checks.jsonl 2>/dev/null || printf 0)\nindex=$((index+1))\nprintf '{"ordinal":%s,"kind":"${kind}","pid":%s,"event":"start"}\\n' "$index" "$$" >> starts.jsonl\n` + (barrier && kind === "CI" ? `if [ "$index" = 1 ]; then echo "$$" > barrier.pid; while [ ! -f release ]; do sleep 0.05; done; fi\n` : "") + `printf '{"ordinal":%s,"kind":"${kind}","exit":${lintFailure && kind === "LINT" ? 3 : 0}}\\n' "$index" >> checks.jsonl\nexit ${lintFailure && kind === "LINT" ? 3 : 0}\n`;
    writeFileSync(join(workdir, "ci.sh"), script("CI"));
    writeFileSync(join(workdir, "lint.sh"), script("LINT"));
    writeFileSync(join(workdir, "changed.sh"), "exit 0\n");
    return fixture;
  }
  async launch(fixture, max = 1) {
    fixture.intent = { kind: "launch", ralph: fixture.ralph, goal: `${fixture.tag}: Run the harmless receipt command and finish.` };
    await this.invoke("agent_goal", { action: "launch", name: fixture.name, goal: fixture.intent.goal, workdir: fixture.workdir, harness: "codex", permission_mode: "bypassPermissions", goal_mode: fixture.ralph ? "ralph" : "verifier", max_iterations: max, ...(fixture.ralph ? { completion_promise: "DONE" } : {}) });
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
  async publicOwner(id, status) {
    const row = this.sessions().find(s => s.sessionId === id);
    assert.ok(row);
    const output = await this.invoke("agent_output", { session: id, full: true });
    const first = output.content.map(c => c.text ?? "").join("\n").split("\n")[0];
    assert.ok(first.startsWith(`Session: ${row.name} [${id}] | Status: ${status.toUpperCase()} |`));
    this.proofs.push({ publicOwnerId: id, publicOwnerStatus: status, activePublicView: true });
  }
  async terminal(goal, fixture, status) {
    const current = await until(() => this.goals().find(g => g.id === goal.id && ["succeeded", "failed", "stopped"].includes(g.status)));
    assert.equal(current.status, status);
    assert.deepEqual(current.requiredVerifierCommands, A);
    assert.equal(fixture.executed, true);
    const row = await until(() => this.sessions().find(s => s.sessionId === current.sessionId && s.backendRef?.conversationId === fixture.threadId));
    if (status === "succeeded") await this.completion(row, true);
    else { const dedupe = await until(() => (this.sessions().find(s => s.sessionId === row.sessionId)?.notificationDedupe ?? []).find(n => n.label === "goal-task-failed" && n.status === "delivered"));
      this.proofs.push({ failedNotificationKey: dedupe.key, delivered: true });
      }
    const listing = await this.invoke("agent_sessions", { status: "all", full: true });
    const headers = listing.content.map(c => c.text ?? "").join("\n").split("\n").filter(line => line.includes(` ${row.name} [${row.sessionId}] — `));
    assert.equal(headers.length, 1);
    this.proofs.push({ goalId: current.id, sessionId: row.sessionId, nativeThreadId: fixture.threadId, terminalStatus: current.status, terminalRowSha256: sha(JSON.stringify(current)), requiredVerifierCommands: current.requiredVerifierCommands, verifierCommands: current.verifierCommands, iteration: current.iteration });
    return current;
  }
  checks(fixture, expected) { const checks = readFileSync(join(fixture.workdir, "checks.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(checks, expected.map(([kind, exit], i) => ({ ordinal: i + 1, kind, exit })));
    this.proofs.push({ case: fixture.tag, checks, nativeReceiptSha256: sha(readFileSync(join(fixture.workdir, "native-receipt.txt"))) });
    }
  async runCases() {
    const selected = this.receipt.scenario;
    if (selected === "smoke") return;
    if (["admission", "all"].includes(selected)) {
      this.stage = "admission";
      const cfg = await this.rpc("config.get"), before = this.effects();
      const refused = await this.cli(["gateway", "call", "config.patch", "--params", JSON.stringify({ raw: JSON.stringify({ plugins: { entries: { "openclaw-code-agent": { config: { requiredGoalVerifierCommands: [] } } } } }), baseHash: cfg.hash, replacePaths: [FIELD] }), "--json"], { allowFailure: true });
      assert.notEqual(refused.code, 0);
      const error = JSON.parse(refused.stdout.slice(refused.stdout.indexOf("{")));
      assert.equal(error.error.code, "INVALID_REQUEST");
      assert.ok(JSON.stringify(error.error.details).includes("requiredGoalVerifierCommands"));
      assert.equal((await this.rpc("config.get")).hash, cfg.hash);
      const weak = await this.invoke("agent_goal", { action: "launch", goal: "Weak", workdir: this.workspace, verifier_commands: [A[0]] }, false);
      assert.match(weak.content[0].text, /complete ordered/);
      assert.deepEqual(this.effects(), before);
      this.receipt.completed.push("admission");
    }
    if (["gates", "all"].includes(selected)) {
      this.stage = "whole-gate";
      await this.suite(A);
      for (const [name, ralph, lintFailure] of [["default", false, false], ["ralph", true, false], ["ralph-fail", true, true]]) { const fixture = this.newCase(name, { ralph, lintFailure });
        const goal = await this.launch(fixture);
        await this.terminal(goal, fixture, lintFailure ? "failed" : "succeeded");
        this.checks(fixture, [["CI", 0], ["LINT", lintFailure ? 3 : 0], ["CI", 0]]);
        }
      this.receipt.completed.push("whole-gate");
    }
    if (["live", "all"].includes(selected)) {
      this.stage = "live-policy";
      await this.suite(A);
      const fixture = this.newCase("live", { barrier: true }), goal = await this.launch(fixture, 3);
      await until(() => existsSync(join(fixture.workdir, "barrier.pid")));
      const pid = Number(readFileSync(join(fixture.workdir, "barrier.pid"), "utf8")), check = processIdentity(pid);
      assert.ok(check && check.executable.endsWith("/bash"));
      let ancestor = check;
      while (ancestor && ancestor.pid !== this.gateway.pid) ancestor = processIdentity(ancestor.parent);
      assert.ok(ancestor && sameProcess(ancestor, this.gatewayIdentity));
      const own = this.goals().find(g => g.id === goal.id);
      assert.equal(own.status, "running");
      await this.publicOwner(own.sessionId, "running");
      await this.suite(B);
      assert.ok(sameProcess(check, processIdentity(pid)));
      const before = this.effects();
      const denied = await this.invoke("agent_goal", { action: "launch", goal: "Complete A denial", workdir: fixture.workdir, verifier_commands: A }, false);
      assert.match(denied.content[0].text, /complete ordered|operator-required/);
      assert.deepEqual(this.effects(), before);
      assert.equal(this.goals().find(g => g.id === goal.id).status, "running");
      assert.ok(sameProcess(check, processIdentity(pid)));
      writeFileSync(join(fixture.workdir, "release"), "release\n");
      const failed = await this.terminal(goal, fixture, "failed");
      assert.match(failed.failureReason, /policy changed|stored suite/i);
      assert.equal(failed.iteration, own.iteration);
      this.checks(fixture, [["CI", 0]]);
      this.proofs.push({ verifierProcess: check, policyFailure: true });
      this.receipt.completed.push("live-policy");
    }
    if (["restore", "all"].includes(selected)) {
      this.stage = "organic-restore";
      await this.suite(A);
      const history = this.goals().filter(g => ["succeeded", "failed", "stopped"].includes(g.status));
      const fixture = this.newCase("restore", { ralph: true, hold: true }), goal = await this.launch(fixture, 3);
      await until(() => fixture.held && fixture.threadId);
      const oldSession = goal.sessionId;
      fixture.oldSessionId = oldSession;
      await this.publicOwner(oldSession, "running");
      fixture.shutdownExpected = true;
      await this.shutdown();
      const saved = this.goals().find(g => g.id === goal.id);
      assert.ok(["running", "waiting_for_session"].includes(saved.status));
      assert.equal(saved.harnessSessionId, fixture.threadId);
      assert.deepEqual(saved.requiredVerifierCommands, A);
      await this.cli(["config", "unset", FIELD]);
      await this.cli(["config", "validate"]);
      assert.equal(Object.hasOwn(json(this.env.OPENCLAW_CONFIG_PATH).plugins.entries["openclaw-code-agent"].config, "requiredGoalVerifierCommands"), false);
      fixture.hold = false;
      fixture.intent = { ...fixture.intent, kind: "restore" };
      fixture.oldTurns = [fixture.turnId]; fixture.turnId = undefined; fixture.call = undefined;
      await this.start();
      const resumed = await until(() => { const current = this.goals().find(g => g.id === goal.id); return current?.sessionId !== oldSession && current; });
      assert.equal(resumed.harnessSessionId, fixture.threadId);
      assert.ok(resumed.sessionId);
      await this.terminal(resumed, fixture, "succeeded");
      this.checks(fixture, [["CI", 0], ["LINT", 0], ["CI", 0]]);
      this.receipt.completed.push("organic-restore");
      for (const previous of history) assert.deepEqual(this.goals().find(g => g.id === previous.id), previous);
      this.proofs.push({ sameGoalId: goal.id, sameNativeThreadId: fixture.threadId, oldSessionId: oldSession, restoredSessionId: resumed.sessionId, historicalRowsCompared: history.map(g => ({ id: g.id, sha256: sha(JSON.stringify(g)) })) });
      if (selected === "all") this.receipt.completed.push("immutable-history");
    }
  }
  async shutdown() {
    const gateway = this.gateway;
    if (!gateway) return;
    const stopped = await stopOwnedChild(gateway, { identity: this.gatewayIdentity, ...this.shutdownOptions });
    if (stopped.complete) this.children.delete(gateway);
    this.gateway = undefined;
    assert.equal(stopped.complete, true, "OWNED_PROCESS_OR_STDIO_SHUTDOWN_FAILED");
    assert.equal(stopped.graceful, true, "GRACEFUL_SHUTDOWN_FAILED");
    await until(() => new Promise(done => { const connection = createConnection({ host: "127.0.0.1", port: this.port }); connection.once("error", () => done(true)); connection.once("connect", () => { connection.destroy(); done(false); }); }));
    this.proofs.push({ ownedShutdown: true, gateway: stopped.targets[0], descendants: stopped.targets.slice(1).map(p => ({ pid: p.pid, startTicks: p.startTicks, executable: p.executable })), listenerClosed: true });
    this.gateway = undefined;
  }
  async settleParentReplies() {
    const history = await this.rpc("chat.history", { sessionKey: this.sessionKey, limit: 100 });
    assert.equal(history.sessionId, this.parentId);
    const runs = new Set(history.messages.filter(m => m.role === "assistant" && m.__openclaw?.runId).map(m => m.__openclaw.runId));
    for (const runId of runs) await this.visible(runId);
    for (const row of this.sessions()) {
      assert.ok(!["failed", "notifying", "wake_pending"].includes(row.deliveryState));
      assert.ok(!(row.notificationDedupe ?? []).some(n => n.status === "in_flight"));
      if (row.completionWakeSummaryFact?.required) { assert.ok(row.completionWakeIssuedAt && row.completionWakeSucceededAt);
        assert.ok(!row.completionWakeFailedAt && !row.completionWakeSkippedAt && !row.completionWakeSkipReason);
        }
    }
  }
  async cleanup() {
    const failures = [];
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
