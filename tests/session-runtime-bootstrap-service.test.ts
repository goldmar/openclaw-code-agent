import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SessionRuntimeBootstrapService } from "../src/session-runtime-bootstrap-service";

describe("SessionRuntimeBootstrapService", () => {
  it("includes harness and model in launch notifications", () => {
    const notifications: string[] = [];
    const service = new SessionRuntimeBootstrapService({
      hydrateSpawnedSession: () => {},
      markRunning: () => {},
      handleTerminal: async () => {},
      handleTurnEnd: () => {},
      formatLaunchWorkdirLabel: () => "/repo/worktree (worktree of /repo)",
      notifySession: (_session, text) => { notifications.push(text); },
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
      "🚀 [launch-session] Launched | /repo/worktree (worktree of /repo) | codex / gpt-5.5",
    ]);
  });
});
