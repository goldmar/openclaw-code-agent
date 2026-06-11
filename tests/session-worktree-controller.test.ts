import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionWorktreeController } from "../src/session-worktree-controller";

function installFakeGit(t: import("node:test").TestContext, scriptLines: string[]): string {
  const tempDir = mkdtempSync(join(tmpdir(), "session-worktree-controller-git-"));
  const binDir = join(tempDir, "bin");
  mkdirSync(binDir);
  const gitPath = join(binDir, "git");
  writeFileSync(gitPath, [
    "#!/bin/sh",
    "set -eu",
    ...scriptLines.map((line) => line.replaceAll("__TEMP_DIR__", tempDir)),
    "exit 1",
    "",
  ].join("\n"));
  chmodSync(gitPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  t.after(() => {
    process.env.PATH = originalPath;
    rmSync(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

describe("SessionWorktreeController.getCompletionState()", () => {
  it("keeps the worktree pending when a missing branch makes ahead detection fail", (t) => {
    const worktreePath = installFakeGit(t, [
      "if [ \"$3\" = \"rev-list\" ]; then",
      "  exit 1",
      "fi",
      "if [ \"$3\" = \"status\" ]; then",
      "  exit 0",
      "fi",
    ]);

    const controller = new SessionWorktreeController();

    assert.equal(
      controller.getCompletionState("/repo", worktreePath, "missing-branch", "main"),
      "has-commits",
    );
  });

  it("keeps the worktree pending when reverse topology detection fails", (t) => {
    const worktreePath = installFakeGit(t, [
      "count_file=\"__TEMP_DIR__/rev-list-count\"",
      "if [ \"$3\" = \"rev-list\" ]; then",
      "  count=0",
      "  if [ -f \"$count_file\" ]; then",
      "    count=$(cat \"$count_file\")",
      "  fi",
      "  count=$((count + 1))",
      "  printf '%s' \"$count\" > \"$count_file\"",
      "  if [ \"$count\" -eq 1 ]; then",
      "    echo 0",
      "    exit 0",
      "  fi",
      "  exit 1",
      "fi",
      "if [ \"$3\" = \"status\" ]; then",
      "  exit 0",
      "fi",
    ]);

    const controller = new SessionWorktreeController();

    assert.equal(
      controller.getCompletionState("/repo", worktreePath, "feature", "main"),
      "has-commits",
    );
  });

});
