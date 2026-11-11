import { afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskOutcomeSession } from "../src/session-task-outcome";
import { reviewedTaskFixture } from "./task-outcome-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Explicit positive setup for reminder timing/delivery tests. Keep legacy and
 * blocked rows unmodified so those tests exercise missing-evidence refusal. */
export function reviewPendingReminder<T extends TaskOutcomeSession & { worktreeBranch?: string }>(row: T): T {
  const originalRepo = row.workdir && existsSync(join(row.workdir, ".git")) ? row.workdir : undefined;
  const root = mkdtempSync(join(tmpdir(), "oca-reviewed-reminder-"));
  roots.push(root);
  const repo = originalRepo ?? join(root, "repo");
  const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  if (!originalRepo) {
    mkdirSync(repo);
    run(repo, "init", "-b", "main");
    run(repo, "-c", "user.name=Fixture User", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "base");
  }
  const branch = row.worktreeBranch ?? "agent/reviewed-reminder";
  const worktree = row.worktreePath ?? join(root, "task");
  if (!existsSync(worktree)) {
    try { run(repo, "show-ref", "--verify", `refs/heads/${branch}`); }
    catch { run(repo, "branch", branch, "main"); }
    run(repo, "worktree", "add", worktree, branch);
  }
  writeFileSync(join(worktree, "reviewed-reminder.txt"), "Completed task with reviewed verification receipts.\n");
  run(worktree, "add", "reviewed-reminder.txt");
  run(worktree, "-c", "user.name=Fixture User", "-c", "user.email=fixture@example.com", "commit", "-m", "completed reminder fixture task");
  Object.assign(row, { workdir: repo, worktreePath: worktree, worktreeBranch: branch, worktreeBaseBranch: "main" });
  reviewedTaskFixture(row);
  return row;
}
