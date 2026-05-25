import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { validateReleaseMetadata } from "../scripts/validate-release-metadata.mjs";
import { register } from "../index";
import { goalController, sessionManager, setGoalController, setSessionManager } from "../src/singletons";

const rootDir = join(import.meta.dirname, "..");

type CapturedTool = {
  factory: (ctx: Record<string, unknown>) => {
    execute: (id: string, params: unknown) => Promise<{ content?: Array<{ text?: string }> }> | { content?: Array<{ text?: string }> };
  };
  options?: { name?: string };
};

function createPluginApi(pluginConfig: Record<string, unknown> = {}) {
  const tools: CapturedTool[] = [];
  const commands: Array<{ name: string; handler: (ctx: Record<string, unknown>) => { text: string } }> = [];
  const services: Array<{ start: (ctx: Record<string, unknown>) => void; stop?: (ctx: Record<string, unknown>) => void }> = [];
  const interactiveHandlers: Array<{ handler: (ctx: Record<string, unknown>) => Promise<unknown> }> = [];
  const runtimeConfig = { runtime: true };
  const api = {
    pluginConfig,
    runtime: {
      config: {
        current: () => runtimeConfig,
      },
    },
    registerTool(factory: CapturedTool["factory"], options?: { name?: string }) {
      tools.push({ factory, options });
    },
    registerCommand(command: { name: string; handler: (ctx: Record<string, unknown>) => { text: string } }) {
      commands.push(command);
    },
    registerService(service: { start: (ctx: Record<string, unknown>) => void; stop?: (ctx: Record<string, unknown>) => void }) {
      services.push(service);
    },
    registerInteractiveHandler(handler: { handler: (ctx: Record<string, unknown>) => Promise<unknown> }) {
      interactiveHandlers.push(handler);
    },
  };
  return { api, commands, services, tools, interactiveHandlers };
}

function stopCapturedServices(services: Array<{ stop?: (ctx: Record<string, unknown>) => void }>): void {
  for (const service of services) {
    service.stop?.({});
  }
}

