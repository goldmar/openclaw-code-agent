import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { consumeFirstCommandArg, tokenizeCommandArgs, tokenizeCommandArgSpans } from "../src/commands/args";

describe("command arg tokenization", () => {
  it("preserves quoted values as single tokens without quotes", () => {
    assert.deepEqual(
      tokenizeCommandArgs('--name "fix auth" --verify "pnpm test" ship it'),
      ["--name", "fix auth", "--verify", "pnpm test", "ship", "it"],
    );
  });

  it("returns an empty list for blank input", () => {
    assert.deepEqual(tokenizeCommandArgs("   "), []);
  });

  it("returns token spans for quoted args", () => {
    assert.deepEqual(
      tokenizeCommandArgSpans('  "agent command"  continue work').map(({ value, raw, start, end }) => ({
        value,
        raw,
        start,
        end,
      })),
      [
        { value: "agent command", raw: '"agent command"', start: 2, end: 17 },
        { value: "continue", raw: "continue", start: 19, end: 27 },
        { value: "work", raw: "work", start: 28, end: 32 },
      ],
    );
  });

  it("consumes a quoted first argument while preserving remaining text", () => {
    assert.deepEqual(
      consumeFirstCommandArg('"agent command"   continue  with   spacing'),
      { value: "agent command", rest: "continue  with   spacing" },
    );
  });
});
