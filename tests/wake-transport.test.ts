import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WakeTransport } from "../src/wake-transport";

const tempDirs: string[] = [];
const originalDiscordLog = process.env.OPENCLAW_TEST_DISCORD_LOG;
const originalPath = process.env.PATH;

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  if (originalDiscordLog == null) {
    delete process.env.OPENCLAW_TEST_DISCORD_LOG;
  } else {
    process.env.OPENCLAW_TEST_DISCORD_LOG = originalDiscordLog;
  }
  if (originalPath == null) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
});

describe("WakeTransport", () => {
  it("keeps chat.send payloads limited to the gateway-supported session wake shape", () => {
    const transport = new WakeTransport();
    const args = transport.buildChatSendArgs(
      "agent:main:telegram:group:-1003863755361:topic:13832",
      "wake up",
      true,
    );

    assert.deepEqual(args.slice(0, 6), [
      "gateway",
      "call",
      "chat.send",
      "--expect-final",
      "--timeout",
      "30000",
    ]);
    const payload = JSON.parse(args[7] ?? "{}") as Record<string, unknown>;
    assert.equal(payload.sessionKey, "agent:main:telegram:group:-1003863755361:topic:13832");
    assert.equal(payload.message, "wake up");
    assert.equal(payload.deliver, true);
    assert.equal(payload.channel, undefined);
    assert.equal(payload.accountId, undefined);
    assert.equal(payload.target, undefined);
    assert.equal(payload.threadId, undefined);
  });

  it("retries loading the Discord component sender after a transient module failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wake-transport-test-"));
    tempDirs.push(dir);

    const brokenModulePath = join(dir, "broken-discord-sdk.mjs");
    const workingModulePath = join(dir, "working-discord-sdk.mjs");
    const discordLogPath = join(dir, "discord-components.log");

    writeFileSync(
      brokenModulePath,
      "export const sendDiscordComponentMessage = undefined;\n",
      "utf8",
    );
    writeFileSync(
      workingModulePath,
      [
        "import { appendFileSync } from \"node:fs\";",
        "",
        "export async function sendDiscordComponentMessage(target, spec, opts = {}) {",
        "  appendFileSync(process.env.OPENCLAW_TEST_DISCORD_LOG, JSON.stringify({ target, spec, opts }) + \"\\n\");",
        "  return { target, spec, opts };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(discordLogPath, "", "utf8");

    let moduleUrl = `file://${brokenModulePath}`;
    const transport = new WakeTransport({
      resolveDiscordSdkModuleUrl: () => moduleUrl,
    });
    const route = {
      provider: "discord",
      accountId: "bot",
      target: "channel:12345",
      threadId: "67890",
    };
    const buttons = [[{ label: "Approve", callbackData: "token-approve" }]];

    process.env.OPENCLAW_TEST_DISCORD_LOG = discordLogPath;

    await assert.rejects(
      transport.sendDiscordComponents(route as any, buttons),
      /component sender export is unavailable/i,
    );

    moduleUrl = `file://${workingModulePath}`;
    await transport.sendDiscordComponents(route as any, buttons);

    const calls = readFileSync(discordLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { target: string; opts: { accountId?: string } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.target, "channel:67890");
    assert.equal(calls[0]?.opts.accountId, "bot");
  });

  it("omits accountId from the Discord SDK call when the route has no account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wake-transport-test-"));
    tempDirs.push(dir);

    const modulePath = join(dir, "discord-sdk.mjs");
    const discordLogPath = join(dir, "discord-components.log");

    writeFileSync(
      modulePath,
      [
        "import { appendFileSync } from \"node:fs\";",
        "",
        "export async function sendDiscordComponentMessage(target, spec, opts) {",
        "  appendFileSync(process.env.OPENCLAW_TEST_DISCORD_LOG, JSON.stringify({ target, spec, opts }) + \"\\n\");",
        "  return { target, spec, opts };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(discordLogPath, "", "utf8");

    process.env.OPENCLAW_TEST_DISCORD_LOG = discordLogPath;
    const transport = new WakeTransport({
      resolveDiscordSdkModuleUrl: () => `file://${modulePath}`,
    });
    await transport.sendDiscordComponents({
      provider: "discord",
      target: "channel:12345",
      threadId: "67890",
    } as any, [[{ label: "Approve", callbackData: "token-approve" }]]);

    const calls = readFileSync(discordLogPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { opts?: unknown });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.opts, undefined);
  });

  it("encodes Telegram buttons through the presentation payload by default", () => {
    const transport = new WakeTransport();
    const args = transport.buildDirectNotificationArgs({
      channel: "telegram",
      target: "-1003863755361",
      threadId: "28",
    } as any, "Plan ready", [[{ label: "Approve", callbackData: "token-approve" }]]);

    assert.deepEqual(args.slice(0, 8), [
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      "-1003863755361",
      "--message",
      "Plan ready",
    ]);
    assert.equal(args[8], "--thread-id");
    assert.equal(args[9], "28");
    assert.equal(args[10], "--presentation");
    assert.deepEqual(JSON.parse(args[11] ?? "{}"), {
      blocks: [{
        type: "buttons",
        buttons: [{ text: "Approve", callback_data: "code-agent:token-approve" }],
      }],
    });
  });

  it("can still emit legacy Telegram --buttons payloads for older OpenClaw CLIs", () => {
    const transport = new WakeTransport({ telegramButtonCliMode: "legacy-buttons" });
    const args = transport.buildDirectNotificationArgs({
      channel: "telegram",
      target: "-1003863755361",
    } as any, "Plan ready", [[{ label: "Approve", callbackData: "token-approve" }]]);

    assert.equal(args[8], "--buttons");
    assert.deepEqual(JSON.parse(args[9] ?? "[]"), [[
      { text: "Approve", callback_data: "code-agent:token-approve" },
    ]]);
  });

  it("auto-detects legacy Telegram button support from the local OpenClaw CLI help", () => {
    const dir = mkdtempSync(join(tmpdir(), "wake-transport-test-"));
    tempDirs.push(dir);

    const fakeOpenClawPath = join(dir, "openclaw");
    writeFileSync(
      fakeOpenClawPath,
      [
        "#!/usr/bin/env node",
        "if (process.argv.slice(2).join(' ') === 'message send --help') {",
        "  process.stdout.write('Usage: openclaw message send\\n\\nOptions:\\n  --buttons <json>\\n');",
        "  process.exit(0);",
        "}",
        "process.exit(1);",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fakeOpenClawPath, 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ""}`;

    const transport = new WakeTransport();
    const args = transport.buildDirectNotificationArgs({
      channel: "telegram",
      target: "-1003863755361",
    } as any, "Plan ready", [[{ label: "Approve", callbackData: "token-approve" }]]);

    assert.equal(args[8], "--buttons");
  });
});
