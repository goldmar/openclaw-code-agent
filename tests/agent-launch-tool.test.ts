import "./test-env";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeAgentLaunchTool } from "../src/tools/agent-launch";
import { setPluginConfig } from "../src/config";
import { setPluginRuntime } from "../src/runtime-store";
import { setSessionManager } from "../src/singletons";

describe("agent_launch tool defaults", () => {
  beforeEach(() => {
    setPluginConfig({});
    setPluginRuntime(undefined);
    setSessionManager(null);
  });

  it("uses the built-in Codex model and leaves reasoning effort to Codex when no model is provided", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({ defaultHarness: "codex" });

    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-1",
          name: "codex-defaults",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "Ship it" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.harness, "codex");
    assert.equal(spawnConfig?.model, "gpt-6-sol");
    assert.equal(spawnConfig?.reasoningEffort, undefined);
    assert.equal(spawnConfig?.fastMode, undefined);
    assert.equal("codexApprovalPolicy" in (spawnConfig ?? {}), false);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, / · codex \| gpt-6-sol/);
    assert.match(text, /Mode: plan first, approval: delegate · worktree: delegate/);
    assert.ok(text.split("\n").length <= 5, `compact launch summary: ${text}`);
  });

  it("prefers an explicit model and the configured Codex reasoning effort", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      defaultHarness: "codex",
      harnesses: {
        codex: {
          defaultModel: "gpt-5.3-codex",
          allowedModels: ["gpt-5.3-codex", "gpt-5.5"],
          reasoningEffort: "high",
        },
      },
    });

    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-2",
          name: "codex-explicit",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    await tool.execute("tool-id", { prompt: "Ship it", model: "gpt-5.5" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.model, "gpt-5.5");
    assert.equal(spawnConfig?.reasoningEffort, "high");
  });

  it("passes the resolved permission mode into spawn when the caller omits permission_mode", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      permissionMode: "bypassPermissions",
    });

    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-permission-mode",
          name: "resolved-permission-mode",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    await tool.execute("tool-id", { prompt: "Inspect only" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.permissionMode, "bypassPermissions");
  });

  it("captures Telegram group chat and topic metadata from tool context", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-3",
          name: "telegram-topic",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({
      workspaceDir: "/tmp",
      messageChannel: "telegram",
      chatId: "-1001234567890",
      messageThreadId: 28,
    } as any);
    await tool.execute("tool-id", { prompt: "Ping the topic" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.originChannel, "telegram|-1001234567890");
    assert.equal(spawnConfig?.originThreadId, 28);
  });

  it("captures routing from deliveryContext on the current SDK surface", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-delivery-context",
          name: "telegram-topic",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({
      workspaceDir: "/tmp",
      sessionKey: "agent:main:telegram:group:-1001234567890:topic:13832",
      deliveryContext: {
        channel: "telegram",
        to: "-1001234567890",
        accountId: "bot1",
        threadId: 13832,
      },
    } as any);
    await tool.execute("tool-id", { prompt: "Ping the topic" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.originChannel, "telegram|bot1|-1001234567890");
    assert.equal(spawnConfig?.originThreadId, 13832);
    assert.equal((spawnConfig?.route as { accountId?: string } | undefined)?.accountId, "bot1");
  });

  it("attaches a managed TaskFlow lifecycle sink when the current runtime is available", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    const createManagedCalls: Record<string, unknown>[] = [];
    let creation: void | Promise<void> = undefined;
    setPluginRuntime({
      tasks: {
        async: {
          managedFlows: {
            fromToolContext() {
              return {
                async tryCreateManaged(params: Record<string, unknown>) {
                  createManagedCalls.push(params);
                  return { flowId: "flow-1", revision: 1 };
                },
                async get(flowId: string) { return { flowId, revision: 1, status: "running" }; },
                async resume() { return { applied: true, flow: { flowId: "flow-1", revision: 2 } }; },
                async setWaiting() { return { applied: true, flow: { flowId: "flow-1", revision: 2 } }; },
                async finish() { return { applied: true, flow: { flowId: "flow-1", revision: 2 } }; },
                async fail() { return { applied: true, flow: { flowId: "flow-1", revision: 2 } }; },
                async requestCancel() { return { applied: true, flow: { flowId: "flow-1", revision: 2 } }; },
              };
            },
          },
        },
      },
    });

    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        const session = {
          id: "sess-task-lifecycle",
          name: "task-lifecycle",
          prompt: config.prompt,
          startedAt: 100,
          status: "starting",
          lifecycle: "starting",
          model: config.model,
        };
        creation = (config.taskLifecycle as { create: (session: unknown) => void | Promise<void> }).create(session);
        return session;
      },
    } as any);

    const tool = makeAgentLaunchTool({
      workspaceDir: "/tmp",
      sessionKey: "agent:main:telegram:group:123",
    } as any);
    await tool.execute("tool-id", { prompt: "Represent this session in native tasks" });
    await creation;

    assert.ok(spawnConfig?.taskLifecycle);
    assert.equal(createManagedCalls.length, 1);
    assert.equal(createManagedCalls[0].controllerId, "openclaw-code-agent");
    assert.equal(createManagedCalls[0].goal, "Represent this session in native tasks");
    assert.equal(createManagedCalls[0].status, "running");
    assert.equal(createManagedCalls[0].notifyPolicy, "silent");
    assert.equal((createManagedCalls[0].stateJson as Record<string, unknown>).integration, "phase-1-managed-task-flow");
  });

  it("falls back to an explicit system route when the tool context has no chat metadata", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-system-route",
          name: "system-route",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true } as any);
    const result = await tool.execute("tool-id", { prompt: "Launch without explicit chat metadata" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal((spawnConfig?.route as { provider?: string } | undefined)?.provider, "system");
    assert.equal((spawnConfig?.route as { target?: string } | undefined)?.target, "system");
    assert.match((result.content[0] as { text: string }).text, /^Launched /);
  });

  it("fails closed for the route-less context produced by the standalone deferred plugin-tool bridge", async () => {
    let spawnCalled = false;
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession() {
        spawnCalled = true;
        throw new Error("must not spawn");
      },
    } as any);

    // OpenClaw's standalone plugin-tools server constructs factories with
    // exactly `{ config }`, dropping the originating ToolContext route.
    const tool = makeAgentLaunchTool({ config: {} } as any);
    const result = await tool.execute("nested-tool-id", {
      prompt: "Launch through the deferred nested bridge",
      workdir: "/tmp",
    });

    assert.equal(spawnCalled, false);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /did not provide a trustworthy lifecycle delivery route/);
    assert.match(text, /is missing a session key and a delivery route/);
    assert.match(text, /No coding session was started/);
  });

  it("names the missing delivery route when only a session key was passed", async () => {
    let spawnCalled = false;
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession() {
        spawnCalled = true;
        throw new Error("must not spawn");
      },
    } as any);

    const tool = makeAgentLaunchTool({ config: {}, sessionKey: "agent:main:main" } as any);
    const result = await tool.execute("session-key-only", {
      prompt: "Launch with a session key but no delivery route",
      workdir: "/tmp",
    });

    assert.equal(spawnCalled, false);
    const text = (result.content[0] as { text: string }).text;
    assert.match(
      text,
      /has a session key but is missing a delivery route: no delivery context or message channel was provided, and the session key does not identify a chat conversation\./,
    );
    assert.doesNotMatch(text, /missing session, delivery, and workspace identity/);
  });

  it("names the missing delivery target when a channel has no conversation", async () => {
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession() {
        throw new Error("must not spawn");
      },
    } as any);

    const tool = makeAgentLaunchTool({ config: {}, sessionKey: "agent:main:main", messageChannel: "telegram" } as any);
    const result = await tool.execute("channel-without-target", {
      prompt: "Launch with a channel but no conversation",
      workdir: "/tmp",
    });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /is missing a delivery target: the "telegram" channel was provided without a conversation to deliver to\./);
  });

  it("asks for repo policy with buttons before launching worktree sessions for unknown repos", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-launch-policy-"));
    let spawnCalled = false;
    let policyLaunchArgs: Record<string, unknown> | undefined;

    try {
      setSessionManager({
        resolve: (): undefined => undefined,
        getPersistedSession: () => ({
          sessionId: "stable-session-1",
          harnessSessionId: "backend-session-1",
          name: "stable-session",
          status: "killed",
          lifecycle: "terminal",
          killReason: "shutdown",
          backendRef: { kind: "codex-app-server", conversationId: "backend-session-1" },
        }),
        resolveBackendConversationId: (id: string) => `resolved-${id}`,
        checkRepoPolicyForLaunch: () => ({
          ok: false,
          text: "Repo integration policy is not set.",
        }),
        requestRepoPolicyForLaunch(args: Record<string, unknown>) {
          policyLaunchArgs = args;
          return `Repo policy choice prompt sent for ${workdir}.`;
        },
        launchSession() {
          spawnCalled = true;
          throw new Error("spawn should not run before policy selection");
        },
      } as any);

      const tool = makeAgentLaunchTool({
        workspaceDir: workdir,
        messageChannel: "telegram",
        chatId: "12345",
        agentId: "agent-main",
      } as any);
      const result = await tool.execute("tool-id", {
        prompt: "Ship isolated changes",
        resume_session_id: "stable-session-1",
        worktree_strategy: "delegate",
        harness: "codex",
        model: "gpt-5.6-sol",
      });

      assert.equal(spawnCalled, false);
      assert.equal((result.content[0] as { text: string }).text, `Repo policy choice prompt sent for ${workdir}.`);
      assert.equal(policyLaunchArgs?.prompt, "Ship isolated changes");
      assert.equal(policyLaunchArgs?.workdir, workdir);
      assert.equal(policyLaunchArgs?.worktreeStrategy, "delegate");
      assert.equal(policyLaunchArgs?.harness, "codex");
      assert.equal(policyLaunchArgs?.model, "gpt-5.6-sol");
      assert.equal(policyLaunchArgs?.sessionIdOverride, "stable-session-1");
      assert.equal(policyLaunchArgs?.resumeWorktreeFrom, "stable-session-1");
      assert.equal(policyLaunchArgs?.originAgentId, "agent-main");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("carries rewind_turns through the repo-policy prompt", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-launch-policy-codex-rewind-"));
    let policyLaunchArgs: Record<string, unknown> | undefined;

    try {
      setSessionManager({
        resolve: (): undefined => undefined,
        getPersistedSession: () => ({ harness: "codex" }),
        resolveBackendConversationId: (id: string) => `resolved-${id}`,
        checkRepoPolicyForLaunch: () => ({
          ok: false,
          text: "Repo integration policy is not set.",
        }),
        requestRepoPolicyForLaunch(args: Record<string, unknown>) {
          policyLaunchArgs = args;
          return `Repo policy choice prompt sent for ${workdir}.`;
        },
        launchSession() {
          throw new Error("spawn should not run before policy selection");
        },
      } as any);

      const tool = makeAgentLaunchTool({ workspaceDir: workdir, oneShotCliRun: true } as any);
      const result = await tool.execute("tool-id", {
        prompt: "Continue after restart",
        resume_session_id: "old-thread",
        fork_session: true,
        rewind_turns: 2,
        worktree_strategy: "delegate",
        harness: "codex",
      });

      assert.equal((result.content[0] as { text: string }).text, `Repo policy choice prompt sent for ${workdir}.`);
      assert.equal(policyLaunchArgs?.rewindTurns, 2);
      assert.equal(policyLaunchArgs?.resumeSessionId, "resolved-old-thread");
      assert.equal(policyLaunchArgs?.forkSession, true);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("resumes persisted Codex App Server threads without clearing them (B7)", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolve: (): undefined => undefined,
      getPersistedSession: () => ({ harness: "codex" }),
      resolveBackendConversationId: (id: string) => `resolved-${id}`,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-4",
          name: "codex-restart",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", {
      prompt: "Continue after restart",
      harness: "codex",
      resume_session_id: "old-thread",
      fork_session: true,
      rewind_turns: 1,
    });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.model, "gpt-6-sol");
    assert.equal(spawnConfig?.resumeSessionId, "resolved-old-thread");
    assert.equal(spawnConfig?.forkSession, true);
    assert.equal(spawnConfig?.rewindTurns, 1);
    assert.match((result.content[0] as { text: string }).text, /Rewind: forked before the last 1 turn/);
  });

  it("rejects rewind_turns without a resume target, for other harnesses, or with invalid counts", async () => {
    setSessionManager({
      resolve: (): undefined => undefined,
      getPersistedSession: (): undefined => undefined,
      resolveHarnessSessionId: (id: string) => id,
      launchSession() {
        throw new Error("spawn should not run");
      },
    } as any);
    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const text = async (params: Record<string, unknown>) => ((await tool.execute("tool-id", { prompt: "x", ...params })).content[0] as { text: string }).text;
    assert.match(await text({ harness: "codex", rewind_turns: 1 }), /rewind_turns requires resume_session_id/);
    assert.match(await text({ harness: "claude-code", resume_session_id: "a", rewind_turns: 1 }), /only supported by the Codex harness/);
    assert.match(await text({ harness: "codex", resume_session_id: "a", rewind_turns: 1.5 }), /positive integer/);
  });

  it("keeps active Codex resume state before spawn", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolve: () => ({ harnessSessionId: "resolved-old-thread", backendRef: { kind: "codex-app-server", conversationId: "resolved-old-thread" } }),
      getPersistedSession: () => ({ harness: "codex" }),
      resolveBackendConversationId: (id: string) => `resolved-${id}`,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-5",
          name: "codex-live",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    await tool.execute("tool-id", {
      prompt: "Continue active session",
      harness: "codex",
      resume_session_id: "old-thread",
    });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.model, "gpt-6-sol");
    assert.equal(spawnConfig?.resumeSessionId, "resolved-old-thread");
  });

  it("reuses the original OpenClaw session ID when resuming a stopped session without fork", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolve: (): undefined => undefined,
      getPersistedSession: () => ({
        sessionId: "sess-stable",
        harnessSessionId: "resolved-old-thread",
        name: "stable-session",
        status: "killed",
        lifecycle: "terminal",
        killReason: "shutdown",
        backendRef: { kind: "codex-app-server", conversationId: "resolved-old-thread" },
      }),
      resolveBackendConversationId: (id: string) => `resolved-${id}`,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-stable",
          name: "stable-session",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", {
      prompt: "Continue stable session",
      harness: "codex",
      resume_session_id: "old-thread",
    });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.sessionIdOverride, "sess-stable");
    assert.equal(spawnConfig?.resumeSessionId, "resolved-old-thread");
    assert.match((result.content[0] as { text: string }).text, /\[sess-stable\]/);
  });

  it("preserves a suspended pending plan when a stable-ID resume is not an approval", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    const pendingPlan = {
      sessionId: "sess-plan",
      harnessSessionId: "thread-plan",
      name: "pending-plan",
      status: "killed",
      lifecycle: "suspended",
      killReason: "idle-timeout",
      backendRef: { kind: "codex-app-server", conversationId: "thread-plan" },
      pendingPlanApproval: true,
      approvalState: "pending",
      planApprovalContext: "plan-mode",
      planDecisionVersion: 4,
      actionablePlanDecisionVersion: 4,
      canonicalPlanPromptVersion: 4,
      approvalPromptRequiredVersion: 4,
      approvalPromptVersion: 4,
      approvalPromptStatus: "delivered",
      approvalPromptTransport: "direct-message",
      approvalPromptMessageKind: "canonical_buttons",
    };
    setSessionManager({
      resolve: (): undefined => undefined,
      getPersistedSession: () => pendingPlan,
      resolveBackendConversationId: () => "thread-plan",
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-plan", name: "pending-plan", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    await tool.execute("tool-id", {
      prompt: "Continue reviewing",
      harness: "codex",
      resume_session_id: "sess-plan",
      permission_mode: "default",
    });

    assert.equal(spawnConfig?.permissionMode, "plan");
    assert.equal(spawnConfig?.pendingPlanApproval, true);
    assert.equal(spawnConfig?.approvalState, "pending");
    assert.equal(spawnConfig?.planDecisionVersion, 4);
    assert.equal(spawnConfig?.actionablePlanDecisionVersion, 4);
  });

  it("records exact approval state when bypass-resuming a suspended pending plan", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setSessionManager({
      resolve: (): undefined => undefined,
      getPersistedSession: () => ({
        sessionId: "sess-plan",
        harnessSessionId: "thread-plan",
        name: "pending-plan",
        status: "killed",
        lifecycle: "suspended",
        killReason: "idle-timeout",
        backendRef: { kind: "codex-app-server", conversationId: "thread-plan" },
        pendingPlanApproval: true,
        approvalState: "pending",
        planApprovalContext: "plan-mode",
        planDecisionVersion: 4,
        actionablePlanDecisionVersion: 4,
      }),
      resolveBackendConversationId: () => "thread-plan",
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-plan", name: "pending-plan", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    await tool.execute("tool-id", {
      prompt: "The user approved Plan v4. Implement it.",
      harness: "codex",
      resume_session_id: "sess-plan",
      permission_mode: "bypassPermissions",
    });

    assert.equal(spawnConfig?.permissionMode, "bypassPermissions");
    assert.equal(spawnConfig?.pendingPlanApproval, false);
    assert.equal(spawnConfig?.approvalState, "approved");
    assert.equal(spawnConfig?.approvalExecutionState, "awaiting_plan_output");
    assert.equal(spawnConfig?.planDecisionVersion, 5);
    assert.equal(spawnConfig?.actionablePlanDecisionVersion, undefined);
  });

  it("preserves the original session name when resuming without an explicit follow-up label", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolve: (): undefined => undefined,
      getPersistedSession: () => ({
        sessionId: "_QDNlLZr",
        harnessSessionId: "thread-auto-update-feature",
        name: "oca-auto-update-feature",
        status: "killed",
        lifecycle: "terminal",
        killReason: "shutdown",
        backendRef: { kind: "codex-app-server", conversationId: "thread-auto-update-feature" },
      }),
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: config.sessionIdOverride,
          name: config.name,
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", {
      prompt: "Continue with the bundle size fix",
      harness: "codex",
      resume_session_id: "_QDNlLZr",
    });

    const text = (result.content[0] as { text: string }).text;
    assert.equal(spawnConfig?.sessionIdOverride, "_QDNlLZr");
    assert.equal(spawnConfig?.name, "oca-auto-update-feature");
    assert.equal(spawnConfig?.resumedFromSessionName, "oca-auto-update-feature");
    assert.match(text, /^Launched oca-auto-update-feature \[/);
    assert.match(text, /Resumed: oca-auto-update-feature \[_QDNlLZr\]/);
    assert.doesNotMatch(text, /now labelled/);
  });

  it("labels explicit names on resumed sessions as follow-up labels", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolve: (): undefined => undefined,
      getPersistedSession: () => ({
        sessionId: "_QDNlLZr",
        harnessSessionId: "thread-auto-update-feature",
        name: "oca-auto-update-feature",
        status: "killed",
        lifecycle: "terminal",
        killReason: "shutdown",
        backendRef: { kind: "codex-app-server", conversationId: "thread-auto-update-feature" },
      }),
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: config.sessionIdOverride,
          name: config.name,
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", {
      prompt: "Continue with the bundle size fix",
      name: "oca-pr-341-bundle-size-fix",
      harness: "codex",
      resume_session_id: "_QDNlLZr",
    });

    const text = (result.content[0] as { text: string }).text;
    assert.equal(spawnConfig?.sessionIdOverride, "_QDNlLZr");
    assert.equal(spawnConfig?.name, "oca-pr-341-bundle-size-fix");
    assert.equal(spawnConfig?.resumedFromSessionName, "oca-auto-update-feature");
    assert.match(text, /^Launched oca-pr-341-bundle-size-fix \[/);
    assert.match(text, /Resumed: oca-auto-update-feature \[_QDNlLZr\] \(now labelled oca-pr-341-bundle-size-fix\)/);
  });

  it("preserves the original resumed identity when relabeling an already relabeled session", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      resolve: (): undefined => undefined,
      getPersistedSession: () => ({
        sessionId: "_QDNlLZr",
        harnessSessionId: "thread-auto-update-feature",
        name: "oca-pr-341-bundle-size-fix",
        resumedFromSessionName: "oca-auto-update-feature",
        status: "killed",
        lifecycle: "terminal",
        killReason: "shutdown",
        backendRef: { kind: "codex-app-server", conversationId: "thread-auto-update-feature" },
      }),
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: config.sessionIdOverride,
          name: config.name,
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", {
      prompt: "Continue with the tests",
      name: "oca-pr-342-tests",
      harness: "codex",
      resume_session_id: "_QDNlLZr",
    });

    const text = (result.content[0] as { text: string }).text;
    assert.equal(spawnConfig?.sessionIdOverride, "_QDNlLZr");
    assert.equal(spawnConfig?.name, "oca-pr-342-tests");
    assert.equal(spawnConfig?.resumedFromSessionName, "oca-auto-update-feature");
    assert.match(text, /^Launched oca-pr-342-tests \[/);
    assert.match(text, /Resumed: oca-auto-update-feature \[_QDNlLZr\] \(now labelled oca-pr-342-tests\)/);
    assert.doesNotMatch(text, /Resumed: oca-pr-341-bundle-size-fix/);
  });

  it("allows non-fork resume attempts for completed Codex App Server sessions", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setSessionManager({
      resolve: (): undefined => undefined,
      getPersistedSession: () => ({
        sessionId: "sess-done",
        harnessSessionId: "resolved-old-thread",
        name: "done-session",
        status: "completed",
        lifecycle: "terminal",
        killReason: "done",
        backendRef: { kind: "codex-app-server", conversationId: "resolved-old-thread" },
      }),
      resolveBackendConversationId: (id: string) => `resolved-${id}`,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-done",
          name: "done-session",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", {
      prompt: "Continue closed session",
      harness: "codex",
      resume_session_id: "old-thread",
    });

    const text = (result.content[0] as { text: string }).text;
    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.resumeSessionId, "resolved-old-thread");
    assert.equal(spawnConfig?.sessionIdOverride, "sess-done");
    assert.match(text, /\[sess-done\]/);
  });

  it("forwards per-session plan_approval override to spawn", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setPluginConfig({
      planApproval: "delegate",
    });

    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-6",
          name: "session-plan-approval",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    await tool.execute("tool-id", {
      prompt: "Ship it",
      plan_approval: "ask",
    });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.planApproval, "ask");
  });

  it("uses Workdir from the prompt when no explicit workdir parameter is provided", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    const repoDir = mkdtempSync(join(tmpdir(), "agent-launch-workdir-"));
    try {
      setSessionManager({
        resolveBackendConversationId: (id: string) => id,
        launchSession(config: Record<string, unknown>) {
          spawnConfig = config;
          return {
            id: "sess-workdir",
            name: "prompt-workdir",
            model: config.model,
          };
        },
      } as any);

      const tool = makeAgentLaunchTool({ workspaceDir: "/tmp/orchestrator-workspace", oneShotCliRun: true });
      await tool.execute("tool-id", {
        prompt: `Workdir: ${repoDir}\nRepo: ${repoDir}\n\nInvestigate the bug.`,
      });

      assert.ok(spawnConfig, "spawn should be called");
      assert.equal(spawnConfig?.workdir, repoDir);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not scan ordinary prompt body text for workdir metadata", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    const repoDir = mkdtempSync(join(tmpdir(), "agent-launch-body-workdir-"));
    const fallbackDir = mkdtempSync(join(tmpdir(), "agent-launch-fallback-workdir-"));
    try {
      setSessionManager({
        resolveBackendConversationId: (id: string) => id,
        launchSession(config: Record<string, unknown>) {
          spawnConfig = config;
          return {
            id: "sess-body-workdir",
            name: "body-workdir",
            model: config.model,
          };
        },
      } as any);

      const tool = makeAgentLaunchTool({ workspaceDir: fallbackDir, oneShotCliRun: true });
      await tool.execute("tool-id", {
        prompt: `Investigate the bug.\n\nThe notes say Repo: ${repoDir} but that should not be parsed as launch metadata.`,
      });

      assert.ok(spawnConfig, "spawn should be called");
      assert.equal(spawnConfig?.workdir, fallbackDir);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(fallbackDir, { recursive: true, force: true });
    }
  });

  it("blocks a fresh launch when a linked resumable session already exists", async () => {
    let spawnCalled = false;

    setSessionManager({
      list: (): never[] => [],
      listPersistedSessions: () => [{
        sessionId: "sess-resume",
        harnessSessionId: "h-resume",
        name: "existing-linked",
        prompt: "old prompt",
        workdir: "/tmp",
        status: "killed",
        lifecycle: "suspended",
        costUsd: 0,
        originSessionKey: "agent:main:telegram:group:123:topic:42",
        resumable: true,
      }],
      launchSession() {
        spawnCalled = true;
        return { id: "should-not-spawn", name: "bad" };
      },
    } as any);

    const tool = makeAgentLaunchTool({
      workspaceDir: "/tmp",
      sessionKey: "agent:main:telegram:group:123:topic:42",
      messageChannel: "telegram",
      chatId: "123",
      messageThreadId: 42,
    } as any);
    const result = await tool.execute("tool-id", { prompt: "Continue the work" });
    const text = (result.content[0] as { text: string }).text;

    assert.equal(spawnCalled, false);
    assert.match(text, /Resume-first protection blocked a fresh launch/);
    assert.match(text, /agent_respond\(session='sess-resume'/);
    assert.match(text, /force_new_session=true/);
  });

  it("allows an explicit force_new_session override for linked resumable sessions", async () => {
    let spawnConfig: Record<string, unknown> | undefined;

    setSessionManager({
      list: (): never[] => [],
      listPersistedSessions: () => [{
        sessionId: "sess-resume",
        harnessSessionId: "h-resume",
        name: "existing-linked",
        prompt: "old prompt",
        workdir: "/tmp",
        status: "killed",
        lifecycle: "suspended",
        costUsd: 0,
        originSessionKey: "agent:main:telegram:group:123:topic:42",
        resumable: true,
      }],
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return {
          id: "sess-7",
          name: "forced-new",
          model: config.model,
        };
      },
    } as any);

    const tool = makeAgentLaunchTool({
      workspaceDir: "/tmp",
      sessionKey: "agent:main:telegram:group:123:topic:42",
      messageChannel: "telegram",
      chatId: "123",
      messageThreadId: 42,
    } as any);
    const result = await tool.execute("tool-id", {
      prompt: "New independent task",
      force_new_session: true,
    });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig?.prompt, "New independent task");
    assert.match((result.content[0] as { text: string }).text, /New session forced/);
  });
});

