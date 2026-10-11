import "./test-env";
import assert from "node:assert/strict";
import { it } from "node:test";
import { makeAgentSendPlanOfferTool } from "../src/tools/agent-send-plan-offer";
import { setPluginConfig } from "../src/config";
import { setSessionManager } from "../src/singletons";
import type { SessionManager } from "../src/session-manager";
import { createCronCompatibilityProvider } from "../scripts/lib/openclaw-compatibility-cron.mjs";

async function runProbe(dispatcher: boolean, offerResult?: string) {
  setPluginConfig({});
  setSessionManager({ sendPlanOffer() { throw new Error("The probe must not queue a notification"); } } as unknown as SessionManager);
  const provider = await createCronCompatibilityProvider();
  const config = { agents: { defaults: {} } } as any;
  provider.configure(config);
  const endpoint = config.models.providers["oca-fixture"].baseUrl + "/chat/completions";
  let job: any;
  const calls: Array<{ tool: string; allowed: boolean; args: unknown }> = [];
  const request = async (body: unknown) => {
    const response = await fetch(endpoint, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return (await response.json() as any).choices[0].message;
  };
  try {
    await provider.check(async () => {
      const names = dispatcher ? ["tool_call"] : job.payload.toolsAllow;
      const body = { model: "oca-compatibility", tools: names.map((name: string) => ({ function: { name } })),
        messages: [{ role: "user", content: job.payload.message }] };
      const assistant = await request(body);
      const call = assistant.tool_calls[0];
      const args = JSON.parse(call.function.arguments);
      const tool = dispatcher ? args.id : call.function.name;
      const allowed = job.payload.toolsAllow.includes(tool);
      calls.push({ tool, allowed, args: dispatcher ? args.args : args });
      const output = tool === "agent_stats"
        ? { content: [{ type: "text", text: "Initialized metrics" }] }
        : offerResult !== undefined ? { content: [{ type: "text", text: offerResult }] }
          : await makeAgentSendPlanOfferTool({ workspaceDir: ".", sessionKey: "agent:main:cron:fixture" })
            .execute("fixture-call", dispatcher ? args.args : args);
      const content = allowed
        ? JSON.stringify(dispatcher ? { tool: { name: tool }, result: output } : output)
        : `Error: Unknown tool ${dispatcher ? "id" : "name"}: ${tool}`;
      await request({ ...body, messages: [...body.messages, assistant,
        { role: "tool", tool_call_id: call.id, content }] });
      return { stdout: JSON.stringify({ completed: true, status: "ok",
        run: { completionStatus: "succeeded", runId: "fixture-run", sessionKey: "fixture-session" } }) };
    }, async (method: string, params: any) => {
      if (method === "cron.add") { job = params; return { id: "fixture-job" }; }
      if (method === "tools.invoke") return { ok: true, output: { content: [{ type: "text", text: "Initialized metrics" }] } };
      assert.equal(method, "cron.remove");
    }, { offerEnabled: true });
    return calls;
  } finally {
    await provider.close();
    setSessionManager(null);
    setPluginConfig({});
  }
}

it("invokes Start Plan under allowed and denied caps through either host tool interface", async () => {
  for (const dispatcher of [false, true]) {
    const calls = await runProbe(dispatcher);
    assert.deepEqual(calls.map(({ tool, allowed }) => ({ tool, allowed })), [
      { tool: "agent_stats", allowed: true }, { tool: "agent_stats", allowed: false },
      { tool: "agent_send_plan_offer", allowed: true }, { tool: "agent_send_plan_offer", allowed: false },
    ]);
    for (const call of calls.filter(({ tool }) => tool === "agent_send_plan_offer")) {
      assert.deepEqual(call.args, { offer_id: "oca-compatibility", offer_text: "Compatibility probe",
        plan_prompt: "Do not launch", plan_workdir: "." });
    }
  }
});

it("rejects a generic Start Plan execution error even when the scheduler succeeds", async () => {
  await assert.rejects(runProbe(true, "Error: SessionManager not initialized."));
});
