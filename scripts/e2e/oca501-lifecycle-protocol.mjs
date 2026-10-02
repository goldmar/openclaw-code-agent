// Pure external-provider fixture selection. No host/native state is fabricated.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { nativeInventory } from "./oca501-native-protocol.mjs";
import { projectHostLog, presentHostLogDiagnostic, HOST_DIAGNOSTIC_IDENTITIES } from "./oca501-host-log-projection.mjs";
import { sourceLogObservation, LOG_SOURCE_TABLE_SHA256 } from "./oca501-log-source-observation.mjs";

export const messageText = (entry) => typeof entry.content === "string" ? entry.content : (entry.content ?? []).map((part) => part.text ?? "").join("\n");
export function latestParentUser(input) {
  return input.input.findLast((entry) => entry.role === "user" && !messageText(entry).trim().startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>"));
}
// Exact pinned session-activity-summaries.ts SYSTEM_PROMPT. Recap transcript
// data is never current user intent, even when it quotes a registered probe.
const ACTIVITY_RECAP_PROMPT_SHA256 = "db550562a488aaab5577cd5ad3bf1ff708120db7aa3ada109500ce257c4ef98f";
export function classifyParentRequest(input, receipt) {
  assert.equal(receipt.transport, "host-parent"); assert.equal(receipt.path, "/host/v1/responses");
  assert.equal(receipt.httpMethod, "POST"); assert.equal(receipt.authorization, "validated synthetic fixture key");
  assert.equal(input.model, "gpt-6-luna"); assert.equal(receipt.model, input.model); assert.equal(input.stream, true);
  assert.ok(Array.isArray(input.input));
  const system = input.input[0], systemText = system?.role === "system" ? messageText(system) : "";
  const promptHash = createHash("sha256").update(systemText).digest("hex");
  if (promptHash === ACTIVITY_RECAP_PROMPT_SHA256) {
    assert.equal(input.input.length, 2); assert.ok(input.tools === undefined || (Array.isArray(input.tools) && input.tools.length === 0));
    for (const [index, role] of [[0, "system"], [1, "user"]]) {
      const entry = input.input[index]; assert.deepEqual(Object.keys(entry).sort(), ["content", "role", "type"]); assert.equal(entry.type, "message"); assert.equal(entry.role, role);
      assert.ok(Array.isArray(entry.content)); assert.equal(entry.content.length, 1);
      assert.deepEqual(Object.keys(entry.content[0]).sort(), ["text", "type"]); assert.equal(entry.content[0].type, "input_text"); assert.equal(typeof entry.content[0].text, "string");
    }
    let payload; try { payload = JSON.parse(messageText(input.input[1])); } catch { assert.fail("Malformed pinned Activity recap payload; raw content excluded from error"); }
    assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
    assert.deepEqual(Object.keys(payload).sort(), ["messages", "omittedContent", "previousRecap"]);
    assert.equal(typeof payload.previousRecap, "string"); assert.equal(typeof payload.omittedContent, "boolean");
    assert.ok(Array.isArray(payload.messages) && payload.messages.every((text) => typeof text === "string"));
    return { kind: "activity-recap", systemPromptSha256: promptHash, attribution: "untrusted recap data; no probe, source-send or queued-context authority" };
  }
  assert.ok(Array.isArray(input.tools) && input.tools.length > 0, "Unknown auxiliary request is BLOCKED, never selected by missing tools");
  assert.ok(systemText.startsWith("<!-- openclaw:attempt:STABLE -->"), "Current embedded parent request requires its actual system surface");
  assert.ok(input.tools.some((tool) => tool.type === "function" && ["tool_search", "tool_describe", "tool_call", "message"].includes(tool.name ?? tool.function?.name)), "Genuine advertised parent tool surface required");
  return { kind: "embedded-parent", systemPromptSha256: promptHash };
}
export function selectParentProbe(input, receipt, probes) {
  const classification = classifyParentRequest(input, receipt);
  if (classification.kind === "activity-recap") return { classification };
  const latest = latestParentUser(input), text = latest ? messageText(latest) : "";
  const normalized = text.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\] /, "");
  const matches = [...probes].filter((probe) => normalized === `Reply exactly ${probe.marker}. Use no tools.`);
  assert.ok(matches.length <= 1, "One registered probe owns the exact current user intent");
  return { classification, probe: matches[0] };
}
export function selectCanonicalProbe(history, requests, terminal, expected) {
  assert.equal(history.sessionKey, expected.sessionKey); assert.equal(history.sessionId, expected.sessionId);
  assert.ok(typeof expected.runId === "string" && expected.runId && typeof expected.probeId === "string" && expected.probeId);
  assert.ok(Array.isArray(history.messages));
  const own = history.messages.filter((message) => message.role === "assistant" && message.__openclaw?.runId === expected.runId);
  assert.equal(own.length, 1, "Exactly one complete canonical own-run assistant, before provider selection");
  const canonical = own[0]; assert.ok(typeof canonical.responseId === "string" && canonical.responseId);
  const matched = requests.filter((request) => request.transport === "host-parent" && request.responseId === canonical.responseId);
  assert.equal(matched.length, 1, "Canonical response ID joins exactly one actual provider request in the admission window");
  const request = matched[0]; assert.equal(request.responseCompleted, true); assert.equal(request.parentProbe, expected.probeId);
  assert.equal(request.parentRequestClassification?.kind, "embedded-parent");
  const selected = selectParentProbe(request.actualProbeInput, request, [{ id: expected.probeId, marker: expected.marker }]); assert.equal(selected.probe?.id, expected.probeId);
  assert.equal(request.emittedType, "message"); assert.equal(request.emittedText, expected.marker); assert.equal(request.parentCall, undefined);
  assert.equal(messageText(canonical), expected.marker); assert.equal(terminal.terminalReply?.text, expected.marker);
  assertVisibleCanonical(terminal, expected.runId, request.responseId, canonical, expected.marker);
  return { canonical, request, selectedRequestIndex: request.requestIndex, excludedRequests: requests.filter((other) => other !== request).map((other) => ({ requestIndex: other.requestIndex, responseId: other.responseId, classification: other.parentRequestClassification, reason: "not the exact admitted canonical response" })) };
}
export function selectNativeCase(input, cases) {
  assert.ok(Array.isArray(input.input));
  const userText = input.input.filter((entry) => entry.type === "message" && entry.role === "user").map(messageText).join("\n");
  const tags = [...new Set(userText.match(/OCA501_CASE_[A-Za-z0-9_-]+:/g) ?? [])].map((tag) => tag.slice(0, -1));
  if (!tags.length) {
    assert.ok(userText.includes("Return the prerequisite marker.") || userText.includes("Return the prerequisite marker; make no edits."), "Unmatched genuine native request is BLOCKED");
    return;
  }
  assert.equal(tags.length, 1, "Ambiguous native conversation cannot borrow another fixture");
  assert.ok(cases.has(tags[0]), "Only an actually admitted registered native case may select output");
  return cases.get(tags[0]);
}
// Public tools are text views of the active Session; recovery rows are not a
// substitute for these source-defined owner headers and listing blocks.
export function sessionListing(text, { sessionId, name }) {
  assert.ok(typeof sessionId === "string" && sessionId && typeof name === "string" && name);
  const lines = text.split("\n"), blocks = [];
  for (let index = 0; index < lines.length; index++) {
    const marker = ` ${name} [${sessionId}] — `, position = lines[index].indexOf(marker);
    if (position <= 0 || lines[index].slice(0, position).includes(" ")) continue;
    let end = index + 1;
    while (end < lines.length && !/^\S+ [^\n]+ \[[A-Za-z0-9_-]+\] — /.test(lines[end])) end++;
    blocks.push(lines.slice(index, end).join("\n").trimEnd());
  }
  assert.equal(blocks.length, 1, "Exact public listing has one owning session block");
  const block = blocks[0], first = block.split("\n")[0], phaseLabel = first.split(` ${name} [${sessionId}] — `)[1].split(" · ")[0];
  assert.ok(["starting", "running", "waiting for plan approval", "waiting for an answer", "waiting for a merge / PR decision", "suspended (a message resumes it)", "completed", "failed", "stopped"].includes(phaseLabel));
  return { sessionId, name, phaseLabel, block, recovered: block.includes("♻️ Recovered after a Gateway restart; no live process") };
}
export function activeSessionView(output, listing, owner) {
  const prefix = `Session: ${owner.name} [${owner.sessionId}] | Status: `;
  const first = output.split("\n")[0]; assert.ok(first.startsWith(prefix), "Anchored public active header, never persisted fallback/body text");
  const fields = first.slice(prefix.length).match(/^(STARTING|RUNNING) \| Phase: ([a-z_]+)(?: \| Lifecycle: ([a-z_]+))? \| Cost: \$[0-9]+\.[0-9]{4} \| Duration: [^\n]+$/);
  assert.ok(fields, "Public active header has the source-defined current posture");
  const labels = { starting: "starting", running: "running", active: "running", awaiting_plan_decision: "waiting for plan approval", awaiting_user_input: "waiting for an answer", awaiting_worktree_decision: "waiting for a merge / PR decision" };
  const phase = fields[2]; assert.ok(Object.hasOwn(labels, phase));
  const item = sessionListing(listing, owner); assert.equal(item.recovered, false); assert.equal(item.phaseLabel, labels[phase]);
  return { ...item, status: fields[1].toLowerCase(), phase, lifecycle: fields[3] ?? phase, outputText: output };
}
export function assertWaitingView(view, waitingListing, kind) {
  const item = sessionListing(waitingListing, view); assert.equal(item.recovered, false);
  const expected = {
    plan: ["awaiting_plan_decision", "Plan waiting for the user: Approve / Revise / Reject (buttons, or reply approve, reject, or the changes)"],
    revise: ["awaiting_user_input", "Plan revision requested: waiting for the user's changes (forward them with agent_respond, userInitiated=true)"],
    question: ["awaiting_user_input", "Question waiting for an answer (agent_output shows it; answer with agent_respond)"],
  }[kind]; assert.ok(expected); assert.equal(view.phase, expected[0]); assert.equal(view.status, "running");
  assert.equal(item.phaseLabel, view.phaseLabel); assert.ok(item.block.split("\n").includes(`   👉 ${expected[1]}`), "Exact owner's public next step supplies current decision authority");
  return { ...view, waitingBlock: item.block, waitingKind: kind };
}
export function planPromptAuthority({ message, tokens, view, markdown, route, nativeRequest, threadId, caseTag }) {
  assert.equal(nativeRequest?.nativeIdentity?.thread_id, threadId); assert.ok(typeof threadId === "string" && threadId); assert.equal(nativeRequest.case, caseTag); assert.ok(typeof caseTag === "string" && caseTag);
  assert.equal(view.waitingKind, "plan"); assert.ok(view.outputText.includes(markdown) && markdown.trim());
  assert.equal(nativeRequest?.responseCompleted, true); assert.equal(nativeRequest.emittedType, "message");
  assert.ok(nativeRequest?.nativePlanModelText === `<proposed_plan>\n${markdown}\n</proposed_plan>`);
  assert.ok(typeof nativeRequest.receivedAt === "string" && Number.isFinite(Date.parse(nativeRequest.receivedAt)));
  assert.equal(message.chat.id, 501002); assert.equal(route.provider, "telegram"); assert.equal(route.target, "501002");
  assert.ok(Object.keys(route).every((key) => ["provider", "target", "accountId", "sessionKey"].includes(key))); if (Object.hasOwn(route, "accountId")) assert.equal(route.accountId, "default");
  const prefix = `📋 [${view.name}] Plan v`, first = message.text.split("\n")[0]; assert.ok(first.startsWith(prefix));
  const versionMatch = first.slice(prefix.length).match(/^([1-9][0-9]*) (?:ready for approval|needs your decision)(?: \([1-9][0-9]*\/[1-9][0-9]*\))?:?$/); assert.ok(versionMatch);
  const version = Number(versionMatch[1]); assert.ok(Number.isSafeInteger(version));
  const kinds = { Approve: "plan-approve", Revise: "plan-request-changes", Reject: "plan-reject" }, matched = [];
  for (const [label, kind] of Object.entries(kinds)) {
    const buttons = message.reply_markup?.inline_keyboard?.flat().filter((button) => button.text === label); assert.equal(buttons?.length, 1);
    const candidates = tokens.filter((token) => token.sessionId === view.sessionId && token.kind === kind && buttons[0].callback_data === `code-agent:${token.id}`); assert.equal(candidates.length, 1);
    const token = candidates[0]; assert.equal(token.planDecisionVersion, version); assert.ok(token.createdAt >= Date.parse(nativeRequest.receivedAt)); assert.ok(!token.consumedAt);
    assert.equal(token.route?.provider, route.provider); assert.equal(token.route?.target, route.target);
    assert.equal(Object.hasOwn(token.route, "accountId"), Object.hasOwn(route, "accountId")); assert.equal(token.route.accountId, route.accountId); assert.equal(token.route.threadId, undefined);
    matched.push(token);
  }
  const appended = view.outputText.match(/^Pending plan \(v([1-9][0-9]*)\):$/m); if (appended) assert.equal(Number(appended[1]), version);
  return { version, sessionId: view.sessionId, name: view.name, originalPrompt: structuredClone(message), originalTokens: structuredClone(matched), nativeRequest: nativeRequest.requestIndex };
}
export function questionCall(input, fixture, { callId, itemId, validate }) {
  assert.equal(fixture.permissionMode, "plan", "Genuine native questions require the admitted Plan collaboration posture");
  const matches = nativeInventory(input).filter(({ namespace, tool }) => namespace === "functions" && tool.name === "request_user_input");
  assert.equal(matches.length, 1, "Exactly one actual question function must be advertised");
  const { namespace, tool } = matches[0]; assert.equal(tool.type, "function"); assert.equal(tool.parameters?.type, "object");
  const args = { questions: [{ id: "fixture_choice", header: "Fixture", question: `${fixture.tag}: Which harmless fixture choice should be recorded?`, options: [{ label: "Choice A", description: "Continue the harmless fixture." }, { label: "Choice B", description: "Continue the other harmless fixture." }] }] };
  assert.equal(validate({ schema: tool.parameters, value: args }).ok, true, "Use the actual native question schema");
  return { item: { type: "function_call", id: itemId, namespace, name: tool.name, arguments: JSON.stringify(args), call_id: callId }, args, callId, namespace, name: tool.name };
}
export function assertQuestionAnswer(output, call, expected) {
  assert.equal(output.type, "function_call_output"); assert.equal(output.call_id, call.callId);
  assert.ok(!output.isError && !output.error && output.success !== false);
  let value = output.output;
  if (Array.isArray(value)) { assert.equal(value.length, 1); assert.equal(value[0].type, "input_text"); value = value[0].text; }
  assert.equal(typeof value, "string"); const actual = JSON.parse(value);
  assert.ok(!actual.error && !actual.isError);
  assert.deepEqual(actual.answers?.fixture_choice?.answers, [expected], "Actual native continuation includes the submitted answer");
  return actual;
}
export function assertNoNativeContinuation(before, after) {
  for (const field of ["goalIds", "sessionIds", "nativeRequests", "nativeProcesses", "receipts"]) assert.deepEqual(after[field], before[field], `Denied work changed ${field}`);
}

