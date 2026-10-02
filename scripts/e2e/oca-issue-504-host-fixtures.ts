import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { closeSync, constants, fstatSync, openSync, readSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PersistedSessionInfo } from "../../src/types";

export const FIXTURE_MARKER = "oca-issue-504-host-acceptance-v1";
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** Persisted Git-only fixture data, never a native thread or delivery receipt. */
export function gitFixtureRow(root: string, coordinates: { repo: string; path: string; branch: string; name: string }): PersistedSessionInfo {
  const now = Date.now();
  return { sessionId: `fixture-${randomUUID()}`, harnessSessionId: `fixture-storage-${randomUUID()}`,
    backendRef: { kind: "codex-app-server", conversationId: `fixture-backend-${randomUUID()}` },
    name: coordinates.name, prompt: "Synthetic Git-only fixture", workdir: ownedPath(root, coordinates.repo),
    createdAt: now, completedAt: now, status: "completed", lifecycle: "awaiting_worktree_decision", runtimeState: "stopped",
    approvalState: "not_required", pendingPlanApproval: false, costUsd: 0,
    route: { provider: "webchat", target: "agent:main:main", sessionKey: "agent:main:main" },
    originAgentId: "main", originChannel: "webchat", originSessionKey: "agent:main:main",
    worktreePath: ownedPath(root, coordinates.path), worktreeBranch: coordinates.branch, worktreeBaseBranch: "main",
    worktreeStrategy: "manual", worktreeMerged: false, worktreeState: "pending_decision",
    worktreeLifecycle: { state: "pending_decision", updatedAt: new Date(now).toISOString() } };
}
export function requireGitFixtureIdentities(rows: PersistedSessionInfo[], native: FixtureRecord): void {
  for (const field of ["sessionId", "harnessSessionId"] as const) {
    assert.ok(rows.every((row) => row[field] && row[field] !== native[field]));
    assert.equal(new Set(rows.map((row) => row[field])).size, rows.length);
  }
  const ids = rows.map((row) => row.backendRef?.conversationId);
  assert.ok(ids.every((id) => id && id !== native.backendRef?.conversationId)); assert.equal(new Set(ids).size, rows.length);
}
export function gitBarrierHook(path: string, entered: string, release: string): string {
  return `#!${process.execPath}\nconst{existsSync,writeFileSync}=require('node:fs');if(process.cwd()===${JSON.stringify(path)}){writeFileSync(${JSON.stringify(entered)},'entered');const end=Date.now()+30000;while(!existsSync(${JSON.stringify(release)})){if(Date.now()>end)process.exit(1);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}`;
}
export function observeGitCall(call: Promise<FixtureRecord>, variant: string, position: "first" | "second", sessionId: string, record: (value: FixtureRecord) => void) {
  const observed: { settled: boolean; result?: FixtureRecord; error?: unknown; done?: Promise<void> } = { settled: false };
  observed.done = call.then((result) => {
    observed.result = result; observed.settled = true;
    const content = (result.content ?? []).map((part: FixtureRecord) => typeof part.text === "string" ? part.text : "").join("\n");
    record({ phase: "git-public-outcome", variant, position, sessionId, contentBytes: Buffer.byteLength(content), contentSha256: sha256(content), contentExcerpt: Buffer.from(content).subarray(0, 512).toString(),
      ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
      ...Object.fromEntries(["status", "code", "targetSelected", "operationStarted"].filter((key) => ["string", "boolean"].includes(typeof result.details?.[key])).map((key) => [key, result.details[key]])) });
  }, (error: unknown) => {
    observed.error = error; observed.settled = true;
    const message = error instanceof Error ? error.message : String(error);
    record({ phase: "git-public-outcome", variant, position, sessionId, transportRejected: true, errorClass: error instanceof Error ? error.name : "UnknownError", causeSha256: sha256(message), causeExcerpt: Buffer.from(message).subarray(0, 512).toString() });
  });
  return observed;
}
export async function requireGitBarrier(observed: ReturnType<typeof observeGitCall>, entered: () => boolean, record: (value: FixtureRecord) => void, timeoutMs = 30_000): Promise<void> {
  try {
    await until(() => {
      if (entered()) return true;
      assert.equal(observed.settled, false, "BLOCKED: first public merge settled before its required hook barrier");
      return undefined;
    }, "real first merge pre-rebase hook barrier", timeoutMs);
  } catch (error) {
    record({ phase: "git-barrier-not-entered", publicOutcome: observed.settled ? "SETTLED" : "PENDING_UNPROVEN" }); throw error;
  }
}
export function gitCallResult(observed: ReturnType<typeof observeGitCall>): FixtureRecord {
  assert.ok(observed.settled, "Git public outcome is still pending/unproven");
  if (observed.error !== undefined) throw observed.error;
  assert.ok(observed.result); return observed.result;
}
export const HOST_COHORTS = ["smoke", "plan", "references", "retries", "git", "embedded-direct", "embedded-deferred", "all"] as const;
export type HostCohort = typeof HOST_COHORTS[number];
export function hostCohort(value: string | undefined): HostCohort {
  assert.ok(value === undefined || HOST_COHORTS.includes(value as HostCohort), "Unknown host acceptance cohort");
  return value === undefined ? "all" : value as HostCohort;
}
export function runsHostCohort(selected: HostCohort, block: Exclude<HostCohort, "smoke" | "all">): boolean {
  return selected === "all" || selected === block;
}
export function requiredHostScenarios(cohort: HostCohort): string[] {
  const references = ["four-tools-unknown-masked-blank", "real-host-auth-denied-unavailable", "native-older-exact-newer-name-backend-literal-mask-output", "native-persisted-resume"];
  const retries = ["same-actual-call-id-sequential", "same-actual-call-id-concurrent", "different-actual-call-id-identical-input"];
  const git = ["alias", "coordinates", "competing-decision", "policy", "merged-cleanup", "new-hooks"].map((name) => `real-git-queue-${name}`);
  switch (cohort) {
    case "smoke": return ["setup-native-protocol-smoke"];
    case "plan": return ["native-ask-approval-authority"];
    case "references": return references;
    case "retries": return retries;
    case "git": return git;
    case "embedded-direct": return ["direct"];
    case "embedded-deferred": return ["deferred"];
    case "all": return ["native-ask-approval-authority", ...references, ...retries, ...git, "direct", "deferred"];
  }
}
export function hostCohortCoverage(cohort: HostCohort, outcomes: Array<{ scenario: string; status: string }>) {
  const requiredScenarios = requiredHostScenarios(cohort), completedScenarios = outcomes.filter((outcome) => outcome.status === "PASS").map((outcome) => outcome.scenario);
  assert.equal(new Set(completedScenarios).size, completedScenarios.length, "Duplicate completed host scenario");
  assert.ok(completedScenarios.every((name) => requiredScenarios.includes(name)), "Unselected host scenario credited");
  return { selectedCohort: cohort, coverageScope: cohort === "all" ? "ONE_FLOOR_COMPLETE_HOST_MATRIX" : "PARTIAL", finalAcceptance: false,
    requiredScenarios, completedScenarios, remainingRequiredScenarios: requiredScenarios.filter((name) => !completedScenarios.includes(name)),
    not_run: [...new Set([...requiredHostScenarios("all"), ...requiredScenarios])].filter((name) => !completedScenarios.includes(name)) };
}
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

