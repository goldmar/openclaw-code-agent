import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { HostEvidence, FIXTURE_PLAN, nativePlanBoundary, publicOutputObservation, waitingPlanObservation, hasLivePlanBoundary, requireAskPlanRefusal, publicAliasOwner, negativeSnapshot, assertNegativeWindow, providerSseObservation, planRowObservation, responseResumeBoundary, requireResponseResume, seedObserverAllow, managedObserverAllow, generationObservation, stoppedGeneration, killResultClass, freshResume, assertAliasProtection, requireHttpBefore, requireEmbeddedAfter, classifyProvider, selectedProvider, installObserver, verifyObserverInspection, closeFailedProviderResponse, subscribeFixtureMessages, projectFixtureHostEvent, hasFreshSubscribedTerminal, type FixtureSessionSubscription, command, fixtureEnv, FIXTURE_MARKER, functionItem, messageItem, ownedPath, preparePackedInstaller, validatePackSource, verifyPackedPluginInspection, freshPluginBootstrap, requireCandidate, responseFrames, sha256, stopOwnedChild, trackOwnedChild, stopNativeProcesses, captureDescendants, cleanupAll, sameProcess, processIdentity, until, writeNativeRelay, writeHostObserver, validateNativeExecutable, NATIVE_CODEX_SHA256, type ProcessIdentity, type FixtureCall } from "./oca-issue-504-host-fixtures";

type Json = Record<string, any>;
type Scenario = { calls: Array<FixtureCall | { deferred: FixtureCall }>; cursor: number; results: Json[]; emitted: Array<{ id: string; itemId: string; hostCallId: string; target: FixtureCall; catalogId?: string }>; schemas: Json[][]; searching?: FixtureCall; final: boolean; nativeTarget: Json; resumeWindows: Array<ReturnType<typeof responseResumeBoundary>> };
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FOUR = ["agent_respond", "agent_merge", "agent_escalate", "agent_output"];
const HOST = "2026.9.7";
const lanes = { rpc: "REAL_HOST_RPC_NATIVE_CODEX", embedded: "REAL_HOST_SUBSCRIBED_EMBEDDED_SIMULATED_PROVIDER" };
let failureReport: Json | undefined;
const text = (value: Json) => value.content?.map((part: Json) => part.text ?? "").join("\n") ?? "";
const parse = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const records = (path: string): Json[] => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

