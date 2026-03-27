import type { Session } from "./session";
import type { WorktreeCompletionState } from "./session-worktree-controller";
import type { EmbeddedEvalResult } from "./embedded-eval";
import { getPrimarySessionLookupRef, usesNativeBackendWorktree } from "./session-backend-ref";
import { detectDefaultBranch, getDiffSummary } from "./worktree";

type DiffSummary = NonNullable<ReturnType<typeof getDiffSummary>>;

export type PlannedWorktreeAction =
  | { kind: "skip"; result: { notificationSent: boolean; worktreeRemoved: boolean } }
  | { kind: "notify"; label: string; message: string }
  | {
      kind: "no-change";
      repoDir: string;
      worktreePath: string;
      deliverablePreview?: string;
      nativeBackendWorktree: boolean;
    }
  | {
      kind: "decision";
      strategy: "ask" | "delegate" | "auto-merge" | "auto-pr";
      repoDir: string;
      worktreePath: string;
      branchName: string;
      baseBranch: string;
      diffSummary: DiffSummary;
      sessionRef?: string;
    };

/**
 * Pure worktree-strategy planner.
 * Computes what should happen next; execution/notifications stay outside.
 */
export class SessionWorktreeActionService {
  constructor(
    private readonly deps: {
      shouldRunWorktreeStrategy: (session: Session) => boolean;
      isAlreadyMerged: (ref: string | undefined) => boolean;
      resolveWorktreeRepoDir: (repoDir: string | undefined, worktreePath?: string) => string | undefined;
      getWorktreeCompletionState: (
        repoDir: string,
        worktreePath: string,
        branchName: string,
        baseBranch: string,
      ) => WorktreeCompletionState;
      classifyNoChangeDeliverable: (context: {
        harnessName: string;
        sessionName: string;
        prompt: string;
        workdir: string;
        agentId?: string;
        outputText: string;
      }) => Promise<EmbeddedEvalResult>;
    },
  ) {}

  async plan(session: Session): Promise<PlannedWorktreeAction> {
    const sessionRef = getPrimarySessionLookupRef(session) ?? session.harnessSessionId;
    if (this.deps.isAlreadyMerged(sessionRef)) {
      console.info(`[SessionManager] handleWorktreeStrategy: session "${session.name}" already merged — skipping strategy handling`);
      return { kind: "skip", result: { notificationSent: true, worktreeRemoved: false } };
    }
    if (session.status !== "completed") {
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }
    if (!this.deps.shouldRunWorktreeStrategy(session)) {
      console.info(`[SessionManager] handleWorktreeStrategy: skipping — session "${session.name}" is in phase "${session.phase}"`);
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }

    const strategy = session.worktreeStrategy;
    if (!strategy || strategy === "off" || strategy === "manual") {
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }

    const worktreePath = session.worktreePath!;
    const repoDir = this.deps.resolveWorktreeRepoDir(session.originalWorkdir, worktreePath);
    const branchName = session.worktreeBranch;
    if (!repoDir) {
      return {
        kind: "notify",
        label: "worktree-missing-repo-dir",
        message: `⚠️ [${session.name}] Cannot determine the original repo for worktree ${worktreePath}. Manual inspection is required.`,
      };
    }
    if (!branchName) {
      return {
        kind: "notify",
        label: "worktree-no-branch-name",
        message: `⚠️ [${session.name}] Cannot determine branch name for worktree ${worktreePath}. The worktree may have been removed or is in detached HEAD state. Manual cleanup may be needed.`,
      };
    }

    const baseBranch = session.worktreeBaseBranch ?? detectDefaultBranch(repoDir);
    const completionState = this.deps.getWorktreeCompletionState(repoDir, worktreePath, branchName, baseBranch);

    if (completionState === "no-change") {
      return {
        kind: "no-change",
        repoDir,
        worktreePath,
        deliverablePreview: await this.classifyNoChangeDeliverable(session),
        nativeBackendWorktree: usesNativeBackendWorktree(session),
      };
    }
    if (completionState === "base-advanced") {
      return {
        kind: "notify",
        label: "worktree-no-commits-ahead",
        message: `⚠️ [${session.name}] Auto-merge: branch '${branchName}' has no commits ahead of '${baseBranch}', but '${baseBranch}' has new commits — commits likely landed outside the worktree branch. Verify that commits were not made directly to '${baseBranch}' instead of the worktree branch. Worktree: ${worktreePath}`,
      };
    }
    if (completionState === "dirty-uncommitted") {
      return {
        kind: "notify",
        label: "worktree-dirty-uncommitted",
        message: `⚠️ [${session.name}] Session completed with uncommitted changes. The branch has no commits ahead of '${baseBranch}' but there are modified tracked files in the worktree. Check: ${worktreePath}`,
      };
    }

    const diffSummary = getDiffSummary(repoDir, branchName, baseBranch);
    if (!diffSummary) {
      console.warn(`[SessionManager] Failed to get diff summary for ${branchName}, skipping merge-back`);
      return { kind: "skip", result: { notificationSent: false, worktreeRemoved: false } };
    }

    return {
      kind: "decision",
      strategy,
      repoDir,
      worktreePath,
      branchName,
      baseBranch,
      diffSummary,
      sessionRef: sessionRef ?? undefined,
    };
  }

  private async classifyNoChangeDeliverable(
    session: Pick<Session, "harnessName" | "name" | "prompt" | "originAgentId" | "getOutput"> & {
      workdir?: string;
      originalWorkdir?: string;
    },
  ): Promise<string | undefined> {
    if (typeof session.getOutput !== "function") return undefined;
    const preview = session.getOutput()
      .join("\n")
      .slice(-2_500)
      .trim();
    if (!preview) return undefined;
    const outputText = session.getOutput()
      .join("\n")
      .slice(-5_000)
      .trim();
    if (!outputText) return undefined;
    const workspaceDir = session.workdir ?? session.originalWorkdir;
    if (!workspaceDir) return undefined;

    const result = await this.deps.classifyNoChangeDeliverable({
      harnessName: session.harnessName,
      sessionName: session.name,
      prompt: session.prompt,
      workdir: workspaceDir,
      agentId: session.originAgentId,
      outputText,
    });
    return result.classification === "report_worthy_no_change" ? preview : undefined;
  }
}
