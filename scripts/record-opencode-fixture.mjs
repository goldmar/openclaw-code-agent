#!/usr/bin/env node
// Opt-in recorder. Use an isolated server/database and synthetic prompts: streams
// can contain source code, tool outputs and answers. Never record production work.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
const arg = (key) => args[args.indexOf(key) + 1];
if (!args.includes("--url") || !args.includes("--output"))
  throw new Error(
    "Usage: --url http://127.0.0.1:PORT --output tests/fixtures/opencode-v2/NAME.ndjson [--duration-ms 30000]. OPENCODE_PASSWORD supplies auth.",
  );
const base = new URL(arg("--url"));
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
  throw new Error("Recorder requires an isolated loopback server.");
const authorization =
  "Basic " +
  Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64");
const controller = new AbortController();
const timer = setTimeout(
  () => controller.abort(),
  Number(args.includes("--duration-ms") ? arg("--duration-ms") : 30000),
);
const frames = [];
try {
  const response = await fetch(new URL("/api/event", base), {
    headers: { Authorization: authorization },
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) frames.push(JSON.parse(data));
    }
  }
} catch (e) {
  if (!controller.signal.aborted) throw e;
} finally {
  clearTimeout(timer);
}
mkdirSync(dirname(arg("--output")), { recursive: true });
writeFileSync(
  arg("--output"),
  frames.map((x) => JSON.stringify(x)).join("\n") + "\n",
);
console.log(
  `Recorded ${frames.length} events. Review/redact before committing.`,
);
