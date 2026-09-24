import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shortId } from "../src/short-id";

describe("shortId", () => {
  it("returns URL-safe ids of the requested length", () => {
    const ids = new Set(Array.from({ length: 500 }, () => shortId(8)));
    assert.equal(ids.size, 500);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{8}$/);
    assert.equal(shortId(21).length, 21);
  });
});
