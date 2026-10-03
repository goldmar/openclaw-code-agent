#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createIsolatedOpenClawEnv, validatePackedPluginRuntime } from "./check-plugin-security.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const execute = promisify(execFile);
const pluginId = "openclaw-code-agent";

function validateExcludedPlugin(result, before, after) {
  assert.equal(after, before, "discovery must preserve plugin configuration");
  assert.ok(!result.plugins?.some((plugin) => plugin.id === pluginId
    && (plugin.status === "loaded" || plugin.toolNames?.length)));
}

/**
 * A skipped plugin must not register tools or mutate its preserved configuration.
 * `reason` is the start of the host diagnostic for the declaration under test, so
 * an invalid range and an unsatisfied range cannot pass on each other's message.
 */
export function validateDiscoveryRejection(result, before, after, reason) {
  validateExcludedPlugin(result, before, after);
  assert.ok(result.diagnostics?.some((diagnostic) => diagnostic.pluginId === pluginId
    && diagnostic.configDisposition === "preserve"
    && diagnostic.message?.startsWith(reason)
    && diagnostic.message.includes("; skipping discovery")), "expected a preserved discovery diagnostic");
}

/** The older host enforces installation metadata during discovery too. */
export function validateHostMinimumRejection(result, before, after, minimum, hostVersion) {
  validateExcludedPlugin(result, before, after);
  assert.ok(result.diagnostics?.some((diagnostic) => diagnostic.pluginId === pluginId
    && diagnostic.message === `plugin requires OpenClaw ${minimum}, but this host is ${hostVersion}; skipping load`),
  "expected explicit host minimum rejection");
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
  return port;
}

