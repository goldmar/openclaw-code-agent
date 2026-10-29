import "./test-env";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { z as runtime } from "zod";
import { compareReleases } from "../scripts/lib/runtime-dependency-pins.mjs";

function hostZod(role: "openclaw-baseline" | "openclaw"): typeof runtime {
  const host = realpathSync(new URL(`../node_modules/${role}`, import.meta.url));
  return createRequire(join(host, "package.json"))("zod").z;
}

// GHSA-mrhx-c7xc-m3w5: the runtime pin alone cannot protect the two exact
// OpenClaw development packages, which upstream pins to Zod 4.6.5.
for (const [role, z] of [
  ["runtime", runtime],
  ["baseline", hostZod("openclaw-baseline")],
  ["development", hostZod("openclaw")],
] as const) {
  describe(`Zod collection security regressions (${role})`, () => {
    for (const compiled of [false, true]) {
      it(`checks collection bounds before elements (${compiled ? "compiled" : "interpreter"})`, () => {
        let parsed = 0;
        const element = z.string().refine(() => { parsed += 1; return true; });
        const cases = [
          { schema: z.array(element).max(2), oversized: ["a", "b", "c"], valid: ["a", "b"] },
          { schema: z.array(element).length(2), oversized: ["a", "b", "c"], valid: ["a", "b"] },
          { schema: z.set(element).max(2), oversized: new Set(["a", "b", "c"]), valid: new Set(["a", "b"]) },
          { schema: z.set(element).size(2), oversized: new Set(["a", "b", "c"]), valid: new Set(["a", "b"]) },
          { schema: z.map(element, element).max(1), oversized: new Map([["a", "a"], ["b", "b"]]), valid: new Map([["a", "a"]]) },
          { schema: z.map(element, element).size(1), oversized: new Map([["a", "a"], ["b", "b"]]), valid: new Map([["a", "a"]]) },
        ];
        for (const fixture of cases) {
          const schema = compiled ? z.compile(fixture.schema, { strict: true }) : fixture.schema;
          parsed = 0;
          const result = schema.safeParse(fixture.oversized);
          assert.equal(result.success, false);
          assert.equal(parsed, 0, "oversized collections must not visit any element");
          assert.deepEqual(result.error?.issues.map(({ code, path }) => ({ code, path })), [{ code: "too_big", path: [] }]);
          assert.deepEqual(schema.parse(fixture.valid), fixture.valid);
          assert.ok(parsed > 0, "valid collections still validate their elements");
        }
      });

      it(`bounds issues for invalid oversized elements (${compiled ? "compiled" : "interpreter"})`, () => {
        const fixtures = [
          { schema: z.array(z.string()).max(1), input: [1, 2, 3] },
          { schema: z.set(z.string()).max(1), input: new Set([1, 2, 3]) },
          { schema: z.map(z.string(), z.string()).max(1), input: new Map([[1, 1], [2, 2]]) },
        ];
        for (const fixture of fixtures) {
          const schema = compiled ? z.compile(fixture.schema, { strict: true }) : fixture.schema;
          const result = schema.safeParse(fixture.input);
          assert.equal(result.success, false);
          assert.deepEqual(result.error?.issues.map(({ code }) => code), ["too_big"]);
        }
      });
    }
  });
}

it("keeps every locked Zod resolution above the advisory floor", () => {
  const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  const versions = [...lockfile.matchAll(/^ {2}zod@(\d+\.\d+\.\d+):/gmu)].map((match) => match[1]);
  assert.ok(versions.length > 0, "the lockfile must contain Zod package resolutions");
  for (const version of versions) assert.ok(compareReleases(version, "4.6.6") >= 0, `vulnerable Zod ${version} remains locked`);
});
