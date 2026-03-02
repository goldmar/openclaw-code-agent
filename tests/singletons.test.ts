import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  setSessionManager,
  setNotificationService,
} from "../src/singletons";

// We need to access the live bindings, so we use the module directly
import * as singletons from "../src/singletons";

// Reset after each test to avoid cross-test contamination
afterEach(() => {
  setSessionManager(null);
  setNotificationService(null);
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

describe("singletons — notificationService", () => {
  it("is initially null (after reset)", () => {
    assert.equal(singletons.notificationService, null);
  });

  it("setNotificationService sets the value", () => {
    const fakeNs = { fake: true } as any;
    setNotificationService(fakeNs);
    assert.equal(singletons.notificationService, fakeNs);
  });

  it("setNotificationService(null) clears the value", () => {
    setNotificationService({ fake: true } as any);
    setNotificationService(null);
    assert.equal(singletons.notificationService, null);
  });
});
