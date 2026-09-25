import "./test-env";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createFakeHost, type FakeHost, type FakeHostOptions } from "./fake-host";
import { getSharedRuntime, resetSharedRuntimeSlotForTests } from "../src/process-runtime";

/**
 * OpenClaw loads a non-bundled plugin once per plugin registry, and each load is a
 * separate captured module graph with its own `src/singletons.ts`. On 2026-09-24
 * the live Gateway had two such copies of OCA: `agent_launch` minted the
 * repo-policy buttons in one copy's SessionManager and the Telegram callback
 * looked them up in the other's, which answered "This action is stale or has
 * already been used."
 *
 * These tests load real, separate copies of the plugin source (like OpenClaw's
 * captures) and check that every copy attaches to one process-wide runtime.
 */

const repoRoot = join(import.meta.dirname, "..");
const scratchRoots: string[] = [];
const hosts: FakeHost[] = [];

function createPluginHost(label: string, pluginConfig: Record<string, unknown> = { autoUpdate: false }): FakeHost {
  const host = createFakeHost({ pluginConfig, config: { owner: label } as FakeHostOptions["config"] });
  hosts.push(host);
  return host;
}

type PluginCopy = {
  index: { register: (api: unknown) => void };
  singletons: { sessionManager: any };
  runtimeStore: { getPluginRuntime: () => unknown };
  sessionManagerModule: { SessionManager: any };
};

/** A second copy of the plugin source = a second module graph, like an OpenClaw capture. */
async function loadPluginCopy(label: string, options: { distinctBuild?: boolean } = {}): Promise<PluginCopy> {
  // Inside the repo so bare imports still resolve through ./node_modules.
  const root = mkdtempSync(join(repoRoot, `.instance-${label}-`));
  scratchRoots.push(root);
  for (const entry of ["index.ts", "api.ts", "package.json", "openclaw.plugin.json", "src"]) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  // A different entry module is a different build identity (a hot reload).
  if (options.distinctBuild) appendFileSync(join(root, "index.ts"), `\n// test build ${label}\n`);
  const load = async (path: string) => await import(pathToFileURL(join(root, path)).href);
  return {
    index: await load("index.ts"),
    singletons: await load("src/singletons.ts"),
    runtimeStore: await load("src/runtime-store.ts"),
    sessionManagerModule: await load("src/session-manager.ts"),
  };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] });
}

function telegramCallbackCtx(tokenId: string) {
  const replies: string[] = [];
  const ctx = {
    channel: "telegram",
    accountId: "default",
    conversationId: "-1001",
    parentConversationId: "-1001",
    threadId: 13832,
    senderId: "1",
    isGroup: true,
    isForum: true,
    auth: { isAuthorizedSender: true },
    callback: { data: `code-agent:${tokenId}`, namespace: "code-agent", payload: tokenId, messageId: 1, chatId: "-1001" },
    respond: {
      acknowledge: async () => {},
      reply: async ({ text }: { text: string }) => { replies.push(text); },
      clearButtons: async () => {},
      editButtons: async () => {},
      editMessage: async () => {},
    },
  };
  return { ctx, replies };
}

async function runTool(host: FakeHost, name: string): Promise<unknown> {
  return await host.runTool(name, {});
}

async function startService(host: FakeHost, config: Record<string, unknown> = {}): Promise<void> {
  await host.services[0]!.start({ ...host.serviceContext, config: config as FakeHost["serviceContext"]["config"] });
}

async function stopAll(...plugins: FakeHost[]): Promise<void> {
  for (const plugin of plugins) {
    for (const service of plugin.services) await service.stop?.(plugin.serviceContext);
  }
}

async function disposeHost(host: FakeHost): Promise<void> {
  for (const dispose of host.disposers.splice(0)) await dispose();
}

