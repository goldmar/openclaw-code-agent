// Read-only native review attribution; no app-server writer or transcript patch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { latestParentUser, messageText } from "./oca501-lifecycle-protocol.mjs";
const uuid = (value) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function reviewDelegate(input, expected) {
  assert.ok(typeof expected.instructions === "string" && expected.instructions && expected.startedAt);
  const latest = latestParentUser(input); assert.ok(latest && messageText(latest).includes(expected.instructions), "Current real review input carries the admitted unique action");
  assert.ok(!messageText(latest).trim().startsWith("```") && !messageText(latest).trim().startsWith(">"));
  const meta = input.client_metadata; assert.ok(meta && typeof meta["x-codex-turn-metadata"] === "string");
  const canonical = JSON.parse(meta["x-codex-turn-metadata"]);
  assert.ok(uuid(canonical.thread_id) && uuid(canonical.parent_thread_id));
  for (const field of ["turn_id", "parent_turn_id"]) assert.ok(typeof canonical[field] === "string" && canonical[field]);
  assert.equal(canonical.request_kind, "turn"); assert.equal(canonical.subagent_kind, "review");
  assert.equal(canonical.parent_thread_id, expected.threadId); assert.notEqual(canonical.thread_id, expected.threadId);
  for (const field of ["thread_id", "turn_id"]) if (Object.hasOwn(meta, field)) assert.equal(meta[field], canonical[field]);
  if (Object.hasOwn(meta, "x-codex-parent-thread-id")) assert.equal(meta["x-codex-parent-thread-id"], canonical.parent_thread_id);
  if (Object.hasOwn(meta, "x-openai-subagent")) assert.equal(meta["x-openai-subagent"], "review");
  return { childThreadId: canonical.thread_id, childTurnId: canonical.turn_id, originalThreadId: canonical.parent_thread_id, originalTurnId: canonical.parent_turn_id, instructions: expected.instructions };
}
export function assertFullReviewOutput(value, expected) {
  assert.deepEqual(Object.keys(value ?? {}).toSorted(), ["findings", "overall_correctness", "overall_explanation", "overall_confidence_score"].toSorted());
  assert.deepEqual(value.findings, []); assert.equal(value.overall_correctness, "patch is correct"); assert.equal(value.overall_confidence_score, 1);
  assert.equal(typeof value.overall_explanation, "string"); assert.ok(value.overall_explanation);
  assert.deepEqual(value, expected, "Actual native structured review output equals the whole emitted object; fallback is not proof"); return value;
}
export function projectNativeReview(lines, expected, complete) {
  const metadata = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.type === "session_meta");
  assert.equal(metadata.length, 1); const session = metadata[0].line.payload;
  assert.equal(session.id, expected.originalThreadId); assert.equal(session.cwd, expected.workdir); assert.equal(session.cli_version, "0.159.3");
  const events = lines.flatMap((line, index) => line.type === "event_msg" && line.payload ? [{ event: line.payload, index }] : []);
  const starts = events.filter(({ event }) => ["task_started", "turn_started"].includes(event.type) && event.turn_id === expected.originalTurnId); assert.equal(starts.length, 1);
  const entries = events.filter(({ event, index }) => index > starts[0].index && ((event.type === "entered_review_mode" && event.turn_id === expected.originalTurnId && event.target?.type === "custom" && event.target.instructions === expected.instructions) || (event.type === "item_completed" && event.thread_id === expected.originalThreadId && event.turn_id === expected.originalTurnId && event.item?.type === "EnteredReviewMode" && event.item.target?.type === "custom" && event.item.target.instructions === expected.instructions)));
  assert.equal(entries.length, 1, "Exact original review turn has one real review entry");
  const selected = [starts[0], entries[0]];
  let actualOutput;
  if (complete) {
    const exits = events.filter(({ event, index }) => index > entries[0].index && ((event.type === "exited_review_mode" && event.turn_id === expected.originalTurnId) || (event.type === "item_completed" && event.thread_id === expected.originalThreadId && event.turn_id === expected.originalTurnId && event.item?.type === "ExitedReviewMode")));
    assert.equal(exits.length, 1); actualOutput = exits[0].event.review_output ?? exits[0].event.item?.review_output;
    assertFullReviewOutput(actualOutput, expected.output);
    const ends = events.filter(({ event, index }) => index > exits[0].index && ["task_complete", "turn_complete"].includes(event.type) && event.turn_id === expected.originalTurnId && !event.error); assert.equal(ends.length, 1);
    selected.push(exits[0], ends[0]);
  }
  return { projection: true, rawRolloutAndOtherTurnsExcluded: true, originalThreadId: session.id, ownedCwdVerified: true, nativeVersion: session.cli_version, originalTurnId: expected.originalTurnId, instructions: expected.instructions, selected: selected.map(({ event, index }) => ({ index, type: event.type, turnId: event.turn_id, itemId: event.item?.id ?? event.item_id })), ...(complete ? { actualOutput, nativeReviewCompleted: true } : {}) };
}
export function readNativeReview(root, expected, complete) {
  assert.ok(uuid(expected.originalThreadId), "Only an admitted native UUID selects a rollout");
  assert.equal(realpathSync(root), root, "Owned CODEX_HOME has no symlink identity");
  const owned = (stat) => { assert.equal(stat.uid, process.getuid(), "Native readback belongs to the actual runner UID"); };
  owned(lstatSync(root));
  const files = []; let visited = 0;
  const visit = (directory, depth) => {
    assert.ok(depth <= 6 && ++visited <= 256, "Bounded owned native session directory observation");
    const stat = lstatSync(directory); owned(stat); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), "No native rollout symlink traversal");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(expected.originalThreadId)) files.push(path);
    }
  };
  visit(join(root, "sessions"), 0); assert.equal(files.length, 1, "One organic original-thread rollout; no candidate borrowing");
  const path = files[0], stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024);
  owned(stat); assert.equal(realpathSync(path), path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try { const opened = fstatSync(fd); owned(opened); assert.equal(opened.dev, stat.dev); assert.equal(opened.ino, stat.ino); bytes = readFileSync(fd); } finally { closeSync(fd); }
  assert.ok(bytes.length <= 4 * 1024 * 1024);
  let projected;
  try { const lines = bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line)); projected = projectNativeReview(lines, expected, complete); }
  catch { throw new Error(`Original native review facts invalid or incomplete; raw rollout excluded; bytes=${bytes.length}; sha256=${createHash("sha256").update(bytes).digest("hex")}`); }
  return { ...projected, relativePath: relative(root, path), originalBytes: bytes.length, originalSha256: createHash("sha256").update(bytes).digest("hex"), originalScope: "Internal original native rollout bytes before safe projection; raw bytes excluded" };
}
