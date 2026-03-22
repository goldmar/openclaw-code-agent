import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session";
import type { SessionConfig } from "../src/types";

const BASE_CONFIG: SessionConfig = {
  prompt: "test prompt",
  workdir: "/tmp",
  permissionMode: "plan",
};

describe("Session state machine", () => {
  let session: Session;

  beforeEach(() => {
    session = new Session(BASE_CONFIG, "test");
  });

  it("starts in 'starting' status", () => {
    assert.equal(session.status, "starting");
  });

  describe("valid transitions", () => {
    it("starting → running", () => {
      session.transition("running");
      assert.equal(session.status, "running");
    });

    it("starting → failed", () => {
      session.transition("failed");
      assert.equal(session.status, "failed");
    });

    it("starting → killed", () => {
      session.transition("killed");
      assert.equal(session.status, "killed");
    });

    it("running → completed", () => {
      session.transition("running");
      session.transition("completed");
      assert.equal(session.status, "completed");
    });

    it("running → failed", () => {
      session.transition("running");
      session.transition("failed");
      assert.equal(session.status, "failed");
    });

    it("running → killed", () => {
      session.transition("running");
      session.transition("killed");
      assert.equal(session.status, "killed");
    });
  });

  describe("invalid transitions", () => {
    it("starting → completed throws", () => {
      assert.throws(() => session.transition("completed"), /Session state error: cannot transition/);
    });

    it("completed → running throws", () => {
      session.transition("running");
      session.transition("completed");
      assert.throws(() => session.transition("running"), /Session state error: cannot transition/);
    });

    it("killed → running throws", () => {
      session.transition("killed");
      assert.throws(() => session.transition("running"), /Session state error: cannot transition/);
    });
  });
});

describe("Session.kill()", () => {
  let session: Session;

  beforeEach(() => {
    session = new Session(BASE_CONFIG, "test");
  });

  it("transitions from running to killed with reason", () => {
    session.transition("running");
    session.kill("user");
    assert.equal(session.status, "killed");
    assert.equal(session.killReason, "user");
    assert.ok(session.completedAt, "should set completedAt");
  });

  it("is a no-op from completed state", () => {
    session.transition("running");
    session.transition("completed");
    session.kill("user");
    assert.equal(session.status, "completed");
  });

  it("can kill directly from starting state", () => {
    session.kill("startup-timeout");
    assert.equal(session.status, "killed");
    assert.equal(session.killReason, "startup-timeout");
    assert.ok(session.completedAt, "should set completedAt");
  });
});

describe("Session.complete()", () => {
  let session: Session;

  beforeEach(() => {
    session = new Session(BASE_CONFIG, "test");
  });

  it("transitions from running to completed with 'done' reason", () => {
    session.transition("running");
    session.complete();
    assert.equal(session.status, "completed");
    assert.equal(session.killReason, "done");
    assert.ok(session.completedAt, "should set completedAt");
  });

  it("is a no-op from killed state", () => {
    session.transition("running");
    session.kill("user");
    assert.equal(session.status, "killed");
    session.complete();
    assert.equal(session.status, "killed");
  });

});

describe("Session event emission", () => {
  it("emits statusChange on transition", () => {
    const session = new Session(BASE_CONFIG, "test");
    const events: Array<{ newStatus: string; prevStatus: string }> = [];
    session.on("statusChange", (_s, newStatus, prevStatus) => {
      events.push({ newStatus, prevStatus });
    });
    session.transition("running");
    assert.equal(events.length, 1);
    assert.equal(events[0].newStatus, "running");
    assert.equal(events[0].prevStatus, "starting");
  });

  it("includes killReason/completedAt on first killed statusChange", () => {
    const session = new Session(BASE_CONFIG, "test");
    session.transition("running");
    let snapshot: { reason: string; completedAt?: number } | undefined;
    session.on("statusChange", (s, newStatus) => {
      if (newStatus === "killed" && !snapshot) {
        snapshot = { reason: s.killReason, completedAt: s.completedAt };
      }
    });
    session.kill("user");
    assert.equal(snapshot?.reason, "user");
    assert.ok(snapshot?.completedAt);
  });

  it("includes killReason/completedAt on first completed statusChange", () => {
    const session = new Session(BASE_CONFIG, "test");
    session.transition("running");
    let snapshot: { reason: string; completedAt?: number } | undefined;
    session.on("statusChange", (s, newStatus) => {
      if (newStatus === "completed" && !snapshot) {
        snapshot = { reason: s.killReason, completedAt: s.completedAt };
      }
    });
    session.complete("done");
    assert.equal(snapshot?.reason, "done");
    assert.ok(snapshot?.completedAt);
  });
});

