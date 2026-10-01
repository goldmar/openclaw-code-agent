import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, join } from "node:path";

export const FIXTURE_MARKER = "oca-issue-504-host-acceptance-v1";
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const EVIDENCE_FILE_LIMIT = 1_048_576;
const EVIDENCE_BUNDLE_LIMIT = 8 * EVIDENCE_FILE_LIMIT;

/** Private fixture receipts only: bounded collection, no runtime policy changes. */
export class HostEvidence {
  readonly path: string;
  readonly errors: string[] = [];
  readonly secrets: string[] = ["synthetic-local-fixture-only", "synthetic-invalid"];
  readonly paths: string[] = [];
  readonly failures: Array<{ stage: string; errorClass: string; message: string; causeClasses: string[]; code?: string }> = [];
  private readonly streams = new Map<string, { kind: "proof" | "diagnostic"; data: Buffer; total: number; hash: ReturnType<typeof createHash> }>();
  private commands = 0;
  constructor(parent: string, node: string, readonly candidateSha: string) {
    assert.match(candidateSha, /^[a-f0-9]{40}$/);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    assert.equal(realpathSync(parent), resolve(parent), "Receipt parent must not redirect through a symlink");
    this.path = join(parent, `host-${node.replace(/[^\w.-]/g, "")}-${candidateSha}-${randomUUID()}`);
    mkdirSync(this.path, { mode: 0o700 });
    writeFileSync(join(this.path, ".fixture-owner"), FIXTURE_MARKER, { mode: 0o600 });
  }
  sanitize(value: string): string {
    for (const secret of this.secrets.filter(Boolean).sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, "[fixture-credential]");
    for (const path of this.paths.filter(Boolean).sort((a, b) => b.length - a.length)) value = value.replaceAll(path, "[owned-path]");
    return value.replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [credential]");
  }
  append(file: string, value: string | Buffer, kind: "proof" | "diagnostic" = "proof"): void {
    assert.match(file, /^[\w.-]+$/);
    const bytes = Buffer.from(value);
    let stream = this.streams.get(file);
    if (!stream) {
      if (this.streams.size >= 512) { if (!this.errors.includes("stream-count-overflow")) this.errors.push("stream-count-overflow"); return; }
      stream = { kind, data: Buffer.alloc(0), total: 0, hash: createHash("sha256") }; this.streams.set(file, stream);
    }
    stream.total += bytes.length; stream.hash.update(bytes);
    const limit = kind === "diagnostic" ? 65_536 : EVIDENCE_FILE_LIMIT;
    if (kind === "proof" && stream.total > limit) {
      if (!this.errors.includes(`proof-overflow:${file}`)) this.errors.push(`proof-overflow:${file}`);
      return;
    }
    const next = Buffer.concat([stream.data, bytes]);
    const retained = next.subarray(Math.max(0, next.length - limit));
    const total = [...this.streams.values()].reduce((sum, item) => sum + item.data.length, 0) - stream.data.length + retained.length;
    if (total > EVIDENCE_BUNDLE_LIMIT - EVIDENCE_FILE_LIMIT - 128) { if (!this.errors.includes("bundle-overflow")) this.errors.push("bundle-overflow"); return; }
    stream.data = Buffer.from(retained);
  }
  record(file: string, value: unknown): void { this.append(file, `${JSON.stringify(value)}\n`); }
  failure(stage: "provider-json" | "provider-schema" | "provider-scenario" | "provider-stream" | "native-observer", error: unknown): void {
    if (this.failures.length >= 128) { if (!this.errors.includes("failure-record-count-overflow")) this.errors.push("failure-record-count-overflow"); return; }
    const classes = new Set(["Error", "SyntaxError", "TypeError", "RangeError", "AssertionError", "AggregateError"]);
    const errorClass = (value: unknown) => value instanceof Error && classes.has(value.name) ? value.name : "UnknownError";
    const causeClasses: string[] = [];
    let cause = error instanceof Error ? error.cause : undefined;
    for (let depth = 0; cause !== undefined && depth < 3; depth++) { causeClasses.push(errorClass(cause)); cause = cause instanceof Error ? cause.cause : undefined; }
    const code = (error as NodeJS.ErrnoException)?.code;
    const record = { stage, errorClass: errorClass(error), message: this.sanitize(`Local fixture ${stage} failed`), causeClasses,
      code: ["EACCES", "EPERM", "ENOENT", "ESRCH", "EIO"].includes(code!) ? code : undefined };
    assert.ok(Buffer.byteLength(record.message) <= 1_024);
    this.failures.push(record); this.record(stage === "native-observer" ? "host-events.jsonl" : "provider.jsonl", { failure: record });
  }
  command(command: string, args: string[]) {
    const id = ++this.commands;
    if (id > 999) { if (!this.errors.includes("command-count-overflow")) this.errors.push("command-count-overflow"); return; }
    this.record("commands.jsonl", { id, command, args });
    return { stdout: `command-${id}-stdout.log`, stderr: `command-${id}-stderr.log`, finish: (value: unknown) => this.record("commands.jsonl", { id, outcome: value }) };
  }
  copyProof(file: string, path: string): void {
    if (!existsSync(path)) return;
    if (statSync(path).size > EVIDENCE_FILE_LIMIT) { this.errors.push(`proof-overflow:${file}`); return; }
    this.append(file, readFileSync(path));
  }
  persist(node: string, status: string, teardownVerified: boolean): { path: string; manifestSha256: string } {
    const files: Array<{ file: string; bytes: number; sha256: string; kind: string; truncated: boolean; totalBytes: number; observedSha256: string }> = [];
    let bytes = 0;
    for (const [file, stream] of this.streams) {
      const data = Buffer.from(this.sanitize(stream.data.toString()));
      if (data.length > EVIDENCE_FILE_LIMIT || bytes + data.length > EVIDENCE_BUNDLE_LIMIT - EVIDENCE_FILE_LIMIT - 128) { this.errors.push(`write-overflow:${file}`); continue; }
      writeFileSync(join(this.path, file), data, { mode: 0o600 }); bytes += data.length;
      files.push({ file, bytes: data.length, sha256: sha256(data), kind: stream.kind, truncated: stream.total > stream.data.length, totalBytes: stream.total, observedSha256: stream.hash.copy().digest("hex") });
    }
    const manifest = Buffer.from(JSON.stringify({ candidateSha: this.candidateSha, node, status: this.errors.length || this.failures.length ? "BLOCKED" : status, teardownVerified, files, errors: this.errors }));
    assert.ok(manifest.length <= EVIDENCE_FILE_LIMIT && bytes + manifest.length <= EVIDENCE_BUNDLE_LIMIT);
    writeFileSync(join(this.path, "manifest.json"), manifest, { mode: 0o600 });
    return { path: this.path, manifestSha256: sha256(manifest) };
  }
}

