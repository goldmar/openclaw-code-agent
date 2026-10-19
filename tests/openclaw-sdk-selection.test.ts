import "./test-env";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkOpenClawSdk } from "../scripts/check-openclaw-sdk.mjs";
import { openClawSdkRole, publicSdkTypePaths, selectOpenClawSdk, validateOpenClawSdkPins } from "../scripts/lib/openclaw-sdk.mjs";

const pkg = () => ({ openclaw: { build: { openclawVersion: "2026.10.1", pluginSdkVersion: "2026.10.1" } },
  devDependencies: { openclaw: "2026.10.4", "openclaw-baseline": "npm:openclaw@2026.10.1" } });
const lock = `importers:

  .:
    devDependencies:
      openclaw:
        specifier: 2026.10.4
        version: 2026.10.4(peer@1.0.0)
      openclaw-baseline:
        specifier: npm:openclaw@2026.10.1
        version: openclaw@2026.10.1(peer@1.0.0)

packages:
`;

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "oca-sdk-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", ...pkg() }));
  writeFileSync(join(root, "pnpm-lock.yaml"), lock);
  for (const [name, version, valueType] of [["openclaw-baseline", "2026.10.1", "string"], ["openclaw", "2026.10.4", "number"]]) {
    const directory = join(root, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "openclaw", version,
      exports: { "./plugin-sdk/example": { types: "./example.d.ts" } } }));
    writeFileSync(join(directory, "example.d.ts"), `export declare const value: ${valueType};\n`);
  }
  writeFileSync(join(root, "api.ts"), 'import { value } from "openclaw/plugin-sdk/example";\nconst result: string = value;\n');
  writeFileSync(join(root, "index.ts"), "export {};\n");
  return root;
}

