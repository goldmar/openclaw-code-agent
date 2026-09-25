import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { completeRuntimeLlmText } from "../src/runtime-llm";
import { setPluginRuntime } from "../src/runtime-store";
import { RuntimeSystemEventTransport } from "../src/wake-transport";
import { resolveSessionTaskLifecycle } from "../src/session-task-lifecycle";
import { Session } from "../src/session";
import {
  createFakeHost,
  type DurableSendParams,
  type FakeHost,
  type FakeHostOptions,
  type HeartbeatRequest,
  type LlmCompleteParams,
  type SystemEventOptions,
} from "./fake-host";

/**
 * OCA's calls into the host, checked against the installed OpenClaw SDK:
 * each expected payload below is declared with `satisfies <SDK type>`, so
 * `pnpm typecheck` fails when the host changes the shape, and the assertions
 * fail when OCA stops sending exactly that shape.
 */

let host: FakeHost | undefined;

afterEach(async () => {
  setPluginRuntime(undefined);
  await host?.dispose();
  host = undefined;
});

describe("host SDK call shapes", () => {
  it("runtime.llm.complete receives a plain completion request", async () => {
    host = createFakeHost({ llmReplies: ["```json\n{\"ok\":true}\n```"] });

    const text = await completeRuntimeLlmText(host.fakeRuntime.llm.complete, {
      purpose: "openclaw-code-agent.test",
      systemPrompt: "Return JSON.",
      prompt: "Summarize.",
      maxTokens: 64,
    });

    assert.equal(text, "{\"ok\":true}");
    const expected = {
      messages: [{ role: "user", content: "Summarize." }],
      systemPrompt: "Return JSON.",
      purpose: "openclaw-code-agent.test",
      maxTokens: 64,
      reasoning: "low",
    } satisfies LlmCompleteParams;
    assert.deepEqual(host.llmCalls, [expected]);
  });

  it("system events carry the origin session key and request an immediate wake only when asked", async () => {
    host = createFakeHost();
    setPluginRuntime(host.runtime);
    const transport = new RuntimeSystemEventTransport();

    await transport.enqueue("Session finished", { sessionKey: "agent:main:telegram:group:1", contextKey: "oca:s-1", wakeNow: false });
    await transport.enqueue("Needs a decision", { sessionKey: "agent:main:telegram:group:1", wakeNow: true });

    const firstOptions = { sessionKey: "agent:main:telegram:group:1", contextKey: "oca:s-1" } satisfies SystemEventOptions;
    const secondOptions = { sessionKey: "agent:main:telegram:group:1" } satisfies SystemEventOptions;
    assert.deepEqual(host.systemEvents, [
      { text: "Session finished", options: firstOptions },
      { text: "Needs a decision", options: secondOptions },
    ]);
    const heartbeat = {
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:telegram:group:1",
    } satisfies HeartbeatRequest;
    assert.deepEqual(host.heartbeats, [heartbeat]);
  });

  it("direct notifications go through sendDurableMessageBatch with buttons as a presentation", async () => {
    const cfg = { channels: { telegram: { enabled: true } } };
    host = createFakeHost({ config: cfg as FakeHostOptions["config"] });
    setPluginRuntime(host.runtime);

    await host.directNotificationTransport().send(
      { channel: "telegram", accountId: "default", target: "-1001", threadId: "7", sessionKey: "agent:main:telegram:group:-1001:topic:7" },
      "Plan ready",
      [[{ label: "Approve", callbackData: "token-1", style: "primary" }]],
    );

    const expected = {
      cfg: cfg as DurableSendParams["cfg"],
      channel: "telegram",
      to: "-1001",
      accountId: "default",
      threadId: "7",
      payloads: [{
        text: "Plan ready",
        presentation: { blocks: [{ type: "buttons", buttons: [{ label: "Approve", value: "code-agent:token-1", style: "primary" }] }] },
      }],
      durability: "required",
    } satisfies DurableSendParams;
    assert.deepEqual(host.durableSends, [expected]);
  });

  it("mirrors a session into a managed Task Flow through tasks.async.managedFlows", async () => {
    host = createFakeHost();
    setPluginRuntime(host.runtime);
    const sink = resolveSessionTaskLifecycle({ sessionKey: "agent:main:telegram:group:1" });
    const session = new Session({ prompt: "Mirror me", workdir: "/tmp", permissionMode: "default" }, "mirror");

    await sink.create(session);
    session.transition("running");
    await sink.progress(session);
    session.complete("done");
    await sink.finalize(session);

    const [flow] = host.flows.values();
    assert.equal(flow?.ownerKey, "agent:main:telegram:group:1");
    assert.equal(flow?.controllerId, "openclaw-code-agent");
    assert.equal(flow?.status, "succeeded");
    // Only the mirror fields are kept from the host's full record (goal, state JSON, ...).
    assert.deepEqual(session.taskFlowMirror, { flowId: flow?.flowId, revision: flow?.revision, status: "succeeded" });
    assert.equal(host.flowCalls[0]?.method, "tryCreateManaged");
    assert.equal(host.flowCalls.at(-1)?.method, "finish");
  });
});
