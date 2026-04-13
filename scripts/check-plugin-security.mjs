#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = dirname(dirname(scriptPath));

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

    const install = await runCommand("pnpm", [
      "exec",
      "openclaw",
      "plugins",
      "install",
      tarballPath,
    ], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: join(profileDir, "state"),
        OPENCLAW_CONFIG_PATH: join(profileDir, "config.json"),
      },
    });

    process.exitCode = install.code;
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
