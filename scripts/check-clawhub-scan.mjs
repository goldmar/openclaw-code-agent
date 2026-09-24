#!/usr/bin/env node
// Runs ClawHub's static moderation scan (vendored from openclaw/clawhub, see
// scripts/vendor/clawhub-moderation-engine.mjs) against the exact file set
// `npm pack` would publish, and fails on any finding. By default dist/ must
// already be built (the pack listing uses --ignore-scripts so it never
// rebuilds); `--tarball=<file>` scans an already packed artifact instead,
// which the release workflow uses on the exact tarball it publishes.
//
// Two explicit guards back the scan up, independent of its heuristics:
// - `fetch(` may appear only in the npm release-client chunk;
// - no packed file may combine `process.env` with a network call (that
//   combination was flagged as env_credential_access before 4.7.7).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runStaticModerationScan } from "./vendor/clawhub-moderation-engine.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const rootDir = resolve(dirname(scriptPath), "..");

const TEXT_FILE_PATTERN = /\.(?:[cm]?js|json|md|txt|ya?ml|sh|ts)$|(?:^|\/)LICENSE$/u;
const FETCH_ALLOWED_PATTERN = /^dist\/chunks\/npm-release-client-[^/]+\.js$/u;
const FETCH_CALL_PATTERN = /\bfetch\s*\(/u;
const NETWORK_CALL_PATTERN = /\bfetch\s*\(|\bhttps?\.(?:request|get)\s*\(|\bnew\s+WebSocket\s*\(|\bXMLHttpRequest\b|\bnet\.connect\s*\(/u;
const ENV_ACCESS_PATTERN = /\bprocess\.env\b/u;

export function listPackedFiles(baseDir = rootDir) {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: baseDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const packed = JSON.parse(output);
  const files = Array.isArray(packed) ? packed[0]?.files : packed?.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error("npm pack --dry-run returned no files");
  return files.map((file) => file.path);
}

export function readPackedTextFiles(paths, baseDir = rootDir) {
  return paths
    .filter((path) => TEXT_FILE_PATTERN.test(path))
    .map((path) => ({ path, content: readFileSync(join(baseDir, path), "utf8") }));
}

/** ClawHub's own static scan result for the packed files. */
export function scanPackedFiles(fileContents, { packageJson, pluginManifest }) {
  return runStaticModerationScan({
    slug: packageJson.name,
    displayName: pluginManifest.name,
    summary: packageJson.description,
    frontmatter: {},
    metadata: { packageJson, pluginManifest },
    files: fileContents.map((file) => ({ path: file.path, size: Buffer.byteLength(file.content) })),
    fileContents,
  });
}

/** OCA's explicit network guards; returns human-readable problems. */
export function findNetworkGuardViolations(fileContents) {
  const problems = [];
  for (const file of fileContents) {
    if (!/\.[cm]?js$/u.test(file.path)) continue;
    if (FETCH_CALL_PATTERN.test(file.content) && !FETCH_ALLOWED_PATTERN.test(file.path)) {
      problems.push(`${file.path}: fetch( outside the npm release-client chunk`);
    }
    if (ENV_ACCESS_PATTERN.test(file.content) && NETWORK_CALL_PATTERN.test(file.content)) {
      problems.push(`${file.path}: process.env and a network call in the same file`);
    }
  }
  return problems;
}

export function checkPackedFiles(fileContents, metadata) {
  const scan = scanPackedFiles(fileContents, metadata);
  const problems = [
    ...(scan.findings ?? []).map((finding) =>
      `${finding.code} (${finding.severity}) ${finding.file}:${finding.line} ${finding.message}`),
    ...(scan.status !== "clean" && (scan.findings ?? []).length === 0
      ? [`scan status ${scan.status}: ${scan.reasonCodes.join(", ")}`]
      : []),
    ...findNetworkGuardViolations(fileContents),
  ];
  return { scan, problems };
}

function listFilesRecursive(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFilesRecursive(path) : [path];
  });
}

/**
 * Extract a packed tarball (`npm pack` output) and return its file paths
 * relative to the package root, plus the extracted root and a cleanup hook.
 */
export function extractPackedTarball(tarballPath) {
  const tempDir = mkdtempSync(join(tmpdir(), "oca-clawhub-scan-"));
  execFileSync("tar", ["-xzf", resolve(tarballPath), "-C", tempDir], { stdio: ["ignore", "pipe", "pipe"] });
  const packageDir = join(tempDir, "package");
  return {
    packageDir,
    paths: listFilesRecursive(packageDir).map((path) => relative(packageDir, path).split("\\").join("/")),
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

function reportAndExit(scan, problems, fileCount, label) {
  if (problems.length > 0) {
    console.error(`ClawHub static scan (${scan.engineVersion}) found problems in ${label}:`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ClawHub static scan (${scan.engineVersion}) is clean for ${fileCount} files in ${label}.`);
}

function main() {
  const tarballArg = process.argv.slice(2).find((arg) => arg.startsWith("--tarball="))?.slice("--tarball=".length);
  if (tarballArg) {
    // Release mode: scan the exact artifact that will be published.
    const extracted = extractPackedTarball(tarballArg);
    try {
      const packageJson = JSON.parse(readFileSync(join(extracted.packageDir, "package.json"), "utf8"));
      const pluginManifest = JSON.parse(readFileSync(join(extracted.packageDir, "openclaw.plugin.json"), "utf8"));
      const fileContents = readPackedTextFiles(extracted.paths, extracted.packageDir);
      const { scan, problems } = checkPackedFiles(fileContents, { packageJson, pluginManifest });
      reportAndExit(scan, problems, fileContents.length, tarballArg);
    } finally {
      extracted.cleanup();
    }
    return;
  }
  const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
  const pluginManifest = JSON.parse(readFileSync(join(rootDir, "openclaw.plugin.json"), "utf8"));
  const paths = listPackedFiles();
  if (!paths.some((path) => path.startsWith("dist/"))) {
    throw new Error("Packed file list has no dist/ files; run pnpm build first");
  }
  const fileContents = readPackedTextFiles(paths);
  const { scan, problems } = checkPackedFiles(fileContents, { packageJson, pluginManifest });
  reportAndExit(scan, problems, fileContents.length, "the packed plugin");
}

if (process.argv[1] === scriptPath) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
