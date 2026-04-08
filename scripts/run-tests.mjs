#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function collectTestFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

const cwd = process.cwd();
const requested = process.argv.slice(2)
  .filter((arg) => arg !== "--")
  .map((arg) => arg.trim())
  .filter(Boolean);

const files = (requested.length > 0 ? requested.map((file) => resolve(cwd, file)) : collectTestFiles(resolve(cwd, "tests")))
  .filter((file) => statSync(file).isFile())
  .sort();

if (files.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

const failures = [];
for (const file of files) {
  console.log(`\n==> ${file}`);
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", file], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    failures.push({ file, status: result.status ?? 1 });
  }
}

console.log(`\nTest files run: ${files.length}`);
if (failures.length === 0) {
  console.log("Status: PASS");
  process.exit(0);
}

console.error(`Status: FAIL (${failures.length} file${failures.length === 1 ? "" : "s"})`);
for (const failure of failures) {
  console.error(`- ${failure.file} (exit ${failure.status})`);
}
process.exit(1);
