// Export-only projections of three pinned logger producers. Original guard,
// runtime records and acceptance readers are never changed by this module.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { actualToolPayload, assertActualSendResult, exactFixtureRoute, sourceSendArgs } from "./oca501-config-receipt.mjs";

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
  return Math.min(2147000000, Math.max(1, Math.floor(modelValue)));
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

// Separate informational attribution for completed function-call responses.
// Every eligible run is already fully settled by the existing host source
// assertions. This join never creates delivery or execution evidence.
export function bindCanonicalFunctionTransportRequest(request, { receipts, requests, sessionKey, sessionId, body, settlements }, assertTerminal) {
  try {
    check(request?.responseCompleted === true && request.transport === "host-parent" && request.parentRequestClassification?.kind === "embedded-parent" && request.hasParentTools === true && request.emittedType === "function_call" && object(body));
    check(digest(JSON.stringify(body)) === request.bodyHash && requests.filter((other) => other.transport === "host-parent" && other.bodyHash === request.bodyHash).length === 1);
    const emitted = request.emittedFunctionCall, call = request.parentCall;
    check(object(emitted) && Object.keys(emitted).toSorted().join(",") === "arguments,call_id,id,name,type" && emitted.type === "function_call" && typeof emitted.arguments === "string");
    check(call && emitted.call_id === call.id && emitted.id === call.itemId && emitted.name === call.name && call.request === request.requestIndex && isDeepStrictEqual(JSON.parse(emitted.arguments), call.args));
    check(typeof call.id === "string" && call.id && typeof call.itemId === "string" && call.itemId && ["search", "describe", "send"].includes(call.stage));
    check(({ search: "tool_search", describe: "tool_describe" })[call.stage] === call.name || call.stage === "send" && ["tool_call", "message"].includes(call.name));
    const advertised = (body.tools ?? []).filter((tool) => (tool.name ?? tool.function?.name) === call.name);
    check(advertised.length === 1 && advertised[0].type === "function" && (advertised[0].parameters ?? advertised[0].function?.parameters)?.type === "object");
    const fullId = `${call.id}|${call.itemId}`;
    const histories = receipts.filter((receipt) => receipt.method === "chat.history" && receipt.params.sessionKey === sessionKey && receipt.value.sessionKey === sessionKey && receipt.value.sessionId === sessionId);
    const physical = new Map();
    for (const history of histories) {
      const records = (history.value.messages ?? []).filter((entry) => entry.role === "assistant" && entry.responseId === request.responseId);
      check(records.length <= 1);
      if (!records.length) continue;
      const entry = records[0], meta = entry.__openclaw;
      check(object(meta) && typeof meta.id === "string" && meta.id && typeof meta.runId === "string" && meta.runId && meta.truncated !== true && Array.isArray(entry.content));
      const calls = entry.content.filter((part) => part.type === "toolCall");
      check(calls.length === 1 && calls[0].id === fullId && calls[0].name === call.name && isDeepStrictEqual(calls[0].arguments, call.args));
      const previous = physical.get(meta.id);
      // Repeated observations only deduplicate the same complete physical
      // assistant. Timestamp/position/seq and the entire content stay equal.
      check(!previous || isDeepStrictEqual(previous, entry)); physical.set(meta.id, entry);
    }
    check(physical.size === 1);
    const canonical = [...physical.values()][0], runId = canonical.__openclaw.runId;
    const matching = settlements.filter((proof) => proof.runId === runId && proof.state?.sessionId === request.parentDelivery?.sessionId && proof.state?.wakeHash === request.parentDelivery?.wakeHash && proof.state?.goalId === request.parentDelivery?.goalId && proof.state?.ordinarySessionId === request.parentDelivery?.ordinarySessionId);
    check(matching.length === 1); const proof = matching[0], state = proof.state, row = proof.row;
    check(row?.sessionId === state.sessionId && state.ownerId === (state.goalId ?? state.ordinarySessionId) && !state.toolError && proof.sessionKey === sessionKey && proof.sessionId === sessionId);
    const registeredCalls = state.calls.filter((entry) => entry.id === call.id && entry.itemId === call.itemId);
    check(registeredCalls.length === 1 && isDeepStrictEqual(registeredCalls[0], call));
    check(isDeepStrictEqual(exactFixtureRoute(state.route), { provider: row.route.provider, target: row.route.target, ...(own(row.route, "accountId") ? { accountId: row.route.accountId } : {}) }));
    assertTerminal(proof.terminal, runId, true);
    if (state.goalId || proof.kind === "completed") {
      check(row.completionWakeRunId === runId && row.completionWakeIssuedAt && row.completionWakeSucceededAt && row.completionWakeRoutedReply === true && row.completionWakeSummaryRequired === undefined);
      check(!row.completionWakeFailedAt && !row.completionWakeSkippedAt && !row.completionWakeSkipReason && row.completionWakeSubmissionState !== "not_submitted");
      const fact = row.completionWakeSummaryFact;
      check(fact?.required === true && fact.producer === (state.goalId ? "goal" : "terminal") && fact.outcomeKey === row.completionWakeOutcomeKey && typeof fact.outcomeKey === "string" && fact.outcomeKey);
      if (state.goalId) check(row.goalTaskId === state.goalId && proof.task?.id === state.goalId && proof.task.sessionId === state.sessionId && row.completionWakeOutcomeKey === `goal:${proof.task.id}`);
    }
    if (state.ordinarySessionId) {
      const completion = state.actualNativeCompletion;
      check(row.goalTaskId === undefined && completion?.nativeCompleted === true && completion.threadId === row.backendRef?.conversationId && typeof completion.turnId === "string" && completion.turnId && proof.ordinaryCycle === state.ordinaryCycle && proof.wakeHash === state.wakeHash);
      check(proof.kind === "turn-ended" || proof.kind === "completed" && row.backendRef?.runId === completion.turnId);
    }
    const final = state.calls.at(-1); check(final?.stage === "send");
    check(isDeepStrictEqual(final.name === "tool_call" ? final.args.args : final.args, sourceSendArgs(state.route, state.summary)));
    const wire = proof.wire;
    check(Array.isArray(wire) && wire.length === 1 && wire[0].method === "sendMessage" && wire[0].respondedAt && wire[0].result?.text === state.summary && wire[0].result?.chat?.id === 501002 && Number.isSafeInteger(wire[0].result?.message_id));
    const params = JSON.parse(wire[0].params);
    check(!["reply_to_message_id", "reply_parameters", "message_thread_id", "direct_messages_topic_id"].some((key) => own(params, key)));
    const finalId = `${final.id}|${final.itemId}`;
    const results = (proof.canonicalHistory?.messages ?? []).filter((entry) => entry.role === "toolResult" && entry.toolCallId === finalId && entry.__openclaw?.runId === runId && entry.__openclaw?.truncated !== true && entry.isError !== true && entry.toolName === final.name);
    check(results.length === 1 && Array.isArray(results[0].content) && results[0].content.every((part) => part.type === "text" && typeof part.text === "string"));
    // Full actual canonical result is the approved final-hook alternative.
    assertActualSendResult(JSON.parse(results[0].content.map((part) => part.text).join("\n")), final.name, state.tool, final.id);
    if (call.actualOutput) {
      check(call.actualOutput.call_id === call.id); const output = actualToolPayload(call.actualOutput);
      if (call.stage === "search") check(Array.isArray(output) && output.filter((tool) => tool.name === "message" && tool.source === "openclaw" && tool.sourceName === "core" && tool.id === state.tool?.id).length === 1 && isDeepStrictEqual(output.find((tool) => tool.id === state.tool.id), state.tool));
      else if (call.stage === "describe") check(isDeepStrictEqual(output, state.description) && output.id === state.tool.id && output.name === "message" && output.source === "openclaw" && output.sourceName === "core" && output.parameters?.type === "object");
      else assertActualSendResult(output, call.name, state.tool, call.id);
    } else check(call.stage === "send" && call.id === final.id && call.itemId === final.itemId);
    return { ownCanonicalBinding: true, uniqueBody: true, runId, body, bodySha256: request.bodyHash, association: "Actual emitted paired function call, physical canonical assistant and independently settled same-owner source run" };
  } catch { return undefined; }
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
  return expected.text === value ? { ...expected, sourceCallIdentity: `${request.runId}:model:${ordinal}`, ordinal, ordinalEvidence: "HASH_DERIVED_SOURCE_ORDINAL; population is search cap, not call count proof" } : undefined;
}

