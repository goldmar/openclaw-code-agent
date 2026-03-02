import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeToolInput, NotificationService } from "../src/notifications";

describe("summarizeToolInput", () => {
  it("extracts file_path", () => {
    assert.equal(summarizeToolInput({ file_path: "/foo/bar.ts" }), "/foo/bar.ts");
  });

  it("extracts command", () => {
    assert.equal(summarizeToolInput({ command: "npm install" }), "npm install");
  });

  it("extracts pattern", () => {
    assert.equal(summarizeToolInput({ pattern: "*.ts" }), "*.ts");
  });

  it("extracts glob", () => {
    assert.equal(summarizeToolInput({ glob: "src/**" }), "src/**");
  });

  it("extracts path", () => {
    assert.equal(summarizeToolInput({ path: "/some/dir" }), "/some/dir");
  });

  it("returns empty string for null", () => {
    assert.equal(summarizeToolInput(null), "");
  });

  it("returns empty string for empty object", () => {
    assert.equal(summarizeToolInput({}), "");
  });

  it("returns empty string for non-object", () => {
    assert.equal(summarizeToolInput("string"), "");
  });

  it("falls back to first string value", () => {
    assert.equal(summarizeToolInput({ custom: "hello" }), "hello");
  });

  it("truncates long values to 60 chars", () => {
    const result = summarizeToolInput({ file_path: "/a".repeat(50) });
    assert.equal(result.length, 60);
    assert.ok(result.endsWith("..."));
  });
});

// ---------------------------------------------------------------------------
// NotificationService class
// ---------------------------------------------------------------------------

describe("NotificationService", () => {
  it("constructor wraps sendMessage", () => {
    const calls: any[][] = [];
    const spy = (channelId: string, text: string, threadId?: string | number) => {
      calls.push([channelId, text, threadId]);
    };
    const ns = new NotificationService(spy);
    ns.emitToChannel("telegram|123", "hello", 42);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["telegram|123", "hello", 42]);
  });

  it("emitToChannel calls sendMessage with correct args", () => {
    const calls: any[][] = [];
    const spy = (...args: any[]) => { calls.push(args); };
    const ns = new NotificationService(spy);
    ns.emitToChannel("discord|bot|789", "test message", "thread-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "discord|bot|789");
    assert.equal(calls[0][1], "test message");
    assert.equal(calls[0][2], "thread-1");
  });

  it("emitToChannel works without threadId", () => {
    const calls: any[][] = [];
    const spy = (...args: any[]) => { calls.push(args); };
    const ns = new NotificationService(spy);
    ns.emitToChannel("telegram|456", "no thread");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "telegram|456");
    assert.equal(calls[0][1], "no thread");
    assert.equal(calls[0][2], undefined);
  });

  it("attachToSession is a no-op and does not throw", () => {
    const ns = new NotificationService(() => {});
    // Should not throw
    ns.attachToSession({} as any);
  });

  it("stop is a no-op and does not throw", () => {
    const ns = new NotificationService(() => {});
    // Should not throw
    ns.stop();
  });
});
