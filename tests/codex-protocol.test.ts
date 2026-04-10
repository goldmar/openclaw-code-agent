import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTurnStartPayloads,
  classifyTerminalOutcome,
  codexExecutionPolicyForMode,
} from "../src/harness/codex-protocol";

describe("codex protocol turn payloads", () => {
  it("includes execution policy alongside plan collaboration mode", () => {
    const payloads = buildTurnStartPayloads({
      threadId: "thread-1",
      prompt: "Plan the work",
      model: "gpt-5.4",
      reasoningEffort: "medium",
      permissionMode: "plan",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    assert.deepEqual(payloads[0], {
      threadId: "thread-1",
      input: [{ type: "text", text: "Plan the work" }],
      model: "gpt-5.4",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.4",
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
      model: "gpt-5.4",
      permissionMode: "bypassPermissions",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    assert.deepEqual(payloads[0], {
      threadId: "thread-2",
      input: [{ type: "text", text: "Implement it" }],
      model: "gpt-5.4",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.4",
          developerInstructions: null,
        },
      },
    });
  });

  it("forwards Codex system prompts through collaboration-mode developer instructions", () => {
    const payloads = buildTurnStartPayloads({
      threadId: "thread-3",
      prompt: "Implement it",
      model: "gpt-5.4",
      systemPrompt: "Follow OpenClaw orchestration rules.",
      permissionMode: "default",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    assert.deepEqual(payloads[0], {
      threadId: "thread-3",
      input: [{ type: "text", text: "Implement it" }],
      model: "gpt-5.4",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.4",
          developerInstructions: "Follow OpenClaw orchestration rules.",
        },
      },
    });

    assert.deepEqual(payloads[1], {
      threadId: "thread-3",
      input: [{ type: "text", text: "Implement it" }],
      model: "gpt-5.4",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      collaboration_mode: {
        mode: "default",
        settings: {
          model: "gpt-5.4",
          developer_instructions: "Follow OpenClaw orchestration rules.",
        },
      },
    });
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
