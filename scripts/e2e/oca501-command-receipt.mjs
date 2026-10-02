// Command receipts for the issue-501 acceptance harness. No host/backend shim.
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";

function identity(pid) {
  try {
    return { executable: realpathSync(`/proc/${pid}/exe`), startTicks: readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ")[19] };
  } catch { return undefined; }
}

export async function captureCommand(command, args, { cwd, env, timeoutMs = 180_000, drainGraceMs = 5000, track = () => {}, untrack = () => {} } = {}) {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  track(child);
  const stdout = []; const stderr = []; const errors = [];
  let disposition; let owned; let timedOut = false; let forcedPipeClose = false; let closeObserved = false; let grace;
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.once("spawn", () => { owned = identity(child.pid); });
  const result = await new Promise((done) => {
    let settled = false;
    const finish = () => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(grace);
      // Decode once after the actual stream boundary, not once per chunk.
      done({ exit: disposition ?? { code: null, signal: null }, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), closeObserved, streamsComplete: closeObserved && !forcedPipeClose, timedOut, errors });
    };
    child.once("error", (error) => { disposition ??= { code: null, signal: null, spawnError: error.stack ?? String(error) }; });
    child.once("exit", (code, signal) => { disposition ??= { code, signal }; });
    child.once("close", (code, signal) => { closeObserved = true; disposition ??= { code, signal }; finish(); });
    const timer = setTimeout(() => {
      timedOut = true;
      // A reaped leader's old PGID is never cleanup authority. Signal only
      // this still-live leader instance; post-exit inherited pipes just drain.
      const current = child.exitCode === null && child.signalCode === null ? identity(child.pid) : undefined;
      if (owned && current && current.executable === owned.executable && current.startTicks === owned.startTicks) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { errors.push(`Owned command timeout cleanup: ${String(error)}`); }
      } else errors.push("Command timeout: no still-verified leader/group authority; no signal sent");
      grace = setTimeout(() => {
        forcedPipeClose = true;
        errors.push("Command stdio did not close within bounded drain grace; received bytes are incomplete");
        // Close only our local read handles, never an unowned/reassigned PGID.
        child.stdout.destroy(); child.stderr.destroy(); finish();
      }, drainGraceMs);
    }, timeoutMs);
  });
  // Leave a genuinely still-live incomplete child under the caller's owned
  // cleanup. An exited leader supplies no process authority to retain/reuse.
  if (closeObserved || child.exitCode !== null || child.signalCode !== null || result.exit.spawnError) untrack(child);
  return result;
}
