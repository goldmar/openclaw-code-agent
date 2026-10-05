import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { buildMinimalChildEnv } from "./child-env";
import { runGit, type CommandError } from "./git-exec";
import type { GoalRepositoryIdentity } from "./types";

const IDENTITY_ERROR = "Cannot verify the goal's repository identity. Restore its original repository or start a new goal; no default policy is selected on an identity error.";

async function identity(kind: GoalRepositoryIdentity["kind"], path: string): Promise<GoalRepositoryIdentity> {
  const canonical = await realpath(path);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new Error(IDENTITY_ERROR);
  return { kind, path: canonical, device: info.dev.toString(), inode: info.ino.toString() };
}

export async function resolveGoalRepositoryIdentity(workdir: string): Promise<GoalRepositoryIdentity> {
  try {
    const directory = await identity("directory", workdir);
    let output: string;
    try {
      output = await runGit(["rev-parse", "--is-inside-work-tree", "--path-format=absolute", "--git-common-dir"], {
        cwd: directory.path, timeout: 1_000,
        env: buildMinimalChildEnv(process.env, { LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" }),
      });
    } catch (error) {
      const failure = error as CommandError;
      if (failure.code !== 128 || !/^fatal: not a git repository(?: \(or any of the parent directories\))?:/m.test(failure.stderr ?? "")) {
        throw new Error(IDENTITY_ERROR);
      }
      // A broken/unreadable/nested .git marker must never become the default.
      for (let ancestor = directory.path; ; ancestor = dirname(ancestor)) {
        try { await lstat(join(ancestor, ".git")); throw new Error(IDENTITY_ERROR); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(IDENTITY_ERROR); }
        if (dirname(ancestor) === ancestor) break;
      }
      return directory;
    }
    const lines = output.trimEnd().split("\n");
    if (lines.length !== 2 || lines[0] !== "true" || !isAbsolute(lines[1]!)) throw new Error(IDENTITY_ERROR);
    return await identity("git", lines[1]!);
  } catch {
    throw new Error(IDENTITY_ERROR);
  }
}

export function sameGoalRepositoryIdentity(left: GoalRepositoryIdentity, right: GoalRepositoryIdentity): boolean {
  return left.kind === right.kind && left.path === right.path && left.device === right.device && left.inode === right.inode;
}
