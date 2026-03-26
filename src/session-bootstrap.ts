import { existsSync } from "fs";
import { pluginConfig } from "./config";
import type { PersistedSessionInfo, SessionConfig } from "./types";
import {
  createWorktree,
  getBranchName,
  hasEnoughWorktreeSpace,
  isGitRepo,
  pruneWorktrees,
} from "./worktree";

type Preparation = {
  actualWorkdir: string;
  effectiveSystemPrompt?: string;
  worktreePath?: string;
  worktreeBranchName?: string;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function appendWorktreeSystemPrompt(
  systemPrompt: string | undefined,
  originalWorkdir: string,
  worktreePath: string,
  worktreeBranchName: string,
): string {
  const worktreeSuffix = [
    ``,
    `You are working in a git worktree.`,
    `Worktree path: ${worktreePath}`,
    `Branch: ${worktreeBranchName}`,
    ``,
    `IMPORTANT: ALL file edits must be made within this worktree at ${worktreePath}.`,
    `Do NOT edit files directly in ${originalWorkdir} (the original workspace).`,
    `If your task references files by absolute path under ${originalWorkdir}, rewrite those`,
    `paths relative to your current working directory. For example:`,
    `  "${originalWorkdir}/src/file.py"  →  use relative path "src/file.py"`,
    ``,
    `Commit all your file changes to this branch before finishing.`,
    `Use \`git add\` and \`git commit\`. Do NOT run \`git checkout\`, \`git switch\`, or \`git reset --hard\` as these will detach or corrupt the worktree HEAD.`,
    ``,
    `When making changes, please note:`,
    `- Do NOT commit planning documents, investigation notes, or analysis artifacts to this branch`,
    `- Only commit actual code, configuration, tests, and documentation changes that were explicitly requested as part of the task`,
  ].join("\n");
  return (systemPrompt ?? "") + worktreeSuffix;
}

function restoreResumeWorktreeContext(
  config: SessionConfig,
  getPersistedSession: (ref: string) => PersistedSessionInfo | undefined,
): { worktreePath?: string; worktreeBranchName?: string } {
  const resumeWorktreeId = config.resumeSessionId ?? config.resumeWorktreeFrom;
  if (!resumeWorktreeId) return {};

  const persistedSession = getPersistedSession(resumeWorktreeId);
  if (!persistedSession) return {};

  if (!config.worktreeStrategy && persistedSession.worktreeStrategy) {
    config.worktreeStrategy = persistedSession.worktreeStrategy;
  }
  if (!config.planApproval && persistedSession.planApproval) {
    config.planApproval = persistedSession.planApproval;
  }

  if (!persistedSession.worktreePath) return {};
  if (!persistedSession.worktreeBranch) {
    throw new Error(`Cannot resume session "${resumeWorktreeId}": persisted worktree metadata is missing worktreeBranch.`);
  }

  if (existsSync(persistedSession.worktreePath)) {
    console.info(`[SessionManager] Resuming with existing worktree: ${persistedSession.worktreePath}`);
    config.workdir = persistedSession.worktreePath;
    return {
      worktreePath: persistedSession.worktreePath,
      worktreeBranchName: persistedSession.worktreeBranch,
    };
  }

  if (!persistedSession.workdir) {
    console.warn(`[SessionManager] Worktree ${persistedSession.worktreePath} no longer exists and cannot be recreated, using original workdir`);
    return {};
  }

  try {
    pruneWorktrees(persistedSession.workdir);
    const recreatedPath = createWorktree(
      persistedSession.workdir,
      persistedSession.worktreeBranch.replace(/^agent\//, ""),
    );
    console.info(`[SessionManager] Recreated worktree from branch ${persistedSession.worktreeBranch}: ${recreatedPath}`);
    config.workdir = recreatedPath;
    return {
      worktreePath: recreatedPath,
      worktreeBranchName: persistedSession.worktreeBranch,
    };
  } catch (err) {
    console.warn(`[SessionManager] Failed to recreate worktree for resume: ${errorMessage(err)}, using original workdir`);
    config.workdir = persistedSession.workdir;
    return {};
  }
}

export function prepareSessionBootstrap(
  config: SessionConfig,
  name: string,
  getPersistedSession: (ref: string) => PersistedSessionInfo | undefined,
): Preparation {
  let { worktreePath, worktreeBranchName } = restoreResumeWorktreeContext(config, getPersistedSession);

  let actualWorkdir = config.workdir;
  const isResumedSession = !!(config.resumeSessionId ?? config.resumeWorktreeFrom);
  const strategy = config.worktreeStrategy ?? pluginConfig.defaultWorktreeStrategy;
  if (strategy) config.worktreeStrategy = strategy;
  const shouldWorktree = !config.resumeSessionId && !worktreePath && strategy && strategy !== "off";

  if (shouldWorktree && isGitRepo(config.workdir)) {
    if (!hasEnoughWorktreeSpace()) {
      throw new Error(`Cannot launch session "${name}": insufficient space for worktree creation.`);
    }
    try {
      worktreePath = createWorktree(config.workdir, name);
      actualWorkdir = worktreePath;
      worktreeBranchName = getBranchName(worktreePath);
      if (!worktreeBranchName) {
        throw new Error(`created worktree at ${worktreePath} but failed to resolve branch name`);
      }
      console.log(`[SessionManager] Created worktree at ${worktreePath}`);
    } catch (err) {
      throw new Error(`Cannot launch session "${name}": worktree creation failed: ${errorMessage(err)}`);
    }
  } else if (shouldWorktree) {
    throw new Error(`Cannot launch session "${name}": worktree strategy "${strategy}" requires a git worktree, but "${config.workdir}" is not a git repository.`);
  }

  if (isResumedSession && worktreePath) {
    actualWorkdir = worktreePath;
  }

  return {
    actualWorkdir,
    effectiveSystemPrompt: worktreePath && worktreeBranchName
      ? appendWorktreeSystemPrompt(config.systemPrompt, config.workdir, worktreePath, worktreeBranchName)
      : config.systemPrompt,
    worktreePath,
    worktreeBranchName,
  };
}
