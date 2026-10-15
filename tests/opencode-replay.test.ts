import "./test-env";
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { EventMapper } from "../src/harness/opencode/mapper";
import { TurnTracker } from "../src/harness/opencode/turn";
import { openCodeEventErrors } from "./protocol-schema";
import type { OpenCodeEvent } from "../src/harness/opencode/protocol/events";
const directory = new URL("./fixtures/opencode-v2/", import.meta.url);
for (const file of readdirSync(directory).filter((f) =>
  f.endsWith(".ndjson"),
)) {
  it(`replays the real OpenCode 2.0.29 recording ${file}`, () => {
    const frames = readFileSync(new URL(file, directory), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as OpenCodeEvent);
    const mapper = new EventMapper();
    const messages = [];
    const tracker = new TurnTracker();
    const delivered = frames.find((e) => e.type === "session.inbox.delivered");
    assert.equal(delivered?.type, "session.inbox.delivered");
    if (delivered?.type === "session.inbox.delivered")
      tracker.begin(delivered.data.inboxID);
    let outcome;
    for (const frame of frames) {
      assert.deepEqual(openCodeEventErrors(frame), []);
      messages.push(...mapper.map(frame));
      outcome = tracker.apply(frame) ?? outcome;
    }
    const golden = JSON.parse(
      readFileSync(
        new URL(file.replace(".ndjson", ".messages.json"), directory),
        "utf8",
      ),
    );
    assert.deepEqual({ messages, result: mapper.result() }, golden);
    assert.equal(outcome?.outcome, "completed");
    assert.equal(mapper.result(), "OPENCODE_OK");
  });
}
