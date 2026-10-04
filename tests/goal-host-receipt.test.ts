import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assignments, decodeReceipt, excluded, frameReceipt, FILE_LIMIT, HOST_PIN, requiredFact, sha } from "../scripts/e2e/oca501-evidence.mjs";
import { optionsFor, visibleProof, stopOwnedChild, processIdentity, currentOwner, FeatureRun, until, patchAcknowledgementProof, configPatchFailureProof, assertPolicyRestoreOwner } from "../scripts/e2e/oca-goal-host-acceptance.mjs";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Readable } from "node:stream";
import { currentNativeIntent, nativeExecutionCall, matchingNativeOutput, policyRestoreIntent, NATIVE_COMMAND, NATIVE_READ_COMMAND, assertNativeExecutionResult, responsesFixture } from "../scripts/e2e/oca501-native-protocol.mjs";
import { Session } from "../src/session";
import { SessionStore } from "../src/session-store";
import { GoalController, normalizeVerifierCommands } from "../src/goal-controller";
import { formatSessionListing } from "../src/format";
import { GoalTaskStore } from "../src/goal-store";
import { SessionRuntimeRegistry } from "../src/session-runtime-registry";
import { SessionHarnessEventApplier } from "../src/session-harness-event-applier";
import type { SessionManager } from "../src/session-manager";
import type { GoalVerificationBinding, SessionConfig } from "../src/types";
import { getSessionOutputText, getSessionsListingText } from "../src/application/session-view";
const expected = { candidateSha: "a".repeat(40), nodeVersion: "24.16.0", scenario: "smoke" };
const receipt = (): any => ({ ...expected, format: "oca-repo-goal-slim-v1", complete: true, hostVersion: "2026.9.8", hostCommit: HOST_PIN, nativeVersion: "0.160.0", assigned: [], completed: [], disposition: "PASS", failure: null, cleanup: { complete: true, failures: [] }, excluded: [], proofs: [] });
describe("bounded representative host receipts", () => {
  it("recognizes policy child acknowledgements without accepting unrelated lexical prefixes or parent paths", () => {
    const field = "plugins.entries.openclaw-code-agent.config.goalVerificationPolicies";
    const ack = (paths: unknown) => ({ ok: true, hash: "changed", changedPaths: paths, sentinel: { payload: { stats: { requiresRestart: false } } } });
    for (const path of [field, `${field}.repositories`, `${field}.defaultRequiredCommands`]) {
      assert.deepEqual(patchAcknowledgementProof(ack([path]), "before", [field]), { patchAckOk: true, patchHashChanged: true, patchSelectedPathChanged: true, patchNoRestart: true });
    }
    for (const previousHash of [undefined, ""]) assert.equal(patchAcknowledgementProof(ack([field]), previousHash, [field]).patchHashChanged, false);
    for (const paths of [[], undefined, [null], [field, null], Array(1), [field.slice(0, field.lastIndexOf("."))], [`${field}Other.repositories`], ["tools.deny"]]) {
      assert.equal(patchAcknowledgementProof(ack(paths), "before", [field]).patchSelectedPathChanged, false);
    }
  });
  it("requires changed hash, no restart, same process and complete applied readback after a real patch acknowledgement", async () => {
    const field = "plugins.entries.openclaw-code-agent.config.goalVerificationPolicies";
    const identity = processIdentity(process.pid); assert.ok(identity);
    const ack = { ok: true, hash: "changed", changedPaths: [`${field}.repositories`], sentinel: { payload: { stats: { requiresRestart: false } } } };
    const after = { valid: true, hash: "changed", configRevisionHash: "applied", appliedConfigHash: "applied" };
    const make = (override = {}, readback = after) => {
      const calls: string[] = [], proofs: any[] = [];
      const run = Object.assign(Object.create(FeatureRun.prototype), { gatewayIdentity: identity, gateway: { pid: process.pid }, proofs,
        rpc: async (method: string) => { calls.push(method); return method === "config.patch" ? { ...ack, ...override } : calls.length === 1 ? { hash: "before" } : readback; } });
      return { run, calls, proofs };
    };
    const valid = make(); assert.deepEqual(await valid.run.patch({}, [field]), after);
    assert.deepEqual(valid.calls, ["config.get", "config.patch", "config.get"]);
    assert.deepEqual(valid.proofs[0], { patchAckOk: true, patchHashChanged: true, patchSelectedPathChanged: true, patchNoRestart: true });
    const invalidAcknowledgements: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ ok: false }, "PATCH_ACK_OK_REQUIRED"], [{ hash: "before" }, "PATCH_ACK_HASH_CHANGE_REQUIRED"],
      [{ hash: undefined }, "PATCH_ACK_HASH_CHANGE_REQUIRED"], [{ changedPaths: ["tools.deny"] }, "PATCH_ACK_SELECTED_PATH_REQUIRED"],
      [{ changedPaths: [`${field}Other.repositories`] }, "PATCH_ACK_SELECTED_PATH_REQUIRED"],
      [{ sentinel: { payload: { stats: { requiresRestart: true } } } }, "PATCH_ACK_NO_RESTART_REQUIRED"],
      [{ sentinel: undefined }, "PATCH_ACK_NO_RESTART_REQUIRED"],
    ];
    for (const [override, label] of invalidAcknowledgements) {
      const invalid = make(override); await assert.rejects(invalid.run.patch({}, [field]), new RegExp(label));
      assert.deepEqual(invalid.calls, ["config.get", "config.patch"], "a refused acknowledgement cannot proceed to applied readback");
      assert.equal(invalid.proofs.length, 1, "the closed acknowledgement facts survive before refusal");
    }
    for (const readback of [{ ...after, valid: false }, { ...after, hash: "stale" }, { ...after, appliedConfigHash: "stale" }, { ...after, configRevisionHash: "", appliedConfigHash: "" }]) {
      await assert.rejects(make({}, readback).run.patch({}, [field]));
    }
    const replaced = make(); replaced.run.gatewayIdentity = { ...identity, startTicks: "0" };
    await assert.rejects(replaced.run.patch({}, [field]));
    const r = receipt(); r.proofs.push(valid.proofs[0]);
    const decoded = decodeReceipt(frameReceipt(r), expected).receipt;
    assert.deepEqual(decoded.proofs, r.proofs);
    for (const field of ["patchAckOk", "patchHashChanged", "patchSelectedPathChanged", "patchNoRestart"]) {
      for (const invalid of [null, "true", 1]) assert.throws(() => frameReceipt({ ...r, proofs: [{ ...valid.proofs[0], [field]: invalid }] }));
    }
    assert.throws(() => frameReceipt({ ...r, proofs: [{ ...valid.proofs[0], rawAck: ack }] }), /Unknown feature proof field|Raw profile/);
  });
  it("declares exact repository-array replacement for removal and every selected-suite mutation", async () => {
    const field = "plugins.entries.openclaw-code-agent.config.goalVerificationPolicies";
    const root = mkdtempSync(join(tmpdir(), "oca-policy-patch-")), configPath = join(root, "config.json");
    const original = { repositories: [{ repository: "/fixture/a", requiredCommands: ["a", "a"] }, { repository: "/fixture/b", requiredCommands: ["b"] }] };
    const alias = { repositories: [...original.repositories, { repository: "/fixture/alias", requiredCommands: ["a"] }] };
    const changedA = structuredClone(original); changedA.repositories[0].requiredCommands = ["changed-a"];
    const changedB = structuredClone(original); changedB.repositories[1].requiredCommands = ["changed-b"];
    const identity = processIdentity(process.pid); assert.ok(identity);
    try {
      for (const [previous, next] of [[alias, original], [original, changedA], [original, changedB], [changedA, original]]) {
        const wrap = (policies: unknown) => ({ plugins: { entries: { "openclaw-code-agent": { config: { goalVerificationPolicies: policies } } } } });
        writeFileSync(configPath, JSON.stringify(wrap(previous)));
        let patched = false;
        const patches: any[] = [], proofs: any[] = [];
        const run = Object.assign(Object.create(FeatureRun.prototype), { env: { OPENCLAW_CONFIG_PATH: configPath }, proofs, gatewayIdentity: identity, gateway: { pid: process.pid },
          rpc: async (method: string, params?: any) => {
            if (method === "config.patch") {
              assert.equal(params.baseHash, "before");
              assert.deepEqual(params.replacePaths, [`${field}.repositories`], "host array intent is exact, never its policy parent");
              assert.deepEqual(JSON.parse(params.raw), wrap(next)); patches.push(params); patched = true;
              return { ok: true, hash: "after", changedPaths: [`${field}.repositories`], sentinel: { payload: { stats: { requiresRestart: false } } } };
            }
            assert.equal(method, "config.get");
            return { valid: true, hash: patched ? "after" : "before", configRevisionHash: patched ? "after" : "before", appliedConfigHash: patched ? "after" : "before", config: wrap(patched ? next : previous) };
          } });
        await run.setPolicies(next); assert.equal(patches.length, 1); assert.deepEqual(run.currentPolicies, next);
        assert.equal(proofs[0].patchSelectedPathChanged, true); assert.deepEqual(proofs[1].mutation, [`${field}.repositories`]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("proves an empty required suite reaches schema validation rather than an earlier patch refusal", async () => {
    const path = "plugins.entries.openclaw-code-agent.config.goalVerificationPolicies.repositories";
    const schema = { error: { code: "INVALID_REQUEST", message: "invalid config: plugins.entries.openclaw-code-agent.config: /goalVerificationPolicies/repositories/0/requiredCommands: must NOT have fewer than 1 items" } };
    const make = (result: { code: number; stdout: string }, revision = "unchanged", changedEffects = false) => {
      let reads = 0, effectReads = 0;
      const run = Object.assign(Object.create(FeatureRun.prototype), { repoA: "/fixture/a",
        effects: () => ({ launches: changedEffects && effectReads++ ? 1 : 0 }),
        rpc: async () => ({ hash: ++reads > 1 ? revision : "unchanged" }),
        cli: async (args: string[], options: any) => {
          const params = JSON.parse(args[args.indexOf("--params") + 1]);
          assert.equal(options.allowFailure, true); assert.equal(params.baseHash, "unchanged");
          assert.deepEqual(params.replacePaths, [path]);
          assert.deepEqual(JSON.parse(params.raw).plugins.entries["openclaw-code-agent"].config.goalVerificationPolicies.repositories, [{ repository: "/fixture/a", requiredCommands: [] }]);
          return result;
        } });
      return { run, reads: () => reads };
    };
    const actual = { code: 1, stdout: JSON.stringify(schema) };
    const valid = make(actual); await valid.run.rejectEmptyPolicy(); assert.equal(valid.reads(), 2);
    for (const result of [
      { code: 1, stdout: JSON.stringify({ error: { code: "INVALID_REQUEST", message: "config.patch would remove entries from array path(s): private-path" } }) },
      { code: 1, stdout: JSON.stringify({ error: { code: "INVALID_REQUEST", message: "invalid config: unrelatedField" } }) },
      { code: 1, stdout: "not JSON" }, { code: 0, stdout: JSON.stringify(schema) },
      { code: 1, stdout: JSON.stringify({ error: { code: "UNAVAILABLE", message: schema.error.message } }) },
    ]) { const invalid = make(result); await assert.rejects(invalid.run.rejectEmptyPolicy()); assert.equal(invalid.reads(), 1); }
    await assert.rejects(make(actual, "modified").run.rejectEmptyPolicy());
    await assert.rejects(make(actual, "unchanged", true).run.rejectEmptyPolicy());
  });
  it("retains closed patch failure facts before the original CLI exit assertion without leaking error prose", async () => {
    const privateValue = "SYNTHETIC_PRIVATE_CONFIG_PATH";
    const output = { code: 1, stdout: JSON.stringify({ error: { code: "INVALID_REQUEST", message: `config.patch would remove entries from array path(s): ${privateValue}` } }), stderr: privateValue };
    const make = () => {
      const proofs: any[] = [], calls: any[] = [];
      const run = Object.assign(Object.create(FeatureRun.prototype), { hostEntry: "/fixture/host", proofs,
        command: async (_command: string, _args: string[], options: any) => { calls.push(options); return output; } });
      return { run, proofs, calls };
    };
    const args = ["gateway", "call", "config.patch", "--params", "{}", "--json"];
    const denied = make(); await assert.rejects(denied.run.cli(args), /CONFIG_PATCH_EXIT_REQUIRED/);
    assert.equal(denied.calls[0].allowFailure, true); assert.equal(denied.proofs[0].patchArrayIntentDenied, true);
    const allowedFailure = make(); assert.deepEqual(await allowedFailure.run.cli(args, { allowFailure: true }), output);
    assert.deepEqual(allowedFailure.proofs, denied.proofs);
    assert.equal(configPatchFailureProof({ code: 1, stdout: "unknown private error" }).patchErrorCode, "UNKNOWN");
    assert.equal(configPatchFailureProof({ code: 0, stdout: "not JSON" }).patchErrorCode, "UNKNOWN");
    assert.equal(configPatchFailureProof({ code: 0, stdout: JSON.stringify({ ok: true }) }).patchErrorCode, "NONE");
    for (const code of ["INVALID_REQUEST", "UNAVAILABLE", "CONFLICT", "RATE_LIMITED"]) assert.equal(configPatchFailureProof({ code: 1, stdout: JSON.stringify({ error: { code } }) }).patchErrorCode, code);
    assert.equal(configPatchFailureProof({ code: 1, stdout: JSON.stringify({ error: { code: privateValue } }) }).patchErrorCode, "UNKNOWN");
    const r = receipt(); r.proofs = denied.proofs;
    const encoded = frameReceipt(r); assert.equal(encoded.includes(privateValue), false);
    assert.deepEqual(decodeReceipt(encoded, expected).receipt.proofs, denied.proofs);
    for (const key of ["patchResponseParsed", "patchArrayIntentDenied", "patchRequiredCommandsSchemaDenied", "patchRateLimitDenied", "patchBaseHashDenied"]) {
      for (const value of [null, "true", 1]) assert.throws(() => frameReceipt({ ...r, proofs: [{ ...denied.proofs[0], [key]: value }] }));
    }
    for (const value of [null, privateValue, 1]) assert.throws(() => frameReceipt({ ...r, proofs: [{ ...denied.proofs[0], patchErrorCode: value }] }));
    assert.throws(() => frameReceipt({ ...r, proofs: [{ ...denied.proofs[0], rawError: privateValue }] }));
  });
  it("requires exact external identity even on BLOCKED evidence", () => {
    const r = receipt(); r.disposition = "BLOCKED";
    const frame = frameReceipt(r); assert.deepEqual(decodeReceipt(frame, expected).receipt, r);
    for (const override of [{ candidateSha: "b".repeat(40) }, { nodeVersion: "26.1.0" }, { scenario: "all" }]) assert.throws(() => decodeReceipt(frame, { ...expected, ...override }));
    assert.throws(() => decodeReceipt(frame + frame, expected));
    assert.throws(() => decodeReceipt(frame.slice(0, -10), expected));
  });
  it("never calls an incomplete scenario or failed cleanup PASS", () => {
    const r = receipt(); r.scenario = "all"; r.assigned = [...assignments.all];
    assert.throws(() => frameReceipt(r));
    r.completed = [...assignments.all]; assert.doesNotThrow(() => frameReceipt(r));
    r.cleanup.complete = false; r.cleanup.failures = ["OWNED_CHILD_SHUTDOWN_FAILED"]; assert.throws(() => frameReceipt(r));
    r.disposition = "BLOCKED"; assert.doesNotThrow(() => frameReceipt(r));
    r.completed.push("foreign"); assert.throws(() => frameReceipt(r));
  });
  it("exports raw excluded stream identity without raw credentials or configuration", () => {
    const privateValue = "SYNTHETIC_PRIVATE_CREDENTIAL";
    const r = receipt(); r.excluded = [excluded("runtime.log", Buffer.from(`apiKey=${privateValue}`))] as any;
    const framed = frameReceipt(r); const decoded = decodeReceipt(framed, expected);
    assert.equal(JSON.stringify(decoded.receipt).includes(privateValue), false);
    assert.equal(decoded.receipt.excluded[0].bytes, Buffer.byteLength(`apiKey=${privateValue}`));
    for (const key of ["auth", "apiKey", "defaults", "bindings", "transcript", "environment"]) assert.throws(() => frameReceipt({ ...receipt(), proofs: [{ [key]: privateValue }] }));
    const redacted = decodeReceipt(frameReceipt({ ...receipt(), proofs: [{ ownRunId: privateValue }] }, [privateValue]), expected);
    assert.equal(JSON.stringify(redacted.receipt).includes(privateValue), false);
    assert.throws(() => frameReceipt({ ...receipt(), proofs: [{ safe: "x".repeat(FILE_LIMIT) }] }));
    const large = { ...receipt(), proofs: Array.from({ length: 1100 }, () => ({ ownRunId: "x".repeat(4096) })) };
    const bounded = decodeReceipt(frameReceipt(large), expected); assert.equal(bounded.receipt.disposition, "BLOCKED");
    assert.equal(bounded.receipt.failure.code, "STRUCTURED_PROOF_BOUND_EXCEEDED"); assert.ok(bounded.bytes.length <= FILE_LIMIT);
  });
  it("rejects unknown or repeated selectors before any host effects", () => {
    const args = ["--expected-sha", expected.candidateSha, "--node-version", expected.nodeVersion, "--artifacts", "/tmp/oca501-owned"];
    assert.equal((optionsFor(args) as Record<string, string>)["--scenario"], "all");
    for (const scenario of Object.keys(assignments)) assert.equal((optionsFor([...args, "--scenario", scenario]) as Record<string, string>)["--scenario"], scenario);
    for (const extra of [["--scenario", "foreign"], ["--scenario", "gates,live"], ["--scenario", ""], ["--scenario", "smoke", "--scenario", "all"], ["--command", "anything"]]) assert.throws(() => optionsFor([...args, ...extra]));
  });
  it("joins a visible own run to exactly one canonical response and actual provider result", () => {
    const identity = { runId: "own-run", sessionId: "own-session", sessionKey: "own-key" };
    const result = { runId: identity.runId, status: "ok", terminalReply: { disposition: "visible", text: "Harmless receipt" } };
    const message = { role: "assistant", responseId: "resp_1", __openclaw: { runId: identity.runId }, content: [{ type: "text", text: result.terminalReply.text }] };
    const history = { sessionId: identity.sessionId, sessionKey: identity.sessionKey, messages: [message] };
    const requests = [{ native: false, completed: true, responseId: "resp_1", text: result.terminalReply.text }];
    assert.doesNotThrow(() => visibleProof(result, history, requests, identity));
    for (const mutate of [
      (r: any, h: any) => { r.runId = "foreign"; }, (r: any) => { r.status = "error"; },
      (r: any) => { r.terminalReply.disposition = "silent"; }, (r: any) => { r.terminalReply.text = " no_reply "; },
      (r: any) => { r.yielded = true; }, (r: any) => { r.terminalReply.yielded = "false"; },
      (_r: any, h: any) => { h.sessionId = "foreign"; }, (_r: any, h: any) => { h.messages.push(h.messages[0]); },
      (_r: any, h: any) => { h.messages[0].__openclaw.truncated = true; },
      (_r: any, h: any) => { h.messages[0].responseId = "foreign"; },
      (_r: any, h: any) => { h.messages[0].content[0].text = "different"; },
    ]) { const r = structuredClone(result), h = structuredClone(history); mutate(r, h); assert.throws(() => visibleProof(r, h, requests, identity)); }
    assert.throws(() => visibleProof(result, history, [...requests, requests[0]], identity));
  });

  it("exports a closed required fact and refuses unknown nested proof fields even during decode", () => {
    const extra = { required: true, producer: "goal", outcomeKey: "goal:owned", credentials: { password: "SYNTHETIC_PRIVATE_VALUE" }, unknownDetail: "SYNTHETIC_PRIVATE_VALUE" };
    assert.deepEqual(requiredFact(extra), { required: true, producer: "goal", outcomeKey: "goal:owned" });
    assert.doesNotThrow(() => frameReceipt({ ...receipt(), proofs: [{ requiredAdmissionFact: requiredFact(extra) }] }));
    for (const proofs of [[{ requiredAdmissionFact: extra }], [{ unknownDetail: extra }], [{ gateway: { pid: 1, unknownDetail: extra } }]]) {
      assert.throws(() => frameReceipt({ ...receipt(), proofs }));
      const bytes = Buffer.from(JSON.stringify({ ...receipt(), proofs }) + "\n");
      const frame = `OCA501_SLIM ${JSON.stringify({ content: bytes.toString("base64"), bytes: bytes.length, sha256: excluded("proof.json", bytes).sha256 })}\n`;
      assert.throws(() => decodeReceipt(frame, expected));
    }
    assert.throws(() => frameReceipt({ ...receipt(), cleanup: { complete: true, failures: ["OWNED_CHILD_SHUTDOWN_FAILED"] } }));
  });
  it("exports actual normalized verifier specs through the terminal proof without unapproved metadata", async () => {
    const commands = ["bash ci.sh", "bash lint.sh", "bash ci.sh"];
    const verifierCommands = normalizeVerifierCommands(commands.map((command, i) => ({ label: `check-${i + 1}`, command })));
    assert.ok(verifierCommands.every(spec => Object.hasOwn(spec, "timeoutMs")));
    assert.throws(() => frameReceipt({ ...receipt(), proofs: [{ verifierCommands }] }));
    const binding: GoalVerificationBinding = { version: 1, source: "default", requiredCommands: commands, additionalCommands: [], identity: { kind: "directory", path: "/tmp/own", device: "fixture", inode: "fixture" }, policyFingerprint: "fixture" };
    const goal = { id: "goal", status: "succeeded", sessionId: "session", sessionName: "own", goalVerificationBinding: binding, verifierCommands, iteration: 0 };
    const row = { sessionId: goal.sessionId, name: goal.sessionName, workdir: "/tmp/own", goalTaskId: goal.id, backendRef: { conversationId: "thread" } };
    const listing = formatSessionListing({ id: row.sessionId, name: row.name, workdir: row.workdir, status: "completed", phase: "terminal", duration: 1, prompt: "Own", multiTurn: true, costUsd: 0 });
    let settled = false;
    const run = Object.assign(Object.create(FeatureRun.prototype), { proofs: [], goals: () => [goal], sessions: () => [row],
      invoke: async () => ({ content: [{ text: listing }] }), completion: async (owner: typeof row, required: boolean) => { assert.equal(owner, row); assert.equal(required, true); settled = true; } });
    await run.terminal(goal, { threadId: "thread", workdir: row.workdir, executed: true }, "succeeded");
    assert.equal(settled, true);
    const proof = decodeReceipt(frameReceipt({ ...receipt(), proofs: run.proofs }), expected).receipt.proofs[0];
    assert.deepEqual(proof.verifierCommands, commands.map((command, i) => ({ label: `check-${i + 1}`, command })));
    assert.deepEqual(proof.requiredCommands, commands); assert.equal(proof.terminalRowSha256, sha(JSON.stringify(goal)));
    assert.equal(verifierCommands.every(spec => Object.hasOwn(spec, "timeoutMs")), true, "Original full terminal specs remain untouched");
  });
  it("settles unchanged required tuples without historical process-local wait handles", async () => {
    const row: any = { sessionId: "own", deliveryState: "idle", completionWakeRoutedReply: false,
      completionWakeSummaryFact: { required: true, producer: "terminal", outcomeKey: "completed" }, completionWakeOutcomeKey: "completed",
      completionWakeRunId: "old-run", completionWakeIssuedAt: 1, completionWakeSucceededAt: 2,
      notificationDedupe: [{ key: "notice", label: "completed", status: "delivered" }] };
    const proofs = [{ sessionId: "own", ownRunId: "old-run", outcomeKey: "completed", issuedAt: 1, succeededAt: 2,
      requiredAdmissionFact: row.completionWakeSummaryFact, notificationKeys: [{ key: "notice", label: "completed" }] },
      { ownRunId: "old-run", responseId: "response", canonicalSha256: sha("Own visible result"), visible: true }];
    const history: any = { sessionId: "parent", sessionKey: "key", messages: [{ role: "assistant", responseId: "response", __openclaw: { runId: "old-run" }, content: [{ type: "text", text: "Own visible result" }] },
      { role: "assistant", responseId: "historical", __openclaw: { runId: "historical-run" }, content: [{ type: "text", text: "Historical record without a current wait handle" }] }] };
    const methods: string[] = [], run = Object.assign(Object.create(FeatureRun.prototype), { parentId: "parent", sessionKey: "key", proofs, sessions: () => [row],
      rpc: async (method: string) => { methods.push(method); assert.equal(method, "chat.history", "No historical agent.wait allowed"); return history; } });
    await run.settleParentReplies(); assert.deepEqual(methods, ["chat.history"]);
    for (const change of [{ completionWakeRunId: "new-run" }, { completionWakeSummaryFact: undefined }, { completionWakeSummaryFact: { ...row.completionWakeSummaryFact, required: false } },
      { completionWakeSucceededAt: 3 }, { completionWakeSkippedAt: 4 }, { deliveryState: "wake_pending" }, { notificationDedupe: [{ key: "notice", label: "completed", status: "in_flight" }] }]) {
      const original = { ...row }; Object.assign(row, change); await assert.rejects(run.settleParentReplies());
      for (const key of Object.keys(row)) delete row[key]; Object.assign(row, original);
    }
    const originalRows = run.sessions; run.sessions = () => [row, { ...row, sessionId: "new-owner" }]; await assert.rejects(run.settleParentReplies());
    run.sessions = (): never[] => []; await assert.rejects(run.settleParentReplies()); run.sessions = originalRows;
    history.messages[0].responseId = "foreign"; await assert.rejects(run.settleParentReplies());
    history.messages[0].responseId = "response"; history.messages[0].content[0].text = "Changed result"; await assert.rejects(run.settleParentReplies());
    assert.equal(methods.includes("agent.wait"), false);
  });
  it("releases only the registered original harmless barrier before graceful failure cleanup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oca501-held-cleanup-")), workspace = join(directory, "workspace"), workdir = join(workspace, "case");
    mkdirSync(workdir, { recursive: true }); const script = join(workdir, "ci.sh");
    writeFileSync(script, "echo ready; while [ ! -f release ]; do sleep 0.02; done; exit 0\n");
    const child = spawn("bash", [script], { cwd: workdir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let identity: ReturnType<typeof processIdentity>;
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); }); identity = processIdentity(child.pid); assert.ok(identity);
      const primary = { stage: "live-policy:original-task-check-held", code: "REQUIRED_FEATURE_PROOF_FAILED" }, r = receipt(); r.failure = primary; r.disposition = "BLOCKED";
      const barrier = { barrier: true, workdir, barrierProcess: identity, barrierScriptSha256: sha(readFileSync(script)) };
      const run = Object.assign(Object.create(FeatureRun.prototype), { directory, workspace, workdirs: [workdir], gateway: child, children: new Set(), receipt: r, raw: r.excluded, proofs: r.proofs,
        fixture: { cases: new Map([["case", barrier]]), requests: [] as never[], failures: [] as never[], close: async (): Promise<void> => {} },
        shutdown: async () => { await until(() => child.exitCode !== null, 2000); const stopped = await stopOwnedChild(child, { identity, graceMs: 100, killMs: 100 }); assert.equal(stopped.complete, true); assert.equal(stopped.graceful, true); assert.equal(child.exitCode, 0); } });
      run.gateway = undefined; barrier.barrierScriptSha256 = "0".repeat(64);
      assert.equal(await run.cleanup(), false); assert.equal(existsSync(join(workdir, "release")), false); assert.equal(processIdentity(child.pid)?.startTicks, identity.startTicks);
      barrier.barrierScriptSha256 = sha(readFileSync(script)); run.gateway = child;
      assert.equal(await run.cleanup(), true); assert.equal(r.failure, primary); assert.equal(r.cleanup.complete, true);
      assert.deepEqual(decodeReceipt(frameReceipt(r), expected).receipt.failure, primary);
    } finally { const stopped = await stopOwnedChild(child, { identity, graceMs: 100, killMs: 100 }); if (stopped.complete) rmSync(directory, { recursive: true, force: true }); }
  });
  it("requires the latest registered native intent and the exact current turn/call", () => {
    const tag = "OCA501_CASE_control", prompt = `${tag}: Run the harmless receipt command.`;
    const message = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    const body = { tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      client_metadata: { thread_id: "own-thread", turn_id: "own-turn" }, input: [message("<environment_context><cwd>/tmp/own/case</cwd></environment_context>"), message(prompt)] };
    const options = { transport: "native-codex", caseTag: tag, workdir: "/tmp/own/case", ownedRoot: "/tmp/own", callId: "oca501_exec_1", itemId: "item", validate: () => ({ ok: true }), intent: { kind: "ordinary", prompt }, expectedIdentity: body.client_metadata };
    const call = nativeExecutionCall(body, options);
    for (const latest of ["Unrelated current request", "<environment_context><cwd>/tmp/own/case</cwd></environment_context>", `Quoted: ${prompt}`, `\x60\x60\x60\n${prompt}\n\x60\x60\x60`]) assert.throws(() => nativeExecutionCall({ ...body, input: [...body.input, message(latest)] }, options));
    assert.throws(() => nativeExecutionCall({ ...body, client_metadata: { ...body.client_metadata, turn_id: "foreign" } }, options));
    const restart = { kind: "restore", goal: `${tag}: Finish.`, ralph: true };
    assert.doesNotThrow(() => currentNativeIntent({ input: [message(`The OpenClaw gateway restarted while this Ralph-style goal task was running.\nResume from the prior session context and continue immediately.\n\nGoal:\n${restart.goal}\n\nInstructions:\n- Continue.`)] }, { caseTag: tag, intent: restart }));
    const result = { type: "function_call_output", call_id: call.callId, output: "real result" };
    assert.equal(matchingNativeOutput({ ...body, input: [...body.input, result] }, call), result);
    for (const change of [{ turn_id: "foreign" }, { thread_id: "foreign" }]) assert.throws(() => matchingNativeOutput({ ...body, client_metadata: { ...body.client_metadata, ...change }, input: [result] }, call));
    assert.throws(() => matchingNativeOutput({ ...body, input: [{ ...result, call_id: "foreign" }] }, call));
  });
  it("admits a policy restore only once for its original goal intent and distinct turn on the pinned thread", () => {
    const tag = "OCA501_CASE_restore", goal = `${tag}: Finish.`;
    const message = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    const intent = { kind: "launch", goal, ralph: false };
    const prefix = "The OpenClaw gateway restarted while this autonomous goal task was running.\nResume from the prior session context and continue toward the same goal immediately.";
    const body = { tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }], client_metadata: { thread_id: "own-thread", turn_id: "new-turn" }, input: [message("<environment_context><cwd>/tmp/own/case</cwd></environment_context>"), message(`${prefix}\n\nGoal:\n${goal}\n\nInstructions:\n- Continue.`)] };
    const fixture = () => ({ tag, intent, policyRestore: { phase: "registered", original: { harnessSessionId: "own-thread" }, originalTurn: "old-turn", originalExecutionComplete: true } });
    const restored = policyRestoreIntent(body, fixture()); assert.equal(restored.kind, "restore");
    assert.throws(() => currentNativeIntent(body, { caseTag: tag, intent }), "restore is not an unregistered launch");
    for (const phase of ["admitting", "admitted", "released", "consumed"]) { const f = fixture(); f.policyRestore.phase = phase; assert.throws(() => policyRestoreIntent(body, f)); }
    assert.throws(() => policyRestoreIntent(body, { ...fixture(), policyRestore: undefined }));
    const incomplete = fixture(); incomplete.policyRestore.originalExecutionComplete = false; assert.throws(() => policyRestoreIntent(body, incomplete));
    for (const metadata of [{ thread_id: "foreign", turn_id: "new-turn" }, { thread_id: "own-thread", turn_id: "old-turn" }, { thread_id: "own-thread", turn_id: "" }]) assert.throws(() => policyRestoreIntent({ ...body, client_metadata: metadata }, fixture()));
    const ralphPrefix = "The OpenClaw gateway restarted while this Ralph-style goal task was running.\nResume from the prior session context and continue immediately.";
    assert.throws(() => policyRestoreIntent({ ...body, input: [message(`${ralphPrefix}\n\nGoal:\n${goal}\n\nInstructions:\n- Continue.`)] }, fixture()));
    const options = { transport: "native-codex", caseTag: tag, workdir: "/tmp/own/case", ownedRoot: "/tmp/own", callId: "oca501_exec_1", itemId: "item", intent: restored, expectedIdentity: body.client_metadata, validate: () => ({ ok: true }) };
    const read = nativeExecutionCall(body, { ...options, receiptMode: "read-existing" });
    assert.equal((read.args as { cmd?: string }).cmd, NATIVE_READ_COMMAND);
    const result = { type: "function_call_output", call_id: read.callId, output: JSON.stringify({ exit_code: 0, output: "NATIVE-EXEC\n" }) };
    assert.doesNotThrow(() => assertNativeExecutionResult(matchingNativeOutput({ ...body, input: [...body.input, result] }, read), read, "NATIVE-EXEC\n"));
    assert.throws(() => assertNativeExecutionResult(result, read, "NATIVE-EXEC\nNATIVE-EXEC\n"), "restore cannot append a second marker");
    assert.throws(() => assertNativeExecutionResult({ ...result, output: JSON.stringify({ exit_code: 1, output: "NATIVE-EXEC\n" }) }, read, "NATIVE-EXEC\n"));
    assert.equal((nativeExecutionCall(body, options).args as { cmd?: string }).cmd, NATIVE_COMMAND, "a manually held restore still creates its own first receipt");
    assert.throws(() => nativeExecutionCall(body, { ...options, receiptMode: "arbitrary" }));
  });
  it("holds the actual fixture restore response until drain and requires its own matched read result", async () => {
    for (const revoke of ["none", "owner", "capability"]) {
      const root = mkdtempSync(join(tmpdir(), "oca-fixture-restore-")), workdir = join(root, "case"); mkdirSync(workdir);
      writeFileSync(join(workdir, "native-receipt.txt"), "NATIVE-EXEC\n");
      const deferred = Promise.withResolvers<void>(); let drained = false, responseReceived = false, ownerCurrent = true;
      const tag = "OCA501_CASE_control", intent = { kind: "launch", goal: `${tag}: Finish.`, ralph: false };
      const capability: any = { phase: "registered", original: { harnessSessionId: "thread" }, originalTurn: "old-turn", originalExecutionComplete: true, drained: deferred.promise,
        revalidate: async (record: any) => {
          assert.equal(drained, true); assert.equal(record, capability.record); assert.equal(record.owner.sessionId, "new-owner");
          if (revoke !== "none") queueMicrotask(() => {
            if (revoke === "owner") ownerCurrent = false;
            else fixture.policyRestore = { ...capability };
          });
          return () => { assert.equal(ownerCurrent, true, "replacement in the authorization return microtask must refuse"); assert.equal(record, capability.record); };
        } };
      const fixture: any = { tag, intent, workdir, threadId: "thread", turnId: "old-turn", executed: true, policyRestore: capability };
      const provider = await responsesFixture({ root, model: "fixture", key: "owned-fixture-key", validate: () => ({ ok: true }),
        observeNativeRestore: async (_fixture: any, record: any) => { assert.equal(capability.phase, "admitting"); assert.equal(record.threadId, "thread"); assert.equal(record.turnId, "new-turn"); },
        observeNative: async () => ({ sessionId: "new-owner", nativeProcess: {} }) });
      provider.cases.set(tag, fixture);
      const message = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
      const body = { model: "fixture", stream: true, tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }], client_metadata: { thread_id: "thread", turn_id: "new-turn" }, input: [message(`<environment_context><cwd>${workdir}</cwd></environment_context>`), message(`The OpenClaw gateway restarted while this autonomous goal task was running.\nResume from the prior session context and continue toward the same goal immediately.\n\nGoal:\n${intent.goal}\n\nInstructions:\n- Continue.`)] };
      const send = (input: any) => fetch(`${provider.url}/v1/responses`, { method: "POST", body: JSON.stringify(input), signal: AbortSignal.timeout(5000) });
      let failure: unknown;
      const pending = send(body).then(response => { responseReceived = true; return response; }).catch((error: unknown): undefined => { failure = error; return undefined; });
      try {
        await until(() => failure || capability.record?.owner, 5000); assert.equal(failure, undefined);
        assert.equal(responseReceived, false); assert.equal(fixture.executed, false, "the old result cannot prove restored execution");
        drained = true; capability.phase = "released"; deferred.resolve();
        const response = await pending;
        if (revoke !== "none") {
          assert.equal(response, undefined); assert.ok(failure); assert.equal(fixture.call, undefined);
          assert.equal(capability.phase, "released"); assert.equal(fixture.executed, false);
          assert.deepEqual(provider.failures, ["FIXTURE_NATIVE_OWNER_INVALID"]);
          assert.equal(readFileSync(join(workdir, "native-receipt.txt"), "utf8"), "NATIVE-EXEC\n");
          continue;
        }
        assert.ok(response); await response.text();
        assert.equal(capability.phase, "consumed"); assert.equal(fixture.call.receiptMode, "read-existing"); assert.equal(fixture.call.args.cmd, NATIVE_READ_COMMAND);
        assert.equal(fixture.executed, false);
        const output = { type: "function_call_output", call_id: fixture.call.callId, output: JSON.stringify({ exit_code: 0, output: "NATIVE-EXEC\n" }) };
        await (await send({ ...body, input: [...body.input, output] })).text();
        assert.equal(fixture.executed, true); assert.equal(provider.requests[1].executionExit, 0);
        assert.equal(readFileSync(join(workdir, "native-receipt.txt"), "utf8"), "NATIVE-EXEC\n");
        await assert.rejects(send({ ...body, client_metadata: { thread_id: "thread", turn_id: "another-turn" } }));
        assert.deepEqual(provider.failures, ["FIXTURE_NATIVE_IDENTITY_INVALID"]);
        assert.equal(provider.requests[2].fixtureFailureCode, "FIXTURE_NATIVE_IDENTITY_INVALID");
      } finally { fixture.shutdownExpected = true; deferred.resolve(); await provider.close(); rmSync(root, { recursive: true, force: true }); }
    }
  });
  it("requires the replacement current owner and immutable binding before and after policy-restore drain", () => {
    const original = { id: "goal", name: "own", goal: "Own goal", workdir: "/tmp/own", loopMode: "verifier", iteration: 0, sessionId: "old", harnessSessionId: "thread", goalVerificationBinding: { version: 1, requiredCommands: ["a", "a"], additionalCommands: ["extra"] }, verifierCommands: [{ command: "a" }, { command: "a" }, { command: "extra" }] };
    const goal = { ...structuredClone(original), status: "running", iteration: 1, sessionId: "new", sessionName: "new-owner" };
    const row = { sessionId: "new", name: "new-owner", goalTaskId: "goal", workdir: "/tmp/own", backendRef: { conversationId: "thread" } };
    const record = { threadId: "thread", turnId: "new-turn" };
    const cap = { phase: "admitting", original, originalTurn: "old-turn" };
    assert.doesNotThrow(() => assertPolicyRestoreOwner(cap, goal, row, record));
    const changedGoals: ReadonlyArray<Partial<typeof goal>> = [{ id: "foreign" }, { workdir: "/tmp/foreign" }, { sessionId: "old" }, { status: "completed" }, { iteration: 2 }, { harnessSessionId: "foreign" }, { goalVerificationBinding: { ...original.goalVerificationBinding, additionalCommands: [] } }, { verifierCommands: original.verifierCommands.slice(1) }];
    for (const change of changedGoals) assert.throws(() => assertPolicyRestoreOwner(cap, { ...goal, ...change }, row, record));
    for (const change of [{ sessionId: "foreign" }, { goalTaskId: "foreign" }, { workdir: "/tmp/foreign" }, { backendRef: { conversationId: "foreign" } }]) assert.throws(() => assertPolicyRestoreOwner(cap, goal, { ...row, ...change }, record));
    for (const change of [{ turnId: "old-turn" }, { threadId: "foreign" }]) assert.throws(() => assertPolicyRestoreOwner(cap, goal, row, { ...record, ...change }));
    assert.throws(() => assertPolicyRestoreOwner({ ...cap, phase: "consumed" }, goal, row, record));
    assert.throws(() => assertPolicyRestoreOwner({ ...cap, phase: "released", record }, goal, row, { ...record }), "a substituted response cannot consume the ticket after the drain await");
    assert.doesNotThrow(() => assertPolicyRestoreOwner({ ...cap, phase: "released", record }, goal, row, record));
  });
  it("drains the pinned admitted process before releasing restored model work and refuses a changed owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "oca-policy-drain-"));
    const child = spawn("bash", ["-c", `while [ ! -f release ]; do sleep 0.05; done; printf '%s\\n' '{"ordinal":1,"kind":"CI","exit":0}' > checks.jsonl`], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const identity = await until(() => { const current = processIdentity(child.pid!); return current?.executable.endsWith("/bash") && current; }, 5000); assert.ok(identity);
    let ownerCurrent = false, released = false;
    const capability = { phase: "admitted", record: { owner: { sessionId: "new" } }, check: identity, release: () => { released = true; } };
    const fixture = { workdir: root, policyRestore: capability };
    const run = Object.assign(Object.create(FeatureRun.prototype), { policyRestoreOwner: () => { assert.equal(ownerCurrent, true); } });
    try {
      await assert.rejects(run.drainPolicyRestore(fixture));
      assert.equal(existsSync(join(root, "release")), false); assert.equal(released, false);
      assert.equal(processIdentity(identity.pid)?.startTicks, identity.startTicks, "refusal leaves the original owned check held");
      ownerCurrent = true; await run.drainPolicyRestore(fixture);
      assert.equal(capability.phase, "released"); assert.equal(released, true);
      assert.notEqual(processIdentity(identity.pid)?.startTicks, identity.startTicks);
      assert.deepEqual(JSON.parse(readFileSync(join(root, "checks.jsonl"), "utf8")), { ordinal: 1, kind: "CI", exit: 0 });
      await assert.rejects(run.drainPolicyRestore(fixture), "the drain capability cannot be reused");
    } finally {
      const stopped = await stopOwnedChild(child, { identity, graceMs: 1000, killMs: 1000 });
      if (stopped.complete) rmSync(root, { recursive: true, force: true });
    }
  });
  it("keeps a retired admitted check separate from the restored owner's entire ordered suite", () => {
    const root = mkdtempSync(join(tmpdir(), "oca-restored-checks-"));
    const fixture = { tag: "OCA501_CASE_owned", workdir: root }, proofs: any[] = [];
    const run = Object.assign(Object.create(FeatureRun.prototype), { proofs });
    const expected = [["CI", 0], ["LINT", 0], ["CI", 0], ["EXTRA_A", 0]];
    const checks = [["CI", 0], ...expected].map(([kind, exit], i) => ({ ordinal: i + 1, kind, exit }));
    try {
      writeFileSync(join(root, "native-receipt.txt"), "NATIVE-EXEC\n");
      writeFileSync(join(root, "checks.jsonl"), checks.map(row => JSON.stringify(row)).join("\n"));
      run.checks(fixture, expected, [["CI", 0]]);
      assert.deepEqual(proofs[0].retiredChecks, checks.slice(0, 1)); assert.deepEqual(proofs[0].checks, checks.slice(1));
      assert.throws(() => run.checks(fixture, expected), "the retired result cannot replace a restored required check");
      for (const bad of [checks.slice(0, -1), [...checks.slice(0, 2), checks[3], checks[2], checks[4]], checks.map((row, i) => i === 1 ? { ...row, exit: 1 } : row)]) {
        writeFileSync(join(root, "checks.jsonl"), bad.map(row => JSON.stringify(row)).join("\n")); assert.throws(() => run.checks(fixture, expected, [["CI", 0]]));
      }
      const r = receipt(); r.proofs = [{ ...proofs[0], retiredAdmittedCheckDrained: true, restoredEffectiveSuitePassed: true }, { providerRequests: [{ fixtureFailureCode: "FIXTURE_INTENT_INVALID", call: { receiptMode: "read-existing" } }] }];
      assert.deepEqual(decodeReceipt(frameReceipt(r), { candidateSha: "a".repeat(40), nodeVersion: "24.16.0", scenario: "smoke" }).receipt.proofs, r.proofs);
      for (const value of ["PRIVATE_ERROR_PROSE", null, 1]) assert.throws(() => frameReceipt({ ...r, proofs: [{ providerRequests: [{ fixtureFailureCode: value }] }] }));
      assert.throws(() => frameReceipt({ ...r, proofs: [{ providerRequests: [{ call: { receiptMode: "PRIVATE_ERROR_PROSE" } }] }] }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("joins actual running recovery rows through the controller's current task association", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oca501-goal-owner-"));
    const fixture = { name: "own", workdir: directory, intent: { kind: "launch", goal: "Own intent" }, ralph: false };
    const store = new SessionStore({ indexPath: join(directory, "sessions.json"), env: {} });
    const registry = new SessionRuntimeRegistry();
    const earlier = new Session({ prompt: "Earlier", workdir: directory, harness: "codex" }, fixture.name);
    earlier.transition("running"); registry.add(earlier);
    let live!: Session;
    const manager = { setGoalTaskAuthorizer: () => {}, emitGoalTaskUpdate: () => {}, resolve: (id: string) => registry.sessions.get(id),
      launchAndAwaitRunning: async (config: SessionConfig) => {
        live = new Session({ ...config, backendRef: { kind: "codex-app-server", conversationId: "thread" } }, registry.uniqueName(config.name!));
        registry.add(live);
        (live as unknown as { harnessEvents: SessionHarnessEventApplier }).harnessEvents.applyMessage({ type: "backend_ref", ref: { kind: "codex-app-server", conversationId: "thread" } },
          { pendingPlanApproval: false, currentPermissionMode: "bypassPermissions", permissionMode: "bypassPermissions", planModeApproved: false });
        store.markRunning(live); return live;
      } };
    const controller = new GoalController(manager as unknown as SessionManager);
    (controller as unknown as { store: GoalTaskStore }).store = new GoalTaskStore({ OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH: join(directory, "goals.json") });
    try {
      const goal = await controller.launchTask({ name: fixture.name, goal: fixture.intent.goal, workdir: directory, verifierCommands: [{ label: "check", command: "true" }],
        loopMode: "verifier", permissionMode: "bypassPermissions", route: { provider: "webchat", target: "owned-parent" } });
      assert.equal(goal.sessionId, live.id); assert.equal(goal.sessionName, live.name); assert.notEqual(live.name, fixture.name);
      const row = store.getPersistedSession(live.id)!; assert.equal(Object.hasOwn(row, "goalTaskId"), false);
      const listing = getSessionsListingText({ list: () => [live], listPersistedSessions: () => store.listPersistedSessions() } as unknown as SessionManager, "running", undefined, { full: true });
      const bound = { ...fixture, goalId: goal.id, nativeSessionId: live.id };
      assert.equal(currentOwner([row], listing, bound, "thread", goal), row);
      assert.doesNotThrow(() => currentOwner([{ ...row, goalTaskId: goal.id }], listing, bound, "thread", goal));
      for (const change of [{ goalTaskId: "foreign" }, { goalTaskId: null }, { goalTaskId: "" }, { name: fixture.name }, { workdir: "/tmp/foreign" }, { backendRef: { conversationId: "foreign" } }])
        assert.throws(() => currentOwner([{ ...row, ...change }], listing, bound, "thread", goal));
      for (const change of [{ id: "foreign" }, { name: "foreign" }, { goal: "foreign" }, { workdir: "/tmp/foreign" }, { loopMode: "ralph" }, { status: "failed" }, { sessionId: "foreign" }, { sessionName: fixture.name }, { harnessSessionId: "foreign" }])
        assert.throws(() => currentOwner([row], listing, bound, "thread", { ...goal, ...change }));
      assert.throws(() => currentOwner([row, row], listing, bound, "thread", goal));
      for (const text of [listing + "\n\n" + listing, listing + "\n   ♻️ Recovered after a Gateway restart; no live process", listing.replace(`[${live.id}]`, "[foreign]")])
        assert.throws(() => currentOwner([row], text, bound, "thread", goal));
      assert.throws(() => currentOwner([row], listing, { ...bound, oldSessionId: live.id }, "thread", goal));
      let observedTasks: Array<typeof goal> = [{ ...goal, sessionName: undefined }], publicReads = 0, taskReads = 0;
      const identity = processIdentity(process.pid)!;
      const nativeFixture = { ...bound, nativeSnapshot: { gateway: identity, processes: [] as Array<NonNullable<ReturnType<typeof processIdentity>>> } };
      const run = Object.assign(Object.create(FeatureRun.prototype), { gatewayReady: true, gatewayIdentity: identity, proofs: [],
        goals: () => { taskReads++; return observedTasks; }, sessions: () => [row], nativeProcesses: () => [identity],
        invoke: async (name: string) => { publicReads++; assert.ok(observedTasks[0].sessionName); return { content: [{ text: name === "agent_sessions" ? listing : getSessionOutputText(manager as unknown as SessionManager, live.id) }] }; } });
      const waiting = run.nativeOwner(nativeFixture, { threadId: "thread" });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(taskReads > 0); assert.equal(publicReads, 0); observedTasks = [{ ...goal }];
      assert.equal((await waiting).sessionId, live.id);
      const before = publicReads;
      const contradictions: Array<Array<typeof goal>> = [[{ ...goal }, { ...goal }], [{ ...goal, harnessSessionId: "foreign" }], [{ ...goal, status: "failed" }]];
      for (const tasks of contradictions) {
        observedTasks = tasks; await assert.rejects(run.nativeOwner(nativeFixture, { threadId: "thread" })); assert.equal(publicReads, before);
      }
      const missingAndInvalid: Array<Partial<typeof goal>> = [{ sessionId: undefined, sessionName: null }, { sessionId: undefined, sessionName: " " },
        { sessionId: undefined, harnessSessionId: "foreign" }, { sessionName: undefined, sessionId: "foreign" },
        { sessionId: undefined, id: null }, { sessionId: undefined, id: " " }];
      for (const change of missingAndInvalid) {
        let reads = 0;
        run.goals = () => { reads++; return reads === 1 ? [{ ...goal, ...change }] : [{ ...goal }]; };
        await assert.rejects(run.nativeOwner({ ...nativeFixture, goalId: change.id === undefined ? goal.id : undefined }, { threadId: "thread" }));
        assert.equal(reads, 1); assert.equal(publicReads, before, "Invalid present fields cannot be retried away before public output");
      }
      const terminal = { ...row, status: "completed", goalTaskId: goal.id };
      assert.throws(() => currentOwner([terminal], listing, { ...fixture, name: live.name }, "thread", undefined), "Ordinary cannot borrow a goal owner");
    } finally {
      controller.stop(); earlier.kill("shutdown"); if (live) live.kill("shutdown");
      await Promise.all([earlier.waitForTeardown(), live?.waitForTeardown()]); rmSync(directory, { recursive: true, force: true });
    }
  });
  it("observes natural completion through the real listing without claiming the outcome", async () => {
    const origin = "agent:main:main", fixture: any = { name: "natural", workdir: "/tmp/owned-case", threadId: "thread", intent: { kind: "ordinary" } };
    const session = new Session({ prompt: "Receipt", workdir: fixture.workdir, harness: "codex", permissionMode: "bypassPermissions", worktreeStrategy: "off",
      originSessionKey: origin, backendRef: { kind: "codex-app-server", conversationId: fixture.threadId } }, fixture.name);
    session.transition("running");
    (session as any).turnRuntime.finishSuccessfulTurn({ currentPermissionMode: "bypassPermissions", permissionMode: "bypassPermissions", pendingPlanApproval: false, planModeApproved: false, hasPendingMessages: false });
    assert.equal(session.status, "completed"); assert.equal(session.phase, "terminal");
    const manager: any = { list: () => [session], listPersistedSessions: (): never[] => [], resolve: (id: string) => id === session.id ? session : undefined };
    let row: any = { sessionId: session.id, name: session.name, status: session.status, workdir: session.workdir, backendRef: session.backendRef };
    let listing = () => getSessionsListingText(manager, "all", undefined, { full: true });
    const calls: string[] = [], run = Object.assign(Object.create(FeatureRun.prototype), { proofs: [], sessions: () => [row], goals: () => [{ id: "goal", sessionId: session.id, sessionName: fixture.name, name: fixture.name, goal: "Finish" }],
      invoke: async (name: string) => { calls.push(name); return { content: [{ text: name === "agent_sessions" ? listing() : getSessionOutputText(manager, session.id, { readerSessionKey: origin }) }] }; } });
    await run.publicOwner(session.id, "completed", fixture);
    assert.deepEqual(calls, ["agent_sessions"]); assert.equal(session.outcomeSeenAt, undefined);
    for (const change of [{ status: "running" }, { status: "failed" }, { status: "killed" }, { name: "foreign" }, { workdir: "/tmp/foreign" }, { backendRef: { kind: "codex-app-server", conversationId: "foreign" } }, { goalTaskId: "foreign" }]) {
      const original = row; row = { ...row, ...change }; await assert.rejects(run.publicOwner(session.id, "completed", fixture)); row = original;
    }
    await assert.rejects(run.publicOwner("foreign", "completed", fixture));
    const originalListing = listing;
    for (const text of [originalListing().replace(`[${session.id}]`, "[foreign]"), originalListing() + "\n   ♻️ Recovered after a Gateway restart; no live process", `${originalListing()}\n\n${originalListing()}`, "Persisted output only"]) {
      listing = () => text; await assert.rejects(run.publicOwner(session.id, "completed", fixture));
    }
    listing = originalListing; fixture.intent = { kind: "launch", goal: "Finish" }; row.goalTaskId = "goal";
    await run.publicOwner(session.id, "completed", fixture); // A running GoalTask may own a terminal native Session.
    row.goalTaskId = "foreign"; await assert.rejects(run.publicOwner(session.id, "completed", fixture)); delete row.goalTaskId;
    await assert.rejects(run.publicOwner(session.id, "running"));
    assert.equal(typeof session.outcomeSeenAt, "number", "The old terminal agent_output read would consume the short-launch outcome");
    await session.waitForTeardown();
  });
  it("binds the sole newly admitted native instance and never reselects an earlier or replacement child", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oca501-native-owner-")), executable = join(directory, "native");
    const workspace = readlinkSync(`/proc/${process.pid}/cwd`), gateway = processIdentity(process.pid);
    const fixture: any = { name: "owned", workdir: join(directory, "logical-case"), intent: { kind: "ordinary" } };
    const row = { ...fixture, sessionId: "owner", backendRef: { conversationId: "thread" } };
    const run = Object.assign(Object.create(FeatureRun.prototype), { native: executable, workspace, gatewayIdentity: gateway, gatewayReady: true,
      sessions: () => [row], invoke: async () => ({ content: [{ text: "🟢 owned [owner] — running · 1s" }] }), publicOwner: async () => {} });
    const children: any[] = []; let primary: unknown, cleanupFailed = false;
    const start = async (cwd = workspace) => {
      const child = Object.assign(spawn(executable, ["-e", "console.log('ready');setInterval(()=>{},1000)"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] }), { ownedIdentity: undefined as ReturnType<typeof processIdentity> });
      children.push(child);
      await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
      child.ownedIdentity = processIdentity(child.pid);
      return child;
    };
    try {
      copyFileSync(readlinkSync(`/proc/${process.pid}/exe`), executable);
      chmodSync(executable, 0o700);
      const earlier = await start();
      fixture.nativeSnapshot = { gateway, processes: run.nativeProcesses() };
      assert.ok(fixture.nativeSnapshot.processes.some((p: NonNullable<ReturnType<typeof processIdentity>>) => p.pid === earlier.pid));
      const current = await start(), request = { threadId: "thread" };
      assert.equal(run.nativeProcesses(null).length, 2);
      const first = await run.nativeOwner(fixture, request);
      assert.equal(first.nativeProcess.pid, current.pid);
      const repeated = (await run.nativeOwner(fixture, request)).nativeProcess;
      for (const field of ["pid", "startTicks", "executable"]) assert.equal(repeated[field], first.nativeProcess[field]);
      fixture.nativeProcess = { ...first.nativeProcess, startTicks: `${first.nativeProcess.startTicks}-reused` };
      await assert.rejects(run.nativeOwner(fixture, request)); fixture.nativeProcess = first.nativeProcess;
      run.gatewayIdentity = { ...gateway, startTicks: `${gateway.startTicks}-foreign` };
      await assert.rejects(run.nativeOwner(fixture, request)); run.gatewayIdentity = gateway;
      await assert.rejects(run.nativeOwner(fixture, { threadId: "foreign" }));
      const another = await start();
      await assert.rejects(run.nativeOwner({ ...fixture, nativeProcess: undefined }, request)); // Two new instances.
      const foreignBaseline = { ...fixture, nativeProcess: undefined, nativeSnapshot: { gateway: earlier.ownedIdentity, processes: [] } };
      run.gatewayIdentity = earlier.ownedIdentity;
      await assert.rejects(run.nativeOwner(foreignBaseline, request)); run.gatewayIdentity = gateway;
      const wrongCwd = await start(directory);
      assert.throws(() => run.nativeProcesses());
      assert.equal((await stopOwnedChild(wrongCwd, { identity: wrongCwd.ownedIdentity, graceMs: 100, killMs: 100 })).complete, true);
      run.native = "/oca501-foreign-executable"; await assert.rejects(run.nativeOwner(fixture, request)); run.native = executable;
      assert.equal((await stopOwnedChild(current, { identity: current.ownedIdentity, graceMs: 100, killMs: 100 })).complete, true);
      await assert.rejects(run.nativeOwner(fixture, request)); // The live replacement must not be selected.
      assert.ok(processIdentity(another.pid));
    } catch (error) { primary = error; }
    finally {
      for (const child of children) try { if (!(await stopOwnedChild(child, { identity: child.ownedIdentity, graceMs: 100, killMs: 100 })).complete) cleanupFailed = true; } catch { cleanupFailed = true; }
      if (!cleanupFailed) try { assert.deepEqual(run.nativeProcesses(null), []); } catch (error) { primary ??= error; cleanupFailed = true; }
      if (!cleanupFailed) rmSync(directory, { recursive: true, force: true });
    }
    if (primary) throw primary;
    assert.equal(cleanupFailed, false);
  });
  it("bounds stubborn child and inherited-pipe cleanup and preserves the primary failure", async () => {
    const child = spawn(process.execPath, ["-e", `const {spawn}=require('node:child_process'); const writer=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>process.stdout.write('writer\\n'),20)"],{stdio:['ignore','inherit','inherit']}); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); console.log(writer.pid);`], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => {});
    const writerPid = await new Promise<number>(resolve => child.stdout.once("data", bytes => resolve(Number(bytes.toString().split("\n")[0]))));
    const writer = processIdentity(writerPid), primary = new Error("PRIMARY_FEATURE_FAILURE");
    let saved: Error | undefined;
    try { throw primary; } catch (error) { saved = error as Error; }
    const result = await stopOwnedChild(child, { graceMs: 100, killMs: 100 });
    assert.equal(saved, primary); assert.equal(result.complete, true); assert.equal(result.graceful, false);
    assert.equal(result.signal, "SIGKILL"); assert.equal(result.stdioComplete, true);
    const remaining = processIdentity(writerPid); assert.ok(!remaining || remaining.startTicks !== writer.startTicks || remaining.state === "Z");
    const r = receipt(); r.disposition = "BLOCKED"; r.failure = { stage: "native", code: "REQUIRED_FEATURE_PROOF_FAILED" };
    r.cleanup = { complete: false, failures: ["OWNED_CHILD_SHUTDOWN_FAILED"] }; r.proofs = [{ exitCode: result.exitCode, signal: result.signal, timedOut: true, stdioComplete: result.stdioComplete }];
    assert.equal(decodeReceipt(frameReceipt(r), expected).receipt.failure.code, "REQUIRED_FEATURE_PROOF_FAILED");
  });
  it("cleans an early Gateway start failure before its identity was recorded", async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise(resolve => child.stdout.once("data", resolve));
    const run = Object.assign(Object.create(FeatureRun.prototype), { gateway: child, gatewayIdentity: undefined, children: new Set([child]), shutdownOptions: { graceMs: 100, killMs: 100 } });
    const shutdown = run.shutdown();
    await assert.rejects(shutdown, /GRACEFUL_SHUTDOWN_FAILED|OWNED_PROCESS_OR_STDIO_SHUTDOWN_FAILED/);
    assert.equal(child.stdout.closed, true); assert.equal(child.stderr.closed, true);
  });

  it("captures failed spawn and timed-out command outcomes before cleanup", async () => {
    const run = Object.assign(Object.create(FeatureRun.prototype), { env: process.env, children: new Set(), raw: [], proofs: [] });
    await assert.rejects(run.command("/oca501-owned-absent-command", []), /COMMAND_SPAWN_FAILED/);
    assert.equal(run.children.size, 0); assert.equal(run.raw.length, 2);
    assert.equal(run.proofs[0].stdioComplete, true);
    await assert.rejects(run.command(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], { timeoutMs: 150, graceMs: 100, killMs: 100 }), /COMMAND_TIMEOUT/);
    assert.equal(run.children.size, 0); assert.equal(run.raw.length, 4);
    const last = run.proofs.at(-1); assert.equal(last.timedOut, true); assert.equal(last.signal, "SIGKILL"); assert.equal(last.stdioComplete, true);
  });

  it("retains a live command after both output pipes close until terminal cleanup", async () => {
    const run = Object.assign(Object.create(FeatureRun.prototype), { env: process.env, children: new Set(), raw: [], proofs: [] });
    const outcome = run.command(process.execPath, ["-e", "console.log(process.pid);setTimeout(()=>{require('node:fs').closeSync(1);require('node:fs').closeSync(2)},50);setInterval(()=>{},1000)"], { allowFailure: true, timeoutMs: 500, graceMs: 100, killMs: 100 }).then((): null => null, (error: Error): Error => error);
    const child: any = [...run.children][0], identity = processIdentity(child.pid);
    try {
      await Promise.all([child.stdout, child.stderr].map((stream: Readable) => stream.closed ? Promise.resolve() : new Promise<void>(resolve => stream.once("close", resolve))));
      assert.equal(child.stderr.closed, true); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
      assert.equal(run.children.has(child), true); assert.ok(processIdentity(child.pid));
      const error = await outcome; assert.match(error.message, /COMMAND_TIMEOUT/);
      assert.equal(run.children.size, 0); assert.equal(child.signalCode, "SIGTERM");
      assert.equal(run.proofs.at(-1).timedOut, true); assert.equal(run.proofs.at(-1).stdioComplete, true);
      assert.equal(run.raw.length, 2);
    } finally {
      await stopOwnedChild(child, { identity, graceMs: 100, killMs: 100 });
      for (const owned of run.children) if (owned !== child) await stopOwnedChild(owned, { graceMs: 100, killMs: 100 });
      await outcome;
    }
  });

});
