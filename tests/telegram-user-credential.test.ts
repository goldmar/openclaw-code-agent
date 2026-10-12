import "./test-env";
import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const modern of [false, true]) it(modern
  ? "exports and restores the modern TDLib primary username saved by the driver"
  : "exports and restores a username-less Telegram account without inventing identity", () => {
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
    if (modern) {
      execFileSync("python3", ["-c", `
import importlib.util, json, pathlib, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("driver", "scripts/e2e/telegram-user-driver.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.CONFIG_PATH = pathlib.Path(sys.argv[1])
stored = json.loads(module.CONFIG_PATH.read_text())
module.save_tester_identity(stored, {"id": 5678, "usernames": {
    "active_usernames": ["primary_qa", "secondary_qa"], "editable_username": "disabled_qa"}})
`, join(driver, "config.local.json")], { stdio: "pipe" });
      config.testerUsername = "primary_qa";
    }
    writeFileSync(join(driver, "db", "fixture"), "TDLIB_FIXTURE");
    writeFileSync(join(desktop, "tdata", "fixture"), "DESKTOP_FIXTURE");
    const bots = join(root, "bots.json");
    writeFileSync(bots, JSON.stringify({ sutBotToken: "fixture-bot-token" }));
    const payloadFile = join(root, "payload.json");
    run("export", "--user-driver-dir", driver, "--desktop-tdata-dir", join(desktop, "tdata"),
      "--bot-credentials-file", bots, "--output", payloadFile);
    const payload = JSON.parse(readFileSync(payloadFile, "utf8"));
    assert.equal(payload.testerUserId, "5678");
    assert.equal(payload.testerUsername, modern ? "primary_qa" : "");
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
