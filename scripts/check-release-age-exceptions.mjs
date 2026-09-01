import { readFile } from "node:fs/promises";

const marker = /^\s*#\s*(security-exception|release-exception)\s+(.+)\s*$/;
const entry = /^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/;
const exactPackageVersion = /^(?:@[^/@]+\/[^/@]+|[^@/]+)@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export function parseReleaseAgeExceptions(source) {
  const lines = source.split(/\r?\n/);
  const exceptions = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = marker.exec(lines[index]);
    if (!match) continue;

    const fields = Object.fromEntries(
      match[2].split(/\s+/).map((part) => {
        const separator = part.indexOf("=");
        if (separator < 1) throw new Error(`Malformed release-age exception field on line ${index + 1}: ${part}`);
        return [part.slice(0, separator), part.slice(separator + 1)];
      }),
    );
    const packageMatch = entry.exec(lines[index + 1] ?? "");
    if (!packageMatch) throw new Error(`Release-age exception on line ${index + 1} must immediately precede one package entry`);
    exceptions.push({ ...fields, kind: match[1], package: packageMatch[1], line: index + 1 });
  }

  return exceptions;
}

function parseMinimumReleaseAgeExcludes(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^minimumReleaseAgeExclude:\s*$/u.test(line));
  if (start < 0) return [];

  const excludes = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\S/u.test(lines[index])) break;
    const match = entry.exec(lines[index]);
    if (match) excludes.push(match[1]);
  }
  return excludes;
}

export function validateReleaseAgeExceptions(source, now = new Date()) {
  if (!/^minimumReleaseAge:\s*1440\s*$/mu.test(source)) {
    throw new Error("pnpm-workspace.yaml must preserve the 24-hour minimumReleaseAge: 1440 policy");
  }
  const exceptions = parseReleaseAgeExceptions(source);
  const excludes = parseMinimumReleaseAgeExcludes(source);
  const annotatedPackages = exceptions.map((exception) => exception.package);
  const unannotated = excludes.filter((packageSpec) => !annotatedPackages.includes(packageSpec));
  if (unannotated.length > 0) {
    throw new Error(
      `minimumReleaseAgeExclude contains unannotated exception(s): ${unannotated.join(", ")}`,
    );
  }
  const detached = annotatedPackages.filter((packageSpec) => !excludes.includes(packageSpec));
  if (detached.length > 0) {
    throw new Error(`release-age exception marker is outside minimumReleaseAgeExclude: ${detached.join(", ")}`);
  }
  for (const exception of exceptions) {
    if (!exactPackageVersion.test(exception.package)) {
      throw new Error(`Release-age exception on line ${exception.line} is not an exact package@version: ${exception.package}`);
    }
    if (exception.kind === "security-exception" && !/^GHSA-[0-9a-z-]+$/.test(exception.advisory ?? "")) {
      throw new Error(`Security exception on line ${exception.line} requires a GHSA advisory`);
    }
    if (exception.kind === "release-exception" && !/^[0-9a-z][0-9a-z.-]+$/u.test(exception.reason ?? "")) {
      throw new Error(`Release exception on line ${exception.line} requires a machine-readable reason`);
    }

    const published = Date.parse(exception.published ?? "");
    const quarantineEnds = Date.parse(exception.quarantineEnds ?? "");
    const expires = Date.parse(exception.expires ?? "");
    if (![published, quarantineEnds, expires].every(Number.isFinite)) {
      throw new Error(`Release-age exception on line ${exception.line} requires valid published, quarantineEnds, and expires timestamps`);
    }
    if (quarantineEnds !== published + 24 * 60 * 60 * 1000) {
      throw new Error(`Release-age exception on line ${exception.line} must use the repository's 24-hour quarantine`);
    }
    if (expires <= quarantineEnds) {
      throw new Error(`Release-age exception on line ${exception.line} must expire after quarantine ends`);
    }
    if (now.getTime() >= expires) {
      throw new Error(`Release-age exception on line ${exception.line} expired at ${exception.expires}; remove it`);
    }
  }
  return exceptions;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const workspaceFile = new URL("../pnpm-workspace.yaml", import.meta.url);
  const exceptions = validateReleaseAgeExceptions(await readFile(workspaceFile, "utf8"));
  console.log(`Validated ${exceptions.length} temporary release-age exception(s).`);
}
