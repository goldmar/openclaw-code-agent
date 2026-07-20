import type { Session } from "./session";
import type { SessionConfig, SessionLifecycle, SessionStatus } from "./types";

type SpawnOptions = {
  notifyLaunch?: boolean;
};

type PreparedLaunch = ReturnType<import("./session-restore-service").SessionRestoreService["prepareSpawn"]>;
type LaunchNotificationSession = Pick<
  Session,
  "id" | "name" | "workdir" | "worktreePath" | "originalWorkdir" | "harnessName" | "model" | "startedAt" | "resumeSessionId" | "resumedFromSessionName"
>;

/**
 * Owns runtime session hydration, listener wiring, startup, and launch notification.
 */
export class SessionRuntimeBootstrapService {
  constructor(
    private readonly deps: {
      hydrateSpawnedSession: (session: Session, preparedLaunch: PreparedLaunch, config: SessionConfig) => void;
      markRunning: (session: Session) => void;
      handleTerminal: (session: Session) => Promise<void>;
      handleTurnEnd: (session: Session, hadQuestion: boolean) => Promise<void>;
      formatLaunchWorkdirLabel: (session: Pick<Session, "workdir" | "worktreePath" | "originalWorkdir">) => string;
      notifySession: (session: Session, text: string, label?: string, idempotencyKey?: string) => void;
    },
  ) {}

  initializeSession(
    session: Session,
    preparedLaunch: PreparedLaunch,
    config: SessionConfig,
    options: SpawnOptions = {},
  ): Session {
    this.deps.hydrateSpawnedSession(session, preparedLaunch, config);
    config.taskLifecycle?.create(session);

    session.on("statusChange", (_session: Session, newStatus: SessionStatus) => {
      if (newStatus === "running") {
        if (session.harnessSessionId) {
          this.deps.markRunning(session);
        }
        config.taskLifecycle?.progress(session);
      } else if (newStatus === "completed" || newStatus === "failed" || newStatus === "killed") {
        config.taskLifecycle?.finalize(session);
        void this.deps.handleTerminal(session).catch((err) => {
          console.error(`[SessionRuntimeBootstrap] handleTerminal threw for session ${session.id}:`, err);
        });
      }
    });

    session.on("lifecycleChange", (_session: Session, _next: SessionLifecycle) => {
      config.taskLifecycle?.progress(session);
    });

    session.on("turnEnd", (_session: Session, hadQuestion: boolean) => {
      void this.deps.handleTurnEnd(session, hadQuestion).catch((err) => {
        console.error(`[SessionRuntimeBootstrap] handleTurnEnd threw for session ${session.id}:`, err);
      });
    });

    session.start();

    // A resume is already acknowledged by the foreground command/tool response.
    // Pushing another lifecycle message creates duplicate Telegram chatter.
    if (options.notifyLaunch !== false && !session.resumeSessionId) {
      const notification = this.buildLaunchNotification(session);
      this.deps.notifySession(session, notification.text, notification.label, notification.idempotencyKey);
    }

    return session;
  }

  private buildLaunchNotification(session: LaunchNotificationSession): {
    text: string;
    label: string;
    idempotencyKey?: string;
  } {
    return {
      text: `🚀 [${session.name}] Started`,
      label: "launch",
    };
  }
}