export function assertConfigSchemaRefusal(receipt, path) {
  assert.equal(receipt.streamsComplete, true); assert.equal(receipt.timedOut, false);
  assert.equal(receipt.exit.code, 1); assert.equal(receipt.exit.signal, null); assert.ok(!receipt.exit.spawnError);
  let value; try { value = JSON.parse(receipt.stdout.slice(receipt.stdout.indexOf("{"))); } catch { throw new Error("Config-schema error payload is malformed; original stream hashes retained; raw config excluded"); }
  assert.equal(value.ok, false); assert.equal(value.error?.type, "gateway_request_error"); assert.equal(value.error.code, "INVALID_REQUEST");
  const issues = value.error.details?.issues; assert.ok(Array.isArray(issues) && issues.length);
  const paths = issues.map((issue) => Array.isArray(issue.path) ? issue.path.join(".") : issue.path);
  assert.ok(paths.some((actual) => typeof actual === "string" && (actual === path || actual.startsWith(`${path}.`))), "Actual schema issue names the intended plugin setting");
  return { classification: "HOST_SCHEMA_REJECTION", code: value.error.code, settingPath: path, issuePaths: paths.filter((actual) => typeof actual === "string" && (actual === path || actual.startsWith(`${path}.`))) };
}
export function nativeDiagnostics(lines) {
  return lines.split("\n").flatMap((line) => {
    try {
      const record = JSON.parse(line); const values = Object.values(record).filter((value) => typeof value === "string");
      return values.flatMap((value) => { try { const event = JSON.parse(value); return event.component === "CodexHarness" ? [event] : []; } catch { return []; } });
    } catch { return []; }
  });
}

