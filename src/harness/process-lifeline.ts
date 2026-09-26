import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

/**
 * N27: a backend server that must not outlive the Gateway.
 *
 * `opencode serve` keeps running when its parent dies (it does not watch its
 * stdin), so a Gateway that is killed (SIGKILL, OOM, crash) would leave the
 * shared server and every tool process it started behind. Node cannot set a
 * parent-death signal, so the server runs under a tiny watchdog: a second
 * Node process (this same executable) that
 *
 * - is the leader of its own process group, so the server and its tool
 *   subprocesses are in that group too, and closing the server stops all of
 *   them (`process.kill(-pid)`), not only the direct child;
 * - reads its stdin, a pipe from the Gateway: when the Gateway exits for any
 *   reason the pipe closes and the watchdog terminates the whole group;
 * - forwards the server's stdout/stderr unchanged and exits with its status.
 *
 * The watchdog source is fixed; the server command and arguments are passed
 * as separate argv entries, never interpolated into code.
 */
const LIFELINE_SOURCE = [
  "const cp = require('node:child_process');",
  "const [command, ...args] = process.argv.slice(1);",
  "const child = cp.spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });",
  "let stopping = false;",
  "const stopGroup = () => {",
  "  if (stopping) return; stopping = true;",
  "  try { process.kill(-process.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }",
  "  setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 3000).unref();",
  "};",
  "process.on('SIGTERM', () => { if (!stopping) { stopping = true; child.kill('SIGTERM'); setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }, 3000).unref(); } });",
  "process.stdin.on('end', stopGroup); process.stdin.on('close', stopGroup); process.stdin.on('error', stopGroup); process.stdin.resume();",
  "child.on('error', (error) => { process.stderr.write(String(error && error.message || error) + '\\n'); process.exit(127); });",
  // Tool processes the server left in the group are asked to stop too.
  "child.on('exit', (code, signal) => { stopping = true; try { process.kill(-process.pid, 'SIGTERM'); } catch {} process.exit(code ?? (signal ? 128 : 1)); });",
].join("\n");

export interface LifelineChild {
  /** The watchdog process (group leader). Its stdout/stderr carry the server's output. */
  process: ChildProcessWithoutNullStreams;
  /** Stop the server and everything in its process group (TERM, then KILL after the grace period). */
  terminate(graceMs?: number): Promise<void>;
}

/** Whether the lifeline watchdog is available on this platform (POSIX process groups). */
export function lifelineSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Spawn `command args` under the lifeline watchdog. On platforms without
 * process groups the command is spawned directly (no watchdog).
 */
export function spawnWithLifeline(
  command: string,
  args: readonly string[],
  options: Omit<SpawnOptionsWithoutStdio, "stdio" | "detached">,
): LifelineChild {
  const supported = lifelineSupported();
  const child = (supported
    ? spawn(process.execPath, ["-e", LIFELINE_SOURCE, command, ...args], { ...options, detached: true, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] })) as ChildProcessWithoutNullStreams;
  // The lifeline pipe must never raise in the Gateway (EPIPE after the watchdog exited).
  child.stdin.on("error", () => undefined);
  const terminate = async (graceMs = 2_000): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      // The watchdog is gone; make sure nothing of its group survived it.
      if (supported) signalGroup(child.pid, "SIGKILL");
      return;
    }
    await new Promise<void>((resolve) => {
      let killTimer: NodeJS.Timeout | undefined;
      const done = (): void => {
        clearTimeout(forceTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve();
      };
      const forceTimer = setTimeout(() => {
        if (supported) signalGroup(child.pid, "SIGKILL");
        else child.kill("SIGKILL");
        killTimer = setTimeout(resolve, 1_000);
      }, graceMs);
      child.once("exit", () => {
        // Tool subprocesses of the server may still be running in the group.
        if (supported) signalGroup(child.pid, "SIGKILL");
        done();
      });
      if (supported) signalGroup(child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    });
  };
  return { process: child, terminate };
}