// logger-file-message.ts: the initial binding and a metadata argument do not
// contribute to the message; all other parts do, with UTF16-safe source cap.
export function pinnedMessageRoles(record) {
  const keys = Object.keys(record).filter((key) => /^\d+$/.test(key)).toSorted((a, b) => Number(a) - Number(b));
  let remaining = [...keys], bindingKey, metadataKey;
  if (typeof record[remaining[0]] === "string" && record[remaining[0]].length <= 8192 && record[remaining[0]].trim().startsWith("{")) {
    try { if (object(JSON.parse(record[remaining[0]]))) bindingKey = remaining.shift(); } catch { /* No binding on malformed JSON. */ }
  }
  if (object(record[remaining[0]]) && typeof record[remaining[0]].message !== "string") metadataKey = remaining.shift();
  return { keys, bindingKey, metadataKey, messageKeys: remaining };
}
function fileMessageWithRoles(record, roles) {
  const parts = roles.messageKeys.map((key) => record[key]).map((value) => typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : object(value) && typeof value.message === "string" ? value.message : value != null ? JSON.stringify(value) : undefined).filter((value) => value?.trim());
  if (!parts.length) return undefined;
  const joined = parts.join(" "); let end = Math.min(joined.length, 4096);
  if (end < joined.length && /[\uD800-\uDBFF]/.test(joined[end - 1]) && /[\uDC00-\uDFFF]/.test(joined[end])) end--;
  return joined.slice(0, end) + (joined.length > 4096 ? "...(truncated)" : "");
}
export function pinnedFileMessage(record) { return fileMessageWithRoles(record, pinnedMessageRoles(record)); }

