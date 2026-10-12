import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

/** Controlled provider transport; runs actual host scheduling/tools without model quota. */
export async function createCronCompatibilityProvider() {
  // Each scheduled turn owns immutable expectations and its own collector.
  // Background turns and late requests from a removed job are not probe evidence.
  const probesByMarker = new Map();
  const server = createServer(async (request, response) => {
    let probe;
    try {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: ["oca-compatibility", "oca-title"].map((id) =>
          ({ id, object: "model", owned_by: "fixture" })) }));
        return;
      }
      assert.equal(request.url, "/v1/chat/completions");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const lastUser = body.messages.findLastIndex((message) => message.role === "user");
      const userContent = body.messages[lastUser]?.content;
      const userText = typeof userContent === "string" ? userContent
        : (Array.isArray(userContent) ? userContent.map((part) => part.text ?? "").join("\n") : "");
      const marker = userText.match(/\[OCA_CRON_PROBE:[0-9a-f-]+\]/u)?.[0];
      probe = body.model === "oca-compatibility" ? probesByMarker.get(marker) : undefined;
      if (!probe) {
        sendCompletion(response, body, { role: "assistant", content: "OCA_CRON_BACKGROUND_OK" }, "stop");
        return;
      }
      const { expectedTool, permittedTools, toolArgs, observations, failures } = probe;
      const names = (body.tools ?? []).map((tool) => tool.function?.name);
      const result = body.messages.slice(lastUser + 1).find((message) => message.role === "tool");
      const advertised = names.includes(expectedTool);
      const dispatcher = names.includes("tool_call");
      assert.ok(dispatcher || advertised === permittedTools.includes(expectedTool), "require a usable host tool interface");
      assert.ok(names.every((name) => !name?.startsWith("agent_") || permittedTools.includes(name)));
      if (!dispatcher) {
        assert.equal(names.includes("agent_send_plan_offer"), permittedTools.includes("agent_send_plan_offer"));
      }
      let delta = { role: "assistant", content: "OCA_CRON_EMPTY_CAP_OK" };
      let finish = "stop";
      if (!result) {
        delta = { role: "assistant", tool_calls: [{ index: 0, id: `call_${randomUUID()}`,
          type: "function", function: { name: dispatcher ? "tool_call" : expectedTool,
            arguments: JSON.stringify(dispatcher ? { id: expectedTool, args: toolArgs } : toolArgs) } }] };
        finish = "tool_calls";
        observations.push({ kind: "tool-request", names, callId: delta.tool_calls[0].id });
      } else {
        const call = body.messages.slice(lastUser + 1).flatMap((message) => message.tool_calls ?? [])
          .find((entry) => entry.id === result.tool_call_id);
        assert.equal(call?.function?.name, dispatcher ? "tool_call" : expectedTool, "tool result must match its actual advertised call");
        if (permittedTools.includes(expectedTool)) {
          let output = result.content;
          if (dispatcher) {
            const envelope = JSON.parse(result.content);
            assert.equal(envelope.tool.name, expectedTool);
            output = envelope.result;
            assert.ok(!output.isError);
            assert.ok(output.content?.some((entry) => entry.type === "text" && entry.text.trim()));
          }
          if (expectedTool === "agent_send_plan_offer") {
            // Valid inputs with no delivery route prove admission and execution
            // without sending a message or starting a coding session.
            const text = typeof output === "string" ? output : JSON.stringify(output);
            assert.match(text, /Error: Could not resolve a direct delivery route for the plan offer\./u);
          } else {
            assert.ok(output && !JSON.stringify(output).includes("Error:"), "actual OCA tool must return initialized metrics");
          }
          observations.push({ kind: "tool-result", names, callId: result.tool_call_id });
        } else {
          assert.match(String(result.content), /Unknown tool (?:id|name)|Tool [^\n]*not found/iu,
            "cron cap must reject dispatch to the requested OCA tool");
          observations.push({ kind: "tool-denied", names, callId: result.tool_call_id });
        }
        delta = { role: "assistant", content: "OCA_CRON_TOOL_RESULT_OK" };
      }
      sendCompletion(response, body, delta, finish);
    } catch (error) {
      probe?.failures.push(error instanceof assert.AssertionError ? error.message : "invalid controlled provider request");
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "compatibility fixture rejected request" } }));
    }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const model = "oca-compatibility";
  return {
    configure(config) {
      config.agents.defaults = { ...config.agents.defaults, skipBootstrap: true,
        model: { primary: `oca-fixture/${model}` }, utilityModel: "oca-fixture/oca-title" };
      config.tools = { codeMode: false };
      config.models = { mode: "replace", providers: { "oca-fixture": {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "isolated-fixture",
        api: "openai-completions", agentRuntime: { id: "openclaw" }, request: { allowPrivateNetwork: true },
        models: [model, "oca-title"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000,
          maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
      } } };
    },
    async check(call, rpc, { offerEnabled = false } = {}) {
      const probes = [
        { tool: "agent_stats", toolsAllow: ["agent_stats"], args: {} },
        { tool: "agent_stats", toolsAllow: [], args: {} },
        ...(offerEnabled ? [true, false].map((allowed) => ({
          tool: "agent_send_plan_offer", toolsAllow: allowed ? ["agent_send_plan_offer"] : ["agent_stats"],
          args: { offer_id: "oca-compatibility", offer_text: "Compatibility probe", plan_prompt: "Do not launch",
            plan_workdir: "." },
        })) : []),
      ];
      for (const probe of probes) {
        const marker = `[OCA_CRON_PROBE:${randomUUID()}]`;
        const { tool: expectedTool, toolsAllow: permittedTools, args: toolArgs } = probe;
        const observations = [];
        const failures = [];
        probesByMarker.set(marker, { expectedTool, permittedTools, toolArgs, observations, failures });
        const allowTool = permittedTools.includes(expectedTool);
        let job;
        try {
          job = await rpc("cron.add", { name: `oca-compat-${randomUUID()}`,
            schedule: { kind: "at", at: new Date(Date.now() + 86400000).toISOString() },
            sessionTarget: "isolated", wakeMode: "now", deleteAfterRun: false,
            payload: { kind: "agentTurn", message: `${marker} Run the controlled OCA tool admission probe once, then finish.`,
              toolsAllow: permittedTools }, delivery: { mode: "none" },
          });
          let terminal;
          try {
            terminal = await call("cron", "run", job.id, "--wait", "--wait-timeout", "2m", "--json");
          } catch (error) {
            if (failures.length) throw new Error(`controlled provider rejected request: ${failures.join("; ")}`);
            throw error;
          }
          const result = JSON.parse(terminal.stdout);
          assert.equal(result.completed, true, "require a scheduler terminal result");
          assert.equal(result.status, "ok");
          assert.equal(result.run.completionStatus, "succeeded");
          assert.ok(result.run.runId && result.run.sessionKey, "terminal cron result must identify its run and session");
          const actual = observations;
          const diagnostic = `cron probe ${expectedTool} (${allowTool ? "allowed" : "denied"}): `
            + JSON.stringify(actual.map(({ kind, callId }) => ({ kind, callId })));
          assert.equal(actual.filter((entry) => entry.kind === "tool-request").length, 1, diagnostic);
          assert.equal(actual.filter((entry) => entry.kind === "tool-result").length, allowTool ? 1 : 0, diagnostic);
          assert.equal(actual.filter((entry) => entry.kind === "tool-denied").length, allowTool ? 0 : 1, diagnostic);
          assert.ok(actual.length > 0);
          assert.deepEqual(failures, []);
          const after = await rpc("tools.invoke", { name: "agent_stats", sessionKey: "agent:main:compatibility-qa", args: {} });
          assert.equal(after.ok, true, "Gateway's OCA service must survive cron runtime retirement");
          assert.ok(!after.output?.isError);
          assert.ok(!after.output?.content?.some((item) => item.type === "text" && item.text.includes("Error:")));
        } finally {
          probesByMarker.delete(marker);
          if (job) await rpc("cron.remove", { id: job.id });
        }
      }
    },
    async close() { server.closeAllConnections(); await new Promise((done) => server.close(done)); },
  };
}

/** Return a deterministic completion without borrowing another turn's expectations. */
function sendCompletion(response, body, delta, finish) {
  const base = { id: `chatcmpl-${randomUUID()}`, created: 0, model: body.model,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  } else {
    const { tool_calls: calls, ...message } = delta;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...base, object: "chat.completion",
      choices: [{ index: 0, message: { ...message, ...(calls ? {
        tool_calls: calls.map(({ index: _index, ...call }) => call),
      } : {}) }, finish_reason: finish }] }));
  }
}
