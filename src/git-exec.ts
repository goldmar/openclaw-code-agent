import { execFile } from "node:child_process";

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

function runCommand(file: "git" | "gh", args: readonly string[], options: CommandOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { cwd: options.cwd, timeout: options.timeout, encoding: "utf-8", maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const failure = error as CommandError;
        failure.stdout = stdout;
        failure.stderr = stderr;
        if (failure.killed && failure.signal) {
          failure.message = `Command timed out after ${options.timeout} ms: ${[file, ...args].join(" ")}`;
        }
        reject(failure);
      },
    );
    child.stdin?.end(options.input);
  });
}

export function runGit(args: readonly string[], options: CommandOptions): Promise<string> {
  return runCommand("git", args, options);
}

export function runGh(args: readonly string[], options: CommandOptions): Promise<string> {
  return runCommand("gh", args, options);
}

const repoTails = new Map<string, Promise<void>>();

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
