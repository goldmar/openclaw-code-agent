import "./test-env";
import { it } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeHarness } from "../src/harness/opencode";
import { PendingInputCoordinator, type InputReply } from "../src/harness/opencode/interaction";
import { OpenCodeApiError } from "../src/harness/opencode/errors";
import { EventMapper } from "../src/harness/opencode/mapper";
import type { HarnessMessage, HarnessSession } from "../src/harness/types";
import { OpenCodeFakeServer } from "./opencode-fake-server";
import type { S_Model_Info } from "../src/harness/opencode/protocol/api";
import { checkServerVersion } from "../src/harness/opencode/endpoint";
import { OpenCodeClient } from "../src/harness/opencode/client";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("review regression timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function collect(session: HarnessSession) {
  const events: HarnessMessage[] = [];
  const done = (async () => { for await (const e of session.messages) events.push(e); })();
  return { events, done };
}
function harness(fake: OpenCodeFakeServer) {
  return new OpenCodeHarness({ fetch: fake.fetch, createServer: async () => fake.handle(), serverIdleShutdownMs: 0, streamReconnectDelayMs: 5 });
}
function result(events: HarnessMessage[]) {
  return events.findLast((e): e is Extract<HarnessMessage, { type: "run_completed" }> => e.type === "run_completed")?.data;
}
function text(events: HarnessMessage[]) {
  return events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
}
const model: S_Model_Info = {
  id: "test", modelID: "test", providerID: "p", name: "Test",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "high" }], time: { released: 0 }, cost: [],
  status: "active", enabled: true, limit: { context: 10000, output: 1000 },
};

for (const version of ["2.0.24", "2.0.25", "2.0.29", "3.0.0"]) {
  it(`checks the supported version boundary for ${version}`, async () => {
    const fake = new OpenCodeFakeServer();
    fake.version = version;
    const check = checkServerVersion(new OpenCodeClient("http://opencode.test", undefined, fake.fetch));
    if (version === "2.0.24" || version === "3.0.0")
      await assert.rejects(check, /requires >= 2\.0\.25/);
    else assert.equal((await check).version, version);
  });
}

for (const stop of ["close", "abort"] as const) {
  it(`releases a late endpoint lease after startup ${stop}`, async () => {
    const fake = new OpenCodeFakeServer();
    let accept!: () => void;
    let starting = false;
    let stopped = 0;
    const ready = new Promise<void>((r) => { accept = r; });
    const h = new OpenCodeHarness({
      fetch: fake.fetch, serverIdleShutdownMs: 0,
      createServer: async () => {
        starting = true;
        await ready;
        return { ...fake.handle(), close: async () => { stopped++; } };
      },
    });
    const abortController = new AbortController();
    const session = h.launch({ prompt: "hello", cwd: "/tmp", abortController });
    const c = collect(session);
    await waitFor(() => starting);
    if (stop === "close") await session.close!();
    else abortController.abort();
    await c.done;
    accept();
    await waitFor(() => stopped === 1);
    assert.equal(fake.requests.filter((r) => r.path === "/api/session").length, 0);
    assert.equal(fake.streams.size, 0);
  });
}

it("lets a rejected multi-field form correct its first answer and conditional fields", async () => {
  const events: HarnessMessage[] = [];
  const sent: InputReply[] = [];
  const inputs = new PendingInputCoordinator((e) => events.push(e), async (_, reply) => {
    sent.push(reply);
    if (sent.length === 1) throw new OpenCodeApiError(400, "FormInvalidAnswerError", "first field invalid");
  });
  inputs.add({ kind: "form", value: { id: "frm_1", sessionID: "ses_1", title: "Form", fields: [
    { key: "count", type: "number", maximum: 10 },
    { key: "detail", type: "string", when: [{ key: "count", op: "eq", value: 99 }] },
    { key: "last", type: "string" },
  ] } });
  await inputs.text("99");
  await inputs.text("stale detail");
  await assert.rejects(inputs.text("last"));
  const pending = events.findLast((e) => e.type === "pending_input");
  assert.equal(pending?.state.activeQuestionIndex, 0);
  assert.deepEqual(pending?.state.answers, {});
  await inputs.text("2");
  await inputs.text("corrected last");
  assert.deepEqual(sent[1], { kind: "form", answer: { count: 2, last: "corrected last" } });
  assert.equal(inputs.pending, false);
});

