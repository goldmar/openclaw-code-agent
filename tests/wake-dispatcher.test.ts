import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WakeDispatcher } from "../src/wake-dispatcher";

type FakeSession = {
  id: string;
  originChannel?: string;
  originThreadId?: string | number;
  originSessionKey?: string;
  originAgentId?: string;
};

const WAIT_STEP_MS = 25;
const WAIT_TIMEOUT_MS = 2_000;

function readCalls(logPath: string): string[][] {
  const raw = readFileSync(logPath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as string[]);
}

async function waitForCalls(logPath: string, count: number): Promise<string[][]> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const calls = readCalls(logPath);
    if (calls.length >= count) return calls;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  throw new Error(`Timed out waiting for ${count} openclaw call(s) in ${logPath}`);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function parseChatSendParams(call: string[]): Record<string, string> {
  assert.deepEqual(call.slice(0, 6), [
    "gateway",
    "call",
    "chat.send",
    "--expect-final",
    "--timeout",
    "30000",
  ]);
  assert.equal(call[6], "--params");
  return JSON.parse(call[7] ?? "{}") as Record<string, string>;
}

function parseMessageSendArgs(call: string[]) {
  assert.deepEqual(call.slice(0, 2), ["message", "send"]);
  const parsed: Record<string, string> = {};
  for (let i = 2; i < call.length; i += 2) {
    const key = call[i];
    const value = call[i + 1];
    if (!key?.startsWith("--")) {
      throw new Error(`Unexpected message.send arg shape: ${JSON.stringify(call)}`);
    }
    parsed[key.slice(2)] = value ?? "";
  }
  return parsed;
}

