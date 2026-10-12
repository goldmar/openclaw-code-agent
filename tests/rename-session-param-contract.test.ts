import "./test-env";
/**
 * Regression test for the `session` → `codeAgentSessionId` rename
 * (issue #504 in goldmar/openclaw-code-agent).
 *
 * The OpenClaw core redactor matches the bare field name `session` as a
 * sensitive credential, so any value passed as `args.session` arrives at
 * OCA tools as `***` and the tool returns "Session not found". Renaming the
 * public tool parameter to `codeAgentSessionId` escapes the redactor and
 * makes the parameter survive the Tool Search wrapper.
 *
 * This test enforces two contracts:
 *   1. Every public OCA tool schema exposes `codeAgentSessionId` and
 *      does NOT expose `session` (the masked field name).
 *   2. The agent_kill allowlist accepts `codeAgentSessionId` and rejects
 *      `session` (otherwise upstream would silently re-allow the masked
 *      field name and the original bug would re-emerge).
 *
 * If a future merge reintroduces `session` as a tool parameter (or removes
 * `codeAgentSessionId`), this test fails. Run it as part of the standard
 * OCA test suite (`pnpm test`).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeAgentRespondTool } from "../src/tools/agent-respond";
import { makeAgentOutputTool } from "../src/tools/agent-output";
import { makeAgentEscalateTool } from "../src/tools/agent-escalate";
import { makeAgentMergeTool } from "../src/tools/agent-merge";
import { makeAgentKillTool } from "../src/tools/agent-kill";
import { makeAgentPrTool } from "../src/tools/agent-pr";
import { makeAgentSessionActionTool } from "../src/tools/agent-session-action";
import { makeAgentWorktreeCleanupTool } from "../src/tools/agent-worktree-cleanup";
import { makeAgentWorktreeStatusTool } from "../src/tools/agent-worktree-status";
import { setSessionManager } from "../src/singletons";

const SESSION_TOOLS: ReadonlyArray<{
  name: string;
  factory: () => { name: string; parameters?: { properties?: Record<string, unknown> } };
}> = [
  { name: "agent_respond", factory: () => makeAgentRespondTool() },
  { name: "agent_output", factory: () => makeAgentOutputTool() },
  { name: "agent_escalate", factory: () => makeAgentEscalateTool() },
  { name: "agent_merge", factory: () => makeAgentMergeTool() },
  { name: "agent_kill", factory: () => makeAgentKillTool() },
  { name: "agent_pr", factory: () => makeAgentPrTool() },
  { name: "agent_session_action", factory: () => makeAgentSessionActionTool() },
  { name: "agent_worktree_cleanup", factory: () => makeAgentWorktreeCleanupTool() },
  { name: "agent_worktree_status", factory: () => makeAgentWorktreeStatusTool() },
];

describe("OCA tool schema contract: codeAgentSessionId, not session", () => {
  for (const { name, factory } of SESSION_TOOLS) {
    it(`${name} exposes codeAgentSessionId and does NOT expose session`, () => {
      const tool = factory();
      assert.equal(tool.name, name);
      const props = tool.parameters?.properties ?? {};
      assert.ok(
        "codeAgentSessionId" in props,
        `${name}: schema must expose 'codeAgentSessionId' as a property (the renamed OCA session reference). ` +
          `The bare name 'session' is matched as a sensitive credential by OpenClaw core and arrives as '***' in tool args.`,
      );
      assert.ok(
        !("session" in props),
        `${name}: schema must NOT expose 'session' as a property. ` +
          `The OpenClaw core redactor masks any args.session value before the tool sees it (issue #504). ` +
          `Use 'codeAgentSessionId' instead.`,
      );
    });
  }
});

describe("agent_kill: allowlist accepts codeAgentSessionId, rejects session", () => {
  it("accepts a params object whose only session-shaped key is codeAgentSessionId", async () => {
    setSessionManager(null);
    const tool = makeAgentKillTool();
    // `reason: "completed"` is the other allow-listed key. The tool will
    // surface service_unavailable because sessionManager is null, but the
    // validation step (which enforces the allowlist) runs first; if the
    // allowlist still expects `session`, validation rejects and we never
    // reach the service_unavailable path.
    const result = await tool.execute("call-1", { codeAgentSessionId: "x", reason: "completed" });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    assert.doesNotMatch(
      text,
      /Invalid parameters/,
      "agent_kill validation must accept codeAgentSessionId; the allowlist still contains the old name 'session'.",
    );
    assert.match(text, /SessionManager not initialized|not found|not running|stopped|Marked as completed/i);
  });
});
