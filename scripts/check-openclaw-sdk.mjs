#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openClawSdkRole, publicSdkTypePaths, sdkRoot, selectOpenClawSdk } from "./lib/openclaw-sdk.mjs";

export function checkOpenClawSdk(args = [], baseDir = sdkRoot) {
  if (args.some((arg) => arg !== "--source-only" && !arg.startsWith("--sdk="))) throw new Error("usage: [--sdk=baseline|dev] [--source-only]");
  const sdk = selectOpenClawSdk(openClawSdkRole(args), baseDir);
  const sourceOnly = args.includes("--source-only");
  const paths = publicSdkTypePaths(sdk, baseDir);
  const directory = mkdtempSync(join(tmpdir(), "oca-sdk-types-"));
  try {
    for (const config of ["tsconfig.typecheck.json", ...(!sourceOnly ? ["tsconfig.tests.json"] : [])]) {
      const target = join(directory, config);
      writeFileSync(target, JSON.stringify({ extends: join(baseDir, config), compilerOptions: {
        paths, typeRoots: [join(baseDir, "node_modules/@types")],
      } }));
      const result = spawnSync("pnpm", ["exec", "tsc", "-p", target, "--noEmit", "--listFiles"], {
        cwd: baseDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stdout.split(/\r?\n/u).filter((line) => !existsSync(line)).join("\n") + result.stderr);
      const files = new Set(result.stdout.split(/\r?\n/u));
      if (!Object.values(paths).some(([declaration]) => files.has(declaration))) {
        throw new Error(`Typecheck did not use the selected ${sdk.role} declarations`);
      }
      // A public SDK self-import must not fall back to the other installed SDK.
      const otherRoot = realpathSync(join(baseDir, "node_modules", sdk.role === "baseline" ? "openclaw" : "openclaw-baseline"));
      if (otherRoot !== sdk.root && [...files].some((file) => file.startsWith(`${otherRoot}/`))) {
        throw new Error(`Typecheck leaked from ${sdk.role} into the other OpenClaw SDK`);
      }
    }
    console.log(`OpenClaw ${sdk.role} SDK ${sdk.version}: public exports and ${sourceOnly ? "source" : "source/test"} types passed`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { checkOpenClawSdk(process.argv.slice(2).filter((arg) => arg !== "--")); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
