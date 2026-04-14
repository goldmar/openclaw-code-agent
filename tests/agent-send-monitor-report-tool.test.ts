import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAgentSendMonitorReportTool } from "../src/tools/agent-send-monitor-report";
import { setSessionManager } from "../src/singletons";

describe("agent_send_monitor_report tool", () => {
  afterEach(() => {
    setSessionManager(null);
  });

  it("returns an invalid-parameters error when required fields are missing", async () => {
    setSessionManager({} as any);
    const tool = makeAgentSendMonitorReportTool({ workspaceDir: "/tmp" } as any);
    const result = await tool.execute("tool-id", { report_id: "openclaw-release-v2026.3.31" });
    const text = (result as any).content?.[0]?.text ?? "";
    assert.match(text, /Invalid parameters/);
  });

  it("routes an interactive monitor report through SessionManager", async () => {
    const calls: Array<Record<string, unknown>> = [];
    setSessionManager({
      sendMonitorReport(args: Record<string, unknown>) {
        calls.push(args);
      },
    } as any);

    const tool = makeAgentSendMonitorReportTool({
      workspaceDir: "/tmp",
      messageChannel: "telegram",
      chatId: "-1003863755361",
      messageThreadId: 13832,
      sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
    } as any);
    const result = await tool.execute("tool-id", {
      report_id: "openclaw-release-v2026.3.31",
      report_text: "Release report body",
      plan_prompt: "Plan the follow-up.",
      plan_workdir: "/home/openclaw/workspace/openclaw-code-agent",
      plan_name: "oc-release-v2026.3.31",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.reportId, "openclaw-release-v2026.3.31");
    assert.equal((calls[0]?.route as { provider?: string })?.provider, "telegram");
    assert.equal((calls[0]?.route as { target?: string })?.target, "-1003863755361");
    assert.equal((calls[0]?.route as { threadId?: string })?.threadId, "13832");
    assert.match((result as any).content?.[0]?.text ?? "", /Interactive monitor report queued/);
  });

  it("prefers deliveryContext routing for the topic 13832 monitor-report path", async () => {
    const calls: Array<Record<string, unknown>> = [];
    setSessionManager({
      sendMonitorReport(args: Record<string, unknown>) {
        calls.push(args);
      },
    } as any);

    const tool = makeAgentSendMonitorReportTool({
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
      report_id: "openclaw-release-v2026.4.14",
      report_text: "Release report body",
      plan_prompt: "Plan the compatibility follow-up.",
      plan_workdir: "/home/openclaw/workspace/openclaw-code-agent",
      plan_name: "oc-release-v2026.4.14",
    });

    assert.equal(calls.length, 1);
    assert.equal((calls[0]?.route as { provider?: string })?.provider, "telegram");
    assert.equal((calls[0]?.route as { accountId?: string })?.accountId, "bot1");
    assert.equal((calls[0]?.route as { target?: string })?.target, "-1003863755361");
    assert.equal((calls[0]?.route as { threadId?: string })?.threadId, "13832");
  });
});