it("shows external-only forms and retains a visible cancellation after transport failure", async () => {
  const events: HarnessMessage[] = [];
  let offline = true;
  let sent: InputReply | undefined;
  const inputs = new PendingInputCoordinator((e) => events.push(e), async (_, reply) => {
    if (offline) throw new Error("offline");
    sent = reply;
  });
  inputs.add({ kind: "form", value: { id: "frm_1", sessionID: "ses_1", title: "External", fields: [
    { key: "auth", type: "external", url: "https://example.com/step", title: "Continue in browser" },
  ] } });
  const pending = events.findLast((e) => e.type === "pending_input");
  assert.match(pending!.state.promptText, /https:\/\/example.com\/step/);
  assert.match(pending!.state.promptText, /cancel/);
  await assert.rejects(inputs.text("cancel"));
  assert.equal(inputs.pending, true);
  offline = false;
  assert.equal(await inputs.text("cancel"), true);
  assert.deepEqual(sent, { kind: "cancel", message: "cancel" });
  assert.equal(inputs.pending, false);
});

for (const restore of [false, true]) {
  it(`repairs missing middle text through ${restore ? "persisted messages" : "text.ended"} before emitting post-gap deltas`, () => {
    const fake = new OpenCodeFakeServer();
    const mapper = new EventMapper();
    const d = { sessionID: "ses_1", assistantMessageID: "msg_a", ordinal: 0 };
    const events = mapper.map(fake.event("session.text.delta", { ...d, delta: "hel" }));
    mapper.beginRecovery();
    events.push(...mapper.map(fake.event("session.text.delta", { ...d, delta: "world" })));
    assert.equal(text(events), "hel");
    events.push(...(restore ? mapper.restore("msg_a", ["hello world"]) : mapper.map(fake.event("session.text.ended", { ...d, text: "hello world" }))));
    assert.equal(text(events), "hello world");
    assert.equal(mapper.result(), "hello world");
  });
}

it("repairs a real stream gap without log retention before publishing trailing text", async () => {
  const fake = new OpenCodeFakeServer();
  fake.override = (r) => r.path.endsWith("/log") ? new Response("{}", { status: 404 }) : undefined;
  const c = collect(harness(fake).launch({ prompt: "hello", cwd: "/tmp" }));
  await waitFor(() => fake.busy.size === 1);
  const sessionID = [...fake.busy][0];
  const d = { sessionID, assistantMessageID: "msg_a", ordinal: 0 };
  fake.event("session.text.delta", { ...d, delta: "hel" });
  await waitFor(() => text(c.events) === "hel");
  fake.dropStreams();
  fake.event("session.text.delta", { ...d, delta: "lo " }, false);
  await waitFor(() => fake.streams.size === 1);
  fake.event("session.text.delta", { ...d, delta: "world" });
  fake.event("session.text.ended", { ...d, text: "hello world" });
  fake.event("session.execution.succeeded", { sessionID });
  await c.done;
  assert.equal(text(c.events), "hello world");
  assert.equal(result(c.events)?.result, "hello world");
  assert.deepEqual(fake.protocolViolations, []);
});

it("restores a lost text.ended from messages while the execution is still active", async () => {
  const fake = new OpenCodeFakeServer();
  fake.override = (r) => r.path.endsWith("/log") ? new Response("{}", { status: 404 }) : undefined;
  const session = harness(fake).launch({ prompt: "hello", cwd: "/tmp" });
  const c = collect(session);
  try {
    await waitFor(() => fake.busy.size === 1);
    const sessionID = [...fake.busy][0];
    const d = { sessionID, assistantMessageID: "msg_a", ordinal: 0 };
    fake.event("session.text.delta", { ...d, delta: "hel" });
    await waitFor(() => text(c.events) === "hel");
    fake.dropStreams();
    fake.records.get(sessionID)!.push({
      id: "msg_a", type: "assistant", agent: "build",
      time: { created: Date.now() }, model: { providerID: "p", id: "test" },
      content: [{ type: "text", text: "hello " }],
    });
    await waitFor(() => fake.streams.size === 1 && text(c.events) === "hello ");
    fake.event("session.text.delta", { ...d, ordinal: 1, delta: "world" });
    fake.event("session.text.ended", { ...d, ordinal: 1, text: "world" });
    fake.event("session.execution.succeeded", { sessionID });
    await c.done;
    assert.equal(text(c.events), "hello \n\nworld");
    assert.equal(result(c.events)?.result, "hello \n\nworld");
    assert.deepEqual(fake.protocolViolations, []);
  } finally {
    await session.close!();
  }
});

