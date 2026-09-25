#!/usr/bin/env node
// Line/branch/function coverage of src/ for the full test suite (or given test files).
//
// Usage: pnpm coverage [tests/foo.test.ts ...]
//
// Runs scripts/run-tests.mjs with NODE_V8_COVERAGE set, so every per-file test
// process writes V8 coverage (source-mapped from the tsx-transpiled TypeScript),
// then renders it with c8 (pinned; fetched by `pnpm dlx`, not a project
// dependency): a per-file table and totals on stdout, plus
// coverage/coverage-summary.json and coverage/lcov.info. Generated Codex
// protocol types are excluded. Reporting only: nothing is gated on it, and
// test failures are reported but do not stop the report.
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const C8 = "c8@10.1.3";
const cwd = process.cwd();
const reportDir = resolve(cwd, "coverage");
const rawDir = resolve(reportDir, ".v8");
rmSync(reportDir, { recursive: true, force: true });
mkdirSync(rawDir, { recursive: true });

const tests = spawnSync(process.execPath, ["scripts/run-tests.mjs", ...process.argv.slice(2)], {
  cwd,
  stdio: "inherit",
  env: { ...process.env, NODE_V8_COVERAGE: rawDir },
});

const report = spawnSync("pnpm", [
  "dlx", C8, "report",
  "--temp-directory", rawDir,
  "--report-dir", reportDir,
  "--reporter=text",
  "--reporter=json-summary",
  "--reporter=lcovonly",
  "--all",
  "--src", "src",
  "--extension", ".ts",
  "--include", "src/**",
  "--exclude", "src/harness/codex-app-server-protocol/**",
], { cwd, stdio: "inherit" });
rmSync(rawDir, { recursive: true, force: true });

if (tests.status !== 0) console.error(`\nSome tests failed (exit ${tests.status}); coverage covers the tests that ran.`);
console.log(`\nCoverage report: ${reportDir}/coverage-summary.json, ${reportDir}/lcov.info`);
process.exit(report.status ?? 1);
