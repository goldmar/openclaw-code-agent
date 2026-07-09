import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SessionRuntimeBootstrapService } from "../src/session-runtime-bootstrap-service";

describe("SessionRuntimeBootstrapService", () => {
  it("includes harness and model in launch notifications", () => {
    const notifications: Array<{ text: string; label?: string; idempotencyKey?: string }> = [];
    const service = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: () => {},
      markRunning: () => {},
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

    service.initializeSession(session as any, {} as any, {} as any);

    assert.deepEqual(notifications, [
      {
        text: "🚀 [launch-session] Launched | /repo/worktree (worktree of /repo) | codex | gpt-5.5",
        label: "launch",
        idempotencyKey: undefined,
      },
    ]);
  });

  it("uses a resumed launch notification and cycle-specific idempotency key", () => {
    const notifications: Array<{ text: string; label?: string; idempotencyKey?: string }> = [];
    const service = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: () => {},
      markRunning: () => {},
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

    service.initializeSession(session as any, {} as any, { resumeSessionId: "backend-thread-1" } as any);

    assert.deepEqual(notifications, [
      {
        text: "▶️ [resume-session] Resumed | /repo | codex | gpt-5.5",
        label: "resumed-launch",
        idempotencyKey: "resumed-launch:stable-session-1:1780000001000:backend-thread-1",
      },
    ]);
  });

  it("shows the original session name and explicit follow-up label in resumed launch notifications", () => {
    const notifications: Array<{ text: string; label?: string; idempotencyKey?: string }> = [];
    const service = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: () => {},
      markRunning: () => {},
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

    service.initializeSession(session as any, {} as any, { resumeSessionId: "thread-auto-update-feature" } as any);

    assert.deepEqual(notifications, [
      {
        text: "▶️ [oca-auto-update-feature] Resumed | Follow-up label: oca-pr-341-bundle-size-fix | /repo | codex | gpt-5.5",
        label: "resumed-launch",
        idempotencyKey: "resumed-launch:_QDNlLZr:1780000001000:thread-auto-update-feature",
      },
    ]);
  });
});
