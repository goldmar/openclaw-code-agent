// Offline protocol controls, including optional immutable captured-request replay.
// No native process, host, tool execution or on-disk shell receipt is simulated.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { nativeInventory, selectNativeExecution, nativeExecutionCall, matchingNativeOutput, assertNativeExecutionResult } from "./oca501-native-protocol.mjs";

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--request"));
const caseTag = "OCA501_CASE_offline", workdir = "/owned/workspace/offline";
const description = "text(value: unknown): void;\ndeclare const tools: { exec_command(args: { cmd: string; login?: boolean; workdir?: string; }): Promise<{ output: string; exit_code?: number; session_id?: number; }>; };";
const tool = { name: "exec", type: "custom", format: { type: "grammar", syntax: "lark", definition: "plain_source: SOURCE\nSOURCE: /.+/" }, description };
const request = { client_metadata: { thread_id: "offline-thread", turn_id: "offline-turn" }, input: [
  { type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [tool, { type: "function", name: "request_user_input", parameters: { type: "object" } }] }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>\n<cwd>${workdir}</cwd>\n</environment_context>` }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: `Goal:\n${caseTag}: harmless offline control` }] },
] };
const options = { transport: "native-codex", caseTag, workdir, ownedRoot: "/owned/workspace", callId: "oca501_exec_1", itemId: "msg_1", validate: () => ({ ok: true }) };
const call = nativeExecutionCall(request, options);
assert.equal(call.item.type, "custom_tool_call"); assert.equal(call.item.namespace, "functions"); assert.equal(call.item.name, "exec");
assert.ok(call.item.input.startsWith("const result = await tools.exec_command(")); assert.ok(call.item.input.endsWith("text(result);"));
assert.ok(!Object.hasOwn(call.item, "arguments")); assert.equal(call.args.workdir, workdir); assert.equal(call.args.login, false);
assert.equal(nativeInventory(request).find((entry) => entry.tool.name === "request_user_input").namespace, "functions");
const terminal = { exit_code: 0, output: "NATIVE-EXEC\n", wall_time_seconds: 0.1, chunk_id: "offline" };
const header = "Script completed\nWall time 0.1 seconds\nOutput:\n";
const output = { type: "custom_tool_call_output", call_id: call.callId, output: JSON.stringify(terminal) };
const receipt = "NATIVE-EXEC\n"; const negatives = [];
const refuse = (name, action) => { assert.throws(action, undefined, name); negatives.push(name); };
for (const encoding of [JSON.stringify(terminal), `${header}${JSON.stringify(terminal)}`, [{ type: "input_text", text: JSON.stringify(terminal) }], [{ type: "input_text", text: header }, { type: "input_text", text: JSON.stringify(terminal) }]]) {
  assert.deepEqual(assertNativeExecutionResult({ ...output, output: encoding }, call, receipt), terminal);
}
const followup = { client_metadata: request.client_metadata, input: [output] };
assert.equal(matchingNativeOutput(followup, call), output);
for (const [name, change] of [
  ["missing execution", (copy) => { copy.input[0].tools[0].tools.shift(); }],
  ["wrong namespace", (copy) => { copy.input[0].tools[0].name = "foreign"; }],
  ["wrong custom type", (copy) => { copy.input[0].tools[0].tools[0].type = "function"; }],
  ["absent nested declaration", (copy) => { copy.input[0].tools[0].tools[0].description = "exec_command mentioned without callable declaration"; }],
  ["missing cwd argument", (copy) => { copy.input[0].tools[0].tools[0].description = description.replace("workdir?: string;", ""); }],
  ["missing disposition declaration", (copy) => { copy.input[0].tools[0].tools[0].description = description.replace("exit_code?: number;", ""); }],
  ["wrong grammar", (copy) => { copy.input[0].tools[0].tools[0].format.syntax = "unknown"; }],
  ["empty grammar", (copy) => { copy.input[0].tools[0].tools[0].format.definition = ""; }],
  ["duplicate identity", (copy) => { copy.input[0].tools[0].tools.push(structuredClone(tool)); }],
  ["conflicting direct surface", (copy) => { copy.tools = [{ type: "function", name: "exec_command", parameters: { type: "object" } }]; }],
  ["untrusted role", (copy) => { copy.input[0].role = "user"; }],
  ["no inventory", (copy) => { copy.input.shift(); }],
  ["malformed tools", (copy) => { copy.input[0].tools = null; }],
]) { const copy = structuredClone(request); change(copy); refuse(name, () => nativeExecutionCall(copy, options)); }
for (const changed of [{ transport: "host-parent" }, { caseTag: "OCA501_CASE_foreign" }, { workdir: "/owned/workspace/foreign" }, { workdir: "/foreign" }]) refuse("case/workdir/transport mismatch", () => nativeExecutionCall(request, { ...options, ...changed }));
refuse("ambiguous case history", () => nativeExecutionCall({ ...request, input: [...request.input, { type: "message", role: "user", content: [{ type: "input_text", text: "OCA501_CASE_other: foreign case" }] }] }, options));
for (const field of ["thread_id", "turn_id"]) refuse(`foreign ${field}`, () => matchingNativeOutput({ ...followup, client_metadata: { ...request.client_metadata, [field]: "foreign" } }, call));
refuse("missing actual result", () => matchingNativeOutput({ ...followup, input: [] }, call));
refuse("duplicate actual result", () => matchingNativeOutput({ ...followup, input: [output, output] }, call));
for (const changed of [{ call_id: "other" }, { type: "function_call_output" }, { name: "other" }, { namespace: "other" }, { isError: true }, { success: false }, { status: "error" }, { error: "actual failure" }, { output: "NATIVE-EXEC" }, { output: null }, { output: [{ type: "input_image", image_url: "unknown" }] }, { output: [{ type: "input_text", text: "Script running with cell ID 1" }, { type: "input_text", text: JSON.stringify(terminal) }] }]) refuse("mismatched/error/malformed actual output", () => assertNativeExecutionResult({ ...output, ...changed }, call, receipt));
for (const changed of [{ status: "running" }, { status: "unknown" }, { success: "true" }]) refuse("unknown native status", () => assertNativeExecutionResult({ ...output, ...changed }, call, receipt));
for (const changed of [{ exit_code: 1 }, { exit_code: null }, { session_id: 1 }, { session_id: null }, { process_id: 1 }, { output: "no marker" }, { output: "NATIVE-EXEC\nextra" }, { error: "nested failure" }, { isError: true }, { success: false }]) refuse("nonterminal/failed nested execution", () => assertNativeExecutionResult({ ...output, output: JSON.stringify({ ...terminal, ...changed }) }, call, receipt));
for (const bytes of ["", "NATIVE-EXEC\nNATIVE-EXEC\n", "foreign"]) refuse("absent/duplicate/foreign shell receipt", () => assertNativeExecutionResult(output, call, bytes));
const directRequest = { ...request, input: request.input.slice(1), tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" }, login: { type: "boolean" }, workdir: { type: "string" } } } }] };
const direct = nativeExecutionCall(directRequest, options); assert.equal(direct.item.type, "function_call"); assert.equal(direct.item.name, "exec_command");
assert.deepEqual(assertNativeExecutionResult({ ...output, type: "function_call_output", output: "Chunk ID: offline\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nNATIVE-EXEC\n" }, direct, receipt), { exit_code: 0, output: receipt });
refuse("actual direct schema refusal", () => nativeExecutionCall(directRequest, { ...options, validate: () => ({ ok: false }) }));
refuse("yielded direct result", () => assertNativeExecutionResult({ ...output, type: "function_call_output", output: "Wall time: 0.1 seconds\nProcess running with session ID 1\nOutput:\nNATIVE-EXEC\n" }, direct, receipt));
let capturedRequest;
if (args.length) {
  const bytes = readFileSync(args[1]); const captured = JSON.parse(bytes).input;
  assert.equal(selectNativeExecution(captured).mode, "custom");
  const cwd = captured.input.filter((entry) => entry.type === "message" && entry.role === "user").flatMap((entry) => entry.content ?? []).find((entry) => entry.text?.startsWith("<environment_context>"))?.text.match(/<cwd>([^<]+)<\/cwd>/)?.[1];
  const actualOptions = { ...options, caseTag: "OCA501_CASE_H03-omit", workdir: cwd, ownedRoot: cwd.slice(0, cwd.lastIndexOf("/")) };
  const genuine = nativeExecutionCall(captured, actualOptions);
  assert.equal(genuine.item.namespace, "functions"); assert.equal(genuine.selected.tool.type, "custom");
  for (const [name, change] of [
    ["captured exec absent", (copy) => { copy.input[0].tools[0].tools.shift(); }],
    ["captured wrong namespace", (copy) => { copy.input[0].tools[0].name = "foreign"; }],
    ["captured wrong custom type", (copy) => { copy.input[0].tools[0].tools[0].type = "function"; }],
    ["captured missing nested declaration", (copy) => { copy.input[0].tools[0].tools[0].description = "undeclared"; }],
    ["captured duplicate exec", (copy) => { copy.input[0].tools[0].tools.push(structuredClone(copy.input[0].tools[0].tools[0])); }],
    ["captured missing grammar", (copy) => { delete copy.input[0].tools[0].tools[0].format; }],
    ["captured absent inventory", (copy) => { copy.input.shift(); }],
  ]) { const copy = structuredClone(captured); change(copy); refuse(name, () => nativeExecutionCall(copy, actualOptions)); }
  capturedRequest = { sha256: createHash("sha256").update(bytes).digest("hex"), scope: "Immutable actual R5 request inventory replay only; no native execution result claimed" };
}
console.log(JSON.stringify({ scope: "Offline native protocol assertions only; no host/native execution PASS", positiveGroups: 7 + (capturedRequest ? 1 : 0), negatives: negatives.length, capturedRequest }));
