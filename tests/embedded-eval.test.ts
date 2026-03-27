import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EmbeddedEvalService } from "../src/embedded-eval";

describe("EmbeddedEvalService", () => {
  it("runs embedded evaluation with tools disabled and parses strict JSON output", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const service = new EmbeddedEvalService({
      agent: {
        runEmbeddedPiAgent: async (params: Record<string, unknown>) => {
          capturedParams = params;
          return {
            payloads: [{ text: JSON.stringify({ classification: "user_question", reason: "clear user prompt" }) }],
          };
        },
      },
    } as any, 5_000);

    const result = await service.classify({
      task: "user_question",
      workspaceDir: "/tmp",
      prompt: "Investigate the rollout",
      turnText: "Which deployment window do you want me to use?",
      sessionName: "rollout-session",
    });

    assert.equal(result.classification, "user_question");
    assert.equal(result.reason, "clear user prompt");
    assert.equal(capturedParams?.disableTools, true);
    assert.equal(capturedParams?.timeoutMs, 5_000);
  });

  it("returns uncertain when the embedded run does not produce valid JSON", async () => {
    const service = new EmbeddedEvalService({
      agent: {
        runEmbeddedPiAgent: async () => ({
          payloads: [{ text: "not json" }],
        }),
      },
    } as any);

    const result = await service.classify({
      task: "plan_ready",
      workspaceDir: "/tmp",
      prompt: "Plan the fix",
      turnText: "Here is a plan.",
      sessionName: "plan-session",
    });

    assert.equal(result.classification, "uncertain");
    assert.equal(result.reason, "invalid_json");
  });
});
