// Real tiny process controls for receipt collection; no Gateway/native fixture.
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { captureCommand } from "./oca501-command-receipt.mjs";

const start = () => Date.now();
const receipt = async (script, options = {}) => captureCommand(process.execPath, ["-e", script], { timeoutMs: 2000, drainGraceMs: 150, ...options });
const both = await receipt('require("fs").writeSync(1,"stdout-final\\n");require("fs").writeSync(2,"stderr-final\\n");');
assert.equal(both.exit.code, 0); assert.equal(both.streamsComplete, true); assert.equal(both.stdout, "stdout-final\n"); assert.equal(both.stderr, "stderr-final\n");
const nonzero = await receipt('require("fs").writeSync(1,"stdout-failed\\n");require("fs").writeSync(2,"stderr-failed\\n");process.exitCode=7;');
assert.equal(nonzero.exit.code, 7); assert.equal(nonzero.streamsComplete, true); assert.equal(nonzero.stdout, "stdout-failed\n"); assert.equal(nonzero.stderr, "stderr-failed\n");
const missing = await captureCommand("/nonexistent/oca501-offline-fixture", [], { timeoutMs: 500, drainGraceMs: 150 });
assert.match(missing.exit.spawnError, /ENOENT/); assert.equal(missing.streamsComplete, true); assert.equal(missing.exit.code, null);
const chunks = await receipt('const b=Buffer.from("µ-synthetic-split-token\\n");process.stdout.write(b.subarray(0,1));setTimeout(()=>{process.stdout.write(b.subarray(1,14));setTimeout(()=>process.stdout.write(b.subarray(14)),20)},20);');
assert.equal(chunks.stdout, "µ-synthetic-split-token\n"); assert.equal(chunks.stdout.replaceAll("synthetic-split-token", "[fixture credential]"), "µ-[fixture credential]\n");
const late = await receipt('require("child_process").spawn(process.execPath,["-e",\'setTimeout(()=>{require("fs").writeSync(1,"inherited-late-stdout\\\\n");require("fs").writeSync(2,"inherited-late-stderr\\\\n")},100)\'],{stdio:["ignore",1,2]});process.exit(0);');
assert.equal(late.exit.code, 0); assert.equal(late.streamsComplete, true); assert.equal(late.stdout, "inherited-late-stdout\n"); assert.equal(late.stderr, "inherited-late-stderr\n");
const before = start();
const timeout = await receipt('process.stdout.write("before-timeout\\n");setInterval(()=>{},1000);', { timeoutMs: 150 });
assert.ok(start() - before < 1500); assert.equal(timeout.timedOut, true); assert.equal(timeout.exit.signal, "SIGKILL"); assert.equal(timeout.stdout, "before-timeout\n");

// The control itself creates and retains authority over this descendant. The
// command leader exits, while this separately-owned process keeps its pipe open.
let descendant; let authority;
const identify = (pid) => ({ executable: realpathSync(`/proc/${pid}/exe`), startTicks: readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).split(" ")[19] });
try {
  const began = start();
  const blocked = await receipt('require("child_process").spawn(process.execPath,["-e",\'process.stdout.write("holder-ready\\\\n");setInterval(()=>{},1000)\'],{stdio:["ignore",1,2],detached:true}).once("spawn",function(){require("fs").writeSync(2,"DESCENDANT "+this.pid+"\\n");process.exit(0)});', {
    timeoutMs: 150,
    track: (child) => child.stderr.on("data", (bytes) => {
      const matched = bytes.toString().match(/DESCENDANT (\d+)/);
      if (matched) { descendant = Number(matched[1]); authority = identify(descendant); }
    }),
  });
  assert.ok(start() - began < 1500); assert.equal(blocked.exit.code, 0);
  assert.equal(blocked.timedOut, true); assert.equal(blocked.streamsComplete, false);
  assert.match(blocked.errors.join("\n"), /incomplete/);
  assert.match(blocked.errors.join("\n"), /no signal sent/);
  assert.match(blocked.stdout, /holder-ready/); assert.ok(descendant && authority);
} finally {
  if (descendant && authority) {
    assert.deepEqual(identify(descendant), authority);
    process.kill(descendant, "SIGKILL");
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      try { identify(descendant); } catch { descendant = undefined; break; }
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal(descendant, undefined, "Separately owned fixture descendant cleaned");
  }
}
console.log(JSON.stringify({ scope: "Offline real-process command receipt controls only", positives: ["final stdout/stderr", "nonzero disposition retained", "spawn error retained", "UTF8 and split credential bytes", "post-exit inherited output fully drained"], negatives: ["live owned timeout is bounded and BLOCKED", "inherited open pipe bounded/incomplete without signalling reaped leader; separately verified fixture descendant cleaned"] }));
