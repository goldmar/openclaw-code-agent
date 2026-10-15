import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OpenCodeHarness,
  permissionRulesForMode,
  privateServerEnvironment,
  resolveCommandPath,
  candidateSearchPaths,
} from "../src/harness/opencode";
import { OpenCodeFakeServer } from "./opencode-fake-server";
import type { HarnessMessage, HarnessSession } from "../src/harness/types";
import { TurnTracker } from "../src/harness/opencode/turn";
import { EventMapper } from "../src/harness/opencode/mapper";
import { EventCursor } from "../src/harness/opencode/event-cursor";
import { OpenCodeClient } from "../src/harness/opencode/client";
import { newMessageId } from "../src/harness/opencode/ids";
import { sseFrames } from "../src/harness/opencode/sse";
import { assessResumeCandidate } from "../src/session-resume";
import { setPluginConfig, pluginConfig } from "../src/config";
import { PendingInputCoordinator } from "../src/harness/opencode/interaction";
import { OpenCodeApiError } from "../src/harness/opencode/errors";
import { UsageAccumulator } from "../src/harness/opencode/usage";
async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function collect(session: HarnessSession) {
  const events: HarnessMessage[] = [];
  const done = (async () => {
    for await (const e of session.messages) events.push(e);
  })();
  return { events, done };
}
function harness(fake: OpenCodeFakeServer) {
  return new OpenCodeHarness({
    fetch: fake.fetch,
    createServer: async () => fake.handle(),
    serverIdleShutdownMs: 0,
    streamReconnectDelayMs: 5,
  });
}
function terminal(events: HarnessMessage[]) {
  return events.findLast(
    (e): e is Extract<HarnessMessage, { type: "run_completed" }> =>
      e.type === "run_completed",
  )?.data;
}
describe("OpenCode 2.0 harness", () => {
  it("runs through the v2 envelope, full text and authoritative terminal", async () => {
    const fake = new OpenCodeFakeServer();
    fake.autoComplete = true;
    const { events, done } = collect(
      harness(fake).launch({
        prompt: "hello",
        cwd: "/tmp",
        systemPrompt: "system",
      }),
    );
    await done;
    assert.equal(terminal(events)?.outcome, "completed");
    assert.equal(terminal(events)?.outcomeAuthoritative, true);
    assert.equal(terminal(events)?.result, "Done.");
    assert.ok(terminal(events)!.duration_ms < 10000);
    assert.equal(events[0].type, "backend_ref");
    assert.equal(events.filter((e) => e.type === "run_started").length, 1);
    assert.ok(fake.instructions.size);
    assert.deepEqual(fake.protocolViolations, []);
  });
  it("enforces plan subagent denial without a blanket bypass rule", () => {
    assert.ok(
      permissionRulesForMode("plan").some(
        (r) => r.action === "subagent" && r.effect === "deny",
      ),
    );
    assert.ok(
      permissionRulesForMode("plan").some(
        (r) => r.action === "shell" && r.effect === "deny",
      ),
    );
    assert.ok(
      permissionRulesForMode("bypassPermissions").every(
        (r) => r.action !== "*",
      ),
    );
  });
  it("keeps only explicitly restored scrubbed keys and replaces inherited passwords", () => {
    const env = privateServerEnvironment(
      {
        PATH: "/bin",
        GH_TOKEN: "hidden",
        MY_PROVIDER: "yes",
        OPENCODE_SERVER_PASSWORD: "old",
        OPENCODE_PASSWORD: "old",
      },
      "/tmp/private.db",
      "random",
      ["GH_TOKEN", "OPENCODE_SERVER_PASSWORD"],
    );
    assert.equal(env.GH_TOKEN, "hidden");
    assert.equal(env.OPENCODE_PASSWORD, "random");
    assert.equal(env.OPENCODE_SERVER_PASSWORD, undefined);
    assert.equal(env.OPENCODE_DB, "/tmp/private.db");
    assert.equal(
      privateServerEnvironment({ GH_TOKEN: "hidden" }, "db", "pw").GH_TOKEN,
      undefined,
    );
  });
  it("copies OpenCode configuration without sharing the allowlist array", () => {
    const passEnv = ["PROVIDER_TOKEN"];
    setPluginConfig({
      harnesses: {
        opencode: {
          command: "/bin/opencode2",
          passEnv,
          defaultAgent: "custom",
          serverMode: "private",
        },
      },
    });
    passEnv.push("LATER");
    assert.deepEqual(pluginConfig.harnesses.opencode.passEnv, [
      "PROVIDER_TOKEN",
    ]);
    assert.equal(pluginConfig.harnesses.opencode.defaultAgent, "custom");
    setPluginConfig({});
  });
  it("rejects old servers with an actionable version diagnostic", async () => {
    const fake = new OpenCodeFakeServer();
    fake.version = "1.19.0";
    const { events, done } = collect(
      harness(fake).launch({ prompt: "hello", cwd: "/tmp" }),
    );
    await done;
    assert.equal(terminal(events)?.errorCode, "opencode_version");
    assert.match(terminal(events)!.result!, /@opencode\/cli/);
    assert.ok(!fake.requests.some((r) => r.path === "/api/session"));
  });
  it("does not settle on idle or a foreign terminal before delivery", () => {
    const fake = new OpenCodeFakeServer();
    const info = fake.create();
    const turn = new TurnTracker();
    turn.begin("msg_ours");
    assert.equal(
      turn.apply(
        fake.event("session.execution.succeeded", { sessionID: info.id }),
      ),
      undefined,
    );
    turn.apply(
      fake.event("session.inbox.delivered", {
        sessionID: info.id,
        inboxID: "msg_ours",
      }),
    );
    assert.equal(
      turn.apply(
        fake.event("session.status", {
          sessionID: info.id,
          status: { type: "idle" },
        }),
      ),
      undefined,
    );
    assert.deepEqual(
      turn.apply(
        fake.event("session.execution.succeeded", { sessionID: info.id }),
      ),
      { outcome: "completed" },
    );
  });
  for (const reason of ["user", "shutdown", "inactivity", "superseded"]) {
    it(`classifies ${reason} interruption`, () => {
      const fake = new OpenCodeFakeServer();
      const turn = new TurnTracker();
      turn.begin("msg_ours");
      turn.apply(
        fake.event("session.inbox.delivered", {
          sessionID: "ses_1",
          inboxID: "msg_ours",
        }),
      );
      const result = turn.apply(
        fake.event("session.execution.interrupted", {
          sessionID: "ses_1",
          reason,
        }),
      );
      assert.equal(
        result?.outcome,
        ["shutdown", "inactivity"].includes(reason) ? "failed" : "interrupted",
      );
    });
  }
  it("continues across a late steer's next execution", () => {
    const fake = new OpenCodeFakeServer();
    const turn = new TurnTracker();
    turn.begin("msg_a");
    turn.apply(
      fake.event("session.inbox.delivered", {
        sessionID: "ses_1",
        inboxID: "msg_a",
      }),
    );
    turn.begin("msg_b");
    assert.equal(
      turn.apply(
        fake.event("session.execution.succeeded", { sessionID: "ses_1" }),
      ),
      undefined,
    );
    assert.equal(turn.continuing, true);
    turn.apply(
      fake.event("session.inbox.delivered", {
        sessionID: "ses_1",
        inboxID: "msg_b",
      }),
    );
    assert.deepEqual(
      turn.apply(
        fake.event("session.execution.succeeded", { sessionID: "ses_1" }),
      ),
      { outcome: "completed" },
    );
  });
  it("repairs missing suffixes and joins all parts of the last assistant message", () => {
    const fake = new OpenCodeFakeServer();
    const mapper = new EventMapper();
    const data = {
      sessionID: "ses_1",
      assistantMessageID: "msg_a",
      ordinal: 0,
    };
    mapper.map(fake.event("session.text.delta", { ...data, delta: "hel" }));
    assert.equal(
      mapper
        .map(fake.event("session.text.ended", { ...data, text: "hello" }))
        .at(-1)?.type,
      "text_delta",
    );
    mapper.map(
      fake.event("session.text.ended", { ...data, ordinal: 1, text: "world" }),
    );
    assert.equal(mapper.result(), "hello\n\nworld");
    mapper.map(
      fake.event("session.text.ended", {
        ...data,
        assistantMessageID: "msg_b",
        text: "final",
      }),
    );
    assert.equal(mapper.result(), "final");
  });
  it("emits one tool call per ID", () => {
    const fake = new OpenCodeFakeServer();
    const mapper = new EventMapper();
    const data = {
      sessionID: "ses_1",
      assistantMessageID: "msg_a",
      id: "tool_1",
    };
    mapper.map(
      fake.event("session.tool.input.started", { ...data, name: "shell" }),
    );
    const called = fake.event("session.tool.called", {
      ...data,
      input: { command: "ls" },
      executed: true,
    });
    assert.equal(
      mapper.map(called).filter((e) => e.type === "tool_call").length,
      1,
    );
    assert.equal(
      mapper.map(called).filter((e) => e.type === "tool_call").length,
      0,
    );
  });
  it("deduplicates durable replay and respects aggregate-specific cursors", async () => {
    const fake = new OpenCodeFakeServer();
    const info = fake.create();
    fake.event("session.execution.started", { sessionID: info.id });
    const cursor = new EventCursor();
    let count = 0;
    const client = new OpenCodeClient(
      "http://opencode.test",
      undefined,
      fake.fetch,
    );
    await cursor.catchUp(client, info.id, () => {
      count++;
    });
    await cursor.catchUp(client, info.id, () => {
      count++;
    });
    assert.equal(count, 1);
  });
  it("steers an active turn and refuses after settlement", async () => {
    const fake = new OpenCodeFakeServer();
    const session = harness(fake).launch({ prompt: "hello", cwd: "/tmp" });
    const collected = collect(session);
    await waitFor(() => fake.busy.size === 1);
    assert.equal(await session.steer!("next"), true);
    fake.end([...fake.busy][0]);
    await collected.done;
    assert.equal(await session.steer!("late"), false);
    assert.equal(terminal(collected.events)?.success, true);
  });
  it("keeps a permission pending when the transport cannot send a reply", async () => {
    const fake = new OpenCodeFakeServer();
    const session = harness(fake).launch({ prompt: "hello", cwd: "/tmp" });
    const c = collect(session);
    await waitFor(() => fake.busy.size === 1);
    void fake.askPermission([...fake.busy][0], "ls");
    await waitFor(() => c.events.some((e) => e.type === "pending_input"));
    fake.override = (r) =>
      r.path.endsWith("/reply")
        ? new Response(JSON.stringify({ _tag: "Offline" }), { status: 503 })
        : undefined;
    await assert.rejects(session.submitPendingInputOption!(0));
    assert.equal(
      c.events.filter((e) => e.type === "pending_input_resolved").length,
      0,
    );
    fake.override = undefined;
    assert.equal(await session.submitPendingInputOption!(0), true);
    fake.end([...fake.busy][0]);
    await c.done;
  });
  it("retains a form after FormInvalidAnswerError", async () => {
    const events: HarnessMessage[] = [];
    let reject = true;
    const inputs = new PendingInputCoordinator(
      (e) => events.push(e),
      async () => {
        if (reject)
          throw new OpenCodeApiError(400, "FormInvalidAnswerError", "invalid");
      },
    );
    inputs.add({
      kind: "form",
      value: {
        id: "frm_1",
        sessionID: "ses_1",
        title: "Q",
        fields: [{ key: "q0", type: "string" }],
      },
    });
    await assert.rejects(inputs.text("hello"));
    assert.equal(inputs.pending, true);
    reject = false;
    assert.equal(await inputs.text("fixed"), true);
    assert.equal(inputs.pending, false);
  });
  it("reconciles pending asks after a stream gap", async () => {
    const fake = new OpenCodeFakeServer();
    const session = harness(fake).launch({ prompt: "hello", cwd: "/tmp" });
    const c = collect(session);
    await waitFor(() => fake.busy.size === 1);
    fake.dropStreams();
    const id = [...fake.busy][0];
    void fake.askPermission(id, "ls");
    await waitFor(() => c.events.some((e) => e.type === "pending_input"));
    await session.submitPendingInputOption!(0);
    fake.end(id);
    await c.done;
    assert.deepEqual(fake.protocolViolations, []);
  });
  it("runs compact through the same tracked prompt path", async () => {
    const fake = new OpenCodeFakeServer();
    fake.autoComplete = true;
    const h = harness(fake);
    const prompt = (async function* () {
      yield h.buildThreadActionMessage({ kind: "compact" });
    })();
    const c = collect(h.launch({ prompt, cwd: "/tmp" }));
    await c.done;
    assert.equal(terminal(c.events)?.success, true);
    assert.ok(fake.requests.some((r) => r.path.endsWith("/compact")));
  });
  it("does not automatically resume historical v1 sessions", () => {
    const candidate = {
      sessionId: "old",
      status: "completed",
      backendRef: { kind: "opencode-server", conversationId: "ses_old" },
    } as any;
    assert.equal(assessResumeCandidate(candidate).kind, "unavailable");
    assert.equal(
      (assessResumeCandidate(candidate) as any).reason,
      "backend_protocol_retired",
    );
  });
  it("generates ordered native IDs", () => {
    const ids = Array.from({ length: 20 }, () => newMessageId(1000));
    assert.ok(ids.every((id) => /^msg_[a-f0-9]{12}[a-zA-Z0-9]{14}$/.test(id)));
    assert.deepEqual([...ids].sort(), ids);
  });
  it("parses split CRLF and multiline SSE data", async () => {
    const chunks = ['event: hi\r\ndata: {"a":\r\n', "data: 1}\r\n\r\n"];
    const response = new Response(
      new ReadableStream({
        start(c) {
          for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
          c.close();
        },
      }),
    );
    const frames = [];
    for await (const f of sseFrames(response)) frames.push(f);
    assert.deepEqual(frames, [{ event: "hi", data: { a: 1 } }]);
  });
  it("resolves commands against the original cwd", () => {
    assert.equal(
      resolveCommandPath("./opencode2", undefined, "/tmp/base"),
      "/tmp/base/./opencode2",
    );
    assert.ok(candidateSearchPaths("/bin").includes("/bin"));
  });
  it("accumulates each durable usage step once", () => {
    const fake = new OpenCodeFakeServer();
    const u = new UsageAccumulator();
    u.apply(
      fake.event("session.step.started", {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        agent: "build",
        model: { providerID: "p", id: "m" },
        started: 1,
      }),
    );
    const step = fake.event("session.step.ended", {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      finish: "stop",
      cost: 1,
      tokens: {
        input: 10,
        output: 2,
        reasoning: 1,
        cache: { read: 3, write: 4 },
      },
    });
    u.apply(step);
    u.apply(step);
    assert.equal(u.snapshot().models[0].costUsd, 1);
    assert.equal(u.snapshot().contextTokens, 17);
  });
  it("interrupts successfully while the terminal closes the stream", async () => {
    const fake = new OpenCodeFakeServer();
    const session = harness(fake).launch({ prompt: "hello", cwd: "/tmp" });
    const c = collect(session);
    await waitFor(() => fake.busy.size === 1);
    await session.interrupt!();
    await c.done;
    assert.equal(terminal(c.events)?.outcome, "interrupted");
  });
  it("rewinds a resumed session in place while preserving files", async () => {
    const fake = new OpenCodeFakeServer();
    fake.autoComplete = true;
    const h = harness(fake);
    const first = collect(h.launch({ prompt: "one", cwd: "/tmp" }));
    await first.done;
    const id = terminal(first.events)!.session_id;
    const second = collect(
      h.launch({
        prompt: "two",
        cwd: "/tmp",
        resumeSessionId: id,
        rewindTurns: 1,
      }),
    );
    await second.done;
    assert.equal(terminal(second.events)?.success, true);
    const stage = fake.requests.find((r) => r.path.endsWith("/revert/stage"));
    assert.equal(stage?.body?.files, false);
    assert.ok(fake.requests.some((r) => r.path.endsWith("/revert/commit")));
    assert.ok(!fake.requests.some((r) => r.path.endsWith("/fork")));
  });
  it("refuses resume with a different working directory", async () => {
    const fake = new OpenCodeFakeServer();
    const existing = fake.create("/one");
    const c = collect(
      harness(fake).launch({
        prompt: "hello",
        cwd: "/two",
        resumeSessionId: existing.id,
      }),
    );
    await c.done;
    assert.match(terminal(c.events)!.result!, /location differs/);
  });
  it("does not retry a prompt with unconfirmed admission", async () => {
    const fake = new OpenCodeFakeServer();
    fake.override = (r) => {
      if (r.path.endsWith("/prompt")) throw new TypeError("lost submit reply");
      if (
        r.path.endsWith("/inbox") &&
        fake.requests.some((q) => q.path.endsWith("/prompt"))
      )
        throw new TypeError("read unavailable");
      return undefined;
    };
    const c = collect(harness(fake).launch({ prompt: "hello", cwd: "/tmp" }));
    await c.done;
    assert.equal(
      fake.requests.filter((r) => r.path.endsWith("/prompt")).length,
      1,
    );
    assert.equal(terminal(c.events)?.success, false);
    assert.match(terminal(c.events)!.result!, /confirm|deliver/i);
  });
  it("does not start a server for an already aborted launch", async () => {
    const fake = new OpenCodeFakeServer();
    const abortController = new AbortController();
    abortController.abort();
    const c = collect(
      harness(fake).launch({ prompt: "hello", cwd: "/tmp", abortController }),
    );
    await c.done;
    assert.equal(fake.requests.length, 0);
  });
  it("does not cache a server that dies during version negotiation",async()=>{
    const fake=new OpenCodeFakeServer();fake.autoComplete=true;let starts=0;
    const h=new OpenCodeHarness({fetch:fake.fetch,serverIdleShutdownMs:0,createServer:async()=>{
      starts++;const server=fake.handle();
      return starts===1?{...server,onExit:(listener:(reason:string)=>void)=>listener("startup exit")}:server;
    }});
    const first=collect(h.launch({prompt:"one",cwd:"/tmp"}));await first.done;
    assert.match(terminal(first.events)!.result!,/version negotiation/);
    assert.equal(first.events.filter(e=>e.type==="run_started").length,1);
    const second=collect(h.launch({prompt:"two",cwd:"/tmp"}));await second.done;
    assert.equal(terminal(second.events)?.success,true);assert.equal(starts,2);
  });

});
