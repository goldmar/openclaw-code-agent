import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WakeDispatcher } from "../src/wake-dispatcher";

type FakeSession = {
  id: string;
  harnessSessionId?: string;
  route?: {
    provider?: string;
    accountId?: string;
    target?: string;
    threadId?: string;
    sessionKey?: string;
  };
  originChannel?: string;
  originThreadId?: string | number;
  originSessionKey?: string;
  originAgentId?: string;
};

function buildRoute(overrides: Partial<NonNullable<FakeSession["route"]>> = {}): NonNullable<FakeSession["route"]> {
  return {
    provider: "telegram",
    accountId: "bot",
    target: "-1003863755361",
    threadId: "11239",
    sessionKey: "agent:main:telegram:group:-1003863755361:topic:11239",
    ...overrides,
  };
}

const WAIT_STEP_MS = 25;
const WAIT_TIMEOUT_MS = 7_000;

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
  const originalDiscordSdkModuleUrl = process.env.OPENCLAW_CODE_AGENT_DISCORD_SDK_MODULE_URL;
  const originalConsoleInfo = console.info;
  let tempDir: string;
  let logPath: string;
  let discordLogPath: string;
  let failStatePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "wake-dispatcher-test-"));
    logPath = join(tempDir, "openclaw-calls.log");
    discordLogPath = join(tempDir, "discord-components.log");
    failStatePath = join(tempDir, "openclaw-fail-state.json");
    writeFileSync(logPath, "");
    writeFileSync(discordLogPath, "");

    const fakeOpenClawPath = join(tempDir, "openclaw");
    writeFileSync(fakeOpenClawPath, `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");

const args = process.argv.slice(2);
appendFileSync(process.env.OPENCLAW_TEST_LOG, JSON.stringify(args) + "\\n");

const failConfigRaw = process.env.OPENCLAW_TEST_FAIL_ONCE_FOR;
if (failConfigRaw) {
  const failConfig = JSON.parse(failConfigRaw);
  const joined = args.join(" ");
  const statePath = process.env.OPENCLAW_TEST_FAIL_ONCE_STATE;
  const state = statePath && existsSync(statePath)
    ? new Set(JSON.parse(readFileSync(statePath, "utf8")))
    : new Set();
  if (joined.includes(failConfig.match) && !state.has(failConfig.match)) {
    state.add(failConfig.match);
    if (statePath) writeFileSync(statePath, JSON.stringify([...state]));
    const delayMs = Number(failConfig.delayMs ?? 0);
    setTimeout(() => {
      process.stderr.write(String(failConfig.stderr ?? "forced failure"));
      process.exit(Number(failConfig.exitCode ?? 1));
    }, delayMs);
    return;
  }
}
`);
    chmodSync(fakeOpenClawPath, 0o755);

    const fakeDiscordSdkPath = join(tempDir, "fake-discord-sdk.mjs");
    writeFileSync(fakeDiscordSdkPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

export async function sendDiscordComponentMessage(target, spec, opts = {}) {
  appendFileSync(
    process.env.OPENCLAW_TEST_DISCORD_LOG,
    JSON.stringify({ target, spec, opts }) + "\\n",
  );
  return { channel: "discord", target, spec, opts };
}
`);

    process.env.OPENCLAW_TEST_LOG = logPath;
    process.env.OPENCLAW_TEST_DISCORD_LOG = discordLogPath;
    process.env.OPENCLAW_TEST_FAIL_ONCE_STATE = failStatePath;
    process.env.OPENCLAW_CODE_AGENT_DISCORD_SDK_MODULE_URL = `file://${fakeDiscordSdkPath}`;
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
    if (originalDiscordSdkModuleUrl == null) {
      delete process.env.OPENCLAW_CODE_AGENT_DISCORD_SDK_MODULE_URL;
    } else {
      process.env.OPENCLAW_CODE_AGENT_DISCORD_SDK_MODULE_URL = originalDiscordSdkModuleUrl;
    }
    delete process.env.OPENCLAW_TEST_DISCORD_LOG;
    delete process.env.OPENCLAW_TEST_FAIL_ONCE_FOR;
    delete process.env.OPENCLAW_TEST_FAIL_ONCE_STATE;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function readDiscordCalls(path: string): Array<{
    target: string;
    spec: {
      blocks: Array<{
        type: string;
        buttons: Array<{ label: string; callbackData: string; style: string }>;
      }>;
    };
    opts: { accountId?: string };
  }> {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return [];
    return raw.split("\n").map((line) => JSON.parse(line));
  }

  async function waitForDiscordCalls(path: string, count: number) {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const calls = readDiscordCalls(path);
      if (calls.length >= count) return calls;
      await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    }
    throw new Error(`Timed out waiting for ${count} Discord component call(s) in ${path}`);
  }

  it("uses message.send for direct user notifications and logs completion", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-1",
      route: buildRoute(),
      originChannel: "telegram|bot|-1003863755361",
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
    assert.equal(params.target, "-1003863755361");
    assert.equal(params.message, "🚀 launched");
    assert.equal(params["thread-id"], "11239");
    await waitFor(
      () => infoLogs.some((line) => line.includes("\"event\":\"dispatch_succeeded\"") && line.includes("\"target\":\"message.send\"")),
      "dispatcher completion log",
    );
    assert.ok(infoLogs.some((line) => line.includes("\"route\":\"telegram|bot|-1003863755361#11239\"")));
  });

  it("preserves direct notification order when an earlier delivery retries", async () => {
    process.env.OPENCLAW_TEST_FAIL_ONCE_FOR = JSON.stringify({
      match: "🚀 launched",
      delayMs: 50,
      stderr: "launch delivery failed once",
      exitCode: 1,
    });
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-ordering",
      route: buildRoute(),
      originChannel: "telegram|bot|12345",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1003863755361:topic:11239",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      notifyUser: "always",
    });

    const calls = await waitForCalls(logPath, 3);
    const messages = calls.map((call) => parseMessageSendArgs(call).message);
    assert.deepEqual(messages, ["🚀 launched", "🚀 launched", "✅ completed"]);
  });

  it("treats explicit system routes as non-routable and falls back to system.event", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-system-route",
      route: {
        provider: "system",
        target: "system",
      },
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(logPath, 1);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["system", "event", "--text", "🚀 launched", "--mode", "now"]);
  });

  it("recovers a direct Telegram notification route from degraded persisted metadata", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-degraded-route",
      route: {
        provider: "system",
        target: "system",
        sessionKey: "agent:main:telegram:group:-1003863755361:topic:11239",
      },
      originChannel: "telegram",
      originSessionKey: "agent:main:telegram:group:-1003863755361:topic:11239",
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
    assert.equal(params.target, "-1003863755361");
    assert.equal(params["thread-id"], "11239");
    assert.equal(params.message, "🚀 launched");
  });

  it("does not install process-level signal listeners per instance", () => {
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    new WakeDispatcher();
    new WakeDispatcher();
    new WakeDispatcher();

    assert.equal(process.listenerCount("SIGINT"), sigintBefore);
    assert.equal(process.listenerCount("SIGTERM"), sigtermBefore);
  });

  it("sends the direct notification and wake through separate transports when wake metadata is present", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-2",
      route: buildRoute(),
      originChannel: "telegram|bot|-1003863755361",
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
    assert.equal(wakeParams.channel, undefined);
    assert.equal(wakeParams.accountId, undefined);
    assert.equal(wakeParams.target, undefined);
    assert.equal(wakeParams.threadId, undefined);
  });

  it("preserves Telegram inline buttons when a notification also sends a wake", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-buttons",
      route: buildRoute(),
      originChannel: "telegram|bot|12345",
      originThreadId: 11239,
      originSessionKey: "agent:main:telegram:group:-1003863755361:topic:11239",
      originAgentId: "main",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "worktree-delegate",
      userMessage: "🔀 Worktree decision required",
      wakeMessage: "Delegated worktree decision wake",
      notifyUser: "always",
      buttons: [[
        { label: "✅ Merge", callbackData: "token-merge" },
        { label: "📬 Open PR", callbackData: "token-pr" },
      ]],
    });
    const calls = await waitForCalls(logPath, 2);

    assert.equal(calls.length, 2);
    const notifyCall = calls.find((call) => call[0] === "message");
    const wakeCall = calls.find((call) => call[0] === "gateway");
    assert.ok(notifyCall, "expected a message.send notification call");
    assert.ok(wakeCall, "expected a chat.send wake call");
    const notifyArgs = parseMessageSendArgs(notifyCall);
    assert.equal(notifyArgs.message, "🔀 Worktree decision required");
    assert.equal(notifyArgs.buttons, JSON.stringify([[
      { text: "✅ Merge", callback_data: "code-agent:token-merge" },
      { text: "📬 Open PR", callback_data: "code-agent:token-pr" },
    ]]));
    const wakeParams = parseChatSendParams(wakeCall);
    assert.equal(wakeParams.message, "Delegated worktree decision wake");
  });

  it("falls back to a direct user notification plus system event when the wake target is unavailable", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-3",
      route: buildRoute({ sessionKey: undefined }),
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

  it("does not silently downgrade interactive notifications to system text when direct routing is unavailable", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-interactive-no-route",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-approval",
      userMessage: "📋 Plan ready",
      notifyUser: "always",
      buttons: [[
        { label: "Approve", callbackData: "token-approve" },
        { label: "Reject", callbackData: "token-reject" },
      ]],
      wakeMessageOnNotifyFailed: "Interactive delivery failed; no buttons were sent.",
    });
    const calls = await waitForCalls(logPath, 1);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      "system",
      "event",
      "--text",
      "Interactive delivery failed; no buttons were sent.",
      "--mode",
      "now",
    ]);
  });

  it("prefers the structured route over legacy originChannel fields for new-schema sessions", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-route-wins",
      route: {
        provider: "discord",
        accountId: "bot-account",
        target: "channel:999",
      },
      originChannel: "telegram|bot|12345",
      originSessionKey: "agent:main:telegram:group:-1003863755361:topic:11239",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(logPath, 1);
    const params = parseMessageSendArgs(calls[0] ?? []);
    assert.equal(params.channel, "discord");
    assert.equal(params.account, "bot-account");
    assert.equal(params.target, "channel:999");
  });

  it("uses the wake/system fallback only once when originSessionKey is missing", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = { id: "session-4", route: buildRoute({ sessionKey: undefined }) };

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

  it("does not send a direct notify fallback when wake routing is recoverable from originSessionKey", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-origin-session-key-wake",
      route: buildRoute({ sessionKey: undefined }),
      originSessionKey: "agent:main:telegram:group:-1003863755361:topic:11239",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "waiting",
      userMessage: "🔔 waiting",
      wakeMessage: "Session is waiting for input.",
      notifyUser: "on-wake-fallback",
    });
    const calls = await waitForCalls(logPath, 1);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "gateway");
    const wakeParams = parseChatSendParams(calls[0] ?? []);
    assert.equal(wakeParams.sessionKey, "agent:main:telegram:group:-1003863755361:topic:11239");
    assert.equal(wakeParams.channel, undefined);
    assert.equal(wakeParams.threadId, undefined);
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

  it("routes explicit Discord channel targets through message.send", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-6",
      route: buildRoute({
        provider: "discord",
        accountId: undefined,
        target: "channel:1481874223294054540",
        threadId: undefined,
        sessionKey: undefined,
      }),
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(logPath, 1);

    assert.equal(calls.length, 1);
    const params = parseMessageSendArgs(calls[0] ?? []);
    assert.equal(params.channel, "discord");
    assert.equal(params.target, "channel:1481874223294054540");
    assert.equal(params.message, "🚀 launched");
  });

  it("routes explicit Discord DM targets through message.send", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-7",
      route: buildRoute({
        provider: "discord",
        accountId: undefined,
        target: "user:774236449288749097",
        threadId: undefined,
        sessionKey: undefined,
      }),
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "launch",
      userMessage: "🚀 launched",
      notifyUser: "always",
    });
    const calls = await waitForCalls(logPath, 1);

    assert.equal(calls.length, 1);
    const params = parseMessageSendArgs(calls[0] ?? []);
    assert.equal(params.channel, "discord");
    assert.equal(params.target, "user:774236449288749097");
    assert.equal(params.message, "🚀 launched");
  });

  it("sends Discord buttons as a separate native component notification", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-10",
      route: buildRoute({
        provider: "discord",
        accountId: undefined,
        target: "channel:1481874223294054540",
        threadId: "1481999999999999999",
        sessionKey: undefined,
      }),
      originChannel: "discord|1481874223294054540",
      originThreadId: "1481999999999999999",
      originSessionKey: "agent:main:discord:channel:1481874223294054540",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "plan-approval",
      userMessage: "📋 Plan ready",
      notifyUser: "always",
      buttons: [[
        { label: "Approve", callbackData: "token-approve" },
        { label: "Reject", callbackData: "token-reject" },
      ]],
    });

    const textCalls = await waitForCalls(logPath, 1);
    const componentCalls = await waitForDiscordCalls(discordLogPath, 1);

    const textArgs = parseMessageSendArgs(textCalls[0] ?? []);
    assert.equal(textArgs.channel, "discord");
    assert.equal(textArgs.target, "channel:1481874223294054540");
    assert.equal(textArgs.message, "📋 Plan ready");
    assert.equal(textArgs["thread-id"], "1481999999999999999");

    const component = componentCalls[0];
    assert.equal(component?.target, "channel:1481999999999999999");
    assert.deepEqual(component?.spec.blocks, [{
      type: "actions",
      buttons: [
        { label: "Approve", callbackData: "code-agent:token-approve", style: "primary" },
        { label: "Reject", callbackData: "code-agent:token-reject", style: "danger" },
      ],
    }]);
  });

  it("falls back to system notify when no explicit route is present", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-8",
    };

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

  it("preserves existing Telegram routing when Discord sessions are added", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-9",
      route: buildRoute(),
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
    assert.equal(params.target, "-1003863755361");
    assert.equal(params.message, "🚀 launched");
    assert.equal(params["thread-id"], "11239");
  });

  it("preserves Telegram topic routing for follow-up notifications", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-10",
      route: {
        provider: "telegram",
        accountId: "bot",
        target: "-1003863755361",
        threadId: "13832",
        sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
      },
      originChannel: "telegram|bot|-1003863755361",
      originThreadId: 13832,
      originSessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
    };

    dispatcher.dispatchSessionNotification(session as any, {
      label: "completed",
      userMessage: "✅ completed",
      notifyUser: "always",
    });
    const calls = await waitForCalls(logPath, 1);

    assert.equal(calls.length, 1);
    const params = parseMessageSendArgs(calls[0] ?? []);
    assert.equal(params.channel, "telegram");
    assert.equal(params.account, "bot");
    assert.equal(params.target, "-1003863755361");
    assert.equal(params.message, "✅ completed");
    assert.equal(params["thread-id"], "13832");
  });

  it("repairs Telegram topic follow-ups before notifying or waking", async () => {
    const dispatcher = new WakeDispatcher();
    const session: FakeSession = {
      id: "session-telegram-topic-repair",
      route: {
        provider: "telegram",
        accountId: "bot",
        target: "5551234",
        threadId: "13832",
        sessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
      },
      originChannel: "telegram",
      originThreadId: 13832,
      originSessionKey: "agent:main:telegram:group:-1003863755361:topic:13832",
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
    assert.equal(notifyArgs.target, "-1003863755361");
    assert.equal(notifyArgs["thread-id"], "13832");

    const wakeParams = parseChatSendParams(wakeCall);
    assert.equal(wakeParams.sessionKey, "agent:main:telegram:group:-1003863755361:topic:13832");
    assert.equal(wakeParams.channel, undefined);
    assert.equal(wakeParams.accountId, undefined);
    assert.equal(wakeParams.target, undefined);
    assert.equal(wakeParams.threadId, undefined);
  });
});