function exactCandidatePath(fixture: string, path: unknown): string {
  assert.ok(typeof path === "string" && isAbsolute(path) && path === resolve(path), "Candidate provenance requires a canonical absolute path");
  const candidate = ownedPath(fixture, path);
  const parts = relative(fixture, candidate).split(sep);
  let current = fixture;
  for (const part of parts) { current = join(current, part); assert.ok(!lstatSync(current).isSymbolicLink(), "Candidate code cannot redirect through a symlink"); }
  assert.equal(realpathSync(candidate), candidate);
  return candidate;
}

function candidateDistHashes(directory: string, prefix = ""): Record<string, string> {
  assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink());
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name), name = prefix + entry.name;
    assert.ok(!entry.isSymbolicLink(), "Packed candidate chunks cannot redirect to other code");
    assert.ok(entry.isDirectory() || entry.isFile(), "Packed candidate code must be regular files");
    return entry.isDirectory() ? Object.entries(candidateDistHashes(path, `${name}/`)) : [[name, sha256(readFileSync(path))]];
  }));
}

export type PackedArchiveProof = { tarballSha256: string; compressedBytes: number; decompressedBytes: number; physicalMembers: number; effectiveMembers: number;
  manifests: Record<string, { bytes: number; sha256: string; base64: string }>; distHashes: Record<string, string> };

/** Only the reviewed default pnpm 11 publication transformation is admitted. */
export function expectedPublishedPackage(source: Record<string, any>): Buffer {
  assert.equal(source.packageManager, "pnpm@11.15.1");
  assert.ok(source.pnpm === undefined, "Unreviewed package packing configuration");
  assert.ok(!source.scripts?.beforePacking && Object.keys(source.publishConfig ?? {}).every((key) => ["access", "provenance"].includes(key)), "Unreviewed publication override/hook");
  assert.ok(source.scripts?.prepack === "pnpm build", "The reviewed prepack build must remain unchanged");
  assert.ok(!source.scripts?.prepare && !source.scripts?.postpack && !source.scripts?.prepublishOnly, "Unreviewed publication lifecycle");
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const version of Object.values(source[key] ?? {})) assert.ok(typeof version === "string" && !/^(?:workspace|catalog|jsr):/.test(version), "Unsupported publication dependency protocol");
  }
  const { scripts, packageManager: _packageManager, pnpm: _pnpm, ...published } = source;
  published.scripts = Object.fromEntries(Object.entries(scripts ?? {}).filter(([key]) => !["prepublishOnly", "prepack", "prepare", "postpack", "publish", "postpublish"].includes(key)));
  return Buffer.from(JSON.stringify(published, null, 2));
}

export function validatePackSource(candidateRoot: string): Buffer {
  for (const name of ["package.yaml", "package.json5", ".pnpmfile.cjs", ".pnpmfile.mjs"]) assert.ok(!existsSync(join(candidateRoot, name)), "Unreviewed packing input");
  const workspace = readFileSync(join(candidateRoot, "pnpm-workspace.yaml"), "utf8");
  assert.ok(!/beforePacking|catalog(?:s)?:|publishConfig|executableFiles/.test(workspace), "Unreviewed workspace publication transform");
  return expectedPublishedPackage(JSON.parse(readFileSync(join(candidateRoot, "package.json"), "utf8")));
}

export function packedCandidateProof(candidateRoot: string, tarball: string, archive: PackedArchiveProof, evidence?: HostEvidence) {
  const sourceBytes = readFileSync(join(candidateRoot, "package.json")), source = JSON.parse(sourceBytes.toString());
  const expectedPublication = expectedPublishedPackage(source);
  const distHashes = candidateDistHashes(join(candidateRoot, "dist"));
  const digestMap = (map: Record<string, string>) => sha256(JSON.stringify(Object.entries(map).sort()));
  evidence?.record("host-events.jsonl", { phase: "source-packed-comparison", sourcePackageSha256: sha256(sourceBytes), expectedPublicationSha256: sha256(expectedPublication), actualPublicationSha256: archive.manifests["package.json"]?.sha256,
    sourceManifestHashes: Object.fromEntries(["openclaw.plugin.json", "npm-shrinkwrap.json"].map((name) => [name, sha256(readFileSync(join(candidateRoot, name)))])),
    builtDistMapSha256: digestMap(distHashes), actualDistMapSha256: digestMap(archive.distHashes), distMatches: digestMap(distHashes) === digestMap(archive.distHashes) });
  assert.equal(archive.tarballSha256, sha256(readFileSync(tarball)));
  const manifestBytes = Object.fromEntries(["package.json", "openclaw.plugin.json", "npm-shrinkwrap.json"].map((name) => {
    const member = archive.manifests[name]; assert.ok(member && Number.isInteger(member.bytes) && member.bytes <= 1_048_576);
    const bytes = Buffer.from(member.base64, "base64");
    assert.equal(bytes.toString("base64"), member.base64); assert.equal(bytes.length, member.bytes); assert.equal(sha256(bytes), member.sha256);
    return [name, bytes];
  }));
  assert.deepEqual(manifestBytes["package.json"], expectedPublication, "Actual packed package differs from reviewed pnpm publication bytes");
  for (const name of ["openclaw.plugin.json", "npm-shrinkwrap.json"]) assert.deepEqual(manifestBytes[name], readFileSync(join(candidateRoot, name)), "Packed manifest differs from source bytes");
  const pkg = JSON.parse(manifestBytes["package.json"].toString()), plugin = JSON.parse(manifestBytes["openclaw.plugin.json"].toString());
  assert.equal(pkg.name, "openclaw-code-agent"); assert.equal(pkg.name, source.name); assert.equal(pkg.version, source.version);
  assert.equal(plugin.id, pkg.name); assert.equal(plugin.version, pkg.version);
  assert.ok(Array.isArray(pkg.openclaw?.extensions) && pkg.openclaw.extensions.length === 1 && typeof pkg.openclaw.extensions[0] === "string");
  const entrypoint = relative(candidateRoot, resolve(candidateRoot, pkg.openclaw.extensions[0]));
  assert.ok(entrypoint && entrypoint !== ".." && !entrypoint.startsWith(`..${sep}`) && !isAbsolute(entrypoint));
  assert.deepEqual(archive.distHashes, distHashes, "Actual packed dist map differs from built candidate");
  assert.ok(entrypoint.startsWith(`dist${sep}`) && distHashes[entrypoint.slice(5)], "Declared entrypoint must belong to the verified dist map");
  return { id: plugin.id as string, packageName: pkg.name as string, version: pkg.version as string, entrypoint,
    tarballSha256: archive.tarballSha256, compressedBytes: archive.compressedBytes, distHashes, sourcePackageSha256: sha256(sourceBytes), expectedPublicationSha256: sha256(expectedPublication),
    manifestHashes: Object.fromEntries(Object.entries(archive.manifests).map(([name, member]) => [name, member.sha256])),
    manifestSizes: Object.fromEntries(Object.entries(archive.manifests).map(([name, member]) => [name, member.bytes])) };
}

