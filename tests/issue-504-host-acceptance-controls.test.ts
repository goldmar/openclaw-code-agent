import "./test-env";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { cpSync, truncateSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServerResponse } from "node:http";
import { options, nativeResult, compositeToolCallId } from "../scripts/e2e/oca-issue-504-host-acceptance";
import { HostEvidence, subscribeFixtureMessages, projectFixtureHostEvent, hasFreshSubscribedTerminal, preparePackedInstaller, command, closeFailedProviderResponse, cleanupAll, currentDescendant, ignorableProcReadFailure, fixtureEnv, FIXTURE_MARKER, ownedPath, packedCandidateProof, expectedPublishedPackage, verifyPackedPluginInspection, freshPluginBootstrap, processIdentity, requireCandidate, sameProcess, sameProcessFields, stopNativeProcesses, trackOwnedChild, stopOwnedChild, until, validateNativeExecutable, writeHostObserver } from "../scripts/e2e/oca-issue-504-host-fixtures";

const archiveReader = join(process.cwd(), "scripts", "e2e", "oca-issue-504-archive-proof.py");
function readArchive(path: string) {
  return JSON.parse(execFileSync("/usr/bin/python3", ["-I", archiveReader, path], { encoding: "utf8", timeout: 30_000, maxBuffer: 2_097_152, stdio: ["ignore", "pipe", "pipe"] }));
}
function writeArchive(path: string, members: Array<{ name: string; bytes?: string; kind?: string; size?: number }>) {
  const script = "import base64,gzip,io,json,sys,tarfile\nwith open(sys.argv[1],'wb') as raw:\n with gzip.GzipFile(fileobj=raw,mode='wb',mtime=0) as gz:\n  with tarfile.open(fileobj=gz,mode='w',format=tarfile.PAX_FORMAT) as tf:\n   for item in json.loads(sys.stdin.read()):\n    member=tarfile.TarInfo(item['name']); data=base64.b64decode(item.get('bytes','')); member.size=item.get('size',len(data))\n    if item.get('kind')=='link': member.type=tarfile.SYMTYPE;member.linkname='../outside';member.size=0\n    tf.addfile(member,io.BytesIO(data) if member.isreg() else None)\n";
  execFileSync("/usr/bin/python3", ["-I", "-c", script, path], { input: JSON.stringify(members), timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] });
}
function syntheticPackedInstall() {
  const fixture = mkdtempSync(join(tmpdir(), "oca504-packed-control-"));
  writeFileSync(join(fixture, ".fixture-owner"), FIXTURE_MARKER);
  const candidate = join(fixture, "candidate"), tarball = join(fixture, "candidate.tgz");
  mkdirSync(join(candidate, "dist", "chunks"), { recursive: true });
  writeFileSync(join(candidate, "dist", "index.js"), "synthetic candidate bytes NEVER executed");
  writeFileSync(join(candidate, "dist", "chunks", "fixture.js"), "synthetic chunk NEVER executed");
  const source = { name: "openclaw-code-agent", version: "5.0.1", packageManager: "pnpm@11.15.1", scripts: { prepack: "pnpm build", test: "node inert-fixture-only" }, dependencies: { "inert-fixture": "1.2.3" }, openclaw: { extensions: ["./dist/index.js"], minHostVersion: "2026.9.7" }, publishConfig: { access: "public", provenance: true } };
  writeFileSync(join(candidate, "package.json"), JSON.stringify(source));
  writeFileSync(join(candidate, "openclaw.plugin.json"), JSON.stringify({ id: "openclaw-code-agent", version: "5.0.1" }));
  writeFileSync(join(candidate, "npm-shrinkwrap.json"), "{}");
  const published = expectedPublishedPackage(source);
  const members = ["package.json", "openclaw.plugin.json", "npm-shrinkwrap.json", "dist/index.js", "dist/chunks/fixture.js"].map((name) => ({ name: "package/" + name, bytes: (name === "package.json" ? published : readFileSync(join(candidate, name))).toString("base64") }));
  writeArchive(tarball, members);
  const archive = readArchive(tarball), proof = packedCandidateProof(candidate, tarball, archive);
  const states = ["state-a", "state-b"].map((name) => join(fixture, name));
  const reports = states.map((state) => {
    const installed = join(state, "installed-candidate"); cpSync(candidate, installed, { recursive: true });
    writeFileSync(join(installed, "package.json"), published);
    return { plugin: { id: proof.id, enabled: true, status: "loaded", imported: false, version: proof.version,
      rootDir: installed, source: join(installed, "dist", "index.js") },
      install: { source: "archive", sourcePath: tarball, installPath: installed, version: proof.version } };
  });
  return { fixture, candidate, tarball, proof, archive, members, source, states, reports };
}

