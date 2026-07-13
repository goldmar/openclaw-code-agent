import { existsSync } from "fs";
import { getDefaultHarnessName, pluginConfig } from "./config";
import { pathsReferToSameLocation } from "./path-utils";
import { canonicalizeSessionRoute, isDirectSessionRoute } from "./session-route";
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
  worktreeParentBranch?: string;
  clearedResumeSessionId?: boolean;
  clearedResumeWorktreeFrom?: boolean;
  restoredMissingNativeBackendWorktree?: boolean;
  failedResumeWorktreeRestore?: boolean;
};

function originChannelFromRoute(route: NonNullable<SessionConfig["route"]>): string | undefined {
  if (!route.provider || !route.target) return undefined;
  return route.accountId
    ? `${route.provider}|${route.accountId}|${route.target}`
    : `${route.provider}|${route.target}`;
}

function hasDirectLaunchRoute(config: SessionConfig): boolean {
  return isDirectSessionRoute(canonicalizeSessionRoute({
    route: config.route,
    originChannel: config.originChannel,
    originThreadId: config.originThreadId,
    originSessionKey: config.originSessionKey,
  }));
}

export function preserveResumeRoutingContext(
  config: SessionConfig,
  getPersistedSession: (ref: string) => PersistedSessionInfo | undefined,
): void {
  if (hasDirectLaunchRoute(config)) return;

  const resumeRefs = [config.resumeSessionId, config.resumeWorktreeFrom]
    .filter((ref): ref is string => Boolean(ref?.trim()));
  for (const ref of resumeRefs) {
    const persisted = getPersistedSession(ref);
    if (!persisted) continue;
    const route = canonicalizeSessionRoute({
      route: persisted.route,
      originChannel: persisted.originChannel,
      originThreadId: persisted.originThreadId,
      originSessionKey: persisted.originSessionKey,
    });
    if (!isDirectSessionRoute(route)) continue;

    config.route = { ...route };
    config.originChannel = persisted.originChannel ?? originChannelFromRoute(route);
    config.originThreadId = persisted.originThreadId ?? route.threadId;
    config.originSessionKey = persisted.originSessionKey ?? route.sessionKey;
    config.originAgentId ??= persisted.originAgentId;
    return;
  }
}

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
    `Before finishing, run \`git status --short\` in this worktree.`,
    `If you made actual task changes, commit all of them to this branch before finishing.`,
    `Use \`git add\` and \`git commit\`. If no repository changes are needed, leave the worktree clean before finishing.`,
    `Do NOT run \`git checkout\`, \`git switch\`, or \`git reset --hard\` as these will detach or corrupt the worktree HEAD.`,
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
  worktreeParentBranch?: string;
  clearedResumeSessionId?: boolean;
  clearedResumeWorktreeFrom?: boolean;
  restoredMissingNativeBackendWorktree?: boolean;
  canCreateManagedWorktreeForResumeWithoutPersistedPath?: boolean;
  failedResumeWorktreeRestore?: boolean;
} {
  const resumeWorktreeId = config.resumeWorktreeFrom ?? config.resumeSessionId;
  if (!resumeWorktreeId) return {};

  const persistedSession = getPersistedSession(resumeWorktreeId);
  if (!persistedSession) return {};
  const hasPersistedBackendIdentity = !!persistedSession.harness || !!persistedSession.backendRef;
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

  if (!config.worktreeStrategy) {
    if (persistedSession.worktreeLifecycle?.state === "pr_open" || persistedSession.worktreePrUrl) {
      config.worktreeStrategy = "auto-pr";
    } else if (persistedSession.worktreeStrategy) {
      config.worktreeStrategy = persistedSession.worktreeStrategy;
    }
  }
  if (!config.planApproval && persistedSession.planApproval) {
    config.planApproval = persistedSession.planApproval;
  }

  if (!persistedSession.worktreePath) {
    const canCreateManagedWorktreeForResumeWithoutPersistedPath =
      hasPersistedBackendIdentity
      && supportsNativeBackendWorktreeRestore(getBackendWorktreeCapability({
        persistedHarness: persistedSession.harness,
        backendRef: persistedSession.backendRef,
      }));
    return {
      originalWorkdir,
      canCreateManagedWorktreeForResumeWithoutPersistedPath,
    };
  }
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
      worktreeParentBranch: persistedSession.worktreeParentBranch,
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
      worktreeParentBranch: persistedSession.worktreeParentBranch,
      clearedResumeWorktreeFrom: !!config.resumeWorktreeFrom,
      restoredMissingNativeBackendWorktree: true,
    };
  }

  try {
    pruneWorktrees(originalWorkdir);
    const recreatedPath = createWorktree(
      originalWorkdir,
      persistedSession.worktreeBranch.replace(/^agent\//, ""),
      { allowExistingBranch: true },
    );
    console.info(`[SessionManager] Recreated worktree from branch ${persistedSession.worktreeBranch}: ${recreatedPath}`);
    return {
      actualWorkdir: recreatedPath,
      originalWorkdir,
      worktreePath: recreatedPath,
      worktreeBranchName: persistedSession.worktreeBranch,
      worktreeParentBranch: persistedSession.worktreeParentBranch,
    };
  } catch (err) {
    console.warn(`[SessionManager] Failed to recreate worktree for resume: ${errorMessage(err)}, using original workdir`);
    return {
      actualWorkdir: originalWorkdir,
      originalWorkdir,
      clearedResumeSessionId: !!config.resumeSessionId,
      clearedResumeWorktreeFrom: !!config.resumeWorktreeFrom,
      failedResumeWorktreeRestore: true,
    };
  }
}

