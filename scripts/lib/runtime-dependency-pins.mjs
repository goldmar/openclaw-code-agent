// Runtime dependencies whose exact versions are security floors for npm
// consumers. npm ignores `overrides` from installed packages, so these must be
// direct, exact `dependencies` in package.json and resolve to exactly that
// version in npm-shrinkwrap.json.
//
// package.json `dependencies` is the single source of truth for the versions.
// This module only names the packages; every check reads the versions from
// package.json:
// - scripts/check-npm-shrinkwrap.mjs (the manifest, the shrinkwrap, and the
//   matching pnpm-workspace.yaml overrides for the development graph)
// - scripts/verify-npm-consumer-install.mjs (the packed consumer install)
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PINNED_RUNTIME_DEPENDENCIES = Object.freeze([
  "@hono/node-server",
  "express-rate-limit",
  "fast-uri",
  "hono",
  "ip-address",
  "qs",
]);

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * `{ name: version }` for every pinned runtime dependency, read from package.json.
 * @param {{ dependencies?: Record<string, string> }} packageJson
 * @returns {Record<string, string>}
 */
export function pinnedRuntimeVersions(packageJson) {
  /** @type {Record<string, string>} */
  const versions = {};
  for (const name of PINNED_RUNTIME_DEPENDENCIES) {
    const version = packageJson.dependencies?.[name];
    if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
      throw new Error(`package.json must declare exact runtime dependency ${name}, got ${version ?? "nothing"}`);
    }
    versions[name] = version;
  }
  return versions;
}

/**
 * The `overrides` map of pnpm-workspace.yaml. Only the flat `key: value` form
 * this repository uses is supported (no nested maps or flow syntax).
 * @param {string} baseDir
 * @returns {Record<string, string>}
 */
export function readPnpmWorkspaceOverrides(baseDir) {
  const lines = readFileSync(join(baseDir, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/u);
  const start = lines.findIndex((line) => /^overrides:\s*$/u.test(line));
  if (start < 0) return {};
  /** @type {Record<string, string>} */
  const overrides = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) break;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = /^\s+("([^"]+)"|[^\s"][^:]*?):\s*(.+?)\s*$/u.exec(line);
    if (!match) throw new Error(`Unsupported pnpm-workspace.yaml override line: ${line}`);
    const key = match[2] ?? match[1];
    overrides[key] = match[3].replace(/^"(.*)"$/u, "$1");
  }
  return overrides;
}

/**
 * Package name of an override selector such as `hono@<4.13.9` or `@hono/node-server@<2.1.1`.
 * @param {string} selector
 * @returns {string}
 */
export function overridePackageName(selector) {
  const at = selector.indexOf("@", 1);
  return at < 0 ? selector : selector.slice(0, at);
}

/**
 * Every pnpm override of a pinned runtime dependency must raise older releases
 * to exactly the package.json version (`name@<version: version`), so the
 * development graph cannot keep a release below the published floor.
 * @param {Record<string, string>} overrides
 * @param {Record<string, string>} versions
 * @returns {string[]}
 */
export function pinnedOverrideErrors(overrides, versions) {
  /** @type {string[]} */
  const errors = [];
  for (const [selector, target] of Object.entries(overrides)) {
    const name = overridePackageName(selector);
    const version = versions[name];
    if (!version) continue;
    if (selector !== `${name}@<${version}` || target !== version) {
      errors.push(`pnpm-workspace.yaml override "${selector}: ${target}" must be "${name}@<${version}: ${version}" to match package.json`);
    }
  }
  return errors;
}
