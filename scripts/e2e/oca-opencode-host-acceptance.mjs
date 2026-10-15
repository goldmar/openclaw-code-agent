#!/usr/bin/env node
// Opt-in: actual packaged OCA + OpenClaw Gateway + native OpenCode. Only model
// transport is deterministic; profiles, providers and messages are run-owned.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createIsolatedOpenClawEnv } from "../check-plugin-security.mjs";
import { tsImport } from "tsx/esm/api";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hostRoot = resolve(process.env.OCA_ACCEPTANCE_HOST_ROOT || join(root, "node_modules/openclaw"));
const { resolveOpenCodeCommand } = await tsImport("../../src/harness/opencode/command.ts", import.meta.url);
const native = resolveOpenCodeCommand();
const artifact = resolve(process.env.OCA_ACCEPTANCE_REPORT || join(tmpdir(), "oca-opencode-host-acceptance.json"));
const profile = await mkdtemp(join(tmpdir(), "oca-opencode-gateway-"));
const env = createIsolatedOpenClawEnv(profile, { PATH: process.env.PATH });
const sessionKey = "agent:main:main";
const cli = join(hostRoot, "openclaw.mjs");
const observations = [], failures = [], outcomes = [];
let gateway, provider, stage = "setup", scenario = "completion", nativeCalls = 0;
let gatewayExit;
let gatewayClient;
let orchestratorAction;
const orchestratorTools = [];
const turns = [];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(read, label, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`deadline: ${label}`);
}
async function command(command, args, cwd = profile, commandEnv = env) {
  try { return await execute(command, args, { cwd, env: commandEnv, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }); }
  catch (error) {
    await writeFile(join(profile, "private-subprocess-failure.log"), String(error.stderr || error.stdout || error.code), { mode: 0o600 });
    throw new Error(`subprocess failed: ${command === process.execPath ? "node" : command}`);
  }
}
function completion(res, body, delta, finish = "stop") {
  const base = { id: `chatcmpl-${randomUUID()}`, created: 0, model: body.model,
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  } else {
    const { tool_calls, ...message } = delta;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, finish_reason: finish,
      message: { ...message, ...(tool_calls ? { tool_calls: tool_calls.map(({ index, ...call }) => call) } : {}) } }] }));
  }
}
function functionCall(name, args) {
  return { role: "assistant", tool_calls: [{ index: 0, id: `call${randomUUID().replaceAll("-", "")}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
try {
  const pkg = JSON.parse(await readFile(join(root, "package.json")));
  const host = JSON.parse(await readFile(join(hostRoot, "package.json")));
  const version = (await command(native, ["--version"])).stdout.trim();
  assert.match(version, /^opencode v2\./u);
  provider = createServer(async (req, res) => {
    try {
      assert.equal(req.socket.remoteAddress, "127.0.0.1");
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: ["test", "orchestrator"].map((id) => ({ id, object: "model", owned_by: "fixture" })) }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const transport = req.url.startsWith("/native/") ? "native" : "orchestrator";
      observations.push({ transport, scenario, messages: body.messages, tools: body.tools?.map((t) => t.function?.name ?? t.name), toolSchemas: body.tools });
      await writeFile(join(profile, "private-observations.json"), JSON.stringify(observations), { mode: 0o600 });
      if (transport === "orchestrator") {
        const action = orchestratorAction;
        if (action && body.tools?.length) {
          const result = body.messages.find((m) => m.role === "tool" && m.tool_call_id === action.callID);
          if (result) {
            assert.ok(!/"isError"\s*:\s*true|Error:/u.test(String(result.content)), "orchestrator tool must succeed");
            action.completed = true;
          } else if (!action.sent && JSON.stringify(body.messages.filter((m) => m.role === "user")).includes(action.marker)) {
            const names = body.tools.map((t) => t.function?.name ?? t.name);
            const dispatcher = names.includes("tool_call");
            assert.ok(dispatcher || names.includes(action.tool), "orchestrator tool must be advertised");
            const call = functionCall(dispatcher ? "tool_call" : action.tool,
              dispatcher ? { id: action.tool, args: action.args } : action.args);
            action.callID = call.tool_calls[0].id;
            action.sent = true;
            orchestratorTools.push(action.tool);
            completion(res, body, call, "tool_calls");
            return;
          }
        }
        completion(res, body, { role: "assistant", content: "ORCHESTRATOR_OBSERVED" });
        return;
      }
      if (!body.tools?.length) {
        completion(res, body, { role: "assistant", content: "Acceptance title" });
        return;
      }
      nativeCalls++;
      if (scenario === "question" && nativeCalls === 1) {
        assert.ok(body.tools.some((t) => t.function.name === "question"), "native question tool required");
        completion(res, body, functionCall("question", { questions: [{ header: "Acceptance", question: "Choose the acceptance color", options: [{ label: "Blue", description: "Acceptance answer" }, { label: "Red", description: "Other choice" }] }] }), "tool_calls");
      } else if (scenario === "permission" && nativeCalls === 1) {
        assert.ok(body.tools.some((t) => t.function.name === "shell"), "native shell tool required");
        completion(res, body, functionCall("shell", { command: "printf OCA_SHELL_OK" }), "tool_calls");
      } else if (scenario === "plan" && nativeCalls === 1) {
        completion(res, body, { role: "assistant", content: "Acceptance plan: inspect the scratch repository, then report OCA_PLAN_DONE. No files need changing." });
      } else {
        completion(res, body, { role: "assistant", content: `OCA_${scenario.toUpperCase()}_DONE` });
      }
    } catch (error) {
      failures.push(error instanceof assert.AssertionError ? error.message : `provider request invalid: ${error.message}`);
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  await new Promise((done) => provider.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${provider.address().port}`;
  const port = await freePort(), token = randomBytes(32).toString("hex");
  env.OPENCLAW_GATEWAY_PORT = String(port);
  env.OPENCLAW_GATEWAY_TOKEN = token;
  env.OPENCLAW_OPENCODE_COMMAND = native;
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  env.OPENCODE_DISABLE_MODELS_FETCH = "1";
  env.OPENCODE_CONFIG_DIR = join(profile, "native-config");
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "oca-fixture/test", providers: { "oca-fixture": {
    package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `${base}/native/v1`, apiKey: "synthetic-only" },
    models: { test: { name: "Fixture", limit: { context: 100000, output: 4096 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } },
  } } });
  const workspace = join(profile, "workspace");
  await mkdir(workspace);
  await command("git", ["init", "--initial-branch=main"], workspace);
  stage = "pack";
  const packDir = join(profile, "pack"); await mkdir(packDir);
  const packed = JSON.parse((await command("pnpm", ["pack", "--json", "--pack-destination", packDir], root, { ...process.env })).stdout);
  const tarball = resolve(packDir, (Array.isArray(packed) ? packed[0] : packed).filename);
  const digest = createHash("sha256").update(await readFile(tarball)).digest("hex");
  const candidate = join(profile, "candidate"); await mkdir(candidate);
  await command("tar", ["-xzf", tarball, "--strip-components=1", "-C", candidate]);
  for (const dependency of ["openclaw", ...Object.keys(pkg.dependencies)]) {
    const target = join(candidate, "node_modules", dependency);
    await mkdir(dirname(target), { recursive: true });
    await symlink(dependency === "openclaw" ? hostRoot : join(root, "node_modules", dependency), target, "dir");
  }
  const config = {
    gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token }, controlUi: { enabled: false } },
    agents: { defaults: { workspace, skipBootstrap: true, model: { primary: "oca-fixture/orchestrator" }, utilityModel: "oca-fixture/orchestrator" } },
    models: { mode: "replace", providers: { "oca-fixture": { api: "openai-completions", agentRuntime: { id: "openclaw" }, baseUrl: `${base}/orchestrator/v1`, apiKey: "synthetic-only", request: { allowPrivateNetwork: true }, models: [{ id: "orchestrator", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
    tools: { codeMode: false },
    plugins: { allow: ["openclaw-code-agent"], slots: { memory: "none" }, load: { paths: [candidate] }, entries: { codex: { enabled: false }, "openclaw-code-agent": { enabled: true, config: { autoUpdate: false, defaultHarness: "opencode", agentChannels: { [workspace]: `webchat|${sessionKey}` }, defaultWorktreeStrategy: "off", permissionMode: "default", planApproval: "delegate", harnesses: { opencode: { defaultModel: "oca-fixture/test", command: native } } } } } },
    cron: { enabled: false }, browser: { enabled: false }, logging: { level: "info", file: join(profile, "gateway-private.log") },
  };
  await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });
  const { GatewayClient } = await import(pathToFileURL(join(hostRoot, "dist/plugin-sdk/gateway-runtime.js")).href);
  const rpc = (method, params = {}) => gatewayClient.request(method, params, { timeoutMs: 70000 });
  const tool = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-openclaw-message-channel": "webchat", "x-openclaw-message-to": sessionKey }, body: JSON.stringify({ tool: name, args, sessionKey }), signal: AbortSignal.timeout(90000) });
    const value = await response.json();
    assert.equal(response.status, 200, "Gateway tool admission");
    assert.equal(value.ok, true, "Gateway tool result");
    const output = (value.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    assert.ok(!value.result?.isError, "OCA tool must succeed");
    return output;
  };
  async function startGateway() {
    gateway = spawn(process.execPath, [cli, "gateway", "run", "--port", String(port), "--bind", "loopback"], { cwd: profile, env, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    gateway.stdout.on("data", (s) => { logs += s; });
    gateway.stderr.on("data", (s) => { logs += s; });
    gatewayExit = new Promise((done) => gateway.once("exit", done));
    await until(async () => {
      assert.equal(gateway.exitCode, null, "isolated Gateway exited");
      try { const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
    }, "Gateway startup");
    await writeFile(join(profile, "gateway-startup-private.log"), logs, { mode: 0o600 });
    await new Promise((accept, reject) => {
      gatewayClient = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token,
        clientName: "cli", clientVersion: host.version, mode: "cli", role: "operator",
        scopes: ["operator.admin"], deviceIdentity: null, env, sharedStateMode: "read-only",
        onHelloOk: accept, onConnectError: reject,
      });
      gatewayClient.start();
    });
    await rpc("health");
  }
  async function stopGateway() {
    await gatewayClient?.stopAndWait();
    if (!gateway || gateway.exitCode !== null) return;
    const owned = [];
    if (process.platform === "linux") {
      const processes = new Map();
      for (const pid of await readdir("/proc")) {
        if (!/^\d+$/u.test(pid)) continue;
        try {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
          processes.set(pid, { parent: fields[1], start: fields[19] });
        } catch (error) {
          if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
        }
      }
      const descendants = new Set([String(gateway.pid)]);
      for (let changed = true; changed;) {
        changed = false;
        for (const [pid, item] of processes)
          if (!descendants.has(pid) && descendants.has(item.parent)) {
            descendants.add(pid); changed = true;
          }
      }
      for (const [pid, item] of processes) {
        let matched = descendants.has(pid);
        if (!matched) {
          try { matched = (await readFile(`/proc/${pid}/environ`)).includes(Buffer.from(`HOME=${profile}\0`)); }
          catch (error) { if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error; }
        }
        if (matched) owned.push({ pid, start: item.start });
      }
    }
    gateway.kill("SIGTERM");
    const timer = setTimeout(() => gateway.kill("SIGKILL"), 15000);
    try { await gatewayExit; } finally { clearTimeout(timer); }
    await until(async () => {
      for (const item of owned) {
        try {
          const stat = await readFile(`/proc/${item.pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
          if (fields[19] === item.start && fields[0] !== "Z") return false;
        } catch (error) {
          if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
        }
      }
      return true;
    }, "owned Gateway/OpenCode process cleanup", 15000);
  }
  stage = "Gateway startup";
  console.log("Acceptance: packaged plugin ready; starting isolated Gateway");
  await startGateway();
  await rpc("sessions.create", { key: sessionKey });
  const effective = await rpc("tools.effective", { sessionKey });
  assert.ok(effective.groups.some((g) => g.tools.some((t) => t.id === "agent_launch")), "orchestrator must see agent_launch");
  async function observe(marker, action) {
    orchestratorAction = action ? { ...action, marker, sent: false, completed: false } : undefined;
    const sent = await rpc("chat.send", { sessionKey, message: marker, idempotencyKey: randomUUID() });
    const terminal = await rpc("agent.wait", { runId: sent.runId, timeoutMs: 60000 });
    turns.push({ marker, admission: sent.status, terminal: terminal.status });
    await writeFile(join(profile, "private-turns.json"), JSON.stringify(turns), { mode: 0o600 });
    // A lifecycle wake may already own the session run while this prompt is
    // queued. Require the exact model-visible tool result, not the enqueue/run ID.
    if (action) await until(() => orchestratorAction.completed,
      `orchestrator must consume ${action.tool} result`);
    orchestratorAction = undefined;
  }
  await observe("OCA_ACCEPTANCE_BOOTSTRAP");
  const storePath = join(env.OPENCLAW_STATE_DIR, "code-agent-sessions.json");
  async function rows() {
    try {
      const data = JSON.parse(await readFile(storePath));
      const sessions = data.sessions ?? data;
      return Array.isArray(sessions) ? sessions : Object.values(sessions);
    } catch { return []; }
  }
  for (const name of ["completion", "question", "permission", "plan"]) {
    console.log(`Acceptance: ${name}`);
    stage = name; scenario = name; nativeCalls = 0;
    await observe(`OCA_LAUNCH_${name.toUpperCase()}`, { tool: "agent_launch", args: { prompt: `OCA_${name.toUpperCase()}_ACCEPTANCE`, name: `accept-${name}`, harness: "opencode", workdir: workspace, worktree_strategy: "off", permission_mode: name === "plan" ? "plan" : "default", plan_approval: "delegate", force_new_session: true } });
    const row = await until(async () => (await rows()).find((r) => r.name === `accept-${name}`), "persisted session");
    if (name !== "completion") {
      await until(async () => (await tool("agent_sessions", { status: "waiting", full: true })).includes(`accept-${name}`), "pending input");
      await observe(`OCA_OBSERVE_${name.toUpperCase()}`, { tool: "agent_output", args: { ocaSessionId: row.sessionId, full: true } });
      const pendingTranscript = JSON.stringify(observations.filter((o) => o.transport === "orchestrator").map((o) => o.messages));
      assert.ok(pendingTranscript.includes(name === "question" ? "Choose the acceptance color" : name === "permission" ? "OCA_SHELL_OK" : "Acceptance plan"), "orchestrator must receive pending request details");
      if (name === "question" || name === "plan") {
        console.log(`Acceptance: restart while ${name} is pending`);
        await stopGateway();
        await startGateway();
        outcomes.push(`restart-with-pending-${name}`);
      }
      await observe(`OCA_ANSWER_${name.toUpperCase()}`, { tool: "agent_respond", args: {
        ocaSessionId: row.sessionId,
        message: name === "question" ? "Blue" : name === "permission" ? "Allow once" : "Implement the approved acceptance plan",
        ...(name === "plan" ? { approve: true, approval_rationale: "The acceptance plan only inspects a disposable scratch repository." } : { userInitiated: true }),
      } });
    }
    await until(async () => (await rows()).find((r) => r.sessionId === row.sessionId && r.status === "completed"), "completion");
    const output = await tool("agent_output", { ocaSessionId: row.sessionId, full: true });
    assert.ok(output.includes(`OCA_${name.toUpperCase()}_DONE`), "saved output must contain native answer");
    await observe(`OCA_OBSERVE_COMPLETED_${name.toUpperCase()}`, { tool: "agent_output", args: { ocaSessionId: row.sessionId, full: true } });
    const transcript = JSON.stringify(observations.filter((o) => o.transport === "orchestrator").map((o) => o.messages));
    assert.ok(transcript.includes(`accept-${name}`), "orchestrator must receive session context");
    assert.ok(transcript.includes(`OCA_${name.toUpperCase()}_DONE`), "orchestrator must consume the final backend output");
    const nativeMessages = observations.filter((o) => o.transport === "native" && o.scenario === name && o.tools?.length).flatMap((o) => o.messages ?? []);
    if (name === "permission") assert.ok(nativeMessages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("OCA_SHELL_OK")), "native approved command must return its result");
    if (name === "question") assert.ok(nativeMessages.some((m) => (m.role === "user" || m.role === "tool") && JSON.stringify(m.content).includes("Blue")), "native resumed conversation must receive the answer");
    const settled = (await rows()).find((r) => r.sessionId === row.sessionId);
    assert.equal(settled.backendRef.conversationId, row.backendRef.conversationId, "resume must retain the backend conversation");
    if (name === "plan") assert.notEqual(settled.currentPermissionMode, "plan", "approved plan must leave plan mode");
    outcomes.push(`${name}:native-backend+Gateway+orchestrator-context+persisted-output`);
  }
  await stopGateway();
  await startGateway();
  const before = (await rows()).find((r) => r.name === "accept-completion");
  scenario = "resume"; nativeCalls = 0;
  await observe("OCA_RESTART_RESUME", { tool: "agent_respond", args: { ocaSessionId: before.sessionId, message: "Continue after Gateway restart" } });
  await until(async () => {
    const output = await tool("agent_output", { ocaSessionId: before.sessionId, full: true });
    return output.includes("OCA_RESUME_DONE");
  }, "restart/resume");
  await observe("OCA_OBSERVE_RESUME", { tool: "agent_output", args: { ocaSessionId: before.sessionId, full: true } });
  assert.ok(JSON.stringify(observations.filter((o) => o.transport === "orchestrator").map((o) => o.messages)).includes("OCA_RESUME_DONE"));
  outcomes.push("Gateway-restart+resume+orchestrator-context");
  const history = await rpc("chat.history", { sessionKey, limit: 200 });
  const messages = JSON.stringify(history.messages);
  assert.ok(messages.includes("Choose the acceptance color"), "question must appear in WebChat history");
  assert.ok(messages.includes("OCA_RESUME_DONE"), "resumed output must appear in the orchestrator transcript");
  await stopGateway();
  outcomes.push("owned-process-cleanup");
  assert.deepEqual(failures, []);
  await mkdir(dirname(artifact), { recursive: true });
  await writeFile(artifact, JSON.stringify({ status: "passed", hostVersion: host.version, pluginVersion: pkg.version, nativeVersion: version, tarballSha256: digest, outcomes, orchestratorTools, orchestratorRequests: observations.filter((o) => o.transport === "orchestrator").length, modelTransport: "local-fixture", channelTransport: "webchat", externalInference: false, externalDelivery: false }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: "passed", hostVersion: host.version, nativeVersion: version, outcomes }));
} catch (error) {
  await writeFile(artifact, JSON.stringify({ status: "failed", stage, reason: error.message, failures, turns, profile }, null, 2), { mode: 0o600 });
  console.error(`OpenCode Gateway acceptance failed at ${stage}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await gatewayClient?.stopAndWait();
  if (gateway && gateway.exitCode === null) {
    gateway.kill("SIGTERM");
    const timer = setTimeout(() => gateway.kill("SIGKILL"), 15000);
    try { await gatewayExit; } finally { clearTimeout(timer); }
  }
  provider?.closeAllConnections();
  if (provider) await new Promise((done) => provider.close(done));
  if (!process.exitCode) await rm(profile, { recursive: true, force: true });
}
