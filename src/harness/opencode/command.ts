import { constants as fsConstants, accessSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { pluginConfig } from "../../config";
function isExecutable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandHasPathSeparator(command: string): boolean {
  return command.includes("/") || (sep === "\\" && command.includes("\\"));
}

export function candidateSearchPaths(envPath: string | undefined): string[] {
  const paths = (envPath ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const expanded = [...paths];
  for (const entry of paths) {
    const normalized = entry.replaceAll("\\", "/");
    if (normalized.endsWith("/opt/node/bin")) {
      expanded.push(join(dirname(dirname(dirname(entry))), "bin"));
    }
  }
  // N6: only standard system locations; a Homebrew/Linuxbrew install must be on
  // the Gateway's PATH or named by OPENCLAW_OPENCODE_COMMAND.
  expanded.push("/usr/local/bin", "/usr/bin", "/bin");
  return [...new Set(expanded)];
}

/**
 * Resolve the OpenCode executable to an absolute path against the Gateway's
 * working directory. The server is spawned with `cwd: tmpdir()`, so a relative
 * override such as `./bin/opencode` (or a relative PATH entry) would otherwise
 * be looked up from the temp directory.
 */
export function resolveCommandPath(
  command: string,
  envPath = process.env.PATH,
  baseDir = process.cwd(),
): string {
  // Prefix relative paths without normalizing: `..` must still be resolved by
  // the OS after symlinks, and absolute overrides pass through unchanged.
  const anchor = (path: string): string =>
    isAbsolute(path) ? path : `${baseDir}${sep}${path}`;
  if (commandHasPathSeparator(command)) return anchor(command);
  for (const entry of candidateSearchPaths(envPath)) {
    const candidate = isAbsolute(entry)
      ? join(entry, command)
      : `${anchor(entry)}${sep}${command}`;
    if (isExecutable(candidate)) return candidate;
  }
  return command;
}

export function resolveOpenCodeCommand(): string {
  const override =
    process.env.OPENCLAW_OPENCODE_COMMAND ??
    pluginConfig.harnesses.opencode?.command;
  if (override) return resolveCommandPath(override);
  const v2 = resolveCommandPath("opencode2");
  return v2 !== "opencode2" ? v2 : resolveCommandPath("opencode");
}
