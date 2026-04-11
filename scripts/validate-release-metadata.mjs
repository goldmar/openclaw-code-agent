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
  };
}

export function validateReleaseMetadata(options = {}) {
  const { releaseVersion, baseDir = rootDir } = options;
  const { packageVersion, pluginVersion } = loadReleaseMetadata(baseDir);

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

  return {
    packageVersion,
    pluginVersion,
  };
}

function runCli() {
  const releaseVersion = process.argv.slice(2).find((arg) => arg !== "--");
  const { packageVersion, pluginVersion } = validateReleaseMetadata({ releaseVersion });
  const releaseLabel = releaseVersion ? ` against release ${releaseVersion}` : "";
  console.log(
    `Release metadata validated${releaseLabel}: package.json=${packageVersion}, openclaw.plugin.json=${pluginVersion}`,
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
