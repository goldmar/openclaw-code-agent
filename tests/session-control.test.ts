import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getKillSessionText } from "../src/application/session-control";

describe("session-control app layer", () => {
  it("returns not found text for unknown session", () => {
    const sm: any = { resolve: () => undefined, getPersistedSession: () => undefined };
    const text = getKillSessionText(sm, "missing");
    assert.equal(text, 'Error: Session "missing" not found.');
  });

  it("dismisses recovered persisted-only sessions instead of reporting not found", () => {
    let patchRef: string | undefined;
    let patch: Record<string, unknown> | undefined;
    const sm: any = {
      resolve: () => undefined,
      getPersistedSession: () => ({
        sessionId: "s-recovered",
        harnessSessionId: "h-recovered",
        name: "recovered",
        status: "killed",
        lifecycle: "suspended",
      }),
      updatePersistedSession: (ref: string, nextPatch: Record<string, unknown>) => {
        patchRef = ref;
        patch = nextPatch;
        return true;
      },
    };

    const text = getKillSessionText(sm, "recovered");

    assert.equal(patchRef, "recovered");
    assert.equal(patch?.status, "killed");
    assert.equal(patch?.lifecycle, "terminal");
    assert.equal(patch?.runtimeState, "stopped");
    assert.equal(patch?.resumable, false);
    assert.equal(patch?.killReason, "user");
    assert.match(text, /dismissed/);
    assert.match(text, /No live process was running/);
  });

  it("marks recovered persisted-only sessions completed when requested", () => {
    let patch: Record<string, unknown> | undefined;
    const sm: any = {
      resolve: () => undefined,
      getPersistedSession: () => ({
        sessionId: "s-recovered",
        name: "recovered",
        status: "killed",
        lifecycle: "suspended",
      }),
      updatePersistedSession: (_ref: string, nextPatch: Record<string, unknown>) => {
        patch = nextPatch;
        return true;
      },
    };

    const text = getKillSessionText(sm, "recovered", "completed");

    assert.equal(patch?.status, "completed");
    assert.equal(patch?.killReason, "done");
    assert.match(text, /marked as completed/);
  });

  it("marks session completed when requested", () => {
    let completed = false;
    const session = {
      name: "s",
      id: "1",
      status: "running",
      complete: () => { completed = true; },
    };
    const sm: any = { resolve: () => session };
    const text = getKillSessionText(sm, "s", "completed");
    assert.equal(completed, true);
    assert.match(text, /marked as completed/);
  });

  it("kills session via SessionManager when reason is killed", () => {
    const session = { name: "s", id: "1", status: "running" };
    let killedId: string | undefined;
    const sm: any = {
      resolve: () => session,
      kill: (id: string) => { killedId = id; },
    };
    const text = getKillSessionText(sm, "s", "killed");
    assert.equal(killedId, "1");
    assert.match(text, /has been terminated/);
  });
});
