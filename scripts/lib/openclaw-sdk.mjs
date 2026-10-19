import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareReleases } from "./runtime-dependency-pins.mjs";

export const sdkRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const exactVersion = /^\d{4}\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

/** The build baseline and development dependency are independent, exact pins. */
export function validateOpenClawSdkPins(pkg, lockfile) {
  const baseline = pkg.openclaw?.build?.openclawVersion;
  const dev = pkg.devDependencies?.openclaw;
  for (const [role, version] of Object.entries({ baseline, dev })) {
    if (typeof version !== "string" || version.trim() !== version || !exactVersion.test(version)
      || !version.split(".").every((part) => Number.isSafeInteger(Number(part)))) {
      throw new Error(`OpenClaw ${role} SDK must be an exact stable version, got ${version}`);
    }
  }
  if (pkg.openclaw?.build?.pluginSdkVersion !== baseline) throw new Error("OpenClaw build SDK metadata mismatch");
  if (pkg.devDependencies?.["openclaw-baseline"] !== `npm:openclaw@${baseline}`) {
    throw new Error(`OpenClaw baseline dependency must be npm:openclaw@${baseline}`);
  }
  if (compareReleases(dev, baseline) < 0) throw new Error("OpenClaw dev SDK must not be older than the build baseline");
  if (lockfile !== undefined) {
    // Read only the root importer's devDependencies, never a transitive match.
    const importer = lockfile.match(/^  \.:\n([\s\S]*?)(?=^  \S|^\S|$(?![\s\S]))/mu)?.[1];
    const dependencies = importer?.match(/^    devDependencies:\n([\s\S]*?)(?=^    \S|$(?![\s\S]))/mu)?.[1];
    for (const [name, specifier, version] of [
      ["openclaw", dev, dev], ["openclaw-baseline", `npm:openclaw@${baseline}`, `openclaw@${baseline}`],
    ]) {
      const entry = dependencies?.match(new RegExp(`^      ${name}:\\n        specifier: ([^\\n]+)\\n        version: ([^\\n]+)$`, "mu"));
      if (!entry || entry[1] !== specifier || entry[2].split("(")[0] !== version) {
        throw new Error(`pnpm-lock.yaml root dev dependency ${name} does not match ${specifier}`);
      }
    }
  }
  return { baseline, dev };
}

/** Resolve the actual package, not whichever executable pnpm put on PATH. */
export function selectOpenClawSdk(role = "baseline", baseDir = sdkRoot) {
  if (role !== "baseline" && role !== "dev") throw new Error(`Unknown OpenClaw SDK role: ${role}`);
  const pkg = JSON.parse(readFileSync(join(baseDir, "package.json"), "utf8"));
  const versions = validateOpenClawSdkPins(pkg, readFileSync(join(baseDir, "pnpm-lock.yaml"), "utf8"));
  const root = realpathSync(join(baseDir, "node_modules", role === "baseline" ? "openclaw-baseline" : "openclaw"));
  const host = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (host.name !== "openclaw" || host.version !== versions[role]) {
    throw new Error(`OpenClaw ${role} SDK package identity mismatch: expected openclaw@${versions[role]}`);
  }
  return { role, root, version: host.version, packageJson: host, cli: join(root, "openclaw.mjs") };
}

export function openClawSdkRole(args) {
  const options = args.filter((arg) => arg.startsWith("--sdk="));
  if (options.length > 1) throw new Error("Specify --sdk only once");
  const role = options[0]?.slice("--sdk=".length) ?? "baseline";
  if (role !== "baseline" && role !== "dev") throw new Error(`Unknown OpenClaw SDK role: ${role}`);
  return role;
}

/** Source and test imports must resolve through the selected public declarations. */
export function publicSdkTypePaths(sdk, baseDir = sdkRoot) {
  const paths = {};
  for (const [name, entry] of Object.entries(sdk.packageJson.exports ?? {})) {
    if (!name.startsWith("./plugin-sdk/") || typeof entry?.types !== "string") continue;
    const target = resolve(sdk.root, entry.types);
    const inside = relative(sdk.root, target);
    if (inside && !inside.startsWith("..") && !isAbsolute(inside) && existsSync(target)) {
      paths[`openclaw${name.slice(1)}`] = [realpathSync(target)];
    }
  }
  const files = ["api.ts", "index.ts"];
  for (const directory of ["src"]) {
    if (!existsSync(join(baseDir, directory))) continue;
    for (const file of readdirSync(join(baseDir, directory), { recursive: true })) {
      if (file.endsWith(".ts")) files.push(join(directory, file));
    }
  }
  for (const file of files) {
    const source = readFileSync(join(baseDir, file), "utf8");
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["'](openclaw(?:\/[^"']*)?)["']/gu)) {
      const name = match[1];
      if (!paths[name]) {
        throw new Error(`${name} has no public types in OpenClaw ${sdk.role} SDK ${sdk.version} (${file})`);
      }
    }
  }
  return paths;
}
