import "./test-env";
import { afterEach, describe, it, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  normalizeOpenClawTargetVersion,
  validateReleaseMetadata,
} from "../scripts/validate-release-metadata.mjs";
import { register, routeFromInteractiveContext } from "../index";
import { autoUpdateService, goalController, sessionManager, setGoalController, setSessionManager } from "../src/singletons";
import { SessionManager } from "../src/session-manager";
import { Session } from "../src/session";
import { GoalController } from "../src/goal-controller";
import { TEST_RUNTIME_LLM } from "./helpers";
import { setGitHubCliAvailabilityForTests } from "../src/worktree-repo";

// PR buttons depend on GitHub CLI availability; never probe the host `gh` (a slow
// cold start used to hit the probe timeout and flip these tests).
before(() => setGitHubCliAvailabilityForTests(true));
after(() => setGitHubCliAvailabilityForTests(undefined));

const rootDir = join(import.meta.dirname, "..");

type PackageMetadata = {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  openclaw?: {
    install?: Record<string, string>;
    compat?: Record<string, string>;
    build?: Record<string, string>;
  };
};

const packageMetadata = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as PackageMetadata;
/** Exact OpenClaw release the plugin is built and validated against. */
const openclawTarget = packageMetadata.openclaw?.build?.openclawVersion ?? "";
/** Oldest OpenClaw plugin API / Gateway the plugin still declares compatibility with. */
const openclawFloor = packageMetadata.openclaw?.compat?.minGatewayVersion ?? "";
const EXACT_OPENCLAW_VERSION = /^\d{4}\.\d+\.\d+$/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function compareOpenClawVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

type CapturedTool = {
  factory: (ctx: Record<string, unknown>) => {
    execute: (id: string, params: unknown) => Promise<{ content?: Array<{ text?: string }> }> | { content?: Array<{ text?: string }> };
  };
  options?: { name?: string };
};

function createPluginApi(pluginConfig: Record<string, unknown> = {}) {
  const tools: CapturedTool[] = [];
  const commands: Array<{ name: string; handler: (ctx: Record<string, unknown>) => { text: string } | Promise<{ text: string }> }> = [];
  const services: Array<{ start: (ctx: Record<string, unknown>) => void | Promise<void>; stop?: (ctx: Record<string, unknown>) => void | Promise<void> }> = [];
  const interactiveHandlers: Array<{ handler: (ctx: Record<string, unknown>) => Promise<unknown> }> = [];
  const runtimeConfig = { runtime: true };
  const api = {
    pluginConfig,
    runtime: {
      config: {
        current: () => runtimeConfig,
      },
      llm: TEST_RUNTIME_LLM,
    },
    registerTool(factory: CapturedTool["factory"], options?: { name?: string }) {
      tools.push({ factory, options });
    },
    registerCommand(command: { name: string; handler: (ctx: Record<string, unknown>) => { text: string } | Promise<{ text: string }> }) {
      commands.push(command);
    },
    registerService(service: { start: (ctx: Record<string, unknown>) => void | Promise<void>; stop?: (ctx: Record<string, unknown>) => void | Promise<void> }) {
      services.push(service);
    },
    registerInteractiveHandler(handler: { handler: (ctx: Record<string, unknown>) => Promise<unknown> }) {
      interactiveHandlers.push(handler);
    },
  };
  return { api, commands, services, tools, interactiveHandlers };
}

async function stopCapturedServices(services: Array<{ stop?: (ctx: Record<string, unknown>) => void | Promise<void> }>): Promise<void> {
  for (const service of services) {
    await service.stop?.({});
  }
}

