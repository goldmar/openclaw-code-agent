#!/usr/bin/env node
// Real host/native prerequisites for issue #501. Run remotely in a clean checkout.
// Only the external Responses and Bot API endpoints are deterministic fixtures.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST_VERSION = "2026.9.7";
const HOST_COMMIT = "c074824a27c96d3983043f9eeb33823cd1772d8c";
const NATIVE_VERSION = "0.159.3";
const MODEL = "gpt-6-luna";
const MARKER = "OCA501_NATIVE_PREREQUISITE_OK";
const LABEL = "real pinned OpenClaw + real native Codex + deterministic loopback provider/channel fixtures";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fileHash = (path) => hash(readFileSync(path));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const inside = (parent, path) => { const rel = relative(parent, path); return !rel || (!rel.startsWith("..") && !isAbsolute(rel)); };

function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(["--expected-sha", "--node-version", "--artifacts", "--phase"].includes(argv[i]), `Unknown option ${argv[i]}`);
    assert.ok(argv[i + 1], `Missing value for ${argv[i]}`);
    options[argv[i].slice(2)] = argv[i + 1];
  }
  assert.match(options["expected-sha"] ?? "", /^[a-f0-9]{40}$/);
  assert.ok(["24.16.0", "26.1.0"].includes(options["node-version"]));
  assert.equal(process.versions.node, options["node-version"], "Use the exact supported Node floor");
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64", "This Hetzner fixture pins the Linux x64 native package");
  assert.ok(options.artifacts && isAbsolute(options.artifacts), "--artifacts must be absolute");
  assert.ok(!inside(ROOT, resolve(options.artifacts)), "Keep evidence outside the checkout");
  assert.equal(options.phase ?? "prerequisites", "prerequisites", "Scenario execution is a separate reviewed milestone");
  return options;
}

async function waitFor(description, probe, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

function treeHashes(root) {
  const result = {};
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result[relative(root, path)] = fileHash(path);
      else throw new Error(`Unexpected nonregular package entry ${path}`);
    }
  }
  visit(root);
  return result;
}

