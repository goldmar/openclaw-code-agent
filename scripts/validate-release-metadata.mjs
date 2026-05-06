#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = dirname(dirname(scriptPath));

export function loadReleaseMetadata(baseDir = rootDir) {
  const packageJson = JSON.parse(readFileSync(join(baseDir, "package.json"), "utf8"));
  const pluginManifest = JSON.parse(readFileSync(join(baseDir, "openclaw.plugin.json"), "utf8"));

  return {
    packageVersion: packageJson.version,
    pluginVersion: pluginManifest.version,
    openclawVersion: packageJson.openclaw?.build?.openclawVersion,
    pluginSdkVersion: packageJson.openclaw?.build?.pluginSdkVersion,
  };
}

export function validateReleaseMetadata(options = {}) {
  const { releaseVersion, openclawTargetVersion, baseDir = rootDir } = options;
  const { packageVersion, pluginVersion, openclawVersion, pluginSdkVersion } =
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

  return {
    packageVersion,
    pluginVersion,
    openclawVersion,
    pluginSdkVersion,
  };
}

function runCli() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const releaseVersion = args.find((arg) => !arg.startsWith("--openclaw-target="));
  const openclawTargetVersion = args
    .find((arg) => arg.startsWith("--openclaw-target="))
    ?.slice("--openclaw-target=".length);
  const { packageVersion, pluginVersion, openclawVersion, pluginSdkVersion } =
    validateReleaseMetadata({ releaseVersion, openclawTargetVersion });
  const releaseLabel = releaseVersion ? ` against release ${releaseVersion}` : "";
  console.log(
    `Release metadata validated${releaseLabel}: package.json=${packageVersion}, openclaw.plugin.json=${pluginVersion}, openclawVersion=${openclawVersion}, pluginSdkVersion=${pluginSdkVersion}`,
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
