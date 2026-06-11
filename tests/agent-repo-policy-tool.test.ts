import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAgentRepoPolicyTool } from "../src/tools/agent-repo-policy";
import { setSessionManager } from "../src/singletons";

describe("agent_repo_policy tool", () => {
  beforeEach(() => {
    setSessionManager(null);
  });

  it("continues a matching deferred launch after setting policy manually", async () => {
    setSessionManager({
      setRepoPolicy: () => ({
        key: "/repo",
        policy: "pr-required",
        repoRoot: "/repo",
        provider: "github",
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        source: "stored",
      }),
      continueLaunchAfterManualRepoPolicy: (workdir: string, policy: string) => {
        assert.equal(workdir, "/repo");
        assert.equal(policy, "pr-required");
        return {
          kind: "launched",
          session: { id: "sess-1", name: "manual-policy-session" },
          text: "Session launched successfully\nID: sess-1",
        };
      },
    } as any);

    const tool = makeAgentRepoPolicyTool({ workspaceDir: "/repo" } as any);
    const result = await tool.execute("tool-id", { policy: "pr-required" });
    const text = (result.content[0] as { text: string }).text;

    assert.match(text, /Repo policy: pr-required/);
    assert.match(text, /Session launched successfully/);
    assert.match(text, /ID: sess-1/);
  });

  it("reports deferred launch failures without hiding the saved policy", async () => {
    setSessionManager({
      setRepoPolicy: () => ({
        key: "/repo",
        policy: "pr-required",
        repoRoot: "/repo",
        provider: "github",
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        source: "stored",
      }),
      continueLaunchAfterManualRepoPolicy: () => {
        throw new Error("launch capacity unavailable");
      },
    } as any);

    const tool = makeAgentRepoPolicyTool({ workspaceDir: "/repo" } as any);
    const result = await tool.execute("tool-id", { policy: "pr-required" });
    const text = (result.content[0] as { text: string }).text;

    assert.match(text, /Repo policy: pr-required/);
    assert.match(text, /Repo policy saved, but the deferred launch failed: launch capacity unavailable/);
    assert.match(text, /pending launch context was kept/);
  });
});
