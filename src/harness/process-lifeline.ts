import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

/**
 * N27: a backend server that must not outlive the Gateway.
 *
 * `opencode serve` keeps running when its parent dies (it does not watch its
 * stdin), and its shell tool starts commands in process groups of their own,
 * so a Gateway that is killed (SIGKILL, OOM, crash) or a server that exits
 * would leave the server and its tool processes behind. Node cannot set a
 * parent-death signal or become a child subreaper, so:
 *
 * - the server is spawned as the leader of its own process group, with a
 *   random marker in its environment (`OPENCLAW_CODE_AGENT_LIFELINE`), which
 *   every process it starts inherits, whatever group it moves to;
 * - stopping the server signals its group and, on Linux, every process whose
 *   environment carries the marker (found in `/proc/<pid>/environ` at the
 *   moment of each signal, so no stale pid is ever reused);
 * - a tiny watchdog (a second process of this Node executable, which starts
 *   nothing itself) holds a pipe from the Gateway on its stdin. When the
 *   Gateway exits for any reason the pipe closes, and the watchdog stops the
 *   group and the marked processes. It also does so once the server itself
 *   has exited, for tools that outlived it.
 *
 * Elsewhere (macOS) only the process group is signalled: a tool that moved to
 * a process group of its own is not found there.
 */
export const LIFELINE_ENV = "OPENCLAW_CODE_AGENT_LIFELINE";

const WATCHDOG_SOURCE = [
  "const fs = require('node:fs');",
  "const server = Number(process.argv[1]);",
  "const marker = Buffer.from(process.argv[2] + '\\u0000');",
  "const statOf = (pid) => { try { const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return st.slice(st.lastIndexOf(')') + 2).split(' '); } catch { return undefined; } };",
  "const serverStart = (statOf(server) || [])[19];",
  // The server is alive only while its pid still names the process started then.
  "const alive = () => serverStart !== undefined && (statOf(server) || [])[19] === serverStart;",
  "const marked = () => { let entries = []; try { entries = fs.readdirSync('/proc'); } catch { return []; } const out = [];",
  "  for (const d of entries) { if (!/^\\d+$/.test(d) || Number(d) === process.pid) continue; try { if (fs.readFileSync('/proc/' + d + '/environ').includes(marker)) out.push(Number(d)); } catch {} } return out; };",
  "const signal = (sig) => { if (alive()) { try { process.kill(-server, sig); } catch {} } for (const pid of marked()) { try { process.kill(pid, sig); } catch {} } };",
  "let stopping = false;",
  "const stop = () => {",
  "  if (stopping) return; stopping = true;",
  "  signal('SIGTERM');",
  "  setTimeout(() => { signal('SIGKILL'); process.exit(0); }, 3000);",
  "};",
  // Once the server has exited, stop whatever it left behind, then exit.
  "setInterval(() => { if (!stopping && !alive()) stop(); }, 1000);",
  // The Gateway's end of this pipe closes when the Gateway exits, for any reason.
  "process.stdin.on('end', stop); process.stdin.on('close', stop); process.stdin.on('error', stop);",
  "process.stdin.resume();",
].join("\n");

export interface LifelineChild {
  /** The server process (leader of its own process group). */
  process: ChildProcessWithoutNullStreams;
  /** Stop the server and every process it started (TERM, then KILL after the grace period). */
  terminate(graceMs?: number): Promise<void>;
}

/** Whether process groups and the watchdog are available on this platform (POSIX). */
export function lifelineSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/**
 * Processes whose environment carries `NAME=value` (Linux `/proc`; empty
 * elsewhere). Read afresh for each signal, so a pid is never reused stale.
 */
export function markedPids(name: string, value: string): number[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const marker = Buffer.from(`${name}=${value}\0`);
  const out: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${entry}/environ`).includes(marker)) out.push(Number(entry));
    } catch {
      // Exited, or not ours to read.
    }
  }
  return out;
}

function signalPids(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
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

function startWatchdog(server: number, marker: string): ChildProcess | undefined {
  try {
    const watchdog = spawn(process.execPath, ["-e", WATCHDOG_SOURCE, String(server), `${LIFELINE_ENV}=${marker}`], {
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
  const marker = randomBytes(16).toString("hex");
  const child = spawn(command, [...args], {
    ...options,
    env: { ...(options.env ?? process.env), [LIFELINE_ENV]: marker },
    detached: supported,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as ChildProcessWithoutNullStreams;
  const watchdog = supported && child.pid ? startWatchdog(child.pid, marker) : undefined;
  const stopWatchdog = (): void => {
    if (watchdog && watchdog.exitCode === null && watchdog.signalCode === null) watchdog.kill("SIGKILL");
  };
  const signalMarked = (signal: NodeJS.Signals): void => {
    if (supported) signalPids(markedPids(LIFELINE_ENV, marker), signal);
  };
  child.once("exit", () => {
    // Tool processes the server left behind are stopped right away: its group
    // (the only group signal after the leader exited, sent at once, since a
    // pid is not reused while a group of that id has members) and every
    // process carrying its marker. The watchdog repeats this a second later
    // for tools that were still starting, then exits by itself.
    if (!supported) return;
    signalGroup(child.pid, "SIGKILL");
    signalMarked("SIGKILL");
  });
  child.once("error", stopWatchdog);

  const terminate = async (graceMs = 2_000): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      signalMarked("SIGKILL");
      stopWatchdog();
      return;
    }
    await new Promise<void>((resolve) => {
      let killTimer: NodeJS.Timeout | undefined;
      const forceTimer = setTimeout(() => {
        if (!(supported && signalGroup(child.pid, "SIGKILL"))) child.kill("SIGKILL");
        signalMarked("SIGKILL");
        killTimer = setTimeout(resolve, 1_000);
      }, graceMs);
      child.once("exit", () => {
        clearTimeout(forceTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve();
      });
      if (!(supported && signalGroup(child.pid, "SIGTERM"))) child.kill("SIGTERM");
      signalMarked("SIGTERM");
    });
    stopWatchdog();
  };
  return { process: child, terminate };
}