describe("WakeDispatcher", () => {
  const originalPath = process.env.PATH ?? "";
  const originalLogPath = process.env.OPENCLAW_TEST_LOG;
  const originalConsoleInfo = console.info;
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "wake-dispatcher-test-"));
    logPath = join(tempDir, "openclaw-calls.log");
    writeFileSync(logPath, "");

    const fakeOpenClawPath = join(tempDir, "openclaw");
    writeFileSync(fakeOpenClawPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

appendFileSync(process.env.OPENCLAW_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`);
    chmodSync(fakeOpenClawPath, 0o755);

    process.env.OPENCLAW_TEST_LOG = logPath;
    process.env.PATH = `${tempDir}:${originalPath}`;
  });

  afterEach(() => {
    console.info = originalConsoleInfo;
    process.env.PATH = originalPath;
    if (originalLogPath == null) {
      delete process.env.OPENCLAW_TEST_LOG;
    } else {
      process.env.OPENCLAW_TEST_LOG = originalLogPath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses message.send for direct user notifications and logs completion", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-1",
      originChannel: "telegram|bot|12345",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1003863755361:topic:11239",
    };
    const infoLogs: string[] = [];
    console.info = (message?: unknown, ...rest: unknown[]) => {
      infoLogs.push([message, ...rest].map((value) => String(value)).join(" "));
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(logPath, 1);

    assert.equal(calls.length, 1);
    const params = parseMessageSendArgs(calls[0] ?? []);
    assert.equal(params.channel, "telegram");
    assert.equal(params.account, "bot");
    assert.equal(params.target, "12345");
    assert.equal(params.message, "🚀 launched");
    assert.equal(params["thread-id"], "11239");
    await waitFor(
      () => infoLogs.some((line) => line.includes("message.send notify completed")),
      "dispatcher completion log",
    );
    assert.ok(infoLogs.some((line) => line.includes("message.send notify completed")));
  });

  it("sends the direct notification and wake through separate transports when wake metadata is present", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-2",
      originChannel: "telegram|bot|12345",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1003863755361:topic:11239",
      originAgentId: "main",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      wakeMessage: "Coding agent session completed.",
      notifyUser: "always",
    });
    const calls = await waitForCalls(logPath, 2);

    assert.equal(calls.length, 2);
    const notifyCall = calls.find((call) => call[0] === "message");
    const wakeCall = calls.find((call) => call[0] === "gateway");
    assert.ok(notifyCall, "expected a message.send notification call");
    assert.ok(wakeCall, "expected a chat.send wake call");
    const notifyArgs = parseMessageSendArgs(notifyCall);
    assert.equal(notifyArgs.message, "✅ completed");
    const wakeParams = parseChatSendParams(wakeCall);
    assert.equal(wakeParams.message, "Coding agent session completed.");
    assert.equal(wakeParams.deliver, true);
  });

  it("falls back to a direct user notification plus system event when the wake target is unavailable", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-3",
      originChannel: "telegram|bot|12345",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "waiting",
      userMessage: "🔔 waiting",
      wakeMessage: "Session is waiting for input.",
      notifyUser: "on-wake-fallback",
    });
    const calls = await waitForCalls(logPath, 2);

    assert.equal(calls.length, 2);
    const notifyCall = calls.find((call) => call[0] === "message");
    const systemCall = calls.find((call) => call[0] === "system");
    assert.ok(notifyCall, "expected a message.send notification call");
    assert.ok(systemCall, "expected a system.event fallback call");
    assert.equal(parseMessageSendArgs(notifyCall).message, "🔔 waiting");
    assert.deepEqual(systemCall, [
      "system",
      "event",
      "--text",
      "Session is waiting for input.",
      "--mode",
      "now",
    ]);
  });

  it("uses the wake/system fallback only once when originSessionKey is missing", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = { id: "session-4", originChannel: "telegram|bot|12345" };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      wakeMessage: "Coding agent session completed.",
      notifyUser: "always",
    });
    const calls = await waitForCalls(logPath, 2);

    assert.equal(calls.length, 2);
    const notifyCall = calls.find((call) => call[0] === "message");
    const systemCall = calls.find((call) => call[0] === "system");
    assert.ok(notifyCall, "expected a message.send notification call");
    assert.ok(systemCall, "expected a system.event fallback call");
    assert.equal(parseMessageSendArgs(notifyCall).message, "✅ completed");
    assert.deepEqual(systemCall, [
      "system",
      "event",
      "--text",
      "Coding agent session completed.",
      "--mode",
      "now",
    ]);
  });

  it("uses system event for notify-only sessions when originSessionKey is missing", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = { id: "session-5" };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(logPath, 1);

    assert.deepEqual(calls, [[
      "system",
      "event",
      "--text",
      "🚀 launched",
      "--mode",
      "now",
    ]]);
  });

  it("routes feishu direct messages via message.send using sessionKey", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-6",
      originSessionKey: "agent:main:feishu:direct:ou_f4ec9a52fe6a68b5ca3c7bc22d671be5",
      originAgentId: "main",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(logPath, 1);

    assert.equal(calls.length, 1);
    const params = parseMessageSendArgs(calls[0] ?? []);
    assert.equal(params.channel, "feishu");
    assert.equal(params.target, "ou_f4ec9a52fe6a68b5ca3c7bc22d671be5");
    assert.equal(params.message, "🚀 launched");
  });

  it("routes feishu group chats via message.send using sessionKey with group kind", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-7",
      originSessionKey: "agent:main:feishu:group:oc_abc123def456",
      originAgentId: "main",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      wakeMessage: "Coding agent session completed.",
      notifyUser: "always",
    });
    const calls = await waitForCalls(logPath, 2);

    assert.equal(calls.length, 2);
    const notifyCall = calls.find((call) => call[0] === "message");
    const wakeCall = calls.find((call) => call[0] === "gateway");
    assert.ok(notifyCall, "expected a message.send notification call");
    assert.ok(wakeCall, "expected a chat.send wake call");
    const notifyArgs = parseMessageSendArgs(notifyCall);
    assert.equal(notifyArgs.channel, "feishu");
    assert.equal(notifyArgs.target, "oc_abc123def456");
    assert.equal(notifyArgs.message, "✅ completed");
  });

  it("routes feishu topic threads with threadId from sessionKey", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-8",
      originSessionKey: "agent:main:feishu:group:oc_topic_chat:topic:om_topic_xyz789",
      originAgentId: "main",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "waiting",
      userMessage: "🔔 waiting",
      wakeMessage: "Session waiting for input.",
      notifyUser: "always",
    });
    const calls = await waitForCalls(logPath, 2);

    assert.equal(calls.length, 2);
    const notifyCall = calls.find((call) => call[0] === "message");
    const notifyArgs = parseMessageSendArgs(notifyCall!);
    assert.equal(notifyArgs.channel, "feishu");
    assert.equal(notifyArgs.target, "oc_topic_chat");
    assert.equal(notifyArgs["thread-id"], "om_topic_xyz789");
    assert.equal(notifyArgs.message, "🔔 waiting");
  });

  it("prefers stored originThreadId over sessionKey threadId for feishu", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-9",
      originThreadId: "om_explicit_thread_123",
      originSessionKey: "agent:main:feishu:group:oc_chat:topic:om_key_thread",
      originAgentId: "main",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ done",
      notifyUser: "always",
    });
    const calls = await waitForCalls(logPath, 1);
    const notifyArgs = parseMessageSendArgs(calls[0]);
    assert.equal(notifyArgs["thread-id"], "om_explicit_thread_123");
  });
});