// Utility controls only. These tests provide no real-host/native acceptance receipt.
describe("issue 504 real-host acceptance controls", () => {
  it("uses the actual message subscription seam and refuses invalid acknowledgements before follow-ons", async () => {
    const counts = { requests: 0, inspection: 0, tool: 0, chat: 0, native: 0 };
    const ack = { subscribed: true, key: "agent:main:main", agentId: "main" };
    const proceed = async (value: unknown, rejects = false) => {
      const result = await subscribeFixtureMessages(async (method, params) => {
        counts.requests++; assert.equal(method, "sessions.messages.subscribe"); assert.deepEqual(params, { key: "agent:main:main" });
        if (rejects) throw new Error("Synthetic SDK subscription rejection"); return value;
      }, "fixture-connection-a");
      counts.inspection++; counts.tool++; counts.chat++; counts.native++; return result;
    };
    assert.equal((await proceed(ack)).localConnectionCorrelation, "fixture-connection-a");
    for (const invalid of [null, [], {}, { ...ack, subscribed: false }, { ...ack, subscribed: "true" }, { ...ack, key: "other-session" }, { ...ack, agentId: "other-owner" }, { subscribed: true, key: ack.key }]) await assert.rejects(proceed(invalid));
    await assert.rejects(proceed(ack, true), /Synthetic SDK subscription rejection/);
    assert.deepEqual(counts, { requests: 10, inspection: 1, tool: 1, chat: 1, native: 1 });
  });

  it("matches only fresh actual projected terminal events from the acknowledged connection/session/run without raw routes", async () => {
    const subscription = await subscribeFixtureMessages(async () => ({ subscribed: true, key: "agent:main:main", agentId: "main" }), "fixture-connection-a");
    const project = (event: string, payload: Record<string, unknown>, connection = "fixture-connection-a") => projectFixtureHostEvent(event, payload, connection, subscription);
    const terminal = { sessionKey: "agent:main:main", runId: "fresh-run", state: "final" };
    const chat = project("chat", terminal), lifecycle = project("agent", { sessionKey: terminal.sessionKey, runId: terminal.runId, stream: "lifecycle", data: { phase: "end" } });
    for (const event of [chat, lifecycle]) assert.equal(hasFreshSubscribedTerminal([event], 0, subscription, "fresh-run"), true);
    assert.equal(hasFreshSubscribedTerminal([chat], 1, subscription, "fresh-run"), false);
    for (const event of [project("chat", { ...terminal, sessionKey: "another-session" }), project("chat", { runId: "fresh-run", state: "final" }),
      project("chat", terminal, "fixture-connection-b"), project("chat", { ...terminal, runId: "stale-run" }), project("sessions.changed", terminal),
      project("chat", { ...terminal, state: "delta" }), project("chat", { ...terminal, state: "error" }), project("chat", { ...terminal, state: "aborted" }),
      project("agent", { ...terminal, stream: "lifecycle", data: { phase: "error" } }),
      project("agent", { ...terminal, state: "error", stream: "lifecycle", data: { phase: "end" } }),
      project("agent", { ...terminal, stream: "lifecycle", data: { phase: "end", isError: true } })]) {
      assert.equal(hasFreshSubscribedTerminal([event], 0, subscription, "fresh-run"), false);
    }
    assert.ok(!JSON.stringify(chat).includes("sessionKey")); assert.ok(!JSON.stringify(chat).includes("agent:main:main"));
    assert.equal(hasFreshSubscribedTerminal([projectFixtureHostEvent("chat", terminal, "fixture-connection-a")], 0, subscription, "fresh-run"), false);
  });

  it("admits unchanged reader proof then freshly refuses a later replaced archive before any installer or follow-on", async () => {
    const s = syntheticPackedInstall(); const original = readFileSync(s.tarball);
    const counts = { install: 0, enable: 0, inspect: 0, gateway: 0 };
    try {
      const admission = await preparePackedInstaller(s.candidate, s.fixture, s.tarball,
        () => command("/usr/bin/python3", ["-I", archiveReader, s.tarball], { cwd: s.fixture, env: fixtureEnv(s.fixture), timeoutMs: 30_000 }),
        async (path) => { assert.equal(path, s.tarball); counts.install++; });
      const startState = async () => { await admission.install(); counts.enable++; counts.inspect++; counts.gateway++; };
      await startState(); assert.deepEqual(counts, { install: 1, enable: 1, inspect: 1, gateway: 1 });
      writeFileSync(s.tarball, Buffer.concat([original, Buffer.from("altered")]));
      await assert.rejects(startState(), /Archive admission hash differs/);
      assert.deepEqual(counts, { install: 1, enable: 1, inspect: 1, gateway: 1 });
      writeFileSync(s.tarball, original); await startState();
      assert.deepEqual(counts, { install: 2, enable: 2, inspect: 2, gateway: 2 });
      rmSync(s.tarball); symlinkSync(join(s.candidate, "package.json"), s.tarball);
      await assert.rejects(startState(), /cannot redirect/); rmSync(s.tarball);
      mkdirSync(s.tarball); await assert.rejects(startState(), /bounded owned regular/); rmSync(s.tarball, { recursive: true });
      writeFileSync(s.tarball, original); truncateSync(s.tarball, 33_554_433);
      await assert.rejects(startState(), /bounded owned regular/);
      assert.deepEqual(counts, { install: 2, enable: 2, inspect: 2, gateway: 2 });
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("promptly refuses an actual no-writer FIFO in the same install seam; supervision timeout is failure", async () => {
    const s = syntheticPackedInstall(); const original = readFileSync(s.tarball);
    try {
      const helper = join(process.cwd(), "scripts/e2e/oca-issue-504-host-fixtures.ts");
      const script = `import { preparePackedInstaller, command, fixtureEnv } from ${JSON.stringify("file://" + helper)};
        import { rmSync } from 'node:fs'; import { execFileSync } from 'node:child_process';
        const [candidate, fixture, tarball, reader] = process.argv.slice(1);
        const counts = { install: 0, enable: 0, inspect: 0, gateway: 0 };
        const admitted = await preparePackedInstaller(candidate, fixture, tarball,
          () => command('/usr/bin/python3', ['-I', reader, tarball], { cwd: fixture, env: fixtureEnv(fixture), timeoutMs: 30000 }),
          async () => { counts.install++; });
        rmSync(tarball); execFileSync('/usr/bin/mkfifo', [tarball]);
        let refused = false;
        try { await admitted.install(); counts.enable++; counts.inspect++; counts.gateway++; }
        catch (error) { if (!/bounded owned regular file/.test(error.message)) throw error; refused = true; }
        if (!refused) throw new Error('FIFO was incorrectly admitted');
        console.log(JSON.stringify({ refused, counts }));`;
      // A blocking open is a real supervised child timeout and fails this assertion.
      const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, s.candidate, s.fixture, s.tarball, archiveReader],
        { cwd: process.cwd(), encoding: "utf8", timeout: 5_000, maxBuffer: 65_536, stdio: ["ignore", "pipe", "pipe"] });
      assert.deepEqual(JSON.parse(output), { refused: true, counts: { install: 0, enable: 0, inspect: 0, gateway: 0 } });
      rmSync(s.tarball); writeFileSync(s.tarball, original);
      let restoredInstalls = 0;
      const restored = await preparePackedInstaller(s.candidate, s.fixture, s.tarball, async () => JSON.stringify(readArchive(s.tarball)), async () => { restoredInstalls++; });
      await restored.install(); assert.equal(restoredInstalls, 1);
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("refuses actual malformed-reader, child timeout and output overflow before installer and follow-on dispatch", async () => {
    const s = syntheticPackedInstall();
    const counts = { install: 0, enable: 0, inspect: 0, gateway: 0 };
    const run = async (read: () => Promise<string>) => {
      const admitted = await preparePackedInstaller(s.candidate, s.fixture, s.tarball, read, async () => { counts.install++; });
      await admitted.install(); counts.enable++; counts.inspect++; counts.gateway++;
    };
    try {
      writeFileSync(s.tarball, "not a gzip archive");
      await assert.rejects(run(() => command("/usr/bin/python3", ["-I", archiveReader, s.tarball], { cwd: s.fixture, env: fixtureEnv(s.fixture), timeoutMs: 30_000 })), /failed/);
      await assert.rejects(run(() => command(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { cwd: s.fixture, env: fixtureEnv(s.fixture), timeoutMs: 100 })), /deadline/);
      await assert.rejects(run(() => command(process.execPath, ["-e", "process.stdout.write('x'.repeat(1048577))"], { cwd: s.fixture, env: fixtureEnv(s.fixture), timeoutMs: 5_000 })), /output-cap/);
      assert.deepEqual(counts, { install: 0, enable: 0, inspect: 0, gateway: 0 });
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("accepts current public install metadata without config installs, while requiring import for runtime inspection", () => {
    const s = syntheticPackedInstall();
    try {
      assert.equal(freshPluginBootstrap({ file: join(s.fixture, "fixture.log") }, 12_345).plugins, undefined);
      assert.notEqual(s.proof.sourcePackageSha256, s.proof.manifestHashes["package.json"]);
      assert.equal(s.proof.expectedPublicationSha256, s.proof.manifestHashes["package.json"]);
      const result = verifyPackedPluginInspection(s.reports[0], s.fixture, s.states[0], s.tarball, s.proof);
      assert.equal(result.installedPath, s.reports[0].install.installPath); assert.equal(result.imported, false);
      assert.throws(() => verifyPackedPluginInspection(s.reports[0], s.fixture, s.states[0], s.tarball, s.proof, true));
      assert.equal(verifyPackedPluginInspection({ ...s.reports[0], plugin: { ...s.reports[0].plugin, imported: true } }, s.fixture, s.states[0], s.tarball, s.proof, true).imported, true);
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("refuses missing or ambiguous records and wrong public identity, enabled status, source and version", () => {
    const s = syntheticPackedInstall();
    try {
      const valid = s.reports[0];
      const bad: unknown[] = [null, [], {}, { plugin: valid.plugin }, { plugin: valid.plugin, install: [] }];
      for (const patch of [{ id: "other" }, { enabled: false }, { status: "disabled" }, { status: "error" }, { error: "failure" }, { version: "wrong" }, { packageName: "other" }, { packageName: null }, { packageName: 1 }, { packageVersion: "wrong" }, { packageVersion: null }, { packageVersion: 1 }]) bad.push({ ...valid, plugin: { ...valid.plugin, ...patch } });
      for (const patch of [{ source: "path" }, { version: "wrong" }, { sourcePath: "relative.tgz" }, { installPath: "relative-root" }, { resolvedName: "other" }, { resolvedVersion: "wrong" }]) bad.push({ ...valid, install: { ...valid.install, ...patch } });
      for (const report of bad) assert.throws(() => verifyPackedPluginInspection(report, s.fixture, s.states[0], s.tarball, s.proof));
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("requires each selected state to supply its own successful packed install and inspect provenance", () => {
    const s = syntheticPackedInstall();
    try {
      for (let i = 0; i < 2; i++) assert.equal(verifyPackedPluginInspection(s.reports[i], s.fixture, s.states[i], s.tarball, s.proof).installedPath, s.reports[i].install.installPath);
      assert.throws(() => verifyPackedPluginInspection(s.reports[0], s.fixture, s.states[1], s.tarball, s.proof));
      assert.throws(() => verifyPackedPluginInspection(s.reports[1], s.fixture, s.states[0], s.tarball, s.proof));
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("refuses another archive, workspace/root/entrypoint switches and redirected candidate code", () => {
    const s = syntheticPackedInstall();
    try {
      const valid = s.reports[0], other = join(s.fixture, "other.tgz"); writeFileSync(other, "other archive");
      for (const report of [
        { ...valid, install: { ...valid.install, sourcePath: other } },
        { ...valid, plugin: { ...valid.plugin, rootDir: s.reports[1].plugin.rootDir } },
        { ...valid, plugin: { ...valid.plugin, source: join(s.candidate, "dist", "index.js") } },
        { ...valid, plugin: { ...valid.plugin, source: join(valid.plugin.rootDir, "dist", "chunks", "fixture.js") } },
      ]) assert.throws(() => verifyPackedPluginInspection(report, s.fixture, s.states[0], s.tarball, s.proof));
      const entrypoint = valid.plugin.source; rmSync(entrypoint); symlinkSync(join(s.candidate, "dist", "index.js"), entrypoint);
      assert.throws(() => verifyPackedPluginInspection(valid, s.fixture, s.states[0], s.tarball, s.proof));
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("rejects changed or missing/extra packed chunks, changed manifests and altered original tarball", () => {
    const s = syntheticPackedInstall();
    try {
      const valid = s.reports[0], dist = join(valid.plugin.rootDir, "dist"), chunk = join(dist, "chunks", "fixture.js");
      const check = () => verifyPackedPluginInspection(valid, s.fixture, s.states[0], s.tarball, s.proof);
      const installedPackage = join(valid.plugin.rootDir, "package.json"), originalPackage = readFileSync(installedPackage);
      const parsedPackage = JSON.parse(originalPackage.toString());
      for (const mutation of [{ ...parsedPackage, name: "other-installed-package" }, { ...parsedPackage, version: "other-installed-version" }]) {
        writeFileSync(installedPackage, JSON.stringify(mutation));
        assert.throws(check, /Installed candidate manifest differs from packed source/);
        writeFileSync(installedPackage, originalPackage); assert.doesNotThrow(check);
      }
      writeFileSync(installedPackage, Buffer.concat([originalPackage, Buffer.from("\n")]));
      assert.deepEqual(JSON.parse(readFileSync(installedPackage, "utf8")), parsedPackage);
      assert.throws(check, /Installed candidate manifest differs from packed source/);
      writeFileSync(installedPackage, originalPackage); assert.doesNotThrow(check);
      writeFileSync(chunk, "changed chunk"); assert.throws(check);
      writeFileSync(chunk, "synthetic chunk NEVER executed"); writeFileSync(join(dist, "extra.js"), "unexpected"); assert.throws(check);
      rmSync(join(dist, "extra.js")); rmSync(chunk); assert.throws(check);
      writeFileSync(chunk, "synthetic chunk NEVER executed"); writeFileSync(join(valid.plugin.rootDir, "npm-shrinkwrap.json"), "changed manifest"); assert.throws(check);
      writeFileSync(join(valid.plugin.rootDir, "npm-shrinkwrap.json"), "{}"); writeFileSync(s.tarball, "changed original archive"); assert.throws(check);
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("starts each install state with fresh local logging and port, without previous plugin paths or auth", () => {
    const config = freshPluginBootstrap({ file: "/synthetic-owned/log" }, 12_345);
    assert.deepEqual(Object.keys(config).sort(), ["gateway", "logging"]);
    assert.deepEqual(config.gateway, { mode: "local", bind: "loopback", port: 12_345 });
    assert.equal(config.plugins, undefined); assert.equal(config.gateway!.auth, undefined);
    assert.throws(() => freshPluginBootstrap({ file: "/synthetic-owned/log" }, 0));
    assert.throws(() => freshPluginBootstrap({ file: "/synthetic-owned/log" }, 65_536));
  });

  it("rejects unreviewed packed identity, dependency, compatibility, entrypoint, scripts and bytes transforms", () => {
    const s = syntheticPackedInstall();
    try {
      const original = JSON.parse(Buffer.from(s.members[0].bytes, "base64").toString());
      const mutations = [{ ...original, name: "other" }, { ...original, version: "other" }, { ...original, dependencies: { "inert-fixture": "9.9.9" } }, { ...original, openclaw: { ...original.openclaw, minHostVersion: "other" } }, { ...original, openclaw: { ...original.openclaw, extensions: ["./dist/other.js"] } }, { ...original, scripts: { ...original.scripts, prepack: "unreviewed" } }];
      for (const mutation of mutations) {
        writeArchive(s.tarball, [{ ...s.members[0], bytes: Buffer.from(JSON.stringify(mutation, null, 2)).toString("base64") }, ...s.members.slice(1)]);
        assert.throws(() => packedCandidateProof(s.candidate, s.tarball, readArchive(s.tarball)), /Actual packed package differs/);
      }
      writeArchive(s.tarball, [{ ...s.members[0], bytes: Buffer.concat([Buffer.from(s.members[0].bytes, "base64"), Buffer.from("\n")]).toString("base64") }, ...s.members.slice(1)]);
      assert.throws(() => packedCandidateProof(s.candidate, s.tarball, readArchive(s.tarball)), /Actual packed package differs/);
      for (const source of [{ ...s.source, publishConfig: { directory: "other" } }, { ...s.source, scripts: { ...s.source.scripts, beforePacking: "other" } }, { ...s.source, dependencies: { fixture: "workspace:*" } }]) assert.throws(() => expectedPublishedPackage(source));
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("rejects missing, changed and extra actual packed chunks or source manifests", () => {
    const s = syntheticPackedInstall();
    try {
      for (const members of [s.members.slice(0, -1), [...s.members.slice(0, -1), { ...s.members.at(-1)!, bytes: Buffer.from("other").toString("base64") }], [...s.members, { name: "package/dist/extra.js", bytes: Buffer.from("other").toString("base64") }], s.members.map((member) => member.name.endsWith("npm-shrinkwrap.json") ? { ...member, bytes: Buffer.from("other").toString("base64") } : member)]) {
        writeArchive(s.tarball, members); assert.throws(() => packedCandidateProof(s.candidate, s.tarball, readArchive(s.tarball)));
      }
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

  it("fails closed on missing, duplicate, traversing, linked, oversized, truncated and corrupt archive members", () => {
    const s = syntheticPackedInstall();
    try {
      for (const members of [s.members.slice(1), [...s.members, s.members[0]], [...s.members, { name: "package/../escape", bytes: "" }], [...s.members, { name: "package/link", kind: "link" }], s.members.map((member) => member.name.endsWith("package.json") ? { ...member, bytes: Buffer.alloc(1_048_577).toString("base64") } : member)]) {
        writeArchive(s.tarball, members); assert.throws(() => readArchive(s.tarball));
      }
      writeArchive(s.tarball, s.members); const valid = readFileSync(s.tarball);
      writeFileSync(s.tarball, valid.subarray(0, valid.length - 6)); assert.throws(() => readArchive(s.tarball));
      const corrupt = Buffer.from(valid); corrupt[corrupt.length - 8] ^= 255; writeFileSync(s.tarball, corrupt); assert.throws(() => readArchive(s.tarball));
      writeFileSync(s.tarball, "not gzip"); assert.throws(() => readArchive(s.tarball));
    } finally { rmSync(s.fixture, { recursive: true, force: true }); }
  });

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
