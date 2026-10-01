import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "../index";
import { AutoUpdateService } from "../src/auto-update";
import { resolveAllowedModelsForHarness, setPluginConfig } from "../src/config";
import { getSharedRuntime, resetSharedRuntimeSlotForTests } from "../src/process-runtime";
import { setPluginRuntime } from "../src/runtime-store";
import { sessionManager } from "../src/singletons";
import { makeAgentRuntimePolicyTool, readCodexRuntimePolicy } from "../src/tools/agent-runtime-policy";
import { createFakeHost, type FakeHost } from "./fake-host";

type PolicyResult = { isError?: boolean; content: Array<{ text: string }> };
const hosts: FakeHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  resetSharedRuntimeSlotForTests();
  setPluginRuntime(undefined);
  setPluginConfig({});
});

function readPolicy(result: unknown) {
  return JSON.parse((result as PolicyResult).content[0].text);
}

describe("loaded runtime policy diagnostic", () => {
  it("reads current loaded launch policy, copies lists, and exposes only allowlisted fields", async () => {
    const tool = makeAgentRuntimePolicyTool(readCodexRuntimePolicy);
    setPluginConfig({
      defaultWorkdir: "/private/repository",
      harnesses: { codex: { defaultModel: "gpt-6.1-sol", allowedModels: ["gpt-6.1-sol"] } },
    });
    setPluginRuntime({});

    const policy = readPolicy(await tool.execute("read", {}));
    assert.deepEqual(policy, {
      schema: "openclaw-code-agent.runtime-policy.v1",
      ready: true,
      codex: { defaultModel: "gpt-6.1-sol", allowedModels: ["gpt-6.1-sol"] },
      managedTaskMirror: { available: false },
    });
    const snapshot = readCodexRuntimePolicy();
    assert.ok(snapshot.allowedModels);
    snapshot.allowedModels.push("changed-by-caller");
    assert.deepEqual(resolveAllowedModelsForHarness("codex"), ["gpt-6.1-sol"]);

    setPluginConfig({ harnesses: { codex: { defaultModel: "gpt-6-astra", allowedModels: [] } } });
    assert.deepEqual(readPolicy(await tool.execute("reread", {})).codex, {
      defaultModel: "gpt-6-astra", allowedModels: [],
    });
    setPluginConfig({ harnesses: { codex: { defaultModel: "gpt-6.1-sol" } } });
    assert.equal(readPolicy(await tool.execute("unrestricted", {})).codex.allowedModels, null);
    assert.equal(Reflect.get(tool.parameters, "additionalProperties"), false);
  });

  it("does not initialize a registered runtime or expose unbound defaults", async () => {
    const host = createFakeHost({ pluginConfig: { autoUpdate: false } });
    hosts.push(host);
    register(host.api);
    const before = host.logs.length;
    const tool = host.tool("agent_runtime_policy");
    const result = await tool.execute("unbound", {});
    assert.equal((result as PolicyResult).isError, true);
    assert.deepEqual(readPolicy(result), { schema: "openclaw-code-agent.runtime-policy.v1", ready: false });
    assert.equal(sessionManager, null);
    assert.equal(getSharedRuntime(), undefined);
    assert.equal(host.logs.length, before);
    assert.equal(host.llmCalls.length + host.durableSends.length, 0);
  });

  it("reads an existing owner without service, config, update, or task activity and rejects retired owners", async (t) => {
    const host = createFakeHost({ pluginConfig: {
      autoUpdate: true,
      harnesses: { codex: { defaultModel: "gpt-6.1-sol", allowedModels: ["gpt-6.1-sol"] } },
    } });
    hosts.push(host);
    register(host.api);
    let updateChecks = 0;
    t.mock.method(AutoUpdateService.prototype, "maybeCheckForUpdate", () => { updateChecks += 1; });
    const starting = host.startServices();
    assert.equal(readPolicy(await host.runTool("agent_runtime_policy", {})).ready, false);
    await starting;
    const currentManager = sessionManager;
    const checksBefore = updateChecks;
    t.mock.method(host.fakeRuntime.config, "current", () => {
      throw new Error("diagnostic must not reread runtime configuration");
    });
    const before = host.logs.length;
    const result = readPolicy(await host.runTool("agent_runtime_policy", {}));
    assert.equal(result.ready, true);
    assert.equal(result.managedTaskMirror.available, false);
    assert.equal(sessionManager, currentManager);
    assert.equal(updateChecks, checksBefore);
    assert.equal(host.logs.length, before);
    assert.equal(host.llmCalls.length + host.durableSends.length, 0);

    const stopping = host.stopServices();
    assert.equal(readPolicy(await host.runTool("agent_runtime_policy", {})).ready, false);
    await stopping;
    assert.equal(readPolicy(await host.runTool("agent_runtime_policy", {})).ready, false);
    await host.disposers[0]();
    assert.equal(readPolicy(await host.runTool("agent_runtime_policy", {})).ready, false);
  });
});

describe("removed native task mirror API", () => {
  it("reports unavailable without inspecting obsolete host surfaces", async () => {
    for (const runtime of [undefined, {}, { tasks: {} }, { tasks: { async: {} } }]) {
      setPluginRuntime(runtime);
      assert.equal(readPolicy(await makeAgentRuntimePolicyTool(readCodexRuntimePolicy).execute("read", {})).managedTaskMirror.available, false);
    }
    setPluginRuntime({ get tasks() { throw new Error("obsolete API must not be read"); } });
    assert.equal(readPolicy(await makeAgentRuntimePolicyTool(readCodexRuntimePolicy).execute("read", {})).managedTaskMirror.available, false);
  });
});
