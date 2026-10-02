// Fixture protocol assertions only. These functions never execute native tools.
import assert from "node:assert/strict";
import { isAbsolute, relative, join } from "node:path";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const NATIVE_COMMAND = "printf 'NATIVE-EXEC\\n' | tee -a native-receipt.txt";
const completedScript = /^Script completed\nWall time \d+\.\d+ seconds\nOutput:\n$/;
const own = (value, key) => Object.hasOwn(value, key);

export function nativeInventory(request) {
  assert.ok(request && Array.isArray(request.input), "Actual native request has input items");
  const result = [];
  const visit = (tools, source, namespace) => {
    assert.ok(Array.isArray(tools), "Actual advertised native tools are an array");
    for (const tool of tools) {
      assert.ok(tool && typeof tool === "object" && !Array.isArray(tool), "Malformed actual native advertisement");
      if (tool.type === "namespace") {
        assert.equal(namespace, undefined, "Nested native tool namespaces are unsupported");
        assert.equal(typeof tool.name, "string"); assert.ok(tool.name.length);
        visit(tool.tools, source, tool.name);
      } else result.push({ source, namespace, tool });
    }
  };
  if (own(request, "tools")) visit(request.tools, "tools");
  for (const [index, entry] of request.input.entries()) {
    if (entry?.type !== "additional_tools") continue;
    assert.equal(entry.role, "developer", "Only actual developer additional_tools authorize native tools");
    visit(entry.tools, `input[${index}].additional_tools`);
  }
  return result;
}

export function selectNativeExecution(request) {
  const candidates = nativeInventory(request).filter(({ tool }) => ["exec", "exec_command", "shell_command"].includes(tool.name));
  assert.equal(candidates.length, 1, "Require one unambiguous actual native execution surface");
  const selected = candidates[0]; const { tool, namespace } = selected;
  if (tool.name === "exec") {
    assert.equal(namespace, "functions"); assert.equal(tool.type, "custom");
    assert.equal(tool.format?.type, "grammar"); assert.equal(tool.format.syntax, "lark");
    assert.equal(typeof tool.format.definition, "string");
    assert.ok(tool.format.definition.includes("plain_source: SOURCE") && tool.format.definition.includes("SOURCE:"), "Actual exec grammar accepts raw source");
    assert.equal(typeof tool.description, "string");
    const declaration = tool.description.match(/declare const tools: \{ exec_command\(args: \{([\s\S]*?)\}\): Promise<\{([\s\S]*?)\}>; \};/);
    assert.ok(declaration, "Actual custom exec declares nested tools.exec_command");
    for (const field of [/\bcmd: string;/, /\blogin\?: boolean;/, /\bworkdir\?: string;/]) assert.match(declaration[1], field);
    for (const field of [/\boutput: string;/, /\bexit_code\?: number;/, /\bsession_id\?: number;/]) assert.match(declaration[2], field);
    assert.ok(tool.description.includes("text(value:"), "Actual exec advertises its text result helper");
    return { ...selected, mode: "custom", outputType: "custom_tool_call_output" };
  }
  assert.equal(tool.type, "function", "Direct execution must really be an advertised function");
  assert.equal(namespace, undefined, "Only the existing direct execution identities are supported");
  assert.equal(tool.parameters?.type, "object", "Actual direct execution has its own argument schema");
  return { ...selected, mode: "function", outputType: "function_call_output" };
}

