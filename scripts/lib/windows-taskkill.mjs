// Resolves Windows system binaries without trusting PATH.
import path from "node:path";

const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

function getEnvValueCaseInsensitive(env, expectedKey) {
  const direct = env[expectedKey];
  if (direct !== undefined) return direct;
  const expected = expectedKey.toUpperCase();
  const actualKey = Object.keys(env).find((key) => key.toUpperCase() === expected);
  return actualKey ? env[actualKey] : undefined;
}

function normalizeWindowsSystemRoot(raw) {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("\r") || trimmed.includes("\n") || trimmed.includes(";")) {
    return null;
  }
  const normalized = path.win32.normalize(trimmed);
  if (!path.win32.isAbsolute(normalized) || normalized.startsWith("\\\\")) return null;
  const parsed = path.win32.parse(normalized);
  if (!/^[A-Za-z]:\\$/u.test(parsed.root) || normalized.length <= parsed.root.length) return null;
  return normalized.replace(/[\\/]+$/u, "");
}

function resolveWindowsSystemRoot(env = process.env) {
  return (
    normalizeWindowsSystemRoot(getEnvValueCaseInsensitive(env, "SystemRoot")) ??
    normalizeWindowsSystemRoot(getEnvValueCaseInsensitive(env, "WINDIR")) ??
    DEFAULT_WINDOWS_SYSTEM_ROOT
  );
}

function resolveWindowsSystem32Path(executableName, env = process.env) {
  if (
    path.win32.basename(executableName) !== executableName ||
    !/^[A-Za-z0-9_.-]+\.exe$/u.test(executableName)
  ) {
    throw new Error(`Invalid Windows System32 executable name: ${executableName}`);
  }
  return path.win32.join(resolveWindowsSystemRoot(env), "System32", executableName);
}

export function resolveWindowsTaskkillPath(env = process.env) {
  return resolveWindowsSystem32Path("taskkill.exe", env);
}
