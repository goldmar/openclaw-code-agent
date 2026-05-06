import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { validateReleaseMetadata } from "../scripts/validate-release-metadata.mjs";

const rootDir = join(import.meta.dirname, "..");

describe("plugin entry source", () => {
  it("keeps package and plugin manifest versions in sync", () => {
    const { packageVersion, pluginVersion, openclawVersion, pluginSdkVersion } =
      validateReleaseMetadata();
    assert.equal(packageVersion, pluginVersion);
    assert.equal(openclawVersion, "2026.5.5");
    assert.equal(pluginSdkVersion, "2026.5.5");
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

  it("declares the v2026.4.21 compatibility floor and v2026.5.5 SDK readiness target in package metadata", () => {
    const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      openclaw?: {
        compat?: Record<string, string>;
        build?: Record<string, string>;
      };
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      pnpm?: {
        overrides?: Record<string, string>;
      };
    };

    assert.equal(packageJson.dependencies?.["@anthropic-ai/claude-agent-sdk"], "^0.2.119");
    assert.equal(packageJson.openclaw?.compat?.pluginApi, ">=2026.4.21");
    assert.equal(packageJson.openclaw?.compat?.minGatewayVersion, "2026.4.21");
    assert.equal(packageJson.openclaw?.build?.openclawVersion, "2026.5.5");
    assert.equal(packageJson.openclaw?.build?.pluginSdkVersion, "2026.5.5");
    assert.equal(packageJson.peerDependencies?.openclaw, ">=2026.4.21");
    assert.equal(packageJson.devDependencies?.openclaw, "2026.5.5");
    assert.equal(packageJson.pnpm?.overrides?.["fast-xml-parser@>=5.0.0 <5.7.0"], ">=5.7.0");
    assert.equal(packageJson.pnpm?.overrides?.["@anthropic-ai/vertex-sdk>google-auth-library"], "10.6.2");
    assert.doesNotMatch(readFileSync(join(rootDir, "pnpm-lock.yaml"), "utf8"), /uuid@9\.0\.1/);
  });

  it("does not use the removed OpenClaw embedded-extension factory API", () => {
    const removedApi = ["register", "Embedded", "Extension", "Factory"].join("");
    const trackedFiles = execFileSync("git", ["ls-files"], {
      cwd: rootDir,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .filter((file) => file && existsSync(join(rootDir, file)))
      .filter((file) =>
        /^(api\.ts|index\.ts|src\/|openclaw\.plugin\.json$|package\.json$)/.test(file),
      );

    const offenders = trackedFiles.filter((file) =>
      readFileSync(join(rootDir, file), "utf8").includes(removedApi),
    );

    assert.deepEqual(offenders, []);
  });

  it("does not depend on legacy authored plugin install metadata", () => {
    const legacyAuthoredInstalls = ["plugins", "installs"].join(".");
    const persistedInstallRegistry = ["installs", "json"].join(".");
    const trackedFiles = execFileSync("git", ["ls-files"], {
      cwd: rootDir,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .filter((file) => file && existsSync(join(rootDir, file)))
      .filter((file) =>
        /^(api\.ts|index\.ts|src\/|scripts\/|openclaw\.plugin\.json$|package\.json$)/.test(file),
      );

    const offenders = trackedFiles.filter((file) => {
      const source = readFileSync(join(rootDir, file), "utf8");
      return source.includes(legacyAuthoredInstalls) || source.includes(persistedInstallRegistry);
    });

    assert.deepEqual(offenders, []);
  });

  it("does not depend on deprecated OpenClaw direct config load/write helper surfaces", () => {
    const deprecatedSdkEntrypoints = [
      "openclaw/plugin-sdk/config-runtime",
      "openclaw/plugin-sdk/config-mutation",
      "openclaw/plugin-sdk/plugin-config-runtime",
    ];
    const deprecatedHelperNames = [
      "loadConfig",
      "writeConfigFile",
      "readConfigFileSnapshotForWrite",
      "mutateConfigFile",
      "replaceConfigFile",
    ];
    const trackedFiles = execFileSync("git", ["ls-files"], {
      cwd: rootDir,
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .filter((file) => file && existsSync(join(rootDir, file)))
      .filter((file) =>
        /^(api\.ts|index\.ts|src\/|scripts\/|openclaw\.plugin\.json$|package\.json$)/.test(file),
      );

    const offenders = trackedFiles.filter((file) => {
      const source = readFileSync(join(rootDir, file), "utf8");
      return deprecatedSdkEntrypoints.some((entrypoint) => source.includes(entrypoint))
        || deprecatedHelperNames.some((helperName) => source.includes(helperName));
    });

    assert.deepEqual(offenders, []);
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
          default?: unknown;
          description?: string;
          enum?: string[];
          additionalProperties?: {
            properties?: Record<string, {
              enum?: string[];
            }>;
          };
        }>;
      };
      uiHints?: Record<string, {
        advanced?: boolean;
        sensitive?: boolean;
      }>;
    };

    assert.deepEqual(pluginManifest.activation, {
      onStartup: true,
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
    assert.equal(pluginManifest.configSchema?.properties?.planApproval?.default, "delegate");
    assert.equal(pluginManifest.configSchema?.properties?.defaultWorktreeStrategy?.default, "delegate");
    assert.match(pluginManifest.configSchema?.properties?.defaultWorkdir?.description ?? "", /git repository root/);
    assert.deepEqual(pluginManifest.configSchema?.properties?.harnesses?.additionalProperties?.properties?.reasoningEffort?.enum, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("keeps declared tool contracts synced with runtime registrations", () => {
    const expectedToolNames = [
      "agent_launch",
      "agent_sessions",
      "agent_kill",
      "agent_output",
      "agent_respond",
      "agent_request_plan_approval",
      "agent_send_plan_offer",
      "agent_stats",
      "agent_merge",
      "agent_pr",
      "agent_worktree_cleanup",
      "agent_worktree_status",
      "goal_launch",
      "goal_status",
      "goal_stop",
    ];
    const pluginManifest = JSON.parse(readFileSync(join(rootDir, "openclaw.plugin.json"), "utf8")) as {
      contracts?: {
        tools?: string[];
      };
    };
    const indexSource = readFileSync(join(rootDir, "index.ts"), "utf8");
    const registeredToolNames = Array.from(
      indexSource.matchAll(/registerTool\([\s\S]*?,\s*\{([^}]*)\}\s*\)/g),
      (match) => {
        const name = match[1]?.match(/\bname:\s*"([^"]+)"/)?.[1];
        assert.ok(name, `missing explicit tool name in registerTool options: ${match[1] ?? ""}`);
        return name;
      },
    );

    assert.deepEqual(pluginManifest.contracts?.tools, expectedToolNames);
    assert.deepEqual(registeredToolNames, expectedToolNames);
    assert.equal(new Set(registeredToolNames).size, registeredToolNames.length);
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
    assert.match(pluginManifest.uiHints?.defaultWorkdir?.help ?? "", /git repository root/);

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
    assert.match(apiSource, /from "openclaw\/plugin-sdk\/plugin-entry"/);
    assert.match(indexSource, /export default definePluginEntry\(\{/);
    assert.match(indexSource, /id: "openclaw-code-agent"/);
    assert.match(indexSource, /name: "OpenClaw Code Agent"/);
    assert.match(indexSource, /register,\s*\n\}\);/);
  });

  it("keeps the OpenClaw plugin API compatibility shim narrow", () => {
    const apiSource = readFileSync(join(rootDir, "api.ts"), "utf8");

    assert.match(apiSource, /from "openclaw\/plugin-sdk\/plugin-entry"/);
    assert.match(apiSource, /PluginInteractiveTelegramHandlerContext/);
    assert.match(apiSource, /PluginInteractiveDiscordHandlerContext/);
    assert.doesNotMatch(apiSource, /openclaw\/plugin-sdk\/telegram-account/);
    assert.doesNotMatch(apiSource, /openclaw\/plugin-sdk\/discord/);
  });

  it("documents 2026.5.5 plugin allowlist and apply_patch policy boundaries", () => {
    const reference = readFileSync(join(rootDir, "docs", "REFERENCE.md"), "utf8");

    assert.match(reference, /OpenClaw 2026\.5\.5 SDK Readiness/);
    assert.match(reference, /package build metadata targets OpenClaw `2026\.5\.5` for both host and SDK readiness/);
    assert.match(reference, /OpenClaw `2026\.5\.6` GitHub release has been observed/);
    assert.match(reference, /npm returns `E404 No match found for version 2026\.5\.6` for `openclaw@2026\.5\.6`/);
    assert.match(reference, /plugins\.allow/);
    assert.match(reference, /openclaw-code-agent/);
    assert.match(reference, /tools\.exec\.applyPatch/);
    assert.match(reference, /tools\.deny/);
  });

  it("documents the generic plan-offer tool", () => {
    const readme = readFileSync(join(rootDir, "README.md"), "utf8");
    const reference = readFileSync(join(rootDir, "docs", "REFERENCE.md"), "utf8");

    assert.match(readme, /agent_send_plan_offer/);
    assert.match(reference, /### `agent_send_plan_offer`/);
    assert.match(reference, /preserving the chosen route, Telegram\/Discord thread, and optional worktree strategy/);
    assert.doesNotMatch(readme, /agent_send_monitor_report|monitor-start-plan|monitor-dismiss/);
    assert.doesNotMatch(reference, /agent_send_monitor_report|monitor-start-plan|monitor-dismiss/);
  });

  it("does not assume bundled Codex or ACPX plugin availability", () => {
    const harnessSources = [
      "src/harness/index.ts",
      "src/harness/codex.ts",
      "src/harness/claude-code.ts",
      "src/tools/agent-launch-resolution.ts",
    ].map((file) => readFileSync(join(rootDir, file), "utf8")).join("\n");

    assert.doesNotMatch(harnessSources, /extensions\/(?:codex|acpx)/);
    assert.doesNotMatch(harnessSources, /plugin-sdk\/agent-runtime/);
    assert.doesNotMatch(harnessSources, /agentRuntime\.id/);
  });

  it("bundles the OpenClaw plugin SDK entry helper into the release artifact", () => {
    const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const buildScript = packageJson.scripts?.build ?? "";

    assert.doesNotMatch(buildScript, /--external:openclaw(?:\s|$)/);
    assert.doesNotMatch(buildScript, /--external:openclaw\/plugin-sdk(?:\s|$)/);
    assert.doesNotMatch(buildScript, /--external:openclaw\/plugin-sdk\/\*(?:\s|$)/);
    assert.match(buildScript, /--external:@anthropic-ai\/claude-agent-sdk/);
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
