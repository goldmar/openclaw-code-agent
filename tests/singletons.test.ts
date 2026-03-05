import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setSessionManager } from "../src/singletons";

// We need to access the live bindings, so we use the module directly
import * as singletons from "../src/singletons";

// Reset after each test to avoid cross-test contamination
afterEach(() => {
  setSessionManager(null);
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
