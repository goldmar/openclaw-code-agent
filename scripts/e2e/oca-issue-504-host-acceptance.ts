import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { closeSync, constants, createWriteStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

// Opt-in acceptance: real host + native backend; only model text is simulated.
type Json = Record<string, any>;
type Identity = { pid: number; parent: number; group: number; start: string };
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = "2026.9.7", NATIVE = "0.159.3";
const NATIVE_HASH = "8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const readJson = (path: string): Json => JSON.parse(readFileSync(path, "utf8"));
const text = (result: Json): string => (result.content ?? []).map((part: Json) => part.text ?? "").join("\n");
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Comparisons use the actual npm consumer, including publication transforms. */
export function distFiles(path: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(path).sort()) {
    const child = join(path, name), stat = lstatSync(child);
    assert.ok(!stat.isSymbolicLink(), "Dist must contain ordinary files/directories");
    if (stat.isDirectory()) Object.assign(result, distFiles(child, `${prefix}${name}/`));
    else { assert.ok(stat.isFile()); result[`${prefix}${name}`] = hash(readFileSync(child)); }
  }
  return result;
}
/** Only these recovery facts are read; state is never a new authority source. */
export function targetFacts(row: Json): Json {
  return { id: row.sessionId, name: row.name, status: row.status, backend: row.backendRef,
    worktree: [row.workdir, row.worktreePath, row.worktreeBranch], lifecycle: row.worktreeLifecycle,
    merged: row.worktreeMerged };
}
export function processFields(pid: number, value: string): Identity | undefined {
  const fields = value.slice(value.lastIndexOf(") ") + 2).split(" ");
  return fields[0] === "Z" ? undefined : { pid, parent: Number(fields[1]), group: Number(fields[2]), start: fields[19] };
}
export function sameLifetime(expected: Identity, current: Identity | undefined): boolean {
  return current !== undefined && expected.pid === current.pid && expected.start === current.start;
}
function identity(pid: number): Identity | undefined {
  try { return processFields(pid, readFileSync(`/proc/${pid}/stat`, "utf8")); }
  catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code!)) return undefined; throw error; }
}
function same(old: Identity): boolean { return sameLifetime(old, identity(old.pid)); }
async function until<T>(read: () => Promise<T | undefined> | T | undefined, label: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await read(); if (value !== undefined) return value; await delay(100); }
  throw new Error(`${label}: deadline`);
}
function inside(root: string, path: string): string {
  const rel = relative(root, resolve(path));
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep), "Path escaped owned root");
  return resolve(path);
}
function readOwned(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd); assert.ok(stat.isFile()); assert.equal(stat.uid, process.getuid!()); return readFileSync(fd); }
  finally { closeSync(fd); }
}
async function listening(port: number): Promise<boolean> {
  return await new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(500); socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => { socket.destroy(); done(false); }); socket.once("timeout", () => { socket.destroy(); done(true); });
  });
}