/** Close only the response owned by the local model fixture; never retry it. */
export function closeFailedProviderResponse(response: Pick<ServerResponse, "headersSent" | "destroyed" | "writableEnded" | "writeHead" | "end" | "destroy">, evidence: HostEvidence): void {
  try {
    if (!response.headersSent && !response.destroyed && !response.writableEnded) { response.writeHead(500); response.end("fixture protocol failure"); }
    else if (!response.destroyed) response.destroy();
  } catch (error) {
    evidence.failure("provider-stream", error);
    try { if (!response.destroyed) response.destroy(); }
    catch (closeError) { evidence.failure("provider-stream", closeError); }
  }
}

/** Every mutable path must be under the newly created, marked fixture root. */
export function ownedPath(root: string, path: string): string {
  assert.equal(readFileSync(join(root, ".fixture-owner"), "utf8"), FIXTURE_MARKER);
  const candidate = resolve(path);
  const rel = relative(realpathSync(root), candidate);
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), "Path must stay inside the fixture root");
  // Verify the nearest existing ancestor as well, rejecting symlink escapes.
  let ancestor = candidate;
  while (!existsSync(ancestor)) ancestor = resolve(ancestor, "..");
  const actual = relative(realpathSync(root), realpathSync(ancestor));
  assert.ok(actual !== ".." && !actual.startsWith(`..${sep}`) && !isAbsolute(actual), "Existing ancestor must stay inside the fixture root");
  return candidate;
}

