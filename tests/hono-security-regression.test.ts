import "./test-env";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { serveStatic as serveNodeStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { serveStatic } from "hono/serve-static";
import { saveContentToFile } from "hono/ssg";
import { parseBody } from "hono/utils/body";
import { getQueryStrings } from "hono/utils/url";

describe("Hono security regressions", () => {
  for (const runtime of ["generic", "node"] as const) {
    it(`${runtime} static middleware rejects a second decode that bypasses prefix authorization`, async (t) => {
      const content = new Map([
        ["static/admin/secret.txt", "protected fixture"],
        ["static/hello world.txt", "space fixture"],
        ["static/炎.txt", "Unicode fixture"],
      ]);
      const root = mkdtempSync(join(tmpdir(), "oca-static-security-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(join(root, "static/admin"), { recursive: true });
      for (const [path, body] of content) writeFileSync(join(root, path), body);

      const attemptedPaths: string[] = [];
      const rewriteRequestPath = (path: string) => {
        attemptedPaths.push(path);
        return path;
      };
      const app = new Hono();
      app.use("/static/admin/*", async (c) => c.text("Unauthorized", 401));
      app.use("*", runtime === "node"
        ? serveNodeStatic({ root, rewriteRequestPath })
        : serveStatic({
          root: ".",
          rewriteRequestPath,
          getContent: async (path) => content.get(path) ?? null,
        }));

      for (const path of ["/static/admin/secret.txt", "/static/%61dmin/secret.txt"]) {
        const response = await app.request(path);
        assert.equal(response.status, 401);
        assert.equal(await response.text(), "Unauthorized");
      }
      // Routing leaves %61 in this malformed encoding. A second decode in
      // static middleware would reach admin/secret.txt without authorization.
      const bypass = await app.request("/static/%%36%31dmin/secret.txt");
      assert.equal(bypass.status, 404);
      assert.equal(await bypass.text(), "404 Not Found");
      assert.deepEqual(attemptedPaths, []);

      for (const [path, body] of [
        ["/static/hello%20world.txt", "space fixture"],
        ["/static/%E7%82%8E.txt", "Unicode fixture"],
      ]) {
        const response = await app.request(path);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), body);
      }
    });
  }

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
