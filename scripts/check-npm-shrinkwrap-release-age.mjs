#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { validateSecurityExceptions } from "./check-release-age-exceptions.mjs";

const rootUrl = new URL("../", import.meta.url);
const quarantineMs = 24 * 60 * 60 * 1000;

function packageNameFromLockPath(lockPath) {
  const marker = "node_modules/";
  const offset = lockPath.lastIndexOf(marker);
  return offset < 0 ? null : lockPath.slice(offset + marker.length);
}

export function collectPublishedPackages(shrinkwrap) {
  const packages = new Map();
  for (const [lockPath, metadata] of Object.entries(shrinkwrap.packages ?? {})) {
    const name = packageNameFromLockPath(lockPath);
    const version = metadata?.version;
    if (!name || typeof version !== "string" || metadata.link === true) continue;
    const versions = packages.get(name) ?? new Set();
    versions.add(version);
    packages.set(name, versions);
  }
  return packages;
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(values[index]);
      }
    }),
  );
  return results;
}

export async function findTooNewPackages({ packages, now = new Date(), fetchImpl = fetch }) {
  const entries = [...packages.entries()];
  const nested = await mapWithConcurrency(entries, 12, async ([name, versions]) => {
    const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    if (!response.ok) {
      throw new Error(`npm registry metadata failed for ${name}: HTTP ${response.status}`);
    }
    const metadata = await response.json();
    return [...versions].flatMap((version) => {
      const published = Date.parse(metadata.time?.[version] ?? "");
      if (!Number.isFinite(published)) {
        throw new Error(`npm registry metadata has no publication time for ${name}@${version}`);
      }
      return now.getTime() - published < quarantineMs
        ? [{ package: `${name}@${version}`, published: metadata.time[version] }]
        : [];
    });
  });
  return nested.flat();
}

async function main() {
  const [shrinkwrapSource, workspaceSource] = await Promise.all([
    readFile(new URL("npm-shrinkwrap.json", rootUrl), "utf8"),
    readFile(new URL("pnpm-workspace.yaml", rootUrl), "utf8"),
  ]);
  const exceptions = validateSecurityExceptions(workspaceSource);
  const allowed = new Set(exceptions.map((exception) => exception.package));
  const tooNew = (await findTooNewPackages({
    packages: collectPublishedPackages(JSON.parse(shrinkwrapSource)),
  })).filter((entry) => !allowed.has(entry.package));
  if (tooNew.length > 0) {
    throw new Error(
      `npm-shrinkwrap.json bypasses the 24-hour minimum-release-age policy:\n${tooNew
        .map((entry) => `- ${entry.package} published ${entry.published}`)
        .join("\n")}`,
    );
  }
  console.log("npm shrinkwrap passes the 24-hour minimum-release-age policy");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
