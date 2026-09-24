import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Set by `tests/test-env.ts`, which every test file imports first. It keeps the
 * guard below active when a test file runs outside `node --test` (an IDE runner
 * or `node --import tsx tests/x.test.ts`).
 */
export const TEST_ISOLATION_ENV = "OPENCLAW_CODE_AGENT_TEST_ISOLATION";

/**
 * True only while running under `node:test`: a `node --test` child
 * (`NODE_TEST_CONTEXT`), an in-process `--test` run, or a process that loaded
 * `tests/test-env.ts`. The Gateway never sets any of these, so production
 * behavior is unchanged.
 */
export function isNodeTestRuntime(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): boolean {
  if (env.NODE_TEST_CONTEXT?.trim()) return true;
  if (env[TEST_ISOLATION_ENV] === "1") return true;
  return execArgv.some((arg) => arg === "--test" || arg.startsWith("--test="));
}

/** Resolve symlinks through the deepest existing ancestor so missing paths compare correctly. */
export function canonicalizePath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    missing.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(realpathSync.native(existing), ...missing);
  } catch {
    return absolute;
  }
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

let accountHomeOverride: string | undefined;

/** Lets the guard's own tests stand in a temporary "account home" so a regression cannot write real state. */
export const testStateGuardInternals = {
  setAccountHomeForTest(home: string | undefined): void {
    accountHomeOverride = home;
  },
};

/**
 * The OS account's own OpenClaw state dirs (`~/.openclaw`, legacy `~/.clawdbot`).
 * Uses the passwd home rather than `HOME`, so a test that points `HOME`
 * somewhere else is still compared against the real account.
 */
function realAccountStateDirs(): string[] {
  let home: string | undefined = accountHomeOverride;
  try {
    home ??= userInfo().homedir;
  } catch {
    return [];
  }
  if (!home) return [];
  return [join(home, ".openclaw"), join(home, ".clawdbot")].map(canonicalizePath);
}

/**
 * Defense in depth for test isolation: under `node:test`, refuse to write,
 * rename, or delete anything inside the real account's OpenClaw state dir.
 * A test that reaches this throws (and fails the run through `process.exitCode`
 * even when a best-effort caller swallows the error). No-op in production.
 */
export function assertTestSafeStatePath(path: string, operation: string): void {
  if (!isNodeTestRuntime()) return;
  const target = canonicalizePath(path);
  for (const stateDir of realAccountStateDirs()) {
    if (!isPathInside(stateDir, target)) continue;
    process.exitCode = 1;
    throw new Error(
      `[openclaw-code-agent] Refusing to ${operation} ${target} under node:test: it is inside the real OpenClaw state dir ${stateDir}. `
      + "Test files must import \"./test-env\" first so OPENCLAW_STATE_DIR points at a temporary directory.",
    );
  }
}
