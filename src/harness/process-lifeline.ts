import { readdirSync, readFileSync } from "node:fs";
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
  "const fs = require('node:fs');",
  "const server = Number(process.argv[1]);",
  // pid -> start time for the server's descendants. Tool processes may lead
  // process groups of their own (OpenCode's shell tool does), and once the
  // server exits they are reparented, so they are tracked while it runs.
  "const startTime = (pid) => { try { const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return st.slice(st.lastIndexOf(')') + 2).split(' ')[19]; } catch { return undefined; } };",
  "const tree = () => { const kids = new Map(); let entries = []; try { entries = fs.readdirSync('/proc'); } catch { return new Map(); }",
  "  for (const d of entries) { if (!/^\\d+$/.test(d)) continue; try { const st = fs.readFileSync('/proc/' + d + '/stat', 'utf8'); const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(Number(d)); } catch {} }",
  "  const out = new Map(); const stack = [server]; while (stack.length) { for (const c of kids.get(stack.pop()) || []) { const t = startTime(c); if (t) out.set(c, t); stack.push(c); } } return out; };",
  "let known = new Map();",
  "const serverStart = startTime(server);",
  // The server is alive only while its pid still names the process started then.
  "const alive = () => serverStart !== undefined && startTime(server) === serverStart;",
  // Only processes that are still the ones recorded (same start time) are signalled.
  "const signal = (sig) => { if (alive()) { try { process.kill(-server, sig); } catch {} } for (const [pid, t] of known) { if (startTime(pid) === t) { try { process.kill(pid, sig); } catch {} } } };",
  "let stopping = false;",
  "const stop = () => {",
  "  if (stopping) return; stopping = true;",
  "  if (alive()) known = new Map([...known, ...tree()]);",
  "  signal('SIGTERM');",
  "  setTimeout(() => { signal('SIGKILL'); process.exit(0); }, 3000);",
  "};",
  // While the server runs, refresh its tree; once it is gone, stop what it left.
  "setInterval(() => { if (stopping) return; if (alive()) { known = tree(); return; } stop(); }, 1000);",
  // The Gateway's end of this pipe closes when the Gateway exits, for any reason.
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

/**
 * Every descendant of `root` (Linux `/proc`; empty elsewhere). Tool processes
 * can lead process groups of their own, so signalling the server's group
 * alone would miss them.
 */
export function descendantPids(root: number): number[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const list = children.get(ppid) ?? [];
      list.push(Number(entry));
      children.set(ppid, list);
    } catch {
      // The process exited while we looked.
    }
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()!) ?? []) {
      out.push(child);
      stack.push(child);
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
  child.once("exit", () => {
    // Tool processes the server left in its group are stopped right away.
    // This is the only group signal sent after the leader exited, and it is
    // sent at once: Linux does not reuse a pid while a process group of that
    // id still has members, and an empty group just fails the call (ESRCH).
    // Tools in groups of their own are stopped by the watchdog, which tracked
    // the server's process tree and exits by itself afterwards.
    if (supported) signalGroup(child.pid, "SIGKILL");
    if (!supported) stopWatchdog();
  });
  child.once("error", stopWatchdog);

  const terminate = async (graceMs = 2_000): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      stopWatchdog();
      return;
    }
    // Collected while the server still runs: its tools may lead groups of their own.
    const tools = supported && child.pid ? descendantPids(child.pid) : [];
    await new Promise<void>((resolve) => {
      let killTimer: NodeJS.Timeout | undefined;
      const forceTimer = setTimeout(() => {
        if (!(supported && signalGroup(child.pid, "SIGKILL"))) child.kill("SIGKILL");
        signalPids(tools, "SIGKILL");
        killTimer = setTimeout(resolve, 1_000);
      }, graceMs);
      child.once("exit", () => {
        clearTimeout(forceTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve();
      });
      if (!(supported && signalGroup(child.pid, "SIGTERM"))) child.kill("SIGTERM");
      signalPids(tools, "SIGTERM");
    });
    stopWatchdog();
  };
  return { process: child, terminate };
}
