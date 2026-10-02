// Bounded structured feature receipts; raw config, logs and model bodies are excluded.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const sha = value => createHash("sha256").update(value).digest("hex");
export const FILE_LIMIT = 4 * 1024 * 1024;
export const HOST_PIN = "c074824a27c96d3983043f9eeb33823cd1772d8c";
export const assignments = Object.freeze({ smoke: [], admission: ["admission"], gates: ["whole-gate"], live: ["live-policy"], restore: ["organic-restore"], all: ["admission", "whole-gate", "live-policy", "organic-restore", "immutable-history", "end-to-end-cleanup"] });
export function excluded(name, bytes, domain = "original captured bytes") {
  assert.ok(/^[a-z][a-z0-9.-]*$/.test(name));
  return { name, disposition: "EXCLUDED", bytes: bytes.length, sha256: sha(bytes), domain };
}
function privacy(value, secrets) {
  if (Array.isArray(value)) return value.map(item => privacy(item, secrets));
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) assert.ok(!/^(?:auth|token|apiKey|botToken|environment|config|providers|defaults|bindings|transcript|raw)$/i.test(key), "Raw profile or transcript field refused");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, privacy(item, secrets)]));
  }
  if (typeof value === "string") {
    for (const secret of secrets) { assert.ok(secret.length >= 8);
      value = value.replaceAll(secret, "[fixture credential]");
      }
    assert.ok(value.length <= 4096, "Unbounded text is not a structured proof");
  }
  return value;
}
export function validateReceipt(receipt, expected) {
  assert.equal(receipt.format, "oca501-slim-v1");
  assert.equal(receipt.complete, true);
  for (const field of ["candidateSha", "nodeVersion", "scenario"]) assert.equal(receipt[field], expected[field]);
  assert.match(receipt.candidateSha, /^[a-f0-9]{40}$/);
  assert.ok(["24.16.0", "26.1.0"].includes(receipt.nodeVersion));
  assert.equal(receipt.hostVersion, "2026.9.7");
  assert.equal(receipt.hostCommit, HOST_PIN);
  assert.equal(receipt.nativeVersion, "0.159.3");
  assert.ok(Object.hasOwn(assignments, receipt.scenario));
  assert.deepEqual(receipt.assigned, assignments[receipt.scenario]);
  assert.equal(new Set(receipt.completed).size, receipt.completed.length);
  for (const id of receipt.completed) assert.ok(receipt.assigned.includes(id));
  assert.ok(["PASS", "BLOCKED"].includes(receipt.disposition));
  if (receipt.disposition === "PASS") { assert.deepEqual(receipt.completed, receipt.assigned);
    assert.equal(receipt.cleanup.complete, true);
    assert.equal(receipt.failure, null);
    }
  assert.ok(receipt.cleanup && Array.isArray(receipt.cleanup.failures));
  assert.ok(Array.isArray(receipt.excluded));
  for (const item of receipt.excluded) { assert.equal(item.disposition, "EXCLUDED");
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0);
    }
  privacy(receipt, []);
  return receipt;
}
export function frameReceipt(receipt, secrets = []) {
  let safe = privacy(receipt, secrets);
  validateReceipt(safe, safe);
  let bytes = Buffer.from(JSON.stringify(safe) + "\n");
  if (bytes.length > FILE_LIMIT) {
    safe = { ...safe, disposition: "BLOCKED", failure: safe.failure ?? { stage: "export", code: "STRUCTURED_PROOF_BOUND_EXCEEDED" },
      proofs: [], excluded: [...safe.excluded, excluded("oversized-proof.json", bytes, "complete sanitized receipt before bounded exclusion")] };
    receipt.disposition = "BLOCKED"; receipt.failure = safe.failure;
    validateReceipt(safe, safe); bytes = Buffer.from(JSON.stringify(safe) + "\n");
  }
  assert.ok(bytes.length <= FILE_LIMIT);
  return `OCA501_SLIM ${JSON.stringify({ sha256: sha(bytes), bytes: bytes.length, content: bytes.toString("base64") })}\n`;
}
export function decodeReceipt(stdout, expected) {
  const frames = stdout.split("\n").filter(line => line.startsWith("OCA501_SLIM "));
  assert.equal(frames.length, 1, "Exactly one complete owning-job receipt required");
  const frame = JSON.parse(frames[0].slice(12));
  assert.ok(Number.isInteger(frame.bytes) && frame.bytes > 0 && frame.bytes <= FILE_LIMIT);
  assert.ok(typeof frame.content === "string" && frame.content.length <= 2 * FILE_LIMIT);
  const bytes = Buffer.from(frame.content, "base64");
  assert.equal(bytes.length, frame.bytes);
  assert.equal(sha(bytes), frame.sha256);
  assert.deepEqual(Buffer.from(bytes.toString("utf8")), bytes);
  const receipt = validateReceipt(JSON.parse(bytes), expected);
  return { receipt, bytes, sha256: frame.sha256 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}, args = process.argv.slice(2);
  assert.equal(args.length, 10);
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(["--decode", "--out", "--expected-sha", "--node-version", "--scenario"].includes(args[i]) && !Object.hasOwn(options, args[i]));
    assert.ok(args[i + 1]);
    options[args[i]] = args[i + 1];
  }
  assert.ok(isAbsolute(options["--decode"]) && isAbsolute(options["--out"]));
  assert.equal(existsSync(options["--out"]), false, "Decode into a new directory only");
  const decoded = decodeReceipt(readFileSync(options["--decode"], "utf8"), { candidateSha: options["--expected-sha"], nodeVersion: options["--node-version"], scenario: options["--scenario"] });
  mkdirSync(options["--out"], { mode: 0o700 });
  writeFileSync(resolve(options["--out"], "receipt.json"), decoded.bytes, { mode: 0o600 });
  console.log(JSON.stringify({ disposition: decoded.receipt.disposition, scenario: decoded.receipt.scenario, completed: decoded.receipt.completed, sha256: decoded.sha256 }));
}
