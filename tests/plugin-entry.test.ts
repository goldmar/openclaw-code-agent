import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateReleaseMetadata } from "../scripts/validate-release-metadata.mjs";

const rootDir = join(import.meta.dirname, "..");

describe("plugin entry source", () => {
  it("keeps package and plugin manifest versions in sync", () => {
    const { packageVersion, pluginVersion } = validateReleaseMetadata();
    assert.equal(packageVersion, pluginVersion);
  });

  it("keeps security audit automation on the pnpm-only path", () => {
    const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const securityAuditWorkflow = readFileSync(
      join(rootDir, ".github", "workflows", "security-audit.yml"),
      "utf8",
    );
    const activeWorkflowSources = [
      readFileSync(join(rootDir, ".github", "workflows", "security-audit.yml"), "utf8"),
      readFileSync(join(rootDir, ".github", "workflows", "ci.yml"), "utf8"),
      readFileSync(join(rootDir, ".github", "workflows", "pr-checks.yml"), "utf8"),
      readFileSync(join(rootDir, ".github", "workflows", "dependency-review.yml"), "utf8"),
    ].join("\n");

    assert.equal(packageJson.scripts?.["audit:prod"], "pnpm audit --prod");
    assert.match(securityAuditWorkflow, /name:\s+pnpm audit --prod/);
    assert.match(securityAuditWorkflow, /run:\s+pnpm run audit:prod/);
    assert.doesNotMatch(activeWorkflowSources, /\bnpm audit\b/);
  });

  it("declares the v2026.4.14 compatibility floor and v2026.4.21 build target in package metadata", () => {
    const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
      openclaw?: {
        compat?: Record<string, string>;
        build?: Record<string, string>;
      };
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    assert.equal(packageJson.openclaw?.compat?.pluginApi, ">=2026.4.14");
    assert.equal(packageJson.openclaw?.compat?.minGatewayVersion, "2026.4.14");
    assert.equal(packageJson.openclaw?.build?.openclawVersion, "2026.4.21");
    assert.equal(packageJson.openclaw?.build?.pluginSdkVersion, "2026.4.21");
    assert.equal(packageJson.peerDependencies?.openclaw, ">=2026.4.14");
    assert.equal(packageJson.devDependencies?.openclaw, "2026.4.21");
  });

  it("declares narrow manifest activation and minimal setup descriptors", () => {
    const pluginManifest = JSON.parse(readFileSync(join(rootDir, "openclaw.plugin.json"), "utf8")) as {
      activation?: {
        onCommands?: string[];
      };
      setup?: {
        requiresRuntime?: boolean;
        providers?: unknown[];
        cliBackends?: unknown[];
        configMigrations?: unknown[];
      };
      configSchema?: {
        properties?: Record<string, {
          enum?: string[];
        }>;
      };
      uiHints?: Record<string, {
        advanced?: boolean;
        sensitive?: boolean;
      }>;
    };

    assert.deepEqual(pluginManifest.activation, {
      onCommands: [
        "agent",
        "agent_kill",
        "agent_output",
        "agent_respond",
        "agent_sessions",
        "agent_stats",
        "goal",
        "goal_status",
        "goal_stop",
      ],
    });
    assert.deepEqual(pluginManifest.setup, {
      requiresRuntime: false,
    });
    assert.deepEqual(pluginManifest.configSchema?.properties?.defaultHarness?.enum, [
      "claude-code",
      "codex",
    ]);
  });

  it("keeps first-run onboarding focused on workdir, harness, and fallback routing", () => {
    const pluginManifest = JSON.parse(readFileSync(join(rootDir, "openclaw.plugin.json"), "utf8")) as {
      uiHints?: Record<string, {
        advanced?: boolean;
        sensitive?: boolean;
      }>;
    };

    assert.equal(pluginManifest.uiHints?.defaultWorkdir?.advanced, undefined);
    assert.equal(pluginManifest.uiHints?.defaultHarness?.advanced, undefined);
    assert.equal(pluginManifest.uiHints?.fallbackChannel?.advanced, undefined);
    assert.equal(pluginManifest.uiHints?.fallbackChannel?.sensitive, undefined);

    assert.equal(pluginManifest.uiHints?.agentChannels?.advanced, true);
    assert.equal(pluginManifest.uiHints?.agentChannels?.sensitive, true);
    assert.equal(pluginManifest.uiHints?.harnesses?.advanced, true);
    assert.equal(pluginManifest.uiHints?.permissionMode?.advanced, true);
    assert.equal(pluginManifest.uiHints?.planApproval?.advanced, true);
    assert.equal(pluginManifest.uiHints?.defaultWorktreeStrategy?.advanced, true);
    assert.equal(pluginManifest.uiHints?.maxSessions?.advanced, true);
    assert.equal(pluginManifest.uiHints?.idleTimeoutMinutes?.advanced, true);
    assert.equal(pluginManifest.uiHints?.defaultModel, undefined);
    assert.equal(pluginManifest.uiHints?.model, undefined);
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
