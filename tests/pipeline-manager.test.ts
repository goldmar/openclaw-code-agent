import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { PipelineManager } from "../src/pipeline-manager";
import { setSessionManager } from "../src/singletons";
import { setPluginConfig } from "../src/config";

describe("PipelineManager.spawnStage", () => {
  beforeEach(() => {
    setPluginConfig({
      harnesses: {
        codex: {
          approvalPolicy: "on-request",
        },
      },
    });
  });

  afterEach(() => {
    setSessionManager(null);
  });

  it("forces Codex pipeline stages to use approvalPolicy never", async () => {
    let capturedConfig: any;
    let startupResolve: () => void;

    const fakeSession = {
      id: "stage-3",
      name: "pipeline-review",
      status: "starting",
      error: undefined,
      waitForStartup: () => new Promise<void>((resolve) => { startupResolve = resolve; }),
      on: () => {},
      removeListener: () => {},
      getOutput: () => ["review output"],
      kill: () => {},
    };

    setSessionManager({
      spawn(config: unknown) {
        capturedConfig = config;
        return fakeSession;
      },
      notifySession() {},
    } as any);

    const pm = new PipelineManager();
    const run: any = {
      id: "pipe-1",
      name: "pipeline-name",
      prompt: "task",
      workdir: "/tmp",
      maxIterations: 1,
      status: "running",
      stages: [],
    };

    // spawnStage is private, call it directly for unit testing
    (pm as any).spawnStage(run, {
      kind: "codex-review",
      harness: "codex",
      prompt: "review prompt",
      iteration: 0,
    });

    // Verify the session config passed to spawn
    assert.equal(capturedConfig.permissionMode, "bypassPermissions");
    assert.equal(capturedConfig.codexApprovalPolicy, "never");

    // Stage should still be "starting" until startup completes
    assert.equal(run.stages[0]?.status, "starting");

    // Resolve startup — stage should transition to "running"
    startupResolve!();
    // Allow microtask to settle
    await new Promise<void>((r) => setTimeout(r, 10));
    assert.equal(run.stages[0]?.status, "running");
  });

  it("fails the stage immediately when startup never reaches running", async () => {
    const fakeSession = {
      id: "stage-timeout",
      name: "pipeline-review-timeout",
      status: "starting",
      error: undefined,
      waitForStartup: async () => {
        throw new Error("Session stage-timeout did not reach running state within 25ms");
      },
      on: () => {},
      removeListener: () => {},
      getOutput: () => [],
      kill: () => {},
    };

    setSessionManager({
      spawn() {
        return fakeSession;
      },
      notifySession() {},
    } as any);

    const pm = new PipelineManager();
    const run: any = {
      id: "pipe-timeout",
      name: "pipeline-timeout",
      prompt: "task",
      workdir: "/tmp",
      maxIterations: 1,
      status: "running",
      stages: [],
    };

    // spawnStage is synchronous but waitForStartup rejection is async
    (pm as any).spawnStage(run, {
      kind: "codex-review",
      harness: "codex",
      prompt: "review prompt",
      iteration: 0,
    });

    // Allow the waitForStartup rejection to propagate
    await new Promise<void>((r) => setTimeout(r, 10));

    // Stage should be marked as failed
    assert.equal(run.stages[0]?.status, "failed");
    assert.match(run.stages[0]?.error, /did not reach running state/);

    // Pipeline should be finalized as failed
    assert.equal(run.status, "failed");
  });
});
