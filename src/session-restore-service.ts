import { prepareSessionBootstrap } from "./session-bootstrap";
import type { Session } from "./session";
import type { PersistedSessionInfo, SessionConfig } from "./types";

export type PreparedSessionLaunch = {
  actualWorkdir: string;
  originalWorkdir: string;
  effectiveSystemPrompt?: string;
  worktreePath?: string;
  worktreeBranchName?: string;
  worktreeParentBranch?: string;
};

export class SessionRestoreService {
  constructor(
    private readonly getPersistedSession: (ref: string) => PersistedSessionInfo | undefined,
  ) {}

  prepareSpawn(config: SessionConfig, name: string): Promise<PreparedSessionLaunch> {
    return prepareSessionBootstrap(config, name, this.getPersistedSession);
  }

  hydrateSpawnedSession(
    session: Pick<Session, "worktreePath" | "originalWorkdir" | "worktreeBranch" | "worktreeParentBranch" | "worktreeState" | "worktreePrTargetRepo" | "worktreePrUrl" | "worktreePrNumber" | "worktreePrBaseBranch" | "worktreePrHeadBranch" | "worktreePushRemote">,
    prepared: PreparedSessionLaunch,
    config: Pick<SessionConfig, "worktreePrTargetRepo" | "worktreeStrategy" | "resumeSessionId" | "resumeWorktreeFrom">,
  ): void {
    if (config.worktreeStrategy && config.worktreeStrategy !== "off") {
      session.originalWorkdir = prepared.originalWorkdir;
    }
    session.worktreeParentBranch = prepared.worktreeParentBranch;
    if (prepared.worktreePath) {
      session.worktreePath = prepared.worktreePath;
      session.worktreeBranch = prepared.worktreeBranchName;
      session.worktreeState = "provisioned";
      const ref = config.resumeWorktreeFrom ?? config.resumeSessionId;
      const previous = ref ? this.getPersistedSession(ref) : undefined;
      if (previous?.worktreePath === prepared.worktreePath && previous.worktreeBranch === prepared.worktreeBranchName) {
        session.worktreePrUrl = previous.worktreePrUrl;
        session.worktreePrNumber = previous.worktreePrNumber;
        session.worktreePrBaseBranch = previous.worktreePrBaseBranch;
        session.worktreePrHeadBranch = previous.worktreePrHeadBranch;
        session.worktreePushRemote = previous.worktreePushRemote;
        session.worktreePrTargetRepo = previous.worktreePrTargetRepo;
      }
    }
    if (config.worktreePrTargetRepo) {
      session.worktreePrTargetRepo = config.worktreePrTargetRepo;
    }
  }
}
