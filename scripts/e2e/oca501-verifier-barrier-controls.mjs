import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installVerifierBarrier, ORDERED_SUITE, parseVerifierEvents, verifierEvents, processIdentity, heldVerifier, assertSameHeldVerifier, releaseVerifier } from "./oca501-verifier-barrier.mjs";

const started = performance.now(); let groups = 0, negatives = 0;
const deny = (fn) => { assert.throws(fn); negatives++; };
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(probe) { const until = Date.now() + 5000; while (Date.now() < until) { const value = probe(); if (value) return value; await delay(10); } throw new Error("Owned shell component control timed out"); }
const owned = [], children = [];
const scratch = resolve(dirname(fileURLToPath(import.meta.url)), "../../.artifacts");
try { mkdirSync(scratch, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
assert.ok(lstatSync(scratch).isDirectory() && !lstatSync(scratch).isSymbolicLink() && lstatSync(scratch).uid === process.getuid());
const create = (ordinal) => { const directory = mkdtempSync(join(scratch, "oca501-h08-component-")); owned.push(directory); return installVerifierBarrier(directory, ordinal); };
const groupId = (pid) => { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[2]); };
function ownChild(child) {
  const record = { child, terminal: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))) };
  children.push(record); try { record.instance = processIdentity(child.pid); assert.equal(groupId(child.pid), child.pid); } catch { /* A short child may already be terminal; it receives no unproved signal. */ }
  return record;
}
const run = (fixture) => ownChild(spawn("/bin/bash", ["-c", "bash ci.sh && bash lint.sh && bash ci.sh"], { cwd: fixture.workdir, stdio: "ignore", detached: true }));
async function cleanup(records) {
  const errors = [];
  for (const record of records) {
    const { child } = record;
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (record.instance) { assert.deepEqual(processIdentity(child.pid), record.instance); assert.equal(groupId(child.pid), child.pid); process.kill(-child.pid, "SIGTERM"); }
      let timer; try { await Promise.race([record.terminal, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("OWNED_CHILD_TERMINAL_UNPROVEN")), 2000); })]); } finally { clearTimeout(timer); }
    } catch { errors.push("OWNED_CHILD_CLEANUP_UNPROVEN"); }
  }
  return errors;
}
let controlFailure;

