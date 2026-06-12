import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerAgentPolicyCommand } from "../src/commands/agent-policy";
import { setSessionManager } from "../src/singletons";

type Handler = (ctx: { args?: string; workspaceDir?: string }) => { text: string };

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

function policyRecord(policy: string = "pr-required") {
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

  it("continues a matching deferred launch after setting policy", () => {
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

    const result = captureHandler()({ args: "pr-required", workspaceDir: "/repo" });

    assert.match(result.text, /Repo policy set to pr-required for \/repo\./);
    assert.match(result.text, /Session launched successfully/);
    assert.match(result.text, /ID: sess-1/);
  });

  it("does not guess when several deferred launches match the policy", () => {
    setSessionManager({
      setRepoPolicy: () => policyRecord(),
      continueLaunchAfterManualRepoPolicy: () => ({ kind: "ambiguous", count: 2 }),
    } as any);

    const result = captureHandler()({ args: "pr-required", workspaceDir: "/repo" });

    assert.match(result.text, /Repo policy set to pr-required for \/repo\./);
    assert.match(result.text, /2 pending launches match this policy/);
  });

  it("returns only the saved policy message when no deferred launch matches", () => {
    setSessionManager({
      setRepoPolicy: () => policyRecord(),
      continueLaunchAfterManualRepoPolicy: () => ({ kind: "none" }),
    } as any);

    const result = captureHandler()({ args: "pr-required", workspaceDir: "/repo" });

    assert.equal(result.text, "Repo policy set to pr-required for /repo.");
  });

  it("keeps older injected managers on the saved policy path", () => {
    setSessionManager({
      setRepoPolicy: () => policyRecord(),
    } as any);

    const result = captureHandler()({ args: "pr-required", workspaceDir: "/repo" });

    assert.equal(result.text, "Repo policy set to pr-required for /repo.");
  });

  it("reports deferred launch failures without losing the saved policy message", () => {
    setSessionManager({
      setRepoPolicy: () => policyRecord(),
      continueLaunchAfterManualRepoPolicy: () => {
        throw new Error("launch capacity unavailable");
      },
    } as any);

    const result = captureHandler()({ args: "pr-required", workspaceDir: "/repo" });

    assert.match(result.text, /Repo policy set to pr-required for \/repo\./);
    assert.match(result.text, /Repo policy saved, but the deferred launch failed: launch capacity unavailable/);
    assert.match(result.text, /pending launch context was kept/);
  });

  it("rejects PR policies when PR automation is unavailable", () => {
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

    const result = captureHandler()({ args: "pr-allowed", workspaceDir: "/repo" });

    assert.match(result.text, /Error: Policy pr-allowed requires PR automation/);
    assert.match(result.text, /Choose never-pr or manual/);
  });

  it("only advertises non-PR policies when PR automation is unavailable", () => {
    setSessionManager({
      resolveRepoPolicy: () => ({
        identity: { key: "/repo", repoRoot: "/repo", provider: "unsupported" },
        source: "unknown",
        provider: "unsupported",
        prAvailable: false,
      }),
    } as any);

    const result = captureHandler()({ workspaceDir: "/repo" });

    assert.match(result.text, /Provider: unsupported \(PR automation unavailable\)/);
    assert.match(result.text, /Set with \/agent_policy never-pr, manual\./);
    assert.doesNotMatch(result.text, /pr-required/);
    assert.doesNotMatch(result.text, /pr-allowed/);
  });
});
