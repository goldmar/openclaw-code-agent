import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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
  // Descendants of the live server too, for tools that cleared their environment.
  "const tree = () => { if (!alive()) return []; const kids = new Map(); let entries = []; try { entries = fs.readdirSync('/proc'); } catch { return []; }",
  "  for (const d of entries) { if (!/^\\d+$/.test(d)) continue; const st = statOf(d); if (!st) continue; const ppid = Number(st[1]); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(Number(d)); }",
  "  const out = []; const stack = [server]; while (stack.length) { for (const c of kids.get(stack.pop()) || []) { out.push(c); stack.push(c); } } return out; };",
  "const signal = (sig) => { const pids = new Set([...tree(), ...marked()]); if (alive()) { try { process.kill(-server, sig); } catch {} } for (const pid of pids) { try { process.kill(pid, sig); } catch {} } };",
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
 * Processes whose environment carries `NAME=value`, plus the live descendants
 * of `root` (tools that cleared their environment), from Linux `/proc` (empty
 * elsewhere). Read afresh for each signal, so a stale pid is never used, and
 * asynchronously, so a busy host does not stall the Gateway's event loop.
 */
export async function lifelinePids(name: string, value: string, root?: number): Promise<number[]> {
  let entries: string[];
  try {
    entries = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid);
  } catch {
    return [];
  }
  const marker = Buffer.from(`${name}=${value}\0`);
  const found = new Set<number>();
  const children = new Map<number, number[]>();
  const BATCH = 64;
  for (let index = 0; index < entries.length; index += BATCH) {
    await Promise.all(entries.slice(index, index + BATCH).map(async (entry) => {
      const pid = Number(entry);
      try {
        if ((await readFile(`/proc/${entry}/environ`)).includes(marker)) found.add(pid);
      } catch {
        // Exited, or not ours to read.
      }
      if (root === undefined) return;
      try {
        const stat = await readFile(`/proc/${entry}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        const list = children.get(ppid) ?? [];
        list.push(pid);
        children.set(ppid, list);
      } catch {
        // Exited meanwhile.
      }
    }));
  }
  if (root !== undefined) {
    const stack = [root];
    while (stack.length > 0) {
      for (const child of children.get(stack.pop()!) ?? []) {
        found.add(child);
        stack.push(child);
      }
    }
  }
  return [...found];
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
  const signalMarked = async (signal: NodeJS.Signals, withTree: boolean): Promise<void> => {
    if (!supported) return;
    signalPids(await lifelinePids(LIFELINE_ENV, marker, withTree ? child.pid : undefined), signal);
  };
  child.once("exit", () => {
    // Tool processes left in the server's group are stopped right away (the
    // only group signal after the leader exited, sent at once, since a pid is
    // not reused while a group of that id has members). Tools in groups of
    // their own are found by the watchdog, by marker, within a second.
    if (supported) signalGroup(child.pid, "SIGKILL");
  });
  child.once("error", stopWatchdog);

  const terminate = async (graceMs = 2_000): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      await signalMarked("SIGKILL", false);
      stopWatchdog();
      return;
    }
    // Collected before the server is signalled: its descendants are
    // reparented once it exits.
    const tools = supported && child.pid ? await lifelinePids(LIFELINE_ENV, marker, child.pid) : [];
    await new Promise<void>((resolve) => {
      let killTimer: NodeJS.Timeout | undefined;
      const forceTimer = setTimeout(() => {
        if (!(supported && signalGroup(child.pid, "SIGKILL"))) child.kill("SIGKILL");
        void signalMarked("SIGKILL", false);
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
    // Whatever still carries the marker (read afresh, so no stale pid).
    await signalMarked("SIGKILL", false);
    stopWatchdog();
  };
  return { process: child, terminate };
}
