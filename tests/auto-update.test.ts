import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoUpdateService, autoUpdateInternals, isNewerStableVersion } from "../src/auto-update";
import { setPluginConfig } from "../src/config";
import type { NotificationRoute } from "../src/wake-route-resolver";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "oca-auto-update-"));
}

function readState(dir: string): Record<string, unknown> {
  const path = join(dir, autoUpdateInternals.UPDATE_STATE_FILE);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {};
}

function writeState(dir: string, state: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, autoUpdateInternals.UPDATE_STATE_FILE), JSON.stringify(state, null, 2), "utf8");
}

function createService(options: {
  stateDir?: string;
  currentVersion?: string;
  latestVersion?: string;
  now?: () => number;
  sends?: Array<{ route: NotificationRoute; text: string; labels: string[] }>;
  commands?: string[][];
  installSource?: "npm" | "clawhub";
}) {
  const sends = options.sends ?? [];
  const commands = options.commands ?? [];
  let fetchCount = 0;
  let installedVersion = options.currentVersion ?? "4.6.0";
  const installSource = options.installSource ?? "npm";
  const service = new AutoUpdateService({
    stateDir: options.stateDir ?? tempStateDir(),
    currentVersion: options.currentVersion ?? "4.6.0",
    now: options.now,
    actionButtonFactory: (_sessionId, kind, label, actionOptions) => ({
      label,
      callbackData: `${kind}:${actionOptions?.pluginUpdateVersion ?? ""}`,
    }),
    fetchLatestRelease: async () => {
      fetchCount++;
      return options.latestVersion ? { version: options.latestVersion } : undefined;
    },
    notifier: {
      send: async (route, text, buttons) => {
        sends.push({
          route,
          text,
          labels: (buttons ?? []).flat().map((button) => button.label),
        });
      },
    },
    runCommand: async (command, args) => {
      commands.push([command, ...args]);
      if (args[0] === "plugins" && args[1] === "install") {
        const match = args[2]?.match(/@(\d+\.\d+\.\d+)$/);
        if (match?.[1]) installedVersion = match[1];
      }
      if (args[0] === "plugins" && args[1] === "inspect") {
        return {
          stdout: JSON.stringify({
            plugin: { id: "openclaw-code-agent", version: installedVersion },
            install: installSource === "npm"
              ? {
                  source: "npm",
                  spec: "openclaw-code-agent",
                  resolvedName: "openclaw-code-agent",
                  version: installedVersion,
                  resolvedVersion: installedVersion,
                }
              : {
                  source: "clawhub",
                  clawhubPackage: "openclaw-code-agent",
                  version: installedVersion,
                  resolvedVersion: installedVersion,
                },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  });
  return {
    service,
    sends,
    commands,
    get fetchCount() {
      return fetchCount;
    },
  };
}

const ROUTE = {
  provider: "telegram",
  accountId: "bot",
  target: "12345",
  threadId: "42",
  sessionKey: "agent:main:telegram:group:12345:topic:42",
};

describe("AutoUpdateService", () => {
  it("compares only newer stable semver releases", () => {
    assert.equal(isNewerStableVersion("4.6.1", "4.6.0"), true);
    assert.equal(isNewerStableVersion("4.7.0", "4.6.9"), true);
    assert.equal(isNewerStableVersion("4.6.0", "4.6.0"), false);
    assert.equal(isNewerStableVersion("4.5.9", "4.6.0"), false);
    assert.equal(isNewerStableVersion("4.7.0-beta.1", "4.6.0"), false);
    assert.equal(isNewerStableVersion("04.7.0", "4.6.0"), false);
    assert.equal(isNewerStableVersion("9007199254740992.0.0", "4.6.0"), false);
  });

  it("checks npm at most once per day", async () => {
    setPluginConfig({});
    let now = Date.parse("2026-07-08T12:00:00.000Z");
    const stateDir = tempStateDir();
    const harness = createService({
      stateDir,
      latestVersion: "4.6.1",
      now: () => now,
    });

    harness.service.maybeCheckForUpdate({ route: ROUTE });
    await harness.service.waitForIdle();
    harness.service.maybeCheckForUpdate({ route: ROUTE });
    await harness.service.waitForIdle();

    assert.equal(harness.fetchCount, 1);
    assert.equal(harness.sends.length, 1);

    now += autoUpdateInternals.DAY_MS + 1;
    harness.service.maybeCheckForUpdate({ route: ROUTE });
    await harness.service.waitForIdle();

    assert.equal(harness.fetchCount, 2);
    assert.equal(harness.sends.length, 1, "same release should not re-prompt before weekly window");
  });

  it("prompts when a newer release is available and records lastPromptedAt", async () => {
    setPluginConfig({});
    const now = Date.parse("2026-07-08T12:00:00.000Z");
    const stateDir = tempStateDir();
    const harness = createService({
      stateDir,
      latestVersion: "4.6.1",
      now: () => now,
    });

    harness.service.maybeCheckForUpdate({ route: ROUTE });
    await harness.service.waitForIdle();

    assert.equal(harness.sends.length, 1);
    assert.match(harness.sends[0]?.text ?? "", /4\.6\.0 -> 4\.6\.1/);
    assert.deepEqual(harness.sends[0]?.labels, ["Update now", "Remind later", "Dismiss"]);
    assert.equal(readState(stateDir).promptedVersion, "4.6.1");
    assert.equal(readState(stateDir).lastPromptedAt, new Date(now).toISOString());
    assert.deepEqual(harness.commands, []);
  });

  it("uses npm registry metadata as the default release source", async () => {
    setPluginConfig({});
    const originalFetch = globalThis.fetch;
    const stateDir = tempStateDir();
    let requestedUrl = "";
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ version: "4.6.1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const sends: Array<{ route: NotificationRoute; text: string; labels: string[] }> = [];
      const service = new AutoUpdateService({
        stateDir,
        currentVersion: "4.6.0",
        actionButtonFactory: (_sessionId, kind, label, actionOptions) => ({
          label,
          callbackData: `${kind}:${actionOptions?.pluginUpdateVersion ?? ""}`,
        }),
        notifier: {
          send: async (route, text, buttons) => {
            sends.push({
              route,
              text,
              labels: (buttons ?? []).flat().map((button) => button.label),
            });
          },
        },
        runCommand: async () => ({
          stdout: JSON.stringify({
            plugin: { id: "openclaw-code-agent", version: "4.6.0" },
            install: { source: "npm", resolvedName: "openclaw-code-agent", resolvedVersion: "4.6.0" },
          }),
          stderr: "",
        }),
      });

      service.maybeCheckForUpdate({ route: ROUTE });
      await service.waitForIdle();

      assert.equal(requestedUrl, autoUpdateInternals.NPM_PACKAGE_URL);
      assert.equal(readState(stateDir).latestVersion, "4.6.1");
      assert.equal(sends.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the recorded ClawHub package for update discovery", async () => {
    setPluginConfig({});
    const originalFetch = globalThis.fetch;
    let npmFetched = false;
    globalThis.fetch = async () => {
      npmFetched = true;
      throw new Error("npm must not be queried for a ClawHub install");
    };
    const commands: string[][] = [];
    try {
      const sends: Array<{ route: NotificationRoute; text: string; labels: string[] }> = [];
      const service = new AutoUpdateService({
        stateDir: tempStateDir(),
        currentVersion: "4.6.0",
        actionButtonFactory: (_sessionId, kind, label) => ({ label, callbackData: kind }),
        notifier: {
          send: async (route, text, buttons) => {
            sends.push({ route, text, labels: (buttons ?? []).flat().map((button) => button.label) });
          },
        },
        runCommand: async (command, args) => {
          commands.push([command, ...args]);
          if (args[1] === "inspect") {
            return {
              stdout: JSON.stringify({
                plugin: { id: "openclaw-code-agent", version: "4.6.0" },
                install: {
                  source: "clawhub",
                  clawhubPackage: "goldmar/openclaw-code-agent",
                  resolvedVersion: "4.6.0",
                },
              }),
              stderr: "",
            };
          }
          return {
            stdout: JSON.stringify({
              results: [
                { package: { name: "lookalike", latestVersion: "9.9.9" }, score: 100 },
                { package: { name: "goldmar/openclaw-code-agent", latestVersion: "4.6.1" }, score: 90 },
              ],
            }),
            stderr: "",
          };
        },
      });

      service.maybeCheckForUpdate({ route: ROUTE });
      await service.waitForIdle();

      assert.equal(npmFetched, false);
      assert.deepEqual(commands, [
        ["openclaw", "plugins", "inspect", "openclaw-code-agent", "--json"],
        ["openclaw", "plugins", "search", "goldmar/openclaw-code-agent", "--limit", "100", "--json"],
      ]);
      assert.match(sends[0]?.text ?? "", /4\.6\.0 -> 4\.6\.1/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not prompt without a direct route or fallback channel", async () => {
    setPluginConfig({});
    const harness = createService({ latestVersion: "4.6.1" });

    harness.service.maybeCheckForUpdate();
    await harness.service.waitForIdle();

    assert.equal(harness.fetchCount, 1);
    assert.equal(harness.sends.length, 0);
  });

  it("prompts from cached latest version when a routed retry follows a route-less daily check", async () => {
    setPluginConfig({});
    const now = Date.parse("2026-07-08T12:00:00.000Z");
    const stateDir = tempStateDir();
    const harness = createService({
      stateDir,
      latestVersion: "4.6.1",
      now: () => now,
    });

    harness.service.maybeCheckForUpdate();
    await harness.service.waitForIdle();

    assert.equal(harness.fetchCount, 1);
    assert.equal(harness.sends.length, 0);
    assert.equal(readState(stateDir).latestVersion, "4.6.1");
    assert.equal(readState(stateDir).lastCheckedAt, new Date(now).toISOString());

    harness.service.maybeCheckForUpdate({ route: ROUTE });
    await harness.service.waitForIdle();

    assert.equal(harness.fetchCount, 1);
    assert.equal(harness.sends.length, 1);
    assert.equal(readState(stateDir).promptedVersion, "4.6.1");
    assert.equal(readState(stateDir).lastPromptedAt, new Date(now).toISOString());
  });

  it("re-prompts a dismissed release only after the weekly reminder window", async () => {
    setPluginConfig({});
    let now = Date.parse("2026-07-15T12:00:00.000Z");
    const stateDir = tempStateDir();
    writeState(stateDir, {
      lastCheckedAt: "2026-07-13T12:00:00.000Z",
      latestVersion: "4.6.1",
      dismissedVersion: "4.6.1",
      lastDismissedAt: "2026-07-12T12:00:00.000Z",
    });
    const harness = createService({
      stateDir,
      latestVersion: "4.6.1",
      now: () => now,
    });

    harness.service.maybeCheckForUpdate({ route: ROUTE });
    await harness.service.waitForIdle();
    assert.equal(harness.sends.length, 0);

    now = Date.parse("2026-07-20T12:00:01.000Z");
    writeState(stateDir, {
      ...readState(stateDir),
      lastCheckedAt: "2026-07-18T12:00:00.000Z",
    });
    harness.service.maybeCheckForUpdate({ route: ROUTE });
    await harness.service.waitForIdle();

    assert.equal(harness.sends.length, 1);
    assert.equal(readState(stateDir).promptedVersion, "4.6.1");
    assert.equal(readState(stateDir).lastPromptedAt, new Date(now).toISOString());
  });

  it("runs update and restart only from explicit confirmation methods", async () => {
    setPluginConfig({});
    const stateDir = tempStateDir();
    const harness = createService({
      stateDir,
      latestVersion: "4.6.1",
    });

    harness.service.maybeCheckForUpdate({ route: ROUTE });
    await harness.service.waitForIdle();
    assert.deepEqual(harness.commands, []);

    const updateText = await harness.service.installConfirmed("4.6.1", { route: ROUTE });
    assert.match(updateText, /Restart confirmation was sent/);
    assert.deepEqual(harness.commands, [
      ["openclaw", "plugins", "inspect", "openclaw-code-agent", "--json"],
      ["openclaw", "plugins", "install", "openclaw-code-agent@4.6.1", "--force"],
      ["openclaw", "plugins", "inspect", "openclaw-code-agent", "--json"],
    ]);
    assert.deepEqual(harness.sends.at(-1)?.labels, ["Restart Gateway", "Remind later", "Dismiss"]);

    const restartText = await harness.service.restartConfirmed("4.6.1");
    assert.match(restartText, /Gateway restart requested/);
    assert.deepEqual(harness.commands.at(-1), ["openclaw", "gateway", "restart"]);
  });

  it("installs the exact approved version when npm latest advances after prompting", async () => {
    setPluginConfig({});
    const stateDir = tempStateDir();
    const harness = createService({
      stateDir,
      currentVersion: "4.6.0",
      latestVersion: "4.6.1",
    });

    harness.service.maybeCheckForUpdate({ route: ROUTE });
    await harness.service.waitForIdle();
    assert.match(harness.sends[0]?.text ?? "", /exact approved version/);

    // The registry may move after the signed callback token was created. The
    // confirmation must still install the version that the user saw.
    const updateText = await harness.service.installConfirmed("4.6.1", { route: ROUTE });

    assert.match(updateText, /installation was verified/);
    assert.deepEqual(harness.commands, [
      ["openclaw", "plugins", "inspect", "openclaw-code-agent", "--json"],
      ["openclaw", "plugins", "install", "openclaw-code-agent@4.6.1", "--force"],
      ["openclaw", "plugins", "inspect", "openclaw-code-agent", "--json"],
    ]);
    assert.equal(readState(stateDir).updateInstalledVersion, "4.6.1");
    assert.match(harness.sends.at(-1)?.text ?? "", /OCA 4\.6\.1 installation was verified/);
  });

  it("reinstalls an exact approved ClawHub release from the recorded source", async () => {
    setPluginConfig({});
    const harness = createService({ installSource: "clawhub" });

    await harness.service.installConfirmed("4.6.1", { route: ROUTE });

    assert.deepEqual(harness.commands, [
      ["openclaw", "plugins", "inspect", "openclaw-code-agent", "--json"],
      ["openclaw", "plugins", "install", "clawhub:openclaw-code-agent@4.6.1", "--force"],
      ["openclaw", "plugins", "inspect", "openclaw-code-agent", "--json"],
    ]);
  });

  it("rejects an exit-zero No install record result without recording success", async () => {
    setPluginConfig({});
    const stateDir = tempStateDir();
    let call = 0;
    const service = new AutoUpdateService({
      stateDir,
      currentVersion: "4.6.0",
      actionButtonFactory: (_sessionId, kind, label) => ({ label, callbackData: kind }),
      runCommand: async () => {
        call++;
        if (call === 1) {
          return {
            stdout: JSON.stringify({
              plugin: { id: "openclaw-code-agent", version: "4.6.0" },
              install: { source: "npm", resolvedName: "openclaw-code-agent", resolvedVersion: "4.6.0" },
            }),
            stderr: "",
          };
        }
        return { stdout: 'No install record for "openclaw-code-agent@4.6.1".', stderr: "" };
      },
    });

    await assert.rejects(service.installConfirmed("4.6.1", { route: ROUTE }), /no managed install record/i);
    assert.equal(readState(stateDir).updateInstalledVersion, undefined);
  });

  it("requires installed plugin and managed install versions to match the approval", async () => {
    setPluginConfig({});
    const stateDir = tempStateDir();
    let inspections = 0;
    const service = new AutoUpdateService({
      stateDir,
      currentVersion: "4.6.0",
      actionButtonFactory: (_sessionId, kind, label) => ({ label, callbackData: kind }),
      runCommand: async (_command, args) => {
        if (args[1] === "inspect") {
          inspections++;
          return {
            stdout: JSON.stringify({
              plugin: { id: "openclaw-code-agent", version: "4.6.0" },
              install: {
                source: "npm",
                resolvedName: "openclaw-code-agent",
                version: "4.6.0",
                resolvedVersion: "4.6.0",
              },
            }),
            stderr: "",
          };
        }
        return { stdout: "Installed", stderr: "" };
      },
    });

    await assert.rejects(service.installConfirmed("4.6.1", { route: ROUTE }), /installed plugin version 4\.6\.0/);
    assert.equal(inspections, 2);
    assert.equal(readState(stateDir).updateInstalledVersion, undefined);
  });

  it("rejects non-stable update versions before invoking OpenClaw", async () => {
    setPluginConfig({});
    const harness = createService({});

    const updateText = await harness.service.installConfirmed("latest", { route: ROUTE });

    assert.match(updateText, /stable OCA version/);
    assert.deepEqual(harness.commands, []);
  });

  it("does not report a completed install as failed when the restart prompt cannot be delivered", async () => {
    setPluginConfig({});
    const commands: string[][] = [];
    let installed = false;
    const service = new AutoUpdateService({
      stateDir: tempStateDir(),
      currentVersion: "4.6.0",
      actionButtonFactory: (_sessionId, kind, label) => ({ label, callbackData: kind }),
      notifier: { send: async () => { throw new Error("Telegram message is no longer available"); } },
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        if (args[1] === "install") installed = true;
        if (args[1] === "inspect") {
          return {
            stdout: JSON.stringify({
              plugin: { id: "openclaw-code-agent", version: installed ? "4.6.1" : "4.6.0" },
              install: {
                source: "npm",
                spec: "openclaw-code-agent",
                resolvedName: "openclaw-code-agent",
                version: installed ? "4.6.1" : "4.6.0",
                resolvedVersion: installed ? "4.6.1" : "4.6.0",
              },
            }),
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      },
    });

    const updateText = await service.installConfirmed("4.6.1", { route: ROUTE });

    assert.match(updateText, /installation was verified/);
    assert.match(updateText, /openclaw gateway restart/);
    assert.deepEqual(commands[1], ["openclaw", "plugins", "install", "openclaw-code-agent@4.6.1", "--force"]);
  });
});
