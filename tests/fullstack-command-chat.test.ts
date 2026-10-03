import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitUntil } from "./harness-backends";
import { startFullStack, TELEGRAM_TOPIC, type FullStack, type SentMessage } from "./fullstack-fixture";

/**
 * One user-visible message per chat command, through the real plugin entry on
 * the fake host. The command contexts have the host's `PluginCommandContext`
 * shape: top-level `channel`, `to`, `accountId`, `messageThreadId`, `senderId`
 * and `sessionKey`, without a `deliveryContext`.
 */

type CommandReply = { text?: string; suppressReply?: boolean };

const TOPIC_COMMAND = {
  channel: "telegram",
  to: `telegram:${TELEGRAM_TOPIC.to}`,
  accountId: TELEGRAM_TOPIC.accountId,
  messageThreadId: TELEGRAM_TOPIC.threadId,
  senderId: "1234",
  sessionKey: TELEGRAM_TOPIC.sessionKey,
};
const OTHER_TOPIC_COMMAND = {
  ...TOPIC_COMMAND,
  messageThreadId: 7,
  sessionKey: `agent:main:telegram:group:${TELEGRAM_TOPIC.to}:topic:7`,
};
const DM_COMMAND = {
  channel: "telegram",
  to: "telegram:1234",
  accountId: TELEGRAM_TOPIC.accountId,
  senderId: "1234",
  sessionKey: "agent:main:main",
};

const PLUGIN_CONFIG = { defaultWorktreeStrategy: "off", permissionMode: "default" };

let stack: FullStack | undefined;

afterEach(async () => {
  await stack?.dispose();
  stack = undefined;
});

function workdir(): string {
  return mkdtempSync(join(process.env.OPENCLAW_CODE_AGENT_TEST_HOME?.trim() || tmpdir(), "fullstack-command-"));
}

async function command(s: FullStack, name: string, ctx: Record<string, unknown>): Promise<CommandReply> {
  return await s.host.runCommand(name, ctx as Parameters<FullStack["host"]["runCommand"]>[1]) as CommandReply;
}

/** What the user sees for one command: its reply (unless suppressed) and every notice sent since `after`. */
function visible(s: FullStack, reply: CommandReply, after: number): { reply: string[]; notices: SentMessage[] } {
  return {
    reply: reply.suppressReply === true || !reply.text ? [] : [reply.text],
    notices: s.messages().filter((message) => message.index >= after),
  };
}

