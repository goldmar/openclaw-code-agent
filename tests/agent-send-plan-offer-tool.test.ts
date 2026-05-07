import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAgentSendPlanOfferTool } from "../src/tools/agent-send-plan-offer";
import { setSessionManager } from "../src/singletons";

describe("agent_send_plan_offer tool", () => {
  afterEach(() => {
    setSessionManager(null);
  });

  it("returns an invalid-parameters error when required fields are missing", async () => {
    setSessionManager({} as any);
    const tool = makeAgentSendPlanOfferTool({ workspaceDir: "/tmp" } as any);
    const result = await tool.execute("tool-id", { offer_id: "plugin-readiness" });
    const text = (result as any).content?.[0]?.text ?? "";
    assert.match(text, /Invalid parameters/);
  });

  it("routes an interactive plan offer through SessionManager", async () => {
    const calls: Array<Record<string, unknown>> = [];
    setSessionManager({
      sendPlanOffer(args: Record<string, unknown>) {
        calls.push(args);
      },
    } as any);

    const tool = makeAgentSendPlanOfferTool({
      workspaceDir: "/tmp",
      messageChannel: "telegram",
      chatId: "-1003863755361",
      messageThreadId: 13832,
      sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
    } as any);
    const result = await tool.execute("tool-id", {
      offer_id: "plugin-readiness-v2026.5.7",
      offer_text: "Readiness report body",
      plan_prompt: "Plan the follow-up.",
      plan_workdir: "/home/openclaw/workspace/openclaw-code-agent",
      plan_worktree_strategy: "auto-pr",
      plan_name: "plugin-readiness-v2026.5.7",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.offerId, "plugin-readiness-v2026.5.7");
    assert.equal(calls[0]?.planWorktreeStrategy, "auto-pr");
    assert.equal((calls[0]?.route as { provider?: string })?.provider, "telegram");
    assert.equal((calls[0]?.route as { target?: string })?.target, "-1003863755361");
    assert.equal((calls[0]?.route as { threadId?: string })?.threadId, "13832");
    assert.match((result as any).content?.[0]?.text ?? "", /Interactive plan offer queued/);
  });

  it("prefers deliveryContext routing for Telegram topic plan-offer delivery", async () => {
    const calls: Array<Record<string, unknown>> = [];
    setSessionManager({
      sendPlanOffer(args: Record<string, unknown>) {
        calls.push(args);
      },
    } as any);

    const tool = makeAgentSendPlanOfferTool({
      workspaceDir: "/tmp",
      sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
      deliveryContext: {
        channel: "telegram",
        to: "-1003863755361",
        accountId: "bot1",
        threadId: 13832,
      },
    } as any);
    await tool.execute("tool-id", {
      offer_id: "plugin-readiness-v2026.5.7",
      offer_text: "Readiness report body",
      plan_prompt: "Plan the compatibility follow-up.",
      plan_workdir: "/home/openclaw/workspace/openclaw-code-agent",
      plan_name: "plugin-readiness-v2026.5.7",
    });

    assert.equal(calls.length, 1);
    assert.equal((calls[0]?.route as { provider?: string })?.provider, "telegram");
    assert.equal((calls[0]?.route as { accountId?: string })?.accountId, "bot1");
    assert.equal((calls[0]?.route as { target?: string })?.target, "-1003863755361");
    assert.equal((calls[0]?.route as { threadId?: string })?.threadId, "13832");
  });

  it("describes generic external workflow usage without monitor policy", () => {
    const tool = makeAgentSendPlanOfferTool({ workspaceDir: "/tmp" } as any);
    assert.match(tool.description, /external workflow/);
    assert.match(tool.description, /Start Plan and Dismiss/);
    assert.doesNotMatch(tool.description, /release monitor|monitor report/i);
  });
});
