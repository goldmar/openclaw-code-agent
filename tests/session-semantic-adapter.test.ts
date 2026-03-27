import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionSemanticAdapter } from "../src/session-semantic-adapter";

describe("SessionSemanticAdapter", () => {
  it("returns complete for non-Codex harnesses without invoking semantic classification", async () => {
    let called = false;
    const adapter = new SessionSemanticAdapter({
      classify: async () => {
        called = true;
        return { classification: "uncertain" };
      },
    } as any);

    const decision = await adapter.classifyTurnBoundary({
      sessionId: "s1",
      sessionName: "session",
      prompt: "do work",
      workdir: "/tmp",
      harnessName: "claude-code",
      permissionMode: "default",
      currentPermissionMode: "default",
      turnText: "Should I continue?",
    });

    assert.equal(decision, "complete");
    assert.equal(called, false);
  });

  it("returns awaiting_plan_decision when plan classification is positive", async () => {
    const adapter = new SessionSemanticAdapter({
      classify: async ({ task }: { task: string }) => ({
        classification: task === "plan_ready" ? "plan_ready" : "none",
      }),
    } as any);

    const decision = await adapter.classifyTurnBoundary({
      sessionId: "s2",
      sessionName: "session",
      prompt: "do work",
      workdir: "/tmp",
      harnessName: "codex",
      permissionMode: "default",
      currentPermissionMode: "default",
      turnText: "Plan:\n1. Inspect\n2. Patch\nShould I proceed?",
    });

    assert.equal(decision, "awaiting_plan_decision");
  });

  it("returns awaiting_user_input when question classification is positive", async () => {
    const adapter = new SessionSemanticAdapter({
      classify: async ({ task }: { task: string }) => ({
        classification: task === "user_question" ? "user_question" : "none",
      }),
    } as any);

    const decision = await adapter.classifyTurnBoundary({
      sessionId: "s3",
      sessionName: "session",
      prompt: "do work",
      workdir: "/tmp",
      harnessName: "codex",
      permissionMode: "default",
      currentPermissionMode: "default",
      turnText: "I found two possible fixes. Which one do you want?",
    });

    assert.equal(decision, "awaiting_user_input");
  });

  it("passes through no-change deliverable classification", async () => {
    const adapter = new SessionSemanticAdapter({
      classify: async () => ({ classification: "report_worthy_no_change", reason: "substantive findings" }),
    } as any);

    const result = await adapter.classifyNoChangeDeliverable({
      harnessName: "codex",
      sessionName: "session",
      prompt: "investigate",
      workdir: "/tmp",
      outputText: "Findings:\nThis is substantive.",
    });

    assert.equal(result.classification, "report_worthy_no_change");
    assert.equal(result.reason, "substantive findings");
  });
});
