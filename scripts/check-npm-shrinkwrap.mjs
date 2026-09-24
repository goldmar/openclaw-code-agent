#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = dirname(dirname(scriptPath));
const requiredSecurityVersions = {
  "@hono/node-server": "2.1.1",
  "express-rate-limit": "8.7.0",
  "fast-uri": "3.1.8",
  hono: "4.13.7",
  "ip-address": "10.7.0",
  qs: "6.16.0",
};

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

  for (const [name, version] of Object.entries(requiredSecurityVersions)) {
    if (packageJson.dependencies?.[name] !== version) {
      throw new Error(`package.json must declare exact runtime dependency ${name}@${version}`);
    }
  }
}

if (process.argv[1] === scriptPath) {
  validateNpmShrinkwrap();
  console.log("npm shrinkwrap runtime security floors validated");
}