/** Deliberately do not inherit provider keys, brokers, auth stores or host controls. */
export function fixtureEnv(root: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  ownedPath(root, join(root, "home"));
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ"] as const) {
    if (source[name]) env[name] = source[name];
  }
  return {
    ...env,
    HOME: join(root, "home"),
    OPENCLAW_HOME: join(root, "home"),
    OPENCLAW_STATE_DIR: join(root, "state"),
    OPENCLAW_CONFIG_PATH: join(root, "config.json"),
    CODEX_HOME: join(root, "codex"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", GH_CONFIG_DIR: join(root, "gh"),
    OPENCLAW_DISABLE_BONJOUR: "1", OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
    OPENCLAW_NO_RESPAWN: "1", OPENCLAW_SKIP_CHANNELS: "1",
    NPM_CONFIG_USERCONFIG: join(root, "npm-user.conf"), NPM_CONFIG_GLOBALCONFIG: join(root, "npm-global.conf"),
    NPM_CONFIG_CACHE: join(root, "npm-cache"), NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NPM_CONFIG_PROXY: "", NPM_CONFIG_HTTPS_PROXY: "",
    OCA504_FIXTURE_KEY: "synthetic-local-fixture-only",
  };
}

export function requireCandidate(actualHead: string, expectedHead: string, trackedStatus: string): void {
  assert.match(expectedHead, /^[a-f0-9]{40}$/);
  assert.equal(actualHead.trim(), expectedHead, "Acceptance requires the exact expected commit");
  assert.equal(trackedStatus.trim(), "", "Acceptance requires a clean tracked candidate");
}

export async function until<T>(read: () => T | undefined | Promise<T | undefined>, label: string, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`BLOCKED: ${label} did not reach its required boundary within ${timeoutMs} ms`);
}

export async function command(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; evidence?: HostEvidence }): Promise<string> {
  const receipt = options.evidence?.command(command, args);
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  trackOwnedChild(child);
  let stdout = "", stderr = "", overflow = false;
  child.stdout.on("data", (chunk) => { if (receipt) options.evidence!.append(receipt.stdout, chunk, "diagnostic"); overflow ||= Buffer.byteLength(stdout) + chunk.length > EVIDENCE_FILE_LIMIT; stdout = (stdout + chunk).slice(-EVIDENCE_FILE_LIMIT); });
  child.stderr.on("data", (chunk) => { if (receipt) options.evidence!.append(receipt.stderr, chunk, "diagnostic"); stderr = (stderr + chunk).slice(-EVIDENCE_FILE_LIMIT); });
  return await new Promise((done, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopOwnedChild(child).catch(reject);
    }, options.timeoutMs ?? 120_000);
    child.once("error", (error) => { receipt?.finish({ startupError: error.name }); clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      receipt?.finish({ code, signal, timedOut, outputOverflow: overflow });
      void stopOwnedChild(child).then(() => {
        if (timedOut || overflow || code !== 0 || signal) reject(new Error(`BLOCKED: ${command} failed (${timedOut ? "deadline" : overflow ? "output-cap" : code ?? signal}); output hash ${sha256(stderr)}`));
        else done(stdout.trim());
      }, reject);
    });
  });
}

