import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

/**
 * N27: a backend server that must not outlive the Gateway.
 *
 * `opencode serve` keeps running when its parent dies (it does not watch its
 * stdin), so a Gateway that is killed (SIGKILL, OOM, crash) would leave the
 * shared server and every tool process it started behind. Node cannot set a
 * parent-death signal, so:
 *
 * - the server is spawned as the leader of its own process group; its tool
 *   subprocesses join that group, and closing the server signals the whole
 *   group (`process.kill(-pid)`), not only the direct child;
 * - a tiny watchdog (a second process of this Node executable) holds a pipe
 *   from the Gateway on its stdin. When the Gateway exits for any reason the
 *   pipe closes, and the watchdog terminates the server's process group. The
 *   watchdog starts nothing itself: its fixed source only signals the group
 *   id it was given.
 */
const WATCHDOG_SOURCE = [
  "const group = Number(process.argv[1]);",
  "let stopping = false;",
  "const stop = () => {",
  "  if (stopping) return; stopping = true;",
  "  try { process.kill(-group, 'SIGTERM'); } catch {}",
  "  setTimeout(() => { try { process.kill(-group, 'SIGKILL'); } catch {} process.exit(0); }, 3000);",
  "};",
  "process.stdin.on('end', stop); process.stdin.on('close', stop); process.stdin.on('error', stop);",
  "process.stdin.resume();",
].join("\n");

export interface LifelineChild {
  /** The server process (leader of its own process group). */
  process: ChildProcessWithoutNullStreams;
  /** Stop the server and everything in its process group (TERM, then KILL after the grace period). */
  terminate(graceMs?: number): Promise<void>;
}

/** Whether process groups and the watchdog are available on this platform (POSIX). */
export function lifelineSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false; // The group is already gone.
  }
}

function startWatchdog(group: number): ChildProcess | undefined {
  try {
    const watchdog = spawn(process.execPath, ["-e", WATCHDOG_SOURCE, String(group)], {
      // Its own group, so signals for the server's group (or the Gateway's) never reach it.
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    watchdog.on("error", () => undefined);
    watchdog.stdin?.on("error", () => undefined);
    // Neither the watchdog nor its pipe keeps the Gateway's event loop alive.
    watchdog.unref();
    (watchdog.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    return watchdog;
  } catch {
    return undefined;
  }
}

/**
 * Spawn `command args` in its own process group with a parent-death watchdog.
 * On platforms without process groups the command is spawned directly.
 */
export function spawnWithLifeline(
  command: string,
  args: readonly string[],
  options: Omit<SpawnOptionsWithoutStdio, "stdio" | "detached">,
): LifelineChild {
  const supported = lifelineSupported();
  const child = spawn(command, [...args], {
    ...options,
    detached: supported,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as ChildProcessWithoutNullStreams;
  const watchdog = supported && child.pid ? startWatchdog(child.pid) : undefined;
  const stopWatchdog = (): void => {
    if (watchdog && watchdog.exitCode === null && watchdog.signalCode === null) watchdog.kill("SIGKILL");
  };
  // Once the server has exited its pid (the group id) may be reused, so the
  // group is only ever signalled while the server is still running.
  child.once("exit", stopWatchdog);
  child.once("error", stopWatchdog);

  const terminate = async (graceMs = 2_000): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      stopWatchdog();
      return;
    }
    await new Promise<void>((resolve) => {
      let killTimer: NodeJS.Timeout | undefined;
      const forceTimer = setTimeout(() => {
        if (!(supported && signalGroup(child.pid, "SIGKILL"))) child.kill("SIGKILL");
        killTimer = setTimeout(resolve, 1_000);
      }, graceMs);
      child.once("exit", () => {
        clearTimeout(forceTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve();
      });
      if (!(supported && signalGroup(child.pid, "SIGTERM"))) child.kill("SIGTERM");
    });
    stopWatchdog();
  };
  return { process: child, terminate };
}
