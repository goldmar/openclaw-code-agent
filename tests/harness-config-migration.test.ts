import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginConfig, setPluginConfig } from "../src/config";
import { Session } from "../src/session";
import { registerHarness, getHarness } from "../src/harness";
import { createFakeHarness } from "./helpers";
import { resolveAgentLaunchRequest } from "../src/tools/agent-launch-resolution";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "openclaw.plugin.json"), "utf8")) as {
  configSchema: { additionalProperties?: boolean; properties: Record<string, unknown> };
};

function resolve(harness: string, model?: string) {
  return resolveAgentLaunchRequest(
    { prompt: "Check migrated model policy", harness, model },
    { workspaceDir: "/tmp", oneShotCliRun: true },
    {},
  );
}

describe("harness model configuration", () => {
  afterEach(() => setPluginConfig({}));

  it("rejects the removed 4.x flat model keys through the host config schema", () => {
    // OpenClaw validates plugins.entries.<id>.config against configSchema before
    // loading the plugin; with additionalProperties=false a leftover key fails
    // with `must not have additional properties: "<key>"`.
    assert.equal(manifest.configSchema.additionalProperties, false);
    for (const removed of ["defaultModel", "model", "reasoningEffort", "allowedModels"]) {
      assert.equal(removed in manifest.configSchema.properties, false, `${removed} must not be accepted`);
    }
  });

  it("ignores removed flat model keys if a caller bypasses schema validation", () => {
    setPluginConfig({
      defaultHarness: "claude-code",
      defaultModel: "haiku",
      model: "gpt-5.5",
      reasoningEffort: "high",
      allowedModels: ["haiku", "gpt-5.5"],
    } as never);

    assert.equal(pluginConfig.harnesses["claude-code"]?.defaultModel, "opus");
    assert.deepEqual(pluginConfig.harnesses["claude-code"]?.allowedModels, ["sonnet", "opus"]);
    assert.equal(pluginConfig.harnesses.codex?.defaultModel, "gpt-6.1-sol");
    assert.equal("allowedModels" in pluginConfig, false);
    assert.equal(resolve("claude-code", "haiku").kind, "error");
  });

  it("applies explicit harness restrictions", () => {
    setPluginConfig({
      defaultHarness: "claude-code",
      harnesses: {
        codex: { defaultModel: "openai/gpt-6-astra", allowedModels: ["gpt-6-astra"] },
        "claude-code": { defaultModel: "sonnet", allowedModels: ["sonnet", "opus"] },
      },
    });

    const codex = resolve("codex");
    assert.equal(codex.kind, "resolved");
    if (codex.kind === "resolved") assert.equal(codex.resolvedModel, "gpt-6-astra");
    assert.equal(resolve("claude-code").kind, "resolved");
    assert.equal(resolve("claude-code", "opus").kind, "resolved");
    assert.equal(resolve("codex", "gpt-5.5").kind, "error");
    assert.equal(resolve("claude-code", "haiku").kind, "error");
  });

  it("distinguishes omitted restrictions from an explicit empty list", () => {
    setPluginConfig({});
    assert.equal(resolve("codex", "gpt-5.5").kind, "error");
    assert.equal(resolve("claude-code", "haiku").kind, "error");

    setPluginConfig({
      harnesses: { codex: { allowedModels: [] }, "claude-code": { allowedModels: [] } },
    });
    assert.equal(resolve("codex", "openai/gpt-5.5").kind, "resolved");
    assert.equal(resolve("claude-code", "haiku").kind, "resolved");
    // Removing model restrictions does not enable unsupported provider syntax.
    assert.equal(resolve("codex", "openai-codex/gpt-5.5").kind, "error");
    assert.equal(resolve("codex", "codex/gpt-5.5").kind, "error");
  });
});

describe("session model policy on native execution", () => {
  afterEach(() => setPluginConfig({}));

  for (const harness of ["codex", "claude-code"]) {
    it(`${harness} refuses a pinned model denied after suspension, before launching the backend`, async () => {
      const original = getHarness(harness);
      const backend = createFakeHarness(harness);
      registerHarness(backend);
      const allowed = harness === "codex" ? "gpt-6-sol" : "sonnet";
      try {
        setPluginConfig({ harnesses: { [harness]: { defaultModel: allowed, allowedModels: [allowed] } } });
        const session = new Session({ prompt: "resume", workdir: "/tmp", harness, model: allowed,
          resumeSessionId: "saved-conversation", permissionMode: "plan" }, "resume");
        setPluginConfig({ harnesses: { [harness]: { allowedModels: [harness === "codex" ? "gpt-6-astra" : "opus"] } } });
        await session.start();
        assert.equal(session.status, "failed");
        assert.match(session.error ?? "", /not allowed/);
        assert.equal(backend.lastLaunchOptions, undefined);
      } finally {
        registerHarness(original);
      }
    });

    it(`${harness} blocks follow-up execution after its model is revoked without blocking Stop`, async () => {
      const original = getHarness(harness);
      const backend = createFakeHarness(harness);
      registerHarness(backend);
      const model = harness === "codex" ? "gpt-6-sol" : "sonnet";
      const session = new Session({ prompt: "plan", workdir: "/tmp", harness, model,
        multiTurn: true, permissionMode: "plan" }, "revoked-followup");
      try {
        setPluginConfig({ harnesses: { [harness]: { allowedModels: [model] } } });
        await session.start();
        session.transition("running");
        setPluginConfig({ harnesses: { [harness]: { allowedModels: [harness === "codex" ? "gpt-6-astra" : "opus"] } } });
        await assert.rejects(session.sendMessage("implement"), /not allowed/);
        assert.deepEqual(backend.steerCalls, []);
        session.kill("user");
        assert.equal(session.status, "killed");
      } finally {
        session.kill("user");
        await session.waitForTeardown();
        registerHarness(original);
      }
    });

    it(`${harness} keeps an allowed provider-qualified model on internal resume`, async () => {
      const original = getHarness(harness);
      const backend = createFakeHarness(harness);
      registerHarness(backend);
      const model = harness === "codex" ? "gpt-6-sol" : "sonnet";
      const provider = harness === "codex" ? "openai" : "anthropic";
      const session = new Session({ prompt: "resume", workdir: "/tmp", harness, model: `${provider}/${model}`,
        resumeSessionId: "saved-conversation", permissionMode: "plan" }, "allowed-resume");
      try {
        setPluginConfig({ harnesses: { [harness]: { allowedModels: [model] } } });
        await session.start();
        assert.equal(backend.lastLaunchOptions?.model, model);
        assert.equal(backend.lastLaunchOptions?.resumeSessionId, "saved-conversation");
      } finally {
        session.kill("user");
        await session.waitForTeardown();
        registerHarness(original);
      }
    });
  }
});
