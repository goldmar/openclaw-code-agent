// Offline assertion controls, not a simulated host acceptance run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEvidence, frameEvidence, decodeEvidence } from "./oca501-evidence.mjs";

const root = mkdtempSync(join(tmpdir(), "oca501-export-controls-"));
const token = "synthetic-controls-token";
writeFileSync(join(root, "raw.log"), `stdout ${token}\nstderr original failure\n`);
writeFileSync(join(root, "redacted.json"), '{"credential":"[fixture credential]"}\n');
const metadata = { candidateSha: "a".repeat(40), nodeVersion: "24.16.0", phase: "controls-only", scriptExitCode: 1, primaryFailure: "original failure", cleanup: { classification: "BLOCKED", failures: ["independent cleanup failure"] }, independentErrors: [{ stage: "cleanup", error: "independent cleanup failure" }] };
const expected = { candidateSha: metadata.candidateSha, nodeVersion: metadata.nodeVersion, phase: metadata.phase, controlsOnly: true };
const decode = (text) => decodeEvidence(text, expected);
const bundle = buildEvidence(root, [{ name: "raw.log", alreadyRedacted: false }, { name: "redacted.json", alreadyRedacted: true }], metadata, [token]);
const frame = frameEvidence(bundle);
const reframe = (value) => frameEvidence({ ...value, digest: createHash("sha256").update(JSON.stringify({ manifest: value.manifest, files: value.files })).digest("hex") });
const decoded = decode(`runner progress\n${frame}other output\n`);
assert.equal(decoded.files.length, 2);
assert.ok(!decoded.files[0].content.includes(token));
assert.ok(decoded.files[0].content.includes("original failure"));
const raw = decoded.manifest.files.find((file) => file.name === "raw.log");
assert.notEqual(raw.originalSha256, raw.sanitizedSha256); assert.ok(raw.originalScope.includes("before export"));
const already = decoded.manifest.files.find((file) => file.name === "redacted.json");
assert.equal(already.originalSha256, already.sanitizedSha256); assert.ok(already.originalScope.includes("already redacted"));
assert.equal(decoded.manifest.primaryFailure, "original failure"); assert.equal(decoded.manifest.cleanup.classification, "BLOCKED");
assert.deepEqual(decoded.manifest.independentErrors, metadata.independentErrors);
const negatives = [];
const deny = (name, operation) => { assert.throws(operation, undefined, name); negatives.push(name); };
deny("missing end marker", () => decode(frame.split("\n").filter((line) => !line.includes('"type":"end"')).join("\n")));
deny("missing manifest", () => decode(frame.split("\n").filter((line) => !line.includes('"type":"manifest"')).join("\n")));
deny("missing complete file", () => decode(frame.split("\n").filter((line) => !line.includes('"type":"file"')).join("\n")));
deny("content corruption", () => decode(frame.replace(bundle.files[0].content, "eA==")));
const wrongFileHash = structuredClone(bundle);
wrongFileHash.files[0].sanitizedSha256 = "0".repeat(64);
wrongFileHash.manifest.files[0].sanitizedSha256 = wrongFileHash.files[0].sanitizedSha256;
deny("per-file hash corruption with valid outer digest", () => decode(reframe(wrongFileHash)));
deny("declared incomplete", () => decode(frame.replace('"complete":true', '"complete":false')));
deny("bundle digest corruption", () => decode(frame.replace(bundle.digest, "0".repeat(64))));
deny("duplicate file identity", () => buildEvidence(root, [{ name: "raw.log" }, { name: "raw.log" }], metadata, []));
deny("traversal", () => buildEvidence(root, [{ name: "../raw.log" }], metadata, []));
deny("missing required registered receipt", () => buildEvidence(root, [{ name: "missing.json" }], metadata, []));
symlinkSync(join(root, "raw.log"), join(root, "alias.log"));
deny("symlink even inside owned root", () => buildEvidence(root, [{ name: "alias.log" }], metadata, []));
symlinkSync(import.meta.filename, join(root, "outside.log"));
deny("outside-root symlink", () => buildEvidence(root, [{ name: "outside.log" }], metadata, []));
deny("file count cap", () => buildEvidence(root, Array.from({ length: 2001 }, (_, index) => ({ name: `f${index}` })), metadata, []));
writeFileSync(join(root, "large.log"), Buffer.alloc(4 * 1024 * 1024 + 1, 65));
deny("file byte cap without truncation", () => buildEvidence(root, [{ name: "large.log" }], metadata, []));
assert.equal(readFileSync(join(root, "large.log")).length, 4 * 1024 * 1024 + 1);
const wrongBytes = structuredClone(bundle); wrongBytes.manifest.totalSanitizedBytes++;
deny("aggregate byte mismatch with valid outer digest", () => decode(reframe(wrongBytes)));
writeFileSync(join(root, "at-cap.log"), Buffer.alloc(4 * 1024 * 1024, 65));
const capped = buildEvidence(root, [{ name: "at-cap.log", alreadyRedacted: true }], metadata, []);
const excess = { ...capped, files: Array.from({ length: 17 }, (_, index) => ({ ...capped.files[0], name: `receipt-${index}.log` })) };
excess.manifest = { ...capped.manifest, fileCount: 17, totalSanitizedBytes: 17 * 4 * 1024 * 1024, files: excess.files.map(({ content, ...file }) => file) };
deny("actual decompressed total cap despite valid file and outer hashes", () => decode(reframe(excess)));
const counted = { ...bundle, files: Array.from({ length: 2001 }, (_, index) => ({ ...bundle.files[0], name: `receipt-${index}.log` })) };
counted.manifest = { ...bundle.manifest, fileCount: 2001, files: counted.files.map(({ content, ...file }) => file) };
deny("actual decoder file count cap", () => decode(reframe(counted)));
deny("missing external identity", () => decodeEvidence(frame));
for (const [field, values] of Object.entries({ candidateSha: ["b".repeat(40), "malformed", undefined], nodeVersion: ["26.1.0", "22.0.0", undefined], phase: ["matrix-h01-h05", "unreviewed", undefined] })) {
  for (const value of values) {
    const foreign = structuredClone(bundle); foreign.manifest[field] = value;
    deny(`rehashed ${field} ${String(value)}`, () => decode(reframe(foreign)));
  }
}
const blockedMetadata = { ...metadata, phase: "prerequisites", expectedHostVersion: "2026.9.7", expectedNativeVersion: "0.159.3" };
const blocked = buildEvidence(root, [{ name: "raw.log", alreadyRedacted: false }], blockedMetadata, [token]);
const runtimeExpected = { candidateSha: metadata.candidateSha, nodeVersion: "24.16.0", phase: "prerequisites" };
assert.equal(decodeEvidence(frameEvidence(blocked), runtimeExpected).manifest.scriptExitCode, 1, "Early blocked setup is valid failure transport, never host success");
const completedMetadata = { ...blockedMetadata, scriptExitCode: 0, primaryFailure: null, independentErrors: [], cleanup: { classification: "PASS", failures: [] }, hostVersion: "2026.9.7", upstreamTagCommit: "c074824a27c96d3983043f9eeb33823cd1772d8c", nativeVersion: "0.159.3", parentModel: "oca501/gpt-6-luna", officialCli: { nodeVersion: "v24.16.0", entryHash: "c".repeat(64), nodeHash: "c".repeat(64) } };
for (const field of ["sourceArchiveHash", "hostEntryHash", "hostPackageHash", "nativeExecutableHash", "packageHash", "installedEntryHash", "acceptanceScriptHash", "evidenceHelperHash", "commandReceiptHelperHash"]) completedMetadata[field] = "c".repeat(64);
const completed = buildEvidence(root, [{ name: "raw.log", alreadyRedacted: false }], completedMetadata, [token]);
assert.equal(decodeEvidence(frameEvidence(completed), runtimeExpected).manifest.scriptExitCode, 0, "Strict identity shape control only; this is not host acceptance");
for (const field of ["hostVersion", "upstreamTagCommit", "nativeVersion", "installedEntryHash", "sourceArchiveHash"]) {
  const incomplete = structuredClone(completed); delete incomplete.manifest[field];
  deny(`zero-exit missing ${field}`, () => decodeEvidence(reframe(incomplete), runtimeExpected));
}
for (const [field, value] of [["hostVersion", "2026.9.8"], ["upstreamTagCommit", "f".repeat(40)], ["nativeVersion", "0.160.0"]]) {
  const foreign = structuredClone(blocked); foreign.manifest[field] = value;
  deny(`rehashed wrong applicable ${field}`, () => decodeEvidence(reframe(foreign), runtimeExpected));
}
const source = join(root, "job.stdout"); writeFileSync(source, frameEvidence(blocked));
const cli = new URL("./oca501-evidence.mjs", import.meta.url).pathname;
const flags = ["--decode", source, "--out", join(root, "decoded"), "--expected-sha", runtimeExpected.candidateSha, "--node-version", runtimeExpected.nodeVersion, "--phase", runtimeExpected.phase];
assert.equal(spawnSync(process.execPath, [cli, ...flags], { encoding: "utf8" }).status, 0);
for (const [name, changed] of [["missing expectations", flags.slice(0, 4)], ["duplicate option", [...flags, "--phase", "prerequisites"]], ["unknown option", flags.map((value) => value === "--phase" ? "--unknown" : value)], ["foreign expected identity", flags.map((value) => value === runtimeExpected.candidateSha ? "b".repeat(40) : value)]]) {
  const output = join(root, `rejected-${negatives.length}`); const args = changed.map((value) => value === join(root, "decoded") ? output : value);
  assert.notEqual(spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" }).status, 0, name);
  assert.equal(existsSync(output), false, "CLI rejects before creating any output"); negatives.push(`CLI ${name} before writes`);
}
console.log(JSON.stringify({ scope: "Offline export assertion controls only", positives: ["complete controls-only roundtrip", "credential redaction and before/after provenance", "original failure and independent cleanup evidence retained", "exact externally expected BLOCKED transport", "complete pinned identity shape (not a host run)", "CLI externally expected identity before output"], negativeCount: negatives.length, negatives, scratch: root }));
