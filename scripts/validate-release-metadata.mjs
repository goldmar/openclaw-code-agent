#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = dirname(dirname(scriptPath));
const defaultOpenClawTargetVersion = "2026.7.1";

export function loadReleaseMetadata(baseDir = rootDir) {
  const packageJson = JSON.parse(readFileSync(join(baseDir, "package.json"), "utf8"));
  const pluginManifest = JSON.parse(readFileSync(join(baseDir, "openclaw.plugin.json"), "utf8"));

  return {
    packageVersion: packageJson.version,
    pluginVersion: pluginManifest.version,
    openclawVersion: packageJson.openclaw?.build?.openclawVersion,
    pluginSdkVersion: packageJson.openclaw?.build?.pluginSdkVersion,
    openclawInstall: packageJson.openclaw?.install,
  };
}

export function validateReleaseMetadata(options = {}) {
  const {
    releaseVersion,
    openclawTargetVersion = defaultOpenClawTargetVersion,
    baseDir = rootDir,
  } = options;
  const { packageVersion, pluginVersion, openclawVersion, pluginSdkVersion, openclawInstall } =
    loadReleaseMetadata(baseDir);

  if (packageVersion !== pluginVersion) {
    throw new Error(
      `Version mismatch: package.json=${packageVersion}, openclaw.plugin.json=${pluginVersion}`,
    );
  }

  if (releaseVersion && packageVersion !== releaseVersion) {
    throw new Error(
      `Release version mismatch: expected ${releaseVersion}, package.json=${packageVersion}, openclaw.plugin.json=${pluginVersion}`,
    );
  }

  if (!openclawVersion || !pluginSdkVersion) {
    throw new Error("Missing OpenClaw build metadata in package.json");
  }

  if (openclawVersion !== pluginSdkVersion) {
    throw new Error(
      `OpenClaw build metadata mismatch: openclawVersion=${openclawVersion}, pluginSdkVersion=${pluginSdkVersion}`,
    );
  }

  if (openclawTargetVersion && openclawVersion !== openclawTargetVersion) {
    throw new Error(
      `OpenClaw target mismatch: expected ${openclawTargetVersion}, openclawVersion=${openclawVersion}, pluginSdkVersion=${pluginSdkVersion}`,
    );
  }

  if (!openclawInstall || typeof openclawInstall !== "object") {
    throw new Error("Missing OpenClaw install metadata in package.json");
  }

  if (openclawInstall.npmSpec !== "openclaw-code-agent") {
    throw new Error(
      `OpenClaw install npmSpec mismatch: expected openclaw-code-agent, got ${openclawInstall.npmSpec}`,
    );
  }

  if (openclawInstall.defaultChoice !== "npm") {
    throw new Error(
      `OpenClaw install defaultChoice mismatch: expected npm, got ${openclawInstall.defaultChoice}`,
    );
  }

  if (openclawInstall.minHostVersion !== ">=2026.7.1") {
    throw new Error(
      `OpenClaw install minHostVersion mismatch: expected >=2026.7.1, got ${openclawInstall.minHostVersion}`,
    );
  }

  const packageJson = JSON.parse(readFileSync(join(baseDir, "package.json"), "utf8"));
  const changelog = readFileSync(join(baseDir, "CHANGELOG.md"), "utf8");
  const lockfile = readFileSync(join(baseDir, "pnpm-lock.yaml"), "utf8");
  const escapedVersion = packageVersion.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

  if (!new RegExp(`^## \\\[${escapedVersion}\\\](?: - .+)?$`, "mu").test(changelog)) {
    throw new Error(`CHANGELOG.md has no ${packageVersion} section`);
  }

  if (!lockfile.includes(`openclaw:\n        specifier: ${openclawVersion}`)) {
    throw new Error(`pnpm-lock.yaml is not pinned to OpenClaw ${openclawVersion}`);
  }

  if (packageJson.packageManager !== "pnpm@10.30.0") {
    throw new Error(`Unexpected package manager: ${packageJson.packageManager}`);
  }

  if (packageJson.publishConfig?.provenance !== true) {
    throw new Error("npm provenance must be enabled");
  }

  return {
    packageVersion,
    pluginVersion,
    openclawVersion,
    pluginSdkVersion,
    openclawInstall,
  };
}

function runCli() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const releaseVersion = args.find((arg) => !arg.startsWith("--"));
  const openclawTargetVersion = args
    .find((arg) => arg.startsWith("--openclaw-target="))
    ?.slice("--openclaw-target=".length);
  const { packageVersion, pluginVersion, openclawVersion, pluginSdkVersion, openclawInstall } =
    validateReleaseMetadata({ releaseVersion, openclawTargetVersion });
  const releaseLabel = releaseVersion ? ` against release ${releaseVersion}` : "";
  console.log(
    `Release metadata validated${releaseLabel}: package.json=${packageVersion}, openclaw.plugin.json=${pluginVersion}, openclawVersion=${openclawVersion}, pluginSdkVersion=${pluginSdkVersion}, openclaw.install.npmSpec=${openclawInstall.npmSpec}, openclaw.install.defaultChoice=${openclawInstall.defaultChoice}, openclaw.install.minHostVersion=${openclawInstall.minHostVersion}`,
  );
}

if (process.argv[1] === scriptPath) {
  try {
    runCli();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
