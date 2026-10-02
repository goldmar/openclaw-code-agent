// Rejection-only fixed source observations. No producer, safety, native, or
// delivery authority is inferred from a dictionary/type/binding match.
import { createHash } from "node:crypto";
import { pinnedMessageRoles } from "./oca501-host-log-projection.mjs";
const levels = ["SILLY", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"];
const fields = new Set(["_meta","accountType","action","actionKind","activeAtEnd","activeCountBefore","ageMs","agentId","agent_id","appServerSubcommand","arch","argsCount","argvCount","at","backendModel","backendRefKind","buildId","byteLength","caller","candidates","channel","chars","closed","closing","code","commandKind","completionDelayMs","component","configuredArgCount","consumed","consumptionId","cronEnabled","currentStatus","date","deliveryRef","details","diagnosticEpoch","durationMs","effort","elapsedMs","enabled","error","errorCode","errorName","event","exitCode","expectedTurnId","fileColumn","fileLine","fileName","fileNameWithLine","filePath","filePathWithLine","forkSessionRequested","fullFilePath","harness","hasBackendConversationId","hasBackendRef","hasBackendRunId","hasClose","hasCwd","hasExpectedTurnId","hasHarnessSessionId","hasInterrupt","hasPayload","hasPendingInput","hasPermissionModeSwitch","hasPid","hasPlanArtifact","hasResumeSessionId","hasStderr","hasStdin","hasStdout","hasStreamInput","hasText","hasThreadId","hasTurnId","hasWorkdir","hostname","id","idleTimeoutMinutes","instanceId","isAuthorizedSender","isMainThread","jobId","jobName","kind","label","lifecycle","lifecycleQueueWaitMs","live","logLevelId","logLevelName","message","messageCount","messageLength","method","model","modelId","module","mutationQueueWaitMs","name","namespace","nextRunAtMs","nextStatus","node","omittedObservations","openssl","operation","operationId","operationSpanId","operationTraceId","opsServed","outcome","parentNames","parentSpanId","path","payloadByteLength","pendingCount","pendingRequests","permissionMode","phaseDurationsMs","pid","planDecisionVersion","platform","plugin","provider","queued","queuedCount","reason","reasoningEffort","recentStderr","reclamationKind","requestCount","requestId","requestKind","requestMethod","requestTimeoutMs","requestVersion","requestedEffort","revision","rewindTurns","runCounter","runtime","runtimeEffort","runtimeOwner","runtimeState","runtimeVersion","schedulerNextWakeAtMs","selectedHarnessId","selectedReason","sessionId","sessionKey","session_id","signal","signalAborted","spanId","sqlite","status","stderrLength","storeKey","storePath","storeRevision","subsystem","supportedVersion","textLength","threadId","time","timeoutMs","timerArmed","tokenFound","tokenHash","traceFlags","traceId","transport","uv","v8","version","what","workerThreadId"]);
const candidateSubsystems = ["agent-launch","agent-merge","agent-pr","auto-update","button-diagnostics","callback-handler","claude-code","codex","codex-protocol","codex-rpc","goal-controller","goal-store","opencode-harness","question-context-summary","session","session-bootstrap","session-lifecycle-service","session-maintenance-service","session-manager","session-question-service","session-reminder-service","session-runtime-bootstrap-service","session-runtime-registry","session-store","session-store-storage","session-worktree-action-service","session-worktree-strategy-service","wake-delivery-executor","wake-dispatcher","worktree-decision-summary","worktree-lifecycle","worktree-merge","worktree-pr","worktree-pr-metadata","worktree-provisioning","worktree-repo"];
const pinnedSubsystems = ["agents/harness", "agent/embedded", "diagnostic"];
const prohibited = "gateway auth token agents defaults bindings channels accounts credentials models providers plugins entries config environment env profile botToken apiKey tokenFile authProfiles gateway.auth agents.defaults models.providers plugins.entries process.env".split(" ");
const sourceTable = { fields: [...fields], candidateSubsystems, pinnedSubsystems, prohibited, source: "c074824a27c96d3983043f9eeb33823cd1772d8c:logging/logger,selection:720-729; candidate createLogger literal arguments" };
export const LOG_SOURCE_TABLE_SHA256 = createHash("sha256").update(JSON.stringify(sourceTable)).digest("hex");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const type = (v) => v === null ? "NULL" : Array.isArray(v) ? "ARRAY" : typeof v === "object" ? "OBJECT" : typeof v === "string" ? "STRING" : "SCALAR";
function bindingClass(value) {
  if (!object(value)) return "UNKNOWN_SOURCE_BINDING";
  const keys = Object.keys(value).toSorted().join(",");
  if (keys === "plugin,subsystem" && value.plugin === "openclaw-code-agent" && candidateSubsystems.includes(value.subsystem)) return "CANDIDATE_SOURCE_BINDING_MATCH";
  if (keys === "subsystem" && pinnedSubsystems.includes(value.subsystem)) return { "agents/harness": "PINNED_AGENTS_HARNESS_BINDING_MATCH", "agent/embedded": "PINNED_AGENT_EMBEDDED_BINDING_MATCH", diagnostic: "PINNED_DIAGNOSTIC_BINDING_MATCH" }[value.subsystem];
  return "UNKNOWN_SOURCE_BINDING";
}
export function sourceLogObservation(text, assess) {
  let row; try { row = JSON.parse(text); } catch { return { status: "INVALID_WHOLE_JSON" }; }
  if (!object(row)) return { status: "UNKNOWN_OUTER_SHAPE" };
  const id = row._meta?.logLevelId, name = row._meta?.logLevelName;
  const nameObservation = name === undefined ? "MISSING" : typeof name !== "string" ? "WRONG_TYPE" : levels.includes(name) ? name : "NONCANONICAL_STRING";
  const idObservation = id === undefined ? "MISSING" : !Number.isInteger(id) ? "WRONG_TYPE" : id < 0 || id > 6 ? "OUT_OF_RANGE_INTEGER" : id;
  const observation = { status: "COMPLETE_OBSERVATION", levelName: nameObservation, levelId: idObservation, levelPairMatches: Number.isInteger(id) && id >= 0 && id <= 6 && levels[id] === name, nodes: [], interpretation: "Dictionary/source-binding/type only; no safety, producer or native proof" };
  let visited = 0;
  const visit = (value, position, depth = 0) => {
    if (visited >= 128 || depth > 16) throw new Error("BOUND");
    visited++;
    const node = { ...(position === "ARRAY_ELEMENT" ? {} : { position }), type: type(value) }; observation.nodes.push(node);
    // Array element counts/types and traversal order are retained; no private
    // path or redundant per-element position string is exported.
    if (position === "ARRAY_ELEMENT") observation.arrayElementPositionsOmitted = true;
    if (object(value)) {
      const entries = Object.entries(value); if (entries.length > 64) { node.fieldCount = entries.length; node.fieldsUninspected = true; throw new Error("BOUND"); }
      node.known = {}; node.unknownCount = 0; node.unknownTypes = {}; node.prohibited = [];
      for (const [key, child] of entries) {
        if (prohibited.includes(key)) node.prohibited.push(key);
        else if (fields.has(key)) (node.known[type(child)] ??= []).push(key);
        else if (!/^\d+$/.test(key)) { node.unknownCount++; node.unknownTypes[type(child)] = (node.unknownTypes[type(child)] ?? 0) + 1; }
      }
      if (!node.unknownCount) delete node.unknownCount;
      if (!Object.keys(node.known).length) delete node.known;
      if (!Object.keys(node.unknownTypes).length) delete node.unknownTypes;
      if (!node.prohibited.length) delete node.prohibited;
      if (["Session", "SessionRuntimeRegistry", "CodexHarness", "CodexAppServerRpc"].includes(value.component) && ["turn.terminal", "turn.error"].includes(value.event) && assess(JSON.stringify(value)).safe) node.native = { component: value.component, event: value.event, kind: ["user", "compact", "review"].includes(value.kind) ? value.kind : "UNKNOWN", outcome: ["completed", "failed", "interrupted"].includes(value.outcome) ? value.outcome : "UNKNOWN" };
      for (const [key, child] of entries) if (key !== "message" && key !== "_meta" && !/^\d+$/.test(key) && child !== null && typeof child === "object") visit(child, "NESTED", depth + 1);
    } else if (Array.isArray(value)) {
      node.length = value.length; node.elementTypes = value.reduce((counts, child) => { counts[type(child)] = (counts[type(child)] ?? 0) + 1; return counts; }, {});
      for (const child of value) if (child !== null && typeof child === "object") visit(child, "ARRAY_ELEMENT", depth + 1);
    }
    return node;
  };
  try {
    visit(row, "OUTER"); if (row._meta !== undefined) visit(row._meta, "META");
    const roles = pinnedMessageRoles(row); observation.originalRoles = { bindingPosition: roles.bindingKey === undefined ? null : roles.keys.indexOf(roles.bindingKey), metadataPosition: roles.metadataKey === undefined ? null : roles.keys.indexOf(roles.metadataKey), messagePositions: roles.messageKeys.map((key) => roles.keys.indexOf(key)) };
    if (roles.bindingKey !== undefined) { const binding = JSON.parse(row[roles.bindingKey]); observation.binding = bindingClass(binding); visit(binding, "INITIAL_SOURCE_BINDING"); }
    else observation.binding = "NO_INITIAL_SOURCE_BINDING";
    for (const [index, key] of roles.keys.entries()) {
      const node = visit(row[key], "NUMERIC_ARGUMENT"); node.argumentPosition = index;
      // Only complete currently supported whole OCA diagnostic JSON is decoded.
      if (typeof row[key] === "string") { let parsed; try { parsed = JSON.parse(row[key]); } catch { continue; }
        if (object(parsed) && ["Session", "SessionRuntimeRegistry", "CodexHarness", "CodexAppServerRpc"].includes(parsed.component) && assess(row[key]).safe) visit(parsed, "WHOLE_NATIVE_DIAGNOSTIC_JSON"); }
    }
  } catch { observation.status = "PARTIAL_OBSERVATION"; observation.traversalBoundOrUnknown = true; }
  observation.visitedNodes = visited;
  return observation;
}
