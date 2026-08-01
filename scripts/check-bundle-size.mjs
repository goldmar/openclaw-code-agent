import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const DEFAULT_BUNDLE_LIMIT_BYTES = 600 * 1024;

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(path) : entry.isFile() ? [path] : [];
  });
}

function displayPath(path) {
  return path.split(sep).join("/");
}

function formatKb(bytes) {
  return (bytes / 1024).toFixed(1);
}

export function createBundleSizeReport(distDir = "dist", maxSizeBytes = DEFAULT_BUNDLE_LIMIT_BYTES) {
  const files = collectFiles(distDir)
    .map((path) => ({
      path: displayPath(join(distDir, relative(distDir, path))),
      sizeBytes: statSync(path).size,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  if (files.length === 0) {
    throw new Error(`Build artifact directory is empty: ${distDir}`);
  }

  const sizeBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  const sizeKb = formatKb(sizeBytes);
  const limitKb = formatKb(maxSizeBytes);
  const overLimit = sizeBytes > maxSizeBytes;
  const status = overLimit ? "❌ EXCEEDS LIMIT" : "✅ Within limit";
  const rows = files.map((file) => `| \`${file.path}\` | ${formatKb(file.sizeBytes)} KB |`);
  const body = [
    "## Bundle Size Report",
    "",
    "| Runtime file | Size |",
    "|--------------|------|",
    ...rows,
    `| **Total** | **${sizeKb} KB** |`,
    "",
    `| Limit | Status |`,
    `|-------|--------|`,
    `| ${limitKb} KB | ${status} |`,
    "",
    overLimit
      ? `> ⚠️ **Complete bundle exceeds the ${limitKb} KB limit.** Please reduce bundle size before merging.`
      : `> Complete bundle is within the ${limitKb} KB limit.`,
  ].join("\n");

  return { body, files, maxSizeBytes, overLimit, sizeBytes, sizeKb };
}