class AcceptanceRun {
  constructor(options) {
    this.options = options;
    mkdirSync(options.artifacts, { recursive: true, mode: 0o700 });
    this.directory = mkdtempSync(join(options.artifacts, "oca501-host-"));
    this.children = new Set(); this.servers = new Set(); this.results = []; this.commandCounter = 0;
    this.fixtureErrors = []; this.modelRequests = []; this.botRequests = []; this.botMessages = [];
    this.nativeExecutions = [];
    this.secrets = [randomBytes(24).toString("hex"), "501001:disposable_fixture_token_oca501_only"];
    this.env = Object.fromEntries(["PATH", "LANG", "LC_ALL", "TZ"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
    for (const [key, folder] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "xdg-config", XDG_STATE_HOME: "xdg-state", XDG_DATA_HOME: "xdg-data", XDG_CACHE_HOME: "xdg-cache", CODEX_HOME: "codex", CLAUDE_CONFIG_DIR: "claude", OPENCLAW_STATE_DIR: "state" })) {
      this.env[key] = join(this.directory, folder); mkdirSync(this.env[key], { recursive: true, mode: 0o700 });
    }
    this.env.TMPDIR = join(this.directory, "tmp"); mkdirSync(this.env.TMPDIR, { mode: 0o700 });
    this.env.OPENCLAW_CONFIG_PATH = join(this.directory, "openclaw.json");
    this.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH = join(this.directory, "goals.json");
    this.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH = join(this.directory, "sessions.json");
    this.workspace = join(this.directory, "workspace"); mkdirSync(this.workspace, { mode: 0o700 });
    this.provenance = { candidateSha: options["expected-sha"], nodeVersion: process.versions.node, expectedHostVersion: HOST_VERSION, expectedNativeVersion: NATIVE_VERSION, fixtureBoundary: LABEL };
  }
  redact(value) { let text = String(value); for (const secret of this.secrets) text = text.replaceAll(secret, "[fixture credential]"); return text; }
  artifact(name, value) { writeFileSync(join(this.directory, name), this.redact(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`), { mode: 0o600 }); }
  async command(command, args, { cwd = ROOT, env = this.env, timeoutMs = 180_000 } = {}) {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.children.add(child);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += this.redact(chunk); });
    child.stderr.on("data", (chunk) => { stderr += this.redact(chunk); });
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, timeoutMs);
    try {
      const exit = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal })); });
      this.artifact(`command-${++this.commandCounter}.json`, { command, args, cwd, exit, stdout, stderr });
      assert.equal(exit.code, 0, `${command} ${args.join(" ")} failed (${exit.signal ?? exit.code}): ${(stdout + stderr).slice(-6000)}`);
      return stdout;
    } finally { clearTimeout(timer); this.children.delete(child); }
  }
  async serve(handler) {
    const server = createServer((request, response) => {
      void (async () => {
        let body = ""; for await (const chunk of request) { body += chunk; assert.ok(body.length < 2_000_000); }
        await handler(request, response, body);
      })().catch((error) => {
        this.fixtureErrors.push(String(error));
        if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      });
    });
    await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    this.servers.add(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  observeNativeProcesses(parentPid) {
    const processes = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
    const descendants = new Set([parentPid]);
    for (let previous = -1; previous !== descendants.size;) { previous = descendants.size; for (const [pid, parent] of processes) if (descendants.has(parent)) descendants.add(pid); }
    for (const pid of descendants) {
      try {
        const executable = realpathSync(`/proc/${pid}/exe`);
        if (executable !== this.nativeExecutable) continue;
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ");
        if (!this.nativeExecutions.some((entry) => entry.pid === pid)) this.nativeExecutions.push({ pid, parentPid, executable, sha256: fileHash(executable), startTicks: stat[19] });
      } catch { /* Processes may exit between the observation and proc read. */ }
    }
  }
  async fixtures() {
    this.providerUrl = await this.serve(async (request, response, body) => {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/responses");
      const input = JSON.parse(body); assert.equal(input.model, MODEL); assert.equal(input.stream, true);
      this.modelRequests.push({ path: request.url, bodyHash: hash(body), model: input.model });
      if (this.gateway?.pid) this.observeNativeProcesses(this.gateway.pid);
      const id = `resp_${this.modelRequests.length}`; const itemId = `msg_${this.modelRequests.length}`;
      const item = { id: itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: MARKER, annotations: [], logprobs: [] }] };
      const base = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model: MODEL, status: "in_progress", output: [], error: null, incomplete_details: null };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let sequence = 0;
      const event = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`);
      event("response.created", { response: base });
      event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      event("response.content_part.added", { item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [], logprobs: [] } });
      event("response.output_text.delta", { item_id: itemId, output_index: 0, content_index: 0, delta: MARKER, logprobs: [] });
      event("response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text: MARKER, logprobs: [] });
      event("response.content_part.done", { item_id: itemId, output_index: 0, content_index: 0, part: item.content[0] });
      event("response.output_item.done", { output_index: 0, item });
      event("response.completed", { response: { ...base, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      response.end();
    });
    let messageId = 0;
    this.botUrl = await this.serve(async (request, response, body) => {
      assert.equal(request.method, "POST");
      const method = request.url?.split("/").at(-1);
      assert.ok(request.url?.startsWith(`/bot${this.secrets[1]}/`), "Unexpected Bot API credential/path");
      const params = body ? request.headers["content-type"]?.includes("application/json") ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)) : {};
      this.botRequests.push({ method, params: this.redact(JSON.stringify(params)) });
      const bot = { id: 501001, is_bot: true, first_name: "OCA501 Fixture", username: "oca501_fixture_bot" };
      let result;
      switch (method) {
        case "getMe": result = bot; break;
        case "getUpdates": await delay(250); result = []; break;
        case "getWebhookInfo": result = { url: "", has_custom_certificate: false, pending_update_count: 0 }; break;
        case "getMyCommands": result = []; break;
        case "deleteWebhook": case "setMyCommands": case "answerCallbackQuery": case "editMessageReplyMarkup": case "sendChatAction": result = true; break;
        case "sendMessage": case "editMessageText": {
          result = { message_id: params.message_id ? Number(params.message_id) : ++messageId, date: Math.floor(Date.now() / 1000), from: bot, chat: { id: Number(params.chat_id), type: "private", first_name: "Fixture" }, text: params.text };
          if (params.reply_markup) result.reply_markup = typeof params.reply_markup === "string" ? JSON.parse(params.reply_markup) : params.reply_markup;
          this.botMessages.push(result); break;
        }
        default: throw new Error(`Unimplemented real Bot API endpoint: ${method}`);
      }
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result }));
    });
  }
  async nativePreflight() {
    const child = spawn(this.nativeExecutable, ["app-server", "--listen", "stdio://"], { cwd: this.workspace, env: this.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.children.add(child); this.observeNativeProcesses(child.pid);
    const pending = new Map(); const frames = []; let counter = 0;
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += this.redact(chunk); });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const frame = JSON.parse(line); frames.push(frame);
        if (frame.id != null && pending.has(frame.id)) { const done = pending.get(frame.id); pending.delete(frame.id); done(frame); }
      } catch (error) { this.fixtureErrors.push(`Native output: ${String(error)}`); }
    });
    const request = async (method, params) => {
      const id = ++counter;
      const result = new Promise((done) => pending.set(id, done));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const frame = await Promise.race([result, delay(30_000).then(() => { throw new Error(`Native preflight timed out at ${method}: ${stderr}`); })]);
      assert.equal(frame.error, undefined, JSON.stringify(frame.error)); return frame.result;
    };
    try {
      const initialized = await request("initialize", { clientInfo: { name: "oca501-acceptance", version: "1" }, capabilities: { experimentalApi: true } });
      assert.match(initialized.userAgent, /\/0\.159\.3(?:[\s(]|$)/);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
      const started = await request("thread/start", { cwd: this.workspace, model: MODEL, permissions: ":danger-full-access", approvalPolicy: "never" });
      await request("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "Return the prerequisite marker.", text_elements: [] }] });
      const terminal = await waitFor("genuine native prerequisite turn", () => frames.find((frame) => frame.method === "turn/completed"));
      assert.equal(terminal.params.turn.status, "completed");
      assert.ok(frames.some((frame) => frame.method === "item/agentMessage/delta" && frame.params.delta.includes(MARKER)));
      this.artifact("native-preflight.json", { initialized, threadId: started.thread.id, frames, stderr });
    } finally { lines.close(); await this.stop(child); }
  }
  async stop(child) {
    if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
    const exited = new Promise((done) => child.once("exit", done));
    try { process.kill(-child.pid, "SIGCONT"); process.kill(-child.pid, "SIGTERM"); } catch {}
    const graceful = await Promise.race([exited.then(() => true), delay(8_000).then(() => false)]);
    if (!graceful) { try { process.kill(-child.pid, "SIGKILL"); } catch {} await exited; }
    this.children.delete(child);
  }
  async rpc(method, params = {}) {
    const output = await this.command(process.execPath, [this.hostEntry, "gateway", "call", method, "--params", JSON.stringify(params), "--json", "--url", this.gatewayUrl.replace("http:", "ws:")]);
    return JSON.parse(output.slice(output.indexOf("{")));
  }
  async invoke(name, args, { channel = "webchat", target = "agent:main:main" } = {}) {
    const body = JSON.stringify({ name, args, sessionKey: "agent:main:main" });
    const response = await fetch(`${this.gatewayUrl}/tools/invoke`, { method: "POST", headers: { authorization: `Bearer ${this.secrets[0]}`, "content-type": "application/json", "x-openclaw-message-channel": channel, "x-openclaw-message-to": target }, body, signal: AbortSignal.timeout(90_000) });
    const output = await response.json(); this.artifact(`invoke-${hash(body).slice(0, 12)}.json`, { method: "POST /tools/invoke", requestHash: hash(body), status: response.status, output });
    return { status: response.status, output };
  }
  async setup() {
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), this.options["expected-sha"]);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim(), "", "Acceptance requires a clean exact-head checkout");
    this.provenance.sourceArchiveHash = hash(execFileSync("git", ["archive", "HEAD"], { cwd: ROOT, maxBuffer: 50_000_000 }));
    const hostRoot = realpathSync(join(ROOT, "node_modules/openclaw"));
    const hostPackage = json(join(hostRoot, "package.json")); assert.equal(hostPackage.version, HOST_VERSION);
    this.provenance.hostVersion = hostPackage.version;
    this.hostEntry = join(hostRoot, "openclaw.mjs");
    this.provenance.hostEntryHash = fileHash(this.hostEntry); this.provenance.hostPackageHash = fileHash(join(hostRoot, "package.json"));
    const releaseRef = await fetch(`https://api.github.com/repos/openclaw/openclaw/git/ref/tags/v${HOST_VERSION}`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(releaseRef.status, 200); let object = (await releaseRef.json()).object;
    if (object.type === "tag") { const tag = await fetch(object.url, { signal: AbortSignal.timeout(30_000) }); assert.equal(tag.status, 200); object = (await tag.json()).object; }
    assert.equal(object.type, "commit"); assert.equal(object.sha, HOST_COMMIT);
    this.provenance.upstreamTagCommit = object.sha;
    this.provenance.hostNpmMetadata = JSON.parse(await this.command("npm", ["view", `openclaw@${HOST_VERSION}`, "dist.integrity", "gitHead", "--json"]));
    await this.command("npm", ["install", "--prefix", join(this.directory, "native"), "--no-audit", "--no-fund", `@openai/codex@${NATIVE_VERSION}`]);
    this.nativeExecutable = realpathSync(join(this.directory, "native/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"));
    assert.equal((await this.command(this.nativeExecutable, ["--version"])).trim(), `codex-cli ${NATIVE_VERSION}`);
    this.provenance.nativeVersion = NATIVE_VERSION;
    this.provenance.nativeExecutable = this.nativeExecutable; this.provenance.nativeExecutableHash = fileHash(this.nativeExecutable);
    this.env.OPENCLAW_CODEX_APP_SERVER_COMMAND = this.nativeExecutable;
    await this.fixtures();
    const nativeConfig = `model = "${MODEL}"\nmodel_provider = "oca501"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[model_providers.oca501]\nname = "OCA501 loopback fixture"\nbase_url = "${this.providerUrl}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
    writeFileSync(join(this.env.CODEX_HOME, "config.toml"), nativeConfig, { mode: 0o600 });
    // OCA intentionally filters CODEX_HOME from native children. HOME is retained.
    mkdirSync(join(this.env.HOME, ".codex"), { mode: 0o700 });
    writeFileSync(join(this.env.HOME, ".codex/config.toml"), nativeConfig, { mode: 0o600 });
    await this.nativePreflight();
    await this.command("git", ["init", this.workspace]);
    await this.command("git", ["-C", this.workspace, "-c", "user.name=OCA501 Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Disposable acceptance repository"]);
    writeFileSync(join(this.workspace, "ci.sh"), 'printf "CI\\n" >> receipt.txt\n', { mode: 0o600 });
    await this.command("pnpm", ["build"]);
    const packed = JSON.parse(await this.command("pnpm", ["pack", "--json", "--pack-destination", this.directory]));
    const filename = Array.isArray(packed) ? packed[0].filename : packed.filename;
    const tarball = isAbsolute(filename) ? filename : join(this.directory, filename);
    this.provenance.packageHash = fileHash(tarball);
    const unpacked = join(this.directory, "unpacked"); mkdirSync(unpacked); await this.command("tar", ["-xzf", tarball, "-C", unpacked]);
    this.provenance.packageDistHashes = treeHashes(join(unpacked, "package/dist"));
    const portReservation = createServer(); await new Promise((done) => portReservation.listen(0, "127.0.0.1", done));
    const port = portReservation.address().port; await new Promise((done) => portReservation.close(done));
    this.gatewayUrl = `http://127.0.0.1:${port}`;
    const pluginToolNames = json(join(ROOT, "openclaw.plugin.json")).contracts.tools.filter((name) => name !== "agent_send_plan_offer");
    const config = {
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token: this.secrets[0] }, reload: { mode: "hybrid" } },
      agents: { defaults: { workspace: this.workspace, heartbeat: { every: "0m" }, memorySearch: { enabled: false } } },
      cron: { enabled: false }, discovery: { mdns: { mode: "off" } },
      tools: { profile: "full", allow: pluginToolNames },
      plugins: { allow: ["openclaw-code-agent", "telegram"], slots: { memory: "none" }, entries: { "openclaw-code-agent": { enabled: true, config: { autoUpdate: false, defaultHarness: "codex", defaultWorktreeStrategy: "off", permissionMode: "bypassPermissions", requiredGoalVerifierCommands: ["bash ci.sh"], harnesses: { codex: { defaultModel: MODEL, allowedModels: [MODEL] } } } } } },
      channels: { telegram: { enabled: true, botToken: this.secrets[1], apiRoot: this.botUrl, dmPolicy: "allowlist", allowFrom: ["501002"], streaming: "off" } },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "default" } }],
    };
    writeFileSync(this.env.OPENCLAW_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await this.command(process.execPath, [this.hostEntry, "plugins", "install", tarball, "--force", "--accept-capabilities"]);
    await this.command(process.execPath, [this.hostEntry, "plugins", "enable", "openclaw-code-agent"]);
    const installedRoot = join(this.env.OPENCLAW_STATE_DIR, "extensions/openclaw-code-agent");
    assert.deepEqual(treeHashes(join(installedRoot, "dist")), this.provenance.packageDistHashes, "Installed packed candidate matches every built file");
    assert.equal(fileHash(join(installedRoot, "openclaw.plugin.json")), fileHash(join(unpacked, "package/openclaw.plugin.json")));
    this.provenance.installedEntry = realpathSync(join(installedRoot, "dist/index.js"));
    this.provenance.installedEntryHash = fileHash(this.provenance.installedEntry);
    this.gateway = spawn(process.execPath, [this.hostEntry, "gateway", "run", "--bind", "loopback", "--port", String(port)], { cwd: this.workspace, env: this.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.children.add(this.gateway); this.gatewayLog = "";
    for (const stream of [this.gateway.stdout, this.gateway.stderr]) stream.on("data", (chunk) => { this.gatewayLog += this.redact(chunk); });
    await waitFor("actual pinned Gateway readiness", async () => {
      assert.equal(this.gateway.exitCode, null, this.gatewayLog);
      try { const response = await fetch(`${this.gatewayUrl}/readyz`, { signal: AbortSignal.timeout(2000) }); return response.ok; } catch { return false; }
    });
    this.provenance.gatewayPid = this.gateway.pid;
    this.artifact("tools-effective.json", await this.rpc("tools.effective", { agentId: "main", sessionKey: "agent:main:main" }));
    const effective = readFileSync(join(this.directory, "tools-effective.json"), "utf8");
    for (const name of pluginToolNames) assert.ok(effective.includes(`"${name}"`), `Actual host tool inventory missing ${name}`);
    this.artifact("goal-config-schema.json", await this.rpc("config.schema.lookup", { path: "plugins.entries.openclaw-code-agent.config" }));
    const beforeRequests = this.modelRequests.length;
    const admitted = await this.invoke("agent_goal", { action: "launch", goal: "Return the prerequisite marker; make no edits.", name: "host-prerequisite", workdir: this.workspace, harness: "codex", max_iterations: 1, permission_mode: "bypassPermissions" });
    assert.equal(admitted.status, 200); assert.equal(admitted.output.ok, true); assert.notEqual(admitted.output.result?.isError, true);
    const goals = () => existsSync(this.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH) ? json(this.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH) : [];
    const terminal = await waitFor("real host goal terminal and shell gate", () => goals().find((goal) => goal.name === "host-prerequisite" && ["succeeded", "failed", "stopped"].includes(goal.status)));
    this.artifact("prerequisite-goals.json", goals());
    assert.equal(terminal.status, "succeeded", JSON.stringify(terminal));
    assert.deepEqual(terminal.requiredVerifierCommands, ["bash ci.sh"]);
    assert.equal(readFileSync(join(this.workspace, "receipt.txt"), "utf8"), "CI\n");
    assert.ok(this.modelRequests.length > beforeRequests, "Real native host session reached the loopback provider");
    assert.ok(this.nativeExecutions.some((entry) => entry.parentPid === this.gateway.pid), "Observed genuine native binary spawned by actual Gateway/OCA");
    assert.ok(this.botRequests.some((entry) => entry.method === "getUpdates"), "Actual pinned Telegram adapter polls loopback Bot API");
    assert.deepEqual(this.fixtureErrors, []);
    this.results.push({ ...this.provenance, scenario: "H01-prerequisite", classification: "PASS", command: "actual packed-plugin HTTP goal launch; genuine native Codex; bash ci.sh", exitCode: 0, assertions: ["clean exact source", "pinned host provenance", "packed/installed entry equality", "native protocol preflight", "real Gateway admission and plugin execution", "actual native subprocess identity", "real shell gate succeeded", "actual channel polling"], skips: [], logPath: this.directory });
    this.results.push({ ...this.provenance, scenario: "H01", classification: "UNPROVEN", unprovenReason: "Prerequisite phase does not yet execute the host tool-denial control" });
    for (let id = 2; id <= 12; id++) this.results.push({ scenario: `H${String(id).padStart(2, "0")}`, classification: "UNPROVEN", unprovenReason: "Scenario implementation belongs to the next independently reviewed milestone", ...this.provenance });
  }
  async cleanup() {
    for (const child of [...this.children]) await this.stop(child);
    // OCA launches native app servers in separate process groups. Only stop
    // recorded owned identities, with proc start time protecting against PID reuse.
    for (const entry of this.nativeExecutions) {
      const ownsLiveProcess = () => {
        try { return realpathSync(`/proc/${entry.pid}/exe`) === entry.executable
          && readFileSync(`/proc/${entry.pid}/stat`, "utf8").split(") ").at(-1).split(" ")[19] === entry.startTicks; } catch { return false; }
      };
      if (ownsLiveProcess()) {
        try { process.kill(-entry.pid, "SIGCONT"); process.kill(-entry.pid, "SIGTERM"); } catch {}
        await delay(500);
        if (ownsLiveProcess()) { try { process.kill(-entry.pid, "SIGKILL"); } catch {} }
        await waitFor("owned native process cleanup", () => !ownsLiveProcess(), 5000);
      }
    }
    for (const server of this.servers) { server.closeAllConnections(); await new Promise((done) => server.close(done)); assert.equal(server.listening, false); }
    this.artifact("gateway.log", this.gatewayLog ?? "Gateway not started");
    this.artifact("fixtures.json", { modelRequests: this.modelRequests, botRequests: this.botRequests, botMessages: this.botMessages, fixtureErrors: this.fixtureErrors, nativeExecutions: this.nativeExecutions });
    this.artifact("provenance.json", this.provenance);
    this.artifact("results.json", this.results);
  }
}

let run;
try {
  run = new AcceptanceRun(parseOptions(process.argv.slice(2)));
  await run.setup();
  console.log(`${LABEL}: prerequisite PASS; evidence ${run.directory}`);
} catch (error) {
  if (run) run.results.push({ ...run.provenance, scenario: "H01-prerequisite", classification: "BLOCKED", exitCode: 1, unprovenReason: run.redact(error.stack ?? error), logPath: run.directory });
  console.error(run ? run.redact(error.stack ?? error) : String(error));
  process.exitCode = 1;
} finally { if (run) await run.cleanup(); }
