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
const FETCH_TIMEOUT_MS = 10_000;
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

type ManagedInstallSource = "npm" | "clawhub";

type ManagedInstall = {
  source: ManagedInstallSource;
  packageName: string;
  recordedVersion?: string;
  resolvedVersion?: string;
};

type PluginInspection = {
  pluginVersion: string;
  install: ManagedInstall;
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

function requiredString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function npmPackageNameFromSpec(spec: string | undefined): string | undefined {
  const normalized = spec?.trim().replace(/^npm:/, "");
  if (!normalized) return undefined;
  if (normalized.startsWith("@")) {
    const separator = normalized.indexOf("@", 1);
    return separator === -1 ? normalized : normalized.slice(0, separator);
  }
  const separator = normalized.indexOf("@");
  return separator === -1 ? normalized : normalized.slice(0, separator);
}

function parsePluginInspection(result: CommandResult): PluginInspection {
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  if (/No install record/i.test(combinedOutput)) {
    throw new Error("OpenClaw reported no managed install record for OCA.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error("OpenClaw returned invalid JSON while inspecting the OCA install.");
  }
  if (!isRecord(payload) || !isRecord(payload.plugin) || !isRecord(payload.install)) {
    throw new Error("OpenClaw inspection did not include the OCA plugin and managed install record.");
  }
  const pluginId = requiredString(payload.plugin, "id");
  const pluginVersion = normalizeVersion(requiredString(payload.plugin, "version"));
  if (pluginId !== PACKAGE_NAME || !pluginVersion) {
    throw new Error("OpenClaw inspection returned an unexpected OCA plugin identity or version.");
  }

  const source = requiredString(payload.install, "source");
  const recordedVersion = normalizeVersion(requiredString(payload.install, "version"));
  const resolvedVersion = normalizeVersion(requiredString(payload.install, "resolvedVersion"));
  if (source === "npm") {
    const packageName = requiredString(payload.install, "resolvedName")
      ?? npmPackageNameFromSpec(requiredString(payload.install, "spec"))
      ?? npmPackageNameFromSpec(requiredString(payload.install, "resolvedSpec"));
    if (!packageName) throw new Error("The OCA npm install record does not identify its package.");
    return { pluginVersion, install: { source, packageName, recordedVersion, resolvedVersion } };
  }
  if (source === "clawhub") {
    const packageName = requiredString(payload.install, "clawhubPackage");
    if (!packageName) throw new Error("The OCA ClawHub install record does not identify its package.");
    return { pluginVersion, install: { source, packageName, recordedVersion, resolvedVersion } };
  }
  throw new Error(`OCA self-update does not support managed install source ${source ?? "unknown"}.`);
}

function installArgs(install: ManagedInstall, version: string): string[] {
  const spec = install.source === "npm"
    ? `${install.packageName}@${version}`
    : `clawhub:${install.packageName}@${version}`;
  return ["plugins", "install", spec, "--force"];
}

function assertVerifiedInstall(
  before: PluginInspection,
  after: PluginInspection,
  approvedVersion: string,
): void {
  if (after.install.source !== before.install.source || after.install.packageName !== before.install.packageName) {
    throw new Error("OCA update verification found that the managed install source or package changed.");
  }
  if (after.pluginVersion !== approvedVersion) {
    throw new Error(`OCA update verification found installed plugin version ${after.pluginVersion}, expected ${approvedVersion}.`);
  }
  const managedVersions = [after.install.recordedVersion, after.install.resolvedVersion].filter(
    (version): version is string => Boolean(version),
  );
  if (managedVersions.length === 0 || managedVersions.some((version) => version !== approvedVersion)) {
    throw new Error(`OCA update verification found managed install version ${managedVersions.join("/") || "unknown"}, expected ${approvedVersion}.`);
  }
}

function parseStableSemver(version: string | undefined): [number, number, number] | undefined {
  const normalized = normalizeVersion(version);
  const match = normalized?.match(/^((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))$/);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  return parts.every(Number.isSafeInteger) ? parts : undefined;
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
  const response = await fetch(NPM_PACKAGE_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

async function fetchClawHubLatestRelease(
  runCommand: CommandRunner,
  packageName: string,
): Promise<ReleaseInfo | undefined> {
  const result = await runCommand("openclaw", ["plugins", "search", packageName, "--limit", "100", "--json"]);
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error("OpenClaw returned invalid JSON while checking ClawHub for OCA updates.");
  }
  const results = isRecord(payload) && Array.isArray(payload.results) ? payload.results : [];
  for (const entry of results) {
    if (!isRecord(entry) || !isRecord(entry.package)) continue;
    if (requiredString(entry.package, "name") !== packageName) continue;
    const version = normalizeVersion(requiredString(entry.package, "latestVersion"));
    return version ? { version } : undefined;
  }
  return undefined;
}

async function fetchSourceAwareLatestRelease(runCommand: CommandRunner): Promise<ReleaseInfo | undefined> {
  const inspection = parsePluginInspection(
    await runCommand("openclaw", ["plugins", "inspect", PACKAGE_NAME, "--json"]),
  );
  return inspection.install.source === "npm"
    ? fetchNpmLatestRelease()
    : fetchClawHubLatestRelease(runCommand, inspection.install.packageName);
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
    this.runCommand = options.runCommand ?? runOpenClawCommand;
    this.fetchLatestRelease = options.fetchLatestRelease ?? (() => fetchSourceAwareLatestRelease(this.runCommand));
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
    if (!normalizedVersion || !parseStableSemver(normalizedVersion)) {
      return "Could not determine which stable OCA version to update to.";
    }

    const before = parsePluginInspection(
      await this.runCommand("openclaw", ["plugins", "inspect", PACKAGE_NAME, "--json"]),
    );
    const installResult = await this.runCommand("openclaw", installArgs(before.install, normalizedVersion));
    if (/No install record/i.test(`${installResult.stdout}\n${installResult.stderr}`)) {
      throw new Error("OpenClaw reported no managed install record while updating OCA.");
    }
    const after = parsePluginInspection(
      await this.runCommand("openclaw", ["plugins", "inspect", PACKAGE_NAME, "--json"]),
    );
    assertVerifiedInstall(before, after, normalizedVersion);
    const state = this.readState();
    this.writeState({
      ...state,
      updateInstalledVersion: normalizedVersion,
    });

    const route = routeToNotificationRoute(routeSource?.route ?? fallbackRoute());
    if (route) {
      try {
        await this.sendRestartPrompt(route, normalizedVersion);
        return `OCA ${normalizedVersion} installation was verified. Restart confirmation was sent.`;
      } catch (error) {
        console.warn(`[auto-update] OCA ${normalizedVersion} was updated, but the restart prompt failed: ${errorMessage(error)}`);
      }
    }

    return [
      `OCA ${normalizedVersion} installation was verified.`,
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
      `Update now will reinstall the exact approved version from OCA's recorded npm or ClawHub source, then verify it.`,
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
      `OCA ${version} installation was verified.`,
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
  FETCH_TIMEOUT_MS,
  parsePluginInspection,
  installArgs,
  fetchClawHubLatestRelease,
};
