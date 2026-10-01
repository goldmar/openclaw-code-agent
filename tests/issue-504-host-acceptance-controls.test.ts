import "./test-env";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerResponse } from "node:http";
import { options, nativeResult, compositeToolCallId } from "../scripts/e2e/oca-issue-504-host-acceptance";
import { HostEvidence, closeFailedProviderResponse, cleanupAll, currentDescendant, ignorableProcReadFailure, fixtureEnv, FIXTURE_MARKER, ownedPath, processIdentity, requireCandidate, sameProcess, sameProcessFields, stopNativeProcesses, trackOwnedChild, stopOwnedChild, until, validateNativeExecutable, writeHostObserver } from "../scripts/e2e/oca-issue-504-host-fixtures";

// Utility controls only. These tests provide no real-host/native acceptance receipt.
describe("issue 504 real-host acceptance controls", () => {
  it("requires exact candidate identity, clean tracked source and complete options", () => {
    const head = "a".repeat(40);
    requireCandidate(`${head}\n`, head, "");
    assert.throws(() => requireCandidate(head, "b".repeat(40), ""));
    assert.throws(() => requireCandidate(head, head, " M src/session.ts"));
    assert.throws(() => options(["--expected-sha", head]));
    assert.throws(() => options(["--expected-sha", head, "--codex-bin", "/fixture", "--codex-version", "0.159.3", "--unknown", "x"]));
  });

  it("rejects a script or substituted native ELF before execution", () => {
    assert.throws(() => validateNativeExecutable(Buffer.from("#!/bin/sh\necho codex-cli 0.159.3\n"), "0.159.3"), /ELF/);
    const forged = Buffer.alloc(64); Buffer.from("7f454c46", "hex").copy(forged); forged[4] = 2; forged[5] = 1; forged.writeUInt16LE(62, 18);
    assert.throws(() => validateNativeExecutable(forged, "0.159.3"), /official archive member/);
    assert.throws(() => validateNativeExecutable(forged, "0.159.4"), /reviewed native version/);
  });

  it("rejects markerless roots, lexical escapes and symlink escapes", () => {
    const root = mkdtempSync(join(tmpdir(), "oca504-controls-"));
    const foreign = mkdtempSync(join(tmpdir(), "oca504-control-foreign-"));
    try {
      assert.throws(() => ownedPath(root, join(root, "file")));
      writeFileSync(join(root, ".fixture-owner"), FIXTURE_MARKER);
      assert.equal(ownedPath(root, join(root, "nested", "file")), join(root, "nested", "file"));
      assert.throws(() => ownedPath(root, join(root, "..", "escape")));
      symlinkSync(foreign, join(root, "redirect"));
      assert.throws(() => ownedPath(root, join(root, "redirect", "file")));
      const env = fixtureEnv(root, { PATH: "/fixture/bin", OPENAI_API_KEY: "must-not-inherit", CODEX_HOME: "/foreign", OPENCLAW_GATEWAY_TOKEN: "must-not-inherit", HTTPS_PROXY: "must-not-inherit" });
      assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.OPENCLAW_GATEWAY_TOKEN, undefined); assert.equal(env.HTTPS_PROXY, undefined);
      assert.equal(env.NPM_CONFIG_USERCONFIG, join(root, "npm-user.conf")); assert.equal(env.NPM_CONFIG_GLOBALCONFIG, join(root, "npm-global.conf"));
      assert.equal(env.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org/");
      assert.equal(env.CODEX_HOME, join(root, "codex")); assert.equal(env.HOME, join(root, "home"));
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(foreign, { recursive: true, force: true }); }
  });

  it("attempts every cleanup after earlier failures and rejects PID reuse evidence", async () => {
    const attempted: string[] = [];
    await assert.rejects(cleanupAll([
      () => { attempted.push("client"); throw new Error("client failed"); },
      () => { attempted.push("native"); },
      () => { attempted.push("gateway"); throw new Error("gateway failed"); },
      () => { attempted.push("provider"); },
    ]), (error: AggregateError) => error.errors.length === 2);
    assert.deepEqual(attempted, ["client", "native", "gateway", "provider"]);
    const own = processIdentity(process.pid)!; assert.ok(own); assert.equal(sameProcess(own), true);
    assert.equal(sameProcess({ ...own, startTicks: "not-the-same-process" }), false);
    assert.equal(sameProcess({ ...own, executable: "/different-exec", group: -1 }), true, "Exec/group changes do not terminate owned kernel lifetime");
  });

  it("stops a captured detached root and its actual descendant without group guessing", async () => {
    const child = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{},stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);`], { env: {}, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    trackOwnedChild(child);
    let output = "", descendant: number;
    child.stdout.on("data", (chunk) => { output += chunk; });
    try { descendant = Number(await until(() => /^\d+\n$/.test(output) ? output.trim() : undefined, "control descendant receipt", 5_000)); assert.ok(processIdentity(descendant)); }
    finally { await stopOwnedChild(child); }
    assert.equal(processIdentity(descendant), undefined);
    assert.equal(processIdentity(child.pid!), undefined);
  });

  it("treats an exited zombie as unsignalable without dropping lifetime checks", () => {
    const fields = Array<string>(20).fill("0"); fields[0] = "S"; fields[19] = "captured";
    assert.equal(sameProcessFields(fields, "captured"), true);
    fields[0] = "Z"; assert.equal(sameProcessFields(fields, "captured"), false);
    fields[0] = "S"; assert.equal(sameProcessFields(fields, "reused"), false);
  });

  it("retains a failed ownership check while still stopping another proven child", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: {}, detached: true, stdio: "ignore" });
    trackOwnedChild(child);
    const ended = new Promise<void>((done) => child.once("close", () => done()));
    const readFailure = Object.assign(new Error("synthetic ownership read failed"), { code: "EACCES" });
    const unproved = { ...processIdentity(process.pid)! };
    // Failure precedes the live identity comparison, so this PID must never be signaled.
    Object.defineProperty(unproved, "startTicks", { get() { throw readFailure; } });
    try {
      const proven = await until(() => processIdentity(child.pid!), "control owned root", 5_000);
      await assert.rejects(stopNativeProcesses(new Map([[proven.pid, proven], [unproved.pid, unproved]])),
        (error: AggregateError) => error.errors.includes(readFailure));
      await ended;
      assert.equal(processIdentity(child.pid!), undefined);
      assert.ok(processIdentity(process.pid), "Unproved PID remains untouched");
    } finally { await stopOwnedChild(child); }
  });

  it("observes exact tool IDs without returning mutations or recording requester routes", async () => {
    const root = mkdtempSync(join(tmpdir(), "oca504-observer-control-"));
    try {
      writeFileSync(join(root, ".fixture-owner"), FIXTURE_MARKER); mkdirSync(join(root, "host-observer"));
      const observer = writeHostObserver(root);
      const module = await import(join(observer.path, "index.mjs"));
      const callbacks = new Map<string, Function>();
      module.default.register({ on: (name: string, callback: Function) => callbacks.set(name, callback) });
      const params = { session: "synthetic-504", message: "1" };
      const callback = callbacks.get("before_tool_call")!;
      assert.equal(callback({ toolName: "agent_respond", toolCallId: "actual-synthetic-id", params }, { sessionKey: "PRIVATE-ROUTE" }), undefined);
      assert.deepEqual(params, { session: "synthetic-504", message: "1" });
      const capture = readFileSync(join(root, "host-tools.jsonl"), "utf8");
      assert.doesNotMatch(capture, /PRIVATE-ROUTE|sessionKey|"message"/);
      assert.equal(JSON.parse(capture).toolCallId, "actual-synthetic-id");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("reads native failures through actual envelope shapes without inventing status from text", () => {
    const error = { isError: true, details: { status: "error", code: "session_not_found", targetSelected: false, operationStarted: false } };
    assert.deepEqual(nativeResult(JSON.stringify({ tool: { id: "plugin:fixture" }, result: error })), error);
    assert.equal(nativeResult({ content: [{ text: "Error: unrelated" }] }), undefined);
    assert.equal(nativeResult({ isError: true, details: { code: "unknown" } }), undefined);
  });

  it("keeps bare provider IDs distinct from exact composite host IDs", () => {
    assert.equal(compositeToolCallId("call-one", "item-one"), "call-one|item-one");
    assert.notEqual(compositeToolCallId("call-one", "item-two"), "call-one|item-one");
    assert.notEqual(compositeToolCallId("call-two", "item-one"), "call-one|item-one");
    assert.throws(() => compositeToolCallId("call-one ", "item-one"));
    assert.throws(() => compositeToolCallId("call-one", ""));
    assert.throws(() => compositeToolCallId("call-one|suffix", "item-one"));
  });

  it("does not admit reused or reparented descendant snapshots and fails closed on owned read errors", () => {
    const parent = processIdentity(process.pid)!;
    const snapshot = { pid: 123, parentPid: parent.pid, startTicks: "first" };
    const identity = { ...snapshot, group: parent.group, executable: parent.executable };
    assert.equal(currentDescendant(snapshot, identity, parent), true);
    assert.equal(currentDescendant(snapshot, { ...identity, startTicks: "replacement" }, parent), false);
    assert.equal(currentDescendant(snapshot, { ...identity, parentPid: 999 }, parent), false);
    assert.equal(currentDescendant(snapshot, identity, { ...parent, startTicks: "replacement" }), false);
    for (const code of ["EACCES", "EPERM"]) { assert.equal(ignorableProcReadFailure(code, false), true); assert.equal(ignorableProcReadFailure(code, true), false); }
    assert.equal(ignorableProcReadFailure("ENOENT", true), true);
    assert.equal(ignorableProcReadFailure("EIO", false), false);
  });

  it("retains sanitized bounded success and failure receipts, including failed cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "oca504-receipt-controls-"));
    try {
      for (const failed of [false, true]) {
        const evidence = new HostEvidence(root, "v26.1.0", "a".repeat(40));
        evidence.secrets.push("PRIVATE_TOKEN"); evidence.paths.push("/private/fixture");
        evidence.append("command-1-stderr.log", "PRIVATE_TOKEN Bearer OTHER_TOKEN /private/fixture/path\n", "diagnostic");
        let original = "original-failure", cleanup = "";
        if (failed) { try { await cleanupAll([() => { throw new Error("cleanup-failure"); }, () => { cleanup = "all attempted"; }]); } catch { /* receipt retains failure */ } }
        evidence.record("run-summary.json", { original: failed ? original : null, cleanup: failed ? cleanup : null });
        const receipt = evidence.persist("v26.1.0", failed ? "BLOCKED" : "PASS", !failed);
        const bytes = readFileSync(join(receipt.path, "manifest.json"));
        assert.equal(receipt.manifestSha256, (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"));
        const manifest = JSON.parse(bytes.toString()); assert.equal(manifest.status, failed ? "BLOCKED" : "PASS"); assert.equal(manifest.teardownVerified, !failed);
        const log = readFileSync(join(receipt.path, "command-1-stderr.log"), "utf8"); assert.doesNotMatch(log, /PRIVATE_TOKEN|OTHER_TOKEN|\/private\/fixture/);
        assert.match(log, /fixture-credential/);
        if (failed) assert.match(readFileSync(join(receipt.path, "run-summary.json"), "utf8"), /original-failure.*all attempted/);
      }
      const bounded = new HostEvidence(root, "v26.1.0", "b".repeat(40));
      bounded.append("command-1-stdout.log", "x".repeat(100_000), "diagnostic");
      bounded.append("native-events.jsonl", "x".repeat(1_048_577));
      const receipt = bounded.persist("v26.1.0", "PASS", true), manifest = JSON.parse(readFileSync(join(receipt.path, "manifest.json"), "utf8"));
      assert.equal(manifest.status, "BLOCKED"); assert.ok(manifest.errors.includes("proof-overflow:native-events.jsonl"));
      const diagnostic = manifest.files.find((file: any) => file.file === "command-1-stdout.log");
      assert.equal(diagnostic.truncated, true); assert.equal(diagnostic.totalBytes, 100_000); assert.ok(diagnostic.bytes <= 65_536);
      assert.ok(manifest.files.every((file: any) => file.bytes <= 1_048_576));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("retains bounded protocol causes separately from later runtime and cleanup failures", () => {
    const root = mkdtempSync(join(tmpdir(), "oca504-error-receipt-controls-"));
    try {
      const evidence = new HostEvidence(root, "v26.1.0", "c".repeat(40));
      const cause = Object.assign(new Error("PRIVATE_BODY /private/path Bearer PRIVATE_TOKEN"), { code: "EACCES" });
      evidence.failure("provider-json", new SyntaxError("PRIVATE_REQUEST_BODY", { cause }));
      evidence.failure("native-observer", cause);
      evidence.record("run-summary.json", { originalFailures: ["later-runtime-timeout"], cleanupFailures: ["later-cleanup-failure"], fixtureFailures: evidence.failures });
      const receipt = evidence.persist("v26.1.0", "BLOCKED", false);
      const proof = readFileSync(join(receipt.path, "provider.jsonl"), "utf8") + readFileSync(join(receipt.path, "host-events.jsonl"), "utf8") + readFileSync(join(receipt.path, "run-summary.json"), "utf8");
      assert.doesNotMatch(proof, /PRIVATE_|\/private\/|Bearer/);
      assert.match(proof, /SyntaxError.*Error/); assert.match(proof, /EACCES/);
      assert.match(proof, /later-runtime-timeout/); assert.match(proof, /later-cleanup-failure/);
      for (let i = 0; i < 128; i++) evidence.failure("provider-stream", new Error("never captured raw input"));
      assert.equal(evidence.failures.length, 128); assert.ok(evidence.errors.includes("failure-record-count-overflow"));
      assert.ok(evidence.failures.every((failure) => Buffer.byteLength(failure.message) <= 1_024));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("closes failed local provider responses without rewriting sent headers or losing secondary causes", () => {
    const root = mkdtempSync(join(tmpdir(), "oca504-provider-close-controls-"));
    try {
      for (const mode of ["before", "after", "ended", "destroyed", "write-fault", "close-fault"]) {
        const evidence = new HostEvidence(root, "v26.1.0", "d".repeat(40));
        evidence.failure("provider-json", new SyntaxError("original raw body is private"));
        const calls: string[] = [];
        const response = { headersSent: mode === "after" || mode === "close-fault", writableEnded: mode === "ended", destroyed: mode === "destroyed",
          writeHead: () => { calls.push("writeHead"); if (mode === "write-fault") throw new TypeError("secondary write fault"); },
          end: (text: string) => { calls.push(`end:${text}`); },
          destroy: () => { calls.push("destroy"); if (mode === "close-fault") throw new RangeError("secondary close fault"); },
        } as unknown as ServerResponse;
        assert.doesNotThrow(() => closeFailedProviderResponse(response, evidence));
        assert.equal(evidence.failures[0].errorClass, "SyntaxError");
        assert.ok(!JSON.stringify(evidence.failures).includes("raw body"));
        if (mode === "before") assert.deepEqual(calls, ["writeHead", "end:fixture protocol failure"]);
        else if (mode === "destroyed") assert.deepEqual(calls, []);
        else if (mode === "write-fault") { assert.deepEqual(calls, ["writeHead", "destroy"]); assert.equal(evidence.failures[1].errorClass, "TypeError"); }
        else if (mode === "close-fault") { assert.ok(calls.every((call) => call === "destroy")); assert.equal(evidence.failures[1].errorClass, "RangeError"); }
        else assert.deepEqual(calls, ["destroy"]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
