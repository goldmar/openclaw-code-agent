#!/usr/bin/env node
// Real host/native prerequisites for issue #501. Run remotely in a clean checkout.
// Only the external Responses and Bot API endpoints are deterministic fixtures.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvidence, frameEvidence } from "./oca501-evidence.mjs";
import { captureCommand } from "./oca501-command-receipt.mjs";
import { nativeExecutionCall, matchingNativeOutput, assertNativeExecutionResult } from "./oca501-native-protocol.mjs";
import { messageText, latestParentUser, selectParentProbe, selectCanonicalProbe, selectNativeCase, questionCall, assertQuestionAnswer, assertConfigSchemaRefusal, hostLogEvidence, assertCompletionTerminal, assertVisibleCanonical, assertOrdinaryCompleted, selectOrdinaryCompletion, ordinaryNativeCompletion, projectHistoryPreviews, assertPreviewSettlement, nativeDiagnostics, activeSessionView, sessionListing, assertWaitingView } from "./oca501-lifecycle-protocol.mjs";
import { renderResponsesStart, expectedEmbeddedStarts, sourceSdkTimeout, bindCanonicalTransportRequest, bindCanonicalFunctionTransportRequest, serializeHostLogArtifact, hostLogArtifactPlan } from "./oca501-host-log-projection.mjs";
import { reviewDelegate, readNativeReview, assertFullReviewOutput } from "./oca501-review-protocol.mjs";
import { runL1 } from "./oca501-lifecycle-acceptance.mjs";
import { l1Assignment, l1Coverage } from "./oca501-l1-cohort.mjs";
import { configMethod, projectConfigCommand, projectConfigRequest, projectConfigResponse, telegramAuthority, exactFixtureRoute, sourceSendArgs, selectRoutedCompletion, readOwnedConfig, assertStableAuthority, ensureSuiteFields, actualToolPayload, assertActualSendResult } from "./oca501-config-receipt.mjs";

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
    assert.ok(["--expected-sha", "--node-version", "--artifacts", "--phase", "--l1-cohort"].includes(argv[i]), `Unknown option ${argv[i]}`);
    assert.ok(!Object.hasOwn(options, argv[i].slice(2)), "Duplicate option is refused before fixture effects");
    assert.ok(argv[i + 1], `Missing value for ${argv[i]}`);
    options[argv[i].slice(2)] = argv[i + 1];
  }
  l1Assignment(options.phase ?? "prerequisites", options["l1-cohort"]);
  assert.match(options["expected-sha"] ?? "", /^[a-f0-9]{40}$/);
  assert.ok(["24.16.0", "26.1.0"].includes(options["node-version"]));
  assert.equal(process.versions.node, options["node-version"], "Use the exact supported Node floor");
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64", "This Hetzner fixture pins the Linux x64 native package");
  assert.ok(options.artifacts && isAbsolute(options.artifacts), "--artifacts must be absolute");
  assert.ok(!inside(ROOT, resolve(options.artifacts)), "Keep evidence outside the checkout");
  assert.ok(["prerequisites", "matrix-h01-h05", "matrix-l1", "routed-negative"].includes(options.phase ?? "prerequisites"), "Use an explicitly reviewed milestone phase");
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


function verifyCompletionAssertionControls() {
  const id = "control-retained-run";
  const visible = { runId: id, status: "ok", yielded: false, terminalReply: { disposition: "visible", text: "Required checks completed." } };
  const routed = { runId: id, status: "ok", terminalReceipt: { runId: id, sourceReplyDelivered: true } };
  assertCompletionTerminal(visible, id, false);
  assertCompletionTerminal(routed, id, true);
  const negatives = [
    ["wrong visible run", { ...visible, runId: "other" }, false],
    ["wrong routed run", { ...routed, runId: "other" }, true],
    ["failed run with delivered source", { ...routed, status: "error" }, true],
    ["yielded visible run", { ...visible, yielded: true }, false],
    ["silent disposition", { ...visible, terminalReply: { disposition: "silent", text: "NO_REPLY" } }, false],
    ["missing visible reply", { runId: id, status: "ok" }, false],
    ["empty visible reply", { ...visible, terminalReply: { disposition: "visible", text: " " } }, false],
    ["visible silent marker", { ...visible, terminalReply: { disposition: "visible", text: " no_reply " } }, false],
    ["missing source receipt", { runId: id, status: "ok" }, true],
    ["wrong source receipt run", { ...routed, terminalReceipt: { runId: "other", sourceReplyDelivered: true } }, true],
    ["source not delivered", { ...routed, terminalReceipt: { runId: id, sourceReplyDelivered: false } }, true],
    ["unknown routing mode", visible, undefined],
    ["nonboolean routing mode", visible, "false"],
  ];
  for (const [, result, mode] of negatives) assert.throws(() => assertCompletionTerminal(result, id, mode));
  return { scope: "Completion assertion controls only; no host run or delivery is simulated", positives: ["exact visible nonyielded internal run", "exact delivered routed source receipt"], negatives: negatives.map(([name]) => name) };
}

function matchesHostCallId(value, call) {
  // Pinned @openclaw/ai keeps the Responses call_id|fc_item_id pair in
  // canonical history, and uses bare call_id on subsequent provider requests.
  return value === call.id || value === `${call.id}|${call.itemId}`;
}

function verifyParentProtocolControls() {
  const goal = { id: "control-goal", sessionId: "control-session", name: "control", status: "succeeded", route: { provider: "telegram", accountId: "default", target: "501002" } };
  const wake = `[control] Goal task control succeeded. ID: control-session\noriginRoute: ${JSON.stringify(goal.route)}\nuse message(action='send', final=true) to originRoute`;
  const input = { input: [{ role: "user", content: wake }], tools: [{ name: "tool_search" }] };
  assert.equal(selectRoutedCompletion(input, [goal]).goal.id, goal.id);
  assert.equal(selectRoutedCompletion({ ...input, input: [...input.input, { role: "user", content: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nquoted data\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>" }] }, [goal]).goal.id, goal.id);
  assert.equal(selectRoutedCompletion({ ...input, input: [...input.input, { role: "user", content: "Unrelated current request" }] }, [goal]), undefined);
  assert.equal(selectRoutedCompletion({ ...input, tools: [] }, [goal]), undefined);
  for (const changed of [wake.replace("501002", "other"), wake.replace("default", "foreign"), wake.replace("control-session", "wrong-session"), `${wake}\noriginRoute: {}`, wake.replace("use message(action='send', final=true) to originRoute", "quoted auxiliary recap")]) assert.throws(() => selectRoutedCompletion({ ...input, input: [{ role: "user", content: changed }] }, [goal]));
  const absentGoal = { ...goal, route: { provider: "telegram", target: "501002" } };
  const makeInput = (route) => ({ ...input, input: [{ role: "user", content: wake.replace(JSON.stringify(goal.route), JSON.stringify(route)) }] });
  const absent = selectRoutedCompletion(makeInput(absentGoal.route), [absentGoal]);
  assert.equal(Object.hasOwn(absent.route, "accountId"), false);
  assert.equal(Object.hasOwn(sourceSendArgs(absent.route, "Actual absence control"), "accountId"), false);
  assert.equal(sourceSendArgs(goal.route, "Actual explicit control").accountId, "default");
  assert.throws(() => selectRoutedCompletion(makeInput(absentGoal.route), [goal]));
  assert.throws(() => selectRoutedCompletion(input, [absentGoal]));
  for (const accountId of [undefined, null, "", " ", 1, false, "foreign"]) assert.throws(() => exactFixtureRoute({ ...absentGoal.route, accountId }));
  for (const route of [{ ...absentGoal.route, threadId: 1 }, { ...absentGoal.route, provider: "other" }, { ...absentGoal.route, target: "other" }]) assert.throws(() => exactFixtureRoute(route));
  const payload = [{ id: "actual-control-id", name: "message", source: "openclaw", sourceName: "core" }];
  assert.deepEqual(actualToolPayload({ type: "function_call_output", output: JSON.stringify(payload) }), payload);
  assert.deepEqual(actualToolPayload({ type: "function_call_output", output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload) }] }) }), payload);
  assert.throws(() => actualToolPayload({ type: "function_call_output", output: "not JSON" }));
  assert.throws(() => actualToolPayload({ type: "function_call_output", output: { isError: true, content: [{ type: "text", text: "[]" }] } }));
  const call = { id: "call_control", itemId: "fc_control" };
  assert.ok(matchesHostCallId(call.id, call)); assert.ok(matchesHostCallId(`${call.id}|${call.itemId}`, call));
  assert.equal(matchesHostCallId(`${call.id}|fc_foreign`, call), false); assert.equal(matchesHostCallId("call_foreign|fc_control", call), false);
  return { scope: "Pure fixture protocol controls only; no host/native/tool delivery simulated", positives: ["current own explicit-default completion", "current own absent-account completion/argument presence", "host internal context attachment", "actual-shaped direct/nested JSON output"], negatives: ["old completion in history", "tool-less auxiliary", "wrong route/account/session", "present malformed account", "task/wake account presence mismatch", "unobserved fields", "multiple route lines", "no source authorization", "invalid/error payload"] };
}