export function nativeExecutionCall(request, { transport, caseTag, workdir, ownedRoot, callId, itemId, validate }) {
  assert.equal(transport, "native-codex", "Parent model tools never authorize native execution");
  assert.match(caseTag, /^OCA501_CASE_[A-Za-z0-9_-]+$/);
  const userTexts = request.input.filter((entry) => entry?.type === "message" && entry.role === "user").flatMap((entry) => entry.content ?? []).filter((entry) => entry.type === "input_text").map((entry) => entry.text);
  assert.ok(userTexts.some((text) => text.includes(`${caseTag}:`)), "Actual native user goal belongs to the exact case");
  const tags = new Set(userTexts.flatMap((text) => text.match(/OCA501_CASE_[A-Za-z0-9_-]+:/g) ?? []));
  assert.deepEqual([...tags], [`${caseTag}:`], "Ambiguous native case history cannot authorize execution");
  assert.ok(isAbsolute(workdir) && isAbsolute(ownedRoot));
  const rel = relative(ownedRoot, workdir); assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), "Native action stays in this case's owned workdir");
  const environment = userTexts.filter((text) => text.startsWith("<environment_context>"));
  assert.ok(environment.length); assert.equal(environment.at(-1).match(/<cwd>([^<]+)<\/cwd>/)?.[1], workdir, "Current actual native cwd matches the case");
  const identity = {};
  for (const field of ["thread_id", "turn_id"]) { assert.equal(typeof request.client_metadata?.[field], "string"); assert.ok(request.client_metadata[field]); identity[field] = request.client_metadata[field]; }
  assert.match(callId, /^oca501_exec_\d+$/); assert.equal(typeof itemId, "string");
  const selected = selectNativeExecution(request);
  const args = selected.tool.name === "shell_command" ? { command: NATIVE_COMMAND, workdir } : { cmd: NATIVE_COMMAND, login: false, workdir };
  const item = selected.mode === "custom"
    ? { id: itemId, type: "custom_tool_call", call_id: callId, namespace: selected.namespace, name: selected.tool.name, input: `const result = await tools.exec_command(${JSON.stringify(args)});\ntext(result);` }
    : { id: itemId, type: "function_call", call_id: callId, name: selected.tool.name, arguments: JSON.stringify(args) };
  if (selected.mode === "function") {
    assert.equal(typeof validate, "function");
    const validity = validate({ schema: selected.tool.parameters, value: args });
    assert.equal(validity.ok, true, "The actual advertised direct schema authorizes these safe arguments");
  }
  return { item, selected, args, caseTag, workdir, callId, identity };
}

function outputText(value, custom) {
  if (typeof value === "string") {
    if (custom && value.startsWith("Script ")) {
      const boundary = value.indexOf("Output:\n") + "Output:\n".length;
      assert.match(value.slice(0, boundary), completedScript, "Yielded/failed native script is not terminal proof");
      return value.slice(boundary);
    }
    return value;
  }
  assert.ok(Array.isArray(value) && value.length >= 1 && value.length <= 2, "Use official text/content native output encoding");
  for (const item of value) { assert.equal(item?.type, "input_text"); assert.equal(typeof item.text, "string"); }
  if (value.length === 2) { assert.equal(custom, true); assert.match(value[0].text, completedScript); }
  return value.at(-1).text;
}

export function matchingNativeOutput(request, call) {
  assert.ok(Array.isArray(request.input));
  for (const [field, value] of Object.entries(call.identity)) assert.equal(request.client_metadata?.[field], value, "Native result belongs to the original actual conversation/turn");
  const outputs = request.input.filter((entry) => ["function_call_output", "custom_tool_call_output"].includes(entry?.type) && entry.call_id === call.callId);
  assert.equal(outputs.length, 1, "Require the one actual matching native result");
  return outputs[0];
}

export function assertNativeExecutionResult(output, call, receipt) {
  assert.equal(output.call_id, call.callId); assert.equal(output.type, call.selected.outputType);
  if (own(output, "name")) assert.equal(output.name, call.selected.tool.name);
  if (own(output, "namespace")) assert.equal(output.namespace, call.selected.namespace);
  assert.ok(!output.isError && !output.error && (!own(output, "success") || output.success === true) && (!own(output, "status") || output.status === "completed"), "Actual native error/unknown status cannot prove execution");
  const text = outputText(output.output, call.selected.mode === "custom");
  let result;
  try { result = JSON.parse(text); } catch (error) {
    assert.equal(call.selected.mode, "function", "Custom native exec must return its actual nested executor object");
    // Pinned unified_exec.rs's terminal text encoding; running/truncated output is refused.
    const match = text.match(/^(?:Chunk ID: [^\n]+\n)?Wall time: \d+(?:\.\d+)? seconds\nProcess exited with code (-?\d+)\n(?:Original token count: \d+\n)?Output:\n?([\s\S]*)$/);
    assert.ok(match, "Unknown actual direct executor disposition is BLOCKED");
    result = { exit_code: Number(match[1]), output: match[2] };
  }
  assert.ok(result && typeof result === "object" && !Array.isArray(result), "Actual executor returned an object");
  assert.ok(!result.isError && !result.error && (!own(result, "success") || result.success === true) && (!own(result, "status") || result.status === "completed"));
  const exitCode = result.exit_code ?? (call.selected.tool.name === "shell_command" ? result.metadata?.exit_code : undefined);
  assert.equal(exitCode, 0, "Actual command completed successfully");
  assert.equal(own(result, "session_id"), false, "A live/yielded native command is not completed");
  assert.equal(own(result, "process_id"), false);
  assert.equal(typeof result.output, "string"); assert.equal(result.output, "NATIVE-EXEC\n", "Actual stdout is the exact native receipt marker");
  assert.equal(receipt, "NATIVE-EXEC\n", "Owned native shell receipt was written exactly once");
  return result;
}

