import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { RuntimeDirectNotificationTransport, type DirectNotificationTransport } from "./direct-notification-transport";
import { pluginConfig } from "./config";
import { routeFromOriginMetadata, type SessionRouteSource } from "./session-route";
import type { SessionActionKind, SessionActionToken, SessionRoute } from "./types";
import type { NotificationButton } from "./session-interactions";
import type { NotificationRoute } from "./wake-route-resolver";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "openclaw-code-agent";
const NPM_PACKAGE_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`;
const UPDATE_STATE_FILE = "openclaw-code-agent-auto-update.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const UPDATE_SESSION_ID = "plugin:auto-update";

type AutoUpdateState = {
  lastCheckedAt?: string;
  latestVersion?: string;
  promptedVersion?: string;
  lastPromptedAt?: string;
  dismissedVersion?: string;
  lastDismissedAt?: string;
  updateInstalledVersion?: string;
  restartPromptedVersion?: string;
  lastError?: string;
};

type ReleaseInfo = {
  version: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;
type ReleaseFetcher = () => Promise<ReleaseInfo | undefined>;

type PluginUpdateActionKind = Extract<
  SessionActionKind,
  "plugin-update-install" | "plugin-update-remind-later" | "plugin-update-dismiss" | "plugin-update-restart"
>;

type ActionButtonFactory = (
  sessionId: string,
  kind: PluginUpdateActionKind,
  label: string,
  options?: Partial<Omit<SessionActionToken, "id" | "sessionId" | "kind" | "createdAt">>,
) => NotificationButton;

export type AutoUpdateCheckContext = {
  route?: SessionRoute;
};

export type AutoUpdateServiceOptions = {
  stateDir: string;
  currentVersion: string;
  actionButtonFactory: ActionButtonFactory;
  notifier?: DirectNotificationTransport;
  fetchLatestRelease?: ReleaseFetcher;
  runCommand?: CommandRunner;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeVersion(version: string | undefined): string | undefined {
  const trimmed = version?.trim().replace(/^v/i, "");
  return trimmed || undefined;
}

function parseStableSemver(version: string | undefined): [number, number, number] | undefined {
  const normalized = normalizeVersion(version);
  const match = normalized?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerStableVersion(candidate: string | undefined, current: string | undefined): boolean {
  const next = parseStableSemver(candidate);
  const base = parseStableSemver(current);
  if (!next || !base) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] > base[index]) return true;
    if (next[index] < base[index]) return false;
  }
  return false;
}

function normalizeState(raw: unknown): AutoUpdateState {
  if (!isRecord(raw)) return {};
  const state: AutoUpdateState = {};
  for (const key of [
    "lastCheckedAt",
    "latestVersion",
    "promptedVersion",
    "lastPromptedAt",
    "dismissedVersion",
    "lastDismissedAt",
    "updateInstalledVersion",
    "restartPromptedVersion",
    "lastError",
  ] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) state[key] = value;
  }
  return state;
}

function routeToNotificationRoute(route?: SessionRoute): NotificationRoute | undefined {
  if (!route?.provider || !route.target || route.provider === "system" || route.target === "system") return undefined;
  return {
    channel: route.provider,
    target: route.target,
    accountId: route.accountId,
    threadId: route.threadId,
    sessionKey: route.sessionKey,
  };
}

function fallbackRoute(): SessionRoute | undefined {
  if (!pluginConfig.fallbackChannel) return undefined;
  return routeFromOriginMetadata(pluginConfig.fallbackChannel);
}

async function fetchNpmLatestRelease(): Promise<ReleaseInfo | undefined> {
  // Match the normal OCA install/update path: the plugin package declares
  // openclaw.install.defaultChoice="npm", and `openclaw plugins update <id>`
  // follows the recorded npm install source for bare OCA installs.
  const response = await fetch(NPM_PACKAGE_URL, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status}`);
  }
  const payload = await response.json() as unknown;
  const version = isRecord(payload) && typeof payload.version === "string"
    ? normalizeVersion(payload.version)
    : undefined;
  return version ? { version } : undefined;
}

