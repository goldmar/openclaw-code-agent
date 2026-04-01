import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rootDir = join(import.meta.dirname, "..");

describe("plugin entry source", () => {
  it("uses the canonical SDK entry helper", () => {
    const indexSource = readFileSync(join(rootDir, "index.ts"), "utf8");
    const apiSource = readFileSync(join(rootDir, "api.ts"), "utf8");

    assert.match(apiSource, /definePluginEntry/);
    assert.match(apiSource, /from "openclaw\/plugin-sdk\/core"/);
    assert.match(indexSource, /export default definePluginEntry\(\{/);
    assert.match(indexSource, /id: "openclaw-code-agent"/);
    assert.match(indexSource, /name: "OpenClaw Code Agent"/);
    assert.match(indexSource, /register,\s*\n\}\);/);
  });

  it("registers interactive handlers and does not register plugin HTTP routes", () => {
    const indexSource = readFileSync(join(rootDir, "index.ts"), "utf8");

    assert.match(indexSource, /registerInteractiveHandler\(createCallbackHandler\("telegram"\)\)/);
    assert.match(indexSource, /registerInteractiveHandler\(createCallbackHandler\("discord"\)\)/);
    assert.doesNotMatch(indexSource, /registerHttpRoute\(/);
  });
});