function severity(record) {
  const meta = record._meta;
  check(object(meta) && Number.isInteger(meta.logLevelId) && meta.logLevelId >= 0 && meta.logLevelId < levels.length && typeof meta.logLevelName === "string" && levels.includes(meta.logLevelName) && levels[meta.logLevelId] === meta.logLevelName);
  return meta.logLevelName;
}

function transformRecord(record, authority, assess, budget) {
  check(object(record) && own(record, "_meta"));
  const level = severity(record), result = clone(record), cases = [], contexts = [], roles = pinnedMessageRoles(record);
  check(roles.keys.length <= 64 && roles.keys.every((key) => /^(?:0|[1-9][0-9]?)$/.test(key) && Number(key) < 64));
  for (const [field, name, values] of [["agent_id", "AGENT_ID", authority.agentIds], ["session_id", "SESSION_ID", authority.sessionIds], ["channel", "CHANNEL", authority.channels]]) {
    if (!own(result, field)) continue;
    check(typeof result[field] === "string" && values.includes(result[field]));
    delete result[field]; contexts.push(name);
  }
  if (contexts.length) cases.push("SOURCE_APPENDED_CONTEXT_ONLY");
  // Check the original producer's derived message before replacing any part.
  if (own(record, "message")) check(typeof record.message === "string" && record.message === pinnedFileMessage(record));
  // Preserve ORIGINAL source roles across normalization: a message that looks
  // like JSON must never become a newly extracted/discarded binding prefix.
  if (roles.bindingKey !== undefined) {
    const binding = JSON.parse(record[roles.bindingKey]);
    const fields = Object.keys(binding).toSorted().join(",");
    check(["plugin,subsystem", "module,storeKey", "subsystem"].includes(fields) && Object.values(binding).every((value) => typeof value === "string") && assess(record[roles.bindingKey]).safe);
    cases.push("SAFE_SOURCE_BINDING_PRESERVED");
  }
  if (roles.metadataKey !== undefined && Object.keys(record[roles.metadataKey]).length === 0) {
    delete result[roles.metadataKey]; cases.push("EMPTY_METADATA_ZERO_FIELDS");
  }
  for (const key of roles.messageKeys) if (object(record[key]) && own(record[key], "message")) {
    check(Object.keys(record[key]).length === 1 && typeof record[key].message === "string" && assess(record[key].message).safe);
    result[key] = record[key].message; cases.push("SOLE_MESSAGE_ROLE_NORMALIZED");
  }
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
      if (matching[0].sourceCallIdentity !== undefined) {
        // Repeated run/model-call identity in another record can be a retry or
        // per-attempt sequence reset. This equality aid cannot resolve it.
        check(!budget.sourceCallIdentities.has(matching[0].sourceCallIdentity));
        budget.sourceCallIdentities.add(matching[0].sourceCallIdentity);
      }
      // The full expected text is a source-rendered, actual request-bound
      // internal value. None of its auth-like text or dynamic tail is exported.
      result[key] = `Responses transport start source template matched (${presence[0]}).`;
      transport.push({ presence: presence[0], requestHashes: [matching[0].bodySha256], ...(matching[0].ordinal === undefined ? { requestIdEvidence: "Source caller proves requestId option absent" } : { ordinal: matching[0].ordinal, ordinalEvidence: matching[0].ordinalEvidence, ownCanonicalRunMatched: true }) });
      cases.push("RESPONSES_START_SOURCE_TEMPLATE_MATCH");
    }
  }
  check(cases.length > 0);
  if (own(record, "message")) { const message = fileMessageWithRoles(result, roles); if (message === undefined) delete result.message; else result.message = message; }
  // This validates the entire remaining header, all binding/argument values,
  // severity and derived output with the unchanged original safety guard.
  check(assess(JSON.stringify(result)).safe);
  for (const key of roles.keys) {
    let value = result[key];
    if (typeof value === "string") { try { value = JSON.parse(value); } catch { continue; } }
    if (object(value) && ["Session", "SessionRuntimeRegistry", "CodexHarness", "CodexAppServerRpc"].includes(value.component) && ["turn.terminal", "turn.error"].includes(value.event) && assess(JSON.stringify(value)).safe && !details.some((existing) => isDeepStrictEqual(existing, value))) details.push(clone(value));
  }
  return { result, cases: [...new Set(cases)], contexts, level, details, transport, roles };
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
    const registry = [], output = [], counts = {}, retainedDiagnostics = [], blockedDetails = [], blockedRecordIndices = [], projectedRecordIndices = [], budget = { hashChecks: 0, sourceCallIdentities: new Set() };
    let changed = 0, safeRecords = 0, blockedRecords = 0, originalGuardSafeRecords = 0;
    for (const [index, span] of spans.entries()) {
      const raw = bytes.subarray(span.start, span.end), body = raw.subarray(0, raw.length - Number(span.lf)).toString("utf8"), safe = assess(body).safe;
      if (safe) originalGuardSafeRecords++;
      let projected = body, observation, reason;
      if (safe) {
        let record; try { record = JSON.parse(body); } catch { /* Safe plain text has no logger severity. */ }
        if (object(record) && own(record, "_meta")) { try { severity(record); } catch { reason = "SOURCE_LOG_UNKNOWN_SEVERITY"; } }
      } else {
        let record; try { record = JSON.parse(body); } catch { reason = "SOURCE_LOG_UNKNOWN_RECORD"; }
        if (!reason) try { observation = transformRecord(record, authority, assess, budget); } catch { reason = "SOURCE_LOG_UNVALIDATED_RECORD"; }
      }
      if (reason) {
        blockedRecords++; blockedRecordIndices.push(index);
        if (blockedDetails.length < 64) blockedDetails.push({ record: index, byteStart: span.start, byteEndExclusive: span.end, originalBytes: raw.length, originalSha256: digest(raw), reason });
        continue;
      }
      if (observation) {
        projected = JSON.stringify(observation.result); changed++; projectedRecordIndices.push(index);
        for (const sourceCase of observation.cases) counts[sourceCase] = (counts[sourceCase] ?? 0) + 1;
        for (const detail of observation.details) if (object(detail) && ["Session", "SessionRuntimeRegistry", "CodexHarness", "CodexAppServerRpc"].includes(detail.component)) retainedDiagnostics.push({ record: index, diagnostic: detail });
      } else safeRecords++;
      const encoded = Buffer.from(projected + (span.lf ? "\n" : "")); output.push(encoded);
      registry.push({ record: index, byteStart: span.start, byteEndExclusive: span.end, originalBytes: raw.length, originalSha256: digest(raw), includesLF: span.lf, trailingEmpty: span.start === bytes.length, projectedBytes: encoded.length, projectedSha256: digest(encoded), sourceCases: observation?.cases ?? ["UNCHANGED_GUARD_SAFE"], ...(observation ? { severity: observation.level, omittedContextFields: observation.contexts, ownContextMatch: observation.contexts.length ? true : undefined, sourceRoles: { bindingPosition: observation.roles.bindingKey === undefined ? null : observation.roles.keys.indexOf(observation.roles.bindingKey), metadataPosition: observation.roles.metadataKey === undefined ? null : observation.roles.keys.indexOf(observation.roles.metadataKey), messagePositions: observation.roles.messageKeys.map((key) => observation.roles.keys.indexOf(key)) }, transport: observation.transport } : {}) });
    }
    const observations = { recordCount: spans.length, originalGuardSafeRecords, safeRecords, projectedRecords: changed, blockedRecords, blockedRecordIndices, projectedRecordIndices, omittedBlockedDetails: blockedRecords - blockedDetails.length, blockedDetails, sourceCaseCounts: counts, accountingComplete: safeRecords + changed + blockedRecords === spans.length };
    // Index/count authority is complete and independent of detail/registry caps.
    // Pretty serialization is shared with the actual consuming artifact writer.
    const serializedRegistry = serializeHostLogArtifact(registry);
    if (Buffer.byteLength(serializedRegistry) > LIMIT) return blocked("SOURCE_LOG_AUDIT_FILE_BOUND", { ...observations, validatedRegistryExcluded: true, validatedRegistrySerialization: { bytes: Buffer.byteLength(serializedRegistry), sha256: digest(serializedRegistry), scope: "Derived pretty JSON registry with newline; not original stream bytes" } });
    if (blockedRecords) return blocked("SOURCE_LOG_UNVALIDATED_RECORDS", { ...observations, validatedRecords: registry });
    const projectedBytes = Buffer.concat(output), audit = { original, candidateSha: authority.candidateSha, helperSha256: authority.helperSha256, hostCommit: PIN, scope: "Every original LF record; source projection, not raw-safe evidence", recordCount: registry.length, originalGuardSafeRecords, transformedRecords: changed, sourceCaseCounts: counts, records: registry, retainedDiagnostics };
    if (!changed || !assess(projectedBytes.toString("utf8")).safe) return blocked("SOURCE_LOG_WHOLE_STREAM_UNEXPLAINED", { transformedRecords: changed });
    if (projectedBytes.length > LIMIT || Buffer.byteLength(serializeHostLogArtifact({ ...audit, projectedRecordHashScope: HOST_LOG_RECORD_HASH_SCOPE })) > LIMIT) return blocked("SOURCE_LOG_PROJECTED_FILE_BOUND", observations);
    return { outcome: "SOURCE_PROJECTED_COMPLETE", original, rawCompleteStreamSafe: false, rawContentExcluded: true, projectedText: projectedBytes.toString("utf8"), projected: { bytes: projectedBytes.length, sha256: digest(projectedBytes), identityDomain: "Complete validated projected UTF8 stream; not original bytes" }, audit };
  } catch { return blocked("SOURCE_LOG_PROJECTION_PRECONDITION"); }
}


