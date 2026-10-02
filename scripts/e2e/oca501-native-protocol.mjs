// Fixture protocol assertions only. These functions never execute native tools.
import assert from "node:assert/strict";
import { isAbsolute, relative } from "node:path";

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