type OwnedChild = { identities: Map<number, ProcessIdentity>; group?: number; error?: unknown; timer?: NodeJS.Timeout };
const childOwnership = new WeakMap<ChildProcess, OwnedChild>();
/** Record kernel lifetime ownership before a root can exit or change executable. */
export function trackOwnedChild(child: ChildProcess): void {
  const owned: OwnedChild = { identities: new Map() }; childOwnership.set(child, owned);
  child.once("spawn", () => {
    try {
      const root = processIdentity(child.pid!);
      if (root) { assert.equal(root.parentPid, process.pid); assert.equal(root.group, child.pid); owned.identities.set(root.pid, root); owned.group = root.group; }
      owned.timer = setInterval(() => { try { captureDescendants(owned.identities); } catch (error) { owned.error ??= error; } }, 250);
    } catch (error) { owned.error = error; }
  });
  child.once("close", () => { if (owned.timer) clearInterval(owned.timer); });
}
function liveGroupMembers(group: number): number[] {
  const members: number[] = [];
  for (const name of readdirSync("/proc").filter((item) => /^\d+$/.test(item))) {
    try { const fields = readFileSync(`/proc/${name}/stat`, "utf8").split(") ").at(-1)!.split(" "); if (Number(fields[2]) === group && fields[0] !== "Z") members.push(Number(name)); }
    catch (error) { if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code!)) throw error; }
  }
  return members;
}
/** Signal only still-identical captured PIDs. A group ID alone confers no ownership. */
export async function stopOwnedChild(child: ChildProcess): Promise<void> {
  assert.ok(child.pid);
  const owned = childOwnership.get(child);
  assert.ok(owned, "BLOCKED: missing owned-child admission proof");
  if (owned.timer) clearInterval(owned.timer);
  const ended = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((done) => child.once("close", () => done()));
  await cleanupAll([
    () => captureDescendants(owned.identities),
    () => stopNativeProcesses(owned.identities),
    async () => {
      let closeTimer: NodeJS.Timeout;
      try { await Promise.race([ended, new Promise<never>((_done, reject) => { closeTimer = setTimeout(() => reject(new Error("BLOCKED: owned child did not close")), 5_000); })]); }
      finally { clearTimeout(closeTimer); }
    },
    () => assert.equal(liveGroupMembers(owned.group ?? child.pid).length, 0, "BLOCKED: unproven live process remains in formerly owned group; refusing foreign signal"),
    () => { if (owned.error) throw owned.error; },
  ]);
}

export const NATIVE_CODEX_VERSION = "0.159.3";
export const NATIVE_CODEX_SHA256 = "8bf204b36a2f6dd0dab73aa2f639892e67ef9ac8befccb4a05b1496ebf25c479";
/** Validate bytes before executing a caller-supplied path, including --version. */
export function validateNativeExecutable(bytes: Buffer, version: string): void {
  assert.equal(version, NATIVE_CODEX_VERSION, "Only the reviewed native version is accepted");
  assert.equal(bytes.subarray(0, 4).toString("hex"), "7f454c46", "Native executable must be ELF");
  assert.equal(bytes[4], 2, "Native executable must be ELF64");
  assert.equal(bytes[5], 1, "Native executable must be little endian");
  assert.equal(bytes.readUInt16LE(18), 62, "Native executable must be x86-64");
  assert.equal(sha256(bytes), NATIVE_CODEX_SHA256, "Native executable does not match the independently reviewed official archive member");
}

