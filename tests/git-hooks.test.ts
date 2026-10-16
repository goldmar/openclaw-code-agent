import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { isHookPath, listHookPathChanges } from "../src/git-hooks";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

const LEFTHOOK_CONFIGS = ["lefthook", "lefthook-local"].flatMap((name) =>
  ["yml", "yaml", "toml", "json", "jsonc"].flatMap((extension) => [
    `${name}.${extension}`,
    `.${name}.${extension}`,
    `.config/${name}.${extension}`,
  ]),
);

describe("isHookPath", () => {
  it("covers pre-commit, lefthook and husky configuration", () => {
    for (const path of [
      ".pre-commit-config.yaml",
      ".pre-commit-config.yml",
      ...LEFTHOOK_CONFIGS,
      ".lefthook/pre-commit/check.sh",
      ".lefthook-local/pre-push/run.sh",
      ".husky/pre-commit",
      ".husky/_/husky.sh",
      ".githooks/pre-push",
      ".openclaw/worktree-setup.sh",
      ".worktreeinclude",
    ]) {
      assert.equal(isHookPath(path), true, path);
    }
    assert.equal(LEFTHOOK_CONFIGS.length, 30);
  });

  it("matches exact repository-root paths and directory prefixes only", () => {
    for (const path of [
      "docs/lefthook.yml",
      "packages/app/.pre-commit-config.yaml",
      "x.pre-commit-config.yaml",
      ".pre-commit-config.yaml.bak",
      ".pre-commit-hooks.yaml",
      "lefthook.yml.example",
      "lefthook.ini",
      ".config/lefthook.yml.orig",
      "src/.husky/pre-commit",
      ".husky",
      ".huskyrc",
      ".lefthook",
      ".lefthookrc",
      "README.md",
    ]) {
      assert.equal(isHookPath(path), false, path);
    }
  });

  it("adds the in-repository core.hooksPath directory", () => {
    assert.equal(isHookPath("tools/hooks/pre-commit"), false);
    assert.equal(isHookPath("tools/hooks/pre-commit", ["tools/hooks/"]), true);
  });
});

describe("listHookPathChanges", () => {
  it("lists added, changed and renamed hook configuration files of the branch, with both paths of a rename", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "oca-git-hooks-"));
    const write = (path: string, text: string): void => {
      mkdirSync(dirname(join(repoDir, path)), { recursive: true });
      writeFileSync(join(repoDir, path), text, "utf-8");
    };
    try {
      git(repoDir, "init", "-b", "main");
      git(repoDir, "config", "user.name", "Test User");
      git(repoDir, "config", "user.email", "test@example.com");
      write("README.md", "base\n");
      write(".pre-commit-config.yaml", "repos: []\n");
      write("lefthook.yml", "pre-commit: {}\n");
      write("docs/lefthook.yml", "example\n");
      git(repoDir, "add", "-A");
      git(repoDir, "commit", "-m", "init");
      git(repoDir, "checkout", "-b", "feature");
      write(".pre-commit-config.yaml", "repos:\n  - repo: local\n");
      mkdirSync(join(repoDir, ".config"));
      git(repoDir, "mv", "lefthook.yml", ".config/lefthook.yml");
      write(".lefthook-local.toml", "[pre-push]\n");
      write(".husky/pre-commit", "echo hook\n");
      write("docs/lefthook.yml", "changed example\n");
      write("src/app.ts", "export {};\n");
      git(repoDir, "add", "-A");
      git(repoDir, "commit", "-m", "change hooks");

      assert.deepEqual(await listHookPathChanges(repoDir, "feature", "main"), [
        ".config/lefthook.yml",
        ".husky/pre-commit",
        ".lefthook-local.toml",
        ".pre-commit-config.yaml",
        "lefthook.yml",
      ]);

      git(repoDir, "checkout", "-b", "plain", "main");
      write("src/app.ts", "export {};\n");
      write("docs/lefthook.yml", "changed example\n");
      git(repoDir, "add", "-A");
      git(repoDir, "commit", "-m", "no hooks");
      assert.deepEqual(await listHookPathChanges(repoDir, "plain", "main"), []);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