async function main(): Promise<void> {
  assert.equal(process.argv.slice(2).length, 6, "Expected exactly three option/value pairs");
  const opts = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((pairs, arg, i, all) => {
    if (i % 2 === 0) pairs.push([arg, all[i + 1]]); return pairs;
  }, []));
  assert.deepEqual(Object.keys(opts).sort(), ["--expected-sha", "--mode", "--node-floor"]);
  assert.ok(["host", "gates", "focused"].includes(opts["--mode"]));
  assert.ok(["24.16.0", "26.1.0"].includes(opts["--node-floor"]));
  assert.match(opts["--expected-sha"], /^[a-f0-9]{40}$/);
  assert.equal(process.version, `v${opts["--node-floor"]}`);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), opts["--expected-sha"]);
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" }).trim(), "");
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");
  const fixture = resolve(process.env.OCA504_OWNED_ROOT!);
  assert.match(relative(join(ROOT, ".reports", "issue504"), fixture), /^slim\.[a-f0-9]{24}$/);
  const binding = JSON.parse(readOwned(join(fixture, ".identity")).toString());
  const verifyRoot = () => {
    assert.equal(realpathSync(fixture), fixture);
    for (const expected of [...binding.parents, { path: fixture, ...binding }]) {
      const fd = openSync(expected.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd); assert.ok(stat.isDirectory());
        assert.equal(stat.dev, expected.dev); assert.equal(stat.ino, expected.ino); assert.equal(stat.uid, process.getuid!());
      } finally { closeSync(fd); }
    }
    assert.equal(lstatSync(fixture).mode & 0o777, 0o700);
    assert.equal(readOwned(join(fixture, ".owner")).toString(), "oca504-slim-v1\n");
  };
  verifyRoot();
  const profile = inside(fixture, process.env.OPENCLAW_STATE_DIR!);
  const profileIdentity = lstatSync(profile);
  assert.ok(profileIdentity.isDirectory() && !profileIdentity.isSymbolicLink());
  assert.equal(profileIdentity.uid, process.getuid!());
  assert.equal(realpathSync(process.execPath), join(fixture, "node", "bin", "node"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  const owned = new Map<number, Identity>(), groups = new Set<number>(), ports: number[] = [];
  const commands: Json[] = [], outcomes: string[] = [], providerErrors: string[] = [];
  let stage = "setup", failure: string | undefined, cleanupFailure: string | undefined;
  let provider: ReturnType<typeof createServer> | undefined, watcher: NodeJS.Timeout | undefined;
  const nativeSeen = new Set<number>();
  const gatewayDescendants = new Set<string>();
  const lifetime = (item: Identity) => `${item.pid}:${item.start}`;
  const unproven = new Map<string, Identity>();
  let codex = "", nativeVersion = "", packageHash = "", hostBuild: Json | undefined, providerTurns = 0;
  const capture = () => {
    const snapshots = readdirSync("/proc").filter((name) => /^\d+$/.test(name)).flatMap((name) => {
      try { const value = identity(Number(name)); return value ? [value] : []; }
      catch (error) { if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code!) && !owned.has(Number(name))) return []; throw error; }
    });
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of snapshots) {
        const parent = owned.get(item.parent);
        const current = parent && !owned.has(item.pid) ? identity(item.pid) : undefined;
        if (parent && current?.start === item.start && current.parent === item.parent && same(parent)) {
          owned.set(item.pid, item); changed = true;
          if (gatewayDescendants.has(lifetime(parent))) gatewayDescendants.add(lifetime(item));
        }
      }
    }
    for (const item of snapshots) if (groups.has(item.group) && !sameLifetime(item, owned.get(item.pid))) {
      unproven.set(lifetime(item), item); // Observation never grants signalling authority.
    }
    if (codex) for (const item of owned.values()) if (gatewayDescendants.has(lifetime(item)) && same(item)) {
      try { if (realpathSync(`/proc/${item.pid}/exe`) === codex) nativeSeen.add(item.pid); }
      catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code!)) throw error; }
    }
  };
  let observationFailure = false;
  const start = (bin: string, args: string[], cwd: string, label: string) => {
    const stdoutPath = inside(fixture, join(fixture, `${commands.length}-stdout.log`));
    const stderrPath = inside(fixture, join(fixture, `${commands.length}-stderr.log`));
    const stdout = createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 });
    const stderr = createWriteStream(stderrPath, { flags: "wx", mode: 0o600 });
    const began = Date.now();
    const publicArg = (value: string) => value.replaceAll(fixture, "<owned>").replaceAll(ROOT, "<candidate>");
    const record: Json = { label, command: [publicArg(bin), ...args.map(publicArg)], exit: null, counts: {}, skips: [] }; commands.push(record);
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => {});
    const observed = identity(child.pid!); assert.ok(observed); assert.equal(observed.parent, process.pid);
    owned.set(observed.pid, observed); groups.add(observed.group);
    let bytes = 0, output = "", overflow = false, pending = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const testLine = (line: string) => {
      const count = line.match(/^[#ℹ] (tests|pass|fail|cancelled|skipped|todo) (\d+)$/);
      if (count) record.counts[count[1]] = (record.counts[count[1]] ?? 0) + Number(count[2]);
      if (/^ok \d+ - .+ # SKIP|^\s*﹣ .+ # SKIP/.test(line)) {
        if (record.skips.length < 64) record.skips.push(line.slice(0, 1000)); else overflow = true;
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length; if (bytes <= 32 * 1024 * 1024) stdout.write(chunk); else overflow = true;
      if (opts["--mode"] !== "host") process.stdout.write(chunk);
      const decoded = stdoutDecoder.write(chunk); output = (output + decoded).slice(-1_048_576);
      const lines = (pending + decoded).split("\n"); pending = lines.pop()!.slice(-65_536); lines.forEach(testLine);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length; if (bytes <= 32 * 1024 * 1024) stderr.write(chunk); else overflow = true;
      if (opts["--mode"] !== "host") process.stderr.write(chunk);
    });
    const finished = new Promise<string>((done, reject) => {
      const timer = label === "gateway" ? undefined : setTimeout(() => { record.timeout = true; reject(new Error(`${label}: deadline`)); }, opts["--mode"] !== "host" ? 2_400_000 : 300_000);
      child.once("error", () => { record.startupFailure = true; clearTimeout(timer); stdout.end(); stderr.end(); reject(new Error(`${label}: startup`)); });
      child.once("close", (code, signal) => {
        clearTimeout(timer); record.exit = code; record.signal = signal; record.outputOverflow = overflow; record.wallMs = Date.now() - began; testLine(pending + stdoutDecoder.end());
        // Logs remain private; only commands/exits and allowlisted test counts leave this profile.
        record.testSummary = output.split("\n").filter((line) => /^(?:[#ℹ] (?:tests|pass|fail|cancelled|skipped|todo|duration_ms) |Test files run:|Status:)/.test(line)).slice(-16);
        Promise.all([new Promise<void>((end) => stdout.end(end)), new Promise<void>((end) => stderr.end(end))]).then(() => {
          record.closed = true;
          if (code || signal || overflow || record.timeout) reject(new Error(`${label}: command failed`)); else done(output.trim());
        }, reject);
      });
    });
    finished.catch(() => {}); return { child, finished, identity: observed };
  };
  const run = async (bin: string, args: string[], cwd = ROOT, label = args[0]) => await start(bin, args, cwd, label).finished;
  const git = (cwd: string, ...args: string[]) => execFileSync("/usr/bin/git", ["-C", inside(fixture, cwd), ...args], { env, encoding: "utf8", timeout: 30_000 }).trim();
  const repo = (name: string) => {
    const path = inside(fixture, join(fixture, name)); mkdirSync(path);
    git(path, "init", "-b", "main"); git(path, "config", "user.name", "OCA fixture"); git(path, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(path, "base.txt"), "base\n"); git(path, "add", "base.txt"); git(path, "commit", "-m", "fixture base"); return path;
  };
  try {
    watcher = setInterval(() => { try { capture(); } catch { observationFailure = true; } }, 100);
    const pm = inside(fixture, join(fixture, "pm", "node_modules", "pnpm", "bin", "pnpm.mjs"));
    assert.equal(await run(process.execPath, [pm, "--version"], ROOT, "pnpm-version"), "11.15.1");
    if (opts["--mode"] === "focused") {
      stage = "focused-temp-boundary-tests";
      await run(process.execPath, [pm, "test:file", "tests/agent-pr-execute.test.ts", "tests/opencode-harness.test.ts", "tests/worktree.test.ts"], ROOT, stage);
      outcomes.push(stage);
    } else if (opts["--mode"] === "gates") {
      outcomes.push("frozen-install");
      const gates = [["verify"], ["check-plugin-security"], ["verify:npm-consumer"], ["audit:prod"], ["validate:release-metadata"]];
      for (const args of gates) { stage = args[0]; await run(process.execPath, [pm, ...args], ROOT, stage); outcomes.push(stage); }
      stage = "bundle-limit";
      await run(process.execPath, ["--input-type=module", "-e", "import { createBundleSizeReport } from './scripts/check-bundle-size.mjs'; const report = createBundleSizeReport(); if (report.overLimit) process.exit(1); console.log(JSON.stringify(report));"], ROOT, stage);
      outcomes.push(stage);
      stage = "packed-dry-run"; await run("npm", ["pack", "--dry-run", "--json"], ROOT, stage); outcomes.push(stage);
    } else {
      const hostPath = join(ROOT, "node_modules", "openclaw"), host = readJson(join(hostPath, "package.json"));
      assert.equal(host.version, HOST); hostBuild = readJson(join(hostPath, "dist", "build-info.json"));
      assert.equal(hostBuild.version, HOST); assert.equal(hostBuild.commit, "c074824a27c96d3983043f9eeb33823cd1772d8c");
      stage = "native-acquisition";
      await run("npm", ["install", "--prefix", join(fixture, "native"), "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "@openai/codex@0.159.3"], fixture, stage);
      codex = realpathSync(join(fixture, "native", "node_modules", "@openai", "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl", "bin", "codex"));
      inside(fixture, codex); assert.equal(readFileSync(codex).subarray(0, 4).toString("hex"), "7f454c46"); assert.equal(hash(readFileSync(codex)), NATIVE_HASH);
      nativeVersion = await run(codex, ["--version"], fixture, "codex-version"); assert.equal(nativeVersion, `codex-cli ${NATIVE}`);
      let releaseCommit: (() => void) | undefined;
      const commitBarrier = new Promise<void>((done) => { releaseCommit = done; });
      let commitReleased = false;
      provider = createServer(async (request, response) => {
        try {
          assert.equal(request.socket.remoteAddress, "127.0.0.1"); assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/responses");
          let body = ""; for await (const chunk of request) { body += chunk; assert.ok(Buffer.byteLength(body) <= 1_048_576); }
          const input = JSON.parse(body);
          const tokens = JSON.stringify((input.input ?? []).filter((item: Json) => item.role === "user")).match(/OCA504_[A-Z0-9]+/g) ?? [];
          const marker = tokens.at(-1) ?? "BACKGROUND";
          if (marker === "OCA504_COMMIT" && !commitReleased) await commitBarrier;
          const item: Json = { type: "message", id: `msg_${randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `Fixture completed ${marker}`, annotations: [], logprobs: [] }] };
          const value: Json = { id: `resp_${randomUUID()}`, object: "response", created_at: Math.floor(Date.now() / 1_000), status: "completed", model: input.model, output: [item], error: null, incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
          const frames: Json[] = [
            { type: "response.created", response: { ...value, status: "in_progress", output: [] } },
            { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
            { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
            { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text },
            { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text },
            { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
            { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: value },
          ];
          providerTurns++; response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(frames.map((frame, sequence_number) => `event: ${frame.type}\ndata: ${JSON.stringify({ ...frame, sequence_number })}\n\n`).join(""));
        } catch { providerErrors.push("model-protocol"); if (!response.headersSent) response.writeHead(500); response.end(); }
      });
      await new Promise<void>((done) => provider!.listen(0, "127.0.0.1", done));
      const providerPort = (provider.address() as { port: number }).port; ports.push(providerPort);
      const socket = createServer(); await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
      const port = (socket.address() as { port: number }).port; await new Promise<void>((done) => socket.close(() => done())); ports.push(port);
      const baseUrl = `http://127.0.0.1:${providerPort}/v1`, token = randomBytes(32).toString("hex");
      env.OPENCLAW_CODEX_APP_SERVER_COMMAND = codex; env.OPENCLAW_WORKTREE_DIR = join(fixture, "worktrees");
      writeFileSync(join(env.CODEX_HOME!, "config.toml"), [
        'model = "gpt-6.1-sol"', 'model_provider = "fixture"', 'approval_policy = "never"', 'sandbox_mode = "workspace-write"',
        'check_for_update_on_startup = false', '[model_providers.fixture]', 'name = "Disposable fixture"', `base_url = "${baseUrl}"`,
        'env_key = "OCA504_FIXTURE_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
        'request_max_retries = 0', 'stream_max_retries = 0', '[otel]', 'exporter = "none"', 'trace_exporter = "none"',
      ].join("\n"), { mode: 0o600 });
      mkdirSync(join(env.HOME!, ".codex")); writeFileSync(join(env.HOME!, ".codex", "config.toml"), readFileSync(join(env.CODEX_HOME!, "config.toml")), { mode: 0o600 });
      const logging = { file: join(fixture, "openclaw.log"), level: "info" };
      const bootstrapConfig = { logging, gateway: { mode: "local", bind: "loopback", port } };
      writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(bootstrapConfig), { mode: 0o600 });
      const cli = (...args: string[]) => run(process.execPath, [join(hostPath, "openclaw.mjs"), ...args], fixture, `host-${args.slice(0, 2).join("-")}`);
      stage = "pack-install";
      const packedDir = join(fixture, "packed"); mkdirSync(packedDir);
      const pack = JSON.parse(await run(process.execPath, [pm, "pack", "--json", "--pack-destination", packedDir], ROOT, "pack"));
      const tarball = inside(fixture, resolve(packedDir, (Array.isArray(pack) ? pack[0] : pack).filename)); packageHash = hash(readFileSync(tarball));
      const consumer = join(fixture, "consumer"); mkdirSync(consumer); writeFileSync(join(consumer, "package.json"), '{"name":"oca504-reference","private":true}');
      await run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", tarball], consumer, "reference-install");
      const reference = join(consumer, "node_modules", "openclaw-code-agent");
      assert.deepEqual(distFiles(join(reference, "dist")), distFiles(join(ROOT, "dist")));
      const publication = readJson(join(reference, "package.json")), source = readJson(join(ROOT, "package.json"));
      for (const key of ["name", "version", "main", "openclaw", "dependencies", "peerDependencies"]) assert.deepEqual(publication[key], source[key]);
      verifyRoot();
      const currentProfile = lstatSync(profile);
      assert.ok(currentProfile.isDirectory() && !currentProfile.isSymbolicLink());
      assert.equal(currentProfile.dev, profileIdentity.dev); assert.equal(currentProfile.ino, profileIdentity.ino);
      assert.equal(currentProfile.uid, process.getuid!());
      assert.deepEqual(readJson(env.OPENCLAW_CONFIG_PATH!), bootstrapConfig, "No previous plugin install/config reference");
      const extensions = join(profile, "extensions");
      try {
        const stat = lstatSync(extensions);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); assert.equal(stat.uid, process.getuid!());
        assert.deepEqual(readdirSync(extensions), [], "Archive acknowledgement must never overwrite an existing install");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      assert.equal(hash(readFileSync(tarball)), packageHash);
      // --force acknowledges a non-ClawHub source; this profile has no replacement target.
      await cli("plugins", "install", "--force", "--accept-capabilities", tarball); await cli("plugins", "enable", "openclaw-code-agent");
      const installedConfig = readJson(env.OPENCLAW_CONFIG_PATH!);
      const inspect = readJsonFrom(await cli("plugins", "inspect", "openclaw-code-agent", "--json"));
      assert.equal(inspect.plugin.id, "openclaw-code-agent"); assert.equal(inspect.plugin.enabled, true); assert.equal(inspect.plugin.status, "loaded");
      assert.equal(inspect.install.source, "archive"); assert.equal(realpathSync(inspect.install.sourcePath), tarball);
      const installed = inside(env.OPENCLAW_STATE_DIR!, realpathSync(inspect.install.installPath));
      assert.equal(realpathSync(inspect.plugin.rootDir), installed); assert.equal(realpathSync(inspect.plugin.source), join(installed, "dist", "index.js"));
      assert.deepEqual(distFiles(join(installed, "dist")), distFiles(join(reference, "dist")));
      for (const name of ["package.json", "openclaw.plugin.json", "npm-shrinkwrap.json"]) assert.equal(hash(readFileSync(join(installed, name))), hash(readFileSync(join(reference, name))));
      assert.equal(hash(readFileSync(tarball)), packageHash); outcomes.push("same-packed-artifact-installed");
      const config = {
        ...installedConfig, logging,
        gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token }, controlUi: { enabled: false } },
        models: { mode: "replace", providers: { fixture: {
          baseUrl, apiKey: "synthetic-local-fixture-only", api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [{ id: "gpt-6.1-sol", name: "Fixture", reasoning: false, input: ["text"],
            contextWindow: 100_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        } } },
        agents: { defaults: { workspace: join(fixture, "workspace"), model: { primary: "fixture/gpt-6.1-sol" } } },
        tools: { profile: "minimal", alsoAllow: ["agent_*"], toolSearch: false, exec: { mode: "full" } },
        plugins: {
          ...installedConfig.plugins, allow: ["openclaw-code-agent"], slots: { memory: "none" },
          entries: { ...installedConfig.plugins.entries, "openclaw-code-agent": {
            enabled: true, config: {
              autoUpdate: false, defaultHarness: "codex", defaultWorktreeStrategy: "off",
              permissionMode: "default", planApproval: "delegate",
              harnesses: { codex: { defaultModel: "gpt-6.1-sol", permissionProfile: ":workspace", approvalPolicy: "never" } },
            },
          } },
        },
        cron: { enabled: false }, browser: { enabled: false },
      };
      mkdirSync(config.agents.defaults.workspace); writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config), { mode: 0o600 });
      await cli("config", "validate"); env.OPENCLAW_GATEWAY_TOKEN = token;
      stage = "gateway-admission";
      const gateway = start(process.execPath, [join(hostPath, "openclaw.mjs"), "gateway", "run", "--port", String(port), "--bind", "loopback"], fixture, "gateway");
      gatewayDescendants.add(lifetime(gateway.identity));
      await until(async () => { assert.equal(gateway.child.exitCode, null); return await listening(port) ? true : undefined; }, "Gateway listener");
      const invoke = async (name: string, args: Json, auth = token): Promise<Json> => {
        const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth}`, "x-openclaw-message-channel": "webchat", "x-openclaw-message-to": "agent:main:main" }, body: JSON.stringify({ tool: name, args, sessionKey: "agent:main:main" }), signal: AbortSignal.timeout(125_000) });
        const value = await response.json() as Json; return { status: response.status, ...value };
      };
      const tool = async (name: string, args: Json) => { const value = await invoke(name, args); assert.equal(value.status, 200); assert.equal(value.ok, true); assert.ok(value.result); return value.result as Json; };
      const unauthorized = await invoke("agent_sessions", {}, "wrong-disposable-token"); assert.equal(unauthorized.status, 401);
      const unavailable = await invoke("oca504_unavailable", {}); assert.equal(unavailable.status, 404);
      const storePath = join(env.OPENCLAW_STATE_DIR!, "code-agent-sessions.json");
      const store = () => existsSync(storePath) ? readJson(storePath) : { sessions: [], repoPolicies: [] };
      const row = (id: string) => store().sessions.find((item: Json) => item.sessionId === id);
      const output = async (id: string) => text(await tool("agent_output", { session: id, full: true }));
      const launch = async (name: string, workdir: string, marker: string, strategy = "off") => {
        const before = new Set(store().sessions.map((item: Json) => item.sessionId));
        await tool("agent_launch", { name, workdir, harness: "codex", prompt: `Reply with the fixture marker ${marker}`, force_new_session: true, worktree_strategy: strategy });
        return await until(() => store().sessions.find((item: Json) => !before.has(item.sessionId) && item.name === name && item.backendRef?.conversationId), "persisted native target");
      };
      const completed = async (target: Json, marker: string) => {
        await until(async () => (await output(target.sessionId)).includes(`Fixture completed ${marker}`) ? true : undefined, "selected native output");
        await until(() => row(target.sessionId)?.status === "completed" ? true : undefined, "persisted native completion");
        assert.equal(row(target.sessionId).backendRef.conversationId, target.backendRef.conversationId);
      };
      stage = "exact-target-and-alias";
      const unrelatedRepo = repo("unrelated"), selectedRepo = repo("selected");
      const unrelated = await launch("unrelated", unrelatedRepo, "OCA504_OTHER"); await completed(unrelated, "OCA504_OTHER");
      const old = await launch("same-name", selectedRepo, "OCA504_OLD"); await completed(old, "OCA504_OLD");
      const newer = await launch("same-name", selectedRepo, "OCA504_NEW"); await completed(newer, "OCA504_NEW");
      assert.notEqual(old.sessionId, newer.sessionId); assert.notEqual(old.backendRef.conversationId, newer.backendRef.conversationId);
      await tool("agent_respond", { session: "same-name", message: "OCA504_ALIAS" }); await completed(newer, "OCA504_ALIAS");
      assert.ok(!(await output(old.sessionId)).includes("OCA504_ALIAS"));
      await tool("agent_respond", { session: old.sessionId, message: "OCA504_EXACT" }); await completed(old, "OCA504_EXACT");
      assert.ok(!(await output(newer.sessionId)).includes("OCA504_EXACT")); assert.ok(!(await output(old.sessionId)).includes("OCA504_NEW"));
      assert.ok(nativeSeen.size > 0 && providerTurns > 0, "Actual owned native executable and model turn required"); outcomes.push("native-exact-old-and-new-alias-output-persistence");
      const targets = [old, newer, unrelated];
      const snapshot = async () => ({ facts: targets.map((target) => targetFacts(row(target.sessionId))), outputs: await Promise.all(targets.map(async (target) => (await output(target.sessionId)).split("\n").slice(1).join("\n"))), refs: [git(selectedRepo, "show-ref"), git(unrelatedRepo, "show-ref")], files: [readFileSync(join(selectedRepo, "base.txt"), "utf8"), readFileSync(join(unrelatedRepo, "base.txt"), "utf8")] });
      stage = "structured-reference-refusals";
      const before = await snapshot();
      const refusedCalls: Array<{ name: string; args: Json }> = [
        { name: "agent_respond", args: { message: "OCA504_REFUSED" } },
        { name: "agent_merge", args: { base_branch: "main", push: false } },
        { name: "agent_escalate", args: { kind: "plan", summary: "Fixture" } },
        { name: "agent_output", args: { full: true } },
      ];
      for (const ref of ["unknown-fixture-target", "***", " "]) for (const call of refusedCalls) {
        const result = await tool(call.name, { ...call.args, session: ref });
        assert.equal(result.isError, true); assert.equal(result.details.code, ref === "unknown-fixture-target" ? "session_not_found" : "session_reference_unusable");
        assert.equal(result.details.operationStarted, false); assert.equal(result.details.targetSelected, false);
        if (ref.trim()) assert.ok(!JSON.stringify(result).includes(ref));
        for (const target of targets) assert.ok(!JSON.stringify(result).includes(target.sessionId) && !JSON.stringify(result).includes(target.backendRef.conversationId));
      }
      assert.deepEqual(await snapshot(), before); outcomes.push("four-tool-unknown-masked-blank-no-observed-effects");
      stage = "managed-worktree-setup";
      const mergeRepo = repo("merge"); git(mergeRepo, "remote", "add", "origin", "https://github.com/goldmar/openclaw-code-agent");
      const managed = await launch("managed", mergeRepo, "OCA504_COMMIT", "manual");
      const worktree = inside(fixture, realpathSync(managed.worktreePath)); assert.ok(managed.worktreeBranch); assert.equal(managed.workdir, mergeRepo);
      writeFileSync(join(worktree, "selected.txt"), "selected fixture change\n"); git(worktree, "add", "selected.txt"); git(worktree, "commit", "-m", "fixture selected change");
      commitReleased = true; releaseCommit!(); await completed(managed, "OCA504_COMMIT");
      stage = "managed-seeded-launch-policy";
      assert.equal(row(managed.sessionId).repoIntegrationPolicy, "pr-required");
      assert.equal(row(managed.sessionId).repoIntegrationPolicySource, "seeded");
      const beforeMerge = { main: git(mergeRepo, "rev-parse", "main"), tip: git(mergeRepo, "rev-parse", managed.worktreeBranch), other: targetFacts(row(unrelated.sessionId)), otherRef: git(unrelatedRepo, "show-ref") };
      stage = "managed-policy-refusal";
      await tool("agent_merge", { session: managed.sessionId, base_branch: "main", push: false, delete_branch: false });
      assert.equal(git(mergeRepo, "rev-parse", "main"), beforeMerge.main); assert.equal(git(mergeRepo, "rev-parse", managed.worktreeBranch), beforeMerge.tip);
      assert.equal(existsSync(join(mergeRepo, "selected.txt")), false); assert.ok(existsSync(worktree)); assert.ok(!row(managed.sessionId).worktreeMerged);
      assert.deepEqual(targetFacts(row(unrelated.sessionId)), beforeMerge.other); assert.equal(git(unrelatedRepo, "show-ref"), beforeMerge.otherRef);
      stage = "managed-current-policy-change";
      await tool("agent_repo_policy", { workdir: mergeRepo, policy: "never-pr" });
      await until(() => store().repoPolicies.find((item: Json) => item.repoRoot === mergeRepo)?.policy === "never-pr" ? true : undefined, "fixture policy persisted");
      stage = "managed-selected-merge-effects";
      await tool("agent_merge", { session: managed.sessionId, base_branch: "main", push: false, delete_branch: false });
      const keptTip = git(mergeRepo, "rev-parse", managed.worktreeBranch); git(mergeRepo, "merge-base", "--is-ancestor", keptTip, "main");
      assert.notEqual(git(mergeRepo, "rev-parse", "main"), beforeMerge.main); assert.equal(readFileSync(join(mergeRepo, "selected.txt"), "utf8"), "selected fixture change\n");
      await until(() => row(managed.sessionId)?.worktreeLifecycle?.state === "merged" ? true : undefined, "selected merged lifecycle");
      assert.equal(existsSync(worktree), false); assert.deepEqual(targetFacts(row(unrelated.sessionId)), beforeMerge.other); assert.equal(git(unrelatedRepo, "show-ref"), beforeMerge.otherRef);
      outcomes.push("managed-policy-refusal-and-selected-merge-effects");
      assert.deepEqual(providerErrors, []); assert.equal(observationFailure, false);
    }
  } catch (error) {
    failure = stage;
    writeFileSync(join(fixture, "failure.log"), error instanceof Error ? error.stack ?? error.name : "Unknown failure", { mode: 0o600 });
  }
  finally {
    const errors: string[] = [];
    try { capture(); } catch { errors.push("ownership-observation"); }
    const signal = (value: NodeJS.Signals) => { for (const item of [...owned.values()].reverse()) { try { if (same(item)) process.kill(item.pid, value); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push("owned-signal"); } } };
    try { signal("SIGTERM"); await until(() => [...owned.values()].every((item) => !same(item)) ? true : undefined, "owned shutdown", 5000); }
    catch { try { signal("SIGKILL"); await until(() => [...owned.values()].every((item) => !same(item)) ? true : undefined, "owned forced shutdown", 5000); } catch { errors.push("owned-survivor"); } }
    if (provider) { try { provider.closeAllConnections(); await new Promise<void>((done, reject) => provider!.close((error) => error ? reject(error) : done())); } catch { errors.push("provider-close"); } }
    if (watcher) clearInterval(watcher);
    try { await until(() => commands.every((item) => item.closed || item.startupFailure) ? true : undefined, "command stream close", 5000); }
    catch { errors.push("command-stream-close"); }
    for (const port of ports) if (await listening(port)) errors.push("listener-survivor");
    try {
      await until(() => {
        capture();
        // Direct reads retain the original lifetime even after reparent/group changes.
        const survivors = [...owned.values(), ...unproven.values()].filter((item) => same(item));
        return survivors.length === 0 ? true : undefined;
      }, "unproven terminal lifetimes", 5000);
    } catch { errors.push("ownership-final"); }
    if (observationFailure) errors.push("ownership-watch");
    if (errors.length) cleanupFailure = [...new Set(errors)].join(",");
    // Failed profiles/logs remain private under the runner's lifetime; no storage-erasure claim.
    if (!failure && !cleanupFailure) {
      try { verifyRoot(); rmSync(fixture, { recursive: true }); assert.equal(existsSync(fixture), false); }
      catch { cleanupFailure = "owned-root-removal"; }
    }
  }
  console.log(JSON.stringify({
    kind: "ISSUE504_REPRESENTATIVE_ACCEPTANCE", candidateSha: opts["--expected-sha"],
    node: process.version, mode: opts["--mode"], status: failure || cleanupFailure ? "BLOCKED" : "PASS",
    failure, cleanup: cleanupFailure ?? "PASS", finalAcceptance: false,
    packageSha256: packageHash || undefined, host: hostBuild && { version: HOST, commit: hostBuild.commit },
    native: nativeVersion && { version: NATIVE, executableSha256: NATIVE_HASH, ownedExecutionObserved: nativeSeen.size > 0 },
    commands, outcomes, simulated: opts["--mode"] === "host" ? ["model-provider"] : [],
    unprovenRemote: ["queued-six-Git-races", "same-call-id-retries", "uncertain-native-ack", "live-plan-ask",
      "embedded-direct-deferred", "external-providers", "restart-multi-registry", "zero-unobserved-invocations", "retained-storage-disposition"],
  }));
  process.exitCode = failure || cleanupFailure ? 1 : 0;
}
function readJsonFrom(value: string): Json { return JSON.parse(value); }
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) void main().catch(() => { console.error("ISSUE504_PRECONDITION_BLOCKED"); process.exitCode = 1; });
