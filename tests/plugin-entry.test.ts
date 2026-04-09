import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rootDir = join(import.meta.dirname, "..");

describe("plugin entry source", () => {
  it("declares the v2026.4.9 external plugin compatibility baseline in package metadata", () => {
    const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
      openclaw?: {
        compat?: Record<string, string>;
        build?: Record<string, string>;
      };
      peerDependencies?: Record<string, string>;
    };

    assert.equal(packageJson.openclaw?.compat?.pluginApi, ">=2026.4.9");
    assert.equal(packageJson.openclaw?.compat?.minGatewayVersion, "2026.4.9");
    assert.equal(packageJson.openclaw?.build?.openclawVersion, "2026.4.9");
    assert.equal(packageJson.openclaw?.build?.pluginSdkVersion, "2026.4.9");
    assert.equal(packageJson.peerDependencies?.openclaw, ">=2026.4.9");
  });

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

  it("registers goal tools, commands, and controller startup", () => {
    const indexSource = readFileSync(join(rootDir, "index.ts"), "utf8");

    assert.match(indexSource, /makeGoalLaunchTool/);
    assert.match(indexSource, /makeGoalStatusTool/);
    assert.match(indexSource, /makeGoalStopTool/);
    assert.match(indexSource, /registerGoalCommand\(api\)/);
    assert.match(indexSource, /registerGoalStatusCommand\(api\)/);
    assert.match(indexSource, /registerGoalStopCommand\(api\)/);
    assert.match(indexSource, /gc = new GoalController\(sm\)/);
    assert.match(indexSource, /gc\.start\(\)/);
  });
});