for (const resume of [false, true]) {
  for (const supported of [false, true]) {
    it(`applies only supported effort to the ${resume ? "resumed" : "new"} default model (${supported})`, async () => {
      const fake = new OpenCodeFakeServer();
      fake.autoComplete = true;
      fake.defaultModel = { providerID: "p", id: "test" };
      fake.modelList = [{ ...model, variants: supported ? model.variants : [] }];
      const existing = resume ? fake.create() : undefined;
      const c = collect(harness(fake).launch({ prompt: "hello", cwd: "/tmp", reasoningEffort: "high", ...(existing ? { resumeSessionId: existing.id } : {}) }));
      await c.done;
      assert.equal(result(c.events)?.success, true);
      const writes = fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/model"));
      assert.equal(writes.length, supported ? 1 : 0);
      if (supported) {
        assert.equal(writes[0].body?.model.variant, "high");
        assert.ok(fake.requests.indexOf(writes[0]) < fake.requests.findIndex((r) => r.path.endsWith("/prompt")));
      }
    });
  }
}

it("applies requested effort when the server first reveals its default in a step event", async () => {
  const fake = new OpenCodeFakeServer();
  fake.modelList = [model];
  const c = collect(harness(fake).launch({ prompt: "hello", cwd: "/tmp", reasoningEffort: "high" }));
  await waitFor(() => fake.busy.size === 1);
  const sessionID = [...fake.busy][0];
  fake.event("session.step.started", { sessionID, assistantMessageID: "msg_default", agent: "build", model: { providerID: "p", id: "test" }, started: Date.now() });
  await waitFor(() => fake.requests.some((r) => r.method === "POST" && r.path.endsWith("/model")));
  assert.equal(fake.sessions.get(sessionID).model.variant, "high");
  fake.end(sessionID);
  await c.done;
  assert.equal(result(c.events)?.success, true);
});

for (const retained of [false, true]) {
  it(`restores paginated per-model usage on resume with log retention ${retained}`, async () => {
    const fake = new OpenCodeFakeServer();
    if (!retained) fake.override = (r) => r.path.endsWith("/log") ? new Response("{}", { status: 404 }) : undefined;
    const info = fake.create();
    const tokens = { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } };
    for (let i = 0; i < 101; i++) {
      fake.records.get(info.id)!.push({ type: "assistant", id: `msg_old_${i}`, time: { created: i + 1, completed: i + 2 }, agent: "build", model: { providerID: "p", id: "old" }, content: [], cost: 1, tokens });
    }
    fake.records.get(info.id)!.push({ type: "compaction", id: "msg_compact", time: { created: 200 }, status: "completed", reason: "manual", model: { providerID: "p", id: "summary" }, summary: "summary", recent: "recent", cost: 2, tokens });
    info.cost = 103;
    // Retained replay must not count a projected historical step a second time.
    fake.event("session.step.started", { sessionID: info.id, assistantMessageID: "msg_old_0", agent: "build", model: { providerID: "p", id: "old" }, started: 1 }, false);
    fake.event("session.step.ended", { sessionID: info.id, assistantMessageID: "msg_old_0", finish: "stop", cost: 1, tokens }, false);
    const c = collect(harness(fake).launch({ prompt: "next", cwd: "/tmp", resumeSessionId: info.id }));
    await waitFor(() => fake.busy.size === 1);
    fake.event("session.step.started", { sessionID: info.id, assistantMessageID: "msg_new", agent: "build", model: { providerID: "p", id: "new" }, started: Date.now() });
    const stepData = { sessionID: info.id, assistantMessageID: "msg_new", finish: "stop", cost: 3, tokens };
    fake.event("session.step.ended", stepData);
    // The same projected message can be encountered again during recovery.
    fake.event("session.step.ended", stepData);
    info.cost = 106;
    fake.event("session.usage.updated", { sessionID: info.id, cost: 106, tokens: { ...tokens, input: 1030 } });
    fake.event("session.execution.succeeded", { sessionID: info.id });
    await c.done;
    assert.equal(result(c.events)?.success, true);
    assert.equal(result(c.events)?.usage?.costUsd, 106);
    assert.deepEqual(result(c.events)?.usage?.models?.map((m) => [m.model, m.costUsd, m.inputTokens]), [ ["p/old", 101, 1010], ["p/summary", 2, 10], ["p/new", 3, 10] ]);
    assert.deepEqual(fake.protocolViolations, []);
  });
}
