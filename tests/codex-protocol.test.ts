import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildThreadStartPayloads,
  buildThreadResumePayloads,
  buildTurnStartPayloads,
  classifyTerminalOutcome,
  codexExecutionPolicyForMode,
} from "../src/harness/codex-protocol";

describe("codex protocol turn payloads", () => {
  it("uses current reasoningEffort naming on fresh thread-start payloads", () => {
    const payloads = buildThreadStartPayloads({
      cwd: "/tmp/project",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    assert.deepEqual(payloads[0], {
      cwd: "/tmp/project",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    assert.equal(payloads.length, 1);
    assert.equal(Object.hasOwn(payloads[0] as Record<string, unknown>, "reasoning_effort"), false);
  });

  it("maps Codex fastMode to service_tier fast without undocumented fast-mode payload fields", () => {
    const threadStart = buildThreadStartPayloads({
      cwd: "/tmp/project",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      fastMode: true,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const threadResume = buildThreadResumePayloads({
      threadId: "thread-1",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      fastMode: true,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const turnStart = buildTurnStartPayloads({
      threadId: "thread-1",
      prompt: "Ship it",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      fastMode: true,
      permissionMode: "plan",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    assert.equal((threadStart[0] as Record<string, unknown>).service_tier, "fast");
    assert.equal(threadResume[0].service_tier, "fast");
    assert.equal((turnStart[0] as Record<string, unknown>).service_tier, "fast");
    for (const payload of [...threadStart, ...threadResume, ...turnStart] as Array<Record<string, unknown>>) {
      assert.equal(Object.hasOwn(payload, "fastMode"), false);
      assert.equal(Object.hasOwn(payload, "fast_mode"), false);
    }
    assert.deepEqual((turnStart[0] as any).collaborationMode.settings, {
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      developerInstructions: null,
    });
    assert.equal(Object.hasOwn((turnStart[0] as any).collaborationMode.settings, "fastMode"), false);
    assert.equal(turnStart.length, 1);
  });

  it("includes execution policy alongside plan collaboration mode", () => {
    const payloads = buildTurnStartPayloads({
      threadId: "thread-1",
      prompt: "Plan the work",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      permissionMode: "plan",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    assert.deepEqual(payloads[0], {
      threadId: "thread-1",
      input: [{ type: "text", text: "Plan the work" }],
      model: "gpt-5.5",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.5",
          reasoningEffort: "medium",
          developerInstructions: null,
        },
      },
    });
  });

  it("includes execution policy for bypassPermissions implementation turns", () => {
    const payloads = buildTurnStartPayloads({
      threadId: "thread-2",
      prompt: "Implement it",
      model: "gpt-5.5",
      permissionMode: "bypassPermissions",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    assert.deepEqual(payloads[0], {
      threadId: "thread-2",
      input: [{ type: "text", text: "Implement it" }],
      model: "gpt-5.5",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.5",
          developerInstructions: null,
        },
      },
    });
  });

  it("forwards Codex system prompts through collaboration-mode developer instructions", () => {
    const payloads = buildTurnStartPayloads({
      threadId: "thread-3",
      prompt: "Implement it",
      model: "gpt-5.5",
      systemPrompt: "Follow OpenClaw orchestration rules.",
      permissionMode: "default",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    assert.deepEqual(payloads[0], {
      threadId: "thread-3",
      input: [{ type: "text", text: "Implement it" }],
      model: "gpt-5.5",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.5",
          developerInstructions: "Follow OpenClaw orchestration rules.",
        },
      },
    });
    assert.equal(payloads.length, 1);
  });

  it("defaults Codex execution policy to never so OpenClaw plan/default sessions do not fall back to on-request", () => {
    assert.deepEqual(codexExecutionPolicyForMode("plan"), {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    assert.deepEqual(codexExecutionPolicyForMode("default"), {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("keeps bypassPermissions on the same explicit execution policy instead of relying on upstream defaults", () => {
    assert.deepEqual(codexExecutionPolicyForMode("bypassPermissions"), {
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });

  it("classifies interrupted and cancelled Codex turn outcomes as interrupted, not failed", () => {
    assert.equal(
      classifyTerminalOutcome("turn/completed", { turn: { status: "interrupted" } }),
      "interrupted",
    );
    assert.equal(
      classifyTerminalOutcome("turn/cancelled", { turn: { status: "cancelled" } }),
      "interrupted",
    );
  });
});
