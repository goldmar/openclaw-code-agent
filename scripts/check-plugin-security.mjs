#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = dirname(dirname(scriptPath));
const pluginName = "openclaw-code-agent";
const allowedPluginSafetyFindings = [
  "[dangerous-exec] Shell command execution detected (child_process)",
];
const allowedPluginSafetyFindingPatterns = [
  /^- \[dangerous-exec-truncated\] \d+ additional dangerous-exec matches omitted after \d+ findings \(.+:\d+\)$/u,
];

/** Reject metadata-only inspection or incomplete runtime registration as package proof. */
export function validatePackedPluginRuntime(report, expectedVersion, expectedTools) {
  if (report.plugin?.version !== expectedVersion || report.plugin?.status !== "loaded") {
    throw new Error(`Packed plugin did not load at the expected version ${expectedVersion}`);
  }
  const errors = (report.diagnostics ?? []).filter((entry) => entry.level === "error");
  if (errors.length) throw new Error("Packed plugin runtime reported error diagnostics");
  const tools = (report.tools ?? []).flatMap((entry) => entry.names);
  if (expectedTools.some((name) => !tools.includes(name))) {
    throw new Error("Packed plugin runtime is missing required OCA tool registrations");
  }
}

export function findUnexpectedPluginSafetyFindings(auditResult, expectedPluginName = pluginName) {
  const findings = Array.isArray(auditResult?.findings) ? auditResult.findings : [];
  const pluginLabel = `Plugin "${expectedPluginName}"`;
  const pluginFindings = findings.filter(
    (finding) => typeof finding?.title === "string" && finding.title.includes(pluginLabel),
  );
  const codeSafetyFindings = pluginFindings.filter(
    (finding) => finding.checkId === "plugins.code_safety",
  );
  const issueLines = codeSafetyFindings.flatMap((finding) =>
    typeof finding.detail === "string"
      ? finding.detail.split(/\r?\n/).filter((line) => /\[[a-z-]+\]/.test(line))
      : [],
  );
  const unexpected = pluginFindings
    .filter((finding) => finding.checkId !== "plugins.code_safety")
    .map((finding) => finding.title);

  for (const line of issueLines) {
    const trimmed = line.trim();
    if (
      !allowedPluginSafetyFindings.some((finding) => trimmed.includes(finding))
      && !allowedPluginSafetyFindingPatterns.some((pattern) => pattern.test(trimmed))
    ) {
      unexpected.push(trimmed);
    }
  }
  if (
    codeSafetyFindings.length !== 1
    || !issueLines.some((line) => line.includes(allowedPluginSafetyFindings[0]))
  ) {
    unexpected.push(`Expected one ${pluginLabel} code-safety finding with reviewed issue detail.`);
  }
  return unexpected;
}

