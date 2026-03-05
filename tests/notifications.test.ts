import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeToolInput } from "../src/notifications";

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