describe("Session.duration", () => {
  let session: Session;

  beforeEach(() => {
    session = new Session(BASE_CONFIG, "test");
  });

  it("returns elapsed ms from startedAt", () => {
    assert.ok(session.duration >= 0);
    assert.ok(session.duration < 1000);
  });

  it("returns fixed duration after completedAt is set", () => {
    session.startedAt = 1000;
    session.completedAt = 6000;
    assert.equal(session.duration, 5000);
  });
});

describe("Session.getOutput()", () => {
  let session: Session;

  beforeEach(() => {
    session = new Session(BASE_CONFIG, "test");
  });

  it("returns empty array initially", () => {
    assert.deepEqual(session.getOutput(), []);
  });

  it("returns all output when no limit", () => {
    session.outputBuffer.push("line1", "line2", "line3");
    assert.deepEqual(session.getOutput(), ["line1", "line2", "line3"]);
  });

  it("returns last N lines when limit specified", () => {
    session.outputBuffer.push("line1", "line2", "line3");
    assert.deepEqual(session.getOutput(2), ["line2", "line3"]);
  });
});

describe("Session constructor", () => {
  it("generates a unique id", () => {
    const s1 = new Session(BASE_CONFIG, "a");
    const s2 = new Session(BASE_CONFIG, "b");
    assert.notEqual(s1.id, s2.id);
  });

  it("applies config fields", () => {
    const session = new Session(
      { ...BASE_CONFIG, model: "opus", originChannel: "telegram|123", multiTurn: false },
      "named",
    );
    assert.equal(session.name, "named");
    assert.equal(session.model, "opus");
    assert.equal(session.originChannel, "telegram|123");
    assert.equal(session.multiTurn, false);
  });

  it("defaults multiTurn to true", () => {
    const session = new Session(BASE_CONFIG, "test");
    assert.equal(session.multiTurn, true);
  });
});

describe("Session.phase", () => {
  let session: Session;

  beforeEach(() => {
    session = new Session(BASE_CONFIG, "test");
  });

  it("returns 'starting' when status is starting", () => {
    assert.equal(session.phase, "starting");
  });

  it("returns 'planning' when running in plan mode without pending approval", () => {
    session.transition("running");
    assert.equal(session.phase, "planning");
  });

  it("returns 'awaiting-plan-approval' when pendingPlanApproval is true", () => {
    session.transition("running");
    session.pendingPlanApproval = true;
    assert.equal(session.phase, "awaiting-plan-approval");
  });

  it("returns 'implementing' when permission mode is bypassPermissions", () => {
    session.transition("running");
    session.currentPermissionMode = "bypassPermissions";
    assert.equal(session.phase, "implementing");
  });

  it("returns 'implementing' when permission mode is bypassPermissions", () => {
    session.transition("running");
    session.currentPermissionMode = "bypassPermissions";
    assert.equal(session.phase, "implementing");
  });

  it("returns 'implementing' when permission mode is default", () => {
    session.transition("running");
    session.currentPermissionMode = "default";
    assert.equal(session.phase, "implementing");
  });

  it("returns status name for terminal states", () => {
    session.transition("running");
    session.transition("completed");
    assert.equal(session.phase, "completed");
  });

  it("awaiting-plan-approval takes precedence over plan mode", () => {
    session.transition("running");
    session.pendingPlanApproval = true;
    // currentPermissionMode is still "plan" from BASE_CONFIG
    assert.equal(session.currentPermissionMode, "plan");
    assert.equal(session.phase, "awaiting-plan-approval");
  });

  it("surfaces Codex sessions as implementing even when configured in plan mode", () => {
    const codexSession = new Session({ ...BASE_CONFIG, harness: "codex" }, "codex-test");
    codexSession.transition("running");

    assert.equal(codexSession.currentPermissionMode, "default");
    assert.equal(codexSession.phase, "implementing");
  });
});
