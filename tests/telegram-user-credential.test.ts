import "./test-env";
import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("exports and restores a username-less Telegram account without inventing identity", () => {
  const root = mkdtempSync(join(tmpdir(), "oca-telegram-credential-"));
  const helper = join(import.meta.dirname, "../scripts/e2e/telegram-user-credential.ts");
  const run = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", helper, ...args], {
    env: { ...process.env, OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "", TELEGRAM_E2E_SUT_BOT_TOKEN: "",
      OPENCLAW_QA_TELEGRAM_GROUP_ID: "", TELEGRAM_E2E_GROUP_ID: "" },
    stdio: "pipe",
  });
  try {
    const driver = join(root, "driver");
    const desktop = join(root, "desktop");
    for (const path of [join(driver, "db"), join(driver, "files"), join(desktop, "tdata")]) mkdirSync(path, { recursive: true });
    const config = { apiId: 1234, apiHash: "fixture-api-hash", databaseEncryptionKey: "fixture-key",
      defaultChatId: "-1001234", testerUserId: 5678, testerUsername: "" };
    writeFileSync(join(driver, "config.local.json"), JSON.stringify(config));
    writeFileSync(join(driver, "db", "fixture"), "TDLIB_FIXTURE");
    writeFileSync(join(desktop, "tdata", "fixture"), "DESKTOP_FIXTURE");
    const bots = join(root, "bots.json");
    writeFileSync(bots, JSON.stringify({ sutBotToken: "fixture-bot-token" }));
    const payloadFile = join(root, "payload.json");
    run("export", "--user-driver-dir", driver, "--desktop-tdata-dir", join(desktop, "tdata"),
      "--bot-credentials-file", bots, "--output", payloadFile);
    const payload = JSON.parse(readFileSync(payloadFile, "utf8"));
    assert.equal(payload.testerUserId, "5678");
    assert.equal(payload.testerUsername, "");
    const restored = join(root, "restored");
    run("restore", "--payload-file", payloadFile, "--user-driver-dir", restored,
      "--desktop-workdir", join(root, "restored-desktop"));
    assert.deepEqual(JSON.parse(readFileSync(join(restored, "config.local.json"), "utf8")), config);
    assert.equal(readFileSync(join(restored, "db", "fixture"), "utf8"), "TDLIB_FIXTURE");
    delete payload.testerUserId;
    writeFileSync(payloadFile, JSON.stringify(payload));
    assert.throws(() => run("restore", "--payload-file", payloadFile, "--user-driver-dir", restored,
      "--desktop-workdir", join(root, "restored-desktop")), /testerUserId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