// Only external model outputs are simulated. All advertised tools execute in Codex.
export async function responsesFixture({ root, model, key, validate, observeNative }) {
  const cases = new Map(), requests = [], failures = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST"); assert.ok(["/v1/responses", "/host/v1/responses"].includes(req.url));
      let bytes = Buffer.alloc(0);
      for await (const chunk of req) { bytes = Buffer.concat([bytes, chunk]); assert.ok(bytes.length <= 4 * 1024 * 1024); }
      const input = JSON.parse(bytes.toString("utf8")); assert.equal(input.model, model); assert.equal(input.stream, true);
      const native = req.url === "/v1/responses", index = requests.length + 1;
      if (!native) assert.equal(req.headers.authorization, `Bearer ${key}`);
      const record = { index, native, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), responseId: `resp_${index}`, completed: false };
      requests.push(record);
      let text = `OCA501 parent receipt resp_${index}`, item;
      if (native) {
        const texts = input.input.filter(e => e.type === "message" && e.role === "user").flatMap(e => e.content ?? []).filter(e => e.type === "input_text").map(e => e.text);
        const tags = new Set(texts.flatMap(t => t.match(/OCA501_CASE_[A-Za-z0-9_-]+:/g) ?? []));
        assert.equal(tags.size, 1); const fixture = cases.get([...tags][0].slice(0, -1)); assert.ok(fixture);
        const identity = input.client_metadata; assert.ok(identity?.thread_id && identity?.turn_id);
        if (fixture.threadId) assert.equal(identity.thread_id, fixture.threadId); else fixture.threadId = identity.thread_id;
        record.case = fixture.tag; record.threadId = identity.thread_id; record.turnId = identity.turn_id;
        const cwd = texts.filter(t => t.startsWith("<environment_context>")).at(-1)?.match(/<cwd>([^<]+)<\/cwd>/)?.[1]; assert.equal(cwd, fixture.workdir);
        record.owner = await observeNative(fixture, record);
        if (fixture.hold && !fixture.held) {
          fixture.held = record; await new Promise(done => res.once("close", done));
          assert.equal(fixture.shutdownExpected, true); record.deliberatelyAborted = true; return;
        }
        text = fixture.ralph ? "<promise>DONE</promise>" : "OCA501 native execution complete";
        if (!fixture.call) { fixture.call = nativeExecutionCall(input, { transport: "native-codex", caseTag: fixture.tag, workdir: fixture.workdir, ownedRoot: root, callId: `oca501_exec_${index}`, itemId: `msg_${index}`, validate }); item = fixture.call.item; record.call = { id: fixture.call.callId, type: item.type, name: item.name, advertisedSource: fixture.call.selected.source }; }
        else { assertNativeExecutionResult(matchingNativeOutput(input, fixture.call), fixture.call, readFileSync(join(fixture.workdir, "native-receipt.txt"), "utf8")); fixture.executed = true; record.executionExit = 0; record.matchedCallId = fixture.call.callId; record.receiptSha256 = createHash("sha256").update(readFileSync(join(fixture.workdir, "native-receipt.txt"))).digest("hex"); }
      }
      item ??= { id: `msg_${index}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [], logprobs: [] }] };
      const base = { id: record.responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "in_progress", output: [], error: null, incomplete_details: null };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); let sequence = 0;
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
      event("response.created", { response: base });
      event("response.output_item.added", { output_index: 0, item: item.type === "message" ? { ...item, status: "in_progress", content: [] } : item });
      if (item.type === "message") {
        event("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [], logprobs: [] } });
        event("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: text, logprobs: [] });
        event("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text, logprobs: [] });
        event("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] }); record.text = text;
      }
      event("response.output_item.done", { output_index: 0, item });
      event("response.completed", { response: { ...base, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); res.end(); record.completed = true;
    } catch { failures.push("FIXTURE_PROTOCOL_FAILURE"); res.destroy(); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}`, cases, requests, failures, close: async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); } };
}
