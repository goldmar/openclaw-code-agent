#!/usr/bin/env node
// Real host/native prerequisites for issue #501. Run remotely in a clean checkout.
// Only the external Responses and Bot API endpoints are deterministic fixtures.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST_VERSION = "2026.9.7";
const HOST_COMMIT = "c074824a27c96d3983043f9eeb33823cd1772d8c";
const NATIVE_VERSION = "0.159.3";
const MODEL = "gpt-6-luna";
const MARKER = "OCA501_NATIVE_PREREQUISITE_OK";
const PARENT_MODEL = `oca501/${MODEL}`;
const PARENT_MARKER = "OCA501_HOST_PROVIDER_OK";
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
  assert.ok(["prerequisites", "matrix-h01-h05"].includes(options.phase ?? "prerequisites"), "Use an explicitly reviewed milestone phase");
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

function assertEffectiveOcaTools(inventory, expected) {
  assert.ok(Array.isArray(inventory.groups), "Actual host inventory has tool groups");
  const entries = inventory.groups.flatMap((group) => {
    assert.ok(Array.isArray(group.tools), "Actual host inventory group has tool entries");
    return group.tools;
  });
  const enabled = entries.filter((entry) => entry.source === "plugin" && entry.pluginId === "openclaw-code-agent" && entry.deniedBySession !== true);
  const ids = enabled.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "Effective OCA inventory has no duplicate IDs");
  assert.deepEqual(ids.toSorted(), [...expected].toSorted(), "Actual enabled OCA tool IDs equal the unchanged public contract");
  return enabled;
}

function verifyInventoryAssertionControls(expected) {
  const enabled = expected.map((id) => ({ id, source: "plugin", pluginId: "openclaw-code-agent" }));
  assert.deepEqual(assertEffectiveOcaTools({ groups: [{ tools: enabled }] }, expected), enabled);
  for (const tools of [[], enabled.map((entry) => ({ ...entry, deniedBySession: true })), enabled.map((entry) => ({ ...entry, pluginId: "unrelated-plugin" })), enabled.map((entry) => ({ ...entry, source: "core" }))]) {
    assert.throws(() => assertEffectiveOcaTools({ toolAccess: { allow: expected }, groups: [{ tools }] }, expected));
  }
  return { scope: "Inventory assertion controls only; these inputs do not simulate host admission", positive: "enabled OCA plugin entries", negatives: ["names only in diagnostics", "session-denied entries", "wrong plugin owner", "wrong tool source"] };
}

function assertNoWorkEffects(before, after) {
  assert.deepEqual(after, before, "Rejected admission changed goals, sessions, provider/native execution or shell receipts");
}

function verifyEffectAssertionControls() {
  const baseline = { goalIds: [], sessionIds: [], confirmationTokenIds: [], nativeRequests: 0, parentRequests: 0, nativeProcesses: 0, receipts: {} };
  assertNoWorkEffects(baseline, structuredClone(baseline));
  const mutations = [
    { goalIds: ["unexpected-goal"] }, { sessionIds: ["unexpected-session"] }, { confirmationTokenIds: ["unexpected-confirmation"] }, { nativeRequests: 1 }, { parentRequests: 1 },
    { nativeProcesses: 1 }, { receipts: { "unexpected/receipt.txt": "CI\n" } },
  ];
  for (const mutation of mutations) assert.throws(() => assertNoWorkEffects(baseline, { ...baseline, ...mutation }));
  return { scope: "Effect assertion controls only, not simulated host execution", positive: "identical snapshot", negatives: mutations.map((entry) => Object.keys(entry)[0]) };
}

