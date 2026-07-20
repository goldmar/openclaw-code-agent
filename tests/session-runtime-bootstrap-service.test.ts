import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SessionRuntimeBootstrapService } from "../src/session-runtime-bootstrap-service";

describe("SessionRuntimeBootstrapService", () => {
  it("sends one concise launch acknowledgement without implementation metadata", () => {
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
        text: "🚀 [launch-session] Started",
        label: "launch",
        idempotencyKey: undefined,
      },
    ]);
  });

  it("does not push another launch notification for a resumed session", () => {
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

    assert.deepEqual(notifications, []);
  });

  it("keeps renamed resumed sessions silent too", () => {
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

    assert.deepEqual(notifications, []);
  });
});
