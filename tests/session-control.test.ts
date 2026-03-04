import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getKillSessionText } from "../src/application/session-control";

describe("session-control app layer", () => {
  it("returns not found text for unknown session", () => {
    const sm: any = { resolve: () => undefined };
    const text = getKillSessionText(sm, "missing");
    assert.equal(text, 'Error: Session "missing" not found.');
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
