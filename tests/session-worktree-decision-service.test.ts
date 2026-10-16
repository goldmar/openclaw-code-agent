import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionWorktreeDecisionService } from "../src/session-worktree-decision-service";
import type { PersistedSessionInfo } from "../src/types";

describe("SessionWorktreeDecisionService.dismissWorktree", () => {
  for (const merged of [
    { worktreeMerged: true },
    { worktreeLifecycle: { state: "merged", updatedAt: "2026-01-01T00:00:00.000Z" } },
    { worktreeLifecycle: { state: "released", updatedAt: "2026-01-01T00:00:00.000Z" } },
  ] as Partial<PersistedSessionInfo>[]) {
    it(`never deletes the recorded worktree of a merged session (${JSON.stringify(merged)})`, async () => {
      // The recorded path now holds a newer session's worktree.
      const worktreePath = mkdtempSync(join(tmpdir(), "openclaw-dismiss-merged-"));
      const patches: Partial<PersistedSessionInfo>[] = [];
      try {
        const row = { sessionId: "old", name: "foo", workdir: worktreePath, worktreePath, worktreeBranch: "agent/foo", ...merged } as PersistedSessionInfo;
        // Only these dependencies are reached before the merged check returns.
        const service = new SessionWorktreeDecisionService({
          getPersistedSession: () => row,
          resolveActiveSession: (): undefined => undefined,
          resolveWorktreeRepoDir: () => worktreePath,
          updatePersistedSession: (_ref: string, patch: Partial<PersistedSessionInfo>) => { patches.push(patch); return true; },
        } as unknown as ConstructorParameters<typeof SessionWorktreeDecisionService>[0]);

        const reply = await service.dismissWorktree("old");

        assert.match(reply, /already resolved \(merged\)/);
        assert.ok(existsSync(worktreePath));
        assert.deepEqual(patches, []);
      } finally {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    });
  }
});
