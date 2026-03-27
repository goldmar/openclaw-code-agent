import type { Session } from "./session";
import type { SessionConfig, SessionStatus } from "./types";

type SpawnOptions = {
  notifyLaunch?: boolean;
};

type PreparedLaunch = ReturnType<import("./session-restore-service").SessionRestoreService["prepareSpawn"]>;

/**
 * Owns runtime session hydration, listener wiring, startup, and launch notification.
 */
export class SessionRuntimeBootstrapService {
  constructor(
    private readonly deps: {
      hydrateSpawnedSession: (session: Session, preparedLaunch: PreparedLaunch, config: SessionConfig) => void;
      markRunning: (session: Session) => void;
      handleTerminal: (session: Session) => Promise<void>;
      handleTurnEnd: (session: Session, hadQuestion: boolean) => void;
      formatLaunchWorkdirLabel: (session: Pick<Session, "workdir" | "worktreePath" | "originalWorkdir">) => string;
      notifySession: (session: Session, text: string, label?: string) => void;
    },
  ) {}

  initializeSession(
    session: Session,
    preparedLaunch: PreparedLaunch,
    config: SessionConfig,
    options: SpawnOptions = {},
  ): Session {
    this.deps.hydrateSpawnedSession(session, preparedLaunch, config);

    session.on("statusChange", (_session: Session, newStatus: SessionStatus) => {
      if (newStatus === "running" && session.harnessSessionId) {
        this.deps.markRunning(session);
      } else if (newStatus === "completed" || newStatus === "failed" || newStatus === "killed") {
        void this.deps.handleTerminal(session).catch((err) => {
          console.error(`[SessionRuntimeBootstrap] handleTerminal threw for session ${session.id}:`, err);
        });
      }
    });

    session.on("turnEnd", (_session: Session, hadQuestion: boolean) => {
      this.deps.handleTurnEnd(session, hadQuestion);
    });

    session.start();

    if (options.notifyLaunch !== false) {
      const workdirLabel = this.deps.formatLaunchWorkdirLabel(session);
      const launchText = `🚀 [${session.name}] Launched | ${workdirLabel} | ${session.model ?? "default"}`;
      this.deps.notifySession(session, launchText, "launch");
    }

    return session;
  }
}
