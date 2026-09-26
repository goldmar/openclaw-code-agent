import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lifelineSupported, spawnWithLifeline } from "../src/harness/process-lifeline";

/**
 * N27: a backend server (and the tool processes it starts) must not outlive
 * the Gateway, even when the Gateway is killed with SIGKILL.
 */

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

/** A fake server: starts a long-running tool process, records both pids, prints a ready line. */
function writeFakeServer(dir: string): string {
  const file = join(dir, "fake-server.cjs");
  writeFileSync(file, [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(join(dir, "pids.json"))}, JSON.stringify({ server: process.pid, tool: tool.pid }));`,
    "console.log('ready');",
    "setInterval(() => {}, 1000);",
  ].join("\n"));
  return file;
}

describe("process lifeline (N27)", { skip: !lifelineSupported() }, () => {
  it("stops the server and its tool processes when the Gateway is SIGKILLed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oca-lifeline-"));
    try {
      const server = writeFakeServer(dir);
      const gateway = join(dir, "gateway.ts");
      const lifelineModule = resolve("src/harness/process-lifeline.ts");
      writeFileSync(gateway, [
        `import { spawnWithLifeline } from ${JSON.stringify(lifelineModule)};`,
        `const child = spawnWithLifeline(process.execPath, [${JSON.stringify(server)}], { cwd: ${JSON.stringify(dir)} });`,
        "child.process.stdout.on('data', () => undefined);",
        "setInterval(() => {}, 1000);",
      ].join("\n"));
      const gatewayProcess = spawn(process.execPath, ["--import", "tsx", gateway], { stdio: "ignore" });
      const pidsFile = join(dir, "pids.json");
      await waitFor(() => existsSync(pidsFile) && readFileSync(pidsFile, "utf8").length > 0, "server start");
      const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { server: number; tool: number };
      assert.ok(alive(pids.server) && alive(pids.tool));
      gatewayProcess.kill("SIGKILL");
      await waitFor(() => !alive(pids.server) && !alive(pids.tool), "server and tool to stop after the Gateway died");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("terminate() stops the whole process group, not only the direct child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oca-lifeline-"));
    try {
      const child = spawnWithLifeline(process.execPath, [writeFakeServer(dir)], { cwd: dir });
      child.process.stdout.resume();
      const pidsFile = join(dir, "pids.json");
      await waitFor(() => existsSync(pidsFile) && readFileSync(pidsFile, "utf8").length > 0, "server start");
      const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { server: number; tool: number };
      await child.terminate(1_000);
      await waitFor(() => !alive(pids.server) && !alive(pids.tool), "group to stop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards the server's exit status", async () => {
    const child = spawnWithLifeline(process.execPath, ["-e", "process.exit(7)"], { cwd: tmpdir() });
    const code = await new Promise<number | null>((resolveExit) => child.process.once("exit", resolveExit));
    assert.equal(code, 7);
  });
});