describe("plugin entry source", () => {
  afterEach(() => {
    if (goalController) {
      goalController.stop();
    }
    if (sessionManager) {
      sessionManager.killAll("shutdown");
      sessionManager.dispose();
    }
    setGoalController(null);
    setSessionManager(null);
  });

  it("keeps package and plugin manifest versions in sync", () => {
    const { packageVersion, pluginVersion, openclawVersion, pluginSdkVersion, openclawInstall } =
      validateReleaseMetadata();
    assert.equal(packageVersion, pluginVersion);
    assert.equal(openclawVersion, "2026.5.22");
    assert.equal(pluginSdkVersion, "2026.5.22");
    assert.equal(openclawInstall.npmSpec, "openclaw-code-agent");
    assert.equal(openclawInstall.defaultChoice, "npm");
    assert.equal(openclawInstall.minHostVersion, ">=2026.4.21");

    const cliOutput = execFileSync("node", ["scripts/validate-release-metadata.mjs"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.match(cliOutput, /openclaw\.install\.npmSpec=openclaw-code-agent/);
    assert.match(cliOutput, /openclaw\.install\.defaultChoice=npm/);
    assert.match(cliOutput, /openclaw\.install\.minHostVersion=>=2026\.4\.21/);
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

  it("declares the v2026.4.21 compatibility floor and v2026.5.22 SDK readiness target in package metadata", () => {
    const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      openclaw?: {
        install?: Record<string, string>;
        compat?: Record<string, string>;
        build?: Record<string, string>;
      };
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      pnpm?: {
        overrides?: Record<string, string>;
      };
    };

    assert.equal(packageJson.dependencies?.["@anthropic-ai/claude-agent-sdk"], "^0.3.142");
    assert.equal(packageJson.openclaw?.install?.npmSpec, "openclaw-code-agent");
    assert.equal(packageJson.openclaw?.install?.defaultChoice, "npm");
    assert.equal(packageJson.openclaw?.install?.minHostVersion, ">=2026.4.21");
    assert.equal(packageJson.openclaw?.compat?.pluginApi, ">=2026.4.21");
    assert.equal(packageJson.openclaw?.compat?.minGatewayVersion, "2026.4.21");
    assert.equal(packageJson.openclaw?.build?.openclawVersion, "2026.5.22");
    assert.equal(packageJson.openclaw?.build?.pluginSdkVersion, "2026.5.22");
    assert.equal(packageJson.peerDependencies?.openclaw, ">=2026.4.21");
    assert.equal(packageJson.devDependencies?.openclaw, "2026.5.22");
    assert.equal(packageJson.pnpm?.overrides?.["fast-xml-parser@>=5.0.0 <5.7.0"], ">=5.7.0");
    assert.doesNotMatch(readFileSync(join(rootDir, "pnpm-lock.yaml"), "utf8"), /uuid@9\.0\.1/);
  });

  it("declares high-trust automation config flags for OpenClaw security review", () => {
    const pluginManifest = JSON.parse(readFileSync(join(rootDir, "openclaw.plugin.json"), "utf8")) as {
      configContracts?: {
        dangerousFlags?: Array<{ path: string; equals: string }>;
      };
    };
    const flags = pluginManifest.configContracts?.dangerousFlags ?? [];

    assert.deepEqual(
      flags.map((flag) => `${flag.path}=${flag.equals}`).sort(),
      [
        "defaultWorktreeStrategy=auto-merge",
        "defaultWorktreeStrategy=auto-pr",
        "permissionMode=bypassPermissions",
        "planApproval=approve",
      ],
    );
  });

  it("keeps orchestration skill guidance out of prompt-override phrasing", () => {
    const skill = readFileSync(
      join(rootDir, "skills", "code-agent-orchestration", "SKILL.md"),
      "utf8",
    );

    assert.doesNotMatch(skill, /\bauthoritative\b/i);
    assert.doesNotMatch(skill, /system prompt|developer instruction|higher-priority/i);
  });

  it("keeps orchestration skill install metadata in plain YAML frontmatter", () => {
    const skill = readFileSync(
      join(rootDir, "skills", "code-agent-orchestration", "SKILL.md"),
      "utf8",
    );
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";

    assert.match(frontmatter, /metadata:\n  openclaw:\n/);
    assert.match(frontmatter, /\n    install:\n      - id: npm\n        kind: node\n        package: openclaw-code-agent\n/);
    assert.doesNotMatch(frontmatter, /,\s*[\]}]/);
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
    assert.equal(pluginManifest.configSchema?.properties?.harnesses?.additionalProperties?.properties?.fastMode?.type, "boolean");
    assert.equal(pluginManifest.configSchema?.properties?.harnesses?.default?.codex?.fastMode, false);
    assert.match(pluginManifest.uiHints?.harnesses?.help ?? "", /harnesses\.codex\.fastMode=true/);
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
      indexSource.matchAll(/registerCodeAgentTool\([\s\S]*?,\s*\{([^}]*)\}\s*\)/g),
      (match) => {
        const name = match[1]?.match(/\bname:\s*"([^"]+)"/)?.[1];
        assert.ok(name, `missing explicit tool name in registerCodeAgentTool options: ${match[1] ?? ""}`);
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

  it("documents 2026.5.22 plugin allowlist and apply_patch policy boundaries", () => {
    const reference = readFileSync(join(rootDir, "docs", "REFERENCE.md"), "utf8");

    assert.match(reference, /OpenClaw 2026\.5\.22 SDK Readiness/);
    assert.match(reference, /package build metadata targets OpenClaw `2026\.5\.22` for both host and SDK readiness/);
    assert.doesNotMatch(reference, /2026\.5\.8/);
    assert.doesNotMatch(reference, /E404/);
    assert.match(reference, /plugins\.allow/);
    assert.match(reference, /openclaw-code-agent/);
    assert.match(reference, /Gateway restart/);
    assert.match(reference, /Start Plan/);
    assert.match(reference, /thread `13832`/);
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

    assert.match(indexSource, /registerCodeAgentInteractiveHandler\("telegram"\)/);
    assert.match(indexSource, /registerCodeAgentInteractiveHandler\("discord"\)/);
    assert.match(indexSource, /createCallbackHandler\(channel\)/);
    assert.doesNotMatch(indexSource, /registerHttpRoute\(/);
  });

  it("registers goal tools, commands, and controller startup", () => {
    const indexSource = readFileSync(join(rootDir, "index.ts"), "utf8");

    assert.match(indexSource, /makeGoalLaunchTool/);
    assert.match(indexSource, /makeGoalStatusTool/);
    assert.match(indexSource, /makeGoalStopTool/);
    assert.match(indexSource, /registerGoalCommand\(commandApi\)/);
    assert.match(indexSource, /registerGoalStatusCommand\(commandApi\)/);
    assert.match(indexSource, /registerGoalStopCommand\(commandApi\)/);
    assert.match(indexSource, /gc = new GoalController\(sm\)/);
    assert.match(indexSource, /gc\.start\(\)/);
  });

  it("lazily starts the code-agent service before a tool can observe an uninitialized SessionManager", async () => {
    const { api, services, tools } = createPluginApi();
    register(api as any);
    assert.equal(sessionManager, null);

    const factory = tools.find((tool) => tool.options?.name === "agent_sessions")?.factory;
    assert.ok(factory, "expected agent_sessions factory");
    const tool = factory({ workspaceDir: rootDir });
    assert.ok(sessionManager, "tool construction should initialize SessionManager");

    const result = await tool.execute("tool-id", {});
    assert.doesNotMatch(result.content?.[0]?.text ?? "", /SessionManager not initialized/);
    stopCapturedServices(services);
  });

  it("lazily starts the code-agent service before command handlers can observe uninitialized state", () => {
    const { api, commands, services } = createPluginApi();
    register(api as any);
    assert.equal(sessionManager, null);

    const command = commands.find((entry) => entry.name === "agent_sessions");
    assert.ok(command, "expected agent_sessions command");
    const result = command.handler({ args: "--full" });

    assert.ok(sessionManager, "command handler should initialize SessionManager");
    assert.doesNotMatch(result.text, /SessionManager not initialized/);
    stopCapturedServices(services);
  });

  it("keeps service startup idempotent when service start runs after lazy tool initialization", () => {
    const { api, services, tools } = createPluginApi();
    register(api as any);

    const factory = tools.find((tool) => tool.options?.name === "agent_sessions")?.factory;
    assert.ok(factory, "expected agent_sessions factory");
    factory({ workspaceDir: rootDir });
    const lazySessionManager = sessionManager;
    assert.ok(lazySessionManager, "expected lazy SessionManager");

    services[0]?.start({ config: { gateway: true } });
    assert.equal(sessionManager, lazySessionManager);

    stopCapturedServices(services);
    assert.equal(sessionManager, null);
  });
});
