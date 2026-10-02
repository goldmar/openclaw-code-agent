// Pure external-provider fixture selection. No host/native state is fabricated.
import assert from "node:assert/strict";
import { nativeInventory } from "./oca501-native-protocol.mjs";

export const messageText = (entry) => typeof entry.content === "string" ? entry.content : (entry.content ?? []).map((part) => part.text ?? "").join("\n");
export function latestParentUser(input) {
  return input.input.findLast((entry) => entry.role === "user" && !messageText(entry).trim().startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>"));
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
  const value = JSON.parse(receipt.stdout.slice(receipt.stdout.indexOf("{")));
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

export function assertSafeHostLog(text) {
  const inspect = (value) => {
    if (typeof value === "string") {
      assert.ok(!/"(?:botToken|apiKey|tokenFile|authProfiles)"\s*:/.test(value), "Config-bearing host log is excluded; evidence remains BLOCKED");
      try { inspect(JSON.parse(value)); } catch (error) { if (error instanceof assert.AssertionError) throw error; }
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) { assert.ok(!["botToken", "apiKey", "tokenFile", "authProfiles"].includes(key), "Config-bearing host log is excluded; evidence remains BLOCKED"); inspect(item); }
    }
  };
  inspect(text); for (const line of text.split("\n")) { try { inspect(JSON.parse(line)); } catch (error) { if (error instanceof assert.AssertionError) throw error; } }
}

export function selectOrdinaryCompletion(input, owners) {
  const latest = latestParentUser(input); if (!latest || !input.tools?.length) return;
  const wake = messageText(latest), firstLine = wake.split("\n")[0].replace(/^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\] /, "");
  const turnEnded = firstLine === "Coding agent session turn ended.";
  const completed = /^\[[^\]\n]+\] Completed\. ID: [A-Za-z0-9_-]+$/.test(firstLine);
  if (!turnEnded && !completed) return;
  const matching = owners.filter(({ row }) => turnEnded ? wake.split("\n")[1] === `Name: ${row.name}` && wake.split("\n")[2] === `ID: ${row.sessionId}` : firstLine === `[${row.name}] Completed. ID: ${row.sessionId}`);
  assert.equal(matching.length, 1, "One genuinely registered ordinary session owns this wake");
  const owner = matching[0], { row, completion } = owner;
  assert.equal(row.goalTaskId, undefined, "Goal-owned sessions cannot use ordinary source dispatch");
  assert.equal(owner.fixture.ordinary, true); assert.equal(owner.fixture.sessionId, row.sessionId);
  assert.ok(completion && completion.nativeCompleted === true, "Actual native completion is required before ordinary source send");
  assert.equal(completion.threadId, row.backendRef?.conversationId); assert.equal(completion.turnId, row.backendRef?.runId);
  assert.ok(typeof completion.turnId === "string" && completion.turnId);
  assert.equal(completion.caseTag, owner.fixture.tag);
  if (turnEnded) {
    assert.equal(wake.split("\n")[3], `Status: ${row.status}`); assert.equal(wake.split("\n")[4], `Lifecycle: ${row.lifecycle}`);
    assert.equal(row.status, "running"); assert.ok(["awaiting_user_input", "running"].includes(row.lifecycle));
    assert.equal(row.pendingPlanApproval, false);
  } else { assert.equal(row.status, "done"); assert.equal(row.lifecycle, "terminal"); }
  const routes = wake.split("\n").filter((line) => line.startsWith("originRoute: ")); assert.equal(routes.length, 1);
  const route = JSON.parse(routes[0].slice(13));
  assert.ok(row.route && Object.keys(row.route).every((key) => ["provider", "target", "accountId", "sessionKey"].includes(key)), "No unobserved ordinary stored destination/thread");
  const storedRoute = { provider: row.route?.provider, target: row.route?.target, ...(row.route && Object.hasOwn(row.route, "accountId") ? { accountId: row.route.accountId } : {}) };
  assert.deepEqual(route, storedRoute); assert.equal(route.provider, "telegram"); assert.equal(route.target, "501002");
  assert.deepEqual(Object.keys(route).toSorted(), (Object.hasOwn(route, "accountId") ? ["accountId", "provider", "target"] : ["provider", "target"]).toSorted());
  if (Object.hasOwn(route, "accountId")) assert.equal(route.accountId, "default");
  assert.ok(wake.includes("use message(action='send', final=true) to originRoute"));
  const cycle = `${row.sessionId}/${completion.turnId}/${turnEnded ? "turn-ended" : "completed"}`;
  return { ordinary: row, owner, completion, cycle, route, wake, index: input.input.indexOf(latest) };
}
