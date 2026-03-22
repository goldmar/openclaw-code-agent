import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  registerHarness,
  getHarness,
  getDefaultHarness,
  listHarnesses,
} from "../src/harness/index";
import type { AgentHarness } from "../src/harness/types";

// ---------------------------------------------------------------------------
// Built-in ClaudeCodeHarness (auto-registered on module import)
// ---------------------------------------------------------------------------

describe("harness registry — built-in registration", () => {
  it("getHarness('claude-code') returns the built-in harness", () => {
    const h = getHarness("claude-code");
    assert.equal(h.name, "claude-code");
  });

  it("getDefaultHarness() returns 'claude-code'", () => {
    const h = getDefaultHarness();
    assert.equal(h.name, "claude-code");
  });

  it("listHarnesses() includes 'claude-code'", () => {
    const list = listHarnesses();
    assert.ok(list.includes("claude-code"));
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("harness registry — error handling", () => {
  it("getHarness throws for unknown harness name", () => {
    assert.throws(
      () => getHarness("nonexistent-harness"),
      /Unknown agent harness: "nonexistent-harness"/,
    );
  });

  it("error message includes available harnesses", () => {
    try {
      getHarness("bad-name");
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.ok(err.message.includes("claude-code"), "error should list available harnesses");
    }
  });
});

// ---------------------------------------------------------------------------
// Custom harness registration
// ---------------------------------------------------------------------------

describe("harness registry — custom registration", () => {
  const createTestHarness = (name: string): AgentHarness => ({
    name,
    supportedPermissionModes: ["default"],
    questionToolNames: [],
    planApprovalToolNames: [],
    launch() { return { messages: (async function*() {})() }; },
    buildUserMessage(text: string, sessionId: string) { return { text, sessionId }; },
  });

  it("registerHarness() makes a harness retrievable", () => {
    const h = createTestHarness("test-harness-1");
    registerHarness(h);
    assert.equal(getHarness("test-harness-1"), h);
  });

  it("listHarnesses() includes custom registered harnesses", () => {
    registerHarness(createTestHarness("test-harness-2"));
    const list = listHarnesses();
    assert.ok(list.includes("test-harness-2"));
  });

  it("registerHarness overwrites existing harness with same name", () => {
    const h1 = createTestHarness("overwrite-test");
    const h2 = createTestHarness("overwrite-test");
    registerHarness(h1);
    registerHarness(h2);
    assert.equal(getHarness("overwrite-test"), h2);
    assert.notEqual(getHarness("overwrite-test"), h1);
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeHarness properties
// ---------------------------------------------------------------------------

describe("ClaudeCodeHarness properties", () => {
  it("has correct name", () => {
    const h = getHarness("claude-code");
    assert.equal(h.name, "claude-code");
  });

  it("has expected questionToolNames", () => {
    const h = getHarness("claude-code");
    assert.ok(h.questionToolNames.includes("AskUserQuestion"));
  });

  it("has expected planApprovalToolNames", () => {
    const h = getHarness("claude-code");
    assert.ok(h.planApprovalToolNames.includes("ExitPlanMode"));
  });

  it("has expected supportedPermissionModes", () => {
    const h = getHarness("claude-code");
    assert.ok(h.supportedPermissionModes.includes("default"));
    assert.ok(h.supportedPermissionModes.includes("plan"));
    assert.ok(h.supportedPermissionModes.includes("bypassPermissions"));
  });

  it("buildUserMessage returns correct structure", () => {
    const h = getHarness("claude-code");
    const msg = h.buildUserMessage("hello world", "sess-123");
    assert.equal(msg.type, "user");
    assert.equal(msg.message.role, "user");
    assert.equal(msg.message.content, "hello world");
    assert.equal(msg.session_id, "sess-123");
  });
});
