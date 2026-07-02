#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const proofScript = path.join(scriptDir, "oca-codex-telegram-proof.ts");
const forwardedArgs = process.argv.slice(2);
const separatorIndex = forwardedArgs.indexOf("--");
if (separatorIndex >= 0) forwardedArgs.splice(separatorIndex, 1);
const proofArgs = forwardedArgs.map((arg) => arg === "--env-file" ? "--convex-env-file" : arg);
const result = spawnSync(process.execPath, ["--import", "tsx", proofScript, "run", ...proofArgs], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