/**
 * @param {string} profileDir
 * @param {NodeJS.ProcessEnv} [sourceEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function createIsolatedOpenClawEnv(profileDir, sourceEnv = process.env) {
  const env = Object.fromEntries(
    Object.entries(sourceEnv).filter(([key]) => !key.startsWith("OPENCLAW_")),
  );
  return {
    ...env,
    HOME: profileDir,
    XDG_CONFIG_HOME: join(profileDir, "config"),
    XDG_STATE_HOME: join(profileDir, "xdg-state"),
    XDG_DATA_HOME: join(profileDir, "data"),
    XDG_CACHE_HOME: join(profileDir, "cache"),
    OPENCLAW_STATE_DIR: join(profileDir, "state"),
    OPENCLAW_CONFIG_PATH: join(profileDir, "config.json"),
    OPENCLAW_GATEWAY_PORT: "65534",
  };
}

export function buildPackedPluginInstallArgs(tarballPath) {
  return [
    "exec",
    "openclaw",
    "plugins",
    "install",
    tarballPath,
    "--force",
    "--accept-capabilities",
  ];
}

function runCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? rootDir,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    if (options.forwardStdout !== false) process.stdout.write(text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    if (options.forwardStderr !== false) process.stderr.write(text);
  });

  return new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`${command} ${args.join(" ")} terminated by signal ${signal}`));
        return;
      }

      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function main() {
  const workspaceDir = resolve(rootDir);
  const packDir = await mkdtemp(join(tmpdir(), "openclaw-plugin-pack-"));
  const profileDir = await mkdtemp(join(tmpdir(), "openclaw-plugin-security-"));
  const isolatedEnv = createIsolatedOpenClawEnv(profileDir);

  try {
    const packed = await runCommand("pnpm", [
      "pack",
      "--json",
      "--pack-destination",
      packDir,
    ], {
      cwd: workspaceDir,
      forwardStdout: false,
    });

    if (packed.code !== 0) {
      process.exitCode = packed.code;
      return;
    }

    const packOutput = JSON.parse(packed.stdout);
    const tarballName = Array.isArray(packOutput) ? packOutput[0]?.filename : packOutput?.filename;

    if (!tarballName || typeof tarballName !== "string") {
      throw new Error(`pnpm pack did not report a tarball filename: ${packed.stdout.trim()}`);
    }

    const tarballPath = isAbsolute(tarballName) ? tarballName : join(packDir, tarballName);
    console.error(`Packed plugin tarball: ${tarballPath}`);
    console.error(`Checking packed plugin security via ${tarballPath}`);

    const install = await runCommand("pnpm", buildPackedPluginInstallArgs(tarballPath), {
      cwd: workspaceDir,
      env: isolatedEnv,
    });

    if (install.code !== 0) {
      process.exitCode = install.code;
      return;
    }

    // Load the installed tarball through the actual published host, independently
    // of the dependency-graph consumer check (which intentionally uses a stub).
    const enable = await runCommand("pnpm", ["exec", "openclaw", "plugins", "enable", pluginName], {
      cwd: workspaceDir, env: isolatedEnv,
    });
    if (enable.code !== 0) throw new Error("Packed plugin activation failed");
    const inspection = await runCommand("pnpm", ["exec", "openclaw", "plugins", "inspect", pluginName, "--runtime", "--json"], {
      cwd: workspaceDir, env: isolatedEnv, forwardStdout: false,
    });
    if (inspection.code !== 0) throw new Error("Packed plugin runtime inspection failed");
    const report = JSON.parse(inspection.stdout);
    const expected = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
    const expectedTools = JSON.parse(readFileSync(join(rootDir, "openclaw.plugin.json"), "utf8"))
      .contracts.tools.filter((name) => name !== "agent_send_plan_offer");
    validatePackedPluginRuntime(report, expected.version, expectedTools);
    const actualHost = JSON.parse(readFileSync(join(rootDir, "node_modules", "openclaw", "package.json"), "utf8"));
    if (actualHost.version !== expected.openclaw.build.openclawVersion) {
      throw new Error("Packed plugin proof used an unexpected OpenClaw package version");
    }
    console.error(`Packed ${pluginName}@${expected.version} loaded through OpenClaw ${expected.openclaw.build.openclawVersion}`);

    const audit = await runCommand("pnpm", [
      "exec",
      "openclaw",
      "security",
      "audit",
      "--deep",
      "--json",
    ], {
      cwd: workspaceDir,
      env: isolatedEnv,
      forwardStdout: false,
    });
    if (audit.code !== 0) {
      process.exitCode = audit.code;
      return;
    }

    const auditResult = JSON.parse(audit.stdout);
    const unexpectedFindings = findUnexpectedPluginSafetyFindings(auditResult);
    if (unexpectedFindings.length > 0) {
      console.error("Unexpected packed-plugin security finding(s):");
      for (const finding of unexpectedFindings) console.error(`- ${finding}`);
      process.exitCode = 1;
      return;
    }

    console.error("Packed plugin code-safety findings match the reviewed allowlist.");
    process.exitCode = 0;
  } finally {
    await Promise.allSettled([
      rm(packDir, { recursive: true, force: true }),
      rm(profileDir, { recursive: true, force: true }),
    ]);
  }
}

if (process.argv[1] === scriptPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
