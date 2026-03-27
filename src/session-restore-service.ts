import { prepareSessionBootstrap } from "./session-bootstrap";
import type { Session } from "./session";
import type { PersistedSessionInfo, SessionConfig } from "./types";

export type PreparedSessionLaunch = {
  actualWorkdir: string;
  originalWorkdir: string;
  effectiveSystemPrompt?: string;
  worktreePath?: string;
  worktreeBranchName?: string;
};

export class SessionRestoreService {
  constructor(
    private readonly getPersistedSession: (ref: string) => PersistedSessionInfo | undefined,
  ) {}

  prepareSpawn(config: SessionConfig, name: string): PreparedSessionLaunch {
    return prepareSessionBootstrap(config, name, this.getPersistedSession);
  }

  hydrateSpawnedSession(
    session: Pick<Session, "worktreePath" | "originalWorkdir" | "worktreeBranch" | "worktreeState" | "worktreePrTargetRepo">,
    prepared: PreparedSessionLaunch,
    config: Pick<SessionConfig, "worktreePrTargetRepo">,
  ): void {
    if (prepared.worktreePath) {
      session.worktreePath = prepared.worktreePath;
      session.originalWorkdir = prepared.originalWorkdir;
      session.worktreeBranch = prepared.worktreeBranchName;
      session.worktreeState = "provisioned";
    }
    if (config.worktreePrTargetRepo) {
      session.worktreePrTargetRepo = config.worktreePrTargetRepo;
    }
  }
}
