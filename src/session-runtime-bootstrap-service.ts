import type { Session } from "./session";
import { formatHarnessModelLabel } from "./session-display";
import { formatResumedLaunchMessage } from "./launch-summary";
import type { SessionConfig, SessionLifecycle, SessionStatus } from "./types";

type SpawnOptions = {
  notifyLaunch?: boolean;
  startAfter?: Promise<void>;
};

type PreparedLaunch = ReturnType<import("./session-restore-service").SessionRestoreService["prepareSpawn"]>;
type LaunchNotificationSession = Pick<
  Session,
  "id" | "name" | "workdir" | "worktreePath" | "originalWorkdir" | "harnessName" | "model" | "reasoningEffort" | "startedAt" | "resumeSessionId" | "resumedFromSessionName"
>;

/**
 * Owns runtime session hydration, listener wiring, startup, and launch notification.
 */
export class SessionRuntimeBootstrapService {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly deps: {
      hydrateSpawnedSession: (session: Session, preparedLaunch: PreparedLaunch, config: SessionConfig) => void;
      markRunning: (session: Session) => void;
      syncTaskMirror: (session: Session) => void;
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
    this.observeMirror(config.taskLifecycle?.create(session), session);

    session.on("statusChange", (_session: Session, newStatus: SessionStatus) => {
      if (newStatus === "running") {
        if (session.harnessSessionId) {
          this.deps.markRunning(session);
        }
        this.observeMirror(config.taskLifecycle?.progress(session), session);
      } else if (newStatus === "completed" || newStatus === "failed" || newStatus === "killed") {
        const finalized = config.taskLifecycle?.finalize(session);
        const terminal = finalized
          ? finalized.catch((err) => this.warnMirror(session, err)).then(() => this.deps.handleTerminal(session))
          : this.deps.handleTerminal(session);
        this.track(terminal, session, "handleTerminal");
      }
    });

    session.on("lifecycleChange", (_session: Session, _next: SessionLifecycle) => {
      this.observeMirror(config.taskLifecycle?.progress(session), session);
    });

    session.on("turnEnd", (_session: Session, hadQuestion: boolean) => {
      this.track(this.deps.handleTurnEnd(session, hadQuestion), session, "handleTurnEnd");
    });

    if (options.startAfter) {
      void options.startAfter.then(() => session.start()).catch((err) => {
        console.error(`[SessionRuntimeBootstrap] deferred start threw for session ${session.id}:`, err);
      });
    } else {
      void session.start();
    }

    if (options.notifyLaunch !== false) {
      const notification = this.buildLaunchNotification(session);
      this.deps.notifySession(session, notification.text, notification.label, notification.idempotencyKey);
    }

    return session;
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  private observeMirror(completion: void | Promise<void>, session: Session): void {
    if (completion) {
      this.track(completion.then(() => this.deps.syncTaskMirror(session)), session, "task mirror");
    }
  }

  private warnMirror(session: Session, err: unknown): void {
    console.warn(`[SessionRuntimeBootstrap] task mirror failed for session ${session.id}:`, err);
  }

  private track(operation: Promise<void>, session: Session, action: string): void {
    const pending = operation.catch((err) => {
      console.error(`[SessionRuntimeBootstrap] ${action} threw for session ${session.id}:`, err);
    }).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }

  private buildLaunchNotification(session: LaunchNotificationSession): {
    text: string;
    label: string;
    idempotencyKey?: string;
  } {
    const workdirLabel = this.deps.formatLaunchWorkdirLabel(session);
    const harnessLabel = formatHarnessModelLabel({
      harness: session.harnessName,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
    }) ?? "default";
    if (session.resumeSessionId) {
      return {
        text: formatResumedLaunchMessage({
          sessionName: session.name,
          resumedFromSessionName: session.resumedFromSessionName,
          workdirLabel,
          harnessLabel,
        }),
        label: "resumed-launch",
        idempotencyKey: `resumed-launch:${session.id}:${session.startedAt}:${session.resumeSessionId}`,
      };
    }
    return {
      text: `🚀 [${session.name}] Launched | ${workdirLabel} | ${harnessLabel}`,
      label: "launch",
    };
  }
}
