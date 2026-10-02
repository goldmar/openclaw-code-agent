// Owned H08 shell component only. These receipts do not prove policy epochs,
// runtime generation, native completion, or host/source delivery.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const ORDERED_SUITE = Object.freeze(["bash ci.sh", "bash lint.sh", "bash ci.sh"]);
const ORDER = ["CI", "LINT", "CI"], MAX_RECEIPT = 65536;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const count = (value) => Number.isSafeInteger(value) && value > 0;
const ticks = (value) => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
function ownedDirectory(path) {
  assert.ok(isAbsolute(path) && resolve(path) === path);
  const stat = lstatSync(path); assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid());
  assert.equal(realpathSync(path), path);
}
function regularBytes(path, limit) {
  const before = lstatSync(path); assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === process.getuid() && before.size <= limit);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const opened = fstatSync(fd); assert.equal(opened.dev, before.dev); assert.equal(opened.ino, before.ino); const bytes = readFileSync(fd); assert.ok(bytes.length <= limit); const after = fstatSync(fd); assert.equal(after.size, opened.size); assert.equal(after.mtimeMs, opened.mtimeMs); return bytes; }
  finally { closeSync(fd); }
}

function scriptText(workdir, script, barrierOrdinal) {
  return `#!/usr/bin/env bash
set -euo pipefail
[[ "$PWD" == ${quote(workdir)} ]]
mkdir .h08-verifier-lock
trap 'rmdir .h08-verifier-lock' EXIT
ordinal=$(cat .h08-verifier-ordinal)
[[ "$ordinal" =~ ^[0-2]$ ]]
ordinal=$((ordinal + 1))
case "$ordinal:${script}" in 1:CI|2:LINT|3:CI) ;; *) exit 93 ;; esac
printf '%s\\n' "$ordinal" > .h08-verifier-ordinal
pid=$BASHPID
stat_line=$(cat "/proc/$pid/stat")
stat_fields=(\${stat_line##*) })
start_ticks=\${stat_fields[19]}
script_hash=$(sha256sum -- "$0")
script_hash=\${script_hash%% *}
emit() { printf '{"ordinal":%s,"script":"${script}","event":"%s","pid":%s,"startTicks":"%s","scriptSha256":"%s","exitCode":%s}\\n' "$ordinal" "$1" "$pid" "$start_ticks" "$script_hash" "$2" >> h08-verifier-events.jsonl; }
emit start null
if [[ "$ordinal" == "${barrierOrdinal ?? 0}" ]]; then
  emit held null
  while [[ ! -f ".h08-release-$ordinal" ]]; do sleep 0.05; done
fi
emit end 0
emit exit 0
`;
}
export function installVerifierBarrier(workdir, barrierOrdinal) {
  ownedDirectory(workdir); assert.ok(barrierOrdinal === undefined || [1, 3].includes(barrierOrdinal));
  const files = { "ci.sh": scriptText(workdir, "CI", barrierOrdinal), "lint.sh": scriptText(workdir, "LINT", barrierOrdinal), ".h08-verifier-ordinal": "0\n", "h08-verifier-events.jsonl": "" };
  for (const name of [...Object.keys(files), ".h08-release-1", ".h08-release-3", ".h08-verifier-lock"]) { try { lstatSync(join(workdir, name)); assert.fail("Fresh owned verifier fixture files are required"); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(workdir, name), bytes, { flag: "wx", mode: 0o600 });
  return { workdir, barrierOrdinal, suite: [...ORDERED_SUITE], scriptHashes: { CI: hash(files["ci.sh"]), LINT: hash(files["lint.sh"]) } };
}
export function parseVerifierEvents(bytes, fixture) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= MAX_RECEIPT && Buffer.from(bytes.toString("utf8")).equals(bytes));
  const text = bytes.toString("utf8"); assert.ok(!text || text.endsWith("\n"), "Only complete append records prove a boundary");
  const events = text ? text.slice(0, -1).split("\n").map((line) => JSON.parse(line)) : [];
  const keys = ["ordinal", "script", "event", "pid", "startTicks", "scriptSha256", "exitCode"].toSorted();
  let next = 1, current;
  for (const row of events) {
    assert.ok(row && !Array.isArray(row)); assert.deepEqual(Object.keys(row).toSorted(), keys);
    assert.ok(Number.isInteger(row.ordinal) && row.ordinal >= 1 && row.ordinal <= 3 && row.script === ORDER[row.ordinal - 1]);
    assert.ok(count(row.pid) && ticks(row.startTicks)); assert.equal(row.scriptSha256, fixture.scriptHashes[row.script]);
    if (row.event === "start") { assert.equal(row.ordinal, next); assert.equal(current, undefined); assert.equal(row.exitCode, null); current = { ...row, state: "started" }; }
    else {
      assert.ok(current); assert.equal(row.ordinal, current.ordinal); assert.equal(row.pid, current.pid); assert.equal(row.startTicks, current.startTicks);
      if (row.event === "held") { assert.equal(current.state, "started"); assert.equal(row.ordinal, fixture.barrierOrdinal); assert.equal(row.exitCode, null); current.state = "held"; }
      else if (row.event === "end") { assert.ok(["started", "held"].includes(current.state)); assert.equal(row.exitCode, 0); current.state = "ended"; }
      else { assert.equal(row.event, "exit"); assert.equal(current.state, "ended"); assert.equal(row.exitCode, 0); current = undefined; next++; }
    }
  }
  return { events, completed: next - 1, active: current, complete: next === 4 && current === undefined, originalBytes: bytes.length, originalSha256: hash(bytes), proofScope: "Actual owned shell append receipts only" };
}
export function verifierEvents(fixture) {
  ownedDirectory(fixture.workdir);
  for (const [script, name] of [["CI", "ci.sh"], ["LINT", "lint.sh"]]) assert.equal(hash(regularBytes(join(fixture.workdir, name), MAX_RECEIPT)), fixture.scriptHashes[script]);
  return parseVerifierEvents(regularBytes(join(fixture.workdir, "h08-verifier-events.jsonl"), MAX_RECEIPT), fixture);
}
export function processIdentity(pid) {
  assert.ok(count(pid));
  const stat = () => { const raw = readFileSync(`/proc/${pid}/stat`, "utf8"), end = raw.lastIndexOf(") "); assert.ok(end > 0); const fields = raw.slice(end + 2).split(" "); assert.notEqual(fields[0], "Z"); assert.ok(ticks(fields[19])); return { parentPid: Number(fields[1]), startTicks: fields[19] }; };
  const before = stat(), executable = realpathSync(`/proc/${pid}/exe`), cwd = realpathSync(`/proc/${pid}/cwd`);
  assert.deepEqual(stat(), before); return { pid, ...before, executable, cwd };
}
export function heldVerifier(fixture, owner) {
  const receipt = verifierEvents(fixture); assert.equal(receipt.active?.state, "held"); assert.equal(receipt.active.ordinal, fixture.barrierOrdinal);
  const expectedOwner = processIdentity(owner.pid); assert.deepEqual(expectedOwner, owner);
  const script = processIdentity(receipt.active.pid); assert.equal(script.startTicks, receipt.active.startTicks); assert.equal(script.cwd, fixture.workdir); assert.equal(script.executable, realpathSync("/bin/bash"));
  const args = readFileSync(`/proc/${script.pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
  assert.ok(args.length === 2 && ["bash", "/bin/bash"].includes(args[0]) && args[1] === (receipt.active.script === "CI" ? "ci.sh" : "lint.sh"), "Held PID must execute the exact owned verifier script");
  const chain = [script]; let parent = script.parentPid;
  while (parent !== owner.pid) { assert.ok(count(parent) && chain.length < 32 && !chain.some((entry) => entry.pid === parent)); const row = processIdentity(parent); chain.push(row); parent = row.parentPid; }
  chain.push(expectedOwner); assert.deepEqual(processIdentity(script.pid), script); assert.deepEqual(processIdentity(owner.pid), expectedOwner);
  return { ordinal: receipt.active.ordinal, script: receipt.active.script, scriptSha256: receipt.active.scriptSha256, process: script, owner: expectedOwner, parentChain: chain, receipt, proofScope: "Live owned held verifier instance beneath supplied owner; no policy/generation claim" };
}
export function assertSameHeldVerifier(before, after) {
  for (const key of ["ordinal", "script", "scriptSha256", "process", "owner", "parentChain"]) assert.deepEqual(after[key], before[key]);
  assert.equal(after.receipt.completed, before.receipt.completed); assert.equal(after.receipt.originalSha256, before.receipt.originalSha256);
}
export function releaseVerifier(fixture, held) {
  const current = heldVerifier(fixture, held.owner); assertSameHeldVerifier(held, current);
  writeFileSync(join(fixture.workdir, `.h08-release-${held.ordinal}`), "release\n", { flag: "wx", mode: 0o600 });
  return { ordinal: held.ordinal, process: held.process, released: true, proofScope: "Owned release-file creation only; await actual shell exit and policy result separately" };
}
