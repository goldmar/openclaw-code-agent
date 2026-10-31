import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Host integration is optional outside installations that expose ops-digest on PATH. */
export const opsDigestInternals = { execFile };

export function enqueueHeldWork(owner: string, ref: string, resolved = false): Promise<"queued" | "unavailable" | "held"> {
  const key = createHash("sha256").update(`${owner}:${ref}`).digest("hex");
  return new Promise((resolve) => {
    const canonical = join(homedir(), ".openclaw", "workspace", "bin", "ops-digest");
    opsDigestInternals.execFile(existsSync(canonical) ? canonical : "ops-digest", ["--producer", "oca-held-work", "--key", key,
      ...(resolved ? ["--resolve"] : ["--weekly", "--summary",
        `Code Agent work remains held for its owner (${key.slice(0, 12)}). Review /agent_status; no ownership or approval has changed.`])],
    { timeout: 20_000 }, (err, stdout) => resolve(!err && stdout.trim() === `ops-digest: ${resolved ? "resolved" : "queued"}`
      ? "queued" : (err as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "unavailable" : "held"));
  });
}
