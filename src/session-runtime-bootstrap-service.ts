import type { Session } from "./session";
import { formatHarnessModelLabel } from "./session-display";
import { formatResumedLaunchMessage } from "./launch-summary";
import type { SessionConfig, SessionLifecycle, SessionStatus } from "./types";
import { createLogger } from "./logger";

const log = createLogger("session-runtime-bootstrap-service");

type SpawnOptions = {
  notifyLaunch?: boolean;
  startAfter?: Promise<void>;
};

type PreparedLaunch = Awaited<ReturnType<import("./session-restore-service").SessionRestoreService["prepareSpawn"]>>;
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
      formatLaunchWorkdirLabel: (session: Pick<Session, "workdir" | "worktreePath" | "originalWorkdir">) => string | Promise<string>;
      notifySession: (session: Session, text: string, label?: string, idempotencyKey?: string) => void;
      /** Stop a session whose host TaskFlow was cancelled. */
      cancelSession?: (session: Session) => void;
    },
  ) {}

  async initializeSession(
    session: Session,
    preparedLaunch: PreparedLaunch,
    config: SessionConfig,
    options: SpawnOptions = {},
  ): Promise<Session> {
    this.deps.hydrateSpawnedSession(session, preparedLaunch, config);
    this.observeMirror(config.taskLifecycle?.create(session, {
      onCancelRequested: () => this.deps.cancelSession?.(session),
    }), session);

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
      void options.startAfter.then(() => {
        // Shutdown may terminate a queued resume while its previous writer drains.
        if (session.status === "starting") return session.start();
      }).catch((err) => {
        log.error(`[SessionRuntimeBootstrap] deferred start threw for session ${session.id}:`, err);
      });
    } else {
      void session.start();
    }

    if (options.notifyLaunch !== false) {
      const notification = await this.buildLaunchNotification(session);
      // Building the label awaits git; a session stopped meanwhile (for example by
      // shutdown) must not announce its launch after its stop notice.
      if (session.status !== "killed" && session.status !== "failed" && session.status !== "completed") {
        this.deps.notifySession(session, notification.text, notification.label, notification.idempotencyKey);
      }
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
    log.warn(`[SessionRuntimeBootstrap] task mirror failed for session ${session.id}:`, err);
  }

  private track(operation: Promise<void>, session: Session, action: string): void {
    const pending = operation.catch((err) => {
      log.error(`[SessionRuntimeBootstrap] ${action} threw for session ${session.id}:`, err);
    }).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }

  private async buildLaunchNotification(session: LaunchNotificationSession): Promise<{
    text: string;
    label: string;
    idempotencyKey?: string;
  }> {
    const workdirLabel = await this.deps.formatLaunchWorkdirLabel(session);
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
