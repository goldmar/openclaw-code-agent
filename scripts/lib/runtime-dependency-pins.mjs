// Runtime dependencies whose exact versions are security floors for npm
// consumers. npm ignores `overrides` from installed packages, so these must be
// direct, exact `dependencies` in package.json and resolve to exactly that
// version in npm-shrinkwrap.json.
//
// Two values per package, each in one place:
// - the pinned version: package.json `dependencies` (bumped freely);
// - the security floor: RUNTIME_SECURITY_FLOORS below, the lowest release that
//   carries the relevant advisory fixes. Raise it only for a new advisory; a
//   pin below its floor fails the checks even if the lock files agree.
// Every check reads these through this module:
// - scripts/check-npm-shrinkwrap.mjs (the manifest, the shrinkwrap, and the
//   matching pnpm-workspace.yaml overrides for the development graph)
// - scripts/verify-npm-consumer-install.mjs (the packed consumer install)
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Lowest acceptable release per pinned runtime dependency. */
export const RUNTIME_SECURITY_FLOORS = Object.freeze({
  "@hono/node-server": "2.1.1",
  "express-rate-limit": "8.7.0",
  "fast-uri": "3.1.8",
  hono: "4.13.7",
  "ip-address": "10.7.2",
  qs: "6.16.0",
});

export const PINNED_RUNTIME_DEPENDENCIES = Object.freeze(Object.keys(RUNTIME_SECURITY_FLOORS));

const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;

/**
 * Negative, zero, or positive as release `a` is older than, equal to, or newer than `b`.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareReleases(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * `{ name: version }` for every pinned runtime dependency, read from package.json.
 * Throws when a pin is missing, not an exact release, or below its security floor.
 * @param {{ dependencies?: Record<string, string> }} packageJson
 * @returns {Record<string, string>}
 */
export function pinnedRuntimeVersions(packageJson) {
  /** @type {Record<string, string>} */
  const versions = {};
  for (const [name, floor] of Object.entries(RUNTIME_SECURITY_FLOORS)) {
    const version = packageJson.dependencies?.[name];
    if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
      throw new Error(`package.json must declare exact runtime dependency ${name}, got ${version ?? "nothing"}`);
    }
    if (compareReleases(version, floor) < 0) {
      throw new Error(`package.json pins ${name}@${version}, below its security floor ${floor}`);
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