/** Fresh synchronous archive admission before each supported installer dispatch. */
export function admitPackedArchive(fixture: string, tarball: string, proof: { tarballSha256: string; compressedBytes: number }, evidence?: HostEvidence): string {
  let actualSha256: string | undefined, bytes: number | undefined;
  try {
    const admitted = exactCandidatePath(fixture, tarball);
    const fd = openSync(admitted, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      assert.ok(before.isFile() && before.uid === process.getuid!() && before.size <= 33_554_432, "Archive admission requires a bounded owned regular file");
      const hash = createHash("sha256"), chunk = Buffer.alloc(65_536); let total = 0;
      for (let count; (count = readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
        total += count; assert.ok(total <= 33_554_432, "Archive admission byte cap"); hash.update(chunk.subarray(0, count));
      }
      const after = fstatSync(fd);
      assert.ok(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && total === after.size, "Archive changed during admission");
      actualSha256 = hash.digest("hex"); bytes = total;
      evidence?.record("host-events.jsonl", { phase: "archive-install-admission", expectedSha256: proof.tarballSha256, actualSha256, bytes });
      assert.equal(actualSha256, proof.tarballSha256, "Archive admission hash differs from observed packed bytes");
      assert.equal(bytes, proof.compressedBytes, "Archive admission size differs from observed packed bytes");
      return admitted;
    } finally { closeSync(fd); }
  } catch (error) {
    evidence?.record("host-events.jsonl", { phase: "archive-install-admission-refused", expectedSha256: proof.tarballSha256, actualSha256, bytes, errorClass: error instanceof Error ? error.name : "Unknown" });
    throw error;
  }
}

/** The real runner supplies its fixed reader command; utility adapters never start a host. */
export async function preparePackedInstaller(candidateRoot: string, fixture: string, tarball: string,
  readArchive: () => Promise<string>, install: (admittedArchive: string) => Promise<void>, evidence?: HostEvidence) {
  const output = await readArchive();
  const archive = JSON.parse(output) as PackedArchiveProof;
  evidence?.record("host-events.jsonl", { phase: "actual-packed-boundary", readerOutputSha256: sha256(output), tarballSha256: archive.tarballSha256,
    compressedBytes: archive.compressedBytes, decompressedBytes: archive.decompressedBytes,
    actualManifests: Object.fromEntries(Object.entries(archive.manifests).map(([name, member]) => [name, { sha256: member.sha256, bytes: member.bytes }])), distMapSha256: sha256(JSON.stringify(archive.distHashes)) });
  const proof = packedCandidateProof(candidateRoot, tarball, archive, evidence);
  return { proof, install: () => install(admitPackedArchive(fixture, tarball, archive, evidence)) };
}

/** Cold CLI metadata is provenance only; actual Gateway execution remains a separate gate. */
export function verifyPackedPluginInspection(report: unknown, fixture: string, state: string, tarball: string,
  proof: ReturnType<typeof packedCandidateProof>, runtime = false, evidence?: HostEvidence): { installedPath: string; source: string; version: string; imported: boolean } {
  assert.ok(report && typeof report === "object" && !Array.isArray(report));
  const { plugin, install } = report as Record<string, any>;
  assert.ok(plugin && typeof plugin === "object" && !Array.isArray(plugin) && install && typeof install === "object" && !Array.isArray(install), "Unambiguous public plugin and install records are required");
  assert.equal(plugin.id, proof.id); assert.equal(plugin.enabled, true); assert.equal(plugin.status, "loaded");
  assert.ok(!plugin.error); assert.equal(plugin.version, proof.version);
  if (plugin.packageName !== undefined) assert.equal(plugin.packageName, proof.packageName);
  if (plugin.packageVersion !== undefined) assert.equal(plugin.packageVersion, proof.version);
  assert.equal(install.source, "archive"); assert.equal(install.version, proof.version);
  if (install.resolvedName !== undefined) assert.equal(install.resolvedName, proof.packageName);
  if (install.resolvedVersion !== undefined) assert.equal(install.resolvedVersion, proof.version);
  const sourceArchive = exactCandidatePath(fixture, install.sourcePath);
  assert.equal(sourceArchive, exactCandidatePath(fixture, tarball));
  admitPackedArchive(fixture, sourceArchive, { tarballSha256: proof.tarballSha256, compressedBytes: proof.compressedBytes }, evidence);
  const installedPath = exactCandidatePath(fixture, install.installPath), selectedState = exactCandidatePath(fixture, state);
  const stateRelative = relative(selectedState, installedPath);
  assert.ok(stateRelative && !stateRelative.startsWith(`..${sep}`) && stateRelative !== ".." && !isAbsolute(stateRelative), "Another state's install cannot authorize this Gateway");
  assert.equal(exactCandidatePath(fixture, plugin.rootDir), installedPath);
  const source = exactCandidatePath(fixture, plugin.source);
  assert.equal(source, resolve(installedPath, proof.entrypoint), "Public plugin entrypoint must belong to the packed candidate");
  const installedDist = candidateDistHashes(join(installedPath, "dist"));
  evidence?.record("host-events.jsonl", { phase: "installed-dist-boundary", expectedDistMapSha256: sha256(JSON.stringify(Object.entries(proof.distHashes).sort())), actualDistMapSha256: sha256(JSON.stringify(Object.entries(installedDist).sort())) });
  const installedManifests: Array<{ expected: string; observed: string }> = [];
  for (const [name, hash] of Object.entries(proof.manifestHashes)) {
    const bytes = readFileSync(exactCandidatePath(fixture, join(installedPath, name))), observed = sha256(bytes);
    evidence?.record("host-events.jsonl", { phase: "installed-manifest-boundary", name, expectedSha256: hash, actualSha256: observed, bytes: bytes.length, matches: observed === hash });
    installedManifests.push({ expected: hash, observed });
  }
  assert.deepEqual(installedDist, proof.distHashes);
  for (const member of installedManifests) assert.equal(member.observed, member.expected, "Installed candidate manifest differs from packed source");
  if (runtime) assert.equal(plugin.imported, true, "Runtime inspection must report an actual import");
  return { installedPath, source, version: proof.version, imported: plugin.imported === true };
}

type FixtureRecord = Record<string, any>;

export function generationObservation(row: FixtureRecord | undefined, target: FixtureRecord) {
  const enums = (value: unknown) => typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : "unknown";
  return { exists: Boolean(row), selectedIdMatches: row?.sessionId === target.sessionId,
    selectedBackendMatches: Boolean(target.backendRef?.conversationId) && row?.backendRef?.conversationId === target.backendRef.conversationId,
    expectedNameMatches: row?.name === target.name, status: enums(row?.status), lifecycle: enums(row?.lifecycle), runtimeState: enums(row?.runtimeState) };
}
export function stoppedGeneration(row: FixtureRecord | undefined, target: FixtureRecord): boolean {
  const facts = generationObservation(row, target);
  assert.ok(facts.exists && facts.selectedIdMatches && facts.selectedBackendMatches, "Captured native generation identity changed");
  if (["starting", "running"].includes(facts.status)) return false;
  assert.ok(["completed", "killed"].includes(facts.status), "Unsupported native terminal status");
  assert.equal(facts.lifecycle, "terminal"); assert.equal(facts.runtimeState, "stopped");
  return true;
}
export function killResultClass(result: FixtureRecord): string {
  const value = result.content?.map((part: FixtureRecord) => part.text ?? "").join("\n") ?? "";
  if (result.isError || /^Error:/.test(value)) return "error";
  if (/has been terminated\.$/.test(value)) return "terminated";
  if (/is already completed\. No action needed\.$|is a persisted completed record with no live process to kill\.$/.test(value)) return "already-completed";
  if (/is already killed\. No action needed\.$|is a persisted killed record with no live process to kill\.$/.test(value)) return "already-killed";
  return "other";
}
export function freshResume(events: FixtureRecord[], threadId: string, required: boolean): void {
  assert.ok(threadId);
  const requests = events.filter((event) => event.direction === "request" && event.method === "thread/resume");
  if (required) assert.equal(requests.length, 1, "Stopped generation requires a fresh native resume");
  for (const request of requests) {
    assert.equal(request.threadId, threadId);
    assert.ok(events.some((event) => event.direction === "response" && event.id === request.id && event.relayPid === request.relayPid && event.threadId === threadId && !event.error), "Fresh native resume must succeed on original thread");
  }
}
/** Same allowlisted projector is embedded in the byte-transparent relay. */
export function projectNativePlanFrame(frame: FixtureRecord, digest: (text: string) => string) {
  const params = frame.params;
  const mode = params?.collaborationMode?.mode;
  const profile = params?.permissions;
  const policy = params?.approvalPolicy;
  const item = params?.item;
  const type = item?.type;
  const phase = item?.phase;
  const observedText = typeof item?.text === "string" ? item.text : frame.method === "item/plan/delta" && typeof params?.delta === "string" ? params.delta : undefined;
  const trimText = typeof item?.text === "string" ? item.text.trim() : undefined;
  return { collaborationMode: mode === undefined ? "absent" : ["plan", "default"].includes(mode) ? mode : "other",
    executionProfile: profile === undefined ? "absent" : [":read-only", ":workspace", ":danger-full-access"].includes(profile) ? profile : "other",
    approvalPolicy: policy === undefined ? "absent" : ["never", "on-request", "on-failure", "untrusted"].includes(policy) ? policy : "other",
    requestedModelMatches: params?.model === "gpt-6.1-sol" && params?.collaborationMode?.settings?.model === "gpt-6.1-sol",
    itemType: type === undefined ? "absent" : ["plan", "agentMessage", "reasoning", "commandExecution", "contextCompaction", "functionCall"].includes(type) ? type : "other",
    itemPhase: phase === undefined ? "absent" : ["commentary", "final_answer"].includes(phase) ? phase : "other",
    textPresent: observedText !== undefined, textNonempty: observedText !== undefined && Boolean(observedText.trim()),
    textBytes: observedText === undefined ? null : Buffer.byteLength(observedText), textSha256: observedText === undefined ? null : digest(observedText),
    trimTextBytes: trimText === undefined ? null : Buffer.byteLength(trimText), trimTextSha256: trimText === undefined ? null : digest(trimText),
    proposedPlanOpen: observedText === undefined ? null : observedText.includes("<proposed_plan>"), proposedPlanClose: observedText === undefined ? null : observedText.includes("</proposed_plan>"),
    genuineNativePlanItem: type === "plan" };
}
export function providerSseObservation(sse: string, output: FixtureRecord[]) {
  assert.ok(Buffer.byteLength(sse) <= 1_048_576);
  const events = sse.split("\n\n").filter(Boolean).map((frame) => frame.split("\n")[0].replace(/^event: /, ""));
  assert.ok(events.length <= 128 && events.every((name) => /^response\.[a-z_.]{1,64}$/.test(name)));
  const items = output.map((item) => {
    const text = item.type === "message" && Array.isArray(item.content) ? item.content.filter((part: FixtureRecord) => part.type === "output_text" && typeof part.text === "string").map((part: FixtureRecord) => part.text).join("") : undefined;
    return { itemType: ["message", "function_call"].includes(item.type) ? item.type : "other",
      itemPhase: item.phase === undefined ? "absent" : ["commentary", "final_answer"].includes(item.phase) ? item.phase : "other",
      textBytes: text === undefined ? null : Buffer.byteLength(text), textSha256: text === undefined ? null : sha256(text),
      proposedPlanOpen: text === undefined ? null : text.includes("<proposed_plan>"), proposedPlanClose: text === undefined ? null : text.includes("</proposed_plan>") };
  });
  return { eventNames: events, eventCount: events.length, items, sseBytes: Buffer.byteLength(sse), sseSha256: sha256(sse), evidenceKind: "simulated-provider-output-not-native-plan" };
}
export function planRowObservation(row: FixtureRecord | undefined, target: FixtureRecord) {
  const version = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000 ? value : null;
  return { ...generationObservation(row, target), currentPermissionMode: ["plan", "default", "bypassPermissions"].includes(row?.currentPermissionMode) ? row!.currentPermissionMode : "UNPROVEN",
    planApproval: ["ask", "delegate"].includes(row?.planApproval) ? row!.planApproval : "UNPROVEN",
    pendingPlanApproval: typeof row?.pendingPlanApproval === "boolean" ? row.pendingPlanApproval : "UNPROVEN",
    planModeApproved: typeof row?.planModeApproved === "boolean" ? row.planModeApproved : "UNPROVEN",
    approvalState: ["not_required", "pending", "approved", "changes_requested", "rejected"].includes(row?.approvalState) ? row!.approvalState : "UNPROVEN",
    decisionVersion: version(row?.planDecisionVersion), actionableVersion: version(row?.actionablePlanDecisionVersion) };
}
export const FIXTURE_PLAN = "# Disposable fixture plan\n1. Inspect fixture.\n2. Report fixture.";
export const ASK_PLAN_NEXT_STEP = "Plan waiting for the user: Approve / Revise / Reject (buttons, or reply approve, reject, or the changes)";
export function nativePlanBoundary(events: FixtureRecord[], eventStart: number, target: FixtureRecord) {
  const absent = { matched: false, planSha256: null as string | null, planBytes: null as number | null, trimPlanSha256: null as string | null, trimPlanBytes: null as number | null };
  if (!Number.isSafeInteger(eventStart) || eventStart < 0) return absent;
  const fresh = events.slice(eventStart), thread = target.backendRef?.conversationId;
  if (typeof thread !== "string" || !thread) return absent;
  for (const request of fresh) {
    if (request.direction !== "request" || request.method !== "turn/start" || request.threadId !== thread || request.collaborationMode !== "plan" || request.executionProfile !== ":read-only" || request.approvalPolicy !== "never" || request.requestedModelMatches !== true) continue;
    const ack = fresh.find((event) => event.direction === "response" && event.id === request.id && event.relayPid === request.relayPid && !event.error && typeof event.turnId === "string" && event.turnId);
    if (!ack) continue;
    const item = fresh.find((event) => event.direction === "response" && event.relayPid === request.relayPid && event.method === "item/completed" && event.threadId === thread && event.turnId === ack.turnId && event.itemType === "plan" && event.genuineNativePlanItem === true && event.textNonempty === true && typeof event.textBytes === "number" && event.textBytes > 0 && /^[a-f0-9]{64}$/.test(event.textSha256));
    const terminal = fresh.some((event) => event.direction === "response" && event.relayPid === request.relayPid && event.method === "turn/completed" && event.threadId === thread && event.turnId === ack.turnId && event.status === "completed" && !event.error);
    if (item && terminal) return { matched: true, planSha256: item.textSha256 as string, planBytes: item.textBytes as number,
      trimPlanSha256: typeof item.trimTextSha256 === "string" ? item.trimTextSha256 : null, trimPlanBytes: typeof item.trimTextBytes === "number" ? item.trimTextBytes : null };
  }
  return absent;
}
export function hasNativePlanBoundary(events: FixtureRecord[], eventStart: number, target: FixtureRecord) {
  return nativePlanBoundary(events, eventStart, target).matched;
}
function publicToolText(result: FixtureRecord | undefined) {
  if (!result || result.isError === true || result.details?.status === "error" || !Array.isArray(result.content) || !result.content.length || !result.content.every((part: FixtureRecord) => part.type === "text" && typeof part.text === "string")) return "";
  const text = result.content.map((part: FixtureRecord) => part.text).join("\n");
  return Buffer.byteLength(text) <= 1_048_576 && !text.startsWith("Error:") ? text : "";
}
export function publicOutputObservation(result: FixtureRecord | undefined, target: FixtureRecord) {
  const text = publicToolText(result), [header = "", ...bodyLines] = text.split("\n"), body = bodyLines.join("\n");
  const prefix = `Session: ${target.name} [${target.sessionId}] | Status: `;
  const fields = header.startsWith(prefix) ? header.slice(prefix.length).split(" | ") : [];
  const phases = fields.filter((field) => field.startsWith("Phase: "));
  const status = ["STARTING", "RUNNING", "COMPLETED", "KILLED", "FAILED"].includes(fields[0]) ? fields[0].toLowerCase() : "UNPROVEN";
  const phase = phases.length === 1 && ["starting", "running", "active", "awaiting_plan_decision", "awaiting_user_input", "awaiting_worktree_decision", "terminal", "suspended"].includes(phases[0].slice(7)) ? phases[0].slice(7) : "UNPROVEN";
  const recovered = /retrieved from|evicted from runtime cache|showing persisted output|persisted session metadata recovered|Recovered after a Gateway restart/.test(text);
  return { selectedReferenceMatches: header.startsWith(prefix), live: Boolean(fields.length && status !== "UNPROVEN" && !recovered), status, phase, recovered,
    outputSha256: sha256(text), bodySha256: sha256(body), exactPlanPresent: body.includes(FIXTURE_PLAN), expectedPlanSha256: sha256(FIXTURE_PLAN) };
}
export function waitingPlanObservation(result: FixtureRecord | undefined, target: FixtureRecord) {
  const text = publicToolText(result), entries = text ? text.split("\n\n") : [];
  const selected = entries.filter((entry) => entry.split("\n")[0].includes(` [${target.sessionId}] — `));
  const entry = selected.length === 1 ? selected[0] : "", header = entry.split("\n")[0];
  return { listingSha256: sha256(text), selectedEntries: selected.length, selectedReferenceMatches: Boolean(entry && header.startsWith(`📋 ${target.name} [${target.sessionId}] — `)),
    recovered: entry.includes("Recovered after a Gateway restart"), userPlanNextStep: entry.split("\n").filter((line) => line === `   👉 ${ASK_PLAN_NEXT_STEP}`).length === 1 };
}
export function hasLivePlanBoundary(events: FixtureRecord[], eventStart: number, output: FixtureRecord | undefined, listing: FixtureRecord | undefined, target: FixtureRecord) {
  const native = nativePlanBoundary(events, eventStart, target), view = publicOutputObservation(output, target), waiting = waitingPlanObservation(listing, target);
  return hasPlanObservationBoundary(native, view, waiting);
}
/** Pure observed facts shared by live parsing and the labelled offline fixture replay. */
export function hasPlanObservationBoundary(native: ReturnType<typeof nativePlanBoundary>, view: ReturnType<typeof publicOutputObservation>, waiting: ReturnType<typeof waitingPlanObservation>) {
  const rawMatches = [FIXTURE_PLAN, `${FIXTURE_PLAN}\n`].some((text) => native.planSha256 === sha256(text) && native.planBytes === Buffer.byteLength(text));
  return native.matched && rawMatches && native.trimPlanSha256 === sha256(FIXTURE_PLAN) && native.trimPlanBytes === Buffer.byteLength(FIXTURE_PLAN) && view.selectedReferenceMatches && view.live && view.status === "running" && view.phase === "awaiting_plan_decision" && view.exactPlanPresent && waiting.selectedEntries === 1 && waiting.selectedReferenceMatches && !waiting.recovered && waiting.userPlanNextStep;
}
/** Historical receipt facts stay immutable; normalization is explicitly a current source fixture. */
export function replayObservedPlan(events: FixtureRecord[], observations: FixtureRecord[]) {
  const requests = events.filter((event) => event.direction === "request" && event.method === "turn/start" && event.collaborationMode === "plan");
  assert.equal(requests.length, 1, "Fixed replay requires one observed plan request");
  const observedNative = nativePlanBoundary(events, 0, { backendRef: { conversationId: requests[0].threadId } });
  assert.ok(observedNative.matched && observedNative.planBytes === Buffer.byteLength(`${FIXTURE_PLAN}\n`) && observedNative.planSha256 === sha256(`${FIXTURE_PLAN}\n`), "Historical native plan identity/hash/count mismatch");
  assert.equal(observedNative.trimPlanBytes, null, "Historical derived normalization must remain absent");
  assert.equal(observedNative.trimPlanSha256, null, "Historical derived normalization must remain absent");
  assert.ok(observations.length > 0, "Historical public observations are required");
  const projected = projectNativePlanFrame({ method: "item/completed", params: { item: { type: "plan", text: `${FIXTURE_PLAN}\n` } } }, sha256);
  const sourceDerived = { ...observedNative, trimPlanBytes: projected.trimTextBytes, trimPlanSha256: projected.trimTextSha256 };
  const matches = observations.map((record) => ({ historicalPredicate: hasPlanObservationBoundary(observedNative, record.output, record.listing), sourceDerivedPredicate: hasPlanObservationBoundary(sourceDerived, record.output, record.listing) }));
  assert.ok(matches.every((match) => !match.historicalPredicate), "Historical missing normalization cannot be backfilled");
  assert.ok(matches.some((match) => match.sourceDerivedPredicate), "Source-derived fixture must correlate with an actual public observation");
  return { label: "OFFLINE_SOURCE_DERIVED_REPLAY", historicalStatus: "BLOCKED", historicalObservedNative: observedNative,
    historicalRawText: "UNPROVEN-not-retained", historicalNormalization: "UNPROVEN-not-retained", sourceFixtureRawPlanSha256: sha256(`${FIXTURE_PLAN}\n`),
    sourceFixtureTrimPlanSha256: projected.trimTextSha256, matches, finalAcceptance: false };
}
export function requireAskPlanRefusal(result: FixtureRecord, target: FixtureRecord) {
  const expected = `Plan approval for session ${target.name} is reserved for the user (planApproval is "ask"); approve=true from the orchestrator is refused. Wait for the user's Approve button, or forward the user's own reply as text with agent_respond(session='${target.name}', message='<their words, e.g. approve>', userInitiated=true) and without approve=true.`;
  assert.equal(result.isError, true); assert.deepEqual(result.content, [{ type: "text", text: expected }], "Ask approval must expose the actual source-defined user-only refusal");
}
export function publicAliasOwner(result: FixtureRecord | undefined, target: FixtureRecord) {
  const facts = publicOutputObservation(result, target);
  return { ...facts, active: !facts.live || !["starting", "running", "completed", "killed"].includes(facts.status) ? null : ["starting", "running"].includes(facts.status) };
}
export function negativeSnapshot(git: number, backend: number, provider: number, records: FixtureRecord[]) {
  const classCounts = { native: 0, background: 0, embedded: 0, unknown: 0 };
  for (const record of records) classCounts[record.requestClass === "native-generation" ? "native" : record.requestClass === "host-background" ? "background" : record.requestClass === "embedded-scenario" ? "embedded" : "unknown"]++;
  return { git, backend, provider, admissionIndex: records.length, classCounts, admissions: records.map((record) => ({ sequence: record.requestSequence, requestClass: record.requestClass })) };
}
export function assertNegativeWindow(prior: ReturnType<typeof negativeSnapshot>, current: ReturnType<typeof negativeSnapshot>, records: FixtureRecord[]) {
  assert.equal(current.git, prior.git, "Negative window performed Git action"); assert.equal(current.backend, prior.backend, "Negative window performed native backend action");
  assert.ok(Number.isSafeInteger(prior.provider) && prior.provider >= 0 && Number.isSafeInteger(current.provider) && current.provider >= prior.provider);
  assert.equal(current.admissionIndex, records.length); assert.deepEqual(current.admissions.slice(0, prior.admissionIndex), prior.admissions, "Existing admission changed");
  const seen = new Set<number>();
  for (const record of records) { assert.ok(Number.isSafeInteger(record.requestSequence) && record.requestSequence > 0 && record.requestSequence <= current.provider && !seen.has(record.requestSequence), "Invalid/duplicate provider entry sequence"); seen.add(record.requestSequence); }
  const background = (record: FixtureRecord) => {
    assert.equal(record.requestClass, "host-background"); assert.equal(record.fixtureGeneration, undefined);
    assert.ok(!(record.fixtureOutputMarkers ?? []).some((marker: string) => marker.startsWith("OCA504_EMBED_DONE:")));
    assert.equal(classifyProvider(undefined, undefined, record.schemaNames, new Set(), new Set()), "host-background");
  };
  let observedBackgroundCount = 0, preWindowBackgroundAdmissions = 0;
  for (let sequence = prior.provider + 1; sequence <= current.provider; sequence++) { const record = records.find((record) => record.requestSequence === sequence); assert.ok(record, "Provider entry has no classified retained admission"); background(record); observedBackgroundCount++; }
  for (const record of records.slice(prior.admissionIndex)) if (record.requestSequence <= prior.provider) { background(record); preWindowBackgroundAdmissions++; }
  return { zeroBackendGit: true, noNativeProviderContinuation: true, providerBefore: prior.provider, providerAfter: current.provider,
    providerClassesBefore: prior.classCounts, providerClassesAfter: current.classCounts,
    providerAdmissionsBefore: prior.admissionIndex, providerAdmissionsAfter: current.admissionIndex, observedBackgroundCount, preWindowBackgroundAdmissions,
    correlation: "entry-sequence-only-not-causal-receipt" };
}

export function responseResumeBoundary(row: FixtureRecord | undefined, target: FixtureRecord, eventStart: number) {
  const facts = generationObservation(row, target);
  assert.ok(facts.exists && facts.selectedIdMatches && facts.selectedBackendMatches);
  assert.ok(Number.isInteger(eventStart) && eventStart >= 0);
  assert.ok(["starting", "running", "completed", "killed"].includes(facts.status));
  const required = ["completed", "killed"].includes(facts.status);
  if (required) stoppedGeneration(row, target);
  return { eventStart, required, facts };
}
export function requireResponseResume(events: FixtureRecord[], boundary: ReturnType<typeof responseResumeBoundary>, threadId: string) {
  freshResume(events.slice(boundary.eventStart), threadId, boundary.required);
}
export function seedObserverAllow(config: FixtureRecord) {
  return { ...config, plugins: { ...config.plugins, allow: ["openclaw-code-agent", "openai"] } };
}
export function managedObserverAllow(config: FixtureRecord): string[] {
  const allow = config.plugins?.allow;
  assert.ok(Array.isArray(allow) && allow.length === 3 && allow.every((id) => typeof id === "string"));
  assert.deepEqual([...allow].sort(), ["oca504-observer", "openai", "openclaw-code-agent"].sort(), "Actual managed installer must append only observer to baseline grants");
  return allow;
}
export function aliasOwnerObservation(row: FixtureRecord | undefined, target: FixtureRecord) {
  const facts = generationObservation(row, target);
  assert.ok(facts.exists && facts.selectedIdMatches && facts.selectedBackendMatches && facts.expectedNameMatches, "Alias owner identity changed");
  assert.ok(["starting", "running", "completed", "killed"].includes(facts.status), "Unexpected alias owner state");
  return { ...facts, active: ["starting", "running"].includes(facts.status) };
}
export function assertAliasProtection(owner: { active: boolean | null }, resumed: FixtureRecord, expectedAlias: string) {
  if (owner.active) assert.notEqual(resumed.name, expectedAlias, "Resumed older generation must not steal active alias");
  return owner.active === null ? "active-alias-protection-UNPROVEN-plugin-fixture-only" : owner.active ? "runtime-active-owner-protected" : "terminal-owner-reuse-supported-active-protection-plugin-fixture-only";
}
export function requireHttpBefore(events: FixtureRecord[], tool: string, session: string, input: string) {
  const hooks = events.filter((event) => event.phase === "before" && event.toolName === tool);
  assert.equal(hooks.length, 1); const hook = hooks[0];
  assert.ok(typeof hook.toolCallId === "string" && hook.toolCallId.trim() === hook.toolCallId && hook.toolCallId);
  assert.equal(hook.session, session); assert.equal(hook.inputHash, sha256(input));
  return hook;
}
export function requireEmbeddedAfter(events: FixtureRecord[], tool: string, callId: string) {
  const hook = events.find((event) => event.phase === "after" && event.toolName === tool && event.toolCallId === callId);
  assert.ok(hook, "Exact embedded call must expose actual after-hook outcome"); return hook;
}
export function classifyProvider(generation: string | undefined, marker: string | undefined, schemaNames: string[], generations: Set<string>, scenarios: Set<string>) {
  assert.ok(schemaNames.length <= 128 && schemaNames.every((name) => typeof name === "string" && name.length <= 128));
  assert.ok(!(generation && marker), "Native and embedded markers cannot overlap");
  if (generation) { assert.ok(generations.has(generation), "Unknown native generation"); return "native-generation" as const; }
  if (marker) { assert.ok(scenarios.has(marker), "Unknown embedded scenario"); return "embedded-scenario" as const; }
  assert.ok(schemaNames.some((name) => ["agent_respond", "agent_merge", "agent_escalate", "agent_output", "tool_call", "tool_search"].includes(name)), "Unknown provider request class");
  return "host-background" as const;
}
export function selectedProvider(requests: FixtureRecord[], generation: string, message: string) {
  assert.ok(requests.length && requests.every((request) => ["native-generation", "host-background"].includes(request.requestClass)), "Unknown or embedded request in serialized native window");
  const native = requests.filter((request) => request.requestClass === "native-generation");
  assert.ok(native.length, "Host background cannot prove native input");
  for (const request of native) {
    assert.equal(request.fixtureGeneration, generation); assert.equal(request.latestInputHash, sha256(message));
    assert.ok(request.fixtureOutputMarkers.includes(`OCA504_BACKEND_OK:${generation}:`));
  }
  return native;
}

function repeatResultText(result: FixtureRecord | undefined): string | undefined {
  return result && Array.isArray(result.content) && result.content.every((part: FixtureRecord) => part?.type === "text" && typeof part.text === "string") ? result.content.map((part: FixtureRecord) => part.text).join("\n") : undefined;
}
/** Whole public source templates only; classification runs before receipt sanitation. */
export function repeatOutcome(result: FixtureRecord | undefined, target: FixtureRecord) {
  const value = repeatResultText(result);
  if (!result || typeof value !== "string" || !value) return "unknown" as const;
  if (result.isError === true && result.details?.status === "error" && result.details?.code === "response_delivery_unconfirmed" && result.details.targetSelected === true && !("operationStarted" in result.details)) return "unconfirmed" as const;
  if (result.details?.code !== undefined) return "unknown" as const;
  const id = target.sessionId, thread = target.backendRef?.conversationId, name = target.name;
  if (typeof id !== "string" || !id || typeof thread !== "string" || !thread || typeof name !== "string" || !name) return "unknown" as const;
  const guards = [`Cannot resume backend thread ${thread}: session ${id} still owns its active writer.`, ...["starting", "running"].map((status) => `Cannot reuse session ID ${id}: that session is still ${status}.`)];
  const exactGuard = guards.some((guard) => value === `Resume unavailable for session ${name} [${id}] (missing_backend_state). Backend resume failed: ${guard} No resumable backend state is available. Launch a fresh session, or fork from prior context with agent_launch(resume_session_id='${id}', fork_session=true, prompt='<new task>').`);
  if (result.isError === true) return exactGuard && (result.details?.status === undefined || result.details.status === "error") ? "guard" as const : "unknown" as const;
  if ((result.isError === undefined || result.isError === false) && (result.details?.status === undefined || result.details.status === "success") && !/^(?:Error|Resume unavailable)/.test(value)) return "success" as const;
  return "unknown" as const;
}

/** Both already-started public calls settle and are recorded before any outcome assertion. */
export async function settleRepeatCalls(calls: [() => Promise<FixtureRecord>, () => Promise<FixtureRecord>], target: FixtureRecord,
  record: (value: FixtureRecord) => void) {
  const settled = await Promise.allSettled(calls.map((call) => Promise.resolve().then(call)));
  return settled.map((item, callIndex) => {
    if (item.status === "rejected") {
      const errorClass = item.reason instanceof Error && ["Error", "TypeError", "SyntaxError", "AssertionError", "RangeError"].includes(item.reason.name) ? item.reason.name : "UnknownError";
      const errorText = item.reason instanceof Error ? item.reason.message : "Non-Error transport rejection";
      record({ phase: "concurrent-public-outcome", callIndex, outcomeClass: "transport-exception", errorClass, exceptionTextSha256: sha256(errorText), diagnosticExcerpt: Buffer.from(errorText).subarray(0, 512).toString() });
      return { callIndex, classification: "unknown" as const, transportException: true };
    }
    const result = item.value, classification = repeatOutcome(result, target);
    const value = repeatResultText(result) ?? "";
    record({ phase: "concurrent-public-outcome", callIndex, outcomeClass: classification,
      isError: result?.isError, status: result?.details?.status, code: result?.details?.code,
      resultSha256: sha256(JSON.stringify(result) ?? "undefined"), textSha256: sha256(value),
      exactSelectedResumeGuard: classification === "guard", diagnosticExcerpt: Buffer.from(value).subarray(0, 512).toString() });
    return { callIndex, classification, result, transportException: false };
  });
}

export function repeatOutcomeCounts(classes: string[]) {
  assert.equal(classes.length, 2); assert.ok(classes.every((value) => ["success", "unconfirmed", "guard"].includes(value)), "Unknown concurrent public outcome");
  return { successes: classes.filter((value) => value === "success").length,
    unconfirmed: classes.filter((value) => value === "unconfirmed").length, guards: classes.filter((value) => value === "guard").length };
}

/** Native attempts are runtime observations, never independent per-call delivery receipts. */
export function repeatNativeObservation(events: FixtureRecord[], target: FixtureRecord, message: string,
  counts: ReturnType<typeof repeatOutcomeCounts>) {
  const thread = target.backendRef?.conversationId;
  assert.ok(thread); assert.equal(counts.successes + counts.unconfirmed + counts.guards, 2);
  const inputs = events.filter((event) => event.direction === "request" && ["turn/start", "turn/steer"].includes(event.method));
  assert.ok(inputs.every((input) => input.threadId === thread && input.nativeInput?.some((part: FixtureRecord) => part.sha256 === sha256(message))), "Unexpected repeat input or generation");
  const accepted: FixtureRecord[] = [], rejected: FixtureRecord[] = [], uncertain: FixtureRecord[] = [];
  for (const input of inputs) {
    const responses = events.filter((event) => event.direction === "response" && event.id === input.id && event.relayPid === input.relayPid);
    assert.ok(responses.length <= 1, "Duplicate native acknowledgement"); const response = responses[0];
    if (response && !response.error && typeof response.turnId === "string" && response.turnId && (input.method === "turn/start" || response.turnId === input.expectedTurnId)) accepted.push(response);
    else if (input.method === "turn/steer" && response?.error && response.errorCode === -32600 && response.errorDataPresent === false && (response.noActiveTurn === true || (response.mismatchExact === true && response.mismatchExpected === input.expectedTurnId && typeof response.mismatchActual === "string" && response.mismatchActual && response.mismatchActual !== input.expectedTurnId))) rejected.push(response);
    else uncertain.push(input);
  }
  const turns = new Set(accepted.map((response) => response.turnId));
  const terminalTurns = [...turns].filter((turnId) => accepted.filter((response) => response.turnId === turnId).every((response) => events.some((event) => event.method === "turn/completed" && event.relayPid === response.relayPid && event.threadId === thread && event.turnId === turnId && event.status === "completed" && !event.error)));
  const ready = inputs.length >= counts.successes + counts.unconfirmed && accepted.length >= counts.successes && accepted.length >= 1
    && uncertain.length <= counts.unconfirmed && terminalTurns.length === turns.size;
  return { ready, inputs, accepted, rejected, uncertain, terminalTurns, ...counts };
}

export function observerSourceProof(fixture: string, path: string) {
  const source = exactCandidatePath(fixture, path);
  const names = ["index.mjs", "openclaw.plugin.json", "package.json"];
  assert.deepEqual(readdirSync(source).sort(), [...names].sort(), "Observer source must contain exactly its three generated files");
  const hashes: Record<string, string> = {};
  for (const name of names) {
    const file = exactCandidatePath(fixture, join(source, name)), info = lstatSync(file);
    assert.ok(info.isFile() && info.uid === process.getuid!() && info.size <= 1_048_576);
    hashes[name] = sha256(readFileSync(file));
  }
  const manifest = JSON.parse(readFileSync(join(source, "openclaw.plugin.json"), "utf8"));
  assert.equal(manifest.id, "oca504-observer"); assert.ok(manifest.activation && typeof manifest.activation === "object" && !Array.isArray(manifest.activation));
  assert.equal(manifest.activation.onStartup, true, "Observer startup activation is required");
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  assert.equal(pkg.name, "oca504-observer"); assert.equal(pkg.version, "0.0.0"); assert.deepEqual(pkg.openclaw.extensions, ["./index.mjs"]);
  return { source, hashes };
}
export async function installObserver(fixture: string, observer: { path: string; hashes: Record<string, string> }, install: (path: string) => Promise<void>) {
  const proof = observerSourceProof(fixture, observer.path);
  assert.deepEqual(proof.hashes, observer.hashes, "Generated observer changed before installation");
  await install(proof.source); return proof;
}
export function verifyObserverInspection(report: FixtureRecord, fixture: string, state: string, proof: ReturnType<typeof observerSourceProof>, runtime = false, evidence?: HostEvidence) {
  const { plugin, install } = report;
  assert.ok(plugin && install); assert.equal(plugin.id, "oca504-observer"); assert.equal(plugin.version, "0.0.0");
  assert.equal(plugin.enabled, true); assert.equal(plugin.status, "loaded"); assert.ok(!plugin.error);
  for (const [field, expected] of [["packageName", "oca504-observer"], ["packageVersion", "0.0.0"]]) if (plugin[field] !== undefined) assert.equal(plugin[field], expected);
  assert.equal(install.source, "path"); assert.equal(exactCandidatePath(fixture, install.sourcePath), proof.source);
  const expectedRoot = exactCandidatePath(fixture, join(state, "extensions", "oca504-observer"));
  assert.equal(exactCandidatePath(fixture, install.installPath), expectedRoot); assert.equal(exactCandidatePath(fixture, plugin.rootDir), expectedRoot);
  assert.equal(exactCandidatePath(fixture, plugin.source), join(expectedRoot, "index.mjs"));
  assert.deepEqual(readdirSync(expectedRoot).sort(), Object.keys(proof.hashes).sort());
  const installedHashes: Record<string, string> = {};
  for (const [name, hash] of Object.entries(proof.hashes)) {
    const file = exactCandidatePath(fixture, join(expectedRoot, name)), info = lstatSync(file);
    assert.ok(info.isFile() && info.uid === process.getuid!() && info.size <= 1_048_576);
    installedHashes[name] = sha256(readFileSync(file));
    evidence?.record("host-events.jsonl", { phase: "observer-installed-file", name, expectedSha256: hash, actualSha256: installedHashes[name], bytes: info.size });
    assert.equal(installedHashes[name], hash);
  }
  if (runtime) assert.equal(plugin.imported, true);
  return { installedHashes, imported: plugin.imported === true, version: plugin.version, sourceKind: install.source };
}

export type FixtureSessionSubscription = { subscribed: true; key: "agent:main:main"; agentId: "main"; localConnectionCorrelation: string };

/** This local correlation label is fixture metadata, not a host connection receipt. */
export async function subscribeFixtureMessages(request: (method: string, params: { key: string }) => Promise<unknown>, localConnectionCorrelation: string): Promise<FixtureSessionSubscription> {
  assert.match(localConnectionCorrelation, /^[A-Za-z0-9_-]{1,64}$/);
  const ack = await request("sessions.messages.subscribe", { key: "agent:main:main" });
  assert.ok(ack && typeof ack === "object" && !Array.isArray(ack), "Actual message subscription acknowledgement required");
  const value = ack as Record<string, unknown>;
  assert.equal(value.subscribed, true); assert.equal(value.key, "agent:main:main"); assert.equal(value.agentId, "main");
  return { subscribed: true, key: "agent:main:main", agentId: "main", localConnectionCorrelation };
}

export function projectFixtureHostEvent(event: string, payload: Record<string, any> | undefined, localConnectionCorrelation: string, subscription?: FixtureSessionSubscription) {
  return { event, localConnectionCorrelation,
    matchesSubscribedSession: subscription?.localConnectionCorrelation === localConnectionCorrelation && payload?.sessionKey === subscription.key,
    payload: { runId: payload?.runId, state: payload?.state, stream: payload?.stream,
      data: { phase: payload?.data?.phase, toolName: payload?.data?.toolName, toolCallId: payload?.data?.toolCallId, isError: payload?.data?.isError, status: payload?.data?.status } } };
}

export function hasFreshSubscribedTerminal(events: Array<ReturnType<typeof projectFixtureHostEvent>>, eventStart: number, subscription: FixtureSessionSubscription, runId: unknown): boolean {
  if (!Number.isInteger(eventStart) || eventStart < 0 || typeof runId !== "string" || !runId) return false;
  return events.slice(eventStart).some((event) => event.localConnectionCorrelation === subscription.localConnectionCorrelation && event.matchesSubscribedSession === true && event.payload.runId === runId && !["error", "abort", "aborted"].includes(event.payload.state) && event.payload.data.isError !== true &&
    ((event.event === "chat" && event.payload.state === "final") || (event.event === "agent" && event.payload.stream === "lifecycle" && event.payload.data.phase === "end")));
}

export function freshPluginBootstrap(logging: OpenClawConfig["logging"], port: number): OpenClawConfig {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535);
  return { logging, gateway: { mode: "local", bind: "loopback", port } };
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
const projectPlan=${projectNativePlanFrame.toString()};
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
        const planMetadata=["turn/start","item/started","item/completed","item/plan/delta","turn/plan/updated","turn/completed"].includes(frame.method)?projectPlan(frame,text=>createHash("sha256").update(text).digest("hex")):{};
        const record={...planMetadata,relayPid:process.pid,direction, method:frame.method, id:frame.id, userAgent:frame.result?.userAgent,nativeInput,expectedTurnId:frame.params?.expectedTurnId,
          threadId:frame.params?.threadId ?? frame.result?.thread?.id,
          turnId:frame.params?.turn?.id ?? frame.params?.turnId ?? frame.result?.turn?.id ?? frame.result?.turnId, status:frame.params?.turn?.status, error:Boolean(frame.error),
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
export function writeHostObserver(root: string): { path: string; hash: string; hashes: Record<string, string> } {
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
  writeFileSync(ownedPath(root, join(path, "openclaw.plugin.json")), JSON.stringify({ id: "oca504-observer", activation: { onStartup: true }, configSchema: { type: "object", additionalProperties: false, properties: {} } }), { mode: 0o600 });
  writeFileSync(ownedPath(root, join(path, "package.json")), JSON.stringify({ name: "oca504-observer", version: "0.0.0", type: "module", openclaw: { extensions: ["./index.mjs"] } }), { mode: 0o600 });
  return { path, hash: sha256(source), hashes: observerSourceProof(root, path).hashes };
}
