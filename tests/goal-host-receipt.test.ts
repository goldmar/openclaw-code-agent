import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assignments, decodeReceipt, excluded, frameReceipt, FILE_LIMIT, HOST_PIN } from "../scripts/e2e/oca501-evidence.mjs";
import { optionsFor, visibleProof } from "../scripts/e2e/oca-goal-host-acceptance.mjs";
const expected = { candidateSha: "a".repeat(40), nodeVersion: "24.16.0", scenario: "smoke" };
const receipt = (): any => ({ ...expected, format: "oca501-slim-v1", complete: true, hostVersion: "2026.9.7", hostCommit: HOST_PIN, nativeVersion: "0.159.3", assigned: [], completed: [], disposition: "PASS", failure: null, cleanup: { complete: true, failures: [] }, excluded: [], proofs: [] });
describe("bounded representative host receipts", () => {
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
    assert.equal(optionsFor(args)["--scenario"], "all");
    for (const scenario of Object.keys(assignments)) assert.equal(optionsFor([...args, "--scenario", scenario])["--scenario"], scenario);
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

});
