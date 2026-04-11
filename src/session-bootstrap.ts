import { existsSync } from "fs";
import { getDefaultHarnessName, pluginConfig } from "./config";
import { pathsReferToSameLocation } from "./path-utils";
import {
  getBackendWorktreeCapability,
  supportsNativeBackendWorktreeExecution,
  supportsNativeBackendWorktreeRestore,
} from "./session-backend-ref";
import type { PersistedSessionInfo, SessionConfig } from "./types";
import {
  createWorktree,
  getBranchName,
  hasEnoughWorktreeSpace,
  getPrimaryRepoRootFromWorktree,
  isGitRepo,
  pruneWorktrees,
} from "./worktree";

type Preparation = {
  actualWorkdir: string;
  originalWorkdir: string;
  effectiveSystemPrompt?: string;
  worktreePath?: string;
  worktreeBranchName?: string;
  clearedResumeSessionId?: boolean;
  clearedResumeWorktreeFrom?: boolean;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function prefersNativeCodexWorktrees(config: SessionConfig): boolean {
  const strategy = config.worktreeStrategy ?? pluginConfig.defaultWorktreeStrategy;
  return !!strategy
    && strategy !== "off"
    && supportsNativeBackendWorktreeExecution(getBackendWorktreeCapability({
      harnessName: config.harness ?? getDefaultHarnessName(),
      backendRef: config.backendRef,
    }));
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
): {
  actualWorkdir?: string;
  originalWorkdir?: string;
  worktreePath?: string;
  worktreeBranchName?: string;
  clearedResumeSessionId?: boolean;
  clearedResumeWorktreeFrom?: boolean;
} {
  const resumeWorktreeId = config.resumeSessionId ?? config.resumeWorktreeFrom;
  if (!resumeWorktreeId) return {};

  const persistedSession = getPersistedSession(resumeWorktreeId);
  if (!persistedSession) return {};
  const originalWorkdir = (() => {
    if (persistedSession.workdir && persistedSession.workdir !== persistedSession.worktreePath) {
      return persistedSession.workdir;
    }
    if (persistedSession.worktreePath) {
      const recoveredRepoRoot = getPrimaryRepoRootFromWorktree(persistedSession.worktreePath);
      if (
        persistedSession.workdir
        && recoveredRepoRoot
        && pathsReferToSameLocation(persistedSession.workdir, recoveredRepoRoot)
      ) {
        return persistedSession.workdir;
      }
      return recoveredRepoRoot ?? persistedSession.workdir;
    }
    return persistedSession.workdir;
  })();

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

  const usesNativeCodexWorktree =
    supportsNativeBackendWorktreeRestore(getBackendWorktreeCapability({
      persistedHarness: persistedSession.harness,
      backendRef: persistedSession.backendRef,
    }))
    && !!persistedSession.backendRef?.worktreePath;

  if (existsSync(persistedSession.worktreePath)) {
    console.info(`[SessionManager] Resuming with existing worktree: ${persistedSession.worktreePath}`);
    return {
      actualWorkdir: persistedSession.worktreePath,
      originalWorkdir: originalWorkdir ?? persistedSession.worktreePath,
      worktreePath: persistedSession.worktreePath,
      worktreeBranchName: persistedSession.worktreeBranch,
    };
  }

  if (!originalWorkdir) {
    console.warn(`[SessionManager] Worktree ${persistedSession.worktreePath} no longer exists and cannot be recreated, using original workdir`);
    return {
      clearedResumeSessionId: !!config.resumeSessionId,
      clearedResumeWorktreeFrom: !!config.resumeWorktreeFrom,
    };
  }

  if (usesNativeCodexWorktree) {
    console.info(
      `[SessionManager] Native Codex worktree ${persistedSession.worktreePath} is missing; resuming from original workdir and letting the backend restore thread state.`,
    );
    return {
      actualWorkdir: originalWorkdir,
      originalWorkdir,
      worktreeBranchName: persistedSession.worktreeBranch,
      clearedResumeWorktreeFrom: !!config.resumeWorktreeFrom,
    };
  }

  try {
    pruneWorktrees(originalWorkdir);
    const recreatedPath = createWorktree(
      originalWorkdir,
      persistedSession.worktreeBranch.replace(/^agent\//, ""),
    );
    console.info(`[SessionManager] Recreated worktree from branch ${persistedSession.worktreeBranch}: ${recreatedPath}`);
    return {
      actualWorkdir: recreatedPath,
      originalWorkdir,
      worktreePath: recreatedPath,
      worktreeBranchName: persistedSession.worktreeBranch,
    };
  } catch (err) {
    console.warn(`[SessionManager] Failed to recreate worktree for resume: ${errorMessage(err)}, using original workdir`);
    return {
      actualWorkdir: originalWorkdir,
      originalWorkdir,
      clearedResumeSessionId: !!config.resumeSessionId,
      clearedResumeWorktreeFrom: !!config.resumeWorktreeFrom,
    };
  }
}

export function prepareSessionBootstrap(
  config: SessionConfig,
  name: string,
  getPersistedSession: (ref: string) => PersistedSessionInfo | undefined,
): Preparation {
  let {
    actualWorkdir,
    originalWorkdir,
    worktreePath,
    worktreeBranchName,
    clearedResumeSessionId,
    clearedResumeWorktreeFrom,
  } = restoreResumeWorktreeContext(config, getPersistedSession);

  if (clearedResumeSessionId) {
    config.resumeSessionId = undefined;
  }
  if (clearedResumeWorktreeFrom) {
    config.resumeWorktreeFrom = undefined;
  }

  actualWorkdir ??= config.workdir;
  originalWorkdir ??= config.workdir;
  const isResumedSession = !!(config.resumeSessionId ?? config.resumeWorktreeFrom);
  const strategy = config.worktreeStrategy ?? pluginConfig.defaultWorktreeStrategy;
  if (strategy) config.worktreeStrategy = strategy;
  const useNativeCodexWorktree = prefersNativeCodexWorktrees(config);
  const shouldWorktree = !config.resumeSessionId && !worktreePath && strategy && strategy !== "off" && !useNativeCodexWorktree;

  if (useNativeCodexWorktree && !isGitRepo(originalWorkdir)) {
    throw new Error(`Cannot launch session "${name}": worktree strategy "${strategy}" requires a git worktree, but "${originalWorkdir}" is not a git repository.`);
  }

  if (shouldWorktree && isGitRepo(originalWorkdir)) {
    if (!hasEnoughWorktreeSpace(originalWorkdir)) {
      throw new Error(`Cannot launch session "${name}": insufficient space for worktree creation.`);
    }
    try {
      worktreePath = createWorktree(originalWorkdir, name);
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
    throw new Error(`Cannot launch session "${name}": worktree strategy "${strategy}" requires a git worktree, but "${originalWorkdir}" is not a git repository.`);
  }

  if (isResumedSession && worktreePath) {
    actualWorkdir = worktreePath;
  }

  return {
    actualWorkdir,
    originalWorkdir,
    effectiveSystemPrompt: worktreePath && worktreeBranchName
      ? appendWorktreeSystemPrompt(config.systemPrompt, originalWorkdir, worktreePath, worktreeBranchName)
      : config.systemPrompt,
    worktreePath,
    worktreeBranchName,
    clearedResumeSessionId,
    clearedResumeWorktreeFrom,
  };
}