export const HOST_LOG_RECORD_HASH_SCOPE = "Validated source projection before exact known synthetic fixture-token artifact redaction";
export function serializeHostLogArtifact(value, redact = (text) => text, replacer, { compact = false } = {}) {
  return redact(typeof value === "string" ? value : `${JSON.stringify(value, replacer, compact ? undefined : 2)}\n`);
}

// Prepare ALL actual final consumer bytes before registration. A bounded
// exclusion receipt replaces an entire oversize artifact; no record is split
// or truncated and the affected acceptance remains BLOCKED.
// Private complete identities survive presentation bounds; never serialized by
// JSON. Original scan completeness and bounded detail presentation are distinct.
export const HOST_DIAGNOSTIC_IDENTITIES = Symbol("closed diagnostic identities");
export function presentHostLogDiagnostic(d, serialize) {
  const fits = (value) => Buffer.byteLength(serialize(value)) <= 64 * 1024;
  if (fits(d)) return d;
  const { failedLineDetails = [], lexicalDetails = [], projectedDiagnosticSha256: _hash, projectedDigestScope: _scope, ...base } = d;
  const all = d[HOST_DIAGNOSTIC_IDENTITIES];
  const blocked = new Set(all?.sourceBlockedIndices ?? []);
  const identities = all?.identities;
  const seal = (value) => ({ ...value, projectedDiagnosticSha256: digest(JSON.stringify(value)), projectedDigestScope: "Closed presentation-bounded diagnostic before digest fields; not original stream" });
  const count = (value) => ({ ...value,
    omittedFailedLineDetails: d.failedLines - value.failedLineDetails.filter((detail) => !detail.originalLineGuardSafe).length,
    omittedProjectionOnlyDetails: (d.projectionBlockedGuardSafeLines ?? 0) - value.failedLineDetails.filter((detail) => detail.originalLineGuardSafe).length,
    lexicalOmittedDetails: d.lexicalMatches - value.lexicalDetails.length,
    presentationComplete: value.failedLineDetails.length === d.failedLines + (d.projectionBlockedGuardSafeLines ?? 0) && value.lexicalDetails.length === d.lexicalMatches });
  let selected = { ...base, failedLineDetails: [], lexicalDetails: [], presentationOrder: "SOURCE_BLOCKED_FIRST; original record order within each class", presentationComplete: false,
    ...(identities ? { rawFailureRecordIdentities: identities, sourceBlockedRecordIndices: [...blocked], identityScope: "Complete raw-rejected and projector-only failure spans; complete validated registry remains in the enclosing source projection receipt" } : {}) };
  if (identities && fits(seal(count(selected)))) {
    const details = failedLineDetails.toSorted((x, y) => Number(blocked.has(y.line)) - Number(blocked.has(x.line)) || x.line - y.line);
    for (const detail of details) {
      const next = { ...selected, failedLineDetails: [...selected.failedLineDetails, detail] };
      if (!fits(seal(count(next)))) break;
      selected = next;
    }
    for (const detail of lexicalDetails) {
      const next = { ...selected, lexicalDetails: [...selected.lexicalDetails, detail] };
      if (!fits(seal(count(next)))) break;
      selected = next;
    }
    return seal(count(selected));
  }
  const fallback = { diagnosticStatus: "DIAGNOSTIC_OUTPUT_BOUND_EXCEEDED", original: d.original, inputIdentityDomain: d.inputIdentityDomain, sourceTableSha256: d.sourceTableSha256, rawContentExcluded: true, inspectionComplete: false, inspectedLines: d.inspectedLines, uninspectedLines: d.uninspectedLines ?? 0, capturedLines: d.capturedLines, failedLines: d.failedLines, safeLines: d.safeLines, projectionBlockedGuardSafeLines: d.projectionBlockedGuardSafeLines, omittedFailedLineDetails: d.failedLines, omittedProjectionOnlyDetails: d.projectionBlockedGuardSafeLines, failureHistogram: d.failureHistogram, lexicalMatches: d.lexicalMatches, lexicalScanCapped: d.lexicalScanCapped, lexicalCountScope: d.lexicalCountScope, lexicalOmittedDetails: d.lexicalMatches, detailContentExcluded: true, outputBoundScope: "Actual final serialized/redacted diagnostic including all source identity/guard wrappers" };
  check(fits(fallback)); return fallback;
}
export function hostLogArtifactPlan(name, receipt, originalText, { serialize, compactSerialize = (value) => serializeHostLogArtifact(value, redact, undefined, { compact: true }), redact, guardSource, assertProjectedSafe }) {
  if (receipt.rejectedStreamDiagnostic) {
    const wrappedDiagnostic = (diagnostic) => compactSerialize({ rejectedStreamDiagnostic: diagnostic, sourceIdentity: name, guardSource });
    const diagnostic = presentHostLogDiagnostic(receipt.rejectedStreamDiagnostic, wrappedDiagnostic);
    if (diagnostic !== receipt.rejectedStreamDiagnostic) {
      const { projectedPayloadSha256: _oldHash, projectedDigestScope: _oldScope, ...payload } = { ...receipt, rejectedStreamDiagnostic: diagnostic };
      receipt = { ...payload, projectedPayloadSha256: digest(JSON.stringify(payload)), projectedDigestScope: "Closed receipt after final diagnostic boundary; before digest/artifact wrapper, not original stream" };
    }
  }
  const files = [], prepare = (fileName, value) => { const text = serialize(value); check(typeof text === "string"); files.push({ name: fileName, text }); };
  let reason = "HOST_LOG_FINAL_ARTIFACT_BOUND";
  try {
    if (receipt.completeStreamSafe) prepare(name, originalText);
    else if (receipt.sourceProjectedComplete) {
      const { projectedText, audit, ...summary } = receipt, sanitized = redact(projectedText);
      assertProjectedSafe(sanitized);
      prepare(`${name}.source-projected.log`, sanitized);
      prepare(`${name}.source-audit.json`, { ...audit, projectedRecordHashScope: HOST_LOG_RECORD_HASH_SCOPE });
      prepare(name, { ...summary, sourceIdentity: name, projectedStream: `${name}.source-projected.log`, sourceAudit: `${name}.source-audit.json`, projectedHashScope: HOST_LOG_RECORD_HASH_SCOPE, exportedProjection: { bytes: Buffer.byteLength(sanitized), sha256: digest(sanitized), scope: "Actual sanitized projected stream artifact bytes" }, projectionScope: "Complete source-validated projection; original raw stream excluded; unchanged acceptance obligations" });
    } else { const value = { ...receipt, sourceIdentity: name, guardSource, projectionScope: "Entire unsafe stream excluded; original bytes/hash retained; lifecycle/error facts UNPROVEN" }; files.push({ name, text: compactSerialize(value) }); }
    if (files.every((file) => Buffer.byteLength(file.text) <= LIMIT)) return { receipt, files, blocked: !receipt.completeStreamSafe && !receipt.sourceProjectedComplete };
  } catch { reason = "HOST_LOG_FINAL_ARTIFACT_PREPARATION_FAILED"; }
  const observations = receipt.sourceProjectionAttempt?.observations, audit = receipt.audit;
  const counts = observations ? { recordCount: observations.recordCount, originalGuardSafeRecords: observations.originalGuardSafeRecords, safeRecords: observations.safeRecords, projectedRecords: observations.projectedRecords, blockedRecords: observations.blockedRecords, accountingComplete: observations.accountingComplete, sourceCaseCounts: observations.sourceCaseCounts } : audit ? { recordCount: audit.recordCount, originalGuardSafeRecords: audit.originalGuardSafeRecords, safeRecords: audit.recordCount - audit.transformedRecords, projectedRecords: audit.transformedRecords, blockedRecords: 0, accountingComplete: true, sourceCaseCounts: audit.sourceCaseCounts } : undefined;
  const fallback = { completeStreamSafe: false, sourceProjectedComplete: false, projection: true, original: receipt.original, rawCompleteStreamExcluded: true, failureDiagnostic: receipt.failureDiagnostic ?? receipt.rawGuardFailureDiagnostic, rejectedStreamDiagnostic: receipt.rejectedStreamDiagnostic, sourceProjectionAttempt: { outcome: "BLOCKED", reason, observations: counts, completeAuditExcluded: true }, finalArtifactBoundary: { reason, oversizedFiles: files.filter((file) => Buffer.byteLength(file.text) > LIMIT).map((file) => ({ bytes: Buffer.byteLength(file.text), sha256: digest(file.text), scope: "Actual final serialized/redacted artifact bytes excluded; not original stream" })) }, exclusionReason: "Host log final artifact exceeds fixed bound or cannot be prepared; full stream/audit excluded; required lifecycle/error facts UNPROVEN" };
  const text = compactSerialize({ ...fallback, sourceIdentity: name, guardSource, projectionScope: "Entire stream excluded at actual final artifact boundary; original identity/disposition and complete counts retained" });
  check(Buffer.byteLength(text) <= LIMIT);
  return { receipt: fallback, files: [{ name, text }], blocked: true };
}
