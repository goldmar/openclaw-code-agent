import "./test-env";
import { afterEach, describe, it } from "node:test";
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
import { normalizeSessionReferenceParams } from "../src/tools/session-reference-params";
import { setSessionManager } from "../src/singletons";
import type { SessionManager } from "../src/session-manager";
import { createStubSession } from "./helpers";

const tools = () => [
  { tool: makeAgentRespondTool(), extra: { message: "Follow up" }, required: true },
  { tool: makeAgentOutputTool(), extra: { full: true }, required: true },
  { tool: makeAgentEscalateTool(), extra: { kind: "plan", summary: "Review" }, required: true },
  { tool: makeAgentMergeTool(), extra: {}, required: true },
  { tool: makeAgentKillTool(), extra: {}, required: true },
  { tool: makeAgentPrTool(), extra: {}, required: true },
  { tool: makeAgentSessionActionTool(), extra: { action: "compact" }, required: true },
  { tool: makeAgentWorktreeCleanupTool(), extra: { mode: "preview_all" }, required: false },
  { tool: makeAgentWorktreeStatusTool(), extra: {}, required: false },
];

afterEach(() => setSessionManager(null));

describe("public OCA session reference contract", () => {
  it("advertises the canonical key and the deprecated alias with the correct requiredness", () => {
    for (const { tool, required } of tools()) {
      const schema = tool.parameters as unknown as {
        properties: Record<string, { description?: string }>; required?: string[]; anyOf?: Array<{ required: string[] }>;
      };
      assert.ok("ocaSessionId" in schema.properties, tool.name);
      assert.match(schema.properties.session.description ?? "", /Deprecated alias/);
      assert.ok(!("codeAgentSessionId" in schema.properties));
      assert.ok(!schema.required?.includes("ocaSessionId") && !schema.required?.includes("session"));
      assert.deepEqual(schema.anyOf, required ? [{ required: ["ocaSessionId"] }, { required: ["session"] }] : undefined);
    }
  });

  it("refuses malformed and conflicting targets before any manager or Git operation", async () => {
    // A boundary fake: even a lookup is forbidden for an invalid reference.
    setSessionManager(new Proxy({}, { get() { assert.fail("Invalid input touched SessionManager"); } }) as SessionManager);
    for (const reference of [
      { ocaSessionId: "old", session: "new" }, { ocaSessionId: "old", session: "***" },
      { ocaSessionId: "old", session: 1 }, { ocaSessionId: null, session: "old" },
      { ocaSessionId: "old", session: undefined }, { ocaSessionId: undefined, session: "old" },
      { ocaSessionId: "" }, { session: " " }, { ocaSessionId: "old", session: " " },
      { ocaSessionId: {} }, { session: [] as unknown[] }, { codeAgentSessionId: "old" },
      { ocaSessionId: "old", codeAgentSessionId: "old" },
    ]) {
      for (const { tool, extra } of tools()) {
        const result = await tool.execute("invalid", { ...extra, ...reference }) as { isError?: boolean; details?: { operationStarted?: boolean }; content: Array<{ text: string }> };
        assert.equal(result.isError, true, tool.name);
        assert.equal(result.details?.operationStarted, false, tool.name);
        assert.doesNotMatch(JSON.stringify(result), /"old"|"new"|"\*\*\*"/);
      }
    }
    for (const { tool, extra, required } of tools()) {
      if (required) assert.equal((await tool.execute("missing", extra) as { isError?: boolean }).isError, true, tool.name);
    }
  });

  it("accepts canonical, legacy, and identical dual references through every tool", async () => {
    for (const reference of [{ ocaSessionId: "older-exact" }, { session: "older-exact" },
      { ocaSessionId: "older-exact", session: "older-exact" }]) {
      for (const { tool, extra } of tools()) {
        const lookups: string[] = [];
        // Unknown-target fake proves validation reaches lookup without allowing any operation.
        setSessionManager({ resolve: (ref: string): undefined => { lookups.push(ref); return undefined; },
          getPersistedSession: (ref: string): undefined => { lookups.push(ref); return undefined; },
          list: (): never[] => [], listPersistedSessions: (): never[] => [],
        } as unknown as SessionManager);
        const result = await tool.execute("valid-reference", { ...extra, ...reference });
        assert.doesNotMatch(result.content[0].text, /Invalid parameters/, tool.name);
        if (tool.name !== "agent_worktree_status" && !(tool.name === "agent_pr" && /GitHub CLI/.test(result.content[0].text))) {
          assert.ok(lookups.length > 0, tool.name);
          assert.ok(lookups.every((ref) => ref === "older-exact"), tool.name);
        }
      }
    }
  });

  it("preserves literal references and optional omission without mutating caller input", () => {
    const input = { session: "  literal name  ", full: false };
    assert.deepEqual(normalizeSessionReferenceParams(input), { ok: true, params: { ocaSessionId: "  literal name  ", full: false } });
    assert.deepEqual(input, { session: "  literal name  ", full: false });
    assert.deepEqual(normalizeSessionReferenceParams({}, false), { ok: true, params: {} });
  });

  it("delivers to the older exact session and preserves approval and boolean validation", async () => {
    const sent: string[] = [];
    const older = createStubSession({ id: "older-exact", name: "older", sendMessage: async () => { sent.push("older"); } });
    const newer = createStubSession({ id: "newer-exact", name: "newer", sendMessage: async () => { sent.push("newer"); } });
    const sessions = new Map([[older.id, older], [newer.id, newer]]);
    setSessionManager({ resolve: (ref: string) => sessions.get(ref), getPersistedSession: (): undefined => undefined } as unknown as SessionManager);
    for (const reference of [{ ocaSessionId: older.id }, { session: older.id }, { ocaSessionId: older.id, session: older.id }]) {
      assert.equal((await makeAgentRespondTool().execute("send", { ...reference, message: "Follow up" })).isError, false);
    }
    assert.deepEqual(sent, ["older", "older", "older"]);
    for (const key of ["approve", "userInitiated", "interrupt"]) {
      assert.equal((await makeAgentRespondTool().execute("boolean", { ocaSessionId: older.id, message: "approve", [key]: "false" })).isError, true);
    }
    older.pendingPlanApproval = true;
    older.planApproval = "ask";
    const denied = await makeAgentRespondTool().execute("approval", { ocaSessionId: older.id, message: "Approved", approve: true });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /reserved for the user/);
    assert.deepEqual(sent, ["older", "older", "older"]);
  });

  it("dispatches explicit cleanup only to the selected reference", async () => {
    const dismissed: string[] = [];
    setSessionManager({ dismissWorktree: async (ref: string) => { dismissed.push(ref); return "Discarded selected fixture"; },
    } as unknown as SessionManager);
    for (const reference of [{ ocaSessionId: "older-exact" }, { session: "older-exact" },
      { ocaSessionId: "older-exact", session: "older-exact" }]) {
      const result = await makeAgentWorktreeCleanupTool().execute("dismiss", { ...reference, dismiss_session: true });
      assert.match(result.content[0].text, /Discarded selected fixture/);
    }
    assert.deepEqual(dismissed, ["older-exact", "older-exact", "older-exact"]);
  });

  it("keeps the kill allowlist closed after alias normalization", async () => {
    const stopped: string[] = [];
    const older = { id: "older-exact", name: "older", status: "running" };
    setSessionManager({ resolve: (ref: string) => ref === older.id ? older : undefined,
      getPersistedSession: (): undefined => undefined, kill: (id: string) => { stopped.push(id); return true; },
    } as unknown as SessionManager);
    for (const reference of [{ ocaSessionId: older.id }, { session: older.id }, { ocaSessionId: older.id, session: older.id }]) {
      assert.match((await makeAgentKillTool().execute("kill", reference)).content[0].text, /Stopped/);
    }
    assert.deepEqual(stopped, [older.id, older.id, older.id]);
    await makeAgentKillTool().execute("extra", { session: older.id, purge: true });
    assert.deepEqual(stopped, [older.id, older.id, older.id]);
  });
});
