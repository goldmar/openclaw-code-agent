/**
 * Hermetic test environment. Every `tests/**\/*.test.ts` file imports this
 * module first (`import "./test-env";`, enforced by
 * `scripts/check-static-guardrails.mjs`), so a test file cannot reach the real
 * OpenClaw state however it is started: `pnpm test`, `pnpm test:file`,
 * `node --import tsx --test tests/x.test.ts`, plain `node --import tsx
 * tests/x.test.ts`, or an IDE runner.
 *
 * Static imports run before this module body, so only Node built-ins and the
 * dependency-free guard module are imported here.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTestSafeStatePath, canonicalizePath, isPathInside, TEST_ISOLATION_ENV } from "../src/test-state-guard";

const env = process.env;
const systemTempDir = canonicalizePath(tmpdir());

function isInsideSystemTempDir(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  const candidate = canonicalizePath(trimmed);
  return candidate !== systemTempDir && isPathInside(systemTempDir, candidate);
}

// `scripts/run-tests.mjs` already gives each file a fresh temp home; keep it so
// the runner can remove it. Anything else (unset, or pointing at a real home)
// gets a fresh temp home that is removed when the process exits.
function ensureHermeticHome(): string {
  const existing = env.OPENCLAW_HOME?.trim();
  if (existing && isInsideSystemTempDir(existing) && isInsideSystemTempDir(env.OPENCLAW_STATE_DIR)) return existing;
  const created = mkdtempSync(join(tmpdir(), "openclaw-code-agent-test-home-"));
  env.OPENCLAW_HOME = created;
  env.OPENCLAW_STATE_DIR = join(created, ".openclaw");
  process.once("exit", () => {
    rmSync(created, { recursive: true, force: true });
  });
  return created;
}

const testHome = ensureHermeticHome();

// Explicit OCA store paths outside the temp dir would bypass OPENCLAW_STATE_DIR.
for (const name of ["OPENCLAW_CODE_AGENT_SESSIONS_PATH", "OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH"] as const) {
  if (env[name]?.trim() && !isInsideSystemTempDir(env[name])) delete env[name];
}

// Output cleanup also scans the OS temp dir for pre-5.0 output files, which
// can belong to a real Gateway. Give each test process its own temp dir.
const hermeticTempDir = join(testHome, "tmp");
mkdirSync(hermeticTempDir, { recursive: true });
env.TMPDIR = hermeticTempDir;
env.TMP = hermeticTempDir;
env.TEMP = hermeticTempDir;

env[TEST_ISOLATION_ENV] = "1";

// Fail fast if the result still points at the real account state.
assertTestSafeStatePath(env.OPENCLAW_STATE_DIR ?? testHome, "use the state dir");