describe("one OCA runtime per Gateway process", () => {
  let repoDir: string;
  before(() => {
    repoDir = mkdtempSync(join(tmpdir(), "oca-multi-instance-repo-"));
    git(repoDir, "init", "-b", "main");
  });
  afterEach(() => {
    resetSharedRuntimeSlotForTests();
  });
  after(() => {
    rmSync(repoDir, { recursive: true, force: true });
    for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
    for (const host of hosts.splice(0)) rmSync(host.stateDir, { recursive: true, force: true });
  });

  for (const choice of ["No PR", "Manual"] as const) {
    it(`resolves a repo-policy "${choice}" button minted by the tool registry from the callback registry`, async () => {
      const a = await loadPluginCopy(`a-${choice === "No PR" ? "nopr" : "manual"}`);
      const b = await loadPluginCopy(`b-${choice === "No PR" ? "nopr" : "manual"}`);
      assert.notEqual(a.singletons, b.singletons, "each capture must be its own module graph");

      const pluginA = createPluginHost("A");
      const pluginB = createPluginHost("B");
      a.index.register(pluginA.api);
      b.index.register(pluginB.api);
      try {
        // Gateway boot: the active registry's service starts first.
        await startService(pluginA, {});
        // The orchestrator's first tool call runs in the agent-runtime registry.
        await runTool(pluginB, "agent_sessions");
        const sm = a.singletons.sessionManager;
        assert.ok(sm);
        assert.equal(b.singletons.sessionManager, sm, "both registries must share one SessionManager");

        let buttons: Array<Array<{ label: string; callbackData: string }>> = [];
        sm.notifications = {
          dispatch: (_session: unknown, request: any) => {
            if (request?.label === "repo-policy-choice") {
              buttons = request.buttons;
              request.hooks?.onNotifySucceeded?.();
            }
          },
          notifyWorktreeOutcome: () => {},
          dispose: () => {},
        };
        const prompt = await b.singletons.sessionManager.requestRepoPolicyForLaunch({
          route: { provider: "telegram", target: "-1001", threadId: "13832", sessionKey: "agent:main:telegram:group:-1001:topic:13832" },
          prompt: "Make one small change",
          workdir: repoDir,
          harness: "codex",
          worktreeStrategy: "auto-merge",
        });
        assert.match(prompt, /Repo policy choice prompt sent/);
        const button = buttons.flat().find((candidate) => candidate.label === choice);
        assert.ok(button, `expected a ${choice} button`);

        // The user presses the button; Telegram callbacks dispatch through the active registry (A).
        sm.launchAfterRepoPolicyChoice = async () => ({ text: "launched" });
        const { ctx, replies } = telegramCallbackCtx(button.callbackData);
        await pluginA.runInteractive("telegram", ctx);

        assert.doesNotMatch(replies.join("\n"), /stale or has already been used/);
        assert.match(replies.join("\n"), /Repo policy saved/);
        assert.equal((await sm.resolveRepoPolicy(repoDir)).policy, choice === "No PR" ? "never-pr" : "manual");
      } finally {
        await stopAll(pluginB, pluginA);
      }
      assert.equal(getSharedRuntime(), undefined, "the last owner stops the runtime");
    });
  }

  it("switches host handles to the newest live owner and never keeps a retired owner's", async () => {
    const a = await loadPluginCopy("handles-a");
    const b = await loadPluginCopy("handles-b");
    const c = await loadPluginCopy("handles-c");
    const pluginA = createPluginHost("A");
    const pluginB = createPluginHost("B");
    const pluginC = createPluginHost("C");
    a.index.register(pluginA.api);
    b.index.register(pluginB.api);
    c.index.register(pluginC.api);
    try {
      await startService(pluginA, { from: "A" });
      const sm = a.singletons.sessionManager;
      assert.ok(sm);
      // A created the runtime, so A's module graph runs it: its runtime store is what matters.
      assert.equal(a.runtimeStore.getPluginRuntime(), pluginA.runtime);

      await runTool(pluginB, "agent_sessions");
      await runTool(pluginC, "agent_sessions");
      assert.equal(a.runtimeStore.getPluginRuntime(), pluginC.runtime, "the newest owner's handles win");

      // The newest registry is retired by the host: the runtime switches to B before C is gone.
      await disposeHost(pluginC);
      assert.equal(a.runtimeStore.getPluginRuntime(), pluginB.runtime);
      assert.equal(c.singletons.sessionManager, null);
      await assert.rejects(runTool(pluginC, "agent_sessions"), /retired by the host/);

      // The creating registry retires while B remains: the runtime keeps running on
      // B's handles, and the creator graph's singletons (which the runtime's own
      // automatic merge/PR paths read) keep pointing at it.
      await disposeHost(pluginA);
      assert.ok(getSharedRuntime());
      assert.equal(a.singletons.sessionManager, sm);
      assert.equal(a.runtimeStore.getPluginRuntime(), pluginB.runtime);
      assert.equal(b.singletons.sessionManager, sm);

      // The last owner stops the runtime and every handle is cleared.
      await disposeHost(pluginB);
      assert.equal(getSharedRuntime(), undefined);
      assert.equal(a.runtimeStore.getPluginRuntime(), undefined);
      assert.equal(a.singletons.sessionManager, null);
    } finally {
      await stopAll(pluginA, pluginB, pluginC);
    }
  });

  it("rebuilds the runtime when a newer registration brings different plugin settings", async () => {
    const a = await loadPluginCopy("config-a");
    const b = await loadPluginCopy("config-b");
    const pluginA = createPluginHost("A", { autoUpdate: false, maxSessions: 3 });
    const pluginB = createPluginHost("B", { autoUpdate: false, maxSessions: 7 });
    a.index.register(pluginA.api);
    b.index.register(pluginB.api);
    try {
      await startService(pluginA, {});
      const before = a.singletons.sessionManager;
      assert.equal(before.maxSessions, 3);
      await startService(pluginB, {});
      const after = b.singletons.sessionManager;
      assert.notEqual(after, before, "services are rebuilt from the new settings");
      assert.equal(after.maxSessions, 7);
      assert.equal(a.singletons.sessionManager, null);
    } finally {
      await stopAll(pluginB, pluginA);
    }
    assert.equal(getSharedRuntime(), undefined);
  });

  it("never lets an older registration run after a newer build has run, and ignores builds that never start", async () => {
    const older = await loadPluginCopy("older-idle", { distinctBuild: true });
    const newer = await loadPluginCopy("newer-ran");
    const inspection = await loadPluginCopy("inspection-only", { distinctBuild: true });
    const pluginOlder = createPluginHost("older");
    const pluginNewer = createPluginHost("newer");
    older.index.register(pluginOlder.api);
    newer.index.register(pluginNewer.api);
    try {
      // A newer build registered after `older` starts and stops again; `older` never started.
      await startService(pluginNewer, {});
      await pluginNewer.services[0]!.stop?.(pluginNewer.serviceContext);
      assert.equal(getSharedRuntime(), undefined);
      await assert.rejects(runTool(pluginOlder, "agent_sessions"), /superseded by a newer build/);
      assert.equal(getSharedRuntime(), undefined);

      // A later registration that only inspects the plugin (never starts) does not
      // block the build that is running.
      const pluginInspection = createPluginHost("inspection");
      inspection.index.register(pluginInspection.api);
      await runTool(pluginNewer, "agent_sessions");
      assert.ok(newer.singletons.sessionManager);
    } finally {
      await stopAll(pluginNewer, pluginOlder);
    }
  });

  it("hands off to a newer build only after the old runtime stopped", async () => {
    const oldBuild = await loadPluginCopy("old-build");
    const newBuild = await loadPluginCopy("new-build", { distinctBuild: true });
    const pluginOld = createPluginHost("old");
    oldBuild.index.register(pluginOld.api);
    const events: string[] = [];
    try {
      await startService(pluginOld, {});
      const oldSm = oldBuild.singletons.sessionManager;
      assert.ok(oldSm);
      const originalShutdown = oldSm.shutdown.bind(oldSm);
      oldSm.shutdown = async () => {
        events.push("old:shutdown:start");
        await originalShutdown();
        events.push("old:shutdown:done");
      };
      const NewSessionManager = newBuild.sessionManagerModule.SessionManager;
      const originalBootstrap = NewSessionManager.prototype.bootstrapMaintenanceSchedules;
      NewSessionManager.prototype.bootstrapMaintenanceSchedules = function (this: unknown, ...args: unknown[]) {
        events.push("new:started");
        return originalBootstrap.apply(this, args);
      };

      // Hot reload: the new build registers after the old one and starts.
      const pluginNew = createPluginHost("new");
      newBuild.index.register(pluginNew.api);
      try {
        await startService(pluginNew, {});
        assert.deepEqual(events, ["old:shutdown:start", "old:shutdown:done", "new:started"]);
        const newSm = newBuild.singletons.sessionManager;
        assert.ok(newSm);
        assert.notEqual(newSm, oldSm);
        assert.equal(oldBuild.singletons.sessionManager, null, "the superseded build lets go of its runtime");
        assert.notEqual(getSharedRuntime()?.buildId, undefined);

        // The superseded build never creates a second writer.
        await assert.rejects(runTool(pluginOld, "agent_sessions"), /superseded by a newer build/);
        assert.equal(newBuild.singletons.sessionManager, newSm);
      } finally {
        NewSessionManager.prototype.bootstrapMaintenanceSchedules = originalBootstrap;
        await stopAll(pluginNew);
      }
      // Not even once the newer runtime has stopped and the slot is empty.
      assert.equal(getSharedRuntime(), undefined);
      await assert.rejects(runTool(pluginOld, "agent_sessions"), /superseded by a newer build/);
      assert.equal(getSharedRuntime(), undefined);
    } finally {
      await stopAll(pluginOld);
    }
    assert.equal(getSharedRuntime(), undefined);
  });
});