export function options(argv: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(["--expected-sha", "--codex-bin", "--codex-version"].includes(argv[i]) && argv[i + 1], "Usage: --expected-sha <40hex> --codex-bin <absolute native executable> --codex-version <exact version>");
    assert.ok(!result[argv[i]], "Duplicate acceptance option");
    result[argv[i]] = argv[i + 1];
  }
  assert.ok(result["--expected-sha"] && result["--codex-bin"] && result["--codex-version"], "All exact provenance options are required");
  return result;
}
/** Pinned Responses conversion carries both IDs into the actual tool hook. */
export function compositeToolCallId(callId: string, itemId: string): string {
  assert.ok(callId && itemId && callId.trim() === callId && itemId.trim() === itemId && !callId.includes("|") && !itemId.includes("|"), "Fixture call/item IDs must be exact, distinct components");
  return `${callId}|${itemId}`;
}
function strings(value: any): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
function findCatalogId(value: any, name: string): string | undefined {
  if (typeof value === "string") { try { return findCatalogId(JSON.parse(value), name); } catch { return undefined; } }
  if (Array.isArray(value)) return value.map((item) => findCatalogId(item, name)).find(Boolean);
  if (!value || typeof value !== "object") return undefined;
  if (value.name === name && typeof value.id === "string") return value.id;
  return Object.values(value).map((item) => findCatalogId(item, name)).find(Boolean);
}
function toolResults(body: Json): Json[] {
  return (body.input ?? []).filter((item: Json) => item.type === "function_call_output").map((item: Json) => ({ callId: item.call_id, output: item.output }));
}
export function nativeResult(value: any): Json | undefined {
  if (typeof value === "string") { try { return nativeResult(JSON.parse(value)); } catch { return undefined; } }
  if (Array.isArray(value)) return value.map(nativeResult).find(Boolean);
  if (!value || typeof value !== "object") return undefined;
  if (value.details?.status === "error" && typeof value.details.code === "string") return value;
  return Object.values(value).map(nativeResult).find(Boolean);
}

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2));
  const expectedSha = opts["--expected-sha"];
  requireCandidate(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }), expectedSha,
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }));
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");
  assert.ok(["v24.16.0", "v26.1.0"].includes(process.version), "Native acceptance must run at a supported exact Node floor");
  for (const file of ["scripts/e2e/oca-issue-504-host-acceptance.ts", "scripts/e2e/oca-issue-504-host-fixtures.ts"]) {
    assert.equal(sha256(execFileSync("git", ["show", `HEAD:${file}`], { cwd: root })), sha256(readFileSync(join(root, file))), "Acceptance source must belong to exact committed candidate");
  }
  const hostPath = join(root, "node_modules", "openclaw");
  const hostPackage = parse(join(hostPath, "package.json"));
  assert.equal(hostPackage.version, HOST);
  const hostBuildBytes = existsSync(join(hostPath, "dist", "build-info.json")) ? readFileSync(join(hostPath, "dist", "build-info.json")) : undefined;
  const hostBuild = hostBuildBytes ? JSON.parse(hostBuildBytes.toString()) : undefined;
  if (hostBuild) { assert.equal(hostBuild.version, HOST); if (hostBuild.commit != null) assert.match(hostBuild.commit, /^[a-f0-9]{40}$/); }
  const hostLockSRI = readFileSync(join(root, "pnpm-lock.yaml"), "utf8").match(/\n  openclaw@2026\.9\.7:\n    resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/)?.[1];
  assert.ok(hostLockSRI, "Official pinned npm lock integrity is required");
  const evidence = new HostEvidence(join(root, ".reports", "issue504"), process.version, expectedSha);
  evidence.paths.push(root);
  const fixture = mkdtempSync(join(tmpdir(), "oca-issue-504-host-"));
  evidence.paths.push(fixture);
  writeFileSync(join(fixture, ".fixture-owner"), FIXTURE_MARKER, { mode: 0o600 });
  const ownedChildren = new Set<ChildProcess>();
  const clients = new Set<GatewayClient>();
  const listenerPorts: number[] = [];
  let provider: ReturnType<typeof createServer> | undefined;
  let summary: Json | undefined;
  let originalFailure: unknown;
  let cleanupFailure: unknown;
  let evidenceReceipt: { path: string; manifestSha256: string } | undefined;
  let nativeWatch: NodeJS.Timeout | undefined;
  const nativeObservationErrors: string[] = [];
  let providerTraffic = 0;
  const providerRequests: Json[] = [];
  const nativeProcesses = new Map<number, ProcessIdentity>();
  const observeNative = () => {
    try {
    for (const event of records(join(fixture, "native-events.jsonl"))) {
      for (const identity of [event.relayIdentity, event.nativeIdentity]) if (identity && !nativeProcesses.has(identity.pid)) nativeProcesses.set(identity.pid, identity);
    }
    for (const child of ownedChildren) {
      if (!child.pid || nativeProcesses.has(child.pid) || child.exitCode !== null || child.signalCode !== null) continue;
      const identity = processIdentity(child.pid);
      if (identity) { assert.equal(identity.parentPid, process.pid); assert.equal(identity.group, child.pid); assert.equal(identity.executable, realpathSync(process.execPath)); nativeProcesses.set(child.pid, identity); }
    }
    captureDescendants(nativeProcesses);
    } catch (error) { evidence.failure("native-observer", error); throw error; }
  };
  try {
  const env = fixtureEnv(fixture);
  for (const key of ["HOME", "OPENCLAW_STATE_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR", "GH_CONFIG_DIR", "NPM_CONFIG_CACHE"]) mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
  for (const path of [env.GIT_CONFIG_GLOBAL!, env.NPM_CONFIG_USERCONFIG!, env.NPM_CONFIG_GLOBALCONFIG!]) writeFileSync(path, "", { mode: 0o600 });
  const logging = { file: ownedPath(fixture, join(fixture, "openclaw.log")), level: "info" as const };
  writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify({ logging, gateway: { mode: "local" } }), { mode: 0o600 });
  // SDK globals must initialize under the same hermetic environment as children.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  const { GatewayClient } = await import("openclaw/plugin-sdk/gateway-runtime");
  const codex = realpathSync(opts["--codex-bin"]);
  validateNativeExecutable(readFileSync(codex), opts["--codex-version"]);
  evidence.paths.push(dirname(codex));
  const codexVersion = await command(codex, ["--version"], { cwd: fixture, env, evidence });
  assert.equal(codexVersion, `codex-cli ${opts["--codex-version"]}`, "Exact native Codex version mismatch");
  assert.ok(Number(opts["--codex-version"].split(".")[1]) >= 156, "Native Codex is below OCA's supported minimum");
  const codexExecutableSha256 = sha256(readFileSync(codex));
  const nativeRelay = writeNativeRelay(fixture, codex);
  mkdirSync(ownedPath(fixture, join(fixture, "host-observer")));
  const observer = writeHostObserver(fixture);
  nativeWatch = setInterval(() => { try { observeNative(); } catch { if (nativeObservationErrors.length < 128) nativeObservationErrors.push("native-observer-failure"); } }, 250);
  const outcomes: Json[] = [];
  const scenarios = new Map<string, Scenario>();
  const generations = new Set<string>();
  const providerErrors: string[] = [];
  provider = createServer(async (request, response) => {
    const requestSequence = ++providerTraffic;
    let stage: "provider-json" | "provider-schema" | "provider-scenario" | "provider-stream" = "provider-schema";
    try {
      assert.equal(request.socket.remoteAddress, "127.0.0.1");
      assert.ok(request.method === "POST" && request.url?.endsWith("/responses"), "Unexpected fixture provider route");
      let raw = "";
      for await (const chunk of request) { raw += chunk; assert.ok(Buffer.byteLength(raw) <= 1_048_576, "Fixture provider input exceeds bounded evidence contract"); }
      stage = "provider-json";
      const body = JSON.parse(raw);
      stage = "provider-schema";
      observeNative();
      const userInput = strings((body.input ?? []).filter((item: Json) => item.role === "user"));
      const marker = userInput.findLast((item) => /OCA504_EMBED:([\w-]+)/.test(item))?.match(/OCA504_EMBED:([\w-]+)/)?.[1];
      const generationMarkers = [...new Set(userInput.flatMap((item) => [...item.matchAll(/OCA504_GENERATION:([a-f0-9-]+)/g)].map((match) => match[1])))];
      assert.ok(generationMarkers.length <= 1, "Conflicting native generation markers");
      const generation = generationMarkers[0];
      const plan = userInput.some((item) => item.includes("OCA504_NATIVE_PLAN"));
      const providerRecord: Json = { requestSequence, fixtureNativeHeaders: { session_id: request.headers.session_id, "x-codex-thread-id": request.headers["x-codex-thread-id"] }, latestInputHash: sha256(userInput.at(-1) ?? ""), inputHashes: userInput.map(sha256), fixtureGeneration: generation, requestClass: "unknown" };
      if (providerRequests.length < 1_000) providerRequests.push(providerRecord);
      else if (!evidence.errors.includes("provider-record-count-overflow")) evidence.errors.push("provider-record-count-overflow");
      const schemaNames = (body.tools ?? []).map((tool: Json) => tool.name ?? tool.function?.name);
      providerRecord.schemaNames = schemaNames;
      evidence.record("provider.jsonl", { phase: "request-observed", ...providerRecord });
      providerRecord.requestClass = classifyProvider(generation, marker, schemaNames, generations, new Set(scenarios.keys()));
      evidence.record("provider.jsonl", { phase: "request-admission", ...providerRecord });
      let output: Json[];
      if (marker) {
        stage = "provider-scenario";
        const scenario = scenarios.get(marker);
        assert.ok(scenario, "Unknown embedded scenario");
        scenario.results = toolResults(body);
        if (!scenario.schemas.length) scenario.schemas.push(body.tools ?? []);
        const next = scenario.calls[scenario.cursor];
        if (!next) { scenario.final = true; output = [messageItem(`OCA504_EMBED_DONE:${marker}`)]; }
        else if ("deferred" in next) {
          if (!scenario.searching) {
            scenario.searching = next.deferred;
            output = [functionItem({ name: "tool_search", args: { query: next.deferred.name } })];
          } else {
            const last = scenario.results.at(-1);
            const id = findCatalogId(last?.output, next.deferred.name);
            assert.ok(id, "Actual ToolSearch result did not contain the selected tool ID");
            const emitted = functionItem({ name: "tool_call", args: { id, args: next.deferred.args } });
            output = [emitted]; scenario.emitted.push({ id: emitted.call_id, itemId: emitted.id, hostCallId: compositeToolCallId(emitted.call_id, emitted.id), target: next.deferred, catalogId: id });
            scenario.searching = undefined;
            scenario.cursor++;
          }
        } else { const emitted = functionItem(next); output = [emitted]; scenario.emitted.push({ id: emitted.call_id, itemId: emitted.id, hostCallId: compositeToolCallId(emitted.call_id, emitted.id), target: next }); scenario.cursor++; }
        const selectedCall = scenario.emitted.at(-1)?.target;
        if (output.some((item) => item.type === "function_call") && selectedCall?.name === "agent_respond" && selectedCall.args.session === scenario.nativeTarget.sessionId && !scenario.searching) {
          const target = scenario.nativeTarget;
          const boundary = responseResumeBoundary(store().sessions.find((row: Json) => row.sessionId === target.sessionId), target, nativeEvents().length);
          scenario.resumeWindows.push(boundary);
          evidence.record("host-events.jsonl", { phase: "embedded-positive-response-pre-row", ...boundary.facts, resumeRequired: boundary.required, observation: "immediately-before-emitted-tool-admission" });
        }
      } else if (providerRecord.requestClass === "host-background") {
        output = [messageItem("Disposable host notification acknowledged.")];
      } else {
        // The provider simulates model output ONLY. Native Codex owns all RPC.
        const latest = userInput.at(-1) ?? "";
        output = [messageItem(plan ? `<proposed_plan>\n${FIXTURE_PLAN}\n</proposed_plan>` : `OCA504_BACKEND_OK:${generation}:${latest}`)];
      }
      const outputText = strings(output).join(" ");
      providerRecord.fixtureOutputMarkers = outputText.match(/OCA504_(?:BACKEND_OK:[a-f0-9-]+:|EMBED_DONE:[\w-]+)/g) ?? [];
      evidence.record("provider.jsonl", { ...providerRecord, outputHash: sha256(outputText), emittedCalls: output.filter((item) => item.type === "function_call").map((item) => ({ callId: item.call_id, itemId: item.id, hostCallId: compositeToolCallId(item.call_id, item.id), name: item.name })), schemaNames: (body.tools ?? []).map((tool: Json) => tool.name ?? tool.function?.name), toolResults: toolResults(body).map((result) => ({ callId: result.callId, outputHash: sha256(JSON.stringify(result.output)), nativeCode: nativeResult(result.output)?.details?.code, readableError: strings(result.output).some((value) => value.startsWith("Error:")) })) });
      stage = "provider-stream";
      const sse = responseFrames(output, body.model);
      evidence.record("provider.jsonl", { phase: "emitted-sse", fixtureGeneration: generation, requestClass: providerRecord.requestClass, ...providerSseObservation(sse, output) });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end(sse);
    } catch (error) {
      if (providerErrors.length < 128) providerErrors.push("provider-protocol-failure");
      evidence.failure(stage, error);
      evidence.record("provider.jsonl", { phase: "request-error", requestSequence, stage, requestClass: "unknown" });
      closeFailedProviderResponse(response, evidence);
    }
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", () => done()));
  const providerPort = (provider.address() as { port: number }).port;
  listenerPorts.push(providerPort);
  const baseUrl = `http://127.0.0.1:${providerPort}/v1`;
  writeFileSync(join(env.CODEX_HOME!, "config.toml"), [
    'model = "gpt-6.1-sol"', 'model_provider = "oca504"', 'model_reasoning_effort = "low"',
    'approval_policy = "never"', 'sandbox_mode = "workspace-write"', 'check_for_update_on_startup = false',
    '[model_providers.oca504]', 'name = "OCA 504 isolated fixture"', `base_url = "${baseUrl}"`,
    'env_key = "OCA504_FIXTURE_KEY"', 'wire_api = "responses"', 'requires_openai_auth = false',
    'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0',
    '[otel]', 'exporter = "none"', 'trace_exporter = "none"',
  ].join("\n"), { mode: 0o600 });
  mkdirSync(join(env.HOME!, ".codex"), { mode: 0o700 });
  writeFileSync(join(env.HOME!, ".codex", "config.toml"), readFileSync(join(env.CODEX_HOME!, "config.toml")), { mode: 0o600 });
  env.OPENCLAW_CODEX_APP_SERVER_COMMAND = nativeRelay;
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const gitCalls = join(fixture, "git-calls.jsonl");
  const bin = ownedPath(fixture, join(fixture, "bin")); mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const{appendFileSync,existsSync,statSync,writeFileSync}=require('node:fs');const append=value=>{try{const text=JSON.stringify(value)+'\\n';if((existsSync(${JSON.stringify(gitCalls)})?statSync(${JSON.stringify(gitCalls)}).size:0)+Buffer.byteLength(text)>1048576)throw Error();appendFileSync(${JSON.stringify(gitCalls)},text,{mode:0o600});}catch{try{writeFileSync(${JSON.stringify(join(fixture, "capture-incomplete"))},'git-proof-incomplete',{mode:0o600});}catch{}}};const args=process.argv.slice(2);append({args,at:Date.now(),phase:'start'});const r=spawnSync(${JSON.stringify(realGit)},args,{env:process.env,stdio:'inherit'});append({args,at:Date.now(),phase:'end',code:r.status});if(r.signal)process.kill(process.pid,r.signal);else process.exit(r.status??1);`, { mode: 0o700 });
  env.PATH = `${bin}:${env.PATH}`;
  const git = (cwd: string, ...args: string[]) => execFileSync(realGit, ["-C", ownedPath(fixture, cwd), ...args], { env, encoding: "utf8" }).trim();
  const createRepo = (name: string) => {
    const dir = ownedPath(fixture, join(fixture, name)); mkdirSync(dir);
    git(dir, "init", "-b", "main"); git(dir, "config", "user.name", "OCA Fixture"); git(dir, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(dir, "base.txt"), "base\n"); git(dir, "add", "base.txt"); git(dir, "commit", "-m", "fixture base");
    return dir;
  };
  let tarballSha256 = "", distSha256 = "";
  const hostEvents: Array<ReturnType<typeof projectFixtureHostEvent>> = [];
  const subscriptions = new WeakMap<GatewayClient, FixtureSessionSubscription>();
  let currentClient: GatewayClient | undefined;
  let currentGateway: ChildProcess | undefined;
  let storePath = "";
  const cli = (...args: string[]) => command(process.execPath, [join(hostPath, "openclaw.mjs"), ...args], { cwd: root, env, evidence });
    const publication = validatePackSource(root);
    evidence.record("host-events.jsonl", { phase: "source-publication-boundary", sourcePackageSha256: sha256(readFileSync(join(root, "package.json"))), expectedPublicationSha256: sha256(publication), publicationTransform: ["packageManager-removed", "packing-lifecycle-scripts-removed", "two-space-json-without-final-newline"] });
    const packDir = ownedPath(fixture, join(fixture, "pack")); mkdirSync(packDir);
    const packed = JSON.parse(await command("pnpm", ["pack", "--json", "--pack-destination", packDir], { cwd: root, env, evidence }));
    const filename = Array.isArray(packed) ? packed[0].filename : packed.filename;
    const tarball = ownedPath(fixture, resolve(packDir, filename));
    tarballSha256 = sha256(readFileSync(tarball)); distSha256 = sha256(readFileSync(join(root, "dist", "index.js")));
    const reader = join(root, "scripts", "e2e", "oca-issue-504-archive-proof.py");
    const python = realpathSync("/usr/bin/python3");
    evidence.record("host-events.jsonl", { phase: "archive-reader-provenance", readerSha256: sha256(readFileSync(reader)), readerExecutableSha256: sha256(readFileSync(python)), readerArguments: ["-I", "fixed-owned-archive"] });
    const packedInstaller = await preparePackedInstaller(root, fixture, tarball,
      () => command(python, ["-I", reader, tarball], { cwd: root, env, evidence, timeoutMs: 30_000 }),
      async (admitted) => { await cli("plugins", "install", "--force", "--accept-capabilities", admitted); }, evidence);
    const candidateProof = packedInstaller.proof;

    async function gateway(mode: false | { mode: "tools" }): Promise<GatewayClient> {
      if (currentClient) { await currentClient.stopAndWait({ timeoutMs: 5_000 }); clients.delete(currentClient); }
      observeNative();
      await stopNativeProcesses(nativeProcesses);
      if (currentGateway) { await stopOwnedChild(currentGateway); ownedChildren.delete(currentGateway); }
      const profileName = mode === false ? `direct-${hostEvents.length}` : "deferred";
      const state = ownedPath(fixture, join(fixture, `state-${profileName}`)); mkdirSync(state);
      env.OPENCLAW_STATE_DIR = state; storePath = join(state, "code-agent-sessions.json");
      const socket = createServer(); await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
      const port = (socket.address() as { port: number }).port; await new Promise<void>((done) => socket.close(() => done()));
      listenerPorts.push(port);
      const token = randomBytes(32).toString("hex");
      evidence.secrets.push(token);
      // Install records belong to this selected state, independently of prior profiles.
      delete env.OPENCLAW_GATEWAY_TOKEN;
      writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(freshPluginBootstrap(logging, port)), { mode: 0o600 });
      await packedInstaller.install();
      await cli("plugins", "enable", "openclaw-code-agent");
      // Existing isolated baseline grants precede the managed observer installer.
      writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(seedObserverAllow(parse(env.OPENCLAW_CONFIG_PATH!))), { mode: 0o600 });
      const observerProof = await installObserver(fixture, observer, async (path) => {
        evidence.record("host-events.jsonl", { phase: "observer-source-admission", sourceHashes: observer.hashes, startupActivation: true });
        await cli("plugins", "install", "--force", "--accept-capabilities", path);
      });
      await cli("plugins", "enable", "oca504-observer");
      const observerMetadata = JSON.parse(await cli("plugins", "inspect", "oca504-observer", "--json"));
      evidence.record("host-events.jsonl", { phase: "observer-cold-inspection", inspectionSha256: sha256(JSON.stringify(observerMetadata)), sourceHashes: observerProof.hashes });
      verifyObserverInspection(observerMetadata, fixture, state, observerProof, false, evidence);
      const installedConfig = parse(env.OPENCLAW_CONFIG_PATH!);
      const managedAllow = managedObserverAllow(installedConfig);
      evidence.record("host-events.jsonl", { phase: "managed-observer-allowlist", actualAllow: managedAllow, manuallyGrantedObserver: false });
      const metadata = JSON.parse(await cli("plugins", "inspect", "openclaw-code-agent", "--json"));
      const installed = verifyPackedPluginInspection(metadata, fixture, state, tarball, candidateProof, false, evidence);
      evidence.record("host-events.jsonl", { stateRole: mode === false ? "direct" : "deferred", phase: "packed-install-metadata", sourceKind: "archive", ...installed,
        tarballSha256: candidateProof.tarballSha256, distMapSha256: sha256(JSON.stringify(candidateProof.distHashes)), manifestHashes: candidateProof.manifestHashes });
      const config: OpenClawConfig = {
        ...installedConfig,
        logging,
        gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token }, controlUi: { enabled: false } },
        models: { mode: "replace", providers: { oca504: { baseUrl, apiKey: "synthetic-local-fixture-only", api: "openai-responses", request: { allowPrivateNetwork: true }, models: [{ id: "gpt-6.1-sol", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
        agents: { defaults: { workspace: ownedPath(fixture, join(fixture, "workspace")), model: { primary: "oca504/gpt-6.1-sol" } } },
        tools: { profile: "minimal", alsoAllow: ["agent_*", "tool_search", "tool_describe", "tool_call"], toolSearch: mode, exec: { mode: "full" } },
        plugins: { ...installedConfig.plugins, allow: managedAllow, slots: { memory: "none" }, entries: { ...installedConfig.plugins.entries, "oca504-observer": { enabled: true }, "openclaw-code-agent": { enabled: true, config: { autoUpdate: false, defaultHarness: "codex", defaultWorktreeStrategy: "off", permissionMode: "default", planApproval: "delegate", harnesses: { codex: { defaultModel: "gpt-6.1-sol", permissionProfile: ":workspace", approvalPolicy: "never" } } } } } },
        cron: { enabled: false }, browser: { enabled: false },
      };
      mkdirSync(config.agents!.defaults!.workspace!, { recursive: true });
      writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config), { mode: 0o600 });
      await cli("config", "validate");
      env.OPENCLAW_GATEWAY_TOKEN = token;
      const child = spawn(process.execPath, [join(hostPath, "openclaw.mjs"), "gateway", "run", "--port", String(port), "--bind", "loopback"], { cwd: fixture, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      trackOwnedChild(child); ownedChildren.add(child); currentGateway = child;
      let logs = "";
      const gatewayNumber = mode === false && listenerPorts.length === 2 ? 1 : mode === false ? 2 : 3;
      child.stdout.on("data", (chunk) => { logs = (logs + chunk).slice(-65_536); evidence.append(`gateway-${gatewayNumber}-stdout.log`, chunk, "diagnostic"); });
      child.stderr.on("data", (chunk) => { logs = (logs + chunk).slice(-65_536); evidence.append(`gateway-${gatewayNumber}-stderr.log`, chunk, "diagnostic"); });
      let hello: Json | undefined;
      const localConnectionCorrelation = randomUUID();
      let subscription: FixtureSessionSubscription | undefined;
      const client = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token, clientName: "gateway-client", mode: "backend", deviceIdentity: null, sharedStateMode: "read-only", scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"], caps: ["tool-events", "session-scoped-events"], env, onHelloOk: (value) => { hello = value; }, onEvent: (event) => {
        const payload = event.payload as Json | undefined;
        const observed = projectFixtureHostEvent(event.event, payload, localConnectionCorrelation, subscription);
        if (hostEvents.length < 4_096) hostEvents.push(observed);
        else if (!evidence.errors.includes("host-event-count-overflow")) evidence.errors.push("host-event-count-overflow");
        evidence.record("host-events.jsonl", observed);
      }, onConnectError: (error) => { evidence.record("host-events.jsonl", { connectError: error.name }); } });
      clients.add(client); currentClient = client; client.start();
      await until(() => { if (child.exitCode !== null) throw new Error(`BLOCKED: disposable Gateway exited; log hash ${sha256(logs)}`); return hello; }, "authenticated disposable Gateway hello", 60_000);
      assert.equal(hello!.server?.version, HOST, "Actual Gateway hello must agree with pinned package");
      assert.ok(hello!.auth?.scopes?.includes("operator.write") && hello!.auth?.scopes?.includes("operator.read"), "Actual native Gateway role grants are required");
      subscription = await subscribeFixtureMessages((method, params) => client.request(method, params), localConnectionCorrelation);
      subscriptions.set(client, subscription);
      evidence.record("host-events.jsonl", { phase: "message-subscription-acknowledgement", method: "sessions.messages.subscribe", subscribed: subscription.subscribed,
        expectedKeyMatches: subscription.key === "agent:main:main", expectedOwnerMatches: subscription.agentId === "main", localConnectionCorrelation,
        correlationKind: "fixture_local_label_not_host_issued_receipt" });
      const observerRuntime = JSON.parse(await cli("plugins", "inspect", "oca504-observer", "--runtime", "--json"));
      evidence.record("host-events.jsonl", { phase: "observer-runtime-cli-inspection", inspectionSha256: sha256(JSON.stringify(observerRuntime)) });
      const observerInstalled = verifyObserverInspection(observerRuntime, fixture, state, observerProof, true, evidence);
      evidence.record("host-events.jsonl", { phase: "observer-installed-provenance", ...observerInstalled, sourceHashes: observerProof.hashes, gatewayActivationProof: "subsequent real before hooks and embedded after hooks required" });
      const inspection = JSON.parse(await cli("plugins", "inspect", "openclaw-code-agent", "--runtime", "--json"));
      const runtimeInstalled = verifyPackedPluginInspection(inspection, fixture, state, tarball, candidateProof, true, evidence);
      assert.equal(runtimeInstalled.installedPath, installed.installedPath);
      assert.equal(runtimeInstalled.source, installed.source);
      evidence.record("host-events.jsonl", { stateRole: mode === false ? "direct" : "deferred", phase: "packed-install-runtime-cli", ...runtimeInstalled,
        gatewayExecutionProvenBy: "subsequent actual tool admission and native/subscribed outcomes" });
      const tool = async (name: string, args: Json = {}, key = randomUUID(), requester = "agent:main:main") => {
        const response = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
          method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}`, "x-openclaw-message-channel": "webchat", "x-openclaw-message-to": requester },
          body: JSON.stringify({ tool: name, name, args, sessionKey: requester, idempotencyKey: key }), signal: AbortSignal.timeout(125_000),
        });
        const result = await response.json() as Json;
        assert.equal(response.status, 200, `Actual HTTP host admission failed: ${result.error?.code ?? result.error?.type}`);
        assert.equal(result.ok, true, "Host transport must reach the admitted packed plugin");
        assert.ok(result.result, "Actual host result required");
        return result.result;
      };
      (client as any).invokeOca = tool;
      (client as any).httpOrigin = `http://127.0.0.1:${port}`;
      (client as any).fixtureToken = token;
      return client;
    }
    function store(): Json { assert.ok(storePath); return parse(ownedPath(fixture, storePath)); }
    function mutate(change: (value: Json) => void): void {
      const value = store(); change(value); value.revision = (value.revision ?? 0) + 1;
      const temporary = ownedPath(fixture, `${storePath}.${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, ownedPath(fixture, storePath));
    }
    const nativeEvents = () => records(join(fixture, "native-events.jsonl"));
    const hostTools = () => records(join(fixture, "host-tools.jsonl"));
    const backendRequests = () => nativeEvents().filter((event) => event.direction === "request");
    const snapshot = () => negativeSnapshot(records(gitCalls).length, backendRequests().length, providerTraffic, providerRequests);
    const assertNoAction = (prior: ReturnType<typeof snapshot>) => {
      const observation = assertNegativeWindow(prior, snapshot(), providerRequests);
      evidence.record("host-events.jsonl", { phase: "negative-window-observation", ...observation });
      return observation;
    };

    const invoke = (client: GatewayClient, name: string, args: Json, key?: string, requester?: string): Promise<Json> => (client as any).invokeOca(name, args, key, requester);
    async function launch(client: GatewayClient, name: string, extra: Json = {}, requester = "agent:main:main"): Promise<Json> {
      const before = new Set(existsSync(storePath) ? store().sessions.map((row: Json) => row.sessionId) : []);
      const workdir = createRepo(`native-${randomUUID()}`);
      const generation = randomUUID(); generations.add(generation);
      const result = await invoke(client, "agent_launch", { name, workdir, harness: "codex", worktree_strategy: "off", ...extra, prompt: `${extra.prompt ?? `OCA504_NATIVE:${name}`} OCA504_GENERATION:${generation}` }, undefined, requester);
      assert.doesNotMatch(text(result), /Error:|failed to start/i);
      const row = await until(() => store().sessions.find((item: Json) => !before.has(item.sessionId) && item.name === name && item.backendRef?.conversationId), "real native session receipt");
      await until(() => nativeEvents().find((event) => event.method === "turn/completed" && event.threadId === row.backendRef.conversationId && event.status === "completed"), "real native terminal turn");
      return { ...row, fixtureGeneration: generation, requestClass: "unknown" };
    }
    const client = await gateway(false);
    const planEventStart = nativeEvents().length;
    const plan = await launch(client, "ask-plan", { prompt: "OCA504_NATIVE_PLAN", permission_mode: "plan", plan_approval: "ask" });
    let previousPlanFacts = "";
    const observePlanRow = (phase: string) => {
      const row = store().sessions.find((item: Json) => item.sessionId === plan.sessionId);
      const facts = { ...planRowObservation(row, plan), observation: "recovery-row-only-non-authoritative-for-live-approval" }, encoded = JSON.stringify(facts);
      if (phase !== "plan-row-change" || encoded !== previousPlanFacts) evidence.record("host-events.jsonl", { phase, ...facts });
      previousPlanFacts = encoded; return row;
    };
    observePlanRow("plan-row-before-wait");
    try {
      await until(async () => {
        observePlanRow("plan-row-change");
        const before = snapshot();
        const output = await invoke(client, "agent_output", { session: plan.sessionId, full: true });
        const listing = await invoke(client, "agent_sessions", { status: "waiting", full: true });
        const passive = assertNoAction(before);
        evidence.record("host-events.jsonl", { phase: "live-plan-public-observation", output: publicOutputObservation(output, plan), listing: waitingPlanObservation(listing, plan), native: nativePlanBoundary(nativeEvents(), planEventStart, plan), ...passive, liveDecisionVersion: "UNPROVEN-not-exposed-by-public-view", liveActionableVersion: "UNPROVEN-not-exposed-by-public-view" });
        return hasLivePlanBoundary(nativeEvents(), planEventStart, output, listing, plan) ? true : undefined;
      }, "native plan and supported live pending-user views");
    } catch (error) { observePlanRow("plan-row-final-refusal"); throw error; }
    const priorPlanRequests = snapshot();
    const approval = await invoke(client, "agent_respond", { session: plan.sessionId, message: "approved", approve: true });
    requireAskPlanRefusal(approval, plan); const planRefusalWindow = assertNoAction(priorPlanRequests);
    outcomes.push({ lane: lanes.rpc, scenario: "native-ask-approval-authority", status: "PASS", observedNativePlanAndLivePendingAskAndUserOnlyRefusal: true, numericalLiveDecisionVersions: "UNPROVEN-public-view-not-exposed", ...planRefusalWindow });
    const a = await launch(client, "lynx-mcp-mvp");
    const b = await launch(client, "unrelated-session", {}, "agent:main:isolated-requester");
    const unknownWindows: ReturnType<typeof assertNoAction>[] = [];
    for (const name of FOUR) for (const reference of ["unknown-504", "***", "   "]) {
      const prior = snapshot();
      const args = { session: reference, ...(name === "agent_respond" ? { message: "1" } : {}), ...(name === "agent_escalate" ? { kind: "plan", summary: "fixture" } : {}), ...(name === "agent_merge" ? { base_branch: "main" } : {}) };
      const result = await invoke(client, name, args, undefined, "agent:main:isolated-requester");
      assert.equal(result.isError, true); assert.equal(result.details.status, "error");
      assert.equal(result.details.code, !reference.trim() || reference.includes("***") ? "session_reference_unusable" : "session_not_found");
      assert.equal(result.details.targetSelected, false); assert.equal(result.details.operationStarted, false);
      for (const row of [a, b]) { assert.ok(!JSON.stringify(result).includes(row.sessionId)); assert.ok(!JSON.stringify(result).includes(row.name)); }
      unknownWindows.push(assertNoAction(prior));
    }
    outcomes.push({ lane: lanes.rpc, scenario: "four-tools-unknown-masked-blank", status: "PASS", assertions: 12, zeroBackendGit: true, noNativeProviderContinuation: true, negativeWindows: unknownWindows });
    const negativesBefore = snapshot();
    const badAuth = await fetch(`${(client as any).httpOrigin}/tools/invoke`, { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer synthetic-invalid" }, body: JSON.stringify({ tool: "agent_respond", args: { session: a.sessionId, message: "AUTH_DENIED" } }), signal: AbortSignal.timeout(10_000) });
    assert.equal(badAuth.status, 401); const authWindows = [assertNoAction(negativesBefore)];
    for (const [name, args] of [["exec", { command: "false" }], ["unavailable-fixture-tool", {}]] as const) {
      const prior = snapshot();
      const refused = await client.request<Json>("tools.invoke", { name, args });
      assert.equal(refused.ok, false); assert.equal(refused.error.code, "not_found");
      authWindows.push(assertNoAction(prior));
    }
    outcomes.push({ lane: lanes.rpc, scenario: "real-host-auth-denied-unavailable", status: "PASS", transportAndToolFailureDistinct: true, zeroBackendGit: true, noNativeProviderContinuation: true, negativeWindows: authWindows });

    async function unchangedResponse(target: Json, ref: string, message = "1", key?: string): Promise<Json> {
      const prior = nativeEvents().length, providerBefore = providerRequests.length, hooksBefore = hostTools().length;
      const preRow = store().sessions.find((row: Json) => row.sessionId === target.sessionId);
      evidence.record("host-events.jsonl", { phase: "native-response-pre-row", ...generationObservation(preRow, target) });
      const boundary = responseResumeBoundary(preRow, target, prior);
      const wasStopped = boundary.required;
      const result = await invoke(client, "agent_respond", { session: ref, message }, key);
      assert.doesNotMatch(text(result), /^Error:/);
      const request = await until(() => nativeEvents().slice(prior).find((event) => event.direction === "request" && ["turn/start", "turn/steer"].includes(event.method) && event.threadId === target.backendRef.conversationId && event.nativeInput?.some((input: Json) => input.sha256 === sha256(message))), "unchanged message in selected native thread");
      assert.ok(nativeEvents().slice(prior).filter((event) => event.direction === "request" && ["turn/start", "turn/steer"].includes(event.method)).every((event) => event.threadId === target.backendRef.conversationId), "Response must not reach another native thread");
      const response = await until(() => nativeEvents().slice(prior).find((event) => event.direction === "response" && event.id === request.id && event.relayPid === request.relayPid && event.turnId && !event.error), "selected native turn response");
      await until(() => nativeEvents().slice(prior).find((event) => event.method === "turn/completed" && event.threadId === target.backendRef.conversationId && event.turnId === response.turnId && event.status === "completed"), "fresh matched selected native turn terminal");
      const model = providerRequests.slice(providerBefore);
      const nativeModel = selectedProvider(model, target.fixtureGeneration, message);
      requireResponseResume(nativeEvents(), boundary, target.backendRef.conversationId);
      for (const body of nativeModel) for (const value of Object.values(body.fixtureNativeHeaders)) if (typeof value === "string") assert.equal(value, target.backendRef.conversationId, "Native provider thread header mismatch");
      const actualOutput = await invoke(client, "agent_output", { session: target.sessionId, full: true });
      assert.ok(text(actualOutput).includes(`OCA504_BACKEND_OK:${target.fixtureGeneration}:`));
      for (const other of [a, b, newer, literal]) if (other.sessionId !== target.sessionId) assert.ok(!text(actualOutput).includes(`OCA504_BACKEND_OK:${other.fixtureGeneration}:`), "Other generation output must not be borrowed");
      const hook = requireHttpBefore(hostTools().slice(hooksBefore), "agent_respond", ref, message);
      return { method: request.method, threadId: request.threadId, turnId: response.turnId, actualToolCallId: hook.toolCallId, providerRequests: model.length, nativeProviderRequests: nativeModel.length, backgroundProviderRequests: model.length - nativeModel.length, resumedStoppedGeneration: wasStopped };
    }
    async function stopGeneration(target: Json) {
      const before = store().sessions.find((row: Json) => row.sessionId === target.sessionId);
      evidence.record("host-events.jsonl", { phase: "native-kill-pre-row", ...generationObservation(before, target) });
      const result = await invoke(client, "agent_kill", { session: target.sessionId });
      const classification = killResultClass(result);
      evidence.record("host-events.jsonl", { phase: "native-kill-result", classification, resultSha256: sha256(JSON.stringify(result)), ...generationObservation(store().sessions.find((row: Json) => row.sessionId === target.sessionId), target) });
      assert.ok(["terminated", "already-completed", "already-killed"].includes(classification), "Unexpected native kill outcome");
      await until(() => {
        const row = store().sessions.find((item: Json) => item.sessionId === target.sessionId);
        evidence.record("host-events.jsonl", { phase: "native-kill-row-observation", ...generationObservation(row, target) });
        return stoppedGeneration(row, target) ? true : undefined;
      }, "captured native generation completed or killed and stopped");
    }
    const literal = await launch(client, "***");
    await stopGeneration(a);
    const newer = await launch(client, a.name);
    assert.equal(newer.name, a.name); assert.notEqual(newer.sessionId, a.sessionId); assert.notEqual(newer.backendRef.conversationId, a.backendRef.conversationId);
    await unchangedResponse(newer, a.name);
    const aliasOutput = await invoke(client, "agent_output", { session: newer.sessionId, full: true });
    const aliasOwner = publicAliasOwner(aliasOutput, newer);
    evidence.record("host-events.jsonl", { phase: "newer-alias-owner-before-old-resume", ...aliasOwner });
    await unchangedResponse(a, a.sessionId);
    const resumedAlias = store().sessions.find((row: Json) => row.sessionId === a.sessionId);
    assert.ok(resumedAlias && resumedAlias.backendRef?.conversationId === a.backendRef.conversationId);
    const aliasProtection = assertAliasProtection(aliasOwner, resumedAlias, newer.name);
    evidence.record("host-events.jsonl", { phase: "active-alias-protection", coverage: aliasProtection });
    await unchangedResponse(a, a.backendRef.conversationId);
    await unchangedResponse(literal, literal.name);
    const beforeNumeric = snapshot();
    const numeric = await invoke(client, "agent_respond", { session: a.sessionId, message: 1 });
    assert.equal(numeric.isError, true); assert.equal(numeric.details.code, "invalid_parameters"); assertNoAction(beforeNumeric);
    const output = await invoke(client, "agent_output", { session: a.sessionId, full: true });
    assert.ok(text(output).includes(`OCA504_BACKEND_OK:${a.fixtureGeneration}:`));
    assert.ok(!text(output).includes(`OCA504_BACKEND_OK:${newer.fixtureGeneration}:`));
    outcomes.push({ lane: lanes.rpc, scenario: "native-older-exact-newer-name-backend-literal-mask-output", status: "PASS", activeAliasCoverage: aliasProtection, numericBoundary: "plugin-invalid-parameters" });
    const originalThread = a.backendRef.conversationId;
    await stopGeneration(a);
    const resumeStart = nativeEvents().length, resumeProvider = providerRequests.length;
    const resumed = await invoke(client, "agent_launch", { prompt: "OCA504_NATIVE:resume", resume_session_id: a.sessionId, harness: "codex", worktree_strategy: "off" });
    assert.doesNotMatch(text(resumed), /Error:|failed to start/i);
    const resumeRequest = await until(() => nativeEvents().slice(resumeStart).find((event) => event.direction === "request" && event.method === "thread/resume" && event.threadId === originalThread), "fresh actual native thread resume");
    await until(() => nativeEvents().slice(resumeStart).find((event) => event.direction === "response" && event.id === resumeRequest.id && event.relayPid === resumeRequest.relayPid && event.threadId === originalThread && !event.error), "successful fresh native resume response");
    const resumedTurn = await until(() => nativeEvents().slice(resumeStart).find((event) => event.direction === "request" && event.method === "turn/start" && event.threadId === originalThread && event.nativeInput?.some((input: Json) => input.sha256 === sha256("OCA504_NATIVE:resume"))), "fresh resumed native turn input");
    const resumedTurnResponse = await until(() => nativeEvents().slice(resumeStart).find((event) => event.direction === "response" && event.id === resumedTurn.id && event.relayPid === resumedTurn.relayPid && event.turnId && !event.error), "resumed native turn acceptance");
    await until(() => nativeEvents().slice(resumeStart).find((event) => event.method === "turn/completed" && event.threadId === originalThread && event.turnId === resumedTurnResponse.turnId && event.status === "completed"), "resumed native turn terminal");
    freshResume(nativeEvents().slice(resumeStart), originalThread, true);
    selectedProvider(providerRequests.slice(resumeProvider), a.fixtureGeneration, "OCA504_NATIVE:resume");
    const resumedRow = store().sessions.find((row: Json) => row.sessionId === a.sessionId && row.backendRef?.conversationId === originalThread);
    assert.ok(resumedRow);
    const resumedOutput = await invoke(client, "agent_output", { session: resumedRow.sessionId, full: true });
    assert.ok(text(resumedOutput).includes(`OCA504_BACKEND_OK:${a.fixtureGeneration}:`));
    assert.ok(!text(resumedOutput).includes(`OCA504_BACKEND_OK:${newer.fixtureGeneration}:`));
    outcomes.push({ lane: lanes.rpc, scenario: "native-persisted-resume", status: "PASS", freshResumeAndTurnTerminal: true });


    for (const concurrent of [false, true]) {
      const prior = nativeEvents().length, hooksBefore = hostTools().length, providerBefore = providerRequests.length;
      const key = `same-${randomUUID()}`, message = `REPEAT-${key}`;
      const repeatWindows: Array<{ boundary: ReturnType<typeof responseResumeBoundary>; result?: Json }> = [];
      const calls = async () => {
        const boundary = responseResumeBoundary(store().sessions.find((row: Json) => row.sessionId === b.sessionId), b, nativeEvents().length);
        evidence.record("host-events.jsonl", { phase: "concurrent-positive-response-pre-row", ...boundary.facts, resumeRequired: boundary.required, observation: "shared-overlap-runtime-window-not-per-call-receipt" });
        const record: typeof repeatWindows[number] = { boundary }; repeatWindows.push(record);
        record.result = await invoke(client, "agent_respond", { session: b.sessionId, message }, key); return record.result;
      };
      const results: Json[] = [];
      if (concurrent) results.push(...await Promise.all([calls(), calls()]));
      else {
        // A second explicit sequential call begins after the first turn settles.
        await unchangedResponse(b, b.sessionId, message, key);
        await unchangedResponse(b, b.sessionId, message, key);
      }
      for (const result of results) if (result.isError) {
        assert.equal(result.details?.code, "response_delivery_unconfirmed");
        assert.ok(!("operationStarted" in result.details));
      }
      const hooks = hostTools().slice(hooksBefore).filter((event) => event.phase === "before" && event.toolName === "agent_respond");
      assert.equal(hooks.length, 2); assert.ok(hooks[0].toolCallId); assert.equal(hooks[0].toolCallId, hooks[1].toolCallId, "SAME actual admitted plugin call ID must be measured");
      await until(() => nativeEvents().slice(prior).filter((event) => event.direction === "request" && ["turn/start", "turn/steer"].includes(event.method) && event.threadId === b.backendRef.conversationId && event.nativeInput?.some((input: Json) => input.sha256 === sha256(message))).length >= 2 ? true : undefined, "both same-call-ID inputs observed by selected native backend");
      const observations = await until(() => {
        const events = nativeEvents().slice(prior);
        const inputs = events.filter((event) => event.direction === "request" && ["turn/start", "turn/steer"].includes(event.method) && event.threadId === b.backendRef.conversationId && event.nativeInput?.some((input: Json) => input.sha256 === sha256(message)));
        const accepted: Json[] = [], rejected: Json[] = [], uncertain: Json[] = [];
        for (const input of inputs) {
          const response = events.find((event) => event.direction === "response" && event.id === input.id && event.relayPid === input.relayPid);
          if (response && !response.error && typeof response.turnId === "string" && response.turnId && (input.method === "turn/start" || response.turnId === input.expectedTurnId)) accepted.push(response);
          else if (input.method === "turn/steer" && response?.error && response.errorCode === -32600 && !response.errorDataPresent && (response.noActiveTurn || (response.mismatchExact && response.mismatchExpected === input.expectedTurnId && response.mismatchActual && response.mismatchActual !== input.expectedTurnId))) rejected.push(response);
          else uncertain.push(input);
        }
        const unconfirmed = results.filter((result) => result.details?.code === "response_delivery_unconfirmed").length;
        const settled = accepted.every((response) => events.some((event) => event.method === "turn/completed" && event.threadId === b.backendRef.conversationId && event.turnId === response.turnId && event.status === "completed"));
        return accepted.length + unconfirmed >= 2 && settled && (uncertain.length === 0 || unconfirmed > 0) ? { accepted, rejected, uncertain, unconfirmed } : undefined;
      }, "matched repeat native terminal observations");
      for (const record of repeatWindows) if (!record.result?.isError) requireResponseResume(nativeEvents(), record.boundary, b.backendRef.conversationId);
      const actual = nativeEvents().slice(prior).filter((event) => event.direction === "request" && ["turn/start", "turn/steer"].includes(event.method));
      const provider = providerRequests.slice(providerBefore);
      assert.ok(actual.every((input) => input.threadId === b.backendRef.conversationId));
      assert.ok(provider.some((request) => request.latestInputHash === sha256(message) && request.fixtureOutputMarkers.includes(`OCA504_BACKEND_OK:${b.fixtureGeneration}:`)));
      const repeatedOutput = await invoke(client, "agent_output", { session: b.sessionId, full: true });
      assert.ok(text(repeatedOutput).includes(`OCA504_BACKEND_OK:${b.fixtureGeneration}:`));
      outcomes.push({ lane: lanes.rpc, scenario: concurrent ? "same-actual-call-id-concurrent" : "same-actual-call-id-sequential", status: "PASS", starts: actual.filter((item) => item.method === "turn/start").length, steers: actual.filter((item) => item.method === "turn/steer").length, acceptedAcknowledgements: observations.accepted.length, knownNotSubmittedRejections: observations.rejected.length, unconfirmedAttempts: observations.uncertain.length, pluginUnconfirmedOutcomes: observations.unconfirmed, terminalTurns: new Set(observations.accepted.map((item) => item.turnId)).size, providerRequests: provider.length, sameActualCallId: true, resumeObservation: concurrent ? "shared-overlapping-runtime-window-not-per-call-receipt" : "distinct-sequential-fresh-windows", durableExactlyOnce: false, modelRetries: "separate and unproven; native rejected-steer queue recovery is OCA behavior" });
    }
    const firstRepeat = await unchangedResponse(b, b.sessionId, "INTENTIONAL_REPEAT", randomUUID());
    const secondRepeat = await unchangedResponse(b, b.sessionId, "INTENTIONAL_REPEAT", randomUUID());
    assert.notEqual(firstRepeat.actualToolCallId, secondRepeat.actualToolCallId);
    outcomes.push({ lane: lanes.rpc, scenario: "different-actual-call-id-identical-input", status: "PASS" });

    // Real Git and packed plugin, with only marker-validated persisted fixture rows.
    for (const variant of ["alias", "coordinates", "competing-decision", "policy", "merged-cleanup", "new-hooks"]) {
      const repo = createRepo(`queue-${variant}`), row0 = structuredClone(b), rowA = structuredClone(b), rowB = structuredClone(b);
      const paths: string[] = [];
      for (const [i, row] of [row0, rowA, rowB].entries()) {
        const branch = `fixture-${variant}-${i}`, path = ownedPath(fixture, join(fixture, `worktree-${variant}-${i}`));
        git(repo, "worktree", "add", "-b", branch, path, "main");
        writeFileSync(join(path, `${i}.txt`), `fixture ${i}\n`); git(path, "add", `${i}.txt`); git(path, "commit", "-m", `fixture ${i}`);
        Object.assign(row, { sessionId: `fixture-${randomUUID()}`, name: i === 1 ? `queue-alias-${variant}` : `queue-${variant}-${i}`, status: "completed", lifecycle: "completed", pendingPlanApproval: false, workdir: repo, worktreePath: path, worktreeBranch: branch, worktreeBaseBranch: "main", worktreeStrategy: "manual", worktreeMerged: false, worktreeState: "pending_decision", worktreeLifecycle: { state: "pending_decision", updatedAt: new Date().toISOString() } });
        paths.push(path);
      }
      writeFileSync(join(repo, "advanced.txt"), "base advanced\n"); git(repo, "add", "advanced.txt"); git(repo, "commit", "-m", "advance base");
      await invoke(client, "agent_repo_policy", { workdir: repo, policy: "never-pr" });
      mutate((value) => value.sessions.push(row0, rowA, rowB));
      const entered = ownedPath(fixture, join(fixture, `entered-${variant}`)), release = ownedPath(fixture, join(fixture, `release-${variant}`));
      const hook = join(repo, ".git", "hooks", "pre-rebase");
      writeFileSync(hook, `#!${process.execPath}\nconst{existsSync,writeFileSync}=require('node:fs');if(process.cwd()===${JSON.stringify(paths[0])}){writeFileSync(${JSON.stringify(entered)},'entered');const end=Date.now()+30000;while(!existsSync(${JSON.stringify(release)})){if(Date.now()>end)process.exit(1);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}`, { mode: 0o700 });
      chmodSync(hook, 0o700);
      const first = invoke(client, "agent_merge", { session: row0.sessionId, base_branch: "main", delete_branch: false, push: false });
      await until(() => existsSync(entered) ? true : undefined, "real first merge pre-rebase hook barrier");
      const start = records(gitCalls).length;
      const second = invoke(client, "agent_merge", { session: rowA.name, base_branch: "main", delete_branch: false, push: false });
      await until(() => records(gitCalls).slice(start).find((call) => call.phase === "end" && call.args.includes("diff") && call.args.some((arg: string) => arg.includes(rowA.worktreeBranch))), "second target initial safe Git inspection");
      const bBefore = sha256(JSON.stringify(store().sessions.find((row: Json) => row.sessionId === rowB.sessionId)));
      if (variant === "new-hooks") {
        mkdirSync(join(paths[1], ".openclaw"), { recursive: true });
        writeFileSync(join(paths[1], ".openclaw", "worktree-setup.sh"), "#!/bin/sh\nexit 0\n"); git(paths[1], "add", ".openclaw/worktree-setup.sh"); git(paths[1], "commit", "-m", "fixture hook change");
      } else mutate((value) => {
        const current = value.sessions.find((row: Json) => row.sessionId === rowA.sessionId);
        if (variant === "alias") { current.name = `old-${variant}`; value.sessions.find((row: Json) => row.sessionId === rowB.sessionId).name = rowA.name; }
        if (variant === "coordinates") current.worktreePath = paths[2];
        if (variant === "competing-decision") { current.worktreeLifecycle.state = "released"; current.worktreeDisposition = "released"; }
        if (variant === "policy") value.repoPolicies.find((policy: Json) => policy.repoRoot === repo).policy = "pr-required";
        if (variant === "merged-cleanup") { current.worktreeMerged = true; current.worktreeLifecycle.state = "merged"; delete current.worktreePath; delete current.worktreeBranch; }
      });
      writeFileSync(release, "release");
      const firstResult = await first, secondResult = await second;
      assert.match(text(firstResult), /Merged|merged/);
      if (variant === "alias") {
        assert.match(text(secondResult), /Merged|merged/); assert.ok(existsSync(join(repo, "1.txt"))); assert.ok(!existsSync(join(repo, "2.txt")));
        assert.equal(store().sessions.find((row: Json) => row.sessionId === rowA.sessionId).worktreeMerged, true);
        // The deliberate fixture alias rename is the only B change.
        assert.equal(store().sessions.find((row: Json) => row.sessionId === rowB.sessionId).worktreeMerged, false);
      } else {
        assert.ok(!existsSync(join(repo, "1.txt")), "Second branch must not merge");
        assert.equal(sha256(JSON.stringify(store().sessions.find((row: Json) => row.sessionId === rowB.sessionId))), bBefore);
        if (["coordinates", "competing-decision"].includes(variant)) assert.equal(secondResult.details?.code, "session_target_changed");
        if (variant === "policy") assert.match(text(secondResult), /requires a pull request/);
        if (variant === "merged-cleanup") assert.match(text(secondResult), /already merged/);
        if (variant === "new-hooks") assert.match(text(secondResult), /hook|user|button/i);
      }
      outcomes.push({ lane: lanes.rpc, scenario: `real-git-queue-${variant}`, status: "PASS", externalWriterAtomicity: false });
    }

    for (const mode of [false, { mode: "tools" }] as const) {
      const embedded = await gateway(mode);
      const embeddedSubscription = subscriptions.get(embedded); assert.ok(embeddedSubscription);
      const target = await launch(embedded, `embedded-${mode === false ? "direct" : "deferred"}`);
      const name = mode === false ? "direct" : "deferred";
      const calls: FixtureCall[] = [
        { name: "agent_respond", args: { session: "unknown-504", message: "1" } },
        { name: "agent_merge", args: { session: "***", base_branch: "main" } },
        { name: "agent_escalate", args: { session: "unknown-504", kind: "plan", summary: "fixture" } },
        { name: "agent_output", args: { session: "   " } },
        { name: "agent_output", args: { session: target.sessionId, full: true } },
        { name: "agent_respond", args: { session: target.sessionId, message: "1" } },
      ];
      const scenario: Scenario = { calls: mode === false ? calls : calls.map((call) => ({ deferred: call })), cursor: 0, results: [], emitted: [], schemas: [], final: false, nativeTarget: target, resumeWindows: [] };
      scenarios.set(name, scenario);
      const eventStart = hostEvents.length, nativeStart = nativeEvents().length, hookStart = hostTools().length, providerStart = providerRequests.length;
      const run = await embedded.request<Json>("chat.send", { sessionKey: "agent:main:main", message: `OCA504_EMBED:${name}`, deliver: false, idempotencyKey: randomUUID() });
      assert.ok(run.runId);
      const terminal = await embedded.request<Json>("agent.wait", { runId: run.runId, timeoutMs: 120_000 }, { timeoutMs: 125_000 });
      assert.equal(terminal.status, "ok"); assert.equal(scenario.final, true);
      assert.equal(scenario.cursor, 6);
      assert.equal(scenario.emitted.length, calls.length);
      assert.equal(scenario.resumeWindows.length, 1);
      for (const boundary of scenario.resumeWindows) requireResponseResume(nativeEvents(), boundary, target.backendRef.conversationId);
      assert.equal(new Set(scenario.emitted.map((item) => item.id)).size, calls.length);
      assert.equal(new Set(scenario.emitted.map((item) => item.itemId)).size, calls.length);
      assert.equal(new Set(scenario.emitted.map((item) => item.hostCallId)).size, calls.length);
      const names = (tools: Json[]) => tools.map((tool) => tool.name ?? tool.function?.name);
      if (mode === false) {
        for (const toolName of FOUR) {
          const schema = scenario.schemas[0].find((tool) => (tool.name ?? tool.function?.name) === toolName);
          assert.ok(schema && (schema.parameters ?? schema.function?.parameters)?.properties?.session?.type === "string", "Direct real provider schema must expose exact session string contract");
        }
      } else {
        assert.ok(names(scenario.schemas[0]).includes("tool_search") && names(scenario.schemas[0]).includes("tool_call"));
        assert.ok(FOUR.every((toolName) => !names(scenario.schemas[0]).includes(toolName)), "Deferred OCA tools must be catalog entries");
        assert.ok(scenario.emitted.every((item) => item.catalogId), "All deferred execution must use actual found catalog IDs");
      }
      for (const [index, emitted] of scenario.emitted.entries()) {
        const returned = scenario.results.find((result) => result.callId === emitted.id);
        assert.ok(returned, "Actual provider must receive each exact emitted tool call result");
        const hooks = hostTools().slice(hookStart).filter((event) => event.toolCallId === emitted.hostCallId);
        const admitted = hooks.find((event) => event.phase === "before" && event.toolName === (mode === false ? emitted.target.name : "tool_call"));
        assert.ok(admitted, "Exact emitted call must reach the actual host hook");
        assert.equal(admitted.session, emitted.target.args.session);
        if (emitted.target.name === "agent_respond") assert.equal(admitted.inputHash, sha256("1"));
        if (index < 4) {
          const code = ["session_not_found", "session_reference_unusable", "session_not_found", "session_reference_unusable"][index];
          if (mode === false) {
            // The official direct Responses converter exposes content only.
            assert.ok(strings(returned.output).some((value) => value.startsWith("Error:")));
            assert.match(strings(returned.output).join(" "), code === "session_not_found" ? /Session not found/ : /blank or masked-looking/);
            const native = requireEmbeddedAfter(hooks, emitted.target.name, emitted.hostCallId);
            assert.ok(native, "Exact direct call must expose actual native result metadata");
            assert.equal(native.status, "error"); assert.equal(native.isError, true); assert.equal(native.code, code);
            assert.equal(native.targetSelected, false); assert.equal(native.operationStarted, false); assert.equal(native.recoveryPresent, true);
          } else {
            const failure = nativeResult(returned.output);
            assert.ok(failure); assert.equal(failure.isError, true); assert.equal(failure.details.code, code);
            assert.equal(failure.details.targetSelected, false); assert.equal(failure.details.operationStarted, false);
            // Keep the bridge failure separate from its contained native error.
            const wrapper = typeof returned.output === "string" ? JSON.parse(returned.output) : returned.output;
            assert.equal(wrapper.tool?.id, emitted.catalogId);
            const outer = requireEmbeddedAfter(hooks, "tool_call", emitted.hostCallId);
            assert.ok(outer); assert.equal(outer.outerStatus, "failed");
          }
          for (const secret of [target.sessionId, target.name, target.backendRef.conversationId]) assert.ok(!JSON.stringify(returned.output).includes(secret), "Failure must not disclose another reference");
        } else {
          assert.ok(!nativeResult(returned.output));
          if (index === 4) assert.ok(strings(returned.output).some((value) => value.includes(`OCA504_BACKEND_OK:${target.fixtureGeneration}:`)), "Selected real native output must survive host round trip");
        }
      }
      const nativeResponse = await until(() => nativeEvents().slice(nativeStart).find((event) => event.direction === "request" && ["turn/start", "turn/steer"].includes(event.method) && event.threadId === target.backendRef.conversationId && event.nativeInput?.some((input: Json) => input.sha256 === sha256("1"))), "embedded positive respond selected native input");
      assert.ok(nativeResponse);
      const accepted = await until(() => nativeEvents().slice(nativeStart).find((event) => event.direction === "response" && event.id === nativeResponse.id && event.relayPid === nativeResponse.relayPid && typeof event.turnId === "string" && !event.error), "embedded positive native acknowledgement");
      await until(() => nativeEvents().slice(nativeStart).find((event) => event.method === "turn/completed" && event.threadId === target.backendRef.conversationId && event.turnId === accepted.turnId && event.status === "completed"), "embedded positive matched native terminal");
      assert.ok(providerRequests.slice(providerStart).some((request) => request.latestInputHash === sha256("1") && request.fixtureOutputMarkers.includes(`OCA504_BACKEND_OK:${target.fixtureGeneration}:`)));
      const history = await embedded.request<Json>("chat.history", { sessionKey: "agent:main:main", limit: 100 });
      assert.ok(strings(history).some((value) => value.includes(`OCA504_EMBED_DONE:${name}`)));
      const subscribed = hostEvents.slice(eventStart);
      assert.ok(hasFreshSubscribedTerminal(hostEvents, eventStart, embeddedSubscription, run.runId), "Fresh same-connection/session/run subscribed host terminal evidence required");
      outcomes.push({ lane: lanes.embedded, scenario: name, status: "PASS", providerFailureExposure: mode === false ? "readable content only; native metadata observed at actual public after-hook" : "outer failed bridge and native structured result", hostFailureEventObserved: subscribed.some((event) => event.payload?.data?.isError === true), classifierSourceContract: "pinned host source; no fabricated classifier receipt", realProviderObservedFailures: 4, actualHostResults: 6, subscribedEvents: subscribed.length });
    }
    const native = nativeEvents();
    assert.equal(providerErrors.length, 0); assert.equal(nativeObservationErrors.length, 0);
    assert.ok(!native.some((event) => event.observationError), "Native protocol observation must be complete");
    const agents = native.filter((event) => typeof event.userAgent === "string");
    assert.ok(agents.length > 0 && agents.every((event) => event.userAgent.includes(opts["--codex-version"])), "Native initialize version must agree with executable");
    assert.ok(native.some((event) => event.method === "turn/completed" && event.status === "completed"));
    const spawned = native.filter((event) => event.nativeIdentity);
    assert.ok(spawned.length > 0);
    for (const event of spawned) { assert.equal(event.executableHash, NATIVE_CODEX_SHA256); assert.equal(event.nativeIdentity.executable, codex); assert.ok(event.nativeIdentity.startTicks); assert.equal(event.nativeIdentity.group, event.relayIdentity.group); }

    requireCandidate(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }), expectedSha,
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }));
    summary = { fixtureCompanionSha256: sha256(readFileSync(join(root, "scripts/e2e/oca-issue-504-host-fixtures.ts"))), observerSha256: observer.hash, observerFileHashes: observer.hashes, hostSourceProvenance: "published package metadata and npm lock integrity; compiled source attestation remains unproven", status: "PASS", candidateSha: expectedSha, gitTree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim(), node: process.version,
      host: HOST, hostPublishedBuild: { bytesSha256: hostBuildBytes ? sha256(hostBuildBytes) : null, version: hostBuild?.version ?? null, commit: hostBuild?.commit ?? null, builtAt: hostBuild?.builtAt ?? null, buildId: hostBuild?.buildId ?? null }, hostLockSRI, hostEntrySha256: sha256(readFileSync(join(hostPath, "openclaw.mjs"))), hostPackageSha256: sha256(readFileSync(join(hostPath, "package.json"))), distHashes: candidateProof.distHashes, nativeCodex: { version: opts["--codex-version"], executableSha256: codexExecutableSha256, relaySha256: sha256(readFileSync(nativeRelay)), initialized: agents.length, completedTurns: native.filter((event) => event.method === "turn/completed" && event.status === "completed").length },
      tarballSha256, distSha256, nativeProcessIdentities: spawned.map((event) => ({ executableSha256: event.executableHash, pid: event.nativeIdentity.pid, group: event.nativeIdentity.group, startTicks: event.nativeIdentity.startTicks })), providerThreadHeadersObserved: providerRequests.some((request) => Object.values(request.fixtureNativeHeaders).some((value) => typeof value === "string")), fixtureSha256: sha256(readFileSync(fileURLToPath(import.meta.url))), providerRequests: providerRequests.length, providerRequestClasses: Object.fromEntries(["native-generation", "embedded-scenario", "host-background", "unknown"].map((kind) => [kind, providerRequests.filter((request) => request.requestClass === kind).length])), outcomes,
      unproven: ["external-provider-entitlement", "production-Telegram-delivery", "reporter-host-hooks", "upstream-redaction-repair", "restart-multiple-registry-exactly-once", "compiled-host-source-attestation", ...(!hostBuild?.commit ? ["published-host-build-commit"] : []), ...(!providerRequests.some((request) => Object.values(request.fixtureNativeHeaders).some((value) => typeof value === "string")) ? ["direct-provider-thread-header-mapping"] : [])],
      pluginFixtureOnly: ["legacy-per-source-matrix", "callback-version-authority", "fine-grained-requester-report-custody", "ambiguous-backend-rejection"] };
  } catch (error) { originalFailure = error; }
  finally {
    if (nativeWatch) clearInterval(nativeWatch);
    const { createConnection } = await import("node:net");
    try {
      await cleanupAll([
        () => { observeNative(); },
        ...[...clients].map((client) => () => client.stopAndWait({ timeoutMs: 5_000 })),
        () => stopNativeProcesses(nativeProcesses),
        ...[...ownedChildren].map((child) => () => stopOwnedChild(child)),
        () => { observeNative(); },
        () => stopNativeProcesses(nativeProcesses),
        async () => { if (provider) { provider.closeAllConnections(); await new Promise<void>((done, reject) => provider!.close((error) => error ? reject(error) : done())); } },
        ...listenerPorts.map((port) => async () => {
          const reachable = await new Promise<boolean>((done) => {
            const socket = createConnection({ host: "127.0.0.1", port }); socket.setTimeout(1_000);
            socket.once("connect", () => { socket.destroy(); done(true); });
            socket.once("error", () => { socket.destroy(); done(false); });
            socket.once("timeout", () => { socket.destroy(); done(true); });
          });
          assert.equal(reachable, false, "Owned loopback listener survived teardown");
        }),
        () => { assert.ok([...nativeProcesses.values()].every((identity) => !sameProcess(identity)), "Owned native process survived teardown"); },
      ]);
      assert.equal(readFileSync(join(fixture, ".fixture-owner"), "utf8"), FIXTURE_MARKER);
    } catch (cleanupError) { cleanupFailure = cleanupError; }
    const failures = (error: unknown): Json[] => error instanceof AggregateError
      ? error.errors.flatMap(failures).slice(0, 20)
      : error === undefined ? [] : [{ name: error instanceof Error ? error.name : "UnknownError", message: evidence.sanitize(error instanceof Error ? error.message : String(error)).slice(0, 1_000) }];
    try {
      await cleanupAll([
        ...[["native-events.jsonl", "native-events.jsonl"], ["host-tools.jsonl", "host-tools.jsonl"], ["git.jsonl", "git-calls.jsonl"]].map(([file, source]) => () => evidence.copyProof(file, join(fixture, source))),
        () => { const incomplete = existsSync(join(fixture, "capture-incomplete")); evidence.record("capture-status.json", { complete: !incomplete }); if (incomplete) evidence.errors.push("fixture-capture-incomplete"); },
      ]);
    } catch (collectionError) { evidence.errors.push(`collection-incomplete:${collectionError instanceof Error ? collectionError.name : "UnknownError"}`); }
    try {
      evidence.record("run-summary.json", { ...summary, providerTraffic, providerRequests: providerRequests.length, providerRequestClasses: Object.fromEntries(["native-generation", "embedded-scenario", "host-background", "unknown"].map((kind) => [kind, providerRequests.filter((request) => request.requestClass === kind).length])), candidateSha: expectedSha, node: process.version, status: originalFailure || cleanupFailure || evidence.errors.length || evidence.failures.length ? "BLOCKED" : "PASS", originalFailures: failures(originalFailure), cleanupFailures: failures(cleanupFailure), fixtureFailures: evidence.failures, teardownVerified: !cleanupFailure });
      evidenceReceipt = evidence.persist(process.version, originalFailure || cleanupFailure ? "BLOCKED" : "PASS", !cleanupFailure);
    } catch (collectionError) { evidence.errors.push(`collection-incomplete:${collectionError instanceof Error ? collectionError.name : "UnknownError"}`); }
    failureReport = { status: "BLOCKED", providerTraffic, providerRequests: providerRequests.length, candidateSha: expectedSha, node: process.version, originalFailures: failures(originalFailure), cleanupFailures: failures(cleanupFailure), fixtureFailures: evidence.failures, evidenceErrors: evidence.errors, evidenceIncomplete: evidence.errors.length > 0 || !evidenceReceipt, teardownVerified: !cleanupFailure, evidence: evidenceReceipt ?? { path: evidence.path, manifestSha256: null }, mandatoryLanes: Object.values(lanes) };
    // A verified teardown permits deleting only the marked disposable profile.
    // Private receipts survive both success and failure; failed cleanup retains
    // its owned scratch for diagnosis and still blocks the run.
    if (!cleanupFailure && evidenceReceipt) rmSync(fixture, { recursive: true, force: true });
  }
  if (originalFailure) throw originalFailure;
  if (cleanupFailure) throw cleanupFailure;
  assert.equal(evidence.errors.length, 0, "BLOCKED: required evidence incomplete");
  assert.equal(evidence.failures.length, 0, "BLOCKED: recorded fixture protocol or observation failure");
  assert.ok(evidenceReceipt, "BLOCKED: private receipt was not retained");
  assert.ok(summary, "Acceptance did not complete");
  console.log(JSON.stringify({ ...summary, teardownVerified: true, evidence: evidenceReceipt }));
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(JSON.stringify(failureReport ?? { status: "BLOCKED", error: error instanceof Error ? error.message.replace(/\/(?:tmp|home|work)\/[^\s"',]+/g, "[fixture-path]") : "Host acceptance failed", mandatoryLanes: Object.values(lanes) })); process.exitCode = 1; });
