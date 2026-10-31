import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Host integration is optional outside installations that expose ops-digest on PATH. */
export const opsDigestInternals = { execFile };

export function heldWorkDigestKey(owner: string, ref: string): string {
  return createHash("sha256").update(`${owner}:${ref}`).digest("hex");
}

export function enqueueHeldWork(owner: string, ref: string, resolved = false, savedKey?: string, details?: { name: string; branch: string; age: string }): Promise<"queued" | "unavailable" | "held"> {
  const key = savedKey ?? heldWorkDigestKey(owner, ref);
  if (!/^[a-f0-9]{64}$/.test(key) || (!resolved && !details)) return Promise.resolve("held");
  return new Promise((resolve) => {
    const canonical = join(homedir(), ".openclaw", "workspace", "bin", "ops-digest");
    opsDigestInternals.execFile(existsSync(canonical) ? canonical : "ops-digest", ["--producer", "oca-held-work", "--key", key,
      ...(resolved ? ["--resolve"] : ["--weekly", "--summary",
        `⏰ [${details!.name}] Branch \`${details!.branch}\` still waits for your decision (${details!.age} at queue time). Review /agent_status ${details!.name}.`])],
    { timeout: 20_000 }, (err, stdout) => resolve(!err && stdout.trim() === `ops-digest: ${resolved ? "resolved" : "queued"}`
      ? "queued" : (err as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "unavailable" : "held"));
  });
}