// Export-only exclusion of an official capped describe preview. The real RPC
// object remains unchanged and the preview never supplies acceptance evidence.
export function projectHistoryPreviews(text, { method, sessionKey, sessionId, calls }) {
  try {
    let value; try { value = JSON.parse(text); } catch { throw new Error("Malformed history response; raw stream excluded"); }
    assert.equal(method, "chat.history"); assert.equal(value.sessionKey, sessionKey); assert.equal(value.sessionId, sessionId); assert.ok(Array.isArray(value.messages));
    const projected = structuredClone(value), exclusions = [];
    for (const [index, message] of value.messages.entries()) {
      if (message.toolName !== "tool_describe" || message.__openclaw?.truncated !== true) continue;
      const closed = (item, keys) => assert.ok(item && !Array.isArray(item) && typeof item === "object" && Object.keys(item).every((key) => keys.includes(key)), "Unknown capped preview provenance excluded");
      assert.equal(message.role, "toolResult"); assert.equal(message.isError, false); assert.equal(message.__openclaw.reason, "display-cap");
      closed(message, ["role", "toolName", "toolCallId", "content", "isError", "timestamp", "__openclaw"]);
      const owners = calls.filter((call) => message.toolCallId === call.id || message.toolCallId === `${call.id}|${call.itemId}`); assert.equal(owners.length, 1, "Capped preview belongs to one genuinely emitted describe call");
      const call = owners[0]; assert.equal(call.name, "tool_describe"); assert.equal(call.stage, "describe");
      const meta = message.__openclaw; closed(meta, ["runId", "id", "recordTimestampMs", "transcriptPosition", "seq", "truncated", "reason"]);
      assert.ok(typeof meta.runId === "string" && /^notification:[a-f0-9]{16}$/.test(meta.runId)); if (call.runId !== undefined) assert.equal(meta.runId, call.runId);
      assert.ok(typeof meta.id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(meta.id));
      for (const number of [meta.recordTimestampMs, meta.seq, message.timestamp]) assert.ok(Number.isSafeInteger(number) && number >= 0);
      closed(meta.transcriptPosition, ["source", "rawSeq"]); assert.ok(typeof meta.transcriptPosition.source === "string" && /^[A-Za-z0-9_-]+$/.test(meta.transcriptPosition.source)); assert.ok(Number.isSafeInteger(meta.transcriptPosition.rawSeq) && meta.transcriptPosition.rawSeq >= 0);
      assert.ok(Array.isArray(message.content) && message.content.length === 1); closed(message.content[0], ["type", "text"]); assert.equal(message.content[0].type, "text"); assert.equal(typeof message.content[0].text, "string"); assert.equal(message.content[0].text.length, 8000, "Pinned host display text cap, never an arbitrary truncated record");
      let provisionalOwner;
      if (call.runId === undefined) {
        assert.ok(typeof call.sessionId === "string" && call.sessionId && call.ownerId === call.sessionId);
        assert.ok(["user", "compact", "review"].includes(call.operation) && Number.isSafeInteger(call.request) && call.request > 0);
        assert.ok(typeof call.nativeThreadId === "string" && call.nativeThreadId && typeof call.nativeTurnId === "string" && call.nativeTurnId);
        assert.equal(call.ordinaryCycle, `${call.sessionId}/${call.nativeTurnId}/turn-ended`);
        provisionalOwner = { sessionId: call.sessionId, ownerId: call.ownerId, ordinaryCycle: call.ordinaryCycle, operation: call.operation, actualParentRequest: call.request, nativeThreadId: call.nativeThreadId, nativeTurnId: call.nativeTurnId };
      }
      const serialized = JSON.stringify(message);
      const excluded = { messageIndex: index, toolCallId: message.toolCallId, actualRunId: meta.runId, ...(provisionalOwner ? { provisionalOwner, identityScope: "Current emitted ordinary call and canonical metadata; provisional only until exact own-run source settlement" } : {}), canonicalMessageSerialization: { bytes: Buffer.byteLength(serialized), sha256: createHash("sha256").update(serialized).digest("hex"), hashScope: "JSON.stringify(actual record); not original message byte slice" }, contentExcluded: true, exclusionReason: "host display-cap tool_describe preview; not acceptance evidence" };
      projected.messages[index] = { role: message.role, toolName: message.toolName, toolCallId: message.toolCallId, isError: false, timestamp: message.timestamp, __openclaw: structuredClone(meta), ...excluded };
      exclusions.push(excluded);
    }
    const stdout = exclusions.length ? JSON.stringify(projected) : text;
    return { stdout, receipt: { projection: exclusions.length > 0, originalCompleteStdout: { bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") }, projectedStdout: { bytes: Buffer.byteLength(stdout), sha256: createHash("sha256").update(stdout).digest("hex") }, rawPreviewContentExcluded: exclusions.length > 0, exclusions } };
  } catch {
    throw new Error(`Unverified history preview projection BLOCKED; raw stream excluded; bytes=${Buffer.byteLength(text)} sha256=${createHash("sha256").update(text).digest("hex")}`);
  }
}

export function assertPreviewSettlement(association, { sessionId, cycle, operation, runId }) {
  assert.equal(association.actualRunId, runId); assert.equal(association.provisionalOwner?.sessionId, sessionId);
  assert.equal(association.provisionalOwner.ordinaryCycle, cycle); assert.equal(association.provisionalOwner.operation, operation);
  return runId;
}

// Exceptions are tied to the actual RPC method AND the canonical response
// location. They never apply to Gateway/debug envelopes or nested config.
function commandMetadataInspection(value, method) {
  const copy = structuredClone(value), metadata = [];
  const closed = (item, fields) => assert.ok(item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).every((key) => fields.includes(key)), "Unknown RPC metadata excluded");
  const defaults = (item, minimal = false) => {
    closed(item, minimal ? ["model", "contextTokens"] : ["modelProvider", "model", "contextTokens", "agentRuntime", "thinkingLevels", "thinkingOptions", "thinkingDefault", "modelSelectionTarget"]);
    for (const key of minimal ? ["model", "contextTokens"] : ["modelProvider", "model", "contextTokens"]) assert.ok(Object.hasOwn(item, key));
    if (Object.hasOwn(item, "modelProvider")) assert.ok(item.modelProvider === null || item.modelProvider === "oca501");
    assert.ok(item.model === null || item.model === "gpt-6-luna");
    assert.ok(item.contextTokens === null || Number.isSafeInteger(item.contextTokens) && item.contextTokens > 0);
    if (item.agentRuntime !== undefined) {
      closed(item.agentRuntime, ["id", "cloudPlacementSupported", "devicePlacementSupported", "source"]);
      assert.deepEqual(item.agentRuntime, { id: "auto", cloudPlacementSupported: false, devicePlacementSupported: false, source: "implicit" });
    }
    const thinking = ["off", "minimal", "low", "medium", "high", "xhigh", "ultra"];
    if (item.thinkingDefault !== undefined) assert.ok(thinking.includes(item.thinkingDefault));
    if (item.thinkingOptions !== undefined) assert.ok(Array.isArray(item.thinkingOptions) && item.thinkingOptions.every((id) => thinking.includes(id)));
    if (item.thinkingLevels !== undefined) {
      assert.ok(Array.isArray(item.thinkingLevels));
      for (const entry of item.thinkingLevels) { closed(entry, ["id", "label"]); assert.ok(thinking.includes(entry.id) && entry.label === entry.id); }
    }
    if (item.modelSelectionTarget !== undefined) assert.equal(item.modelSelectionTarget, "session");
    metadata.push({ method, location: minimal ? "sessions.defaults" : "defaults", modelSelection: item.model === null || item.modelProvider === null ? "unknown catalog metadata; no fallback or endpoint proof" : "known fixture model metadata; not transport proof" });
  };
  if (["sessions.list", "chat.history"].includes(method) && Object.hasOwn(copy, "defaults")) { defaults(copy.defaults); delete copy.defaults; }
  if (["health", "status"].includes(method) && copy.sessions && Object.hasOwn(copy.sessions, "defaults")) { defaults(copy.sessions.defaults, true); delete copy.sessions.defaults; }
  if (method === "tools.effective") {
    if (Object.hasOwn(copy, "profile")) { assert.equal(copy.profile, "full"); delete copy.profile; metadata.push({ method, location: "profile", policy: "full" }); }
    if (copy.toolAccess !== undefined) {
      const access = copy.toolAccess; closed(access, ["checked", "profiles", "tools"]); assert.equal(access.checked, "live-session");
      assert.ok(Array.isArray(access.profiles) && Array.isArray(access.tools));
      for (const profile of access.profiles) { closed(profile, ["profile", "source", "active"]); assert.deepEqual(profile, { profile: "full", source: "tools.profile", active: true }); }
      for (const tool of access.tools) {
        closed(tool, ["id", "status", "reasons", "alsoAllowPath"]); assert.ok(typeof tool.id === "string" && tool.id && ["allowed", "excluded", "available", "unavailable"].includes(tool.status));
        if (tool.alsoAllowPath !== undefined) assert.equal(tool.alsoAllowPath, "tools.alsoAllow");
        assert.ok(Array.isArray(tool.reasons));
        for (const reason of tool.reasons) {
          closed(reason, ["kind", "label", "source", "profile"]); assert.ok(["profile", "deny", "allowlist", "session", "runtime"].includes(reason.kind) && typeof reason.label === "string" && reason.label);
          if (reason.source !== undefined) assert.ok(["tools.profile", "tools.allow", "tools.deny", "session.tools"].includes(reason.source));
          if (reason.profile !== undefined) { assert.equal(reason.profile, "full"); assert.equal(reason.kind, "profile"); assert.equal(reason.source, "tools.profile"); }
        }
      }
      // Remaining diagnostic strings still pass the complete-stream inspection.
      copy.toolAccess = { ...access, profiles: access.profiles.map(({ source, active }) => ({ source, active })), tools: access.tools.map((tool) => ({ ...tool, reasons: tool.reasons.map(({ profile: _profile, ...reason }) => reason) })) };
      metadata.push({ method, location: "toolAccess", diagnosticOnly: true });
    }
  }
  return { copy, metadata };
}

// Guard diagnostics carry only source-code constants, never assertion messages
// or rejected payload keys/values. Uninstrumented assertions stay blocked.
const LOG_GUARD_DIAGNOSTIC = Symbol("closed-log-guard-diagnostic");
const logGuard = (condition, code, guardSite, sourceClass = "unknown") => {
  if (condition) return;
  const error = new Error("Host log export validation rejected the stream");
  error[LOG_GUARD_DIAGNOSTIC] = Object.freeze({ code, guardSite, sourceClass, location: { scope: "whole-stream", available: false } });
  throw error;
};
const LOG_PROFILE_KEYS = /(?:["'](?:gateway|auth|token|agents|defaults|bindings|channels|accounts|credentials|models|providers|plugins|entries|config|environment|env|profile|botToken|apiKey|tokenFile|authProfiles)["']\s*:|\b(?:gateway|agents|defaults|bindings|channels|accounts|models|providers|plugins|entries|config|environment|env|profile)\b\s*[:=]\s*[\[{]|\b(?:auth|token|credentials|botToken|apiKey|tokenFile|authProfiles)\b\s*[:=]|\b(?:gateway\.auth|agents\.defaults|models\.providers|plugins\.entries|process\.env)\b\s*[:=])/i;
const LOG_MULTILINE_PROFILE = /(?:^|\n)\s*(?:gateway|auth|agents|defaults|bindings|channels|accounts|credentials|models|providers|plugins|entries|config|environment|env|profile|botToken|apiKey|tokenFile|authProfiles):(?:\s|$)/i;
export function assertSafeHostLog(text, { commandStream = false, rpcMethod } = {}) {
  // Unknown content-bearing JSON blocks export rather than becoming arbitrary
  // data hidden inside a logger wrapper. Required omitted facts remain blocked.
  const profileKeys = LOG_PROFILE_KEYS, multilineProfile = LOG_MULTILINE_PROFILE;
  const diagnosticFields = new Set("component event at sessionId name status lifecycle runtimeState harness hasHarnessSessionId model reasoningEffort hasWorkdir hasResumeSessionId forkSessionRequested hasBackendRef hasStreamInput hasInterrupt hasClose hasPermissionModeSwitch backendRefKind hasBackendConversationId hasBackendRunId nextStatus reason currentStatus messageCount activeAtEnd activeCountBefore kind outcome hasThreadId hasTurnId error errorCode requestKind queued method hasCwd durationMs commandKind argsCount transport timeoutMs requestId pendingCount code signal hasStdin hasStdout hasStderr hasPid channel namespace payloadByteLength tokenHash isAuthorizedSender tokenFound actionKind planDecisionVersion consumptionId consumed version queuedCount runtimeOwner storeRevision instanceId buildId caller hasText textLength permissionMode messageLength pid pendingRequests appServerSubcommand configuredArgCount closing closed errorName exitCode argvCount requestMethod requestedEffort runtimeEffort hasPendingInput hasPlanArtifact revision expectedTurnId hasExpectedTurnId hasPayload stderrLength byteLength requestCount live requestVersion supportedVersion deliveryRef chars idleTimeoutMinutes backendModel requestTimeoutMs recentStderr id accountType runCounter effort rewindTurns what".split(" "));
  const harmlessFields = new Set("subsystem plugin module storeKey enabled kind label path action storePath jobId jobName schedulerNextWakeAtMs timerArmed cronEnabled nextRunAtMs pid threadId isMainThread diagnosticEpoch omittedObservations operationId operation operationTraceId operationSpanId elapsedMs completionDelayMs mutationQueueWaitMs lifecycleQueueWaitMs phaseDurationsMs signalAborted reclamationKind workerThreadId outcome reason opsServed ageMs platform arch node v8 uv openssl sqlite".split(" "));
  const scalar = (value) => value == null || ["string", "number", "boolean"].includes(typeof value);
  const phaseMap = (data) => {
    logGuard(data && !Array.isArray(data) && typeof data === "object" && Object.keys(data).length <= 32, "INVALID_PHASE_MAP", "timing-map-shape");
    for (const [phase, duration] of Object.entries(data)) {
      const names = [phase, ...phase.replace(/([a-z0-9])([A-Z])/g, "$1.$2").split(/[._-]/)];
      logGuard(/^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(phase), "INVALID_PHASE_MAP", "timing-map-key-syntax");
      logGuard(names.every((name) => !profileKeys.test(JSON.stringify(name) + ":")), "PROHIBITED_PROFILE_AUTH", "timing-map-key");
      logGuard(typeof duration === "number" && Number.isFinite(duration) && duration >= 0, "INVALID_PHASE_MAP", "timing-map-value");
    }
  };
  let inspectionDepth = 0;
  const inspect = (value) => {
    logGuard(++inspectionDepth <= 32, "PARSER_BOUND", "recursive-inspection-bound");
    try {
    if (typeof value === "string") {
      logGuard(!profileKeys.test(value) && !multilineProfile.test(value), "PROHIBITED_PROFILE_AUTH", "string-profile-auth");
      let parsed; try { parsed = JSON.parse(value); } catch {
        // A plain log prefix can precede a genuine JSON string literal. Parse
        // each complete literal with JSON.parse, then apply the same closed
        // inspection to its actual decoded value. Malformed quoted structures
        // are blocked rather than permissively unescaped or repaired.
        const literalRanges = [];
        for (let index = 0; index < value.length; index++) {
          if (value[index] !== '"' || value[index - 1] === "\\") continue;
          const begin = index; let escaped = false, closed = false;
          for (++index; index < value.length; index++) {
            const char = value[index];
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') { closed = true; break; }
          }
          const literal = value.slice(begin, closed ? index + 1 : value.length);
          if (!closed) { logGuard(!/\\|[{}\[]/.test(literal), "MALFORMED_EMBEDDED_CONTENT", "unclosed-quoted-structure"); break; }
          let decoded; try { decoded = JSON.parse(literal); } catch { logGuard(false, "MALFORMED_EMBEDDED_CONTENT", "quoted-literal-parser"); }
          inspect(decoded); literalRanges.push([begin, index + 1]);
        }
        let previousEnd = 0; const unparsed = [];
        for (const [begin, end] of literalRanges) { unparsed.push(value.slice(previousEnd, begin)); previousEnd = end; }
        unparsed.push(value.slice(previousEnd));
        logGuard(!/[{\[]\s*\\+["'{\[]|\\(?:"|u[0-9a-f]{0,4})/i.test(unparsed.join(" ")), "MALFORMED_EMBEDDED_CONTENT", "unparsed-escaped-structure");
        // Inspect every embedded JSON payload, including multiple bounded
        // worker-memory metadata arrays embedded in one genuine diagnostic.
        const starts = /\{\s*["']|\[\s*\{/g; let match;
        while ((match = starts.exec(value))) {
          const begin = match.index; let depth = 0, quoted = false, escaped = false, end = begin;
          for (; end < value.length; end++) {
            const char = value[end];
            if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
            else if (char === '"') quoted = true;
            else if (char === "{" || char === "[") depth++;
            else if (char === "}" || char === "]") { if (--depth === 0) { end++; break; } }
          }
          logGuard(depth === 0, "MALFORMED_EMBEDDED_CONTENT", "embedded-container-closure");
          let embedded; try { embedded = JSON.parse(value.slice(begin, end)); } catch { logGuard(false, "MALFORMED_EMBEDDED_CONTENT", "embedded-container-parser"); }
          if (!Array.isArray(embedded) && /phaseDurationsMs=$/.test(value.slice(0, begin))) {
            phaseMap(embedded);
          } else if (Array.isArray(embedded)) {
            logGuard(/(?:workerMemoryMissing|workerHeaps)=$/.test(value.slice(0, begin)) && embedded.length <= 64, "UNKNOWN_STRUCTURED_SHAPE", "embedded-worker-array");
            for (const worker of embedded) {
              const allowed = new Set("script threadId reason heapUsed heapTotal external arrayBuffers sampleAgeMs".split(" "));
              assert.ok(worker && !Array.isArray(worker) && Object.keys(worker).every((key) => allowed.has(key)) && typeof worker.script === "string" && /^[A-Za-z0-9_.-]+\.js$/.test(worker.script));
              for (const [key, data] of Object.entries(worker)) {
                if (key === "script") continue;
                if (key === "reason") assert.ok(["pending", "unavailable", "timeout", "error"].includes(data));
                else assert.ok(Number.isSafeInteger(data) && data >= 0);
              }
            }
          } else inspect(embedded);
          starts.lastIndex = end;
        }
        return;
      }
      if (parsed && typeof parsed === "object" || typeof parsed === "string" && parsed !== value) inspect(parsed);
    } else if (value && typeof value === "object") {
      if (Array.isArray(value) && commandStream) { value.forEach(inspect); return; }
      logGuard(!Array.isArray(value), "UNKNOWN_STRUCTURED_SHAPE", "structured-array");
      const keys = Object.keys(value);
      logGuard(keys.every((key) => !profileKeys.test(JSON.stringify(key) + ":")), "PROHIBITED_PROFILE_AUTH", "object-profile-auth");
      if (Object.hasOwn(value, "phaseDurationsMs")) phaseMap(value.phaseDurationsMs);
      if (commandStream) { for (const item of Object.values(value)) { if (Array.isArray(item)) item.forEach(inspect); else inspect(item); } }
      else if (keys.length && keys.every((key) => /^\d+$/.test(key))) {
        logGuard(Object.values(value).every(scalar), "UNKNOWN_STRUCTURED_SHAPE", "numeric-logger-payload", "host-logger-envelope"); Object.values(value).forEach(inspect);
      } else if (Object.hasOwn(value, "_meta")) {
        const allowed = /^(?:\d+|_meta|time|hostname|message|traceId|spanId|parentSpanId|traceFlags)$/;
        logGuard(keys.every((key) => allowed.test(key)), "UNKNOWN_STRUCTURED_SHAPE", "logger-envelope-shape", "host-logger-envelope");
        const metaKeys = new Set("runtime runtimeVersion hostname date logLevelId logLevelName name parentNames path".split(" "));
        logGuard(value._meta && Object.keys(value._meta).every((key) => metaKeys.has(key)), "INVALID_CLOSED_METADATA", "logger-metadata-shape", "host-logger-envelope");
        for (const [key, item] of Object.entries(value)) {
          if (key === "_meta") {
            for (const [field, data] of Object.entries(item)) {
              if (field === "parentNames") { assert.ok(Array.isArray(data) && data.every(scalar)); data.forEach(inspect); }
              else if (field === "path" && data && typeof data === "object") {
                assert.ok(Object.keys(data).every((part) => ["fullFilePath", "fileName", "fileNameWithLine", "method", "fileLine", "fileColumn", "filePath", "filePathWithLine"].includes(part)) && Object.values(data).every(scalar)); Object.values(data).forEach(inspect);
              } else { logGuard(scalar(data), "INVALID_CLOSED_METADATA", "logger-metadata-value", "host-logger-envelope"); inspect(data); }
            }
          } else inspect(item);
        }
      } else if ((typeof value.component === "string" && ["Session", "SessionRuntimeRegistry", "CodexHarness", "CodexAppServerRpc"].includes(value.component)) || (typeof value.event === "string" && /^callback_/.test(value.event))) {
        logGuard(keys.every((key) => diagnosticFields.has(key)) && Object.values(value).every(scalar), "UNKNOWN_STRUCTURED_SHAPE", "native-diagnostic-shape", "known-oca-diagnostic"); Object.values(value).forEach(inspect);
      } else if (keys.toSorted().join(",") === "compute,workerCount,workerLifecycle") {
        const count = (number) => Number.isSafeInteger(number) && number >= 0;
        assert.ok(count(value.workerCount) && Array.isArray(value.workerLifecycle) && value.workerLifecycle.length <= 32);
        for (const worker of value.workerLifecycle) {
          assert.deepEqual(Object.keys(worker).toSorted(), ["retired", "script", "started"]);
          assert.ok(["other", "sqlite-store.worker.js", "openclaw-state-lease-heartbeat.worker.js", "openclaw-state-read.worker.js"].includes(worker.script) && count(worker.started) && Array.isArray(worker.retired));
          assert.ok(worker.retired.length <= 32 && worker.retired.every((entry) => Object.keys(entry).toSorted().join(",") === "count,reason" && ["exit", "idle", "error", "shutdown"].includes(entry.reason) && count(entry.count)));
        }
        assert.deepEqual(Object.keys(value.compute).toSorted(), ["active", "limit", "pendingBytes", "pendingTasks", "waitingPools"]); assert.ok(Object.values(value.compute).every(count));
      } else {
        logGuard(keys.length && keys.every((key) => harmlessFields.has(key)), "UNKNOWN_STRUCTURED_SHAPE", "metadata-object-shape");
        for (const [key, data] of Object.entries(value)) {
          if (key === "phaseDurationsMs") {
            phaseMap(data);
          } else { logGuard(scalar(data), "INVALID_CLOSED_METADATA", "metadata-object-value"); inspect(data); }
        }
      }
    }
    } finally { inspectionDepth--; }
  };
  let complete; try { complete = JSON.parse(text); } catch { /* JSONL/plain streams are checked record by record. */ }
  if (complete && typeof complete === "object") {
    const checked = commandStream && rpcMethod ? commandMetadataInspection(complete, rpcMethod) : { copy: complete, metadata: [] };
    inspect(checked.copy); return checked.metadata;
  }
  logGuard(!profileKeys.test(text) && !multilineProfile.test(text), "PROHIBITED_PROFILE_AUTH", "whole-stream-profile-auth");
  for (const line of text.split("\n")) inspect(line);
  return [];
}
function assessHostLog(text, options) {
  try { return { safe: true, commandMetadata: assertSafeHostLog(text, options) }; }
  catch (error) { return { safe: false, failureDiagnostic: error?.[LOG_GUARD_DIAGNOSTIC] ?? { code: "UNKNOWN_GUARD_FAILURE", guardSite: "unclassified-validation", sourceClass: options?.commandStream ? "command-response" : "unknown", location: { scope: "whole-stream", available: false } } }; }
}
const LOG_RULE_NAMES = "gateway auth token agents defaults bindings channels accounts credentials models providers plugins entries config environment env profile botToken apiKey tokenFile authProfiles gateway.auth agents.defaults models.providers plugins.entries process.env".split(" ");
const LOG_SEVERITIES = ["SILLY", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"];
function diagnosticEnvelope(text) {
  const unknown = { envelope: "PLAIN_TEXT_OR_UNKNOWN", severity: "UNKNOWN_SEVERITY", header: "UNKNOWN_ENVELOPE" };
  let record; try { record = JSON.parse(text); } catch { return unknown; }
  if (!record || typeof record !== "object" || Array.isArray(record) || !record._meta) return unknown;
  const outer = /^(?:\d+|_meta|time|hostname|message|traceId|spanId|parentSpanId|traceFlags)$/;
  const scalar = (v) => v == null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v);
  const meta = record._meta, metaKeys = new Set("runtime runtimeVersion hostname date logLevelId logLevelName name parentNames path".split(" "));
  if (!Object.keys(record).every((key) => outer.test(key)) || typeof meta !== "object" || Array.isArray(meta) || !Object.keys(meta).every((key) => metaKeys.has(key))) return unknown;
  for (const [key, value] of Object.entries(meta)) {
    if (key === "parentNames") { if (!Array.isArray(value) || !value.every(scalar)) return unknown; }
    else if (key === "path" && value && typeof value === "object") {
      if (Array.isArray(value) || !Object.keys(value).every((part) => ["fullFilePath", "fileName", "fileNameWithLine", "method", "fileLine", "fileColumn", "filePath", "filePathWithLine"].includes(part)) || !Object.values(value).every(scalar)) return unknown;
    } else if (!scalar(value)) return unknown;
  }
  if (!Object.entries(record).every(([key, value]) => key === "_meta" || /^\d+$/.test(key) || scalar(value))) return unknown;
  const payloads = Object.entries(record).filter(([key]) => /^\d+$/.test(key)).map(([, value]) => value);
  const envelope = payloads.length && payloads.every((value) => typeof value === "string") ? "PINNED_LOGGER_STRING_PAYLOADS" : payloads.some((value) => value && typeof value === "object" && !Array.isArray(value)) ? "PINNED_LOGGER_OBJECT_PAYLOAD" : "PINNED_LOGGER_OTHER_PAYLOAD";
  const severity = Number.isInteger(meta.logLevelId) && meta.logLevelId >= 0 && meta.logLevelId <= 6 && meta.logLevelName === LOG_SEVERITIES[meta.logLevelId] ? meta.logLevelName : "UNKNOWN_SEVERITY";
  return { envelope, severity, header: "PINNED_OUTER_HEADER" };
}
// Rejection-only observation. This never supplies acceptance or exports text.
export function rejectedHostLogDiagnostic(input, options, validatedProjectionRecords = new Set(), blockedProjectionRecords = new Set()) {
  const raw = Buffer.isBuffer(input), bytes = raw ? input : Buffer.from(input), original = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const inputIdentityDomain = raw ? "original captured stream bytes" : "captured text UTF8 encoding; original undecoded byte validity unavailable";
  const fallback = (status) => ({ diagnosticStatus: status, original, inputIdentityDomain, rawContentExcluded: true, inspectionComplete: false, inspectedLines: 0, uninspectedLines: "NOT_COUNTED", lexicalCountScope: "NOT_COUNTED" });
  if (bytes.length > 4 * 1024 * 1024) return fallback("DIAGNOSTIC_BOUND_EXCEEDED");
  const text = bytes.toString("utf8"); if (!Buffer.from(text).equals(bytes)) return fallback("DIAGNOSTIC_INVALID_UTF8");
  try {
    const whole = assessHostLog(text, options); if (whole.safe) return { diagnosticStatus: "NOT_REJECTED", original };
    const lines = []; let start = 0, capturedLines = 1;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) { if (lines.length < 10000) lines.push({ start, end: i + 1, lf: true }); start = i + 1; capturedLines++; }
    if (capturedLines > 10000) return { ...fallback("DIAGNOSTIC_BOUND_EXCEEDED"), capturedLines, uninspectedLines: capturedLines };
    lines.push({ start, end: bytes.length, lf: false });
    const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
    const span = (begin, end) => ({ byteStart: begin, byteEndExclusive: end, bytes: end - begin, sha256: digest(bytes.subarray(begin, end)) });
    const failedDetails = [], pendingDetails = [], failureIdentities = [], histogram = {}; let failed = 0, projectionOnlyFailed = 0;
    for (const [index, line] of lines.entries()) {
      const body = bytes.subarray(line.start, line.lf ? line.end - 1 : line.end).toString("utf8"), assessed = assessHostLog(body, options);
      if (!assessed.safe || blockedProjectionRecords.has(index)) {
        if (!assessed.safe) failed++; else projectionOnlyFailed++;
        failureIdentities.push({ line: index, ...span(line.start, line.end), originalLineGuardSafe: assessed.safe, sourceProjectorBlocked: blockedProjectionRecords.has(index) });
        const envelope = diagnosticEnvelope(body), d = assessed.safe ? { originalLineGuardSafe: true, projectionDisposition: "UNVALIDATED_RECORD" } : assessed.failureDiagnostic;
        const key = assessed.safe ? `UNCHANGED_LINE_GUARD_SAFE/SOURCE_PROJECTOR_BLOCKED/${envelope.envelope}/${envelope.severity}` : `${d.code}/${d.guardSite}/${d.sourceClass}/${envelope.envelope}/${envelope.severity}`; histogram[key] = (histogram[key] ?? 0) + 1;
        pendingDetails.push({ line: index, ...span(line.start, line.end), includesLF: line.lf, trailingEmpty: line.start === bytes.length, unterminated: !line.lf && line.start < bytes.length, ...d, ...envelope });
      }
    }
    const selectedDetails = pendingDetails.length > 64 ? pendingDetails.toSorted((x, y) => Number(blockedProjectionRecords.has(y.line)) - Number(blockedProjectionRecords.has(x.line)) || x.line - y.line).slice(0, 64) : pendingDetails;
    for (const detail of selectedDetails) {
      const line = lines[detail.line], body = bytes.subarray(line.start, line.lf ? line.end - 1 : line.end).toString("utf8");
      failedDetails.push({ ...detail, ...(validatedProjectionRecords.has(detail.line) ? { sourceObservation: { status: "VALIDATED_SOURCE_PROJECTION; see complete record audit" } } : { sourceObservation: sourceLogObservation(body, (value) => assessHostLog(value, options)) }) });
    }
    const lexicalDetails = []; let lexicalMatches = 0, lexicalCapped = false;
    for (const [pattern, sourceRule] of [[LOG_PROFILE_KEYS, "profileKeys"], [LOG_MULTILINE_PROFILE, "multilineProfile"]]) {
      const regex = new RegExp(pattern.source, "gi"); let match;
      while ((match = regex.exec(text))) {
        if (lexicalMatches === 10000) { lexicalCapped = true; break; } lexicalMatches++;
        if (lexicalDetails.length >= 64) continue;
        const raw = match[0], trimmed = raw.trim(); let name, context;
        if (sourceRule === "multilineProfile") { name = trimmed.match(/^([A-Za-z]+):/)?.[1]; context = "line-property-like"; }
        else if (/^["']/.test(trimmed)) { name = trimmed.match(/^["']([A-Za-z]+)["']/)?.[1]; context = "quoted-property-like"; }
        else { name = trimmed.match(/^([A-Za-z]+(?:\.[A-Za-z]+)?)/)?.[1]; context = name?.includes(".") ? "dotted-assignment-like" : /[\[{]$/.test(trimmed) ? "assignment-object-like" : "auth-assignment-like"; }
        const rule = LOG_RULE_NAMES.find((known) => known.toLowerCase() === name?.toLowerCase()) ?? "UNKNOWN_RULE";
        const begin = Buffer.byteLength(text.slice(0, match.index)), end = begin + Buffer.byteLength(raw);
        let lineIndex = lines.findIndex((line) => begin < line.end); if (lineIndex < 0) lineIndex = lines.length - 1;
        const line = lines[lineIndex]; lexicalDetails.push({ rule, context, pattern: sourceRule, interpretation: "LEXICAL_SOURCE_GUARD_RULE; no actual field or producer inference", ...span(begin, end), crossesLineBoundary: end > line.end, containingLine: { line: lineIndex, scope: "match-start captured record", ...span(line.start, line.end) } });
      }
      if (lexicalCapped) break;
    }
    const payload = { diagnosticStatus: "REJECTED_STREAM_OBSERVED", sourceTableSha256: LOG_SOURCE_TABLE_SHA256, original, inputIdentityDomain, rawContentExcluded: true, inspectionComplete: !lexicalCapped, capturedLines: lines.length, inspectedLines: lines.length, uninspectedLines: 0, failedLines: failed, safeLines: lines.length - failed, omittedFailedLineDetails: failed - failedDetails.filter((detail) => !detail.originalLineGuardSafe).length, projectionBlockedGuardSafeLines: projectionOnlyFailed, omittedProjectionOnlyDetails: projectionOnlyFailed - failedDetails.filter((detail) => detail.originalLineGuardSafe).length, failureHistogram: histogram, failedLineDetails: failedDetails, wholeFailure: whole.failureDiagnostic, crossingLineUnresolved: failed === 0, lexicalMatches, lexicalScanCapped: lexicalCapped, lexicalOmittedDetails: lexicalMatches - lexicalDetails.length, lexicalCountScope: lexicalCapped ? "lower bound; scan incomplete" : "all original regex matches", lexicalDetails, acceptanceEvidence: false };
    const result = { ...payload, projectedDiagnosticSha256: digest(Buffer.from(JSON.stringify(payload))), projectedDigestScope: "Closed diagnostic payload; not original stream" };
    result[HOST_DIAGNOSTIC_IDENTITIES] = { identities: failureIdentities.toSorted((x, y) => x.line - y.line), sourceBlockedIndices: [...blockedProjectionRecords].toSorted((x, y) => x - y) };
    const bounded = presentHostLogDiagnostic(result, (value) => JSON.stringify(value));
    if (bounded !== result) bounded[HOST_DIAGNOSTIC_IDENTITIES] = result[HOST_DIAGNOSTIC_IDENTITIES];
    return bounded;
  } catch { return fallback("DIAGNOSTIC_UNKNOWN_FAILURE"); }
}
export function hostLogEvidence(input, options) {
  const raw = Buffer.isBuffer(input), bytes = raw ? input : Buffer.from(input), text = raw ? bytes.toString("utf8") : input;
  const original = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), identityDomain: raw ? "original captured stream bytes" : "captured text UTF8 encoding; original undecoded byte validity unavailable" };
  const assessment = raw && !Buffer.from(text).equals(bytes) ? { safe: false, failureDiagnostic: { code: "UNKNOWN_GUARD_FAILURE", guardSite: "captured-source-utf8-identity", sourceClass: "unknown", location: { scope: "whole-stream", available: false } } } : assessHostLog(text, options);
  if (assessment.safe) { const commandMetadata = assessment.commandMetadata; return { completeStreamSafe: true, original, ...(commandMetadata.length ? { commandMetadata } : {}) }; }
  {
    const sourceProjection = options?.sourceAuthority ? projectHostLog(input, options.sourceAuthority, (value) => assessHostLog(value)) : undefined;
    if (sourceProjection?.outcome === "SOURCE_PROJECTED_COMPLETE") return { completeStreamSafe: false, sourceProjectedComplete: true, projection: true, original, rawCompleteStreamExcluded: true, rawGuardFailureDiagnostic: assessment.failureDiagnostic, ...sourceProjection };
    const failureDiagnostic = assessment.failureDiagnostic;
    const payload = { completeStreamSafe: false, projection: true, original, rawCompleteStreamExcluded: true, failureDiagnostic, rejectedStreamDiagnostic: rejectedHostLogDiagnostic(raw ? bytes : text, options, new Set(sourceProjection?.observations?.projectedRecordIndices ?? []), new Set(sourceProjection?.observations?.blockedRecordIndices ?? [])),
      excludedRecordRange: { first: 0, last: text.split("\n").length - 1, numbering: "zero-based captured stream lines; entire stream excluded" },
      ...(sourceProjection ? { sourceProjectionAttempt: sourceProjection } : {}), exclusionReason: "Unsafe or unknown structured profile/auth/content-bearing log; omitted lifecycle/error facts remain BLOCKED" };
    return { ...payload, projectedPayloadSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), projectedDigestScope: "Closed projection payload before digest/source wrapper; not the original stream" };
  }
}

export function assertCompletionTerminal(result, retainedRunId, routedReply) {
  assert.equal(typeof routedReply, "boolean", "Actual completion routing mode must be explicit");
  assert.equal(result.runId, retainedRunId, "Actual terminal belongs to the exact retained completion run");
  assert.equal(result.status, "ok", "Actual completion parent run succeeded");
  if (routedReply) {
    assert.equal(result.terminalReceipt?.runId, retainedRunId, "Actual source delivery receipt belongs to the retained run");
    assert.equal(result.terminalReceipt.sourceReplyDelivered, true, "Actual routed completion reply reached its source");
  } else {
    for (const yielded of [result.yielded, result.terminalReply?.yielded]) {
      assert.ok(yielded === undefined || typeof yielded === "boolean", "Actual yielded disposition is boolean when present");
      assert.notEqual(yielded, true, "A yielded parent run is not a completed visible reply");
    }
    assert.equal(result.terminalReply?.disposition, "visible", "Actual internal completion reply is visible");
    assert.equal(typeof result.terminalReply.text, "string");
    assert.ok(result.terminalReply.text.trim(), "Actual internal completion reply is nonempty");
    assert.doesNotMatch(result.terminalReply.text.trim(), /^NO_REPLY$/i, "A silent marker is not a visible completion summary");
  }
}
export function assertVisibleCanonical(terminal, runId, responseId, canonical, expectedText) {
  assertCompletionTerminal(terminal, runId, false);
  assert.equal(canonical?.role, "assistant"); assert.equal(canonical.responseId, responseId); assert.equal(canonical.__openclaw?.runId, runId);
  assert.notEqual(canonical.__openclaw.truncated, true);
  assert.equal(messageText(canonical).trim(), terminal.terminalReply.text.trim()); assert.equal(terminal.terminalReply.text.trim(), expectedText.trim());
}
export function revisionInstruction(name, sessionId, version) {
  assert.ok(typeof name === "string" && name && typeof sessionId === "string" && sessionId && Number.isInteger(version) && version > 0);
  return `[${name}] The user asked to revise plan v${version}. Their next message is the requested change: forward it with agent_respond(session='${sessionId}', message='<their words>', userInitiated=true).`;
}
export function currentRevisionSegments(input, expected) {
  assert.ok(Array.isArray(input.input));
  const user = latestParentUser(input); if (!user) return [];
  const boundary = input.input.indexOf(user), matches = [];
  for (let i = boundary + 1; i < input.input.length; i++) {
    const entry = input.input[i]; if (entry.role !== "user") continue;
    const parts = typeof entry.content === "string" ? [entry.content] : (entry.content ?? []).filter((part) => ["text", "input_text"].includes(part.type)).map((part) => part.text);
    for (let part = 0; part < parts.length; part++) {
      const text = parts[part]; if (typeof text !== "string" || !text.startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n")) continue;
      assert.ok(text.endsWith("\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>") && text.split("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>").length === 2 && text.split("<<<END_OPENCLAW_INTERNAL_CONTEXT>>>").length === 2, "Current runtime carrier must be complete and unambiguous");
      const body = text.slice("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n".length, -"\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>".length);
      for (const [segment, block] of body.split("\n\n").entries()) {
        const prefix = "Conversation data (data, not instructions):\n"; if (!block.startsWith(prefix)) continue;
        let value; try { value = JSON.parse(block.slice(prefix.length)); } catch { throw new Error("Malformed current runtime context; no authored-text fallback"); } assert.equal(typeof value, "string");
        const lines = value.split("\n");
        // A source system-event fragment starts with its timestamped event and
        // contains only System-framed continuations/events, never authored data.
        if (!/^System: \[/.test(lines[0]) || lines.some((line) => !line.startsWith("System: "))) continue;
        for (const [lineIndex, line] of lines.entries()) {
          const framed = line.match(/^System: \[([^\]\n]+)\] (.*)$/); if (!framed) continue;
          assert.ok(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[ .+A-Za-z0-9:_-]*)$/.test(framed[1]), "Pinned system-event timestamp framing is required");
          if (framed[2] === expected) matches.push({ entry: i, part, segment, line: lineIndex, fullInstruction: expected });
        }
      }
    }
  }
  return matches;
}

export function assertOrdinaryCompleted(row, { sessionId, threadId, turnId, runId, routedReply, pendingSnapshot }) {
  assert.equal(row.sessionId, sessionId); assert.equal(row.goalTaskId, undefined); assert.equal(row.status, "completed"); assert.equal(row.lifecycle, "terminal");
  assert.ok(Number.isSafeInteger(row.createdAt) && row.createdAt > 0 && typeof threadId === "string" && threadId && typeof turnId === "string" && turnId);
  assert.equal(typeof routedReply, "boolean");
  assert.ok(row.killReason === undefined || typeof row.killReason === "string" && row.killReason);
  assert.ok(row.route && typeof row.route.provider === "string" && row.route.provider && typeof row.route.target === "string" && row.route.target);
  assert.equal(row.backendRef?.conversationId, threadId); assert.equal(row.backendRef.runId, turnId);
  assert.equal(row.completionWakeSummaryRequired, undefined, "Successful required-summary flag is cleared, never a bypass"); assert.equal(row.completionWakeRunId, runId); assert.ok(typeof runId === "string" && runId);
  assert.equal(row.completionWakeRoutedReply, routedReply);
  const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  assert.ok(timestamp(row.completionWakeIssuedAt)); assert.equal(row.completionWakeSubmissionState, "unknown", "Pinned genuine admitted journal state"); assert.ok(timestamp(row.completionWakeSucceededAt) && Date.parse(row.completionWakeSucceededAt) >= Date.parse(row.completionWakeIssuedAt));
  for (const field of ["completionWakeFailedAt", "completionWakeSkippedAt", "completionWakeSkipReason"]) assert.ok(!row[field], "Required ordinary summary cannot fail or skip");
  const outcome = row.completionWakeOutcomeKey, prefix = `terminal:${sessionId}:${row.status}:${row.createdAt}:${threadId}:`, suffix = `:${row.killReason ?? "unknown"}`;
  assert.ok(typeof outcome === "string" && outcome.startsWith(prefix) && outcome.endsWith(suffix), "Whole current terminal cycle matches actual available original facts");
  const counter = outcome.slice(prefix.length, -suffix.length); assert.match(counter, /^(?:0|[1-9]\d*)$/, "Counter is actual emitted canonical cycle text, never invented");
  const cycle = outcome.slice(`terminal:${sessionId}:`.length);
  assert.equal(row.completionWakeSummaryFact?.required, true); assert.equal(row.completionWakeSummaryFact.producer, "terminal"); assert.equal(row.completionWakeSummaryFact.outcomeKey, outcome);
  const scope = { provider: row.route.provider, accountId: row.route.accountId, target: row.route.target, threadId: row.route.threadId };
  const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  const notificationKey = `notification:${digest(JSON.stringify({ scope, semanticKey: `terminal-completed:${sessionId}:${cycle}` }))}`;
  assert.equal(row.notificationDedupe?.filter((record) => record.key === notificationKey && record.label === "completed" && record.status === "delivered").length, 1, "Exact current canonical terminal notification delivered");
  const summaryKey = `route:${digest(JSON.stringify(scope))}:outcome:${digest(outcome)}`;
  assert.ok(row.completionSummaryDedupe?.some((record) => (record.key === summaryKey || record.linkedKeys?.includes(summaryKey)) && record.recordedAt), "Actual completion-summary dedupe uses the exact source-backed outcome mapping");
  assert.equal(row.deliveryState, "idle", "Successful ordinary completion has no failed or pending delivery");
  assert.ok(!row.notificationDedupe.some((record) => record.status === "in_flight"));
  let obligationObservation = "retained required admission fact; pending-flag transition not sampled";
  if (pendingSnapshot?.completionWakeSummaryRequired === true) {
    assert.equal(pendingSnapshot.sessionId, sessionId); assert.equal(pendingSnapshot.completionWakeRunId, runId); assert.equal(pendingSnapshot.completionWakeOutcomeKey, outcome);
    assert.deepEqual(pendingSnapshot.completionWakeSummaryFact, row.completionWakeSummaryFact);
    obligationObservation = "actual pending required flag and same admitted fact/run/outcome observed before cleared success";
  }
  return { outcome, cycle, notificationKey, summaryKey, obligationObservation };
}

export function ordinaryNativeCompletion({ row, fixture, requests, diagnostics, reviewReadback, publicView }) {
  assert.equal(publicView?.sessionId, row.sessionId); assert.equal(publicView.name, row.name);
  assert.ok(publicView.terminalListing === true || publicView.status === "running" && publicView.recovered === false);
  assert.equal(fixture.ordinary, true); assert.equal(fixture.sessionId, row.sessionId); assert.equal(row.goalTaskId, undefined);
  const kind = fixture.operation ?? "user"; assert.ok(["user", "compact", "review"].includes(kind));
  const boundary = kind === "user" ? fixture.admissionRequestBoundary : fixture.operationRequestBoundary;
  assert.ok(Number.isSafeInteger(boundary) && boundary >= 0);
  if (kind !== "user") {
    assert.equal(fixture.operationAdmission?.status, 200); assert.equal(fixture.operationAdmission.output?.ok, true);
    assert.notEqual(fixture.operationAdmission.output.result?.isError, true); assert.doesNotMatch(messageText({ content: fixture.operationAdmission.output.result?.content ?? [] }), /^Error:/m); assert.ok(typeof fixture.operationStartedAt === "string" && fixture.operationStartedAt);
  }
  const current = requests.findLast((request) => request.transport === "native-codex" && request.case === fixture.tag && request.requestIndex > boundary && request.responseCompleted && request.emittedType === "message" && (kind === "user" || request.receivedAt >= fixture.operationStartedAt));
  assert.ok(current, "Actual current admitted ordinary operation has a complete model response");
  let threadId = current.nativeIdentity?.thread_id, turnId = current.nativeIdentity?.turn_id;
  if (kind === "review") {
    const relation = current.actualReviewRelation; assert.ok(relation && reviewReadback?.nativeReviewCompleted === true);
    assert.equal(relation.originalThreadId, row.backendRef?.conversationId);
    assert.equal(relation.childThreadId, threadId); assert.equal(relation.childTurnId, turnId); assert.notEqual(threadId, relation.originalThreadId);
    assert.equal(relation.instructions, fixture.reviewInstructions); assert.equal(reviewReadback.originalThreadId, relation.originalThreadId); assert.equal(reviewReadback.originalTurnId, relation.originalTurnId);
    assert.deepEqual(reviewReadback.actualOutput, fixture.reviewOutput); assert.equal(current.emittedText, JSON.stringify(fixture.reviewOutput));
    threadId = relation.originalThreadId; turnId = relation.originalTurnId;
  }
  assert.equal(threadId, row.backendRef?.conversationId);
  if (publicView.terminalListing) { assert.equal(row.status, "completed"); assert.equal(row.lifecycle, "terminal"); assert.equal(turnId, row.backendRef?.runId); }
  assert.ok(typeof threadId === "string" && threadId && typeof turnId === "string" && turnId);
  const terminal = diagnostics.findLast((event) => event.event === "turn.terminal" && event.hasThreadId === true && event.hasTurnId === true && event.outcome === "completed" && event.kind === kind && event.at >= current.receivedAt);
  assert.ok(terminal, "Actual successful corresponding native-kind terminal corroborates serialized operation");
  return { nativeCompleted: true, caseTag: fixture.tag, threadId, turnId, publicView, rawRecoveryIdentity: { sessionId: row.sessionId, backendRef: structuredClone(row.backendRef) }, operation: kind, actualNativeRequest: structuredClone(current), request: current.requestIndex, terminalDiagnostic: terminal, ...(kind === "review" ? { actualReviewRelation: current.actualReviewRelation, originalNativeReadback: reviewReadback } : {}) };
}

export function selectOrdinaryCompletion(input, owners) {
  const latest = latestParentUser(input); if (!latest || !input.tools?.length) return;
  const wake = messageText(latest), firstLine = wake.split("\n")[0].replace(/^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\] /, "");
  const turnEnded = firstLine === "Coding agent session turn ended.";
  const completed = /^\[[^\]\n]+\] Completed\. ID: [A-Za-z0-9_-]+$/.test(firstLine);
  if (!turnEnded && !completed) return;
  const matching = owners.filter(({ row }) => turnEnded ? wake.split("\n")[1] === `Name: ${row.name}` && wake.split("\n")[2] === `ID: ${row.sessionId}` : firstLine === `[${row.name}] Completed. ID: ${row.sessionId}`);
  assert.equal(matching.length, 1, "One genuinely registered ordinary session owns this wake");
  const owner = matching[0], { row, completion, publicView } = owner;
  assert.equal(publicView?.sessionId, row.sessionId); assert.equal(publicView.name, row.name);
  assert.equal(row.goalTaskId, undefined, "Goal-owned sessions cannot use ordinary source dispatch");
  assert.equal(owner.fixture.ordinary, true); assert.equal(owner.fixture.sessionId, row.sessionId);
  assert.ok(completion && completion.nativeCompleted === true, "Actual native completion is required before ordinary source send");
  assert.equal(completion.threadId, row.backendRef?.conversationId);
  assert.ok(typeof completion.turnId === "string" && completion.turnId);
  assert.equal(completion.caseTag, owner.fixture.tag);
  const actual = completion.actualNativeRequest; assert.ok(actual?.responseCompleted && actual.emittedType === "message"); assert.equal(actual.case, owner.fixture.tag); assert.equal(actual.requestIndex, completion.request);
  if (completion.operation === "review") {
    assert.equal(completion.originalNativeReadback?.nativeReviewCompleted, true); assert.equal(completion.threadId, completion.originalNativeReadback.originalThreadId); assert.equal(completion.turnId, completion.originalNativeReadback.originalTurnId);
    assert.equal(actual.actualReviewRelation?.originalThreadId, completion.threadId); assert.equal(actual.actualReviewRelation.originalTurnId, completion.turnId);
  } else { assert.ok(["user", "compact"].includes(completion.operation)); assert.equal(actual.nativeIdentity?.thread_id, completion.threadId); assert.equal(actual.nativeIdentity?.turn_id, completion.turnId); }
  if (turnEnded) {
    assert.equal(publicView.status, "running"); assert.equal(publicView.recovered, false); assert.ok(["awaiting_user_input", "running"].includes(publicView.phase));
    assert.equal(wake.split("\n")[3], `Status: ${publicView.status}`); assert.equal(wake.split("\n")[4], `Lifecycle: ${publicView.lifecycle}`);
  } else { assert.equal(publicView.terminalListing, true); assert.equal(publicView.phaseLabel, "completed"); assert.equal(row.status, "completed"); assert.equal(row.lifecycle, "terminal"); assert.equal(completion.turnId, row.backendRef?.runId); }
  const routes = wake.split("\n").filter((line) => line.startsWith("originRoute: ")); assert.equal(routes.length, 1);
  const route = JSON.parse(routes[0].slice(13));
  assert.ok(row.route && Object.keys(row.route).every((key) => ["provider", "target", "accountId", "sessionKey"].includes(key)), "No unobserved ordinary stored destination/thread");
  const storedRoute = { provider: row.route?.provider, target: row.route?.target, ...(row.route && Object.hasOwn(row.route, "accountId") ? { accountId: row.route.accountId } : {}) };
  assert.deepEqual(route, storedRoute); assert.ok(["telegram", "webchat"].includes(route.provider), "Only originally admitted ordinary routes are supported");
  if (route.provider === "telegram") assert.equal(route.target, "501002");
  else { assert.equal(route.target, owner.fixture.originSessionKey); assert.ok(typeof owner.fixture.originSessionKey === "string" && owner.fixture.originSessionKey); assert.equal(Object.hasOwn(route, "accountId"), false); }
  assert.deepEqual(Object.keys(route).toSorted(), (Object.hasOwn(route, "accountId") ? ["accountId", "provider", "target"] : ["provider", "target"]).toSorted());
  if (Object.hasOwn(route, "accountId")) assert.equal(route.accountId, "default");
  if (route.provider === "telegram") assert.ok(wake.includes("use message(action='send', final=true) to originRoute"));
  else assert.ok(wake.includes("Reply with an ordinary visible final answer in this WebChat session. Do not use the message tool to send this update."));
  const cycle = `${row.sessionId}/${completion.turnId}/${turnEnded ? "turn-ended" : "completed"}`;
  return { ordinary: row, owner, completion, publicView, cycle, route, wake, index: input.input.indexOf(latest) };
}
