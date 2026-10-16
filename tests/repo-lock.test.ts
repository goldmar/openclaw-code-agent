import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withRepoLock } from "../src/git-exec";
import { SessionManager } from "../src/session-manager";

function repoWithSpellings() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-repo-lock-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "init"], { cwd: repo, stdio: "ignore" });
  const worktree = join(root, "linked");
  execFileSync("git", ["worktree", "add", "-b", "agent/linked", worktree], { cwd: repo, stdio: "ignore" });
  const link = join(root, "link");
  symlinkSync(repo, link);
  return { root, spellings: [`${repo}/`, join(repo, "sub"), link, worktree], repo };
}

/** True when `second` (another spelling of the same repository) waited for `first` to finish. */
async function serializes(
  run: (dir: string, fn: () => Promise<void>) => Promise<void>,
  first: string,
  second: string,
): Promise<boolean> {
  const events: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const a = run(first, async () => { events.push("a-start"); await held; events.push("a-end"); });
  const b = run(second, async () => { events.push("b"); });
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await Promise.all([a, b]);
  return events.join(",") === "a-start,a-end,b";
}

describe("repository serialization keys", () => {
  it("serializes git sequences for every spelling of the same repository", async () => {
    const { root, repo, spellings } = repoWithSpellings();
    try {
      for (const spelling of spellings) {
        assert.ok(await serializes((dir, fn) => withRepoLock(dir, fn), repo, spelling), spelling);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("queues merges for every spelling of the same repository", async () => {
    const { root, repo, spellings } = repoWithSpellings();
    const sm = new SessionManager(1, 10, { store: { indexPath: join(root, "sessions.json") } });
    try {
      for (const spelling of spellings) {
        assert.ok(await serializes((dir, fn) => sm.enqueueMerge(dir, fn), repo, spelling), spelling);
      }
      sm.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
