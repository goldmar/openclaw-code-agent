import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SessionRuntimeBootstrapService } from "../src/session-runtime-bootstrap-service";
import type { Session } from "../src/session";

describe("SessionRuntimeBootstrapService", () => {
  it("does not launch a deferred session terminated while its previous writer drains", async () => {
    const previousWriter = Promise.withResolvers<void>();
    let launched = false;
    const service = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: () => {}, markRunning: () => {}, syncTaskMirror: () => {},
      handleTerminal: async () => {}, handleTurnEnd: async () => {},
      formatLaunchWorkdirLabel: () => "/repo", notifySession: () => {},
    });
    const session = Object.assign(new EventEmitter(), {
      id: "deferred-shutdown", name: "deferred-shutdown", status: "starting",
      start: async () => { launched = true; },
    });
    await service.initializeSession(session as Session, {} as any, {} as any, {
      startAfter: previousWriter.promise, notifyLaunch: false,
    });
    session.status = "killed";
    session.emit("statusChange", session, "killed");
    await service.drain();
    previousWriter.resolve();
    await previousWriter.promise;
    await Promise.resolve();
    assert.equal(launched, false);
  });

  it("drains mirror completion before terminal persistence and its cleanup finish", async () => {
    const finalized = Promise.withResolvers<void>();
    const terminalEntered = Promise.withResolvers<void>();
    const terminalFinished = Promise.withResolvers<void>();
    const calls: string[] = [];
    const service = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: () => {},
      markRunning: () => {},
      syncTaskMirror: () => { calls.push("mirror"); },
      handleTerminal: async () => {
        calls.push("terminal");
        terminalEntered.resolve();
        await terminalFinished.promise;
      },
      handleTurnEnd: async () => {},
      formatLaunchWorkdirLabel: () => "/repo",
      notifySession: () => {},
    });
    const session = Object.assign(new EventEmitter(), {
      id: "drained-session",
      name: "drained-session",
      start: async () => {},
    });
    await service.initializeSession(session as Session, {} as Parameters<typeof service.initializeSession>[1], {
      prompt: "mirror completion",
      workdir: "/repo",
      permissionMode: "plan",
      taskLifecycle: { create() {}, progress() {}, finalize: () => finalized.promise },
    }, { notifyLaunch: false });
    session.emit("statusChange", session, "completed");
    let drained = false;
    const drain = service.drain().then(() => { drained = true; });
    try {
      await Promise.resolve();
      assert.deepEqual(calls, []);
      assert.equal(drained, false);
      finalized.resolve();
      await terminalEntered.promise;
      assert.equal(drained, false);
      terminalFinished.resolve();
      await drain;
      assert.deepEqual(calls, ["terminal"]);
      assert.equal(drained, true);
    } finally {
      finalized.resolve();
      terminalFinished.resolve();
      await drain;
    }
  });

  it("publishes a mirror only after its asynchronous creation settles", async () => {
    const created = Promise.withResolvers<void>();
    let published = false;
    const service = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: () => {},
      markRunning: () => {},
      syncTaskMirror: () => { published = true; },
      handleTerminal: async () => {},
      handleTurnEnd: async () => {},
      formatLaunchWorkdirLabel: () => "/repo",
      notifySession: () => {},
    });
    const session = Object.assign(new EventEmitter(), {
      id: "created-session", name: "created-session", start: async () => {},
    });
    await service.initializeSession(session as Session, {} as Parameters<typeof service.initializeSession>[1], {
      prompt: "mirror creation", workdir: "/repo", permissionMode: "plan",
      taskLifecycle: { create: () => created.promise, progress() {}, finalize() {} },
    }, { notifyLaunch: false });
    try {
      assert.equal(published, false);
      created.resolve();
      await service.drain();
      assert.equal(published, true);
    } finally {
      created.resolve();
      await service.drain();
    }
  });

  it("routes a host TaskFlow cancel intent to the session cancel hook", async () => {
    const cancelled: string[] = [];
    let hooks: { onCancelRequested?: () => void } | undefined;
    const service = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: () => {},
      markRunning: () => {},
      syncTaskMirror: () => {},
      handleTerminal: async () => {},
      handleTurnEnd: async () => {},
      formatLaunchWorkdirLabel: () => "/repo",
      notifySession: () => {},
      cancelSession: (session) => { cancelled.push(session.id); },
    });
    const session = Object.assign(new EventEmitter(), {
      id: "cancelled-session", name: "cancelled-session", start: async () => {},
    });
    await service.initializeSession(session as Session, {} as Parameters<typeof service.initializeSession>[1], {
      prompt: "mirror cancel", workdir: "/repo", permissionMode: "plan",
      taskLifecycle: {
        create(_session, createHooks) { hooks = createHooks; },
        progress() {},
        finalize() {},
      },
    }, { notifyLaunch: false });

    hooks?.onCancelRequested?.();
    await service.drain();
    assert.deepEqual(cancelled, ["cancelled-session"]);
  });

  it("does not announce a launch when the session stopped while its label was built", async () => {
    const notifications: string[] = [];
    let releaseLabel!: (label: string) => void;
    const service = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: () => {},
      markRunning: () => {},
      syncTaskMirror: () => {},
      handleTerminal: async () => {},
      handleTurnEnd: async () => {},
      formatLaunchWorkdirLabel: () => new Promise<string>((resolve) => { releaseLabel = resolve; }),
      notifySession: (_session, text) => { notifications.push(text); },
    });
    const session = Object.assign(new EventEmitter(), {
      id: "stopped-during-label", name: "stopped-during-label", status: "starting", start: () => {},
    });

    const initializing = service.initializeSession(session as any, {} as any, {} as any);
    session.status = "killed"; // shutdown stops the session while the workdir label awaits git
    releaseLabel("/repo");
    await initializing;

    assert.deepEqual(notifications, []);
  });

  it("includes harness and model in launch notifications", async () => {
    const notifications: Array<{ text: string; label?: string; idempotencyKey?: string }> = [];
    const service = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: () => {},
      markRunning: () => {},
      syncTaskMirror: () => {},
      handleTerminal: async () => {},
      handleTurnEnd: async () => {},
      formatLaunchWorkdirLabel: () => "/repo/worktree (worktree of /repo)",
      notifySession: (_session, text, label, idempotencyKey) => {
        notifications.push({ text, label, idempotencyKey });
      },
    });

    const session = Object.assign(new EventEmitter(), {
      id: "session-1",
      name: "launch-session",
      model: "gpt-5.5",
      harnessName: "codex",
      start: () => {},
    });

    await service.initializeSession(session as any, {} as any, {} as any);

    assert.deepEqual(notifications, [
      {
        text: "🚀 [launch-session] Launched | /repo/worktree (worktree of /repo) | codex | gpt-5.5",
        label: "launch",
        idempotencyKey: undefined,
      },
    ]);
  });

  it("uses a resumed launch notification and cycle-specific idempotency key", async () => {
    const notifications: Array<{ text: string; label?: string; idempotencyKey?: string }> = [];
    const service = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: () => {},
      markRunning: () => {},
      syncTaskMirror: () => {},
      handleTerminal: async () => {},
      handleTurnEnd: async () => {},
      formatLaunchWorkdirLabel: () => "/repo",
      notifySession: (_session, text, label, idempotencyKey) => {
        notifications.push({ text, label, idempotencyKey });
      },
    });

    const session = Object.assign(new EventEmitter(), {
      id: "stable-session-1",
      name: "resume-session",
      model: "gpt-5.5",
      harnessName: "codex",
      startedAt: 1_780_000_001_000,
      resumeSessionId: "backend-thread-1",
      start: () => {},
    });

    await service.initializeSession(session as any, {} as any, { resumeSessionId: "backend-thread-1" } as any);

    assert.deepEqual(notifications, [
      {
        text: "▶️ [resume-session] Resumed | /repo | codex | gpt-5.5",
        label: "resumed-launch",
        idempotencyKey: "resumed-launch:stable-session-1:1780000001000:backend-thread-1",
      },
    ]);
  });

  it("shows the original session name and explicit follow-up label in resumed launch notifications", async () => {
    const notifications: Array<{ text: string; label?: string; idempotencyKey?: string }> = [];
    const service = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: () => {},
      markRunning: () => {},
      syncTaskMirror: () => {},
      handleTerminal: async () => {},
      handleTurnEnd: async () => {},
      formatLaunchWorkdirLabel: () => "/repo",
      notifySession: (_session, text, label, idempotencyKey) => {
        notifications.push({ text, label, idempotencyKey });
      },
    });

    const session = Object.assign(new EventEmitter(), {
      id: "_QDNlLZr",
      name: "oca-pr-341-bundle-size-fix",
      resumedFromSessionName: "oca-auto-update-feature",
      model: "gpt-5.5",
      harnessName: "codex",
      startedAt: 1_780_000_001_000,
      resumeSessionId: "thread-auto-update-feature",
      start: () => {},
    });

    await service.initializeSession(session as any, {} as any, { resumeSessionId: "thread-auto-update-feature" } as any);

    assert.deepEqual(notifications, [
      {
        text: "▶️ [oca-auto-update-feature] Resumed | Follow-up label: oca-pr-341-bundle-size-fix | /repo | codex | gpt-5.5",
        label: "resumed-launch",
        idempotencyKey: "resumed-launch:_QDNlLZr:1780000001000:thread-auto-update-feature",
      },
    ]);
  });
});
