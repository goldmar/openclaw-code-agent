import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  generateSessionName,
  truncateText,
  lastCompleteLines,
  formatSessionListing,
  formatStats,
} from "../src/format";
import type { SessionMetrics } from "../src/types";

describe("formatDuration", () => {
  it("returns 0s for zero", () => {
    assert.equal(formatDuration(0), "0s");
  });

  it("returns seconds only when < 60s", () => {
    assert.equal(formatDuration(5000), "5s");
    assert.equal(formatDuration(59000), "59s");
  });

  it("returns minutes and seconds", () => {
    assert.equal(formatDuration(90000), "1m30s");
    assert.equal(formatDuration(60000), "1m0s");
  });

  it("floors sub-second values to 0s", () => {
    assert.equal(formatDuration(500), "0s");
    assert.equal(formatDuration(999), "0s");
  });
});

describe("generateSessionName", () => {
  it("extracts up to 3 keywords", () => {
    assert.equal(generateSessionName("fix auth token refresh"), "fix-auth-token");
  });

  it("filters stop words", () => {
    assert.equal(generateSessionName("please create a new feature"), "new-feature");
  });

  it("returns 'session' for empty input", () => {
    assert.equal(generateSessionName(""), "session");
  });

  it("returns 'session' when all words are stop words", () => {
    assert.equal(generateSessionName("please just do it"), "session");
  });

  it("strips punctuation", () => {
    assert.equal(generateSessionName("fix: the bug!"), "fix-bug");
  });

  it("filters single-char words", () => {
    assert.equal(generateSessionName("a b c data"), "data");
  });
});

describe("truncateText", () => {
  it("returns short text unchanged", () => {
    assert.equal(truncateText("hello", 10), "hello");
  });

  it("truncates long text with ...", () => {
    assert.equal(truncateText("hello world", 5), "hello...");
  });

  it("handles exact boundary", () => {
    assert.equal(truncateText("12345", 5), "12345");
  });
});

describe("lastCompleteLines", () => {
  it("returns empty for empty input", () => {
    assert.equal(lastCompleteLines("", 100), "");
  });

  it("returns all lines when they fit", () => {
    assert.equal(lastCompleteLines("a\nb\nc", 100), "a\nb\nc");
  });

  it("drops earliest lines first", () => {
    const result = lastCompleteLines("first\nsecond\nthird", 12);
    assert.ok(!result.includes("first"), "should drop 'first'");
    assert.ok(result.includes("third"), "should keep 'third'");
  });

  it("never cuts mid-line", () => {
    const result = lastCompleteLines("short\nalongerline", 12);
    assert.ok(
      result === "short\nalongerline" || result === "alongerline",
      `Got: ${result}`
    );
  });
});

// Minimal session-like object for formatSessionListing tests
function makeSession(overrides: Record<string, any> = {}) {
  return {
    status: "running",
    name: "s",
    id: "x",
    duration: 0,
    prompt: "p",
    workdir: "/tmp",
    multiTurn: true,
    costUsd: 0,
    harnessSessionId: undefined,
    resumeSessionId: undefined,
    forkSession: undefined,
    ...overrides,
  } as any;
}

describe("formatSessionListing", () => {
  it("shows status icon, name, id, duration, mode", () => {
    const result = formatSessionListing(
      makeSession({ name: "test-session", id: "abc123", duration: 60000, prompt: "do something" }),
    );
    assert.ok(result.includes("🟢"), "should have running icon");
    assert.ok(result.includes("test-session"), "should have name");
    assert.ok(result.includes("abc123"), "should have id");
    assert.ok(result.includes("1m0s"), "should have duration");
    assert.ok(result.includes("multi-turn"), "should show multi-turn mode");
  });

  it("truncates prompt at 80 chars", () => {
    const result = formatSessionListing(
      makeSession({ status: "completed", prompt: "x".repeat(100), multiTurn: false }),
    );
    assert.ok(result.includes("..."), "should truncate long prompt");
    assert.ok(result.includes("single"), "should show single mode");
  });

  it("shows session ID when present", () => {
    const result = formatSessionListing(makeSession({ harnessSessionId: "session-123" }));
    assert.ok(result.includes("session-123"));
  });

  it("shows phase for running session in plan mode", () => {
    const result = formatSessionListing(
      makeSession({ status: "running", phase: "planning" }),
    );
    assert.ok(result.includes("Phase: planning"), "should show planning phase");
  });

  it("shows phase for session awaiting plan approval", () => {
    const result = formatSessionListing(
      makeSession({ status: "running", phase: "awaiting-plan-approval" }),
    );
    assert.ok(result.includes("awaiting-plan-approval"), "should show awaiting phase");
  });

  it("does not show phase for completed session", () => {
    const result = formatSessionListing(
      makeSession({ status: "completed", phase: "completed" }),
    );
    assert.ok(!result.includes("Phase:"), "should not show Phase for completed");
  });
});

describe("formatStats", () => {
  const EMPTY_METRICS: SessionMetrics = {
    totalCostUsd: 0,
    costPerDay: new Map(),
    sessionsByStatus: { completed: 0, failed: 0, killed: 0 },
    totalLaunched: 0,
    totalDurationMs: 0,
    sessionsWithDuration: 0,
    mostExpensive: null,
  };

  it("formats zero-session metrics", () => {
    const result = formatStats(EMPTY_METRICS, 0);
    assert.ok(result.includes("Launched:   0"));
    assert.ok(result.includes("n/a"), "should show n/a for avg duration");
  });

  it("formats populated metrics with mostExpensive", () => {
    const metrics: SessionMetrics = {
      ...EMPTY_METRICS,
      totalCostUsd: 1.5,
      sessionsByStatus: { completed: 5, failed: 1, killed: 2 },
      totalLaunched: 8,
      totalDurationMs: 480000,
      sessionsWithDuration: 4,
      mostExpensive: { id: "abc", name: "big-job", costUsd: 0.8, prompt: "do stuff" },
    };
    const result = formatStats(metrics, 2);
    assert.ok(result.includes("Launched:   8"));
    assert.ok(result.includes("Running:    2"));
    assert.ok(result.includes("Completed:  5"));
    assert.ok(result.includes("2m0s"), "avg duration should be 120s = 2m0s");
    assert.ok(result.includes("big-job"), "should show notable session");
  });
});