class AcceptanceRun {
  constructor(options) {
    this.options = options;
    mkdirSync(options.artifacts, { recursive: true, mode: 0o700 });
    this.directory = mkdtempSync(join(options.artifacts, "oca501-host-"));
    this.children = new Set(); this.servers = new Set(); this.results = []; this.commandCounter = 0;
    this.fixtureErrors = []; this.modelRequests = []; this.botRequests = []; this.botMessages = []; this.botMenus = new Map();
    this.nativeExecutions = []; this.ownedProcesses = new Map();
    this.artifactFiles = new Set(); this.historyExportProjections = new WeakMap(); this.previewAssociations = []; this.parentDeliveries = []; this.negativeDeliveryGoal = undefined;
    this.botUpdates = []; this.updateId = 1000; this.receiptWorkdirs = new Set(); this.patchCounter = 0;
    this.nativeCases = new Map(); this.externalReleases = new Map(); this.parentProbes = new Map(); this.progressCapture = "";
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
    this.provenance = { candidateSha: options["expected-sha"], nodeVersion: process.versions.node, expectedHostVersion: HOST_VERSION, expectedNativeVersion: NATIVE_VERSION, fixtureBoundary: LABEL, acceptanceScriptHash: fileHash(fileURLToPath(import.meta.url)), evidenceHelperHash: fileHash(join(ROOT, "scripts/e2e/oca501-evidence.mjs")), commandReceiptHelperHash: fileHash(join(ROOT, "scripts/e2e/oca501-command-receipt.mjs")), configReceiptHelperHash: fileHash(join(ROOT, "scripts/e2e/oca501-config-receipt.mjs")), nativeProtocolHelperHash: fileHash(join(ROOT, "scripts/e2e/oca501-native-protocol.mjs")), lifecycleProtocolHelperHash: fileHash(join(ROOT, "scripts/e2e/oca501-lifecycle-protocol.mjs")), hostLogProjectionHelperHash: fileHash(join(ROOT, "scripts/e2e/oca501-host-log-projection.mjs")), logSourceObservationHelperHash: fileHash(join(ROOT, "scripts/e2e/oca501-log-source-observation.mjs")), lifecycleAcceptanceHelperHash: fileHash(join(ROOT, "scripts/e2e/oca501-lifecycle-acceptance.mjs")), reviewProtocolHelperHash: fileHash(join(ROOT, "scripts/e2e/oca501-review-protocol.mjs")) };
    if (options.phase === "matrix-l1") {
      this.l1Assignment = l1Assignment(options.phase, options["l1-cohort"]);
      this.provenance.selectedL1Cohort = this.l1Assignment.selectedL1Cohort;
      this.provenance.l1CohortHelperHash = fileHash(join(ROOT, "scripts/e2e/oca501-l1-cohort.mjs"));
      this.artifact("l1-cohort-assignment.json", this.l1Assignment);
    }
  }
  set nativeFixture(value) { assert.ok(!this.nativeCases.has(value.tag), "Do not overwrite a real case's fixture history"); this.nativeCases.set(value.tag, value); this.lastNativeFixture = value; }
  get nativeFixture() { return this.lastNativeFixture; }
  progress(id, boundary) {
    assert.match(id, /^[A-Za-z0-9_-]+$/); assert.ok(["start", "completed"].includes(boundary));
    const line = `OCA501_PROGRESS ${JSON.stringify({ scope: "progress-only; not acceptance evidence", phase: this.options.phase, case: id, boundary, time: new Date().toISOString() })}\n`;
    this.progressCapture += line; process.stdout.write(line);
  }
  releaseExternal(fixture) { assert.ok(fixture.heldRequest, "Release only an actually held external Responses request"); const release = this.externalReleases.get(fixture.heldRequest); assert.ok(release); release(); }
  redact(value) { let text = String(value); for (const secret of this.secrets) text = text.replaceAll(secret, "[fixture credential]"); return text; }
  serializeArtifact(value, { compact = false } = {}) {
    return serializeHostLogArtifact(value, (text) => this.redact(text), (_key, item) => item && typeof item === "object" ? this.historyExportProjections.get(item) ?? item : item, { compact });
  }
  artifact(name, value, { serialized = false } = {}) {
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    const text = serialized ? value : this.serializeArtifact(value);
    if (serialized) assert.ok(typeof text === "string" && Buffer.byteLength(text) <= 4 * 1024 * 1024, "Register only final bounded prepared log artifact bytes");
    writeFileSync(join(this.directory, name), text, { mode: 0o600 });
    this.artifactFiles.add(name);
  }
  logSourceAuthority() {
    const responsesStarts = [];
    let modelAbsenceProven = false;
    if (this.logModelReadback && existsSync(this.env.OPENCLAW_CONFIG_PATH)) {
      const source = readOwnedConfig(this.env.OPENCLAW_CONFIG_PATH, this.directory).config;
      const provider = source.models?.providers?.oca501, model = provider?.models?.find((entry) => entry.id === MODEL);
      modelAbsenceProven = provider?.baseUrl === this.logModelReadback.baseUrl && provider.api === "openai-responses" && model && JSON.stringify(provider.models) === JSON.stringify(this.logModelReadback.models) && !Object.hasOwn(model, "requestTimeoutMs");
    }
    const population = this.modelRequests.filter((request) => request.transport === "host-parent").length;
    for (const request of this.modelRequests) {
      if (!modelAbsenceProven || request.transport !== "host-parent" || request.authorization !== "validated synthetic fixture key") continue;
      const originalBody = this.originalModelBodies?.get(request.requestIndex);
      if (typeof originalBody !== "string" || hash(originalBody) !== request.bodyHash) continue;
      const input = JSON.parse(originalBody);
      // Actual captured HTTP bytes, never a token-redacted artifact body.
      if (hash(JSON.stringify(input)) !== request.bodyHash) continue;
      const options = { provider: "oca501", model: MODEL, baseUrl: `${this.providerUrl}/host/v1`, timeoutMs: sourceSdkTimeout({ optionAbsenceProven: true, modelAbsenceProven: true }), presence: "present", requestPopulation: population, allowedToolNames: ["tool_call", "tool_describe", "tool_search", "message", ...(this.pluginToolNames ?? [])] };
      // Pinned c074 attempt.model-diagnostic-lifecycle passes requestId only,
      // never options.timeoutMs; isolated simple-completion-execution likewise
      // passes its deadline via signal, not a stream timeout. The actual owned
      // model/readback absence above supplies the other SDK timeout branch.
      // host-prepared-isolated-completion/simple-completion-execution supplies
      // no requestId or stream timeout; its separate deadline is an AbortSignal.
      if (request.parentRequestClassification?.kind === "activity-recap") {
        responsesStarts.push(renderResponsesStart({ ...options, body: input, bodySha256: request.bodyHash })); continue;
      }
      const binding = { receipts: this.logRpcReceipts ?? [], requests: this.modelRequests, sessionKey: this.sessionKey, sessionId: this.parentSessionId, body: input, settlements: this.logSourceSettlements ?? [], completedRunIds: this.sessions().filter((row) => row.originSessionKey === this.sessionKey && row.completionWakeIssuedAt && row.completionWakeSucceededAt && !row.completionWakeFailedAt && !row.completionWakeSkippedAt).map((row) => row.completionWakeRunId).filter(Boolean) };
      const bound = request.emittedType === "function_call" ? bindCanonicalFunctionTransportRequest(request, binding, assertCompletionTerminal) : bindCanonicalTransportRequest(request, binding, assertCompletionTerminal, assertVisibleCanonical);
      if (bound) responsesStarts.push(...expectedEmbeddedStarts(bound, options));
    }
    const ownRows = this.sessions().filter((row) => row.originSessionKey === this.sessionKey && ([...this.nativeCases.values()].some((fixture) => fixture.sessionId === row.sessionId) || this.goals().some((goal) => goal.sessionId === row.sessionId && goal.id === row.goalTaskId)));
    return { candidateSha: this.provenance.candidateSha, helperSha256: this.provenance.hostLogProjectionHelperHash, hostCommit: this.provenance.upstreamTagCommit,
      agentIds: this.logParentIdentity ? [this.logParentIdentity.agentId] : [],
      sessionIds: this.logParentIdentity ? [this.logParentIdentity.sessionId, this.logParentIdentity.sessionKey] : [],
      channels: [...new Set(ownRows.map((row) => row.route?.provider).filter((value) => ["telegram", "webchat"].includes(value)))], responsesStarts };
  }
  hostStreamEvidence(text) {
    // A missing/unstable source proof never prevents the existing fixed safe
    // failure/cleanup receipt from being exported.
    try { return hostLogEvidence(text, { sourceAuthority: this.logSourceAuthority() }); }
    catch { return hostLogEvidence(text); }
  }
  captureHostStream(name, text) {
    const plan = hostLogArtifactPlan(name, this.hostStreamEvidence(text), Buffer.isBuffer(text) ? text.toString("utf8") : text, {
      serialize: (value) => this.serializeArtifact(value), compactSerialize: (value) => this.serializeArtifact(value, { compact: true }), redact: (value) => this.redact(value),
      guardSource: { helper: "scripts/e2e/oca501-lifecycle-protocol.mjs", helperSha256: this.provenance.lifecycleProtocolHelperHash, candidateSha: this.provenance.candidateSha },
      assertProjectedSafe: (value) => assert.ok(hostLogEvidence(value).completeStreamSafe),
    });
    // All bytes, wrappers, redaction and newline are checked before ANY log
    // artifact is registered. The writer consumes these exact final strings.
    for (const file of plan.files) this.artifact(file.name, file.text, { serialized: true });
    if (plan.blocked) {
      (this.independentErrors ??= []).push({ stage: "log-export-boundary", source: name, error: plan.receipt.exclusionReason });
      for (const result of this.results) if (result.classification === "PASS") { result.classification = "BLOCKED"; result.unprovenReason = plan.receipt.exclusionReason; }
      process.exitCode = 1;
    }
    return plan.receipt;
  }
  projectHistoryStream(stdout) {
    const calls = this.parentDeliveries.flatMap((state) => state.calls.filter((call) => call.name === "tool_describe" && call.stage === "describe").map((call) => {
      const row = this.sessions().find((row) => row.sessionId === state.sessionId);
      const runId = state.ordinaryCycle?.endsWith("/turn-ended") ? undefined : row?.completionWakeRunId;
      return { ...call, runId, ownerId: state.ownerId, sessionId: state.sessionId, ordinaryCycle: state.ordinaryCycle, operation: state.actualNativeCompletion?.operation, nativeThreadId: state.actualNativeCompletion?.threadId, nativeTurnId: state.actualNativeCompletion?.turnId, request: call.request };
    }));
    const projected = projectHistoryPreviews(stdout, { method: "chat.history", sessionKey: this.sessionKey, sessionId: this.parentSessionId, calls });
    for (const exclusion of projected.receipt.exclusions) if (exclusion.provisionalOwner && !this.previewAssociations.some((record) => record.toolCallId === exclusion.toolCallId)) this.previewAssociations.push(exclusion);
    return projected;
  }
  async command(command, args, { cwd = ROOT, env = this.env, timeoutMs = 180_000, expectedConfigSchemaError } = {}) {
    const receipt = await captureCommand(command, args, { cwd, env, timeoutMs, track: (child) => this.children.add(child), untrack: (child) => this.children.delete(child) });
    const sensitive = configMethod(args);
    const identity = `command-${++this.commandCounter}`;
    const officialRpcMethod = command === process.execPath && args[0] === this.hostEntry && args[1] === "gateway" && args[2] === "call" ? args[3] : undefined;
    const protectedStatus = officialRpcMethod === "status";
    if (sensitive) {
      // Full original streams remain internal and are used by RPC/CAS checks.
      // Only this closed projection is registered for the evidence exporter.
      this.artifact(`${identity}.json`, projectConfigCommand(sensitive, args, receipt));
    } else if (protectedStatus) {
      let value; try { value = JSON.parse(receipt.stdout.slice(receipt.stdout.indexOf("{"))); } catch { value = {}; }
      this.artifact(`${identity}.json`, { projection: true, rawStatusProfileFieldsAndStreamsExcluded: true, exit: receipt.exit, streamsComplete: receipt.streamsComplete, timedOut: receipt.timedOut, originalStdout: { bytes: Buffer.byteLength(receipt.stdout), sha256: hash(receipt.stdout) }, originalStderr: { bytes: Buffer.byteLength(receipt.stderr), sha256: hash(receipt.stderr) }, actualOwnedStatus: { pid: Number.isSafeInteger(value.pid) ? value.pid : undefined }, dispositionErrors: receipt.errors.map((error) => ({ bytes: Buffer.byteLength(String(error)), sha256: hash(String(error)) })) });
    } else {
      const rpcMethod = officialRpcMethod;
      let historyProjection;
      try { historyProjection = rpcMethod === "chat.history" ? this.projectHistoryStream(receipt.stdout) : undefined; }
      catch {
        this.artifact(`${identity}.json`, { projection: true, method: rpcMethod, rawCommandArgumentsAndStreamsExcluded: true, exit: receipt.exit, streamsComplete: receipt.streamsComplete, timedOut: receipt.timedOut, originalStdout: { bytes: Buffer.byteLength(receipt.stdout), sha256: hash(receipt.stdout) }, originalStderr: { bytes: Buffer.byteLength(receipt.stderr), sha256: hash(receipt.stderr) }, dispositionErrors: receipt.errors.map((error) => ({ bytes: Buffer.byteLength(String(error)), sha256: hash(String(error)) })), exclusionReason: "Unverified official capped-preview provenance; required missing content remains BLOCKED" });
        throw new Error(`History export provenance BLOCKED; original disposition/hashes preserved in ${identity}.json; raw streams excluded`);
      }
      const exportStdout = historyProjection?.stdout ?? receipt.stdout;
      const stdoutEvidence = hostLogEvidence(exportStdout, { commandStream: true, rpcMethod }), stderrEvidence = hostLogEvidence(receipt.stderr, { commandStream: true });
      if (!stdoutEvidence.completeStreamSafe || !stderrEvidence.completeStreamSafe) {
        this.artifact(`${identity}.json`, { command, cwd, exit: receipt.exit, streamsComplete: receipt.streamsComplete, timedOut: receipt.timedOut, projection: true, rawCommandArgumentsAndStreamsExcluded: true, originalStdout: { bytes: Buffer.byteLength(receipt.stdout), sha256: hash(receipt.stdout) }, stdoutEvidence, stderrEvidence, ...(historyProjection ? { historyExportProjection: historyProjection.receipt } : {}), dispositionErrors: receipt.errors.map((error) => ({ bytes: Buffer.byteLength(String(error)), sha256: hash(String(error)) })) });
        throw new Error(`Unsafe command log excluded; complete original stream hashes retained in ${identity}.json; acceptance BLOCKED`);
      }
      const stdout = this.redact(exportStdout); const stderr = this.redact(receipt.stderr);
      this.artifact(`${identity}.stdout.log`, stdout); this.artifact(`${identity}.stderr.log`, stderr);
      this.artifact(`${identity}.json`, { command, args, cwd, ...receipt, stdout, stderr, stdoutEvidence, stderrEvidence, ...(historyProjection ? { historyExportProjection: historyProjection.receipt, stdoutScope: historyProjection.receipt.projection ? "Export projection; full original stdout remains internal; capped describe previews excluded" : "Complete original stdout" } : {}), stdoutFile: `${identity}.stdout.log`, stderrFile: `${identity}.stderr.log` });
    }
    const failure = sensitive || protectedStatus ? `${sensitive ?? "status"}: disposition/stream failure; original stream hashes are in ${identity}.json (raw config excluded)` : `${command} ${args.join(" ")} failed (${receipt.exit.signal ?? receipt.exit.code}): ${receipt.exit.spawnError ?? this.redact((args.includes("chat.history") ? "History command failed; original hashes/projection retained" : receipt.stdout) + receipt.stderr).slice(-6000)}`;
    assert.equal(receipt.streamsComplete, true, (sensitive || protectedStatus) ? failure : `Incomplete command streams are BLOCKED: ${receipt.errors.join("; ")}`);
    assert.equal(receipt.timedOut, false, failure);
    if (expectedConfigSchemaError) {
      assert.ok(sensitive === "config.patch" || sensitive === "config.apply");
      const refusal = assertConfigSchemaRefusal(receipt, expectedConfigSchemaError);
      this.artifact(`${identity}-schema-refusal.json`, { ...refusal, commandReceipt: `${identity}.json` });
      return { refusal, receiptProjection: projectConfigCommand(sensitive, args, receipt) };
    }
    assert.equal(receipt.exit.code, 0, failure);
    return receipt.stdout;
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
      const requestIndex = this.modelRequests.length; attempt.requestIndex = requestIndex;
      assert.equal(request.method, "POST"); assert.notEqual(transport, "unexpected", "Only the two explicit loopback Responses routes are permitted");
      if (transport === "host-parent") {
        assert.equal(request.headers.authorization, `Bearer ${this.secrets[2]}`, "Genuine parent client uses only the synthetic local API key");
        attempt.authorization = "validated synthetic fixture key";
      }
      const input = JSON.parse(body); assert.equal(input.model, MODEL); assert.equal(input.stream, true);
      (this.originalModelBodies ??= new Map()).set(requestIndex, body);
      attempt.hasParentTools = transport === "host-parent" && !!input.tools?.length;
      attempt.model = input.model;
      this.artifact(`responses-request-${requestIndex}.json`, { ...attempt, input });
      if (this.gateway?.pid) this.observeNativeProcesses(this.gateway.pid);
      const id = `resp_${requestIndex}`; const itemId = `msg_${requestIndex}`; attempt.responseId = id;
      const fixture = transport === "native-codex" ? selectNativeCase(input, this.nativeCases) : undefined;
      if (fixture) { assert.ok(body.includes(fixture.tag), "Actual native request contains this case's unique goal tag"); attempt.case = fixture.tag; }
      attempt.nativeIdentity = transport === "native-codex" ? input.client_metadata : undefined;
      if (fixture?.ordinary) {
        const actualRow = this.sessions().find((row) => row.backendRef?.conversationId === input.client_metadata?.thread_id);
        // Inline review inference has its distinct C9 child identity; the
        // registered original owner is retained rather than aliased to it.
        if (fixture.operation !== "review") {
          assert.ok(actualRow && actualRow.goalTaskId === undefined && actualRow.workdir === fixture.workdir);
          assert.ok(actualRow.prompt.includes(`${fixture.tag}:`)); assert.ok(requestIndex > fixture.admissionRequestBoundary);
          if (fixture.sessionId) assert.equal(fixture.sessionId, actualRow.sessionId);
          else fixture.sessionId = actualRow.sessionId; // Genuine admitted owner, before any completion wake races the launch response.
          attempt.actualOrdinaryOwner = { sessionId: actualRow.sessionId, originalThreadId: actualRow.backendRef.conversationId, recoverySnapshot: true };
        }
      }
      if (fixture?.hold && !fixture.heldRequest) {
        fixture.heldRequest = requestIndex; attempt.externalHeld = true;
        this.artifact(`responses-request-${requestIndex}.json`, { ...attempt, input });
        await new Promise((done) => {
          const finish = () => { this.externalReleases.delete(requestIndex); done(); };
          this.externalReleases.set(requestIndex, () => { attempt.externalReleasedAt = new Date().toISOString(); finish(); });
          response.once("close", () => { if (!response.writableFinished) { attempt.externalAbortedAt = new Date().toISOString(); finish(); } });
        });
        this.artifact(`responses-request-${requestIndex}.json`, { ...attempt, input });
        if (attempt.externalAbortedAt) return;
      }
      let marker = transport === "host-parent" ? PARENT_MARKER : fixture?.text ?? MARKER;
      let item = { id: itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: marker, annotations: [], logprobs: [] }] };
      if (transport === "host-parent") {
        const decision = await this.parentResponse(input, attempt, itemId);
        if (decision?.item) item = decision.item;
        if (decision?.text) {
          marker = decision.text;
          item = { ...item, content: [{ type: "output_text", text: marker, annotations: [], logprobs: [] }] };
        }
        this.artifact(`responses-request-${requestIndex}.json`, { ...attempt, input });
      }
      if (fixture?.mode === "plan" && !fixture.planSent) {
        const row = this.sessions().find((entry) => entry.backendRef?.conversationId === input.client_metadata?.thread_id);
        assert.equal(row?.requestedPermissionMode, "plan", "Actual persisted admission requested Plan posture");
        attempt.actualPublicSession = await this.publicSession(row.sessionId); assert.equal(attempt.actualPublicSession.status, "running");
        fixture.planSent = true; marker = `<proposed_plan>\n${fixture.planMarkdown}\n</proposed_plan>`;
        item = { ...item, content: [{ type: "output_text", text: marker, annotations: [], logprobs: [] }] };
        attempt.nativePlanModelText = marker;
      } else if (fixture?.mode === "plan") {
        assert.ok(body.includes("Approved. Go ahead."), "Actual second native turn carries genuine user approval");
        attempt.actualApprovalInput = input; fixture.approvalObserved = true;
      }
      if (fixture?.mode === "question" && !fixture.question) {
        const row = this.sessions().find((entry) => entry.backendRef?.conversationId === input.client_metadata?.thread_id);
        assert.equal(row?.requestedPermissionMode, "plan", "Question uses the genuinely requested Plan admission and actual advertised native schema");
        attempt.actualPublicSession = await this.publicSession(row.sessionId); assert.equal(attempt.actualPublicSession.status, "running");
        fixture.question = questionCall(input, fixture, { callId: `oca501_question_${requestIndex}`, itemId, validate: this.validateHostSchema });
        fixture.questionNativeThread = input.client_metadata.thread_id; item = fixture.question.item; attempt.actualQuestionCall = fixture.question;
      } else if (fixture?.mode === "question") {
        assert.equal(input.client_metadata?.thread_id, fixture.questionNativeThread);
        const outputs = input.input.filter((entry) => entry.type === "function_call_output" && entry.call_id === fixture.question.callId);
        assert.equal(outputs.length, 1); attempt.actualQuestionOutput = outputs[0];
        this.artifact(`native-question-${fixture.question.callId}.json`, { case: fixture.tag, call: fixture.question, output: outputs[0] });
        fixture.answerObserved = assertQuestionAnswer(outputs[0], fixture.question, fixture.expectedAnswer);
        if (fixture.planAfterAnswer && !fixture.planSent) {
          fixture.planSent = true; marker = `<proposed_plan>\n${fixture.planMarkdown}\n</proposed_plan>`;
          item = { ...item, content: [{ type: "output_text", text: marker, annotations: [], logprobs: [] }] };
          attempt.nativePlanModelText = marker;
        } else if (fixture.planAfterAnswer) { assert.ok(body.includes("Approved. Go ahead.")); fixture.approvalObserved = true; }

      }
      if (fixture?.operation === "review") {
        assert.ok(attempt.receivedAt >= fixture.reviewStartedAt && !fixture.reviewResponseSent, "Only the actually admitted fresh review action may receive its one result");
        const original = this.sessions().find((row) => row.sessionId === fixture.sessionId); assert.equal(original.goalTaskId, undefined);
        const relation = reviewDelegate(input, { instructions: fixture.reviewInstructions, startedAt: fixture.reviewStartedAt, threadId: original.backendRef.conversationId });
        const expected = { ...relation, workdir: fixture.workdir, output: fixture.reviewOutput };
        let lastError;
        let entry;
        try { entry = await waitFor("organic original native review entered exact outer turn", () => { try { return readNativeReview(this.env.CODEX_HOME, expected, false); } catch (error) { lastError = String(error); return false; } }); }
        catch (error) { this.artifact(`native-review-entry-${requestIndex}.json`, { relation, error: String(error), lastIncompleteObservation: lastError, projection: true, rawRolloutExcluded: true }); throw error; }
        fixture.reviewRelation = relation; fixture.reviewExpected = expected; fixture.reviewResponseSent = true;
        assertFullReviewOutput(fixture.reviewOutput, fixture.reviewOutput); marker = JSON.stringify(fixture.reviewOutput);
        item = { ...item, content: [{ type: "output_text", text: marker, annotations: [], logprobs: [] }] };
        attempt.nativeReviewModelText = marker; attempt.actualReviewRelation = relation;
        this.artifact(`native-review-entry-${requestIndex}.json`, { relation, entry, priorIncompleteObservation: lastError, projection: true, rawRolloutExcluded: true });
      }
      if (fixture?.execute && !fixture.commandSent) {
        fixture.nativeCall = nativeExecutionCall(input, { transport, caseTag: fixture.tag, workdir: fixture.workdir, ownedRoot: this.workspace, callId: `oca501_exec_${requestIndex}`, itemId, validate: this.validateHostSchema });
        fixture.commandSent = true; item = fixture.nativeCall.item;
        attempt.nativeExecutionCall = fixture.nativeCall;
        this.artifact(`native-execution-${fixture.nativeCall.callId}.json`, { case: fixture.tag, requestHash: attempt.bodyHash, actualCall: fixture.nativeCall });
      } else if (fixture?.execute) {
        const output = matchingNativeOutput(input, fixture.nativeCall);
        const proof = { case: fixture.tag, requestHash: attempt.bodyHash, actualCall: fixture.nativeCall, actualOutput: output };
        this.artifact(`native-execution-${fixture.nativeCall.callId}.json`, proof); // Retain the actual union before interpreting it.
        try {
          proof.actualExecutorResult = assertNativeExecutionResult(output, fixture.nativeCall, existsSync(join(fixture.workdir, "native-receipt.txt")) ? readFileSync(join(fixture.workdir, "native-receipt.txt"), "utf8") : "");
        } catch (error) { proof.error = String(error); this.artifact(`native-execution-${fixture.nativeCall.callId}.json`, proof); throw error; }
        attempt.nativeExecutionOutput = output; fixture.executionProved = true;
        this.artifact(`native-execution-${fixture.nativeCall.callId}.json`, proof);
      }
      this.artifact(`responses-request-${requestIndex}.json`, { ...attempt, input });
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
      attempt.responseCompleted = true; attempt.emittedType = item.type; attempt.emittedText = item.type === "message" ? marker : undefined;
      if (item.type === "function_call") attempt.emittedFunctionCall = structuredClone(item);
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
      if (["sendMessage", "editMessageText"].includes(method)) assert.equal(String(params.chat_id), "501002", "No message may leave the owned fixture route");
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
      attempt.result = structuredClone(result); attempt.respondedAt = new Date().toISOString();
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, result }));
    });
  }
  async parentResponse(input, attempt, itemId) {
    attempt.parentRequestClassification = { kind: "unknown", attribution: "not admitted as recap, probe or routed completion" };
    this.artifact(`responses-request-${attempt.requestIndex}.json`, { ...attempt, input });
    const selection = selectParentProbe(input, attempt, this.parentProbes.values());
    attempt.parentRequestClassification = selection.classification;
    this.artifact(`responses-request-${attempt.requestIndex}.json`, { ...attempt, input });
    if (selection.classification.kind === "activity-recap") return { text: PARENT_MARKER };
    const latest = latestParentUser(input); const text = latest ? messageText(latest) : "";
    if (selection.probe) { attempt.parentProbe = selection.probe.id; attempt.actualProbeInput = input; return { text: selection.probe.marker }; }
    // Ignore only the host's explicitly delimited context attached to a user
    // request. A quoted completion in an older turn cannot select a case.
    const ordinaryOwners = [];
    for (const fixture of [...this.nativeCases.values()].filter((fixture) => fixture.ordinary && fixture.sessionId)) {
      const row = this.sessions().find((row) => row.sessionId === fixture.sessionId); if (!row) continue;
      const first = text.split("\n")[0].replace(/^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\] /, "");
      const currentOwner = first === `[${row.name}] Completed. ID: ${row.sessionId}` || first === "Coding agent session turn ended." && text.split("\n")[1] === `Name: ${row.name}` && text.split("\n")[2] === `ID: ${row.sessionId}`;
      let completion, publicView;
      if (currentOwner) {
        publicView = await this.publicSession(row.sessionId);
        const events = existsSync(join(this.directory, "openclaw-runtime.log")) ? nativeDiagnostics(readFileSync(join(this.directory, "openclaw-runtime.log"), "utf8")) : [];
        try {
          const reviewReadback = fixture.operation === "review" && fixture.reviewExpected ? readNativeReview(this.env.CODEX_HOME, fixture.reviewExpected, true) : undefined;
          completion = ordinaryNativeCompletion({ row, fixture, requests: this.modelRequests, diagnostics: events, reviewReadback, publicView });
        } catch { /* A pending/unknown operation cannot dispatch ordinary success. */ }
      }
      ordinaryOwners.push({ row, fixture, completion, publicView });
    }
    const selected = selectOrdinaryCompletion(input, ordinaryOwners) ?? selectRoutedCompletion(input, this.goals());
    if (!selected) return;
    const { goal, ordinary, route, wake, index } = selected;
    const ownerId = goal?.id ?? ordinary.sessionId; const sessionId = goal?.sessionId ?? ordinary.sessionId;
    // Existing file readback at actual provider admission may catch the pending
    // flag. Missing this fast window is recorded, never manufactured.
    const pendingSnapshot = ordinary?.completionWakeSummaryRequired === true ? Object.fromEntries(["sessionId", "completionWakeSummaryRequired", "completionWakeRunId", "completionWakeOutcomeKey", "completionWakeSummaryFact"].filter((key) => Object.hasOwn(ordinary, key)).map((key) => [key, structuredClone(ordinary[key])])) : undefined;
    if (ordinary && route.provider === "webchat") {
      attempt.case = ordinary.name; attempt.ordinarySessionId = ordinary.sessionId; attempt.wakeHash = hash(wake);
      attempt.ordinaryCycle = selected.cycle; attempt.actualNativeCompletion = selected.completion;
      attempt.actualOrdinaryAdmission = pendingSnapshot;
      return { text: `OCA501 ordinary visible receipt ${selected.cycle}: ${ordinary.name} native turn completed.` };
    }
    const entries = input.input;
    const tools = input.tools ?? [];
    if (!tools.length) return; // Tool-less auxiliary/compaction request is not source delivery.
    attempt.case = goal?.name ?? ordinary.name; attempt.goalId = goal?.id; attempt.ordinarySessionId = ordinary?.sessionId; attempt.wakeHash = hash(wake);
    if (this.options.phase === "routed-negative" && goal?.name === "routed-source-negative") {
      this.negativeDeliveryGoal = goal.id; attempt.expectedUnfulfilled = true; return;
    }
    const tail = entries.slice(index + 1);
    let state = this.parentDeliveries.findLast((delivery) => (goal ? delivery.goalId === goal.id : delivery.ordinarySessionId === ordinary.sessionId) && delivery.wakeHash === hash(wake) && delivery.calls.some((call) => tail.some((entry) => entry.call_id === call.id)));
    if (!state) {
      state = { ownerId, goalId: goal?.id, ordinarySessionId: ordinary?.sessionId, sessionId, wakeHash: hash(wake), ordinaryCycle: selected.cycle, actualNativeCompletion: selected.completion, actualOrdinaryAdmission: pendingSnapshot, route, calls: [], summary: goal ? `OCA501 source receipt ${goal.id}: ${goal.name} ${goal.status}.` : `OCA501 ordinary source receipt ${selected.cycle}: ${ordinary.name} native turn completed.`, admittedAt: attempt.receivedAt };
      this.parentDeliveries.push(state);
    }
    attempt.parentDelivery = { goalId: state.goalId, ordinarySessionId: state.ordinarySessionId, sessionId: state.sessionId, wakeHash: state.wakeHash };
    const advertised = (name) => {
      const matches = tools.filter((tool) => (tool.name ?? tool.function?.name) === name);
      assert.equal(matches.length, 1, `Actual host must advertise exactly one ${name} capability`);
      return matches[0].parameters ?? matches[0].function?.parameters;
    };
    const emit = async (name, args, stage) => {
      const schema = advertised(name);
      const valid = this.validateHostSchema({ schema, value: args, cacheKey: `oca501:${hash(JSON.stringify(schema))}` });
      assert.equal(valid.ok, true, `Fixture arguments must match the actual advertised ${name} schema: ${JSON.stringify(valid.errors)}`);
      const id = `call_oca501_parent_${attempt.requestIndex}`;
      const functionItemId = `fc_oca501_parent_${attempt.requestIndex}`;
      state.calls.push({ id, itemId: functionItemId, name, stage, args, request: attempt.requestIndex });
      attempt.parentCall = state.calls.at(-1);
      this.artifact("parent-delivery-protocol.json", this.parentDeliveries);
      return { item: { id: functionItemId, type: "function_call", call_id: id, name, arguments: JSON.stringify(args) } };
    };
    const consume = (call) => {
      const outputs = tail.filter((entry) => entry.type === "function_call_output" && entry.call_id === call.id);
      assert.equal(outputs.length, 1, "Consume only the actual matching tool response");
      call.actualOutput = outputs[0]; attempt.consumedCallId = call.id;
      // Persist the genuine matched output BEFORE decoding/interpreting its
      // union. Host error results are first-cause evidence, never success.
      this.artifact("parent-delivery-protocol.json", this.parentDeliveries);
      this.artifact(`parent-tool-result-${call.id}.json`, { goalId: state.goalId, sessionId: state.sessionId, callId: call.id, stage: call.stage, actualOutput: outputs[0] });
      try { return actualToolPayload(outputs[0]); } catch (error) {
        state.toolError = { callId: call.id, error: String(error) };
        this.artifact("parent-delivery-protocol.json", this.parentDeliveries);
        throw error;
      }
    };
    const authority = await this.channelAuthority();
    attempt.channelAuthority = authority;
    attempt.fixtureLimit = "Explicit documented replyToMode off; omitted-setting Telegram inference failed on pinned host in preserved R4, not fixed upstream";
    const args = sourceSendArgs(route, state.summary);
    const prior = state.calls.at(-1);
    if (prior?.stage === "send") {
      const output = consume(prior);
      try { assertActualSendResult(output, prior.name, state.tool, prior.id); } catch (error) {
        state.toolError = { callId: prior.id, error: String(error) };
        this.artifact("parent-delivery-protocol.json", this.parentDeliveries);
        throw error;
      }
      state.resultTransport = "actual Responses function_call_output"; state.actualSendResult = output;
      assert.ok(this.botRequests.some((request) => request.method === "sendMessage" && request.result?.text === state.summary && request.result.chat.id === 501002), "Actual source send precedes NO_REPLY");
      this.artifact("parent-delivery-protocol.json", this.parentDeliveries);
      return { text: "NO_REPLY" };
    }
    if (!prior && tools.some((tool) => (tool.name ?? tool.function?.name) === "message")) return emit("message", args, "send");
    if (!prior) return emit("tool_search", { query: "message send", limit: 5 }, "search");
    if (prior.stage === "search") {
      const candidates = consume(prior);
      assert.ok(Array.isArray(candidates), "Actual single Tool Search returns candidates");
      const matching = candidates.filter((candidate) => candidate.name === "message" && candidate.source === "openclaw" && candidate.sourceName === "core");
      assert.equal(matching.length, 1, "Actual search admits exactly the existing core message tool");
      assert.equal(typeof matching[0].id, "string"); state.tool = matching[0];
      return emit("tool_describe", { id: state.tool.id }, "describe");
    }
    assert.equal(prior.stage, "describe");
    const description = consume(prior);
    assert.equal(description.id, state.tool.id); assert.equal(description.name, "message"); assert.equal(description.source, "openclaw"); assert.equal(description.sourceName, "core");
    assert.ok(description.parameters);
    const valid = this.validateHostSchema({ schema: description.parameters, value: args, cacheKey: `oca501:message:${hash(JSON.stringify(description.parameters))}` });
    assert.equal(valid.ok, true, `Message args match actual described schema: ${JSON.stringify(valid.errors)}`);
    state.description = description;
    return emit("tool_call", { id: state.tool.id, args }, "send");
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
    } finally {
      this.artifact("native-preflight-observed.json", { frames, stderr, processPid: child.pid, scope: "Actual frames observed even when preflight fails" });
      lines.close(); this.observeNativeProcesses(child.pid); await this.stop(child);
    }
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
    try {
      const value = JSON.parse(output.slice(output.indexOf("{")));
      if (method === "chat.history") {
        const projection = this.projectHistoryStream(output);
        if (projection.receipt.projection) this.historyExportProjections.set(value, { ...JSON.parse(projection.stdout), exportProjection: projection.receipt });
      }
      if (["chat.send", "chat.history", "agent.wait"].includes(method)) (this.logRpcReceipts ??= []).push({ method, params: structuredClone(params), value: structuredClone(value) });
      return value;
    } catch (error) {
      if (method.startsWith("config.")) throw new Error(`Invalid internal ${method} response; bytes=${Buffer.byteLength(output)} sha256=${hash(output)} (raw response excluded)`);
      throw error;
    }
  }
  async invoke(name, args, { channel = "webchat", target = this.sessionKey } = {}) {
    assert.ok(this.sessionKey, "Use an actual host-created session");
    const body = JSON.stringify({ name, args, sessionKey: this.sessionKey });
    const response = await fetch(`${this.gatewayUrl}/tools/invoke`, { method: "POST", headers: { authorization: `Bearer ${this.secrets[0]}`, "content-type": "application/json", "x-openclaw-message-channel": channel, "x-openclaw-message-to": target, "x-openclaw-account-id": "default" }, body, signal: AbortSignal.timeout(90_000) });
    const output = await response.json(); this.artifact(`invoke-${hash(body).slice(0, 12)}.json`, { method: "POST /tools/invoke", request: { name, args }, requestHash: hash(body), status: response.status, output });
    return { status: response.status, output };
  }
  async publicSession(sessionId, { waitingKind } = {}) {
    const row = this.sessions().find((entry) => entry.sessionId === sessionId); assert.ok(row?.name);
    const owner = { sessionId, name: row.name }, observedAt = new Date().toISOString();
    const listing = await this.invoke("agent_sessions", { status: "all", full: true });
    const checked = (response) => { assert.equal(response.status, 200); assert.equal(response.output.ok, true); assert.notEqual(response.output.result?.isError, true); return messageText({ content: response.output.result?.content ?? [] }); };
    let view, output, waiting, observationComplete = false;
    try {
      const item = sessionListing(checked(listing), owner);
      if (["completed", "failed", "stopped"].includes(item.phaseLabel)) {
        // Terminal output reads can claim early notification ownership. Observe
        // the listing only; required journals and delivery remain unconditional.
        assert.equal(waitingKind, undefined); view = { ...item, terminalListing: true };
      } else {
        output = await this.invoke("agent_output", { session: sessionId, full: true });
        view = activeSessionView(checked(output), checked(listing), owner);
        if (waitingKind) { waiting = await this.invoke("agent_sessions", { status: "waiting", full: true }); view = assertWaitingView(view, checked(waiting), waitingKind); }
      }
      observationComplete = true;
    } finally {
      this.publicObservationIndex = (this.publicObservationIndex ?? 0) + 1;
      this.artifact(`public-session-${this.publicObservationIndex}.json`, { observedAt, owner, listing, output, waiting, view, observationComplete, authority: "Actual anchored public text views; raw row supplies identity only" });
    }
    return { ...view, observedAt };
  }
  async setup() {
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), this.options["expected-sha"]);
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim(), "", "Acceptance requires a clean exact-head checkout");
    this.provenance.sourceArchiveHash = hash(execFileSync("git", ["archive", "HEAD"], { cwd: ROOT, maxBuffer: 50_000_000 }));
    const hostRoot = realpathSync(join(ROOT, "node_modules/openclaw"));
    const hostPackage = json(join(hostRoot, "package.json")); assert.equal(hostPackage.version, HOST_VERSION);
    const validatorPath = join(hostRoot, "dist/schema-validator-BP6RVpTv.mjs");
    this.validateHostSchema = (await import(validatorPath)).validateJsonSchemaValue;
    assert.equal(typeof this.validateHostSchema, "function");
    this.provenance.fixtureSchemaValidator = { path: validatorPath, hash: fileHash(validatorPath), scope: "Unmodified pinned pure JSON-schema validator; no host execution hooks" };
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
    this.artifact("completion-assertion-controls.json", verifyCompletionAssertionControls());
    this.artifact("parent-protocol-assertion-controls.json", verifyParentProtocolControls());
    this.pluginToolNames = pluginToolNames;
    const config = {
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token: this.secrets[0] }, reload: { mode: "hybrid" } },
      logging: { file: join(this.directory, "openclaw-runtime.log"), ...(this.options.phase === "matrix-l1" ? { level: "debug" } : {}) },
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
      tools: { profile: "full", allow: [...pluginToolNames, "message"] },
      plugins: { allow: ["openclaw-code-agent", "telegram"], slots: { memory: "none" }, entries: { "openclaw-code-agent": { enabled: true, config: { autoUpdate: false, defaultHarness: "codex", defaultWorktreeStrategy: "off", permissionMode: "bypassPermissions", planApproval: "ask", requiredGoalVerifierCommands: ["bash ci.sh"], harnesses: { codex: { defaultModel: MODEL, allowedModels: [MODEL] } } } } } },
      channels: { telegram: { enabled: true, botToken: this.secrets[1], apiRoot: this.botUrl, dmPolicy: "allowlist", allowFrom: ["501002"], replyToMode: "off", streaming: { mode: "off" } } },
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
    this.children.add(this.gateway); this.gatewayLog = ""; this.gatewayStdout = ""; this.gatewayStderr = "";
    const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
    this.gateway.stdout.on("data", (chunk) => { const text = stdoutDecoder.write(chunk); this.gatewayStdout += text; this.gatewayLog += text; });
    this.gateway.stderr.on("data", (chunk) => { const text = stderrDecoder.write(chunk); this.gatewayStderr += text; this.gatewayLog += text; });
    this.gateway.stdout.once("end", () => { const text = stdoutDecoder.end(); this.gatewayStdout += text; this.gatewayLog += text; });
    this.gateway.stderr.once("end", () => { const text = stderrDecoder.end(); this.gatewayStderr += text; this.gatewayLog += text; });
    await waitFor("actual pinned Gateway readiness", async () => {
      assert.equal(this.gateway.exitCode, null, "Owned Gateway exited before readiness; original complete stdout/stderr retained behind safe export boundary");
      try { const response = await fetch(`${this.gatewayUrl}/readyz`, { signal: AbortSignal.timeout(2000) }); return response.ok; } catch { return false; }
    });
    this.provenance.gatewayPid = this.gateway.pid;
    this.gatewayInstance = await this.hostIdentity();
    this.artifact("host-process-profile-identity.json", this.gatewayInstance);
    const loadedConfig = await this.rpc("config.get");
    this.artifact("telegram-default-authority.json", await this.channelAuthority());
    const loadedModels = loadedConfig.config.models;
    const loadedDefaults = loadedConfig.config.agents.defaults;
    assert.equal(loadedModels.mode, "replace"); assert.deepEqual(Object.keys(loadedModels.providers), ["oca501"]);
    assert.equal(loadedModels.providers.oca501.baseUrl, `${this.providerUrl}/host/v1`);
    const sourceModel = readOwnedConfig(this.env.OPENCLAW_CONFIG_PATH, this.directory).config.models?.providers?.oca501;
    if (sourceModel && JSON.stringify(sourceModel.models) === JSON.stringify(loadedModels.providers.oca501.models) && !Object.hasOwn(sourceModel.models.find((entry) => entry.id === MODEL) ?? {}, "requestTimeoutMs")) this.logModelReadback = { baseUrl: sourceModel.baseUrl, models: structuredClone(sourceModel.models) };
    assert.equal(loadedModels.providers.oca501.request.allowPrivateNetwork, true);
    assert.equal(loadedModels.catalogRefresh.enabled, false);
    assert.deepEqual(loadedDefaults.model, { primary: PARENT_MODEL, fallbacks: [] });
    assert.deepEqual(loadedDefaults.modelPolicy.allow, [PARENT_MODEL]); assert.equal(loadedDefaults.utilityModel, PARENT_MODEL);
    assert.equal(loadedDefaults.decisionModel, ""); assert.equal(loadedDefaults.experimental.decisionAssistance, false);
    assert.equal(loadedDefaults.embeddedAgent.cyberFailover.mode, "off");
    this.artifact("model-isolation-config.json", { projection: true, rawFullConfigExcluded: true, configHash: loadedConfig.hash, parentBaseUrl: `${this.providerUrl}/host/v1`, modelMode: "replace", configuredProviders: ["oca501"], catalogRefreshEnabled: false, primary: PARENT_MODEL, fallbacks: [], allowedModels: [PARENT_MODEL], utilityModel: PARENT_MODEL, decisionAssistance: false, cyberFailover: "off", nativeBaseUrl: `${this.providerUrl}/v1`, limits: "Provider account/model inference and real Telegram service acceptance remain unproven; fixture responses are deterministic" });
    // Genuine host creation with no initial turn or naming prompt materializes
    // the canonical WebChat session. Do not fabricate host storage/context.
    const beforeCreationRequests = this.modelRequests.length;
    // This fresh, one-shot bootstrap uses the normal creation path. Optional
    // creation idempotency requires a principal/device this token CLI lacks.
    const created = await this.rpc("sessions.create", { key: "agent:main:main", agentId: "main" });
    this.artifact("host-session-created.json", created);
    assert.equal(created.ok, true); assert.equal(created.key, "agent:main:main");
    assert.ok(created.sessionId); this.parentSessionId = created.sessionId; assert.ok(created.entry); assert.equal(created.runStarted, false);
    assert.equal(this.modelRequests.length, beforeCreationRequests, "Host session creation starts no model turn");
    this.sessionKey = created.key;
    assert.ok(this.gatewayLog.includes(`agent model: ${PARENT_MODEL}`), "Actual Gateway reports the isolated parent model");
    const modelSession = await this.rpc("sessions.list", { agentId: "main", limit: 10 });
    this.artifact("parent-model-session-before.json", modelSession);
    const effectiveSession = modelSession.sessions.find((entry) => entry.key === this.sessionKey);
    assert.ok(effectiveSession, "Real host lists the created parent session");
    assert.equal(effectiveSession.sessionId, created.sessionId); assert.equal(effectiveSession.agentId, "main");
    this.logParentIdentity = { agentId: effectiveSession.agentId, sessionId: effectiveSession.sessionId, sessionKey: effectiveSession.key };
    assert.equal(effectiveSession.modelProvider, "oca501"); assert.equal(effectiveSession.model, MODEL);
    if (effectiveSession.activeModelProvider !== undefined) assert.equal(effectiveSession.activeModelProvider, "oca501");
    if (effectiveSession.activeModel !== undefined) assert.equal(effectiveSession.activeModel, MODEL);
    const effective = await this.rpc("tools.effective", { agentId: "main", sessionKey: this.sessionKey });
    this.artifact("tools-effective.json", effective);
    const enabledOcaTools = assertEffectiveOcaTools(effective, pluginToolNames);
    assert.ok(effective.groups.flatMap((group) => group.tools).some((entry) => entry.id === "message" && entry.source !== "plugin" && entry.deniedBySession !== true), "Actual host exposes the existing core message under the narrow fixture policy");
    this.artifact("tools-effective-oca-enabled.json", { expectedIds: pluginToolNames.toSorted(), effectiveIds: enabledOcaTools.map((entry) => entry.id).toSorted(), entries: enabledOcaTools });
    this.artifact("goal-config-schema.json", await this.rpc("config.schema.lookup", { path: "plugins.entries.openclaw-code-agent.config" }));
    // Exercise the genuine embedded parent client, not only its configuration.
    const beforeParentProbe = this.modelRequests.length;
    const nativeRequestsBefore = this.modelRequests.filter((entry) => entry.transport === "native-codex").length;
    const setupProbeId = "setup-parent-prerequisite";
    this.parentProbes.set(setupProbeId, { id: setupProbeId, marker: PARENT_MARKER });
    const parentRun = await this.rpc("chat.send", { sessionKey: this.sessionKey, agentId: "main", message: `Reply exactly ${PARENT_MARKER}. Use no tools.`, thinking: "off", deliver: false, idempotencyKey: `oca501-parent-${randomBytes(12).toString("hex")}` });
    this.artifact("parent-probe-admission.json", parentRun);
    assert.ok(parentRun.runId, "Real host accepted a parent turn");
    const parentHistory = await waitFor("genuine parent loopback turn in canonical history", async () => {
      if (!this.modelRequests.slice(beforeParentProbe).some((entry) => entry.transport === "host-parent" && entry.responseCompleted)) return false;
      const history = await this.rpc("chat.history", { sessionKey: this.sessionKey, agentId: "main", limit: 10 });
      return history.sessionKey === this.sessionKey && history.sessionId === created.sessionId && history.messages.some((entry) => entry.role === "assistant" && entry.__openclaw?.runId === parentRun.runId) ? history : false;
    });
    const parentRequests = this.modelRequests.slice(beforeParentProbe);
    assert.ok(parentRequests.length > 0); assert.ok(parentRequests.every((entry) => entry.transport === "host-parent" && entry.authorization === "validated synthetic fixture key"));
    assert.equal(this.modelRequests.filter((entry) => entry.transport === "native-codex").length, nativeRequestsBefore, "Parent probe starts no native Codex turn");
    assert.ok(!existsSync(this.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH), "Parent marker turn launches no goal");
    const parentTerminal = await this.rpc("agent.wait", { runId: parentRun.runId, timeoutMs: 5000 });
    const attribution = selectCanonicalProbe(parentHistory, parentRequests, parentTerminal, { sessionKey: this.sessionKey, sessionId: created.sessionId, runId: parentRun.runId, marker: PARENT_MARKER, probeId: setupProbeId });
    const parentSessionAfter = await this.rpc("sessions.list", { agentId: "main", limit: 10 });
    const afterRow = parentSessionAfter.sessions.find((entry) => entry.key === this.sessionKey);
    assert.equal(afterRow?.sessionId, created.sessionId); assert.equal(afterRow.modelProvider, "oca501"); assert.equal(afterRow.model, MODEL);
    if (afterRow.activeModelProvider !== undefined) assert.equal(afterRow.activeModelProvider, "oca501");
    if (afterRow.activeModel !== undefined) assert.equal(afterRow.activeModel, MODEL);
    this.artifact("parent-loopback-probe.json", { run: parentRun, terminal: parentTerminal, history: parentHistory, attribution, effectiveSession: afterRow, requests: parentRequests, model: PARENT_MODEL, fixtureBoundary: "Actual embedded host provider/client; only external Responses output is deterministic" });
    this.provenance.parentModel = PARENT_MODEL; this.provenance.parentProviderBaseUrl = `${this.providerUrl}/host/v1`;
    const beforeRequests = this.modelRequests.length;
    const admitted = await this.invoke("agent_goal", { action: "launch", goal: "Return the prerequisite marker; make no edits.", name: "host-prerequisite", workdir: this.workspace, harness: "codex", max_iterations: 1, permission_mode: "bypassPermissions" });
    assert.equal(admitted.status, 200); assert.equal(admitted.output.ok, true); assert.notEqual(admitted.output.result?.isError, true);
    this.hostGoalAdmitted = true;
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
    if (this.options.phase === "matrix-l1") await runL1(this);
    if (this.options.phase === "routed-negative") await this.routedNegative();
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
    this.progress(id, "completed");
  }
  async patch(raw, replacePaths) {
    const before = await this.rpc("config.get");
    const identity = this.ownedProcessIdentity(this.gateway.pid);
    const changed = await this.rpc("config.patch", { raw: JSON.stringify(raw), baseHash: before.hash, replacePaths });
    this.artifact(`config-patch-${++this.patchCounter}.json`, { projection: true, rawFullConfigExcluded: true, beforeHash: before.hash, request: projectConfigRequest("config.patch", { raw: JSON.stringify(raw), baseHash: before.hash, replacePaths }), result: projectConfigResponse("config.patch", changed) });
    assert.equal(changed.ok, true); assert.ok(changed.hash && changed.hash !== before.hash, "Narrow patch must change the config hash");
    assert.ok(changed.changedPaths?.some((path) => replacePaths.includes(path)), "Host acknowledges the intended changed path");
    assert.equal(changed.sentinel?.payload?.stats?.requiresRestart, false, "Fixture policy changes must not restart the Gateway");
    // At this pin, successful hot config.patch waits writeResult.application;
    // persistence-only/not-applied writes return UNAVAILABLE, never this ACK.
    const applied = await this.rpc("config.get"); assert.equal(applied.hash, changed.hash, "Actual host reads back the applied config revision");
    this.artifact(`telegram-authority-patch-${this.patchCounter}.json`, await this.channelAuthority());
    assert.deepEqual(this.ownedProcessIdentity(this.gateway.pid), identity, "Same actual Gateway identity after patch");
    return changed;
  }
  async suite(commands, trusted = []) {
    const receipt = await ensureSuiteFields({ commands, trusted, patch: (raw, paths) => this.patch(raw, paths), observe: async (position) => {
      const ownerBefore = position === "before" ? await this.hostIdentity() : undefined;
      const publicConfig = await this.rpc("config.get");
      const source = readOwnedConfig(this.env.OPENCLAW_CONFIG_PATH, this.directory);
      telegramAuthority(publicConfig, { apiRoot: this.botUrl, token: this.secrets[1], env: this.env, sourceConfig: source.config });
      const owner = ownerBefore ?? await this.hostIdentity();
      return { public: publicConfig, source, owner };
    } });
    this.artifact(`suite-preparation-${this.commandCounter}.json`, receipt);
    this.activeSuite = commands;
  }
  ownedProcessIdentity(pid) {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ");
    return { pid, executable: realpathSync(`/proc/${pid}/exe`), startTicks: stat[19] };
  }
  async channelAuthority() {
    // Public API intentionally redacts credentials. Prove source consistency
    // only inside this verified disposable profile, with stable real revision,
    // bytes and process brackets; never export/reapply the full source.
    const ownerBefore = await this.hostIdentity();
    const before = await this.rpc("config.get");
    const sourceBefore = readOwnedConfig(this.env.OPENCLAW_CONFIG_PATH, this.directory);
    const authority = telegramAuthority(before, { apiRoot: this.botUrl, token: this.secrets[1], env: this.env, sourceConfig: sourceBefore.config });
    const after = await this.rpc("config.get");
    const sourceAfter = readOwnedConfig(this.env.OPENCLAW_CONFIG_PATH, this.directory);
    telegramAuthority(after, { apiRoot: this.botUrl, token: this.secrets[1], env: this.env, sourceConfig: sourceAfter.config });
    const ownerAfter = await this.hostIdentity();
    assertStableAuthority(before, after, sourceBefore, sourceAfter, ownerBefore, ownerAfter);
    this.provenance.telegramReplyThreading = { replyToMode: authority.replyToMode, verified: true, scope: "Explicit documented off configuration in new disposable profile", limit: "Pinned-host omitted-account/omitted-replyToMode inference failed in preserved R4; no upstream fix claimed" };
    const receipt = { ...authority, ownedRegularSourceVerified: true, ownedSourceBytesStable: true, publicRevisionBracketStable: true, ownedProcessProfileStable: true };
    this.artifact(`telegram-authority-${this.commandCounter}.json`, receipt);
    return receipt;
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
    assert.ok(!Object.keys(env).some((key) => /TELEGRAM/.test(key)), "Actual Gateway inherits no Telegram credentials");
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
    if (execute) assert.equal(this.nativeFixture.executionProved, true, "Actual advertised native execution and matching terminal tool result were observed");
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
          assertCompletionTerminal(terminal, row.completionWakeRunId, row.completionWakeRoutedReply);
          const source = row.completionWakeRoutedReply ? await this.sourceDeliveryEvidence(task, row, terminal) : await this.visibleDeliveryEvidence(task, row, terminal);
          this.artifact(`delivery-${task.id}.json`, { session: row, terminal, source });
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
  async visibleDeliveryEvidence(task, row, terminal) {
    const origin = row.originSessionKey ?? task.originSessionKey ?? task.route?.sessionKey; assert.ok(origin);
    const history = await this.rpc("chat.history", { sessionKey: origin, agentId: "main", limit: 200, maxBytes: 2_000_000, maxChars: 500_000 });
    const matching = history.messages.flatMap((entry) => {
      if (entry.role !== "assistant" || entry.__openclaw?.runId !== row.completionWakeRunId) return [];
      return this.modelRequests.filter((request) => request.transport === "host-parent" && request.responseId === entry.responseId && request.responseCompleted && request.emittedType === "message").map((request) => ({ entry, request }));
    });
    assert.equal(matching.length, 1, "Exact retained nonrouted completion has one actual canonical/provider reply");
    const { entry, request } = matching[0];
    assertVisibleCanonical(terminal, row.completionWakeRunId, request.responseId, entry, request.emittedText);
    return { retainedRunId: row.completionWakeRunId, canonical: entry, actualParentRequest: request, history, terminal, route: row.route };
  }
  async sourceDeliveryEvidence(task, row, terminal) {
    assertCompletionTerminal(terminal, row.completionWakeRunId, true);
    const candidates = this.parentDeliveries.filter((state) => state.goalId === task.id && state.sessionId === task.sessionId && state.calls.at(-1)?.stage === "send");
    assert.ok(candidates.length, "Genuine provider emitted an admitted current-source message call");
    const origin = row.originSessionKey ?? task.originSessionKey ?? task.route?.sessionKey;
    assert.ok(origin);
    const history = await this.rpc("chat.history", { sessionKey: origin, agentId: "main", limit: 100 });
    const proved = candidates.map((state) => {
      const call = state.calls.at(-1);
      const wire = this.botRequests.filter((request) => request.method === "sendMessage" && request.result?.text === state.summary && request.result.chat.id === 501002);
      const transcript = history.messages.flatMap((entry) => {
        if (entry.__openclaw?.runId !== row.completionWakeRunId) return [];
        const top = matchesHostCallId(entry.toolCallId, call) && entry.role === "toolResult" && [call.name, "message"].includes(entry.toolName) ? [{ record: entry, historyEntry: entry }] : [];
        // The supported history projection preserves genuine nested execution
        // as toolResult blocks, with its actual owning run and parent call ID.
        const nested = Array.isArray(entry.content) ? entry.content.filter((part) => part.type === "toolResult" && part.toolName === "message" && matchesHostCallId(part.parentToolCallId, call) && part.runId === row.completionWakeRunId).map((record) => ({ record, historyEntry: entry })) : [];
        return [...top, ...nested];
      });
      return { state, call, wire, transcript };
    }).filter((proof) => proof.wire.length && proof.transcript.length);
    assert.equal(proved.length, 1, "Exactly one actual source-send protocol/result/wire is correlated with this completion");
    const proof = proved[0];
    const storedRoute = { provider: task.route?.provider, target: task.route?.target, ...(task.route && Object.hasOwn(task.route, "accountId") ? { accountId: task.route.accountId } : {}) };
    assert.deepEqual(proof.state.route, exactFixtureRoute(storedRoute), "Actual task and source call preserve original account presence/value");
    const actualMessageArgs = proof.call.name === "tool_call" ? proof.call.args.args : proof.call.args;
    assert.deepEqual(actualMessageArgs, sourceSendArgs(proof.state.route, proof.state.summary), "Actual schema-valid emitted message args preserve route presence");
    assert.equal(proof.wire.length, 1, "One actual current-source summary send, with no duplicate delivery");
    for (const { record, historyEntry } of proof.transcript) {
      assert.notEqual(historyEntry.__openclaw?.truncated, true, "Canonical message result must not be truncated");
      assert.ok(record.content?.some((part) => typeof part.text === "string" && part.text.trim()), "Actual canonical message result has visible result content");
      assert.notEqual(record.isError, true);
    }
    for (const wire of proof.wire) {
      assert.ok(Number.isSafeInteger(wire.result.message_id)); assert.ok(wire.respondedAt);
      const params = JSON.parse(wire.params);
      for (const key of ["reply_to_message_id", "reply_parameters", "message_thread_id", "direct_messages_topic_id"]) assert.equal(Object.hasOwn(params, key), false, "Explicit off source send has no fabricated reply/thread identifiers");
    }
    const source = { retainedRunId: row.completionWakeRunId, terminalReceipt: terminal.terminalReceipt, protocol: proof.state, messageCallId: proof.call.id, wire: proof.wire, canonicalHistory: history, resultTransport: proof.state.actualSendResult ? "actual Responses function_call_output" : "canonical actual host tool transcript and terminal source receipt (final hook ended before next Responses request)" };
    (this.logSourceSettlements ??= []).splice(0, this.logSourceSettlements.length, ...this.logSourceSettlements.filter((proof) => proof.runId !== row.completionWakeRunId), { runId: row.completionWakeRunId, sessionKey: history.sessionKey, sessionId: history.sessionId, task: structuredClone(task), row: structuredClone(row), state: proof.state, terminal: structuredClone(terminal), wire: structuredClone(proof.wire), canonicalHistory: structuredClone(history) });
    this.artifact(`source-delivery-${task.id}.json`, source);
    return source;
  }
  async ordinarySourceSettlement(sessionId, kind) {
    const cycle = kind === "completed" ? "/completed" : "/turn-ended";
    const state = await waitFor("actual ordinary source send", () => this.parentDeliveries.find((state) => state.ordinarySessionId === sessionId && state.ordinaryCycle?.endsWith(cycle) && state.calls.at(-1)?.stage === "send"));
    const call = state.calls.at(-1);
    const history = await waitFor("actual ordinary send canonical result", async () => {
      const value = await this.rpc("chat.history", { sessionKey: this.sessionKey, limit: 200, maxBytes: 2_000_000, maxChars: 500_000 });
      const entries = value.messages.filter((entry) => entry.__openclaw?.runId && ((entry.role === "toolResult" && matchesHostCallId(entry.toolCallId, call) && [call.name, "message"].includes(entry.toolName)) || entry.content?.some((part) => part.type === "toolResult" && part.toolName === "message" && matchesHostCallId(part.parentToolCallId, call) && part.runId === entry.__openclaw.runId)));
      return entries.length ? { value, entries } : false;
    });
    const runIds = [...new Set(history.entries.map((entry) => entry.__openclaw.runId))]; assert.equal(runIds.length, 1);
    const runId = runIds[0]; const terminal = await waitFor("actual ordinary source own-run terminal", async () => { const value = await this.rpc("agent.wait", { runId, timeoutMs: 1000 }); return ["pending", "timeout"].includes(value.status) ? false : value; });
    assertCompletionTerminal(terminal, runId, true);
    for (const association of this.previewAssociations.filter((record) => record.provisionalOwner?.ordinaryCycle === state.ordinaryCycle)) {
      association.corroboratedOwnRun = assertPreviewSettlement(association, { sessionId, cycle: state.ordinaryCycle, operation: state.actualNativeCompletion.operation, runId });
    }
    for (const entry of history.entries) assert.notEqual(entry.__openclaw.truncated, true, "Complete canonical actual tool execution receipt required");
    const wire = this.botRequests.filter((request) => request.method === "sendMessage" && request.result?.text === state.summary && request.result.chat.id === 501002);
    assert.equal(wire.length, 1); assert.ok(wire[0].respondedAt);
    const params = JSON.parse(wire[0].params); assert.equal(params.reply_to_message_id, undefined); assert.equal(params.message_thread_id, undefined); assert.equal(params.reply_parameters, undefined);
    const args = call.name === "tool_call" ? call.args.args : call.args; assert.deepEqual(args, sourceSendArgs(state.route, state.summary));
    const row = this.sessions().find((row) => row.sessionId === sessionId);
    const projected = { provider: row.route.provider, target: row.route.target, ...(Object.hasOwn(row.route, "accountId") ? { accountId: row.route.accountId } : {}) }; assert.deepEqual(state.route, exactFixtureRoute(projected));
    assert.ok(state.actualNativeCompletion.nativeCompleted); assert.equal(state.actualNativeCompletion.threadId, row.backendRef.conversationId);
    if (kind === "completed") {
      await waitFor("ordinary actual required completion journal settled", () => {
        const current = this.sessions().find((row) => row.sessionId === sessionId);
        try { state.actualCompletedProof = assertOrdinaryCompleted(current, { sessionId, threadId: state.actualNativeCompletion.threadId, turnId: state.actualNativeCompletion.turnId, runId, routedReply: true, pendingSnapshot: state.actualOrdinaryAdmission }); return current; } catch { return false; }
      });
      assert.ok(this.botRequests.some((request) => request.method === "sendMessage" && request.respondedAt && request.result?.chat.id === 501002 && request.result.text?.startsWith(`✅ [${row.name}] Completed`)), "Original canonical terminal status notification has actual wire delivery");
    }
    await waitFor("ordinary direct delivery drained", () => { const value = this.sessions().find((row) => row.sessionId === sessionId); return !["notifying", "wake_pending"].includes(value.deliveryState) && !value.notificationDedupe?.some((entry) => entry.status === "in_flight"); });
    const evidence = { sessionId, kind, ordinaryCycle: state.ordinaryCycle, wakeHash: state.wakeHash, actualNativeCompletion: state.actualNativeCompletion, state, canonicalHistory: history.value, runId, terminal, wire, row: this.sessions().find((row) => row.sessionId === sessionId), resultTransport: state.actualSendResult ? "actual Responses function_call_output" : "canonical actual host tool result + terminal source receipt after final hook" };
    (this.logSourceSettlements ??= []).splice(0, this.logSourceSettlements.length, ...this.logSourceSettlements.filter((proof) => proof.runId !== runId), { ...evidence, state, sessionKey: history.value.sessionKey, sessionId: history.value.sessionId });
    this.artifact(`ordinary-source-${sessionId}-${kind}.json`, evidence); return evidence;
  }
  async routedNegative() {
    // A distinct command invocation creates a new own profile, port and state;
    // it cannot contaminate positive-profile settlement or consume its fence.
    this.currentScenario = "routed-source-negative";
    await this.settleGoalDelivery(this.goals().find((goal) => goal.name === "host-prerequisite"));
    const id = "routed-source-negative";
    const workdir = await this.workdir(id);
    this.nativeFixture = { tag: `OCA501_CASE_${id}`, text: MARKER, workdir };
    const admission = await this.invoke("agent_goal", this.goalArgs(id, workdir), { channel: "telegram", target: "501002" });
    assert.equal(admission.status, 200); assert.notEqual(admission.output.result?.isError, true);
    const task = await waitFor("separate negative goal admitted before completion", () => this.goals().find((goal) => goal.name === id));
    this.negativeDeliveryGoal = task.id;
    const completed = await waitFor("separate negative native/check success", () => this.goals().find((goal) => goal.id === task.id && goal.status === "succeeded"));
    assert.deepEqual(completed.requiredVerifierCommands, ["bash ci.sh"]); assert.equal(readFileSync(join(workdir, "receipt.txt"), "utf8"), "CI\n");
    const row = await waitFor("actual retained negative completion run", () => {
      const candidate = this.sessions().find((entry) => entry.sessionId === completed.sessionId);
      return candidate?.completionWakeRunId && candidate.completionWakeRoutedReply === true ? candidate : false;
    });
    const terminal = await waitFor("actual negative parent run terminal", async () => {
      const result = await this.rpc("agent.wait", { runId: row.completionWakeRunId, timeoutMs: 1000 });
      return ["pending", "timeout"].includes(result.status) ? false : result;
    });
    assert.equal(terminal.runId, row.completionWakeRunId); assert.equal(terminal.status, "ok");
    assert.notEqual(terminal.terminalReceipt?.sourceReplyDelivered, true);
    assert.throws(() => assertCompletionTerminal(terminal, row.completionWakeRunId, true));
    const preserved = this.sessions().find((entry) => entry.sessionId === completed.sessionId);
    assert.ok(!preserved.completionWakeSucceededAt, "No source send cannot satisfy the retained obligation");
    assert.ok(this.modelRequests.some((request) => request.goalId === task.id && request.expectedUnfulfilled && request.responseCompleted));
    assert.ok(!this.parentDeliveries.some((state) => state.goalId === task.id));
    assert.ok(!this.botMessages.some((message) => message.text?.startsWith(`OCA501 source receipt ${task.id}:`)));
    const evidence = { classification: "EXPECTED_UNFULFILLED", admission, task: completed, session: preserved, terminal, assertions: ["genuine routed goal/check succeeded", "deterministic plain model output made no message call", "actual source receipt absent", "strict acceptance predicate rejected own retained run", "unfulfilled obligation preserved; no C1 successful fence"] };
    this.artifact("routed-source-negative.json", evidence);
    this.results.push({ ...this.provenance, scenario: id, classification: "EXPECTED_UNFULFILLED", exitCode: 0, assertions: evidence.assertions, logPath: join(this.directory, "routed-source-negative.json") });
  }
  async launchCase(id, { commands, extra = {}, expected = {}, script = {}, text = MARKER, execute = false, slash = false } = {}) {
    this.progress(id, "start");
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
    this.currentScenario = id; this.progress(id, "start");
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
      if (verifierCommands === null) {
        assert.notEqual(admission.status, 404, "Missing tool availability cannot prove present-null selection refusal");
        assert.match(JSON.stringify(admission.output), /verifier|commands|schema|invalid.*arg|parameter/i, "Present-null refusal identifies actual validation/policy failure");
      }
    }
    const after = this.effects(); assertNoWorkEffects(before, after);
    this.recordCase(id, { admission, selection: { present: true, value: verifierCommands }, before, after, layer: expectedHostDeny ? "host effective tools policy" : admission.status >= 400 ? "host validation" : "OCA atomic policy admission", assertions: ["actual ingress rejected", "no goal/session insertion", "no native/provider/check effects", "no mandatory verifier confirmation"] });
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
    for (const [suffix, selection] of [["true", ["true"]], ["false", ["false"]], ["path", ["bash ./ci.sh"]], ["suffix", ["bash ci.sh; true"]], ["case", ["BASH ci.sh"]], ["space", ["bash  ci.sh"]], ["newline", ["bash\nci.sh"]], ["empty", []], ["null", null], ["blank", [""]], ["white", [" "]], ["mixed", ["bash ci.sh", 1]], ["nonarray", "bash ci.sh"]]) await this.deniedCase(`H03-${suffix}`, selection);
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
    for (const association of this.previewAssociations) assert.equal(association.corroboratedOwnRun, association.actualRunId, "Every provisional preview owner received exact genuine source settlement before fencing");
    this.artifact("preview-owner-settlement.json", this.previewAssociations);
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
    if (this.gateway) await waitFor("actual owned Gateway stdout/stderr complete", () => this.gateway.stdout.readableEnded && this.gateway.stderr.readableEnded, 5000);
    this.captureHostStream("gateway.log", this.gatewayLog ?? "Gateway not started");
    this.captureHostStream("gateway.stdout.log", this.gatewayStdout ?? ""); this.captureHostStream("gateway.stderr.log", this.gatewayStderr ?? "");
    if (existsSync(join(this.directory, "openclaw-runtime.log"))) {
      const runtimeText = readFileSync(join(this.directory, "openclaw-runtime.log"));
      if (!hostLogEvidence(runtimeText).completeStreamSafe) this.captureHostStream("runtime-log.projection.json", runtimeText);
    }
    this.artifact("fixtures.json", { modelRequests: this.modelRequests, botRequests: this.botRequests, botMessages: this.botMessages, botMenus: [...this.botMenus.entries()], fixtureErrors: this.fixtureErrors, nativeExecutions: this.nativeExecutions });
    this.artifact("provenance.json", this.provenance);
    this.artifact("results.json", this.results);
  }
  exportEvidence() {
    // Registration is the allowlist: only actual receipt writes through
    // artifact(), plus three explicitly identified owned runtime/store files.
    // Config/auth/env, caches, native rollout/binary and package archives are
    // deliberately excluded, even though they live under the disposable root.
    let runtimeSafe = true;
    if (existsSync(join(this.directory, "openclaw-runtime.log"))) {
      const receipt = this.hostStreamEvidence(readFileSync(join(this.directory, "openclaw-runtime.log")));
      runtimeSafe = receipt.completeStreamSafe;
      if (!runtimeSafe) { this.captureHostStream("runtime-log.projection.json", readFileSync(join(this.directory, "openclaw-runtime.log"))); this.artifact("results.json", this.results); }
    }
    const entries = [...this.artifactFiles].map((name) => ({ name, alreadyRedacted: true }));
    const unavailable = [];
    for (const name of ["goals.json", "sessions.json", "openclaw-runtime.log"]) {
      if (name === "openclaw-runtime.log" && !runtimeSafe) unavailable.push({ name, reason: "Original guard-rejected raw stream excluded; source projection or BLOCKED receipt retains original identity and complete classification" });
      else if (existsSync(join(this.directory, name))) entries.push({ name, alreadyRedacted: false });
      else {
        assert.ok(!this.hostGoalAdmitted, `Required ${name} evidence missing after real admission`);
        unavailable.push({ name, reason: "Not generated before setup failed; no runtime acceptance claimed" });
      }
    }
    for (const name of ["cleanup.json", "gateway.log", "fixtures.json", "provenance.json", "results.json", "acceptance-command.stdout.log", "acceptance-command.stderr.log"]) assert.ok(this.artifactFiles.has(name), `Required evidence not captured: ${name}`);
    const cleanup = json(join(this.directory, "cleanup.json"));
    const coverage = this.l1Assignment ? l1Coverage(this.l1Assignment.selectedL1Cohort, this.results.filter((row) => this.l1Assignment.assignedCaseIds.includes(row.scenario) && row.classification === "PASS").map((row) => row.scenario), process.exitCode ?? 0) : {};
    const metadata = { ...this.provenance, ...coverage, phase: this.options.phase ?? "prerequisites", scriptExitCode: process.exitCode ?? 0, primaryFailure: this.primaryFailure ?? null, cleanup: { classification: cleanup.classification, failures: cleanup.failures }, independentErrors: this.independentErrors ?? [], unavailable, excludes: ["openclaw.json/raw config", "auth/environment/provider keys", "native binaries/rollout/cache", "tarballs/unpacked/install trees", "unrelated files"], sourceReceipts: "Nonsensitive command stdout/stderr complete and separate; config commands export closed projections with original stream hashes, full config/streams/arguments excluded; artifact receipts exact-key redacted, runtime/store original hashes precede export redaction" };
    const bundle = buildEvidence(this.directory, entries, metadata, this.secrets);
    const framed = frameEvidence(bundle);
    // Awaiting the write callback keeps the complete end/digest inside the
    // owning job lifetime rather than relying on later warm-server recovery.
    return new Promise((done, reject) => process.stdout.write(framed, (error) => error ? reject(error) : done()));
  }
}