/** Let the terminal lifecycle finish, so a notice that would be sent has been sent. */
async function settle(s: FullStack, name: string): Promise<void> {
  await waitUntil(() => {
    const status = s.sm.resolve(name)?.status ?? s.sm.getPersistedSession(name)?.status;
    return status === "killed" || status === "failed";
  }, `${name} ended`);
  await s.sm.whenStorePersisted();
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function launchFromTopic(s: FullStack, name: string): Promise<void> {
  const before = s.host.durableSends.length;
  const reply = await command(s, "agent", { ...TOPIC_COMMAND, args: `--name ${name} --workdir ${workdir()} --harness codex Start the task` });
  assert.match(reply.text ?? "", new RegExp(`^🚀 \\[${name}\\] Launched \\| `), reply.text);
  await waitUntil(() => s.sm.resolve(name)?.status === "running", `${name} running`);
  // One message: the reply replaces the 🚀 launch notice.
  assert.deepEqual(visible(s, reply, before).notices.filter((message) => /Launched/.test(message.text)), []);
  // The route carries the bot account the command was typed to.
  assert.deepEqual(s.sm.resolve(name)?.route, {
    provider: "telegram",
    accountId: TELEGRAM_TOPIC.accountId,
    target: TELEGRAM_TOPIC.to,
    threadId: String(TELEGRAM_TOPIC.threadId),
    sessionKey: TELEGRAM_TOPIC.sessionKey,
  });
}

describe("one message per chat command (Telegram topic)", () => {
  it("/agent then /agent_kill in the same topic: the kill reply is the only stop message", async () => {
    const s = stack = await startFullStack({ backend: "codex", pluginConfig: PLUGIN_CONFIG });
    await launchFromTopic(s, "cmd-kill");

    const before = s.host.durableSends.length;
    const reply = await command(s, "agent_kill", { ...TOPIC_COMMAND, args: "cmd-kill" });
    await settle(s, "cmd-kill");

    const seen = visible(s, reply, before);
    assert.equal(seen.reply.length, 1);
    assert.match(seen.reply[0]!, /^⛔ \[cmd-kill\] Stopped by user/);
    assert.deepEqual(seen.notices.map((message) => message.text), [], "no separate stop notice in the same topic");
  });

  it("/agent_kill from another topic: a short reply there, the stop notice in the session's topic", async () => {
    const s = stack = await startFullStack({ backend: "codex", pluginConfig: PLUGIN_CONFIG });
    await launchFromTopic(s, "cmd-kill-elsewhere");

    const before = s.host.durableSends.length;
    const reply = await command(s, "agent_kill", { ...OTHER_TOPIC_COMMAND, args: "cmd-kill-elsewhere" });
    const notice = await s.waitForMessage(/^⛔ \[cmd-kill-elsewhere\] Stopped by user/, before);
    await settle(s, "cmd-kill-elsewhere");

    assert.equal(reply.text, "⛔ [cmd-kill-elsewhere] Stopped.");
    assert.equal(notice.to, TELEGRAM_TOPIC.to);
    assert.equal(String(notice.threadId), String(TELEGRAM_TOPIC.threadId));
    assert.equal(notice.accountId, TELEGRAM_TOPIC.accountId);
    assert.equal(visible(s, reply, before).notices.filter((message) => /Stopped/.test(message.text)).length, 1);
  });

  it("/agent failing at startup in its own topic: the Failed notice with its buttons is the only message", async () => {
    const s = stack = await startFullStack({ backend: "codex", pluginConfig: PLUGIN_CONFIG });
    (s.backend.harness as { launch: unknown }).launch = () => { throw new Error("model_not_found"); };

    const before = s.host.durableSends.length;
    const reply = await command(s, "agent", { ...TOPIC_COMMAND, args: `--name cmd-broken --workdir ${workdir()} --harness codex Start the task` });
    const notice = await s.waitForMessage(/^❌ \[cmd-broken\] Failed/, before);
    await settle(s, "cmd-broken");

    assert.deepEqual(reply, { suppressReply: true });
    const seen = visible(s, reply, before);
    assert.deepEqual(seen.reply, []);
    assert.deepEqual(seen.notices.map((message) => message.text), [notice.text], "exactly one message");
    assert.match(notice.text, /model_not_found/);
    assert.equal(notice.to, TELEGRAM_TOPIC.to);
    assert.equal(String(notice.threadId), String(TELEGRAM_TOPIC.threadId));
    assert.equal(notice.accountId, TELEGRAM_TOPIC.accountId);
    assert.ok(notice.buttons.length > 0, "the notice keeps its buttons");
  });

  it("/agent failing at startup for a session that reports to another chat: the reply and the notice", async () => {
    const dir = workdir();
    const s = stack = await startFullStack({
      backend: "codex",
      pluginConfig: { ...PLUGIN_CONFIG, agentChannels: { [dir]: `telegram|${TELEGRAM_TOPIC.accountId}|${TELEGRAM_TOPIC.to}` } },
    });
    (s.backend.harness as { launch: unknown }).launch = () => { throw new Error("model_not_found"); };

    const before = s.host.durableSends.length;
    // Typed in a DM; `agentChannels` sends this directory's notices to the group.
    const reply = await command(s, "agent", { ...DM_COMMAND, args: `--name cmd-broken-elsewhere --workdir ${dir} --harness codex Start the task` });
    const notice = await s.waitForMessage(/^❌ \[cmd-broken-elsewhere\] Failed/, before);
    await settle(s, "cmd-broken-elsewhere");

    assert.equal(reply.text, "❌ [cmd-broken-elsewhere] Did not start: model_not_found\nFix the problem and run /agent again.");
    assert.equal(notice.to, TELEGRAM_TOPIC.to);
    assert.equal(visible(s, reply, before).notices.length, 1);
  });
});