try {
  assert.deepEqual(ORDERED_SUITE, ["bash ci.sh", "bash lint.sh", "bash ci.sh"]);
  for (const ordinal of [1, 3]) {
    const fixture = create(ordinal); deny(() => installVerifierBarrier(fixture.workdir, ordinal));
    const owner = processIdentity(process.pid), execution = run(fixture);
    await waitFor(() => { try { return verifierEvents(fixture).active?.state === "held"; } catch { return false; } });
    const held = heldVerifier(fixture, owner); assert.equal(held.ordinal, ordinal); assert.equal(held.receipt.completed, ordinal - 1);
    assert.equal(held.receipt.events.filter((row) => row.event === "start").length, ordinal);
    assertSameHeldVerifier(held, heldVerifier(fixture, owner));
    deny(() => heldVerifier(fixture, { ...owner, startTicks: String(Number(owner.startTicks) + 1) }));
    deny(() => heldVerifier(fixture, { ...owner, pid: 1 }));
    for (const patch of [{ ordinal: ordinal === 1 ? 3 : 1 }, { scriptSha256: "f".repeat(64) }, { process: { ...held.process, startTicks: "1" } }, { owner: { ...owner, executable: "foreign" } }, { parentChain: [] }]) deny(() => assertSameHeldVerifier(held, { ...held, ...patch }));
    const data = readFileSync(join(fixture.workdir, "h08-verifier-events.jsonl"));
    const lines = data.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    for (const changes of [
      { ordinal: 2 }, { script: "LINT" }, { event: "unknown" }, { pid: -1 }, { startTicks: "0" },
      { scriptSha256: "0".repeat(64) }, { exitCode: 0 }, { foreign: true },
    ]) { const copy = structuredClone(lines); copy[0] = { ...copy[0], ...changes }; deny(() => parseVerifierEvents(Buffer.from(copy.map((row) => JSON.stringify(row)).join("\n") + "\n"), fixture)); }
    deny(() => parseVerifierEvents(data.subarray(0, data.length - 1), fixture));
    deny(() => parseVerifierEvents(Buffer.from([255]), fixture));
    deny(() => parseVerifierEvents(Buffer.alloc(65537), fixture));
    assert.equal(releaseVerifier(fixture, held).released, true); deny(() => releaseVerifier(fixture, held));
    assert.deepEqual(await execution.terminal, { code: 0, signal: null });
    const complete = verifierEvents(fixture); assert.equal(complete.complete, true); assert.equal(complete.completed, 3);
    assert.deepEqual(complete.events.filter((row) => row.event === "start").map(({ ordinal, script }) => [ordinal, script]), [[1, "CI"], [2, "LINT"], [3, "CI"]]);
    for (const event of ["end", "exit"]) assert.deepEqual(complete.events.filter((row) => row.event === event).map(({ ordinal, exitCode }) => [ordinal, exitCode]), [[1, 0], [2, 0], [3, 0]]);
    const extra = ownChild(spawn("/bin/bash", ["ci.sh"], { cwd: fixture.workdir, stdio: "ignore", detached: true }));
    const extraExit = await extra.terminal; assert.notEqual(extraExit.code, 0); assert.equal(verifierEvents(fixture).originalSha256, complete.originalSha256);
    deny(() => heldVerifier(fixture, owner)); groups++;
  }
  const unchanged = create(undefined), execution = run(unchanged); assert.deepEqual(await execution.terminal, { code: 0, signal: null }); assert.equal(verifierEvents(unchanged).complete, true); assert.equal(verifierEvents(unchanged).events.some((row) => row.event === "held"), false); groups++;
  const invalid = create(1); const original = readFileSync(join(invalid.workdir, "ci.sh")); writeFileSync(join(invalid.workdir, "ci.sh"), "exit 0\n"); deny(() => verifierEvents(invalid)); writeFileSync(join(invalid.workdir, "ci.sh"), original);
  deny(() => installVerifierBarrier(invalid.workdir, 2)); deny(() => installVerifierBarrier("relative", 1));
  const current = processIdentity(process.pid); assert.equal(current.pid, process.pid); assert.match(current.startTicks, /^[1-9][0-9]*$/); deny(() => processIdentity(-1)); groups++;
  // Inject an original failure while TWO known owned detached groups have
  // real held script writers. Cleanup must reach both without replacing it.
  const injected = new Error("ORIGINAL_INJECTED_COMPONENT_FAILURE"), active = [], writers = [];
  let injectedOriginal;
  try {
    for (let index = 0; index < 2; index++) { const fixture = create(1), execution = run(fixture); active.push(execution); await waitFor(() => { try { return verifierEvents(fixture).active?.state === "held"; } catch { return false; } }); writers.push(heldVerifier(fixture, processIdentity(process.pid)).process); }
    throw injected;
  } catch (error) { injectedOriginal = error; }
  const cleanupErrors = await cleanup(active); assert.deepEqual(cleanupErrors, []); assert.equal(injectedOriginal, injected);
  for (const record of active) assert.deepEqual(await record.terminal, { code: null, signal: "SIGTERM" });
  for (const writer of writers) await waitFor(() => { try { const stat = readFileSync(`/proc/${writer.pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" "); assert.equal(fields[19], writer.startTicks); return fields[0] === "Z"; } catch (error) { if (error.code === "ENOENT") return true; throw error; } });
  groups++;
  console.log(JSON.stringify({ classification: "OWNED_SHELL_COMPONENT_CONTROLS_ONLY_NOT_HOST_POLICY_ACCEPTANCE", positiveGroups: groups, negativeControls: negatives, elapsedMs: performance.now() - started }));
} catch (error) { controlFailure = error; }
finally {
  const cleanupErrors = await cleanup(children);
  if (!cleanupErrors.length) for (const directory of owned) { try { rmSync(directory, { recursive: true, force: true }); } catch { cleanupErrors.push("OWNED_DIRECTORY_CLEANUP_UNPROVEN"); } }
  if (cleanupErrors.length) { console.error(JSON.stringify({ classification: "COMPONENT_CLEANUP_FAILURE", errors: cleanupErrors })); controlFailure ??= new Error("OWNED_COMPONENT_CLEANUP_UNPROVEN"); }
}
if (controlFailure) throw controlFailure;

