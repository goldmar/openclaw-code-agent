/**
 * Environments for child processes OCA starts.
 *
 * Two policies (documented in docs/REFERENCE.md, "Child process environments"):
 *
 * - Repository-controlled commands (the `.openclaw/worktree-setup.sh` script
 *   and goal verifier commands) get a minimal allowlisted environment: the
 *   basics a build or test command needs (PATH, HOME, locale, temp dir, XDG
 *   dirs, CA bundles, proxies) and nothing else, so no API keys or tokens.
 * - Coding-agent backends (the Codex app server, the Claude Agent SDK, and the
 *   OpenCode server) keep the Gateway environment, because they need their own
 *   provider credentials and whatever the user's agent configuration relies
 *   on, minus secrets that are clearly unrelated to running a coding agent:
 *   GitHub, npm and ClawHub tokens, OpenClaw Gateway credentials, chat-channel
 *   bot tokens, 1Password and cloud-infrastructure tokens.
 *
 * `git` and `gh` keep the full Gateway environment: pushing and opening pull
 * requests need `SSH_AUTH_SOCK`, `GH_TOKEN` and the git credential helpers.
 */

const MINIMAL_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  // Windows process basics.
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

/** Variables allowed into repository-controlled commands, in addition to `LC_*`. */
export const MINIMAL_CHILD_ENV_KEYS: readonly string[] = MINIMAL_ENV_KEYS;

/**
 * Minimal environment for repository-controlled commands: allowlisted keys from
 * `base`, plus `extra`. Shell startup hooks (`BASH_ENV`, `ENV`) are never set.
 */
export function buildMinimalChildEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const allowed = new Set<string>(MINIMAL_ENV_KEYS);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (allowed.has(key) || key.startsWith("LC_")) env[key] = value;
  }
  return { ...env, ...extra };
}

const UNRELATED_SECRET_KEYS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "CLAWHUB_TOKEN",
  "OP_SERVICE_ACCOUNT_TOKEN",
  "OP_CONNECT_TOKEN",
  "HCLOUD_TOKEN",
  "DIGITALOCEAN_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "DISCORD_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_USER_TOKEN",
  "SLACK_SIGNING_SECRET",
]);

/** OpenClaw credentials (`OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_*_PASSWORD`, ...). */
const OPENCLAW_SECRET_KEY = /^OPENCLAW_[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET)$/;

/** True for a variable that coding-agent backends never receive. */
export function isUnrelatedSecretEnvKey(key: string): boolean {
  return UNRELATED_SECRET_KEYS.has(key) || OPENCLAW_SECRET_KEY.test(key) || key.startsWith("OP_SESSION_");
}

/** Gateway environment for a coding-agent backend, without clearly unrelated secrets. */
export function buildHarnessChildEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || isUnrelatedSecretEnvKey(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}
