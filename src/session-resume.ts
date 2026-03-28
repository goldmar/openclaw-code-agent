import { decideResumeSessionId } from "./resume-policy";
import { getBackendConversationId } from "./session-backend-ref";
import type { Session } from "./session";
import type { PersistedSessionInfo } from "./types";

export type ResumableSessionLike = Session | PersistedSessionInfo;

export type ResumeUnavailableReason =
  | "already_running"
  | "completed"
  | "legacy_non_resumable"
  | "missing_backend_state";

export type ResumeAssessment =
  | {
      kind: "direct";
      reason: "already_running";
    }
  | {
      kind: "resume";
      resumeSessionId: string;
      stableSessionId?: string;
      clearedPersistedCodexResume: boolean;
    }
  | {
      kind: "relaunch";
      stableSessionId?: string;
    }
  | {
      kind: "unavailable";
      reason: ResumeUnavailableReason;
      stableSessionId?: string;
      clearedPersistedCodexResume?: boolean;
    };

export function getStableSessionId(session: ResumableSessionLike): string | undefined {
  return "id" in session ? session.id : session.sessionId;
}

export function isCompletedByDefault(session: ResumableSessionLike): boolean {
  return session.status === "completed" || session.killReason === "done";
}

export function isNeverStartedRelaunch(session: ResumableSessionLike): boolean {
  return (session.killReason === "shutdown" || session.killReason === "startup-timeout")
    && !getBackendConversationId(session);
}

export function assessResumeCandidate(session: ResumableSessionLike): ResumeAssessment {
  if (session.status === "running") {
    return { kind: "direct", reason: "already_running" };
  }

  const stableSessionId = getStableSessionId(session);
  if (isCompletedByDefault(session)) {
    return { kind: "unavailable", reason: "completed", stableSessionId };
  }

  const backendConversationId = getBackendConversationId(session);
  if (backendConversationId) {
    const persistedSession = "harnessName" in session ? undefined : session;
    const { resumeSessionId, clearedPersistedCodexResume } = decideResumeSessionId({
      requestedResumeSessionId: backendConversationId,
      activeSession: "harnessName" in session
        ? { harnessSessionId: backendConversationId }
        : undefined,
      persistedSession: persistedSession
        ? { harness: persistedSession.harness, backendRef: persistedSession.backendRef }
        : undefined,
    });

    if (resumeSessionId) {
      return {
        kind: "resume",
        resumeSessionId,
        stableSessionId,
        clearedPersistedCodexResume,
      };
    }

    return {
      kind: "unavailable",
      reason: "legacy_non_resumable",
      stableSessionId,
      clearedPersistedCodexResume,
    };
  }

  if (isNeverStartedRelaunch(session)) {
    return {
      kind: "relaunch",
      stableSessionId,
    };
  }

  return {
    kind: "unavailable",
    reason: "missing_backend_state",
    stableSessionId,
  };
}