describe("agent_launch allowedModels validation", () => {
  beforeEach(() => {
    setPluginConfig({});
    setSessionManager(null);
  });

  it("allows model when allowedModels is not configured", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      harnesses: {
        "claude-code": {
          defaultModel: "sonnet",
          allowedModels: undefined,
        },
      },
    });
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "test", model: "anthropic/claude-opus-4-6" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "claude-opus-4-6");
    assert.match((result.content[0] as { text: string }).text, /^Launched /);
  });

  it("allows model when allowedModels is empty array", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      harnesses: {
        "claude-code": {
          defaultModel: "sonnet",
          allowedModels: [],
        },
      },
    });
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "test", model: "anthropic/claude-opus-4-6" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "claude-opus-4-6");
    assert.match((result.content[0] as { text: string }).text, /^Launched /);
  });

  it("allows explicit model matching allowedModels pattern (case-insensitive)", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({ harnesses: { "claude-code": { allowedModels: ["sonnet", "opus"] } } });
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "test", model: "anthropic/claude-SONNET-4-6" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "claude-SONNET-4-6");
    assert.match((result.content[0] as { text: string }).text, /^Launched /);
  });

  it("allows explicit model with substring match", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({ harnesses: { "claude-code": { allowedModels: ["sonnet"] } } });
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "test", model: "claude-sonnet-4-6" });

    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "claude-sonnet-4-6");
    assert.match((result.content[0] as { text: string }).text, /^Launched /);
  });

  it("blocks explicit model not in allowedModels", async () => {
    setPluginConfig({ harnesses: { "claude-code": { allowedModels: ["sonnet"] } } });
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "test", model: "anthropic/claude-opus-4-6" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Error: Model "anthropic\/claude-opus-4-6" is not allowed/);
    assert.match(text, /Permitted models: sonnet/);
  });

  it("blocks explicit model with multiple allowedModels shown", async () => {
    setPluginConfig({ harnesses: { "claude-code": { allowedModels: ["sonnet", "opus", "haiku"] } } });
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "test", model: "gpt-4" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Error: Model "gpt-4" is not allowed/);
    assert.match(text, /Permitted models: sonnet, opus, haiku/);
  });

  it("blocks default model not in allowedModels with config error", async () => {
    setPluginConfig({
      harnesses: {
        "claude-code": {
          defaultModel: "anthropic/claude-opus-4-6",
          allowedModels: ["sonnet", "haiku"],
        },
      },
    });
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "test" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Error: Default model "anthropic\/claude-opus-4-6" is not in allowedModels \(sonnet, haiku\)\. Update harnesses\.claude-code\.defaultModel or harnesses\.claude-code\.allowedModels in the plugin config\./);
  });

  it("allows launch when default model is in allowedModels", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      harnesses: {
        "claude-code": {
          defaultModel: "anthropic/claude-sonnet-4-7",
          allowedModels: ["sonnet", "haiku"],
        },
      },
    });
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "test" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /^Launched /);
    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "claude-sonnet-4-7");
  });

  it("normalizes provider-prefixed Codex model ids before spawn", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({
      harnesses: {
        codex: {
          defaultModel: "gpt-5.5",
          allowedModels: ["gpt-5.5"],
        },
      },
    });
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "test", harness: "codex", model: "openai/gpt-5.5" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /^Launched /);
    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "gpt-5.5");
  });

  it("blocks codex harness model when not allowed", async () => {
    setPluginConfig({
      harnesses: {
        codex: {
          defaultModel: "anthropic/claude-opus-4-6",
          allowedModels: ["haiku"],
        },
      },
    });
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "test", harness: "codex" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /Error: Model "anthropic\/claude-opus-4-6" is not supported for harness "codex"/);
    assert.match(text, /bare Codex model id/);
  });

  it("blocks undefined default model with allowedModels", async () => {
    setPluginConfig({
      harnesses: {
        "claude-code": {
          defaultModel: "haiku",
          allowedModels: ["sonnet"],
        },
      },
    });
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "test" });

    const text = (result.content[0] as { text: string }).text;
    // mismatched default should trigger error
    assert.match(text, /Error: Default model "haiku" is not in allowedModels \(sonnet\)\. Update harnesses\.claude-code\.defaultModel or harnesses\.claude-code\.allowedModels in the plugin config\./);
  });

  it("case-insensitive matching works both ways", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({ harnesses: { "claude-code": { allowedModels: ["SONNET"] } } });
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "test", model: "claude-sonnet-4-6" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /^Launched /);
    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "claude-sonnet-4-6");
  });

  it("partial pattern matching works", async () => {
    let spawnConfig: Record<string, unknown> | undefined;
    setPluginConfig({ harnesses: { "claude-code": { allowedModels: ["claude-son"] } } });
    setSessionManager({
      resolveBackendConversationId: (id: string) => id,
      launchSession(config: Record<string, unknown>) {
        spawnConfig = config;
        return { id: "sess-1", name: "test", model: config.model };
      },
    } as any);

    const tool = makeAgentLaunchTool({ workspaceDir: "/tmp", oneShotCliRun: true });
    const result = await tool.execute("tool-id", { prompt: "test", model: "anthropic/claude-sonnet-4-7" });

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /^Launched /);
    assert.ok(spawnConfig, "spawn should be called");
    assert.equal(spawnConfig.model, "claude-sonnet-4-7");
  });
});