class AcceptanceRun {
  constructor(options) {
    this.options = options;
    mkdirSync(options.artifacts, { recursive: true, mode: 0o700 });
    this.directory = mkdtempSync(join(options.artifacts, "oca501-host-"));
    this.children = new Set(); this.servers = new Set(); this.results = []; this.commandCounter = 0;
    this.fixtureErrors = []; this.modelRequests = []; this.botRequests = []; this.botMessages = []; this.botMenus = new Map();
    this.nativeExecutions = []; this.ownedProcesses = new Map();
    this.botUpdates = []; this.updateId = 1000; this.receiptWorkdirs = new Set(); this.patchCounter = 0;
    this.secrets = [randomBytes(24).toString("hex"), "501001:disposable_fixture_token_oca501_only", randomBytes(24).toString("hex")];
    this.env = Object.fromEntries(["PATH", "LANG", "LC_ALL", "TZ"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
    for (const [key, folder] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "xdg-config", XDG_STATE_HOME: "xdg-state", XDG_DATA_HOME: "xdg-data", XDG_CACHE_HOME: "xdg-cache", XDG_RUNTIME_DIR: "xdg-runtime", CODEX_HOME: "codex", CLAUDE_CONFIG_DIR: "claude", OPENCLAW_STATE_DIR: "state" })) {
      this.env[key] = join(this.directory, folder); mkdirSync(this.env[key], { recursive: true, mode: 0o700 });
    }
    this.env.TMPDIR = join(this.directory, "tmp"); mkdirSync(this.env.TMPDIR, { mode: 0o700 });
    this.env.OPENCLAW_CONFIG_PATH = join(this.directory, "openclaw.json");
    this.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH = join(this.directory, "goals.json");
    this.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH = join(this.directory, "sessions.json");
    this.workspace = join(this.directory, "workspace"); mkdirSync(this.workspace, { mode: 0o700 });
    this.receiptWorkdirs.add(this.workspace);
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
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ");
        this.ownedProcesses.set(pid, { pid, parentPid, executable, startTicks: stat[19] });
        if (executable !== this.nativeExecutable) continue;
        if (!this.nativeExecutions.some((entry) => entry.pid === pid)) this.nativeExecutions.push({ pid, parentPid, executable, sha256: fileHash(executable), startTicks: stat[19] });
      } catch { /* Processes may exit between the observation and proc read. */ }
    }
  }
  async fixtures() {
    this.providerUrl = await this.serve(async (request, response, body) => {
      const transport = request.url === "/host/v1/responses" ? "host-parent" : request.url === "/v1/responses" ? "native-codex" : "unexpected";
      const attempt = { httpMethod: request.method, path: request.url, bodyHash: hash(body), transport, receivedAt: new Date().toISOString() };
      this.modelRequests.push(attempt);
      assert.equal(request.method, "POST"); assert.notEqual(transport, "unexpected", "Only the two explicit loopback Responses routes are permitted");
      if (transport === "host-parent") {
        assert.equal(request.headers.authorization, `Bearer ${this.secrets[2]}`, "Genuine parent client uses only the synthetic local API key");
        attempt.authorization = "validated synthetic fixture key";
      }
      const input = JSON.parse(body); assert.equal(input.model, MODEL); assert.equal(input.stream, true);
      attempt.model = input.model;
      this.artifact(`responses-request-${this.modelRequests.length}.json`, { ...attempt, input });
      if (this.gateway?.pid) this.observeNativeProcesses(this.gateway.pid);
      const id = `resp_${this.modelRequests.length}`; const itemId = `msg_${this.modelRequests.length}`;
      const fixture = transport === "native-codex" ? this.nativeFixture : undefined;
      if (fixture) { assert.ok(body.includes(fixture.tag), "Actual native request contains this case's unique goal tag"); attempt.case = fixture.tag; }
      const marker = transport === "host-parent" ? PARENT_MARKER : fixture?.text ?? MARKER;
      let item = { id: itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: marker, annotations: [], logprobs: [] }] };
      if (fixture?.execute && !fixture.commandSent) {
        const names = input.tools?.map((tool) => tool.name ?? tool.function?.name) ?? [];
        const name = ["exec_command", "shell_command"].find((candidate) => names.includes(candidate));
        assert.ok(name, `Genuine native executable must advertise a supported execution tool, got ${names.join(",")}`);
        const command = "printf 'NATIVE-EXEC\\n' | tee -a native-receipt.txt";
        const args = name === "exec_command" ? { cmd: command, login: false } : { command, workdir: fixture.workdir };
        fixture.callId = `oca501_exec_${this.modelRequests.length}`; fixture.commandSent = true;
        item = { id: itemId, type: "function_call", call_id: fixture.callId, name, arguments: JSON.stringify(args) };
        attempt.executionTool = name;
      } else if (fixture?.execute) {
        const output = input.input?.find((entry) => entry.type === "function_call_output" && entry.call_id === fixture.callId);
        assert.ok(output, "Actual native command sent a matching function_call_output");
        assert.ok(JSON.stringify(output.output).includes("NATIVE-EXEC"), "Actual native tool output includes the receipt marker");
        assert.equal(readFileSync(join(fixture.workdir, "native-receipt.txt"), "utf8"), "NATIVE-EXEC\n");
        attempt.nativeExecutionOutput = output; fixture.executionProved = true;
      }
      const base = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model: MODEL, status: "in_progress", output: [], error: null, incomplete_details: null };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let sequence = 0;
      const event = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`);
      event("response.created", { response: base });
      event("response.output_item.added", { output_index: 0, item: item.type === "message" ? { ...item, status: "in_progress", content: [] } : item });
      if (item.type === "message") {
        event("response.content_part.added", { item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [], logprobs: [] } });
        event("response.output_text.delta", { item_id: itemId, output_index: 0, content_index: 0, delta: marker, logprobs: [] });
        event("response.output_text.done", { item_id: itemId, output_index: 0, content_index: 0, text: marker, logprobs: [] });
        event("response.content_part.done", { item_id: itemId, output_index: 0, content_index: 0, part: item.content[0] });
      }
      event("response.output_item.done", { output_index: 0, item });
      event("response.completed", { response: { ...base, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      response.end();
      attempt.responseCompleted = true;
    });
    let messageId = 0;
    this.botUrl = await this.serve(async (request, response, body) => {
      const url = new URL(request.url, this.botUrl);
      const method = url.pathname.split("/").at(-1);
      const attempt = { httpMethod: request.method, url: this.redact(request.url), method, bodyHash: hash(body) };
      this.botRequests.push(attempt); // Preserve the real wire attempt even if validation or parsing fails.
      assert.equal(url.pathname, `/bot${this.secrets[1]}/${method}`, "Unexpected Bot API credential/path");
      assert.ok(request.method === "POST" || (request.method === "GET" && ["getMe", "getWebhookInfo"].includes(method)), "Unexpected Bot API HTTP method");
      if (request.method === "GET") assert.equal(body, "", "Telegram GET probes carry no body");
      const params = request.method === "GET" ? Object.fromEntries(url.searchParams) : body ? request.headers["content-type"]?.includes("application/json") ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)) : {};
      attempt.params = this.redact(JSON.stringify(params));
      const objectParam = (value) => typeof value === "string" ? JSON.parse(value) : value;
      const menuKey = JSON.stringify({ scope: objectParam(params.scope) ?? { type: "default" }, language_code: params.language_code ?? "" });
      const bot = { id: 501001, is_bot: true, first_name: "OCA501 Fixture", username: "oca501_fixture_bot" };
      let result;
      switch (method) {
        case "getMe": result = bot; break;
        case "getUpdates": {
          const offset = Number(params.offset ?? 0); assert.ok(Number.isSafeInteger(offset));
          this.botUpdates = this.botUpdates.filter((entry) => entry.update_id >= offset);
          if (!this.botUpdates.length) await delay(250);
          result = this.botUpdates.slice(0, Math.min(Number(params.limit ?? 100), 100)); break;
        }
        case "getWebhookInfo": result = { url: "", has_custom_certificate: false, pending_update_count: 0 }; break;
        case "getMyCommands": result = this.botMenus.get(menuKey) ?? []; break;
        case "setMyCommands": {
          const commands = objectParam(params.commands); assert.ok(Array.isArray(commands));
          this.botMenus.set(menuKey, commands); result = true; break;
        }
        case "deleteMyCommands": this.botMenus.delete(menuKey); result = true; break;
        case "editMessageReplyMarkup": {
          const existing = this.botMessages.findLast((entry) => entry.message_id === Number(params.message_id) && entry.chat.id === Number(params.chat_id));
          assert.ok(existing, "Edit markup for a real fixture-delivered bot message");
          existing.reply_markup = objectParam(params.reply_markup) ?? { inline_keyboard: [] }; result = existing; break;
        }
        case "deleteWebhook": case "answerCallbackQuery": case "sendChatAction": result = true; break;
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
    } finally { lines.close(); this.observeNativeProcesses(child.pid); await this.stop(child); }
  }
  async stop(child) {
    if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
    const exited = new Promise((done) => child.once("exit", done));
    try { process.kill(-child.pid, "SIGCONT"); process.kill(-child.pid, "SIGTERM"); } catch {}
    const graceful = await Promise.race([exited.then(() => true), delay(8_000).then(() => false)]);
    if (!graceful) { try { process.kill(-child.pid, "SIGKILL"); } catch {} await exited; }
    this.children.delete(child);
  }
  async rpc(method, params = {}, { timeoutMs } = {}) {
    // Use only the isolated config target/auth; URL overrides require explicit auth.
    const output = await this.command(process.execPath, [this.hostEntry, "gateway", "call", method, "--params", JSON.stringify(params), "--json", ...(timeoutMs ? ["--timeout", String(timeoutMs - 5000)] : [])], timeoutMs ? { timeoutMs } : {});
    return JSON.parse(output.slice(output.indexOf("{")));
  }
  async invoke(name, args, { channel = "webchat", target = this.sessionKey } = {}) {
    assert.ok(this.sessionKey, "Use an actual host-created session");
    const body = JSON.stringify({ name, args, sessionKey: this.sessionKey });
    const response = await fetch(`${this.gatewayUrl}/tools/invoke`, { method: "POST", headers: { authorization: `Bearer ${this.secrets[0]}`, "content-type": "application/json", "x-openclaw-message-channel": channel, "x-openclaw-message-to": target, "x-openclaw-account-id": "default" }, body, signal: AbortSignal.timeout(90_000) });
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
    // Both supported native config homes remain confined to this disposable run.
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
    this.artifact("inventory-assertion-controls.json", verifyInventoryAssertionControls(pluginToolNames));
    this.artifact("effect-assertion-controls.json", verifyEffectAssertionControls());
    this.pluginToolNames = pluginToolNames;
    const config = {
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token: this.secrets[0] }, reload: { mode: "hybrid" } },
      logging: { file: join(this.directory, "openclaw-runtime.log") },
      models: { mode: "replace", catalogRefresh: { enabled: false }, providers: { oca501: {
        baseUrl: `${this.providerUrl}/host/v1`, api: "openai-responses", auth: "api-key", apiKey: this.secrets[2], request: { allowPrivateNetwork: true },
        models: [{ id: MODEL, name: "OCA501 Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 4096 }],
      } } },
      agents: { defaults: {
        workspace: this.workspace, heartbeat: { every: "0m" }, model: { primary: PARENT_MODEL, fallbacks: [] }, modelPolicy: { allow: [PARENT_MODEL] },
        utilityModel: PARENT_MODEL, decisionModel: "", experimental: { decisionAssistance: false }, thinkingDefault: "off", fastModeDefault: false,
        embeddedAgent: { cyberFailover: { mode: "off" } }, compaction: { enabled: false, memoryFlush: { enabled: false }, postIndexSync: "off" },
      } },
      memory: { search: { enabled: false } },
      cron: { enabled: false }, discovery: { mdns: { mode: "off" } },
      tools: { profile: "full", allow: pluginToolNames },
      plugins: { allow: ["openclaw-code-agent", "telegram"], slots: { memory: "none" }, entries: { "openclaw-code-agent": { enabled: true, config: { autoUpdate: false, defaultHarness: "codex", defaultWorktreeStrategy: "off", permissionMode: "bypassPermissions", requiredGoalVerifierCommands: ["bash ci.sh"], harnesses: { codex: { defaultModel: MODEL, allowedModels: [MODEL] } } } } } },
      channels: { telegram: { enabled: true, botToken: this.secrets[1], apiRoot: this.botUrl, dmPolicy: "allowlist", allowFrom: ["501002"], streaming: { mode: "off" } } },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "default" } }],
    };
    writeFileSync(this.env.OPENCLAW_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    // OCA's genuine chat.inject/agent.wait subprocesses invoke `openclaw` by
    // name. Expose the unmodified pinned package bin, never a test CLI shim.
    assert.equal(hostPackage.version, HOST_VERSION);
    assert.equal(typeof hostPackage.bin?.openclaw, "string");
    const officialEntry = realpathSync(resolve(hostRoot, hostPackage.bin.openclaw));
    assert.ok(inside(realpathSync(hostRoot), officialEntry), "Official CLI bin stays inside the pinned package");
    assert.equal(officialEntry, realpathSync(this.hostEntry));
    assert.equal(fileHash(officialEntry), this.provenance.hostEntryHash);
    accessSync(officialEntry, constants.X_OK);
    assert.equal(readFileSync(officialEntry, "utf8").split("\n")[0], "#!/usr/bin/env node");
    this.officialCliDirectory = join(this.directory, "official-cli");
    mkdirSync(this.officialCliDirectory, { mode: 0o700 });
    const officialCli = join(this.officialCliDirectory, "openclaw");
    symlinkSync(officialEntry, officialCli);
    assert.equal(realpathSync(officialCli), officialEntry);
    this.env.PATH = [this.officialCliDirectory, dirname(process.execPath), this.env.PATH].filter(Boolean).join(":");
    const resolvedNode = (await this.command("node", ["-p", "process.execPath"])).trim();
    assert.equal(realpathSync(resolvedNode), realpathSync(process.execPath), "Official env-node shebang resolves the exact supported Node binary");
    const resolvedNodeVersion = (await this.command("node", ["--version"])).trim();
    assert.equal(resolvedNodeVersion, `v${this.options["node-version"]}`);
    const officialVersion = (await this.command("openclaw", ["--version"])).trim();
    assert.match(officialVersion, /(?:^|\s)2026\.9\.7(?:\s|$|\()/);
    this.provenance.officialCli = { launcher: officialCli, entry: officialEntry, entryHash: fileHash(officialEntry), version: officialVersion, nodeExecutable: resolvedNode, nodeHash: fileHash(resolvedNode), nodeVersion: resolvedNodeVersion };
    this.artifact("official-cli-path.json", this.provenance.officialCli);
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
    this.gatewayInstance = await this.hostIdentity();
    this.artifact("host-process-profile-identity.json", this.gatewayInstance);
    const loadedConfig = await this.rpc("config.get");
    const loadedModels = loadedConfig.config.models;
    const loadedDefaults = loadedConfig.config.agents.defaults;
    assert.equal(loadedModels.mode, "replace"); assert.deepEqual(Object.keys(loadedModels.providers), ["oca501"]);
    assert.equal(loadedModels.providers.oca501.baseUrl, `${this.providerUrl}/host/v1`);
    assert.equal(loadedModels.providers.oca501.request.allowPrivateNetwork, true);
    assert.equal(loadedModels.catalogRefresh.enabled, false);
    assert.deepEqual(loadedDefaults.model, { primary: PARENT_MODEL, fallbacks: [] });
    assert.deepEqual(loadedDefaults.modelPolicy.allow, [PARENT_MODEL]); assert.equal(loadedDefaults.utilityModel, PARENT_MODEL);
    assert.equal(loadedDefaults.decisionModel, ""); assert.equal(loadedDefaults.experimental.decisionAssistance, false);
    assert.equal(loadedDefaults.embeddedAgent.cyberFailover.mode, "off");
    this.artifact("model-isolation-config.json", { configHash: loadedConfig.hash, parentBaseUrl: loadedModels.providers.oca501.baseUrl, modelMode: loadedModels.mode, configuredProviders: Object.keys(loadedModels.providers), catalogRefresh: loadedModels.catalogRefresh, primaryAndFallbacks: loadedDefaults.model, modelPolicy: loadedDefaults.modelPolicy, utilityModel: loadedDefaults.utilityModel, decisionModel: loadedDefaults.decisionModel, experimental: loadedDefaults.experimental, embeddedAgent: loadedDefaults.embeddedAgent, compaction: loadedDefaults.compaction, nativeBaseUrl: `${this.providerUrl}/v1`, limits: "Provider account/model inference and real Telegram service acceptance remain unproven; fixture responses are deterministic" });
    // Genuine host creation with no initial turn or naming prompt materializes
    // the canonical WebChat session. Do not fabricate host storage/context.
    const beforeCreationRequests = this.modelRequests.length;
    // This fresh, one-shot bootstrap uses the normal creation path. Optional
    // creation idempotency requires a principal/device this token CLI lacks.
    const created = await this.rpc("sessions.create", { key: "agent:main:main", agentId: "main" });
    this.artifact("host-session-created.json", created);
    assert.equal(created.ok, true); assert.equal(created.key, "agent:main:main");
    assert.ok(created.sessionId); assert.ok(created.entry); assert.equal(created.runStarted, false);
    assert.equal(this.modelRequests.length, beforeCreationRequests, "Host session creation starts no model turn");
    this.sessionKey = created.key;
    assert.ok(this.gatewayLog.includes(`agent model: ${PARENT_MODEL}`), "Actual Gateway reports the isolated parent model");
    const modelSession = await this.rpc("sessions.list", { agentId: "main", limit: 10 });
    this.artifact("parent-model-session-before.json", modelSession);
    const effectiveSession = modelSession.sessions.find((entry) => entry.key === this.sessionKey);
    assert.ok(effectiveSession, "Real host lists the created parent session");
    assert.equal(effectiveSession.modelProvider, "oca501"); assert.equal(effectiveSession.model, MODEL);
    if (effectiveSession.activeModelProvider !== undefined) assert.equal(effectiveSession.activeModelProvider, "oca501");
    if (effectiveSession.activeModel !== undefined) assert.equal(effectiveSession.activeModel, MODEL);
    const effective = await this.rpc("tools.effective", { agentId: "main", sessionKey: this.sessionKey });
    this.artifact("tools-effective.json", effective);
    const enabledOcaTools = assertEffectiveOcaTools(effective, pluginToolNames);
    this.artifact("tools-effective-oca-enabled.json", { expectedIds: pluginToolNames.toSorted(), effectiveIds: enabledOcaTools.map((entry) => entry.id).toSorted(), entries: enabledOcaTools });
    this.artifact("goal-config-schema.json", await this.rpc("config.schema.lookup", { path: "plugins.entries.openclaw-code-agent.config" }));
    // Exercise the genuine embedded parent client, not only its configuration.
    const beforeParentProbe = this.modelRequests.length;
    const nativeRequestsBefore = this.modelRequests.filter((entry) => entry.transport === "native-codex").length;
    const parentRun = await this.rpc("chat.send", { sessionKey: this.sessionKey, agentId: "main", message: `Reply exactly ${PARENT_MARKER}. Use no tools.`, thinking: "off", deliver: false, idempotencyKey: `oca501-parent-${randomBytes(12).toString("hex")}` });
    this.artifact("parent-probe-admission.json", parentRun);
    assert.ok(parentRun.runId, "Real host accepted a parent turn");
    const parentHistory = await waitFor("genuine parent loopback turn in canonical history", async () => {
      if (!this.modelRequests.slice(beforeParentProbe).some((entry) => entry.transport === "host-parent" && entry.responseCompleted)) return false;
      const history = await this.rpc("chat.history", { sessionKey: this.sessionKey, agentId: "main", limit: 10 });
      return history.messages.some((entry) => entry.role === "assistant" && entry.content?.some((part) => part.type === "text" && part.text === PARENT_MARKER)) ? history : false;
    });
    const parentRequests = this.modelRequests.slice(beforeParentProbe);
    assert.ok(parentRequests.length > 0); assert.ok(parentRequests.every((entry) => entry.transport === "host-parent" && entry.authorization === "validated synthetic fixture key"));
    assert.equal(this.modelRequests.filter((entry) => entry.transport === "native-codex").length, nativeRequestsBefore, "Parent probe starts no native Codex turn");
    assert.ok(!existsSync(this.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH), "Parent marker turn launches no goal");
    const parentTerminal = await this.rpc("agent.wait", { runId: parentRun.runId, timeoutMs: 5000 });
    assert.equal(parentTerminal.status, "ok", "Genuine host parent run reached successful terminal state");
    const parentSessionAfter = await this.rpc("sessions.list", { agentId: "main", limit: 10 });
    const afterRow = parentSessionAfter.sessions.find((entry) => entry.key === this.sessionKey);
    assert.equal(afterRow?.sessionId, created.sessionId); assert.equal(afterRow.modelProvider, "oca501"); assert.equal(afterRow.model, MODEL);
    if (afterRow.activeModelProvider !== undefined) assert.equal(afterRow.activeModelProvider, "oca501");
    if (afterRow.activeModel !== undefined) assert.equal(afterRow.activeModel, MODEL);
    this.artifact("parent-loopback-probe.json", { run: parentRun, terminal: parentTerminal, history: parentHistory, effectiveSession: afterRow, requests: parentRequests, model: PARENT_MODEL, fixtureBoundary: "Actual embedded host provider/client; only external Responses output is deterministic" });
    this.provenance.parentModel = PARENT_MODEL; this.provenance.parentProviderBaseUrl = `${this.providerUrl}/host/v1`;
    const beforeRequests = this.modelRequests.length;
    const admitted = await this.invoke("agent_goal", { action: "launch", goal: "Return the prerequisite marker; make no edits.", name: "host-prerequisite", workdir: this.workspace, harness: "codex", max_iterations: 1, permission_mode: "bypassPermissions" });
    assert.equal(admitted.status, 200); assert.equal(admitted.output.ok, true); assert.notEqual(admitted.output.result?.isError, true);
    const goals = () => existsSync(this.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH) ? json(this.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH) : [];
    const terminal = await waitFor("real host goal terminal and shell gate", () => goals().find((goal) => goal.name === "host-prerequisite" && ["succeeded", "failed", "stopped"].includes(goal.status)));
    this.artifact("prerequisite-goals.json", goals());
    assert.equal(terminal.status, "succeeded", JSON.stringify(terminal));
    assert.deepEqual(terminal.requiredVerifierCommands, ["bash ci.sh"]);
    assert.equal(readFileSync(join(this.workspace, "receipt.txt"), "utf8"), "CI\n");
    assert.ok(this.modelRequests.slice(beforeRequests).some((entry) => entry.transport === "native-codex" && entry.responseCompleted), "Real native host session reached its distinct loopback provider");
    assert.ok(this.nativeExecutions.some((entry) => entry.parentPid === this.gateway.pid), "Observed genuine native binary spawned by actual Gateway/OCA");
    assert.ok(this.botRequests.some((entry) => entry.method === "getUpdates"), "Actual pinned Telegram adapter polls loopback Bot API");
    assert.deepEqual(this.fixtureErrors, []);
    this.results.push({ ...this.provenance, scenario: "H01-prerequisite", classification: "PASS", command: "actual packed-plugin HTTP goal launch; genuine native Codex; bash ci.sh", exitCode: 0, assertions: ["clean exact source", "pinned host provenance", "packed/installed entry equality", "native protocol preflight", "real Gateway admission and plugin execution", "actual native subprocess identity", "real shell gate succeeded", "actual channel polling"], skips: [], logPath: this.directory });
    this.results.push({ ...this.provenance, scenario: "H01", classification: "UNPROVEN", unprovenReason: "Prerequisite phase does not yet execute the host tool-denial control" });
    for (let id = 2; id <= 12; id++) this.results.push({ scenario: `H${String(id).padStart(2, "0")}`, classification: "UNPROVEN", unprovenReason: "Scenario implementation belongs to the next independently reviewed milestone", ...this.provenance });
    if (this.options.phase === "matrix-h01-h05") await this.matrixH01H05();
  }
  goals() { return existsSync(this.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH) ? json(this.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH) : []; }
  sessions() { return existsSync(this.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH) ? json(this.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH).sessions : []; }
  effects() {
    this.observeNativeProcesses(this.gateway.pid);
    const receipts = {};
    for (const workdir of this.receiptWorkdirs) for (const name of ["receipt.txt", "native-receipt.txt"]) {
      const path = join(workdir, name); if (existsSync(path)) receipts[relative(this.directory, path)] = readFileSync(path, "utf8");
    }
    const tokens = existsSync(this.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH) ? json(this.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH).actionTokens : [];
    return { goalIds: this.goals().map((goal) => goal.id).toSorted(), sessionIds: this.sessions().map((session) => session.sessionId).toSorted(), confirmationTokenIds: tokens.filter((token) => ["goal-verifiers-confirm", "goal-verifiers-decline"].includes(token.kind)).map((token) => token.id).toSorted(), nativeRequests: this.modelRequests.filter((request) => request.transport === "native-codex").length, parentRequests: this.modelRequests.filter((request) => request.transport === "host-parent").length, nativeProcesses: this.nativeExecutions.length, receipts };
  }
  recordCase(id, evidence) {
    this.currentScenario = id;
    this.artifact(`${id}.json`, evidence);
    this.results.push({ ...this.provenance, scenario: id, classification: "PASS", command: "Actual Gateway tools/Telegram ingress + genuine native Codex + real shell receipts", exitCode: 0, assertions: evidence.assertions, skips: [], logPath: join(this.directory, `${id}.json`) });
  }
  async patch(raw, replacePaths) {
    const before = await this.rpc("config.get");
    const identity = this.ownedProcessIdentity(this.gateway.pid);
    const changed = await this.rpc("config.patch", { raw: JSON.stringify(raw), baseHash: before.hash, replacePaths });
    this.artifact(`config-patch-${++this.patchCounter}.json`, { beforeHash: before.hash, replacePaths, raw, result: changed });
    assert.equal(changed.ok, true); assert.ok(changed.hash && changed.hash !== before.hash, "Narrow patch must change the config hash");
    assert.ok(changed.changedPaths?.some((path) => replacePaths.includes(path)), "Host acknowledges the intended changed path");
    assert.equal(changed.sentinel?.payload?.stats?.requiresRestart, false, "Fixture policy changes must not restart the Gateway");
    // At this pin, successful hot config.patch waits writeResult.application;
    // persistence-only/not-applied writes return UNAVAILABLE, never this ACK.
    const applied = await this.rpc("config.get"); assert.equal(applied.hash, changed.hash, "Actual host reads back the applied config revision");
    assert.deepEqual(this.ownedProcessIdentity(this.gateway.pid), identity, "Same actual Gateway identity after patch");
    return changed;
  }
  async suite(commands, trusted = []) {
    const base = "plugins.entries.openclaw-code-agent.config";
    const fields = { requiredGoalVerifierCommands: commands ?? null, trustedVerifierCommands: trusted };
    await this.patch({ plugins: { entries: { "openclaw-code-agent": { config: fields } } } }, Object.keys(fields).map((key) => `${base}.${key}`));
    this.activeSuite = commands;
  }
  ownedProcessIdentity(pid) {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ");
    return { pid, executable: realpathSync(`/proc/${pid}/exe`), startTicks: stat[19] };
  }
  async hostIdentity() {
    this.observeNativeProcesses(this.gateway.pid);
    const status = await this.rpc("status", { includeChannelSummary: false });
    const pid = status.pid; assert.ok(Number.isSafeInteger(pid));
    assert.ok(pid === this.gateway.pid || this.ownedProcesses.has(pid), "Actual Gateway status PID is an owned process descendant");
    const port = Number(new URL(this.gatewayUrl).port);
    const sockets = new Set(["/proc/net/tcp", "/proc/net/tcp6"].flatMap((path) => readFileSync(path, "utf8").trim().split("\n").slice(1).map((line) => line.trim().split(/\s+/))).filter((fields) => fields[3] === "0A" && parseInt(fields[1].split(":")[1], 16) === port).map((fields) => `socket:[${fields[9]}]`));
    assert.ok(readdirSync(`/proc/${pid}/fd`).some((fd) => { try { return sockets.has(readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { return false; } }), "Actual owned Gateway PID owns the loopback listener");
    const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((entry) => { const index = entry.indexOf("="); return [entry.slice(0, index), entry.slice(index + 1)]; }));
    const profile = {};
    for (const key of ["HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "CODEX_HOME"]) {
      assert.equal(env[key], this.env[key], `Actual Gateway ${key} belongs to this disposable profile`); assert.ok(inside(this.directory, env[key])); profile[key] = env[key];
    }
    assert.equal(env.PATH, this.env.PATH, "Actual owned Gateway inherits only the corrected disposable PATH");
    assert.equal(env.PATH.split(":")[0], this.officialCliDirectory);
    assert.equal(realpathSync(join(this.officialCliDirectory, "openclaw")), this.provenance.officialCli.entry);
    assert.equal(fileHash(this.provenance.officialCli.entry), this.provenance.officialCli.entryHash);
    profile.officialCliDirectory = this.officialCliDirectory;
    assert.equal(fileHash(this.provenance.installedEntry), this.provenance.installedEntryHash, "Owned host keeps the exact packed candidate entry");
    return { ...this.ownedProcessIdentity(pid), listenerPort: port, profile, installedEntry: this.provenance.installedEntry, installedEntryHash: this.provenance.installedEntryHash };
  }
  async workdir(id, { ciExit = 0, lintExit = 0, ciLabel = "CI" } = {}) {
    const workdir = join(this.workspace, id); mkdirSync(workdir, { mode: 0o700 }); this.receiptWorkdirs.add(workdir);
    await this.command("git", ["init", workdir]);
    writeFileSync(join(workdir, "ci.sh"), `printf '${ciLabel}\\n' >> receipt.txt\nexit ${ciExit}\n`, { mode: 0o600 });
    writeFileSync(join(workdir, "lint.sh"), `printf 'LINT\\n' >> receipt.txt\nexit ${lintExit}\n`, { mode: 0o600 });
    writeFileSync(join(workdir, "weak.sh"), "printf 'WEAK\\n' >> receipt.txt\n", { mode: 0o600 });
    return workdir;
  }
  goalArgs(id, workdir, extra = {}) {
    return { action: "launch", name: id.toLowerCase(), goal: `OCA501_CASE_${id}: Return the fixed marker and perform only the supplied harmless fixture action.`, workdir, harness: "codex", permission_mode: "bypassPermissions", max_iterations: 1, ...extra };
  }
  async terminal(id, workdir, { status = "succeeded", receipt = "CI\n", commands, execute = false } = {}) {
    const task = await waitFor(`actual ${id} terminal`, () => this.goals().find((goal) => goal.name === id.toLowerCase() && ["succeeded", "failed", "stopped"].includes(goal.status)));
    assert.equal(task.status, status, JSON.stringify(task));
    assert.equal(existsSync(join(workdir, "receipt.txt")) ? readFileSync(join(workdir, "receipt.txt"), "utf8") : "", receipt);
    if (commands) { assert.deepEqual(task.verifierCommands.map((step) => step.command), commands); assert.deepEqual(task.requiredVerifierCommands, commands); }
    if (execute) assert.equal(this.nativeFixture.executionProved, true, "Actual advertised native execution and function_call_output were observed");
    await this.settleGoalDelivery(task);
    return task;
  }
  async settleGoalDelivery(task) {
    if (!task.sessionId) return;
    const terminalLabel = task.status === "succeeded" ? "goal-task-succeeded" : task.status === "failed" ? "goal-task-failed" : "goal-task-stopped";
    const evidence = { goalId: task.id, sessionId: task.sessionId, expectedLabel: terminalLabel, expectedOutcome: `goal:${task.id}` };
    let lastState;
    const observe = (row) => {
      const blockers = [];
      if (!row) blockers.push("own persisted session row missing");
      else {
        if (["notifying", "wake_pending"].includes(row.deliveryState)) blockers.push(`deliveryState=${row.deliveryState}`);
        if (row.notificationDedupe?.some((entry) => entry.status === "in_flight")) blockers.push("notification in flight");
        if (!row.notificationDedupe?.some((entry) => entry.label === terminalLabel && entry.status === "delivered")) blockers.push("own terminal notification not delivered");
        if (task.status === "succeeded" && row.completionWakeOutcomeKey !== evidence.expectedOutcome) blockers.push("required completion outcome identity missing/mismatched");
        if (task.status === "succeeded" && !row.completionWakeSucceededAt) blockers.push("required completion wake success unproven");
        if (row.completionWakeRunId && !row.completionWakeSucceededAt && !row.completionWakeSkippedAt) blockers.push("retained completion run not settled");
        if (row.completionWakeFailedAt) blockers.push("required completion delivery failed");
      }
      if (task.route?.provider === "telegram" && !this.botMessages.some((message) => message.chat.id === 501002 && message.text?.includes(`[${task.name}] Goal task ${task.status}`))) blockers.push("correlated Telegram terminal message missing");
      const state = { row, blockers };
      if (JSON.stringify(state) !== lastState) {
        lastState = JSON.stringify(state);
        Object.assign(evidence, state, { observedAt: new Date().toISOString() });
        this.artifact(`settlement-${task.id}.json`, evidence);
      }
      return blockers;
    };
    let session;
    try {
      session = await waitFor(`actual ${task.name} delivery settled`, async () => {
        const row = this.sessions().find((entry) => entry.sessionId === task.sessionId);
        const blockers = observe(row);
        if (row?.completionWakeFailedAt) throw new Error(`Actual completion delivery failed: ${JSON.stringify(row)}`);
        if (blockers.length) return false;
        if (row.completionWakeRunId) {
          const terminal = await this.rpc("agent.wait", { runId: row.completionWakeRunId, timeoutMs: 1000 });
          if (terminal.status === "timeout" || terminal.status === "pending") return false;
          assert.equal(terminal.status, "ok", "Actual completion parent run succeeded");
          this.artifact(`delivery-${task.id}.json`, { session: row, terminal });
        }
        if (task.route?.provider === "telegram") {
          const delivered = this.botMessages.findLast((message) => message.chat.id === 501002 && message.text?.includes(`[${task.name}] Goal task ${task.status}`));
          if (!delivered) return false;
          this.artifact(`telegram-terminal-${task.id}.json`, delivered);
        }
        return row;
      });
    } catch (error) {
      // Observe the exact retained obligation without sending/retrying any
      // parent work. Diagnostics cannot turn the original failure into PASS.
      try {
        const row = this.sessions().find((entry) => entry.sessionId === task.sessionId);
        observe(row);
        evidence.error = String(error); evidence.goal = this.goals().find((goal) => goal.id === task.id);
        if (row?.completionWakeRunId) {
          try { evidence.retainedRunTerminal = await this.rpc("agent.wait", { runId: row.completionWakeRunId, timeoutMs: 5000 }, { timeoutMs: 15_000 }); }
          catch (diagnosticError) { evidence.retainedRunError = String(diagnosticError); }
        }
        const origin = row?.originSessionKey ?? task.originSessionKey ?? task.route?.sessionKey;
        if (origin) {
          try { evidence.originHistory = await this.rpc("chat.history", { sessionKey: origin, agentId: "main", limit: 20 }, { timeoutMs: 15_000 }); }
          catch (diagnosticError) { evidence.originHistoryError = String(diagnosticError); }
        }
        evidence.requestReceipts = this.modelRequests.map((request, index) => ({ index: index + 1, transport: request.transport, case: request.case, receivedAt: request.receivedAt, responseCompleted: request.responseCompleted, path: join(this.directory, `responses-request-${index + 1}.json`) }));
        this.artifact(`settlement-${task.id}.json`, evidence);
      } catch (diagnosticError) {
        console.error(this.redact(`Settlement diagnostics failed: ${String(diagnosticError)}`));
      }
      throw error;
    }
    this.artifact(`session-${task.id}.json`, session);
  }
  async launchCase(id, { commands, extra = {}, expected = {}, script = {}, text = MARKER, execute = false, slash = false } = {}) {
    this.currentScenario = id;
    const workdir = await this.workdir(id, script);
    this.nativeFixture = { tag: `OCA501_CASE_${id}`, text, execute, workdir };
    const args = this.goalArgs(id, workdir, extra);
    const before = this.effects();
    let admission;
    if (slash) {
      const flags = Object.entries(extra).flatMap(([key, value]) => key === "verifier_commands" ? value.map((command) => `--verify ${JSON.stringify(command)}`) : [`--${key.replaceAll("_", "-")} ${JSON.stringify(value)}`]).join(" ");
      const command = `/agent_goal --name ${id.toLowerCase()} --workdir ${JSON.stringify(workdir)} --harness codex --permission-mode bypassPermissions --max-iterations 1 ${flags} ${args.goal}`;
      admission = await this.slash(command);
    } else {
      admission = await this.invoke("agent_goal", args, { channel: "telegram", target: "501002" });
      assert.equal(admission.status, 200); assert.equal(admission.output.ok, true); assert.notEqual(admission.output.result?.isError, true);
    }
    const task = await this.terminal(id, workdir, { commands, execute, ...expected });
    if (!commands) assert.equal(task.requiredVerifierCommands, undefined, "Default compatibility goal is not implicitly operator-bound");
    if (extra.verifier_commands && !commands) assert.deepEqual(task.verifierCommands.map((step) => step.command), extra.verifier_commands.map((command) => command.trim()));
    if (extra.goal_mode) assert.equal(task.loopMode, extra.goal_mode);
    else if (commands || extra.verifier_commands) assert.equal(task.loopMode, "verifier", "Omitted mode follows supplied/mandatory verifiers");
    const after = this.effects();
    assert.equal(after.goalIds.length, before.goalIds.length + 1); assert.equal(after.sessionIds.length, before.sessionIds.length + 1);
    assert.ok(after.nativeRequests > before.nativeRequests, "Genuine native provider requests increased on authorized launch");
    assert.deepEqual(after.confirmationTokenIds, before.confirmationTokenIds, "Authorized preapproved/typed launch required no verifier confirmation");
    this.recordCase(id, { admission, task, before, after, fixture: this.nativeFixture, assertions: ["one real admitted goal/session", "genuine native provider execution", "actual terminal state", "exact append-only shell receipt", "actual delivery settlement"] });
    return task;
  }
  async deniedCase(id, verifierCommands, { slash = false, expectedHostDeny = false, extra = {} } = {}) {
    this.currentScenario = id;
    const workdir = await this.workdir(id);
    const before = this.effects();
    let admission;
    if (slash) {
      const command = `/agent_goal --name ${id.toLowerCase()} --workdir ${JSON.stringify(workdir)} --harness codex --permission-mode bypassPermissions --verify ${JSON.stringify(verifierCommands[0])} OCA501_CASE_${id}`;
      admission = await this.slash(command);
      assert.ok(admission.messages.some((message) => /Error:/i.test(message.text ?? "")), "Actual slash returns rejection");
    } else {
      admission = await this.invoke("agent_goal", this.goalArgs(id, workdir, { verifier_commands: verifierCommands, ...extra }));
      if (expectedHostDeny) { assert.equal(admission.status, 404); assert.equal(admission.output.ok, false); assert.equal(admission.output.error.type, "not_found"); }
      else assert.ok(admission.status >= 400 || admission.output.result?.isError === true || admission.output.result?.content?.some((part) => /Error:/i.test(part.text ?? "")), "Real host schema or OCA policy must reject selection");
    }
    const after = this.effects(); assertNoWorkEffects(before, after);
    this.recordCase(id, { admission, before, after, layer: expectedHostDeny ? "host effective tools policy" : admission.status >= 400 ? "host validation" : "OCA atomic policy admission", assertions: ["actual ingress rejected", "no goal/session insertion", "no native/provider/check effects", "no mandatory verifier confirmation"] });
  }
  async slash(text) {
    await waitFor("genuine Telegram polling", () => this.botRequests.some((request) => request.method === "getUpdates"));
    const beforeMessages = this.botMessages.length;
    const update = { update_id: ++this.updateId, message: { message_id: this.updateId, date: Math.floor(Date.now() / 1000), from: { id: 501002, is_bot: false, first_name: "Fixture" }, chat: { id: 501002, type: "private", first_name: "Fixture" }, text, entities: [{ type: "bot_command", offset: 0, length: 11 }] } };
    this.botUpdates.push(update);
    const messages = await waitFor("actual Telegram slash response", () => {
      const responses = this.botMessages.slice(beforeMessages).filter((message) => message.chat.id === 501002);
      return responses.some((message) => /Goal task|Error:/i.test(message.text ?? "")) ? responses : false;
    });
    return { update, messages: structuredClone(messages) };
  }
  async click(message, label) {
    const button = message.reply_markup?.inline_keyboard?.flat().find((entry) => entry.text === label);
    assert.ok(button?.callback_data, `Capture actual ${label} wire callback`);
    const callbackId = `oca501_callback_${randomBytes(12).toString("hex")}`;
    const update = { update_id: ++this.updateId, callback_query: { id: callbackId, from: { id: 501002, is_bot: false, first_name: "Fixture" }, message: structuredClone(message), chat_instance: "oca501-private-chat", data: button.callback_data } };
    this.botUpdates.push(update);
    await waitFor("actual Telegram callback acknowledgement", () => this.botRequests.find((request) => request.method === "answerCallbackQuery" && JSON.parse(request.params ?? "{}").callback_query_id === callbackId));
    return update;
  }
  async matrixH01H05() {
    await this.settleGoalDelivery(this.goals().find((goal) => goal.name === "host-prerequisite"));
    this.currentScenario = "H01";
    this.artifact("host-tools-deny-schema.json", await this.rpc("config.schema.lookup", { path: "tools.deny" }));
    await this.patch({ tools: { deny: ["agent_goal"] } }, ["tools.deny"]);
    const deniedInventory = await this.rpc("tools.effective", { agentId: "main", sessionKey: this.sessionKey });
    assertEffectiveOcaTools(deniedInventory, this.pluginToolNames.filter((name) => name !== "agent_goal"));
    this.artifact("host-tools-denied-inventory.json", deniedInventory);
    await this.deniedCase("H01-host-deny", ["bash ci.sh"], { expectedHostDeny: true });
    await this.patch({ tools: { deny: null } }, ["tools.deny"]);
    assertEffectiveOcaTools(await this.rpc("tools.effective", { agentId: "main", sessionKey: this.sessionKey }), this.pluginToolNames);
    await this.launchCase("H01-host-recovery", { commands: ["bash ci.sh"] });

    this.currentScenario = "H02"; await this.suite(undefined);
    const id = "H02-confirm"; const workdir = await this.workdir(id); const before = this.effects();
    const messageStart = this.botMessages.length;
    this.nativeFixture = { tag: `OCA501_CASE_${id}`, text: MARKER, workdir };
    const admission = await this.invoke("agent_goal", this.goalArgs(id, workdir, { verifier_commands: ["bash weak.sh"] }), { channel: "telegram", target: "501002" });
    assert.equal(admission.status, 200); assert.equal(admission.output.ok, true);
    const awaiting = await waitFor("real verifier confirmation", () => this.goals().find((goal) => goal.name === id.toLowerCase() && goal.status === "awaiting_verifier_confirmation"));
    const message = await waitFor("real Run checks buttons", () => this.botMessages.slice(messageStart).find((entry) => entry.reply_markup?.inline_keyboard?.flat().some((button) => button.text === "Run these checks")));
    const afterAwaiting = this.effects();
    assert.equal(afterAwaiting.confirmationTokenIds.length, before.confirmationTokenIds.length + 2, "One real Run/Cancel token pair is issued");
    assertNoWorkEffects({ ...before, goalIds: [...before.goalIds, awaiting.id].toSorted(), confirmationTokenIds: afterAwaiting.confirmationTokenIds }, afterAwaiting);
    const captured = structuredClone(message); assert.ok(captured.reply_markup.inline_keyboard.flat().some((button) => button.text === "Cancel"));
    const callback = await this.click(captured, "Run these checks");
    const confirmed = await this.terminal(id, workdir, { receipt: "WEAK\n" });
    assert.equal(confirmed.requiredVerifierCommands, undefined);
    this.recordCase(id, { admission, awaiting, before, afterAwaiting, captured, callback, confirmed, assertions: ["untrusted tool awaits real confirmation", "no native/session/check before callback", "actual captured opaque Run callback starts native goal and WEAK shell"] });
    await this.launchCase("H02-slash-default", { extra: { verifier_commands: ["bash weak.sh"] }, slash: true, expected: { receipt: "WEAK\n" } });
    await this.suite(undefined, ["bash weak.sh"]);
    await this.launchCase("H02-trusted", { extra: { verifier_commands: ["bash weak.sh"] }, expected: { receipt: "WEAK\n" } });
    await this.suite(undefined);
    await this.launchCase("H02-ralph-free", { extra: { goal_mode: "ralph" }, text: "<promise>DONE</promise>", expected: { receipt: "" } });

    this.currentScenario = "H03"; await this.suite(["bash ci.sh"]);
    for (const [suffix, selection] of [["true", ["true"]], ["false", ["false"]], ["path", ["bash ./ci.sh"]], ["suffix", ["bash ci.sh; true"]], ["case", ["BASH ci.sh"]], ["space", ["bash  ci.sh"]], ["newline", ["bash\nci.sh"]], ["empty", []], ["blank", [""]], ["white", [" "]], ["mixed", ["bash ci.sh", 1]], ["nonarray", "bash ci.sh"]]) await this.deniedCase(`H03-${suffix}`, selection);
    await this.deniedCase("H03-plan-weak", ["true"], { extra: { permission_mode: "plan" } });
    await this.deniedCase("H03-ralph-weak", ["true"], { extra: { goal_mode: "ralph", completion_promise: "DONE" } });
    await this.deniedCase("H03-harness-weak", ["true"], { extra: { harness: "claude-code" } });
    await this.deniedCase("H03-confirmation-flag", ["true"], { extra: { verifier_commands_confirmed: true } });
    await this.deniedCase("H03-slash-weak", ["true"], { slash: true });
    await this.deniedCase("H03-slash-empty", [""], { slash: true });
    await this.launchCase("H03-omit", { commands: ["bash ci.sh"], execute: true });
    await this.launchCase("H03-outertrim", { commands: ["bash ci.sh"], extra: { verifier_commands: ["  bash ci.sh  "] } });
    await this.launchCase("H03-slash-omit", { commands: ["bash ci.sh"], slash: true });

    this.currentScenario = "H04"; const suite = ["bash ci.sh", "bash lint.sh", "bash ci.sh"]; await this.suite(suite);
    for (const [suffix, selection] of [["subset", [suite[0]]], ["reorder", [suite[1], suite[0], suite[2]]], ["dedup", [suite[0], suite[1]]], ["extra", [...suite, "true"]], ["blank", [suite[0], "", suite[2]]]]) await this.deniedCase(`H04-${suffix}`, selection);
    await this.deniedCase("H04-slash-subset", [suite[0]], { slash: true });
    for (const [id, extra, slash] of [["H04-omit", {}, false], ["H04-complete", { verifier_commands: suite }, false], ["H04-slash", {}, true], ["H04-slash-complete", { verifier_commands: suite }, true]]) {
      const task = await this.launchCase(id, { commands: suite, extra, slash, expected: { receipt: "CI\nLINT\nCI\n" } });
      assert.equal(task.lastVerifierSummary.split("\n").length, 3); assert.ok(task.lastVerifierSummary.includes("PASS check-3"));
    }
    this.currentScenario = "H05";
    const failedVerifier = await this.launchCase("H05-verifier-fail", { commands: suite, text: "DONE", script: { lintExit: 7 }, expected: { status: "failed", receipt: "CI\nLINT\nCI\n" } });
    assert.match(failedVerifier.lastVerifierSummary, /FAIL check-2 \(exit 7,/); assert.match(failedVerifier.lastVerifierSummary, /PASS check-3/);
    await this.launchCase("H05-ralph-pass", { commands: suite, extra: { goal_mode: "ralph", verifier_commands: suite }, text: "<promise>DONE</promise>", expected: { receipt: "CI\nLINT\nCI\n" } });
    await this.launchCase("H05-ralph-fail", { commands: suite, extra: { goal_mode: "ralph" }, text: "<promise>DONE</promise>", script: { lintExit: 7 }, expected: { status: "failed", receipt: "CI\nLINT\nCI\n" } });
    const noPromise = await this.launchCase("H05-no-promise", { commands: suite, extra: { goal_mode: "ralph" }, text: "No promise emitted.", expected: { status: "failed", receipt: "" } });
    assert.equal(noPromise.lastVerifierSummary, undefined); assert.match(noPromise.failureReason, /Completion promise/);
    await this.suite(["bash ci.sh"]);
    const mutableDir = await this.workdir("H05-integrity"); const scripts = [];
    for (const [suffix, exit, status] of [["fail", 9, "failed"], ["pass", 0, "succeeded"]]) {
      writeFileSync(join(mutableDir, "ci.sh"), `printf '${suffix}\\n' >> receipt.txt\nexit ${exit}\n`, { mode: 0o600 });
      const caseId = `H05-integrity-${suffix}`; this.nativeFixture = { tag: `OCA501_CASE_${caseId}`, text: "DONE", workdir: mutableDir };
      const response = await this.invoke("agent_goal", this.goalArgs(caseId, mutableDir)); assert.equal(response.status, 200); assert.notEqual(response.output.result?.isError, true);
      const task = await this.terminal(caseId, mutableDir, { status, commands: ["bash ci.sh"], receipt: suffix === "fail" ? "fail\n" : "fail\npass\n" });
      scripts.push({ suffix, scriptHash: fileHash(join(mutableDir, "ci.sh")), task });
    }
    assert.notEqual(scripts[0].scriptHash, scripts[1].scriptHash);
    this.recordCase("H05-integrity", { scripts, assertions: ["same mandatory command string", "harmless script rewrite changes real exit/result", "append-only fail/pass receipt", "selection policy does not freeze script integrity"] });
    this.results = this.results.filter((result) => !(result.classification === "UNPROVEN" && /^H0[1-5]$/.test(result.scenario)));
    for (let id = 1; id <= 5; id++) {
      const scenario = `H0${id}`; const subcases = this.results.filter((result) => result.scenario.startsWith(`${scenario}-`)).map((result) => result.scenario);
      this.results.push({ ...this.provenance, scenario, classification: "PASS", command: "Complete reviewed H01–H05 milestone subcases", exitCode: 0, assertions: subcases, skips: [], logPath: this.directory });
    }
    await this.finalDrain();
  }
  async finalDrain() {
    this.currentScenario = "final-settlement";
    const evidence = { mutation: "Own disposable Gateway suspend.prepare(preserve, drain) after all scenario outcomes; no handoff/auth changes", observations: [] };
    let lease; let requestId;
    try {
      await waitFor("all real Telegram updates acknowledged by polling offsets", () => this.botUpdates.length === 0);
      assert.deepEqual(await this.hostIdentity(), this.gatewayInstance, "Same actual listener process/profile/package before final fence");
      const active = await this.rpc("sessions.list", { agentId: "main", activeOnly: true, limit: 100 });
      assert.deepEqual(active.sessions, [], "Expected parent/native session work is terminal before fencing new admission");
      assert.deepEqual(this.fixtureErrors, []);
      evidence.beforeFence = { identity: this.gatewayInstance, effects: this.effects(), sessionRows: this.sessions(), activeSessions: active };
      requestId = `oca501-final-${randomBytes(12).toString("hex")}`;
      const params = { requestId, terminalPolicy: "preserve", drain: true };
      const prepared = await this.rpc("gateway.suspend.prepare", params); evidence.prepared = prepared;
      assert.ok(["ready", "draining"].includes(prepared.status), "Only a real ready/draining lease is accepted");
      assert.ok(prepared.suspensionId && prepared.expiresAtMs > Date.now(), "Real returned lease is unexpired"); lease = prepared.suspensionId;
      const ready = await waitFor("own genuine Gateway suspension ready", async () => {
        const status = await this.rpc("gateway.suspend.status", { suspensionId: lease, includeLifecycle: true }); evidence.observations.push(status);
        this.artifact("final-settlement.json", evidence);
        assert.ok(["ready", "draining"].includes(status.status), "Busy/conflict/recovery/expiry is blocked");
        assert.equal(status.ownerId, requestId); assert.ok(status.expiresAtMs > Date.now(), "Owned observed lease remains unexpired");
        return status.status === "ready" ? status : false;
      }, 60_000);
      assert.deepEqual(ready.writeCustody, []);
      const refreshed = await this.rpc("gateway.suspend.prepare", params); evidence.refreshed = refreshed;
      assert.equal(refreshed.status, "ready"); assert.equal(refreshed.suspensionId, lease); assert.ok(refreshed.expiresAtMs > Date.now());
      assert.equal(refreshed.activeCount, 0); assert.deepEqual(refreshed.blockers, []); assert.deepEqual(refreshed.writeCustody, []);
      assertNoWorkEffects(evidence.beforeFence.effects, this.effects());
      assert.deepEqual(this.ownedProcessIdentity(this.gatewayInstance.pid), { pid: this.gatewayInstance.pid, executable: this.gatewayInstance.executable, startTicks: this.gatewayInstance.startTicks });
      evidence.classification = "PASS"; this.artifact("final-settlement.json", evidence);
      // No scenario admission after this real fence. Fixtures stay up until the
      // existing bounded owned-process shutdown completes in cleanup().
      this.results.push({ ...this.provenance, scenario: "final-settlement", classification: "PASS", command: "gateway.suspend.prepare/status(preserve,drain), actual owned lease", exitCode: 0, assertions: ["prior correlated outcomes terminal", "real owned unexpired ready lease", "zero active count", "empty blockers and write custody"], skips: [], logPath: join(this.directory, "final-settlement.json") });
    } catch (error) {
      evidence.classification = "BLOCKED"; evidence.error = String(error);
      if (lease && requestId) {
        try {
          const status = await this.rpc("gateway.suspend.status", { suspensionId: lease, includeLifecycle: true }); evidence.failureStatus = status;
          if (["ready", "draining"].includes(status.status) && status.ownerId === requestId && status.expiresAtMs > Date.now()) evidence.resume = await this.rpc("gateway.suspend.resume", { suspensionId: lease });
        } catch (resumeError) { evidence.resumeError = String(resumeError); }
      }
      this.artifact("final-settlement.json", evidence); throw error;
    }
  }
  async cleanup() {
    const failures = [];
    const attempt = async (operation) => { try { await operation(); } catch (error) { failures.push(this.redact(error.stack ?? error)); } };
    // Discover children even when native initialization fails before any HTTP
    // provider request, before parent exit can reparent them away from the tree.
    for (const child of this.children) if (child.pid) await attempt(() => this.observeNativeProcesses(child.pid));
    for (const child of [...this.children]) await attempt(() => this.stop(child));
    // OCA launches native app servers in separate process groups. Only stop
    // recorded owned identities, with proc start time protecting against PID reuse.
    for (const entry of this.nativeExecutions) {
      await attempt(async () => {
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
      });
    }
    // The native transport owns another process group; verify every captured
    // descendant, not just the successfully initialized native binary.
    for (const entry of this.ownedProcesses.values()) {
      await attempt(async () => {
      const ownsLiveProcess = () => {
        try { return realpathSync(`/proc/${entry.pid}/exe`) === entry.executable
          && readFileSync(`/proc/${entry.pid}/stat`, "utf8").split(") ").at(-1).split(" ")[19] === entry.startTicks; } catch { return false; }
      };
      if (ownsLiveProcess()) {
        try { process.kill(entry.pid, "SIGCONT"); process.kill(entry.pid, "SIGTERM"); } catch {}
        await delay(500);
        if (ownsLiveProcess()) { try { process.kill(entry.pid, "SIGKILL"); } catch {} }
        await waitFor("owned descendant cleanup", () => !ownsLiveProcess(), 5000);
      }
      assert.equal(ownsLiveProcess(), false, `Owned process survived cleanup: ${entry.pid}`);
      });
    }
    const ports = [];
    if (this.gatewayUrl) ports.push(Number(new URL(this.gatewayUrl).port));
    for (const server of this.servers) {
      await attempt(async () => {
      ports.push(server.address().port);
      server.closeAllConnections(); await new Promise((done) => server.close(done)); assert.equal(server.listening, false);
      });
    }
    for (const port of ports) {
      await attempt(async () => {
      const listening = await new Promise((done) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => { socket.destroy(); done(true); });
        socket.once("error", () => { socket.destroy(); done(false); });
        socket.setTimeout(1000, () => { socket.destroy(); done(false); });
      });
      assert.equal(listening, false, `Owned listener survived cleanup: ${port}`);
      });
    }
    if (failures.length) {
      for (const result of this.results) if (result.classification === "PASS") {
        result.classification = "BLOCKED"; result.unprovenReason = "Behavior assertions passed, but owned-resource cleanup failed";
      }
      this.results.push({ ...this.provenance, scenario: "cleanup", classification: "BLOCKED", exitCode: 1, unprovenReason: failures.join("\n"), logPath: this.directory });
      process.exitCode = 1;
    }
    this.artifact("cleanup.json", { ownedProcesses: [...this.ownedProcesses.values()], checkedPorts: ports, classification: failures.length ? "BLOCKED" : "PASS", failures });
    this.artifact("gateway.log", this.gatewayLog ?? "Gateway not started");
    this.artifact("fixtures.json", { modelRequests: this.modelRequests, botRequests: this.botRequests, botMessages: this.botMessages, botMenus: [...this.botMenus.entries()], fixtureErrors: this.fixtureErrors, nativeExecutions: this.nativeExecutions });
    this.artifact("provenance.json", this.provenance);
    this.artifact("results.json", this.results);
  }
}

let run;
try {
  run = new AcceptanceRun(parseOptions(process.argv.slice(2)));
  await run.setup();
} catch (error) {
  if (run) run.results.push({ ...run.provenance, scenario: run.currentScenario ?? "H01-prerequisite", classification: "BLOCKED", exitCode: 1, unprovenReason: run.redact(error.stack ?? error), logPath: run.directory });
  console.error(run ? run.redact(error.stack ?? error) : String(error));
  process.exitCode = 1;
} finally {
  if (run) {
    try { await run.cleanup(); } catch (error) {
      process.exitCode = 1;
      console.error(`Cleanup/evidence failure: ${run.redact(error.stack ?? error)}`);
    }
  }
}
if (run) console.log(`${LABEL}: ${run.options.phase ?? "prerequisites"} ${process.exitCode ? "BLOCKED" : "PASS"}; H06–H12 remain UNPROVEN in these milestone phases; evidence ${run.directory}`);
