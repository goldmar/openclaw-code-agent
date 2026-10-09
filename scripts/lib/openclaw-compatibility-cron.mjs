import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

/** Controlled provider transport; runs actual host scheduling/tools without model quota. */
export async function createCronCompatibilityProvider() {
  const observations = [];
  const failures = [];
  let expectedTool;
  const server = createServer(async (request, response) => {
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
      const isProbe = body.model === "oca-compatibility";
      const names = (body.tools ?? []).map((tool) => tool.function?.name);
      const lastUser = body.messages.findLastIndex((message) => message.role === "user");
      const result = body.messages.slice(lastUser + 1).find((message) => message.role === "tool");
      const advertised = names.includes("agent_stats");
      const dispatcher = names.includes("tool_call");
      if (isProbe) {
        assert.ok(dispatcher || advertised === (expectedTool === "agent_stats"), "require a usable host tool interface");
        assert.ok(names.every((name) => !name?.startsWith("agent_") || name === expectedTool));
      }
      let delta = { role: "assistant", content: "OCA_CRON_EMPTY_CAP_OK" };
      let finish = "stop";
      if (isProbe && (advertised || dispatcher) && !result) {
        delta = { role: "assistant", tool_calls: [{ index: 0, id: `call_${randomUUID()}`,
          type: "function", function: { name: dispatcher ? "tool_call" : "agent_stats",
            arguments: dispatcher ? JSON.stringify({ id: "agent_stats", args: {} }) : "{}" } }] };
        finish = "tool_calls";
        observations.push({ kind: "tool-request", names });
      } else if (result) {
        const call = body.messages.slice(lastUser + 1).flatMap((message) => message.tool_calls ?? [])
          .find((entry) => entry.id === result.tool_call_id);
        assert.equal(call?.function?.name, dispatcher ? "tool_call" : "agent_stats", "tool result must match its actual advertised call");
        if (expectedTool) {
          assert.ok(result.content && !String(result.content).includes("Error:"), "actual OCA tool must return initialized metrics");
          if (dispatcher) {
            const envelope = JSON.parse(result.content);
            assert.equal(envelope.tool.name, "agent_stats");
            assert.ok(envelope.result.content?.some((entry) => entry.type === "text" && entry.text.trim()));
            assert.ok(!envelope.result.isError);
          }
          observations.push({ kind: "tool-result", names });
        } else {
          assert.match(String(result.content), /Unknown tool (?:id|name)/iu, "empty cron cap must reject dispatch to OCA");
          observations.push({ kind: "tool-denied", names });
        }
        delta = { role: "assistant", content: "OCA_CRON_TOOL_RESULT_OK" };
      } else {
        if (isProbe) observations.push({ kind: "no-tools", names });
      }
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
    } catch (error) {
      failures.push(error instanceof assert.AssertionError ? error.message : "invalid controlled provider request");
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
    async check(call, rpc) {
      for (const allowTool of [true, false]) {
        expectedTool = allowTool ? "agent_stats" : undefined;
        const before = observations.length;
        const job = await rpc("cron.add", { name: `oca-compat-${randomUUID()}`,
          schedule: { kind: "at", at: new Date(Date.now() + 86400000).toISOString() },
          sessionTarget: "isolated", wakeMode: "now", deleteAfterRun: false,
          payload: { kind: "agentTurn", message: "Check OCA metrics once if granted; otherwise reply without tools.",
            toolsAllow: allowTool ? ["agent_stats"] : [] }, delivery: { mode: "none" },
        });
        try {
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
          const actual = observations.slice(before);
          const dispatched = actual.some((entry) => entry.names.includes("tool_call"));
          assert.equal(actual.filter((entry) => entry.kind === "tool-request").length, allowTool || dispatched ? 1 : 0);
          assert.equal(actual.filter((entry) => entry.kind === "tool-result").length, allowTool ? 1 : 0);
          assert.equal(actual.filter((entry) => entry.kind === "tool-denied").length, !allowTool && dispatched ? 1 : 0);
          assert.ok(actual.length > 0);
          assert.deepEqual(failures, []);
          const after = await rpc("tools.invoke", { name: "agent_stats", sessionKey: "agent:main:compatibility-qa", args: {} });
          assert.equal(after.ok, true, "Gateway's OCA service must survive cron runtime retirement");
          assert.ok(!after.output?.isError);
          assert.ok(!after.output?.content?.some((item) => item.type === "text" && item.text.includes("Error:")));
        } finally {
          await rpc("cron.remove", { id: job.id });
        }
      }
    },
    async close() { server.closeAllConnections(); await new Promise((done) => server.close(done)); },
  };
}
