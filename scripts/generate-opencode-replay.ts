// Generate the golden projection only from reviewed real-server recordings.
// node --import tsx scripts/generate-opencode-replay.ts [--check]
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { EventMapper } from "../src/harness/opencode/mapper";
import { openCodeEventErrors } from "../tests/protocol-schema";
import type { OpenCodeEvent } from "../src/harness/opencode/protocol/events";
const directory = new URL("../tests/fixtures/opencode-v2/", import.meta.url);
for (const file of readdirSync(directory).filter((f) =>
  f.endsWith(".ndjson"),
)) {
  const frames = readFileSync(new URL(file, directory), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as OpenCodeEvent);
  const mapper = new EventMapper();
  const messages = [];
  for (const frame of frames) {
    const errors = openCodeEventErrors(frame);
    if (errors.length) throw new Error(errors.join("\n"));
    messages.push(...mapper.map(frame));
  }
  const content =
    JSON.stringify({ messages, result: mapper.result() }, null, 2) + "\n";
  const target = new URL(file.replace(".ndjson", ".messages.json"), directory);
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== content)
      throw new Error(`${file} replay changed`);
  } else writeFileSync(target, content);
}
