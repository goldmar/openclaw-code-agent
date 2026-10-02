// Bounded receipt transport for the issue-501 disposable-host acceptance job.
// Decode on the coordinator host immediately after the owning remote job ends:
// node scripts/e2e/oca501-evidence.mjs --decode /tmp/job.stdout --out /tmp/receipts \
//   --expected-sha <reviewed SHA> --node-version 24.16.0 --phase matrix-h01-h05
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const PREFIX = "OCA501_EVIDENCE ";
const LIMITS = { files: 2000, fileBytes: 4 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 };
const safeName = (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
const HOST_VERSION = "2026.9.7";
const HOST_COMMIT = "c074824a27c96d3983043f9eeb33823cd1772d8c";
const NATIVE_VERSION = "0.159.3";
const PHASES = ["prerequisites", "matrix-h01-h05", "matrix-l1", "routed-negative"];

function validateIdentity(manifest, expected) {
  assert.ok(expected && typeof expected === "object", "External expected receipt identity is mandatory");
  assert.match(expected.candidateSha ?? "", /^[a-f0-9]{40}$/); assert.match(manifest.candidateSha ?? "", /^[a-f0-9]{40}$/);
  assert.ok(["24.16.0", "26.1.0"].includes(expected.nodeVersion));
  assert.ok(PHASES.includes(expected.phase) || (expected.controlsOnly === true && expected.phase === "controls-only"));
  for (const field of ["candidateSha", "nodeVersion", "phase"]) assert.equal(manifest[field], expected[field], `Expected ${field} mismatch`);
  assert.ok(Number.isSafeInteger(manifest.scriptExitCode) && manifest.scriptExitCode >= 0);
  if (expected.controlsOnly === true) { assert.equal(manifest.phase, "controls-only"); return; }
  assert.equal(manifest.expectedHostVersion, HOST_VERSION); assert.equal(manifest.expectedNativeVersion, NATIVE_VERSION);
  for (const [field, pinned] of [["hostVersion", HOST_VERSION], ["upstreamTagCommit", HOST_COMMIT], ["nativeVersion", NATIVE_VERSION]]) {
    if (manifest[field] !== undefined || manifest.scriptExitCode === 0) assert.equal(manifest[field], pinned, `Applicable pinned ${field} mismatch`);
  }
  // Failed setup can export complete failure receipts without claiming that
  // installation/runtime stages were reached. Successful runtime needs pins.
  if (manifest.scriptExitCode === 0) {
    for (const field of ["sourceArchiveHash", "hostEntryHash", "hostPackageHash", "nativeExecutableHash", "packageHash", "installedEntryHash", "acceptanceScriptHash", "evidenceHelperHash", "commandReceiptHelperHash"]) assert.match(manifest[field] ?? "", /^[a-f0-9]{64}$/, `Required ${field} provenance missing`);
    assert.equal(manifest.officialCli?.nodeVersion, `v${expected.nodeVersion}`);
    assert.equal(manifest.officialCli?.entryHash, manifest.hostEntryHash);
    assert.match(manifest.officialCli?.nodeHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(manifest.parentModel, "oca501/gpt-6-luna");
    assert.equal(manifest.cleanup?.classification, "PASS", "Zero-exit export requires completed owned cleanup");
  } else {
    assert.ok((typeof manifest.primaryFailure === "string" && manifest.primaryFailure) || manifest.cleanup?.classification === "BLOCKED" || manifest.independentErrors?.length, "Blocked transport must preserve its failure reason");
  }
}

export function buildEvidence(root, entries, metadata, secrets) {
  assert.ok(entries.length <= LIMITS.files);
  const owned = realpathSync(root);
  const names = new Set(); let totalBytes = 0;
  const files = entries.toSorted((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    assert.ok(safeName(entry.name) && !names.has(entry.name), "Unique flat evidence identity"); names.add(entry.name);
    const path = join(root, entry.name);
    assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "Only regular owned evidence");
    assert.equal(relative(owned, realpathSync(path)), entry.name, "No outside-root evidence");
    const original = readFileSync(path); assert.ok(original.length <= LIMITS.fileBytes, "Evidence file exceeds fixed bound");
    let text = original.toString("utf8");
    assert.deepEqual(Buffer.from(text), original, "Export only complete UTF-8 text receipts");
    for (const secret of secrets) text = text.replaceAll(secret, "[fixture credential]");
    const sanitized = Buffer.from(text); totalBytes += sanitized.length;
    assert.ok(sanitized.length <= LIMITS.fileBytes && totalBytes <= LIMITS.totalBytes, "Evidence export exceeds fixed bound");
    return { name: entry.name, originalBytes: original.length, originalSha256: sha(original), originalScope: entry.alreadyRedacted ? "artifact already redacted before hashing" : "owned raw receipt before export redaction", sanitizedBytes: sanitized.length, sanitizedSha256: sha(sanitized), content: gzipSync(sanitized).toString("base64") };
  });
  const manifest = { ...metadata, format: "oca501-evidence-v1", complete: true, redaction: "Exact known synthetic fixture tokens/API keys only; no raw config/auth/env export", compression: "gzip+base64", limits: LIMITS, fileCount: files.length, totalSanitizedBytes: totalBytes, files: files.map(({ content, ...entry }) => entry) };
  return { manifest, files, digest: sha(JSON.stringify({ manifest, files })) };
}

export function frameEvidence(bundle) {
  return [JSON.stringify({ type: "begin", format: "oca501-evidence-v1" }), ...bundle.files.map((file) => JSON.stringify({ type: "file", file })), JSON.stringify({ type: "manifest", manifest: bundle.manifest }), JSON.stringify({ type: "end", digest: bundle.digest })].map((line) => `${PREFIX}${line}`).join("\n") + "\n";
}

export function decodeEvidence(stdout, expected) {
  const lines = stdout.split("\n").filter((line) => line.startsWith(PREFIX)).map((line) => JSON.parse(line.slice(PREFIX.length)));
  assert.equal(lines[0]?.type, "begin"); assert.equal(lines[0].format, "oca501-evidence-v1");
  assert.equal(lines.at(-1)?.type, "end", "Missing final evidence marker");
  assert.equal(lines.at(-2)?.type, "manifest");
  const manifest = lines.at(-2).manifest;
  validateIdentity(manifest, expected);
  assert.equal(manifest.complete, true, "Incomplete export is blocked"); assert.equal(manifest.format, "oca501-evidence-v1");
  assert.deepEqual(manifest.limits, LIMITS);
  const files = lines.slice(1, -2).map((line) => { assert.equal(line.type, "file"); return line.file; });
  assert.equal(files.length, manifest.fileCount); assert.ok(files.length <= LIMITS.files);
  assert.deepEqual(files.map(({ content, ...entry }) => entry), manifest.files);
  assert.equal(sha(JSON.stringify({ manifest, files })), lines.at(-1).digest, "Full bundle digest mismatch");
  const names = new Set(); let bytes = 0;
  const decoded = files.map((file) => {
    assert.ok(safeName(file.name) && !names.has(file.name)); names.add(file.name);
    for (const count of [file.sanitizedBytes, file.originalBytes]) assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= LIMITS.fileBytes);
    for (const digest of [file.sanitizedSha256, file.originalSha256]) assert.match(digest, /^[a-f0-9]{64}$/);
    assert.ok(typeof file.content === "string" && file.content.length <= 2 * LIMITS.fileBytes, "Bound compressed transport before decode");
    const content = gunzipSync(Buffer.from(file.content, "base64"), { maxOutputLength: LIMITS.fileBytes });
    assert.equal(content.length, file.sanitizedBytes); assert.equal(sha(content), file.sanitizedSha256);
    bytes += content.length; assert.ok(bytes <= LIMITS.totalBytes);
    return { name: file.name, content };
  });
  assert.equal(bytes, manifest.totalSanitizedBytes);
  return { manifest, files: decoded, digest: lines.at(-1).digest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  const args = process.argv.slice(2);
  assert.equal(args.length, 10, "Provide exactly decode/out/expected-sha/node-version/phase options");
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    assert.ok(["--decode", "--out", "--expected-sha", "--node-version", "--phase"].includes(name) && !Object.hasOwn(options, name), "Unknown/duplicate decoder option");
    assert.ok(args[index + 1]); options[name] = args[index + 1];
  }
  const source = options["--decode"]; const output = options["--out"];
  assert.ok(isAbsolute(source) && isAbsolute(output));
  const decoded = decodeEvidence(readFileSync(source, "utf8"), { candidateSha: options["--expected-sha"], nodeVersion: options["--node-version"], phase: options["--phase"] });
  // Exclusive writes prevent replacing another run's receipts.
  mkdirSync(output, { mode: 0o700 });
  for (const file of decoded.files) writeFileSync(join(output, file.name), file.content, { flag: "wx", mode: 0o600 });
  writeFileSync(join(output, "export-manifest.json"), JSON.stringify({ ...decoded.manifest, digest: decoded.digest }, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ complete: true, acceptance: decoded.manifest.scriptExitCode === 0 ? "MILESTONE_COMPLETE" : "BLOCKED", files: decoded.files.length, bytes: decoded.manifest.totalSanitizedBytes, candidateSha: decoded.manifest.candidateSha, nodeVersion: decoded.manifest.nodeVersion, phase: decoded.manifest.phase, digest: decoded.digest }));
}
