import { execFile, type ChildProcess } from "node:child_process";
import { processShared } from "./process-runtime";

/**
 * Async `git` / `gh` execution for the worktree layer.
 *
 * Commands always run from an argument array (never a shell string), with an
 * explicit timeout, UTF-8 output, and the Gateway's inherited environment, the
 * same contract the previous `execFileSync` calls had. stdin is closed right
 * away (after an optional `input` payload) so a command that unexpectedly
 * reads it sees EOF instead of hanging.
 * A non-zero exit rejects with Node's `Command failed: <cmd>\n<stderr>` error;
 * a timeout rejects with a `timed out` error after the child is killed.
 */
export interface CommandOptions {
  /** Working directory; defaults to the Gateway process cwd. */
  cwd?: string;
  /** Hard timeout in milliseconds. */
  timeout: number;
  /** Optional stdin payload; otherwise stdin is closed immediately. */
  input?: string;
}

export type CommandError = Error & {
  code?: number | string | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
};

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function settleCommand(
  label: string,
  args: readonly string[],
  options: CommandOptions,
  resolve: (stdout: string) => void,
  reject: (error: CommandError) => void,
): ExecFileCallback {
  return (error, stdout, stderr) => {
    if (!error) {
      resolve(stdout);
      return;
    }
    const failure = error as CommandError;
    failure.stdout = stdout;
    failure.stderr = stderr;
    if (failure.killed && failure.signal) {
      failure.message = `Command timed out after ${options.timeout} ms: ${[label, ...args].join(" ")}`;
    }
    reject(failure);
  };
}

function execOptions(options: CommandOptions) {
  return { cwd: options.cwd, timeout: options.timeout, encoding: "utf-8", maxBuffer: 1024 * 1024, windowsHide: true } as const;
}

function closeStdin(child: ChildProcess, input: string | undefined): void {
  // A command can exit before reading its input; the resulting EPIPE must not
  // become an unhandled stream error. The exit status still reports the failure.
  child.stdin?.on("error", () => {});
  child.stdin?.end(input);
}

// The executable is a string literal at each call site (no shell, fixed binary):
// OCA only ever runs `git` and `gh` from this module.
export function runGit(args: readonly string[], options: CommandOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", [...args], execOptions(options), settleCommand("git", args, options, resolve, reject));
    closeStdin(child, options.input);
  });
}

export function runGh(args: readonly string[], options: CommandOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("gh", [...args], execOptions(options), settleCommand("gh", args, options, resolve, reject));
    closeStdin(child, options.input);
  });
}

// Process-wide so every plugin registry's module graph serializes on the same lock.
const repoTails = processShared("git-repo-locks.v1", () => new Map<string, Promise<void>>());

/**
 * Serialize mutating git sequences (worktree add/remove, checkout, merge,
 * branch deletion) per repository. The synchronous implementation got this
 * for free by blocking the event loop; async callers must not interleave two
 * multi-step sequences against the same checkout.
 */
export function withRepoLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoTails.get(repoDir) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  const tail = next.then(() => {}, () => {});
  repoTails.set(repoDir, tail);
  void tail.then(() => {
    if (repoTails.get(repoDir) === tail) repoTails.delete(repoDir);
  });
  return next;
}
