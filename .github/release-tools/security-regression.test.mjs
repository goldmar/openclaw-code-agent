import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { finished } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { Agent, fetch, MockAgent } from "undici";

// Resolve the parser from the same release-tools installation as ClawHub.
const require = createRequire(import.meta.url);
const { EventSourceStream } = require("undici/lib/web/eventsource/eventsource-stream.js");

test("excessive content encodings reject without an orphaned-stream crash", { timeout: 5000 }, async (t) => {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end([
      "HTTP/1.1 200 OK",
      "Content-Length: 1",
      "Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip",
      "Connection: close",
      "", "",
    ].join("\r\n")));
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const dispatcher = new Agent();
  t.after(() => dispatcher.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(fetch(`http://127.0.0.1:${address.port}`, { dispatcher }),
    (error) => error instanceof TypeError && error.cause instanceof Error
      && /too many content-encodings/.test(error.cause.message));
  // An uncaught stream error after the caught rejection fails the test process.
  await setImmediate();
});

test("EventSource bounds tiny fields and fragmented unfinished lines", { timeout: 5000 }, async () => {
  for (const chunk of [Buffer.from("data:\n"), Buffer.from("x")]) {
    // These payloads remain well below the byte limit. Rejection must come
    // from retained parser-item bounds, without allocating an attack-sized body.
    const parser = new EventSourceStream({ maxEventSize: 1024 * 1024 });
    parser.resume();
    const completion = assert.rejects(finished(parser), /EventSource message size exceeded/);
    for (let index = 0; index < 8193 && !parser.destroyed; index += 1) parser.write(chunk);
    parser.end();
    await completion;
  }
});

test("mixed-case integrity algorithms enforce both matching and mismatching digests", async (t) => {
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  t.after(() => dispatcher.close());
  const origin = "https://registry.example.test";
  const body = "synthetic release artifact";
  const digest = (value) => createHash("sha256").update(value).digest("base64");
  for (const algorithm of ["SHA256", "Sha256"]) {
    dispatcher.get(origin).intercept({ path: "/artifact" }).reply(200, body).times(2);
    const response = await fetch(`${origin}/artifact`, {
      dispatcher, integrity: `${algorithm}-${digest(body)}`,
    });
    assert.equal(await response.text(), body);
    await assert.rejects(fetch(`${origin}/artifact`, {
      dispatcher, integrity: `${algorithm}-${digest("different artifact")}`,
    }), (error) => error instanceof TypeError && error.cause instanceof Error && error.cause.message === "integrity mismatch");
  }
  dispatcher.assertNoPendingInterceptors();
});
