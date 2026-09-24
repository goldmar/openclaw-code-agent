import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginConfig, setPluginConfig } from "../src/config";
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
    assert.equal(pluginConfig.harnesses.codex?.defaultModel, "gpt-6-sol");
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
