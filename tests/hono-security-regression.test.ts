import "./test-env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { saveContentToFile } from "hono/ssg";
import { parseBody } from "hono/utils/body";
import { getQueryStrings } from "hono/utils/url";

describe("Hono security regressions", () => {
  it("bounds dot-notation form nesting", async () => {
    const form = new URLSearchParams();
    const nestedKey = Array.from({ length: 34 }, (_, index) => `level${index}`).join(".");
    form.set(nestedKey, "value");
    const request = new Request("https://example.test/form", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });

    await assert.rejects(parseBody(request, { dot: true }), /nesting limit exceeded/i);
  });

  it("rejects static-generation writes outside the output directory", async () => {
    const calls: string[] = [];
    const fs = {
      mkdir: async (path: string) => {
        calls.push(`mkdir:${path}`);
      },
      writeFile: async (path: string) => {
        calls.push(`write:${path}`);
      },
    };

    await assert.rejects(
      saveContentToFile(
        Promise.resolve({ routePath: "/../outside", content: "content", mimeType: "text/html" }),
        fs,
        "public",
      ),
      /outside the output directory/i,
    );
    assert.deepEqual(calls, []);
  });

  it("ignores query-looking text after a URL fragment", () => {
    assert.equal(getQueryStrings("https://example.test/resource#section?mode=alternate"), "");
    assert.equal(getQueryStrings("https://example.test/resource?mode=canonical#section"), "?mode=canonical");
  });
});
