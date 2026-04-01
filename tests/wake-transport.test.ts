import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WakeTransport } from "../src/wake-transport";

const tempDirs: string[] = [];
const originalDiscordSdkModuleUrl = process.env.OPENCLAW_CODE_AGENT_DISCORD_SDK_MODULE_URL;
const originalDiscordLog = process.env.OPENCLAW_TEST_DISCORD_LOG;

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  if (originalDiscordSdkModuleUrl == null) {
    delete process.env.OPENCLAW_CODE_AGENT_DISCORD_SDK_MODULE_URL;
  } else {
    process.env.OPENCLAW_CODE_AGENT_DISCORD_SDK_MODULE_URL = originalDiscordSdkModuleUrl;
  }
  if (originalDiscordLog == null) {
    delete process.env.OPENCLAW_TEST_DISCORD_LOG;
  } else {
    process.env.OPENCLAW_TEST_DISCORD_LOG = originalDiscordLog;
  }
});

describe("WakeTransport", () => {
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

    const transport = new WakeTransport();
    const route = {
      provider: "discord",
      accountId: "bot",
      target: "channel:12345",
      threadId: "67890",
    };
    const buttons = [[{ label: "Approve", callbackData: "token-approve" }]];

    process.env.OPENCLAW_TEST_DISCORD_LOG = discordLogPath;
    process.env.OPENCLAW_CODE_AGENT_DISCORD_SDK_MODULE_URL = `file://${brokenModulePath}`;

    await assert.rejects(
      transport.sendDiscordComponents(route as any, buttons),
      /component sender export is unavailable/i,
    );

    process.env.OPENCLAW_CODE_AGENT_DISCORD_SDK_MODULE_URL = `file://${workingModulePath}`;
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
    process.env.OPENCLAW_CODE_AGENT_DISCORD_SDK_MODULE_URL = `file://${modulePath}`;

    const transport = new WakeTransport();
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
});