describe("plugin entry source", () => {
  afterEach(async () => {
    if (goalController) {
      goalController.stop();
    }
    if (sessionManager) {
      sessionManager.killAll("shutdown");
      await sessionManager.drainTaskLifecycle();
      sessionManager.dispose();
    }
    setGoalController(null);
    setSessionManager(null);
  });

  it("keeps package and plugin manifest versions in sync", () => {
    const { packageVersion, pluginVersion, pluginName, openclawVersion, pluginSdkVersion, openclawInstall, nodeEngine } =
      validateReleaseMetadata();
    assert.equal(packageVersion, pluginVersion);
    assert.equal(pluginName, "Code Agent");
    assert.match(openclawTarget, EXACT_OPENCLAW_VERSION);
    assert.equal(openclawVersion, openclawTarget);
    assert.equal(pluginSdkVersion, openclawTarget);
    assert.equal(openclawInstall.npmSpec, "openclaw-code-agent");
    assert.equal(openclawInstall.defaultChoice, "npm");
    assert.equal(openclawInstall.minHostVersion, `>=${openclawTarget}`);
    assert.equal(nodeEngine, ">=24.16.0 <25 || >=26.1.0");

    const cliOutput = execFileSync("node", ["scripts/validate-release-metadata.mjs"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.match(cliOutput, /openclaw\.plugin\.name=Code Agent/);
    assert.match(cliOutput, /openclaw\.install\.npmSpec=openclaw-code-agent/);
    assert.match(cliOutput, /openclaw\.install\.defaultChoice=npm/);
    assert.match(cliOutput, new RegExp(`openclaw\\.install\\.minHostVersion=>=${escapeRegExp(openclawTarget)}`));
    assert.match(cliOutput, /engines\.node=>=24\.16\.0 <25 \|\| >=26\.1\.0/);
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

  it("ships patched runtime dependencies as enforceable exact dependencies", () => {
    const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };

    assert.equal(packageJson.dependencies?.["fast-uri"], "3.1.8");
    assert.equal(packageJson.dependencies?.hono, "4.13.7");
    assert.equal(packageJson.dependencies?.["ip-address"], "10.7.2");
    assert.equal(packageJson.dependencies?.qs, "6.16.0");
    assert.equal(packageJson.overrides, undefined);
    assert.doesNotThrow(() =>
      execFileSync("node", ["scripts/check-npm-shrinkwrap.mjs"], {
        cwd: rootDir,
        encoding: "utf8",
      }),
    );
    const pack = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: rootDir,
        encoding: "utf8",
      }),
    ) as Array<{ files?: Array<{ path?: string }> }>;
    assert.ok(pack[0]?.files?.some((file) => file.path === "npm-shrinkwrap.json"));
  });

  it("requires the built OpenClaw release for installation while retaining the declared API floor", () => {
    const packageJson = packageMetadata;

    assert.match(packageJson.dependencies?.["@anthropic-ai/claude-agent-sdk"] ?? "", /^\d+\.\d+\.\d+$/u);
    assert.equal(packageJson.openclaw?.install?.npmSpec, "openclaw-code-agent");
    assert.equal(packageJson.openclaw?.install?.defaultChoice, "npm");
    assert.match(openclawTarget, EXACT_OPENCLAW_VERSION);
    assert.match(openclawFloor, EXACT_OPENCLAW_VERSION);
    assert.ok(compareOpenClawVersions(openclawFloor, openclawTarget) <= 0, "compatibility floor must not exceed the build target");
    assert.equal(packageJson.openclaw?.install?.minHostVersion, `>=${openclawTarget}`);
    assert.equal(packageJson.openclaw?.compat?.pluginApi, `>=${openclawFloor}`);
    assert.equal(packageJson.openclaw?.compat?.minGatewayVersion, openclawFloor);
    assert.equal(packageJson.openclaw?.build?.openclawVersion, openclawTarget);
    assert.equal(packageJson.openclaw?.build?.pluginSdkVersion, openclawTarget);
    assert.equal(packageJson.peerDependencies?.openclaw, `>=${openclawFloor}`);
    assert.equal(packageJson.devDependencies?.openclaw, openclawTarget);
    assert.equal(packageJson.engines?.node, ">=24.16.0 <25 || >=26.1.0");
    assert.doesNotMatch(readFileSync(join(rootDir, "pnpm-lock.yaml"), "utf8"), /uuid@9\.0\.1/);
  });

  it("accepts exact and range-shaped manual OpenClaw release targets", () => {
    assert.equal(normalizeOpenClawTargetVersion(openclawTarget), openclawTarget);
    assert.equal(normalizeOpenClawTargetVersion(`>=${openclawTarget}`), openclawTarget);
    assert.doesNotThrow(() =>
      validateReleaseMetadata({
        openclawTargetVersion: openclawTarget,
        openclawCompatibilityFloor: `>=${openclawFloor}`,
      }),
    );
    assert.throws(
      () => validateReleaseMetadata({ openclawTargetVersion: "2000.1.1" }),
      /OpenClaw target mismatch/u,
    );
    assert.throws(
      () => validateReleaseMetadata({ openclawCompatibilityFloor: "2000.1.1" }),
      /OpenClaw pluginApi mismatch/u,
    );
    assert.throws(
      () => normalizeOpenClawTargetVersion("^2026.7.1"),
      /expected an exact version or >= range/u,
    );
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

  it("requires verification before orchestrator plan approval in the skill", () => {
    const skill = readFileSync(
      join(rootDir, "skills", "code-agent-orchestration", "SKILL.md"),
      "utf8",
    );
    const approveSection = skill.split('### `planApproval: "approve"`')[1]?.split("\n## ")[0] ?? "";

    assert.doesNotMatch(skill, /auto-approve/i);
    assert.match(approveSection, /only after it verifies the plan/);
    assert.match(approveSection, /agent_output\(session, full=true\)/);
    assert.match(approveSection, /agent_request_plan_approval/);
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

  it("declares OCA as a built-in natural-language trigger in skill metadata and docs", () => {
    const skill = readFileSync(
      join(rootDir, "skills", "code-agent-orchestration", "SKILL.md"),
      "utf8",
    );
    const readme = readFileSync(join(rootDir, "README.md"), "utf8");
    const reference = readFileSync(join(rootDir, "docs", "REFERENCE.md"), "utf8");
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";

    assert.match(frontmatter, /^name:\s+Code Agent Orchestration \(OCA\)$/m);
    assert.match(frontmatter, /orchestrating coding agent sessions from OpenClaw/);
    assert.match(frontmatter, /let oca do/);
    assert.match(frontmatter, /ask oca to/);
    assert.match(frontmatter, /have oca handle/);
    assert.match(skill, /built-in short name for OpenClaw Code Agent/);
    for (const source of [readme, reference]) {
      assert.match(source, /[Nn]o (?:local alias config|custom local alias config) is needed/);
      assert.match(source, /Let oca do/);
      assert.match(source, /Ask oca to/);
      assert.match(source, /Have oca handle/);
    }
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
        "agent_policy",
        "agent_goal",
        "agent_goal_status",
        "agent_goal_stop",
        "agent_goal_edit",
      ],
    });
    assert.deepEqual(pluginManifest.setup, {
      requiresRuntime: false,
    });
    assert.deepEqual(pluginManifest.configSchema?.properties?.defaultHarness?.enum, [
      "claude-code",
      "codex",
      "opencode",
    ]);
    assert.match(pluginManifest.configSchema?.properties?.defaultHarness?.description ?? "", /experimental harness/);
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
    assert.equal(pluginManifest.configSchema?.properties?.harnesses?.default?.codex?.defaultModel, "gpt-6-sol");
    assert.equal(pluginManifest.configSchema?.properties?.harnesses?.default?.["claude-code"]?.defaultModel, "opus");
    assert.match(pluginManifest.uiHints?.harnesses?.help ?? "", /"defaultModel":"opus"/);
    assert.equal(pluginManifest.configSchema?.properties?.harnesses?.default?.codex?.fastMode, false);
    assert.equal(pluginManifest.configSchema?.properties?.harnesses?.default?.codex?.reasoningEffort, undefined);
    assert.equal(pluginManifest.configSchema?.properties?.harnesses?.default?.codex?.permissionProfile, undefined, "unset so it follows tools.exec.mode");
    assert.equal(pluginManifest.configSchema?.properties?.harnesses?.default?.codex?.approvalPolicy, undefined);
    assert.equal(pluginManifest.configSchema?.properties?.harnesses?.default?.codex?.approvalsReviewer, undefined);
    assert.deepEqual(pluginManifest.configSchema?.properties?.harnesses?.additionalProperties?.properties?.permissionProfile?.enum, [
      ":read-only",
      ":workspace",
      ":danger-full-access",
    ]);
    assert.deepEqual(pluginManifest.configSchema?.properties?.harnesses?.additionalProperties?.properties?.approvalPolicy?.enum, [
      "never",
      "on-request",
      "untrusted",
    ]);
    assert.deepEqual(pluginManifest.configSchema?.properties?.harnesses?.additionalProperties?.properties?.approvalsReviewer?.enum, [
      "user",
      "auto_review",
    ]);
    assert.deepEqual(pluginManifest.configSchema?.properties?.harnesses?.default?.opencode, {});
    assert.match(pluginManifest.uiHints?.harnesses?.help ?? "", /harnesses\.codex\.fastMode=true/);
    assert.match(pluginManifest.uiHints?.harnesses?.help ?? "", /OpenCode is experimental/);
  });

  it("keeps declared tool contracts synced with runtime registrations", () => {
    const expectedToolNames = [
      "agent_launch",
      "agent_sessions",
      "agent_kill",
      "agent_output",
      "agent_respond",
      "agent_session_action",
      "agent_request_plan_approval",
      "agent_request_worktree_decision",
      "agent_send_plan_offer",
      "agent_stats",
      "agent_repo_policy",
      "agent_merge",
      "agent_pr",
      "agent_worktree_cleanup",
      "agent_worktree_status",
      "agent_goal_launch",
      "agent_goal_status",
      "agent_goal_stop",
      "agent_goal_edit",
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
    assert.match(indexSource, /name: "Code Agent"/);
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

  it("documents the compatibility floor and ownership boundaries", () => {
    const reference = readFileSync(join(rootDir, "docs", "REFERENCE.md"), "utf8");
    const readme = readFileSync(join(rootDir, "README.md"), "utf8");
    const target = escapeRegExp(openclawTarget);
    const floor = escapeRegExp(openclawFloor);

    assert.match(reference, /## Compatibility And Upgrades/);
    assert.match(reference, new RegExp(`requires, is built against, and is validated against OpenClaw \`${target}\``));
    assert.match(readme, new RegExp(`requires, is built against, and is validated against OpenClaw \`${target}\``));
    assert.match(reference, new RegExp(`Package installation therefore requires \`${target}\``));
    assert.match(reference, new RegExp(`keep the verified \`${floor}\` compatibility floor`));
    assert.match(readme, /callback ownership, and namespaced tool allowlists remain under the same plugin contracts/);
    assert.match(reference, /pnpm-workspace\.yaml/);
    assert.match(reference, /plugins\.allow/);
    assert.match(reference, /No host config migration is performed by this package/);
    assert.match(reference, /host-owned `codex\/\*` and `openai-codex\/\*` model references to `openai\/\*`/);
    assert.match(reference, /Restored sessions and explicit overrides pass through the same harness-scoped validation/);
    assert.match(reference, /Start Plan/);
    assert.match(reference, /thread `<topic-id>`/);
    assert.match(reference, /ctx\.callback\.payload/);
    assert.match(reference, /apply-then-consume token semantics/);
    assert.match(reference, /token remains retryable/);
    assert.match(reference, /treated as terminal/);
    assert.match(reference, /serialized per session\/version/);
    assert.match(reference, /PR update completion summaries/);
    assert.match(reference, /tools\.exec\.applyPatch/);
    assert.match(reference, /tools\.deny/);
    assert.match(reference, /Upgrading from 4\.x/);
    assert.doesNotMatch(reference, /callback_data/);
    assert.doesNotMatch(reference, /### Deprecated Compatibility Fields/);
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

  it("externalizes exactly the public OpenClaw plugin SDK subpaths the source imports", () => {
    const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const buildScript = packageJson.scripts?.build ?? "";

    assert.doesNotMatch(buildScript, /--external:openclaw(?:\s|$)/);
    assert.doesNotMatch(buildScript, /--external:openclaw\/plugin-sdk(?:\s|$)/);
    assert.doesNotMatch(buildScript, /--external:openclaw\/plugin-sdk\/\*(?:\s|$)/);
    assert.match(buildScript, /--external:@anthropic-ai\/claude-agent-sdk/);

    const externals = [...buildScript.matchAll(/--external:(openclaw\/plugin-sdk\/[a-z-]+)/g)].map((match) => match[1]).sort();
    const sources = [
      "api.ts",
      "index.ts",
      ...(readdirSync(join(rootDir, "src"), { recursive: true }) as string[])
        .filter((file) => file.endsWith(".ts"))
        .map((file) => join("src", file)),
    ];
    const runtimeImports = new Set<string>();
    for (const file of sources) {
      const source = readFileSync(join(rootDir, file), "utf8");
      // Value imports/re-exports and dynamic imports need a host module at runtime;
      // `import type` / `typeof import(...)` are erased by the build.
      for (const match of source.matchAll(/(?:^|\n)(?:import|export)\s+(?!type\b)[^;]*?from\s+"(openclaw\/plugin-sdk\/[a-z-]+)"|await import\("(openclaw\/plugin-sdk\/[a-z-]+)"\)/g)) {
        runtimeImports.add(match[1] ?? match[2]!);
      }
    }
    assert.deepEqual(externals, [...runtimeImports].sort());

    // Every externalized subpath must be a public export of the minimum supported host.
    const hostPackage = JSON.parse(readFileSync(join(rootDir, "node_modules", "openclaw", "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    for (const subpath of externals) {
      assert.ok(hostPackage.exports?.[`./${subpath.slice("openclaw/".length)}`], `${subpath} is not exported by openclaw`);
    }
  });

  it("registers interactive handlers and does not register plugin HTTP routes", () => {
    const indexSource = readFileSync(join(rootDir, "index.ts"), "utf8");

    assert.match(indexSource, /registerCodeAgentInteractiveHandler\("telegram"\)/);
    assert.match(indexSource, /registerCodeAgentInteractiveHandler\("discord"\)/);
    assert.match(indexSource, /createCallbackHandler\(channel\)/);
    assert.doesNotMatch(indexSource, /registerHttpRoute\(/);
  });

  it("derives direct routes from non-Telegram interactive contexts", () => {
    const route = routeFromInteractiveContext({
      channel: "discord",
      accountId: "bot1",
      conversationId: "987654321",
      threadId: "112233",
      sessionKey: "agent:main:discord:channel:987654321",
    });

    assert.deepEqual(route, {
      provider: "discord",
      accountId: "bot1",
      target: "channel:987654321",
      threadId: "112233",
      sessionKey: "agent:main:discord:channel:987654321",
    });
  });

  it("registers goal tools, commands, and controller startup", () => {
    const indexSource = readFileSync(join(rootDir, "index.ts"), "utf8");

    assert.match(indexSource, /makeGoalLaunchTool/);
    assert.match(indexSource, /makeGoalStatusTool/);
    assert.match(indexSource, /makeGoalStopTool/);
    assert.match(indexSource, /makeGoalEditTool/);
    assert.match(indexSource, /registerGoalCommand\(commandApi\)/);
    assert.match(indexSource, /registerGoalStatusCommand\(commandApi\)/);
    assert.match(indexSource, /registerGoalStopCommand\(commandApi\)/);
    assert.match(indexSource, /registerGoalEditCommand\(commandApi\)/);
    assert.match(indexSource, /gc = new GoalController\(sm\)/);
    assert.match(indexSource, /gc\.start\(\)/);
  });

  it("keeps tool construction side-effect free and starts before execution", async () => {
    const { api, services, tools } = createPluginApi();
    register(api as any);
    assert.equal(sessionManager, null);

    const factory = tools.find((tool) => tool.options?.name === "agent_sessions")?.factory;
    assert.ok(factory, "expected agent_sessions factory");
    const tool = factory({ workspaceDir: rootDir });
    assert.equal(sessionManager, null, "tool construction must not initialize SessionManager");

    const result = await tool.execute("tool-id", {});
    assert.ok(sessionManager, "tool execution should initialize SessionManager");
    assert.doesNotMatch(result.content?.[0]?.text ?? "", /SessionManager not initialized/);
    await stopCapturedServices(services);
  });

  it("lazily starts the code-agent service before command handlers can observe uninitialized state", async () => {
    const { api, commands, services } = createPluginApi();
    register(api as any);
    assert.equal(sessionManager, null);

    const command = commands.find((entry) => entry.name === "agent_sessions");
    assert.ok(command, "expected agent_sessions command");
    const result = await command.handler({ args: "--full" });

    assert.ok(sessionManager, "command handler should initialize SessionManager");
    assert.doesNotMatch(result.text, /SessionManager not initialized/);
    await stopCapturedServices(services);
  });

  it("keeps service startup idempotent when service start follows tool execution", async () => {
    const { api, services, tools } = createPluginApi();
    register(api as any);

    const factory = tools.find((tool) => tool.options?.name === "agent_sessions")?.factory;
    assert.ok(factory, "expected agent_sessions factory");
    const tool = factory({ workspaceDir: rootDir });
    assert.equal(sessionManager, null);
    await tool.execute("tool-id", {});
    const lazySessionManager = sessionManager;
    assert.ok(lazySessionManager, "expected lazy SessionManager");

    await services[0]?.start({ config: { gateway: true } });
    assert.equal(sessionManager, lazySessionManager);

    await stopCapturedServices(services);
    assert.equal(sessionManager, null);
  });

  it("does not create the self-updater when autoUpdate is false", async () => {
    const { api, services } = createPluginApi({ autoUpdate: false });
    register(api as any);

    await services[0]?.start({ config: { gateway: true } });
    assert.ok(sessionManager, "expected a started SessionManager");
    assert.equal(autoUpdateService, null);

    await stopCapturedServices(services);
  });

  it("shares concurrent startup and waits for drainage before a lazy restart", async () => {
    const entered = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    const start = mock.method(GoalController.prototype, "start", () => {});
    const launch = mock.method(Session.prototype, "start", async () => {});
    const drain = mock.method(SessionManager.prototype, "drainTaskLifecycle", async () => {
      entered.resolve();
      await drained.promise;
    });
    const { api, services, tools } = createPluginApi();
    register(api as any);
    const factory = tools.find((tool) => tool.options?.name === "agent_sessions")?.factory;
    assert.ok(factory);
    const tool = factory({ workspaceDir: rootDir });
    let restart: Promise<unknown> | undefined;
    let stopping: Promise<unknown> | undefined;
    try {
      await Promise.all([
        tool.execute("first", {}),
        tool.execute("second", {}),
        services[0].start({ config: { gateway: true } }),
      ]);
      assert.equal(start.mock.callCount(), 1);
      const previous = sessionManager;
      assert.ok(previous);
      stopping = Promise.resolve(services[0].stop?.({}));
      assert.equal(sessionManager, previous);
      let restarted = false;
      restart = Promise.resolve(tool.execute("restart", {})).then(() => { restarted = true; });
      await entered.promise;
      assert.equal(restarted, false);
      assert.equal(sessionManager, previous);
      const lateLaunch = async () => await previous.launchSession({
        prompt: "Launch prepared before shutdown",
        workdir: rootDir,
        permissionMode: "plan",
        worktreeStrategy: "off",
        route: { provider: "system", target: "system" },
      });
      await assert.rejects(lateLaunch, /service is shutting down/);
      assert.equal(launch.mock.callCount(), 0);
      assert.deepEqual(previous.list(), []);
      drained.resolve();
      await stopping;
      await restart;
      assert.notEqual(sessionManager, previous);
      assert.equal(start.mock.callCount(), 2);
      await assert.rejects(lateLaunch, /service is shutting down/);
    } finally {
      drained.resolve();
      await Promise.allSettled([stopping, restart]);
      await stopCapturedServices(services);
      drain.mock.restore();
      start.mock.restore();
      launch.mock.restore();
    }
  });
});
