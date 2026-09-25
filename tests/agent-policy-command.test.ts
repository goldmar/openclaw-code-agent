import "./test-env";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerAgentPolicyCommand } from "../src/commands/agent-policy";
import { setSessionManager } from "../src/singletons";
import { formatUnresolvedRepoPolicy } from "../src/tools/agent-repo-policy";
import { tokenizeCommandArgs } from "../src/commands/args";
import type { RepoIntegrationPolicy, RepoPolicyRecord } from "../src/types";

type Handler = (ctx: { args?: string; workspaceDir?: string }) => Promise<{ text: string }>;

function captureHandler(): Handler {
  let handler: Handler | undefined;
  registerAgentPolicyCommand({
    registerCommand(command: { handler: Handler }) {
      handler = command.handler;
    },
  });
  assert.ok(handler);
  return handler;
}

function policyRecord(policy: RepoIntegrationPolicy = "pr-required"): RepoPolicyRecord {
  return {
    key: "/repo",
    policy,
    repoRoot: "/repo",
    provider: "github",
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
    source: "stored",
  };
}

describe("/agent_policy command", () => {
  beforeEach(() => {
    setSessionManager(null);
  });

  it("continues a matching deferred launch after setting policy", async () => {
    setSessionManager({
      setRepoPolicy: (workdir: string, policy: string) => {
        assert.equal(workdir, "/repo");
        assert.equal(policy, "pr-required");
        return policyRecord(policy);
      },
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

    const result = await captureHandler()({ args: "pr-required", workspaceDir: "/repo" });

    assert.match(result.text, /Repo policy set to pr-required for \/repo\./);
    assert.match(result.text, /Session launched successfully/);
    assert.match(result.text, /ID: sess-1/);
  });

  it("does not guess when several deferred launches match the policy", async () => {
    setSessionManager({
      setRepoPolicy: () => policyRecord(),
      continueLaunchAfterManualRepoPolicy: () => ({ kind: "ambiguous", count: 2 }),
    } as any);

    const result = await captureHandler()({ args: "pr-required", workspaceDir: "/repo" });

    assert.match(result.text, /Repo policy set to pr-required for \/repo\./);
    assert.match(result.text, /2 pending launches match this policy/);
  });

  it("returns only the saved policy message when no deferred launch matches", async () => {
    setSessionManager({
      setRepoPolicy: () => policyRecord(),
      continueLaunchAfterManualRepoPolicy: () => ({ kind: "none" }),
    } as any);

    const result = await captureHandler()({ args: "pr-required", workspaceDir: "/repo" });

    assert.equal(result.text, "Repo policy set to pr-required for /repo.");
  });

  it("keeps older injected managers on the saved policy path", async () => {
    setSessionManager({
      setRepoPolicy: () => policyRecord(),
    } as any);

    const result = await captureHandler()({ args: "pr-required", workspaceDir: "/repo" });

    assert.equal(result.text, "Repo policy set to pr-required for /repo.");
  });

  it("reports deferred launch failures without losing the saved policy message", async () => {
    setSessionManager({
      setRepoPolicy: () => policyRecord(),
      continueLaunchAfterManualRepoPolicy: () => {
        throw new Error("launch capacity unavailable");
      },
    } as any);

    const result = await captureHandler()({ args: "pr-required", workspaceDir: "/repo" });

    assert.match(result.text, /Repo policy set to pr-required for \/repo\./);
    assert.match(result.text, /Repo policy saved, but the deferred launch failed: launch capacity unavailable/);
    assert.match(result.text, /pending launch context was kept/);
  });

  it("rejects PR policies when PR automation is unavailable", async () => {
    setSessionManager({
      resolveRepoPolicy: () => ({
        identity: { key: "/repo", repoRoot: "/repo", provider: "unsupported" },
        source: "unknown",
        provider: "unsupported",
        prAvailable: false,
      }),
      setRepoPolicy: () => {
        throw new Error("setRepoPolicy should not be called");
      },
    } as any);

    const result = await captureHandler()({ args: "pr-allowed", workspaceDir: "/repo" });

    assert.match(result.text, /Error: Policy pr-allowed requires PR automation/);
    assert.match(result.text, /Choose never-pr or manual/);
  });

  it("only advertises non-PR policies when PR automation is unavailable", async () => {
    setSessionManager({
      resolveRepoPolicy: () => ({
        identity: { key: "/repo", repoRoot: "/repo", provider: "unsupported" },
        source: "unknown",
        provider: "unsupported",
        prAvailable: false,
      }),
    } as any);

    const result = await captureHandler()({ workspaceDir: "/repo" });

    assert.match(result.text, /Provider: unsupported \(PR automation unavailable\)/);
    assert.match(result.text, /Set with \/agent_policy never-pr, manual\./);
    assert.doesNotMatch(result.text, /pr-required/);
    assert.doesNotMatch(result.text, /pr-allowed/);
  });

  it("resets a stored policy by path and shows stored policies for a deleted repo", async () => {
    const resetRefs: string[] = [];
    setSessionManager({
      resetRepoPolicy: (ref: string) => {
        resetRefs.push(ref);
        return ref === "/gone/repo" ? [{ ...policyRecord("never-pr"), key: "/gone/repo|https://github.com/x/y", repoRoot: "/gone/repo" }] : [];
      },
      resolveRepoPolicy: () => ({ source: "none", provider: "unsupported", prAvailable: false }),
      findStoredRepoPolicies: (ref: string) => ref === "/gone/repo" ? [{ ...policyRecord("never-pr"), repoRoot: "/gone/repo" }] : [],
    } as any);
    const handler = captureHandler();

    assert.equal((await handler({ args: "reset \"/gone/repo\"", workspaceDir: "/elsewhere" })).text, "Repo policy reset for /gone/repo.");
    assert.match((await handler({ args: "reset", workspaceDir: "/elsewhere" })).text, /No stored repo policy found for \/elsewhere\. See \/agent_policy list/);
    assert.deepEqual(resetRefs, ["/gone/repo", "/elsewhere"]);

    const status = await handler({ workspaceDir: "/gone/repo" });
    assert.match(status.text, /Repo policy: never-pr/);
    assert.match(status.text, /reset with \/agent_policy reset \/gone\/repo\.$/);
    assert.equal((await handler({ workspaceDir: "/not-a-repo" })).text, "No git repository found for /not-a-repo.");
  });

  it("quotes reset hints so the command parser reads the path back", async () => {
    const stored = (repoRoot: string) => [{ ...policyRecord("never-pr"), repoRoot }];
    for (const path of ["/gone/my repo", "/gone/a\"b c", "/gone/it's here", "/gone/back\\slash"]) {
      const text = formatUnresolvedRepoPolicy(path, stored(path), "command");
      const hint = /reset with \/agent_policy reset (.+)\.$/.exec(text)?.[1];
      assert.ok(hint, text);
      assert.deepEqual(tokenizeCommandArgs(hint), [path]);
    }
    assert.match(formatUnresolvedRepoPolicy(`/gone/a"b c'd`, stored(`/gone/a"b c'd`), "command"), /reset with agent_repo_policy\(reset=true\) with this workdir\.$/);
    assert.match(formatUnresolvedRepoPolicy('/gone/a"b', stored('/gone/a"b')), /agent_repo_policy\(workdir="\/gone\/a\\"b", reset=true\)/);
  });
});
