#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pinnedOverrideErrors,
  pinnedRuntimeVersions,
  readPnpmWorkspaceOverrides,
} from "./lib/runtime-dependency-pins.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = dirname(dirname(scriptPath));

export function validateNpmShrinkwrap(baseDir = rootDir) {
  const packageJson = JSON.parse(readFileSync(join(baseDir, "package.json"), "utf8"));
  const shrinkwrap = JSON.parse(readFileSync(join(baseDir, "npm-shrinkwrap.json"), "utf8"));

  if (shrinkwrap.lockfileVersion !== 3) {
    throw new Error(`npm-shrinkwrap.json must use lockfileVersion 3, got ${shrinkwrap.lockfileVersion}`);
  }
  if (shrinkwrap.name !== packageJson.name || shrinkwrap.version !== packageJson.version) {
    throw new Error("npm-shrinkwrap.json root identity does not match package.json");
  }

  const root = shrinkwrap.packages?.[""];
  if (!root || root.name !== packageJson.name || root.version !== packageJson.version) {
    throw new Error("npm-shrinkwrap.json root package metadata does not match package.json");
  }
  if (JSON.stringify(root.dependencies) !== JSON.stringify(packageJson.dependencies)) {
    throw new Error("npm-shrinkwrap.json root dependencies do not exactly match package.json");
  }
  if (JSON.stringify(root.peerDependencies) !== JSON.stringify(packageJson.peerDependencies)) {
    throw new Error("npm-shrinkwrap.json root peer dependencies do not exactly match package.json");
  }
  if (JSON.stringify(root.engines) !== JSON.stringify(packageJson.engines)) {
    throw new Error("npm-shrinkwrap.json root engines do not exactly match package.json");
  }

  for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      throw new Error(`published runtime dependency ${name} must use an exact version, got ${version}`);
    }
    const installed = shrinkwrap.packages?.[`node_modules/${name}`]?.version;
    if (installed !== version) {
      throw new Error(`npm-shrinkwrap.json must resolve ${name}@${version}, got ${installed}`);
    }
  }

  // The pinned security floors are package.json versions; pnpm overrides for
  // the same packages must lift the development graph to exactly those.
  const pinned = pinnedRuntimeVersions(packageJson);
  const overrideErrors = pinnedOverrideErrors(readPnpmWorkspaceOverrides(baseDir), pinned);
  if (overrideErrors.length > 0) throw new Error(overrideErrors.join("\n"));
}

if (process.argv[1] === scriptPath) {
  validateNpmShrinkwrap();
  console.log("npm shrinkwrap runtime security floors validated");
}