export function prepareSessionBootstrap(
  config: SessionConfig,
  name: string,
  getPersistedSession: (ref: string) => PersistedSessionInfo | undefined,
): Preparation {
  preserveResumeRoutingContext(config, getPersistedSession);

  let {
    actualWorkdir,
    originalWorkdir,
    worktreePath,
    worktreeBranchName,
    worktreeParentBranch,
    clearedResumeSessionId,
    clearedResumeWorktreeFrom,
    restoredMissingNativeBackendWorktree,
    canCreateManagedWorktreeForResumeWithoutPersistedPath,
    failedResumeWorktreeRestore,
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
  if (!isResumedSession && strategy && strategy !== "off" && isGitRepo(originalWorkdir)) {
    worktreeParentBranch ??= getBranchName(originalWorkdir);
  }
  const useNativeCodexWorktree = prefersNativeCodexWorktrees(config);
  const canCreateWorktreeForThisLaunch = !isResumedSession || !!canCreateManagedWorktreeForResumeWithoutPersistedPath;
  const shouldWorktree = canCreateWorktreeForThisLaunch
    && !restoredMissingNativeBackendWorktree
    && !worktreePath
    && strategy
    && strategy !== "off"
    && !useNativeCodexWorktree;

  if (failedResumeWorktreeRestore && strategy && strategy !== "off") {
    throw new Error(
      `Cannot launch session "${name}": worktree strategy "${strategy}" was requested, but no isolated worktree was prepared. ` +
      `Launch with worktree_strategy "off" only when running in the base checkout is intentional.`,
    );
  }

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

  if (strategy && strategy !== "off" && !worktreePath) {
    throw new Error(
      `Cannot launch session "${name}": worktree strategy "${strategy}" was requested, but no isolated worktree was prepared. ` +
      `Launch with worktree_strategy "off" only when running in the base checkout is intentional.`,
    );
  }

  return {
    actualWorkdir,
    originalWorkdir,
    effectiveSystemPrompt: worktreePath && worktreeBranchName
      ? appendWorktreeSystemPrompt(config.systemPrompt, originalWorkdir, worktreePath, worktreeBranchName)
      : config.systemPrompt,
    worktreePath,
    worktreeBranchName,
    worktreeParentBranch,
    clearedResumeSessionId,
    clearedResumeWorktreeFrom,
    restoredMissingNativeBackendWorktree,
    failedResumeWorktreeRestore,
  };
}
