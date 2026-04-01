import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setGoalController, setSessionManager } from "../src/singletons";

// We need to access the live bindings, so we use the module directly
import * as singletons from "../src/singletons";

// Reset after each test to avoid cross-test contamination
afterEach(() => {
  setSessionManager(null);
  setGoalController(null);
});

describe("singletons — sessionManager", () => {
  it("is initially null (after reset)", () => {
    assert.equal(singletons.sessionManager, null);
  });

  it("setSessionManager sets the value", () => {
    const fakeSm = { fake: true } as any;
    setSessionManager(fakeSm);
    assert.equal(singletons.sessionManager, fakeSm);
  });

  it("setSessionManager(null) clears the value", () => {
    setSessionManager({ fake: true } as any);
    setSessionManager(null);
    assert.equal(singletons.sessionManager, null);
  });
});

describe("singletons — goalController", () => {
  it("is initially null (after reset)", () => {
    assert.equal(singletons.goalController, null);
  });

  it("setGoalController sets the value", () => {
    const fakeController = { fake: true } as any;
    setGoalController(fakeController);
    assert.equal(singletons.goalController, fakeController);
  });

  it("setGoalController(null) clears the value", () => {
    setGoalController({ fake: true } as any);
    setGoalController(null);
    assert.equal(singletons.goalController, null);
  });
});