export type FixtureCall = { name: string; args: Record<string, unknown> };
export function responseFrames(output: Record<string, unknown>[], model: string): string {
  const id = `resp_oca504_${randomUUID()}`;
  const completed: Record<string, unknown> = {
    id, object: "response", created_at: Math.floor(Date.now() / 1_000), status: "completed",
    model, output, error: null, incomplete_details: null,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  };
  const frames: Record<string, unknown>[] = [{ type: "response.created", response: { ...completed, status: "in_progress", output: [] } }];
  output.forEach((item, index) => {
    frames.push({ type: "response.output_item.added", output_index: index, item: { ...item, status: "in_progress", ...(item.type === "message" ? { content: [] } : { arguments: "" }) } });
    if (item.type === "message") {
      const content = item.content as Array<Record<string, unknown>>;
      frames.push({ type: "response.content_part.added", output_index: index, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] as unknown[], logprobs: [] as unknown[] } });
      frames.push({ type: "response.output_text.delta", output_index: index, item_id: item.id, content_index: 0, delta: content[0].text, logprobs: [] });
      frames.push({ type: "response.output_text.done", output_index: index, item_id: item.id, content_index: 0, text: content[0].text, logprobs: [] });
      frames.push({ type: "response.content_part.done", output_index: index, item_id: item.id, content_index: 0, part: content[0] });
    } else if (item.type === "function_call") {
      frames.push({ type: "response.function_call_arguments.delta", output_index: index, item_id: item.id, delta: item.arguments });
      frames.push({ type: "response.function_call_arguments.done", output_index: index, item_id: item.id, arguments: item.arguments });
    }
    frames.push({ type: "response.output_item.done", output_index: index, item });
  });
  frames.push({ type: "response.completed", response: completed });
  return frames.map((frame, sequence_number) => `event: ${frame.type}\ndata: ${JSON.stringify({ ...frame, sequence_number })}\n\n`).join("");
}
export const messageItem = (text: string) => ({ type: "message", id: `msg_${randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] as unknown[], logprobs: [] as unknown[] }] });
export const functionItem = (call: FixtureCall) => ({ type: "function_call", id: `fc_${randomUUID()}`, call_id: `call_${randomUUID()}`, name: call.name, arguments: JSON.stringify(call.args), status: "completed" });

export type ProcessIdentity = { pid: number; parentPid: number; group: number; startTicks: string; executable: string };
export function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
    if (fields[0] === "Z") return undefined;
    return { pid, parentPid: Number(fields[1]), group: Number(fields[2]), startTicks: fields[19], executable: realpathSync(`/proc/${pid}/exe`) };
  } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code!)) return undefined; throw error; }
}
export function sameProcess(expected: ProcessIdentity): boolean {
  try {
    const fields = readFileSync(`/proc/${expected.pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
    return sameProcessFields(fields, expected.startTicks);
  } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code!)) return false; throw error; }
}
export function sameProcessFields(fields: string[], startTicks: string): boolean { return fields[0] !== "Z" && fields[19] === startTicks; }
export function currentDescendant(snapshot: Pick<ProcessIdentity, "pid" | "parentPid" | "startTicks">, identity: ProcessIdentity, parent: ProcessIdentity): boolean {
  return identity.pid === snapshot.pid && identity.startTicks === snapshot.startTicks && identity.parentPid === snapshot.parentPid && snapshot.parentPid === parent.pid && sameProcess(parent);
}
export function ignorableProcReadFailure(code: string | undefined, knownOwned: boolean): boolean {
  return code === "ENOENT" || code === "ESRCH" || (!knownOwned && (code === "EACCES" || code === "EPERM"));
}
/** Capture only descendants proven from recorded native/relay roots, before reparenting. */
export function captureDescendants(owned: Map<number, ProcessIdentity>): void {
  // Read only PID/parent metadata for unowned processes. Executable resolution
  // is restricted to a currently proven descendant; root-owned /proc entries
  // may legitimately be inaccessible to the unprivileged remote runner.
  const processes: Array<{ pid: number; parentPid: number; startTicks: string }> = [];
  for (const name of readdirSync("/proc").filter((item) => /^\d+$/.test(item))) {
    try {
      const fields = readFileSync(`/proc/${name}/stat`, "utf8").split(") ").at(-1)!.split(" ");
      processes.push({ pid: Number(name), parentPid: Number(fields[1]), startTicks: fields[19] });
    } catch (error) {
      if (!ignorableProcReadFailure((error as NodeJS.ErrnoException).code, owned.has(Number(name)))) throw error;
    }
  }
  let added = true;
  while (added) {
    added = false;
    for (const item of processes) {
      if (owned.has(item.pid)) continue;
      const parent = owned.get(item.parentPid);
      if (parent && sameProcess(parent)) {
        const identity = processIdentity(item.pid);
        if (identity && currentDescendant(item, identity, parent)) { owned.set(item.pid, identity); added = true; }
      }
    }
  }
}
export async function stopNativeProcesses(owned: Map<number, ProcessIdentity>): Promise<void> {
  const errors: unknown[] = [];
  const unproved = new Set<number>();
  try { captureDescendants(owned); } catch (error) { errors.push(error); }
  const live = (identity: ProcessIdentity) => {
    if (unproved.has(identity.pid)) return false;
    try { return sameProcess(identity); }
    catch (error) { errors.push(error); unproved.add(identity.pid); return false; }
  };
  const signal = (identity: ProcessIdentity, value: NodeJS.Signals) => {
    if (!live(identity)) return;
    try { process.kill(identity.pid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(error); }
  };
  for (const identity of [...owned.values()].reverse()) {
    // Signal only the still-identical captured process, avoiding reused/foreign groups.
    signal(identity, "SIGTERM");
  }
  try { await until(() => [...owned.values()].every((item) => !live(item)) ? true : undefined, "owned native descendants graceful teardown", 5_000); }
  catch {
    for (const identity of [...owned.values()].reverse()) signal(identity, "SIGKILL");
    try { await until(() => [...owned.values()].every((item) => !live(item)) ? true : undefined, "owned native descendants forced teardown", 5_000); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "BLOCKED: owned process cleanup proof failed");
}
/** A failed resource never prevents cleanup of later resources. */
export async function cleanupAll(actions: Array<() => void | Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const action of actions) { try { await action(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, "BLOCKED: owned fixture cleanup failed");
}

/** Identity-preserving observer: real Codex owns every RPC byte and outcome. */
export function writeNativeRelay(root: string, nativeExecutable: string): string {
  const relay = ownedPath(root, join(root, "native-codex-relay.mjs"));
  const capture = ownedPath(root, join(root, "native-events.jsonl"));
  writeFileSync(relay, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync, existsSync, statSync, writeFileSync } from 'node:fs';
const incomplete=${JSON.stringify(join(root, "capture-incomplete"))};
const append=record=>{const text=JSON.stringify(record)+'\\n';if((existsSync(${JSON.stringify(capture)})?statSync(${JSON.stringify(capture)}).size:0)+Buffer.byteLength(text)>1048576){writeFileSync(incomplete,'native-proof-overflow',{mode:0o600});return;}appendFileSync(${JSON.stringify(capture)},text,{mode:0o600});};
const child = spawn(${JSON.stringify(nativeExecutable)}, process.argv.slice(2), { env: process.env, stdio: ['pipe','pipe','pipe'] });
const identity=pid=>{const f=readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).split(' ');return {pid,parentPid:Number(f[1]),group:Number(f[2]),startTicks:f[19],executable:realpathSync('/proc/'+pid+'/exe')};};
try {
 append({nativeIdentity:identity(child.pid),relayIdentity:identity(process.pid),spawnedNativePid:child.pid,relayPid:process.pid,argv:process.argv.slice(2),executableHash:createHash('sha256').update(readFileSync('/proc/'+child.pid+'/exe')).digest('hex')});
} catch {
 process.stderr.write('Native observation admission failed\\n');
 child.kill('SIGTERM');
 const deadline=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},5000);
 child.once('close',()=>{clearTimeout(deadline);process.exit(1);});
}

const observe = (stream, direction) => {
  let pending='';
  stream.on('data', bytes => {
    pending += bytes.toString();
    if (Buffer.byteLength(pending) > 1048576) { writeFileSync(incomplete,'native-frame-overflow',{mode:0o600}); pending=''; return; }
    for (;;) {
      const end=pending.indexOf('\\n'); if(end<0) break;
      const line=pending.slice(0,end); pending=pending.slice(end+1); if(!line.trim())continue;
      try {
        const frame=JSON.parse(line);
        const nativeInput=(frame.params?.input??[]).filter(part=>part.type==='text'&&typeof part.text==='string').map(part=>({sha256:createHash('sha256').update(part.text).digest('hex'),sentinel:/^(1|REPEAT-[\\w-]+|INTENTIONAL_REPEAT)$/.test(part.text)?part.text:part.text.match(/OCA504_NATIVE[_:]?[\\w-]*/)?.[0]}));
        const mismatch=typeof frame.error?.message==='string'?/^expected active turn id \x60([^\x60]+)\x60 but found \x60([^\x60]+)\x60$/.exec(frame.error.message):null;
        const record={relayPid:process.pid,direction, method:frame.method, id:frame.id, userAgent:frame.result?.userAgent,nativeInput,expectedTurnId:frame.params?.expectedTurnId,
          threadId:frame.params?.threadId ?? frame.result?.thread?.id,
          turnId:frame.params?.turn?.id ?? frame.result?.turn?.id ?? frame.result?.turnId, status:frame.params?.turn?.status, error:Boolean(frame.error),
          errorCode:typeof frame.error?.code==='number'?frame.error.code:undefined,errorDataPresent:frame.error?.data!=null,
          noActiveTurn:frame.error?.message==='no active turn to steer',mismatchExact:Boolean(mismatch&&mismatch[0]===frame.error.message),mismatchExpected:mismatch?.[1],mismatchActual:mismatch?.[2]};
        append(record);
      } catch { try{writeFileSync(incomplete,'native-observation-incomplete',{mode:0o600});}catch{} }
    }
  });
};
observe(process.stdin,'request'); observe(child.stdout,'response');
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
process.stdin.on('end',()=>child.stdin.end());
child.on('error',()=>{process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
child.on('close',(code,signal)=>{ if(signal) { process.removeAllListeners(signal); process.kill(process.pid,signal); } else process.exit(code ?? 1); });
`, { mode: 0o700 });
  return relay;
}

/** Observation hooks never return policy, parameters or replacement results. */
export function writeHostObserver(root: string): { path: string; hash: string } {
  const path = ownedPath(root, join(root, "host-observer"));
  // Caller creates this directory before asking for any child path.
  const capture = ownedPath(root, join(root, "host-tools.jsonl"));
  const source = `import {appendFileSync,existsSync,statSync,writeFileSync} from 'node:fs';import{createHash}from'node:crypto';
const append=(phase,event,ctx)=>{
 if(!event.toolName?.startsWith('agent_')&&!['tool_call','tool_search','tool_describe'].includes(event.toolName))return;
 const params=event.toolName==='tool_call'?event.params?.args:event.params;
 const input=typeof params?.message==='string'?createHash('sha256').update(params.message).digest('hex'):undefined;
 const result=event.result?.details?.result??event.result;
 const text=JSON.stringify({phase,toolName:event.toolName,toolCallId:event.toolCallId??ctx.toolCallId,session:params?.session,inputHash:input,status:result?.details?.status,code:result?.details?.code,isError:result?.isError,targetSelected:result?.details?.targetSelected,operationStarted:result?.details?.operationStarted,recoveryPresent:typeof result?.details?.recovery==='string',recoveryClass:typeof result?.details?.recovery==='string'?'provided':undefined,outerStatus:event.result?.details?.status,error:Boolean(event.error)})+'\\n';
 try{if((existsSync(${JSON.stringify(capture)})?statSync(${JSON.stringify(capture)}).size:0)+Buffer.byteLength(text)>1048576)throw Error();appendFileSync(${JSON.stringify(capture)},text,{mode:0o600});}catch{try{writeFileSync(${JSON.stringify(join(root, "capture-incomplete"))},'host-observation-incomplete',{mode:0o600});}catch{}}
};
export default{id:'oca504-observer',name:'Disposable OCA504 observer',register(api){api.on('before_tool_call',(event,ctx)=>{append('before',event,ctx);});api.on('after_tool_call',(event,ctx)=>{append('after',event,ctx);});}};
`;
  writeFileSync(ownedPath(root, join(path, "index.mjs")), source, { mode: 0o600 });
  writeFileSync(ownedPath(root, join(path, "openclaw.plugin.json")), JSON.stringify({ id: "oca504-observer", configSchema: { type: "object", additionalProperties: false, properties: {} } }), { mode: 0o600 });
  writeFileSync(ownedPath(root, join(path, "package.json")), JSON.stringify({ name: "oca504-observer", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] } }), { mode: 0o600 });
  return { path, hash: sha256(source) };
}
