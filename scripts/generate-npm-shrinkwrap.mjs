#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const stagingDir = mkdtempSync(join(tmpdir(), "oca-npm-shrinkwrap-"));

try {
  const publishedRuntimeManifest = {
    name: packageJson.name,
    version: packageJson.version,
    license: packageJson.license,
    dependencies: packageJson.dependencies,
    peerDependencies: packageJson.peerDependencies,
    ...(packageJson.peerDependenciesMeta
      ? { peerDependenciesMeta: packageJson.peerDependenciesMeta }
      : {}),
    ...(packageJson.engines ? { engines: packageJson.engines } : {}),
  };
  writeFileSync(
    join(stagingDir, "package.json"),
    `${JSON.stringify(publishedRuntimeManifest, null, 2)}\n`,
  );
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    { cwd: stagingDir, stdio: "inherit" },
  );
  cpSync(join(stagingDir, "package-lock.json"), join(rootDir, "npm-shrinkwrap.json"));
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}