describe("independently pinned OpenClaw SDKs", () => {
  it("accepts equal or newer exact dev pins", () => {
    assert.deepEqual(validateOpenClawSdkPins(pkg(), lock), { baseline: "2026.10.1", dev: "2026.10.4" });
    const same = pkg(); same.devDependencies.openclaw = "2026.10.1";
    assert.equal(validateOpenClawSdkPins(same).dev, "2026.10.1");
  });

  it("rejects malformed, ranged, missing, older, or inconsistent pins", () => {
    for (const value of ["latest", "^2026.10.4", ">=2026.10.1", "2026.10.04", "2026.10.4-rc.1", "2026.10.4\n", "2026.10.999999999999999999999", "", undefined, "2026.9.9"]) {
      const input = pkg(); input.devDependencies.openclaw = value as string;
      assert.throws(() => validateOpenClawSdkPins(input), /exact stable|older/);
    }
    for (const value of ["npm:openclaw@2026.9.9", "npm:other@2026.10.1", "npm:openclaw@^2026.10.1", ""]) {
      const input = pkg(); input.devDependencies["openclaw-baseline"] = value;
      assert.throws(() => validateOpenClawSdkPins(input), /baseline dependency/);
    }
    const input = pkg(); input.openclaw.build.pluginSdkVersion = "2026.10.4";
    assert.throws(() => validateOpenClawSdkPins(input), /metadata mismatch/);
  });

  it("rejects root specifier and resolution drift for either pin, including a transitive decoy", () => {
    for (const changed of [
      lock.replace("specifier: 2026.10.4", "specifier: ^2026.10.4"),
      lock.replace("version: 2026.10.4(", "version: 2026.10.1("),
      lock.replace("specifier: npm:openclaw@2026.10.1", "specifier: npm:openclaw@2026.10.4"),
      lock.replace("version: openclaw@2026.10.1(", "version: openclaw@2026.10.4("),
      lock.replace("  .:", "  other:"),
      lock.replace("    devDependencies:", "    dependencies:"),
    ]) assert.throws(() => validateOpenClawSdkPins(pkg(), changed), /root dev dependency/);
  });

  it("rejects unknown or repeated selections", () => {
    assert.equal(openClawSdkRole([]), "baseline");
    assert.equal(openClawSdkRole(["--sdk=dev"]), "dev");
    assert.throws(() => openClawSdkRole(["--sdk=latest"]), /Unknown/);
    assert.throws(() => openClawSdkRole(["--sdk=dev", "--sdk=baseline"]), /only once/);
  });

  it("checks the selected package identity and refuses a missing baseline", (t) => {
    const root = fixture(t);
    assert.equal(selectOpenClawSdk("baseline", root).version, "2026.10.1");
    assert.equal(selectOpenClawSdk("dev", root).version, "2026.10.4");
    const path = join(root, "node_modules/openclaw-baseline/package.json");
    for (const replacement of [{ name: "other", version: "2026.10.1" }, { name: "openclaw", version: "2026.10.4" }]) {
      writeFileSync(path, JSON.stringify(replacement));
      assert.throws(() => selectOpenClawSdk("baseline", root), /identity mismatch/);
    }
    rmSync(join(root, "node_modules/openclaw-baseline"), { recursive: true });
    assert.throws(() => selectOpenClawSdk("baseline", root), /ENOENT/);
  });

  it("never accepts a dev-only export or an unshipped/private declaration as baseline proof", (t) => {
    const root = fixture(t);
    const sdk = selectOpenClawSdk("baseline", root);
    assert.deepEqual(publicSdkTypePaths(sdk, root), { "openclaw/plugin-sdk/example": [join(sdk.root, "example.d.ts")] });
    for (const entry of [undefined, { types: "./missing.d.ts" }, { types: "../../api.ts" }]) {
      sdk.packageJson.exports["./plugin-sdk/example"] = entry;
      assert.throws(() => publicSdkTypePaths(sdk, root), /no public types/);
    }
  });

  it("keeps npm pack JSON readable when prepack validates the baseline", (t) => {
    const root = fixture(t);
    symlinkSync(join(import.meta.dirname, "../node_modules/.bin"), join(root, "node_modules/.bin"), "dir");
    symlinkSync(join(import.meta.dirname, "../node_modules/typescript"), join(root, "node_modules/typescript"), "dir");
    writeFileSync(join(root, "tsconfig.typecheck.json"), JSON.stringify({
      compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2022", types: [] },
      include: ["api.ts", "index.ts"],
    }));
    const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ ...metadata, name: "oca-sdk-pack-fixture", version: "1.0.0",
      scripts: { prepack: "node prepack.mjs" } }));
    const checker = new URL("../scripts/check-openclaw-sdk.mjs", import.meta.url).href;
    writeFileSync(join(root, "prepack.mjs"), `import { checkOpenClawSdk } from ${JSON.stringify(checker)}; checkOpenClawSdk(["--source-only"], process.cwd());`);
    const output = execFileSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: root, encoding: "utf8" });
    assert.equal(JSON.parse(output)[0].name, "oca-sdk-pack-fixture");
  });

  it("actually compiles against the chosen baseline rather than the incompatible dev types", (t) => {
    const root = fixture(t);
    // Use the real compiler, but resolve SDK imports only from this fixture.
    symlinkSync(join(import.meta.dirname, "../node_modules/.bin"), join(root, "node_modules/.bin"), "dir");
    symlinkSync(join(import.meta.dirname, "../node_modules/typescript"), join(root, "node_modules/typescript"), "dir");
    writeFileSync(join(root, "tsconfig.typecheck.json"), JSON.stringify({
      compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", target: "ES2022", types: [] },
      include: ["api.ts", "index.ts"],
    }));
    assert.doesNotThrow(() => checkOpenClawSdk(["--source-only"], root));
    assert.throws(() => checkOpenClawSdk(["--source-only", "--sdk=dev"], root), /number.*not assignable.*string/);
    // A type error confined to the baseline must not be hidden by dev success.
    writeFileSync(join(root, "api.ts"), readFileSync(join(root, "api.ts"), "utf8").replace("result: string", "result: number"));
    assert.throws(() => checkOpenClawSdk(["--source-only"], root), /string.*not assignable.*number/);
    assert.doesNotThrow(() => checkOpenClawSdk(["--source-only", "--sdk=dev"], root));
  });
});