async function runOpenClawCommand(command: string, args: string[]): Promise<CommandResult> {
  const result = await execFileAsync(command, args, {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

export class AutoUpdateService {
  private readonly statePath: string;
  private readonly notifier: DirectNotificationTransport;
  private readonly fetchLatestRelease: ReleaseFetcher;
  private readonly runCommand: CommandRunner;
  private readonly now: () => number;
  private checkInFlight: Promise<void> | undefined;

  constructor(private readonly options: AutoUpdateServiceOptions) {
    this.statePath = join(options.stateDir, UPDATE_STATE_FILE);
    this.notifier = options.notifier ?? new RuntimeDirectNotificationTransport();
    this.fetchLatestRelease = options.fetchLatestRelease ?? fetchNpmLatestRelease;
    this.runCommand = options.runCommand ?? runOpenClawCommand;
    this.now = options.now ?? Date.now;
  }

  maybeCheckForUpdate(context: AutoUpdateCheckContext = {}): void {
    if (this.checkInFlight) return;
    this.checkInFlight = this.checkForUpdate(context)
      .catch((error) => {
        console.warn(`[auto-update] Update check failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.checkInFlight = undefined;
      });
  }

  async waitForIdle(): Promise<void> {
    await this.checkInFlight;
  }

  async installConfirmed(version: string | undefined, routeSource?: SessionRouteSource): Promise<string> {
    const normalizedVersion = normalizeVersion(version);
    if (!normalizedVersion) return "Could not determine which OCA version to update to.";

    await this.runCommand("openclaw", ["plugins", "update", `${PACKAGE_NAME}@latest`]);
    const state = this.readState();
    this.writeState({
      ...state,
      updateInstalledVersion: normalizedVersion,
    });

    const route = routeToNotificationRoute(routeSource?.route ?? fallbackRoute());
    if (route) {
      await this.sendRestartPrompt(route, normalizedVersion);
      return `OCA update command completed for ${normalizedVersion}. Restart confirmation was sent.`;
    }

    return [
      `OCA update command completed for ${normalizedVersion}.`,
      `Restart the Gateway explicitly to load it: openclaw gateway restart`,
    ].join("\n");
  }

  async restartConfirmed(version: string | undefined): Promise<string> {
    const normalizedVersion = normalizeVersion(version);
    await this.runCommand("openclaw", ["gateway", "restart"]);
    return normalizedVersion
      ? `Gateway restart requested for OCA ${normalizedVersion}.`
      : "Gateway restart requested.";
  }

  dismiss(version: string | undefined): string {
    return this.postpone(version, "Dismissed");
  }

  remindLater(version: string | undefined): string {
    return this.postpone(version, "Will remind later about");
  }

  private postpone(version: string | undefined, label: string): string {
    const normalizedVersion = normalizeVersion(version);
    const state = this.readState();
    this.writeState({
      ...state,
      ...(normalizedVersion
        ? {
            dismissedVersion: normalizedVersion,
            lastDismissedAt: new Date(this.now()).toISOString(),
          }
        : {}),
    });
    return normalizedVersion
      ? `${label} OCA ${normalizedVersion} update reminder.`
      : `${label} OCA update reminder.`;
  }

  private async checkForUpdate(context: AutoUpdateCheckContext): Promise<void> {
    const state = this.readState();
    const checkedAtMs = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : Number.NaN;
    if (Number.isFinite(checkedAtMs) && this.now() - checkedAtMs < DAY_MS) {
      await this.promptFromState(state, context);
      return;
    }

    const checkedAt = new Date(this.now()).toISOString();
    const checkedState: AutoUpdateState = { ...state, lastCheckedAt: checkedAt };
    delete checkedState.lastError;
    this.writeState(checkedState);

    try {
      const release = await this.fetchLatestRelease();
      const latestVersion = normalizeVersion(release?.version);
      const nextState: AutoUpdateState = {
        ...this.readState(),
        latestVersion,
      };
      delete nextState.lastError;
      this.writeState(nextState);

      await this.promptFromState(nextState, context);
    } catch (error) {
      this.writeState({
        ...this.readState(),
        lastError: errorMessage(error),
      });
      throw error;
    }
  }

  private async promptFromState(state: AutoUpdateState, context: AutoUpdateCheckContext): Promise<void> {
    const latestVersion = normalizeVersion(state.latestVersion);
    if (!isNewerStableVersion(latestVersion, this.options.currentVersion)) return;
    if (!this.shouldPromptForVersion(state, latestVersion)) return;

    const route = routeToNotificationRoute(context.route ?? fallbackRoute());
    if (!route) return;

    await this.sendUpdatePrompt(route, latestVersion);
    this.writeState({
      ...this.readState(),
      latestVersion,
      promptedVersion: latestVersion,
      lastPromptedAt: new Date(this.now()).toISOString(),
    });
  }

  private async sendUpdatePrompt(route: NotificationRoute, latestVersion: string): Promise<void> {
    await this.notifier.send(route, [
      `OCA update available: ${this.options.currentVersion} -> ${latestVersion}.`,
      ``,
      `Update now will run: openclaw plugins update ${PACKAGE_NAME}@latest`,
      `If the update succeeds, OCA will ask separately before restarting the Gateway.`,
    ].join("\n"), [[
      this.options.actionButtonFactory(UPDATE_SESSION_ID, "plugin-update-install", "Update now", {
        pluginUpdateVersion: latestVersion,
        route: {
          provider: route.channel,
          accountId: route.accountId,
          target: route.target,
          threadId: route.threadId,
          sessionKey: route.sessionKey,
        },
      }),
      this.options.actionButtonFactory(UPDATE_SESSION_ID, "plugin-update-remind-later", "Remind later", {
        pluginUpdateVersion: latestVersion,
      }),
      this.options.actionButtonFactory(UPDATE_SESSION_ID, "plugin-update-dismiss", "Dismiss", {
        pluginUpdateVersion: latestVersion,
      }),
    ]]);
  }

  private shouldPromptForVersion(state: AutoUpdateState, latestVersion: string): boolean {
    const lastRelevantPromptAt = state.promptedVersion === latestVersion
      ? state.lastPromptedAt
      : undefined;
    const lastRelevantDismissedAt = state.dismissedVersion === latestVersion
      ? state.lastDismissedAt
      : undefined;
    const timestamps = [lastRelevantPromptAt, lastRelevantDismissedAt]
      .map((value) => value ? Date.parse(value) : Number.NaN)
      .filter((value) => Number.isFinite(value));
    if (timestamps.length === 0) return true;
    return this.now() - Math.max(...timestamps) >= WEEK_MS;
  }

  private async sendRestartPrompt(route: NotificationRoute, version: string): Promise<void> {
    await this.notifier.send(route, [
      `OCA ${version} update command completed.`,
      ``,
      `Restart the Gateway now to load the updated plugin?`,
      `This will run: openclaw gateway restart`,
    ].join("\n"), [[
      this.options.actionButtonFactory(UPDATE_SESSION_ID, "plugin-update-restart", "Restart Gateway", {
        pluginUpdateVersion: version,
      }),
      this.options.actionButtonFactory(UPDATE_SESSION_ID, "plugin-update-remind-later", "Remind later", {
        pluginUpdateVersion: version,
      }),
      this.options.actionButtonFactory(UPDATE_SESSION_ID, "plugin-update-dismiss", "Dismiss", {
        pluginUpdateVersion: version,
      }),
    ]]);
    this.writeState({
      ...this.readState(),
      restartPromptedVersion: version,
    });
  }

  private readState(): AutoUpdateState {
    try {
      return normalizeState(JSON.parse(readFileSync(this.statePath, "utf-8")));
    } catch {
      return {};
    }
  }

  private writeState(state: AutoUpdateState): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, this.statePath);
  }
}

export const autoUpdateInternals = {
  NPM_PACKAGE_URL,
  UPDATE_SESSION_ID,
  UPDATE_STATE_FILE,
  DAY_MS,
  WEEK_MS,
};