let run;
try {
  run = new AcceptanceRun(parseOptions(process.argv.slice(2)));
  await run.setup();
} catch (error) {
  if (run) { run.primaryFailure = run.redact(error.stack ?? error); run.stderrCapture = `${run.primaryFailure}\n`; }
  if (run) run.results.push({ ...run.provenance, scenario: run.currentScenario ?? "H01-prerequisite", classification: "BLOCKED", exitCode: 1, unprovenReason: run.redact(error.stack ?? error), logPath: run.directory });
  console.error(run ? run.redact(error.stack ?? error) : String(error));
  process.exitCode = 1;
} finally {
  if (run) {
    try { await run.cleanup(); } catch (error) {
      process.exitCode = 1;
      (run.independentErrors ??= []).push({ stage: "cleanup", error: run.redact(error.stack ?? error) });
      const message = `Cleanup/evidence failure: ${run.redact(error.stack ?? error)}`;
      run.stderrCapture = (run.stderrCapture ?? "") + `${message}\n`; console.error(message);
    }
    const remaining = run.options.phase === "matrix-l1" ? "H01–H05/H08/H10–H12 final cumulative coverage remains UNPROVEN in this phase" : "H06–H12 remain UNPROVEN in these milestone phases";
    const selected = run.l1Assignment ? ` selected L1 cohort ${run.l1Assignment.selectedL1Cohort}; unassigned ${run.l1Assignment.unassignedCohorts.join(",") || "none"}` : "";
    const summary = `${LABEL}: ${run.options.phase ?? "prerequisites"}${selected} ${process.exitCode ? "BLOCKED" : "MILESTONE COMPLETE"}; ${remaining}; evidence ${run.directory}`;
    run.artifact("acceptance-command.stdout.log", `${run.progressCapture}${summary}\n`);
    run.artifact("acceptance-command.stderr.log", run.stderrCapture ?? "");
    try { await run.exportEvidence(); } catch (error) {
      process.exitCode = 1;
      (run.independentErrors ??= []).push({ stage: "export", error: run.redact(error.stack ?? error) });
      // A failed export cannot leave an apparently complete PASS bundle.
      console.error(`Evidence export BLOCKED: ${run.redact(error.stack ?? error)}`);
      console.log(`OCA501_EVIDENCE ${JSON.stringify({ type: "incomplete", complete: false, candidateSha: run.provenance.candidateSha, primaryFailure: run.primaryFailure ?? null, independentErrors: run.independentErrors })}`);
    }
    console.log(`${summary}${process.exitCode ? "; exit blocked (see errors/export)" : ""}`);
  }
}
