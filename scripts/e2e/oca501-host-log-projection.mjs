// Export-only projections of three pinned logger producers. Original guard,
// runtime records and acceptance readers are never changed by this module.
import { createHash } from "node:crypto";

const PIN = "c074824a27c96d3983043f9eeb33823cd1772d8c";
const LIMIT = 4 * 1024 * 1024;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const levels = ["SILLY", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"];
const own = (value, key) => Object.hasOwn(value, key);
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const refuse = () => { throw new Error("SOURCE_LOG_PROJECTION_UNVALIDATED"); };
const check = (test) => { if (!test) refuse(); };
const clone = (value) => JSON.parse(JSON.stringify(value));

// Literal pinned summarizeResponsesPayload algorithm, narrowed to the owned
// fixture's actual non-compacting Responses requests. This produces INTERNAL
// comparison text only; a source match exports no message/tail values.
export function renderResponsesStart({ body, bodySha256, provider, model, baseUrl, requestId, timeoutMs, presence, allowedToolNames = ["tool_call", "tool_describe", "tool_search", "message"] }) {
  check(object(body) && body.model === model && body.stream === true && provider === "oca501" && model === "gpt-6-luna");
  check(digest(JSON.stringify(body)) === bodySha256 && /^[a-f0-9]{64}$/.test(bodySha256) && ["present", "missing"].includes(presence));
  const endpoint = new URL(baseUrl); check(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1" && endpoint.pathname === "/host/v1" && endpoint.port && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
  check(Object.keys(body).every((key) => ["model", "input", "stream", "max_output_tokens", "tools", "store", "temperature", "reasoning", "text", "service_tier", "prompt_cache_key"].includes(key)));
  check(Array.isArray(allowedToolNames) && allowedToolNames.every((name) => typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)));
  const allowedName = (name) => typeof name === "string" && allowedToolNames.includes(name);
  check(body.store === undefined || typeof body.store === "boolean");
  check(body.max_output_tokens === undefined || Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0);
  check(body.temperature === undefined || typeof body.temperature === "number" && Number.isFinite(body.temperature));
  check(body.prompt_cache_key === undefined || typeof body.prompt_cache_key === "string");
  check(body.service_tier === undefined || ["auto", "default", "flex", "priority"].includes(body.service_tier));
  check(body.reasoning === undefined || object(body.reasoning) && Object.keys(body.reasoning).every((key) => ["effort", "summary"].includes(key)) && (body.reasoning.effort === undefined || ["none", "minimal", "low", "medium", "high", "xhigh"].includes(body.reasoning.effort)) && (body.reasoning.summary === undefined || ["auto", "concise", "detailed"].includes(body.reasoning.summary)));
  check(body.text === undefined || object(body.text) && Object.keys(body.text).every((key) => key === "verbosity") && ["low", "medium", "high"].includes(body.text.verbosity));
  check(body.tools === undefined || Array.isArray(body.tools) && body.tools.every((tool) => object(tool) && Object.keys(tool).every((key) => ["type", "name", "description", "parameters", "strict"].includes(key)) && tool.type === "function" && allowedName(tool.name) && typeof tool.description === "string" && object(tool.parameters) && tool.parameters.type === "object" && (tool.strict === undefined || typeof tool.strict === "boolean")));
  check(Array.isArray(body.input) && body.input.every((item) => {
    if (!object(item) || !["message", "function_call", "function_call_output", "reasoning", "item_reference"].includes(item.type)) return false;
    if (!Object.keys(item).every((key) => ["type", "role", "content", "id", "status", "call_id", "name", "arguments", "output", "encrypted_content", "summary"].includes(key))) return false;
    if (item.role !== undefined && !["system", "developer", "user", "assistant", "tool"].includes(item.role)) return false;
    if (item.type === "message") return item.role !== undefined && (typeof item.content === "string" || Array.isArray(item.content) && item.content.every((part) => object(part) && ["input_text", "output_text"].includes(part.type) && typeof part.text === "string" && Object.keys(part).every((key) => ["type", "text", "annotations", "logprobs"].includes(key))));
    if (item.type === "function_call") return allowedName(item.name) && typeof item.call_id === "string" && typeof item.arguments === "string";
    if (item.type === "function_call_output") return typeof item.call_id === "string" && typeof item.output === "string";
    return typeof item.id === "string";
  }));
  const safe = (value) => typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : value === null ? "null" : value === undefined ? "undefined" : Array.isArray(value) ? "array" : typeof value;
  const textChars = (value) => {
    if (typeof value === "string") return value.length;
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + textChars(item), 0);
    if (!object(value)) return 0;
    return (typeof value.text === "string" ? value.text.length : 0) + (typeof value.content === "string" ? value.content.length : Array.isArray(value.content) ? textChars(value.content) : 0);
  };
  const roles = [...new Set(body.input.flatMap((item) => typeof item?.role === "string" && item.role.trim() ? [item.role.trim()] : []))].toSorted().join(",") || "none";
  const shape = body.input.map((item) => !object(item) || typeof item.type !== "string" ? "unknown" : item.type === "message" && typeof item.role === "string" ? `message:${item.role}` : item.type).join(",") || "none";
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = tools.map((tool) => typeof tool?.name === "string" ? tool.name : typeof tool?.function?.name === "string" ? tool.function.name : typeof tool?.type === "string" && tool.type !== "function" ? tool.type : "").filter(Boolean);
  const shown = names.slice(0, 12).join(","), toolSummary = `count=${tools.length}${shown ? ` ${names.length <= 12 ? "names" : "sample"}=${shown}` : ""}`;
  const parts = [`fields=${Object.keys(body).toSorted().join(",")}`, `model=${safe(body.model)}`, `stream=${safe(body.stream)}`, `inputItems=${body.input.length}`, `inputItemShape=${shape}`, `inputRoles=${roles}`, `inputTextChars=${textChars(body.input)}`, `tools=${toolSummary}`, `reasoningEffort=${safe(body.reasoning?.effort)}`, `reasoningSummary=${safe(body.reasoning?.summary)}`, `textVerbosity=${safe(body.text?.verbosity)}`, `serviceTier=${safe(body.service_tier)}`, "compactionItems=0", "compactionIdHashes=none", "compactionPayloadHashes=none", "compactionInputIndexes=none", `store=${safe(body.store)}`, `promptCacheKey=${body.prompt_cache_key === undefined ? "absent" : "present"}`, "metadataKeys=none"];
  check(requestId === undefined || typeof requestId === "string" && requestId.trim());
  check(timeoutMs === undefined || Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  const requestHash = requestId === undefined ? "-" : `sha256:${digest(requestId.trim())}`;
  return { text: `[responses] start provider=${provider} api=openai-responses model=${model} requestIdHash=${requestHash} baseUrl=${endpoint.toString()} timeoutMs=${safe(timeoutMs)} apiKey=${presence} ${parts.join(" ")}`, presence: presence === "present" ? "PRESENT_MARKER" : "MISSING_MARKER", bodySha256 };
}

export function sourceSdkTimeout({ explicitOption, modelValue, optionAbsenceProven, modelAbsenceProven }) {
  // Pinned package host-policy returns a nonnull explicit option directly.
  if (explicitOption !== undefined && explicitOption !== null) { check(Number.isSafeInteger(explicitOption) && explicitOption > 0); return explicitOption; }
  check(optionAbsenceProven === true);
  if (modelValue === undefined) { check(modelAbsenceProven === true); return undefined; }
  // Host provider-transport-fetch delegates to clampPositiveTimerTimeoutMs.
  check(typeof modelValue === "number" && Number.isFinite(modelValue) && modelValue > 0);
  return Math.min(2147483647, Math.max(1, Math.floor(modelValue)));
}

export function expectedEmbeddedStarts(request, options) {
  check(request?.ownCanonicalBinding === true && typeof request.runId === "string" && request.runId && request.uniqueBody === true);
  check(Number.isSafeInteger(options.requestPopulation) && options.requestPopulation > 0 && options.requestPopulation <= 10000);
  // A bounded hash preimage search is solely a source equality aid. It does
  // not assert an independently sampled model-call ordinal or ordering.
  return [{ sourceKind: "BOUND_OWN_EMBEDDED_REQUEST", request: clone(request), options: clone(options) }];
}

export function bindCanonicalTransportRequest(request, { receipts, requests, sessionKey, sessionId, body, completedRunIds = [] }, assertTerminal, assertCanonical) {
  if (!request?.responseCompleted || request.transport !== "host-parent" || request.parentRequestClassification?.kind !== "embedded-parent" || request.hasParentTools !== true || request.emittedType !== "message" || request.parentCall || typeof request.emittedText !== "string" || digest(JSON.stringify(body)) !== request.bodyHash) return;
  const histories = receipts.filter((receipt) => receipt.method === "chat.history" && receipt.params.sessionKey === sessionKey && receipt.value.sessionKey === sessionKey && receipt.value.sessionId === sessionId);
  if (histories.some((receipt) => (receipt.value.messages ?? []).filter((entry) => entry.role === "assistant" && entry.responseId === request.responseId).length > 1)) return;
  const canonical = histories.flatMap((receipt) => receipt.value.messages ?? []).filter((entry) => entry.role === "assistant" && entry.responseId === request.responseId && entry.__openclaw?.runId && entry.__openclaw.truncated !== true);
  const runIds = [...new Set(canonical.map((entry) => entry.__openclaw.runId))]; if (runIds.length !== 1) return;
  const runId = runIds[0];
  const admitted = receipts.some((receipt) => receipt.method === "chat.send" && receipt.params.sessionKey === sessionKey && receipt.value.runId === runId);
  if (!admitted && !completedRunIds.includes(runId)) return;
  const waits = receipts.filter((receipt) => receipt.method === "agent.wait" && receipt.params.runId === runId && receipt.value.runId === runId);
  if (!waits.some((receipt) => { try {
    assertTerminal(receipt.value, runId, false);
    // The body/run join is independently visible and exact before the hash is
    // considered. This narrow path does not authorize routed/tool-call bodies.
    for (const entry of canonical) assertCanonical(receipt.value, runId, request.responseId, entry, request.emittedText);
    return true;
  } catch { return false; } })) return;
  if (requests.filter((other) => other.transport === "host-parent" && other.bodyHash === request.bodyHash).length !== 1) return;
  return { ownCanonicalBinding: true, uniqueBody: true, runId, body, bodySha256: request.bodyHash };
}

function exactStartMatch(value, entry, budget) {
  if (entry.sourceKind !== "BOUND_OWN_EMBEDDED_REQUEST") return entry.text === value ? entry : undefined;
  // The hash narrows ONLY the already independently attributed own run/body;
  // it never selects or assigns an owning run.
  const requestHash = value.match(/ requestIdHash=(sha256:[a-f0-9]{64}) /)?.[1]; if (!requestHash) return;
  const { request, options } = entry; let ordinal;
  for (let n = 1; n <= options.requestPopulation; n++) {
    check(++budget.hashChecks <= 100000);
    if (`sha256:${digest(`${request.runId}:model:${n}`)}` !== requestHash) continue;
    check(ordinal === undefined); ordinal = n;
  }
  if (ordinal === undefined) return;
  const expected = renderResponsesStart({ ...options, body: request.body, bodySha256: request.bodySha256, requestId: `${request.runId}:model:${ordinal}` });
  return expected.text === value ? { ...expected, ordinal, ordinalEvidence: "HASH_DERIVED_SOURCE_ORDINAL; population is search cap, not call count proof" } : undefined;
}

// logger-file-message.ts: the initial binding and a metadata argument do not
// contribute to the message; all other parts do, with UTF16-safe source cap.
export function pinnedFileMessage(record) {
  let args = Object.keys(record).filter((key) => /^\d+$/.test(key)).toSorted((a, b) => Number(a) - Number(b)).map((key) => record[key]);
  if (typeof args[0] === "string" && args[0].length <= 8192 && args[0].trim().startsWith("{")) {
    try { if (object(JSON.parse(args[0]))) args = args.slice(1); } catch { /* Source leaves a non-JSON binding as an ordinary part. */ }
  }
  if (object(args[0]) && typeof args[0].message !== "string") args = args.slice(1);
  const parts = args.map((value) => typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : object(value) && typeof value.message === "string" ? value.message : value != null ? JSON.stringify(value) : undefined).filter((value) => value?.trim());
  if (!parts.length) return undefined;
  const joined = parts.join(" "); let end = Math.min(joined.length, 4096);
  if (end < joined.length && /[\uD800-\uDBFF]/.test(joined[end - 1]) && /[\uDC00-\uDFFF]/.test(joined[end])) end--;
  return joined.slice(0, end) + (joined.length > 4096 ? "...(truncated)" : "");
}

function severity(record) {
  const meta = record._meta;
  check(object(meta) && Number.isInteger(meta.logLevelId) && levels[meta.logLevelId] === meta.logLevelName);
  return meta.logLevelName;
}

function transformRecord(record, authority, assess, budget) {
  check(object(record) && own(record, "_meta"));
  const level = severity(record), result = clone(record), cases = [], contexts = [];
  for (const [field, name, values] of [["agent_id", "AGENT_ID", authority.agentIds], ["session_id", "SESSION_ID", authority.sessionIds], ["channel", "CHANNEL", authority.channels]]) {
    if (!own(result, field)) continue;
    check(typeof result[field] === "string" && values.includes(result[field]));
    delete result[field]; contexts.push(name);
  }
  if (contexts.length) cases.push("SOURCE_APPENDED_CONTEXT_ONLY");
  // Check the original producer's derived message before replacing any part.
  if (own(record, "message")) check(typeof record.message === "string" && record.message === pinnedFileMessage(record));
  const details = [], transport = [];
  for (const key of Object.keys(result).filter((key) => /^\d+$/.test(key))) {
    const value = result[key];
    let wrapper = value;
    if (typeof value === "string") { try { wrapper = JSON.parse(value); } catch { /* No unescaping, repair or substring extraction. */ } }
    if (object(wrapper) && own(wrapper, "details")) {
      check(Object.keys(wrapper).length === 1 && Array.isArray(wrapper.details) && wrapper.details.length > 0 && wrapper.details.length <= 64);
      for (const element of wrapper.details) {
        // Exactly the current guard's own closed scalar/metadata/diagnostic
        // validation, not a new wrapper-wide allowance or error suppression.
        check(assess(JSON.stringify(element)).safe);
        details.push(clone(element));
      }
      result[key] = wrapper.details.map((element) => JSON.stringify(element)).join("\n");
      cases.push("DETAILS_WRAPPER");
    } else if (typeof value === "string" && value.startsWith("[responses] start ")) {
      check(["DEBUG", "INFO"].includes(level));
      const matching = authority.responsesStarts.flatMap((entry) => { const match = exactStartMatch(value, entry, budget); return match ? [match] : []; });
      check(matching.length === 1 && matching.every((entry) => ["PRESENT_MARKER", "MISSING_MARKER"].includes(entry.presence)));
      const presence = [...new Set(matching.map((entry) => entry.presence))]; check(presence.length === 1);
      // The full expected text is a source-rendered, actual request-bound
      // internal value. None of its auth-like text or dynamic tail is exported.
      result[key] = `Responses transport start source template matched (${presence[0]}).`;
      transport.push({ presence: presence[0], requestHashes: [matching[0].bodySha256], ...(matching[0].ordinal === undefined ? { requestIdEvidence: "Source caller proves requestId option absent" } : { ordinal: matching[0].ordinal, ordinalEvidence: matching[0].ordinalEvidence, ownCanonicalRunMatched: true }) });
      cases.push("RESPONSES_START_SOURCE_TEMPLATE_MATCH");
    }
  }
  check(cases.length > 0);
  if (own(record, "message")) { const message = pinnedFileMessage(result); if (message === undefined) delete result.message; else result.message = message; }
  // This validates the entire remaining header, all binding/argument values,
  // severity and derived output with the unchanged original safety guard.
  check(assess(JSON.stringify(result)).safe);
  return { result, cases: [...new Set(cases)], contexts, level, details, transport };
}

export function projectHostLog(input, authority, assess) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input), text = bytes.toString("utf8");
  const original = { bytes: bytes.length, sha256: digest(bytes), identityDomain: Buffer.isBuffer(input) ? "original captured stream bytes" : "captured text UTF8 encoding; original undecoded byte validity unavailable" };
  const blocked = (reason, observed = {}) => ({ outcome: "BLOCKED", original, rawCompleteStreamSafe: false, rawContentExcluded: true, reason, observations: observed });
  try {
    check(authority?.hostCommit === PIN && /^[a-f0-9]{40}$/.test(authority.candidateSha) && /^[a-f0-9]{64}$/.test(authority.helperSha256));
    check([authority.agentIds, authority.sessionIds, authority.channels, authority.responsesStarts].every(Array.isArray));
    if (bytes.length > LIMIT || !Buffer.from(text).equals(bytes)) return blocked("SOURCE_LOG_BYTE_BOUND_OR_UTF8");
    const spans = []; let start = 0;
    for (let index = 0; index < bytes.length; index++) if (bytes[index] === 10) { spans.push({ start, end: index + 1, lf: true }); start = index + 1; if (spans.length >= 10000) return blocked("SOURCE_LOG_RECORD_BOUND"); }
    spans.push({ start, end: bytes.length, lf: false });
    check(authority.responsesStarts.length <= 10000);
    const registry = [], output = [], counts = {}, retainedDiagnostics = [], budget = { hashChecks: 0 }; let changed = 0;
    for (const [index, span] of spans.entries()) {
      const raw = bytes.subarray(span.start, span.end), body = raw.subarray(0, raw.length - Number(span.lf)).toString("utf8"), safe = assess(body).safe;
      // Unknown severity is never hidden by a mixed projected stream, even
      // when this one record happened to pass the existing privacy guard.
      if (safe) {
        let record; try { record = JSON.parse(body); } catch { /* Unchanged safe plain text has no logger severity. */ }
        if (object(record) && own(record, "_meta")) { try { severity(record); } catch { return blocked("SOURCE_LOG_UNKNOWN_SEVERITY", { record: index }); } }
      }
      let projected = body, observation;
      if (!safe) {
        let record; try { record = JSON.parse(body); } catch { return blocked("SOURCE_LOG_UNKNOWN_RECORD", { record: index, classifiedRecords: index, transformedRecords: changed }); }
        try { observation = transformRecord(record, authority, assess, budget); } catch { return blocked("SOURCE_LOG_UNVALIDATED_RECORD", { record: index, classifiedRecords: index, transformedRecords: changed }); }
        projected = JSON.stringify(observation.result); changed++;
        for (const sourceCase of observation.cases) counts[sourceCase] = (counts[sourceCase] ?? 0) + 1;
        for (const detail of observation.details) if (object(detail) && ["Session", "SessionRuntimeRegistry", "CodexHarness", "CodexAppServerRpc"].includes(detail.component)) retainedDiagnostics.push({ record: index, diagnostic: detail });
      }
      const encoded = Buffer.from(projected + (span.lf ? "\n" : "")); output.push(encoded);
      registry.push({ record: index, byteStart: span.start, byteEndExclusive: span.end, originalBytes: raw.length, originalSha256: digest(raw), includesLF: span.lf, trailingEmpty: span.start === bytes.length, projectedBytes: encoded.length, projectedSha256: digest(encoded), sourceCases: observation?.cases ?? ["UNCHANGED_GUARD_SAFE"], ...(observation ? { severity: observation.level, omittedContextFields: observation.contexts, ownContextMatch: true, transport: observation.transport } : {}) });
    }
    const projectedBytes = Buffer.concat(output), audit = { original, candidateSha: authority.candidateSha, helperSha256: authority.helperSha256, hostCommit: PIN, scope: "Every original LF record; source projection, not raw-safe evidence", recordCount: registry.length, transformedRecords: changed, sourceCaseCounts: counts, records: registry, retainedDiagnostics };
    if (!changed || !assess(projectedBytes.toString("utf8")).safe) return blocked("SOURCE_LOG_WHOLE_STREAM_UNEXPLAINED", { transformedRecords: changed });
    if (projectedBytes.length > LIMIT || Buffer.byteLength(JSON.stringify(audit)) > LIMIT) return blocked("SOURCE_LOG_PROJECTED_FILE_BOUND");
    return { outcome: "SOURCE_PROJECTED_COMPLETE", original, rawCompleteStreamSafe: false, rawContentExcluded: true, projectedText: projectedBytes.toString("utf8"), projected: { bytes: projectedBytes.length, sha256: digest(projectedBytes), identityDomain: "Complete validated projected UTF8 stream; not original bytes" }, audit };
  } catch { return blocked("SOURCE_LOG_PROJECTION_PRECONDITION"); }
}
