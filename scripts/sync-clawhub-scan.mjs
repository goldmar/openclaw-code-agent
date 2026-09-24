#!/usr/bin/env node
// Regenerates the vendored ClawHub static moderation scanner in
// scripts/vendor/clawhub-moderation-engine.mjs from a local clawhub checkout
// (https://github.com/openclaw/clawhub, MIT).
//
// Usage: node scripts/sync-clawhub-scan.mjs [--clawhub <dir>] [--check]
//        CLAWHUB_DIR=<dir> node scripts/sync-clawhub-scan.mjs
//
// The generator bundles `convex/lib/moderationEngine.ts` (and its local
// imports, which are pure TypeScript with no runtime dependencies) with
// esbuild into one ESM file, prefixed with the source commit and the upstream
// MIT license notice. Never edit the vendored file by hand.
// `--check` fails when the vendored file differs from a fresh generation.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const vendoredEnginePath = join(repoRoot, "scripts", "vendor", "clawhub-moderation-engine.mjs");
const ENTRY = join("convex", "lib", "moderationEngine.ts");
const SOURCE_REPO = "https://github.com/openclaw/clawhub";

function parseArgs(argv) {
  const args = { clawhub: process.env.CLAWHUB_DIR, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--clawhub") args.clawhub = argv[++i];
    else if (argv[i] === "--check") args.check = true;
    else if (!argv[i].startsWith("--") && !args.clawhub) args.clawhub = argv[i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.clawhub) throw new Error("Pass the clawhub checkout with --clawhub <dir> or CLAWHUB_DIR");
  return args;
}

export async function generateVendoredEngine(clawhubDir) {
  const root = resolve(clawhubDir);
  const entry = join(root, ENTRY);
  if (!existsSync(entry)) throw new Error(`Not a clawhub checkout (missing ${ENTRY}): ${root}`);
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const license = readFileSync(join(root, "LICENSE"), "utf8").trim();
  const result = await build({
    absWorkingDir: root,
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    minify: false,
    write: false,
    legalComments: "none",
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  const imports = [...code.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gmu)].map((m) => m[1]);
  const foreign = imports.filter((spec) => !spec.startsWith("node:"));
  if (foreign.length > 0) throw new Error(`Bundle has non-builtin runtime imports: ${foreign.join(", ")}`);
  const header = [
    "// GENERATED FILE - DO NOT EDIT. Regenerate with `node scripts/sync-clawhub-scan.mjs --clawhub <dir>`.",
    `// Source: ${SOURCE_REPO} (${ENTRY.replaceAll("\\", "/")}) at commit ${commit}.`,
    "// Vendored so CI can run ClawHub's static moderation scan against the packed plugin.",
    "//",
    ...license.split(/\r?\n/u).map((line) => (line ? `// ${line}` : "//")),
    "",
    "",
  ].join("\n");
  return header + code;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const generated = await generateVendoredEngine(args.clawhub);
  const rel = relative(repoRoot, vendoredEnginePath);
  if (args.check) {
    const current = existsSync(vendoredEnginePath) ? readFileSync(vendoredEnginePath, "utf8") : "";
    if (current !== generated) {
      console.error(`Vendored ClawHub scanner is stale: ${rel}. Run node scripts/sync-clawhub-scan.mjs --clawhub <dir>.`);
      process.exit(1);
    }
    console.log(`Vendored ClawHub scanner matches (${rel}).`);
    return;
  }
  mkdirSync(dirname(vendoredEnginePath), { recursive: true });
  writeFileSync(vendoredEnginePath, generated);
  console.log(`Wrote ${rel}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