async function main() {
  const args = process.argv.slice(process.argv[2] === "--" ? 3 : 2);
  assert.ok(args.every((arg, index) => arg === "--gateway" || arg === "--host-root"
    || (index > 0 && args[index - 1] === "--host-root")), "usage: [--gateway] [--host-root PATH]");
  const hostArg = args.indexOf("--host-root");
  if (hostArg >= 0) assert.ok(args[hostArg + 1] && !args[hostArg + 1].startsWith("--"));
  const hostRoot = resolve(hostArg >= 0 ? args[hostArg + 1] : join(root, "node_modules/openclaw"));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, "openclaw.plugin.json"), "utf8"));
  const host = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
  assert.ok([pkg.openclaw.build.openclawVersion, pkg.openclaw.compat.minGatewayVersion].includes(host.version),
    "host must match the exact target or declared compatibility floor");
  const cli = join(hostRoot, "openclaw.mjs");
  const temp = await mkdtemp(join(tmpdir(), "oca-host-compat-"));
  const results = [];
  let stage = "pack";
  try {
    const pack = await execute("npm", ["pack", "--json", "--pack-destination", temp], { cwd: root });
    const packed = JSON.parse(pack.stdout)[0];
    const tarball = join(temp, packed.filename);
    const digest = createHash("sha256").update(await readFile(tarball)).digest("hex");
    const scenarios = host.version === pkg.openclaw.build.openclawVersion
      ? ["default", "offer-enabled", "invalid-api", "incompatible-api"]
      : ["host-minimum"];
    for (const scenario of scenarios) {
      stage = scenario;
      const directory = join(temp, scenario);
      const candidate = join(directory, "candidate");
      const profile = join(directory, "profile");
      await mkdir(candidate, { recursive: true });
      await mkdir(profile);
      await execute("tar", ["-xzf", tarball, "--strip-components=1", "-C", candidate]);
      // Runtime dependencies resolve independently of the source tree's entry.
      // Production installation is exercised by the separate security gate.
      await mkdir(join(candidate, "node_modules"), { recursive: true });
      await symlink(hostRoot, join(candidate, "node_modules/openclaw"), "dir");
      for (const dependency of Object.keys(pkg.dependencies)) {
        const target = join(candidate, "node_modules", dependency);
        await mkdir(dirname(target), { recursive: true });
        await symlink(join(root, "node_modules", dependency), target, "dir");
      }
      // The host only calls a declaration invalid when it is empty or not a string;
      // a malformed range string is reported as an unsatisfied requirement.
      const rejectedApi = scenario === "invalid-api" ? "" : ">=2099.1.1";
      if (scenario.endsWith("api")) {
        const fixture = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
        fixture.openclaw.compat.pluginApi = rejectedApi;
        await writeFile(join(candidate, "package.json"), JSON.stringify(fixture));
      }
      const port = await freePort();
      const env = createIsolatedOpenClawEnv(profile);
      for (const key of Object.keys(env)) {
        if (/^(?:CLAWDBOT_|CODEX_|ANTHROPIC_|OPENAI_)/u.test(key) || /(?:TOKEN|SECRET|API_KEY)$/u.test(key)) delete env[key];
      }
      env.OPENCLAW_GATEWAY_PORT = String(port);
      const config = {
        gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token: randomBytes(32).toString("hex") } },
        agents: { defaults: { workspace: join(profile, "workspace") } },
        plugins: { allow: [pluginId], load: { paths: [candidate] }, entries: {
          codex: { enabled: false }, [pluginId]: { enabled: true, config: {
            autoUpdate: false, planOfferTool: scenario === "offer-enabled",
          } },
        } },
      };
      const configText = JSON.stringify(config);
      await writeFile(env.OPENCLAW_CONFIG_PATH, configText, { mode: 0o600 });
      const call = async (...command) => execute(process.execPath, [cli, ...command], {
        env, cwd: profile, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
      });
      if (scenario === "host-minimum") {
        const listed = JSON.parse((await call("plugins", "list", "--json")).stdout);
        validateHostMinimumRejection(listed, configText, await readFile(env.OPENCLAW_CONFIG_PATH, "utf8"),
          pkg.openclaw.install.minHostVersion, host.version);
      } else if (scenario.endsWith("api")) {
        const listed = JSON.parse((await call("plugins", "list", "--json")).stdout);
        validateDiscoveryRejection(listed, configText, await readFile(env.OPENCLAW_CONFIG_PATH, "utf8"),
          scenario === "invalid-api" ? "invalid package plugin API metadata:"
            : `plugin requires plugin API ${rejectedApi}, but this host is ${host.version};`);
      } else {
        const inspection = JSON.parse((await call("plugins", "inspect", pluginId, "--runtime", "--json")).stdout);
        const tools = manifest.contracts.tools.filter((name) => scenario === "offer-enabled" || name !== "agent_send_plan_offer");
        validatePackedPluginRuntime(inspection, pkg.version, tools);
        const names = inspection.tools.flatMap((entry) => entry.names);
        assert.equal(names.includes("agent_send_plan_offer"), scenario === "offer-enabled");
        assert.equal(names.length, tools.length);
        if (args.includes("--gateway")) {
          stage = `${scenario}-gateway`;
          const gateway = spawn(process.execPath, [cli, "gateway", "run"], { env, cwd: profile, stdio: "ignore" });
          let exited = false;
          const closed = new Promise((done) => { gateway.once("error", () => { exited = true; done(); }); gateway.once("close", () => { exited = true; done(); }); });
          try {
            const rpc = async (method, params = {}) => JSON.parse((await call("gateway", "call", method,
              "--json", "--timeout", "10000", "--params", JSON.stringify(params))).stdout);
            let ready = false;
            for (let attempt = 0; attempt < 30 && !exited; attempt++) {
              try { await rpc("health"); ready = true; break; } catch { await new Promise((done) => setTimeout(done, 500)); }
            }
            assert.ok(ready, "isolated Gateway failed readiness");
            const sessionKey = "agent:main:compatibility-qa";
            await rpc("sessions.create", { key: sessionKey });
            const effective = await rpc("tools.effective", { sessionKey });
            const effectiveNames = effective.groups.flatMap((group) => group.tools.map((tool) => tool.id));
            assert.ok(tools.every((tool) => effectiveNames.includes(tool)), "missing effective OCA tools");
            const invoked = await rpc("tools.invoke", { name: "agent_stats", sessionKey, args: {} });
            assert.equal(invoked.ok, true);
            assert.ok(!invoked.output?.isError);
            assert.ok(invoked.output?.content?.some((item) => item.type === "text" && item.text.trim()));
            config.tools = { deny: ["agent_stats"] };
            await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });
            let denied = false;
            for (let attempt = 0; attempt < 20; attempt++) {
              const result = await rpc("tools.invoke", { name: "agent_stats", sessionKey, args: {} });
              if (result.ok === false && ["not_found", "forbidden"].includes(result.error?.code)) { denied = true; break; }
              await new Promise((done) => setTimeout(done, 500));
            }
            assert.ok(denied, "tool denial did not apply after reload");
            const restricted = await rpc("tools.effective", { sessionKey });
            assert.ok(!restricted.groups.some((group) => group.tools.some((tool) => tool.id === "agent_stats")));
          } finally {
            if (!exited) gateway.kill("SIGTERM");
            const timeout = setTimeout(() => { if (!exited) gateway.kill("SIGKILL"); }, 10_000);
            try { await closed; } finally { clearTimeout(timeout); }
          }
        }
      }
      results.push({ scenario, status: "passed" });
    }
    console.log(JSON.stringify({ hostVersion: host.version, packageVersion: pkg.version, tarballSha256: digest,
      gatewayChecked: args.includes("--gateway") && host.version === pkg.openclaw.build.openclawVersion, results }, null, 2));
  } catch (error) {
    // Do not print subprocess output or config; the isolated profile contains auth.
    // A subprocess failure's message embeds its stderr and a JSON parse error quotes
    // its input, so report only how those ended.
    const reason = error?.cmd !== undefined
      ? `subprocess ${error.killed ? "timed out" : `exited with ${error.code ?? error.signal}`}`
      : error instanceof SyntaxError ? "unparseable subprocess output"
        : error instanceof Error ? error.message : String(error);
    console.error(`OpenClaw compatibility check failed at ${stage}: ${reason}`);
    process.exitCode = 1;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) void main();
