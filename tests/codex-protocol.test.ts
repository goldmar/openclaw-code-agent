import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildThreadStartPayloads,
  buildThreadResumePayloads,
  buildPendingInputState,
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

  it("rejects top-level-only Codex request_user_input payloads with an explicit diagnostic", () => {
    assert.throws(() => buildPendingInputState("tool/requestUserInput", "req-legacy", {
      question: "Choose an environment",
      options: [{
        label: "Staging",
        description: "Use staging credentials.",
      }, "Production"],
    }), /Malformed Codex request_user_input payload for req-legacy: expected non-empty questions\[\]/);
  });

  it("defensively extracts observed nested Codex request_user_input questions and option metadata", () => {
    const state = buildPendingInputState("tool/requestUserInput", "req-questions", {
      questions: [{
        id: "confirm_path",
        header: "Confirm",
        question: "Proceed with the plan?",
        isOther: true,
        options: [{
          label: "Yes (Recommended)",
          description: "Continue the current plan.",
        }, {
          label: "No",
          description: "Stop and revisit the approach.",
        }],
      }],
    });

    assert.equal(state.kind, "question");
    assert.deepEqual(state.options, ["Yes (Recommended)", "No"]);
    assert.deepEqual(state.questions, [{
      id: "confirm_path",
      header: "Confirm",
      question: "Proceed with the plan?",
      options: [
        {
          label: "Yes (Recommended)",
          description: "Continue the current plan.",
          recommended: true,
        },
        {
          label: "No",
          description: "Stop and revisit the approach.",
          recommended: false,
        },
      ],
      allowsFreeText: true,
    }]);
    assert.match(state.promptText ?? "", /Confirm/);
    assert.match(state.promptText ?? "", /Yes \(Recommended\) - Continue the current plan\./);
    assert.match(state.promptText ?? "", /Free-form answer is allowed\./);
  });

  it("starts multiple observed nested Codex request_user_input questions at the first wizard step", () => {
    const state = buildPendingInputState("tool/requestUserInput", "req-multi", {
      questions: [{
        id: "environment",
        header: "Environment",
        question: "Which environment should I target?",
        options: [
          { label: "Staging", description: "Use staging credentials." },
          { label: "Production", description: "Use production credentials." },
        ],
      }, {
        id: "scope",
        header: "Scope",
        question: "How broad should the rollout be?",
        options: [
          { label: "Canary", description: "Start with a small cohort." },
          { label: "Everyone", description: "Roll out to all users." },
        ],
      }],
    });

    assert.deepEqual(state.options, ["Staging", "Production"]);
    assert.equal(state.questions?.length, 2);
    assert.equal(state.activeQuestionIndex, 0);
    assert.match(state.promptText ?? "", /Question 1 - Environment/);
    assert.doesNotMatch(state.promptText ?? "", /Question 2 - Scope/);
  });

  it("tolerates sparse Codex nested question fields as the protocol evolves", () => {
    const state = buildPendingInputState("tool/requestUserInput", "req-sparse", {
      questions: [{
        prompt: "Provide a branch name",
        options: [
          { label: "main" },
          { text: "Other", isOther: true },
        ],
      }],
    });

    assert.equal(state.kind, "question");
    assert.deepEqual(state.options, ["main", "Other"]);
    assert.equal(state.questions?.[0]?.id, "question_1");
    assert.equal(state.questions?.[0]?.question, "Provide a branch name");
    assert.equal(state.questions?.[0]?.options[1]?.isOther, true);
    assert.equal(state.questions?.[0]?.allowsFreeText, true);
  });
});
