interface ActiveResumeSessionInfo {
  harnessSessionId?: string;
}

interface PersistedResumeSessionInfo {
  harness?: string;
  backendRef?: {
    kind?: string;
  };
}

interface ResumeSessionDecision {
  resumeSessionId?: string;
  clearedPersistedCodexResume: boolean;
}

interface ResumeSessionDecisionOptions {
  requestedResumeSessionId?: string;
  activeSession?: ActiveResumeSessionInfo;
  persistedSession?: PersistedResumeSessionInfo;
}

/**
 * Historical Codex SDK thread IDs are not compatible with the App Server
 * backend and must never be resumed. App Server-backed Codex sessions are
 * resumable like any other persisted backend conversation.
 */
export function decideResumeSessionId(
  options: ResumeSessionDecisionOptions,
): ResumeSessionDecision {
  const { requestedResumeSessionId, activeSession, persistedSession } = options;

  if (!requestedResumeSessionId) {
    return { resumeSessionId: undefined, clearedPersistedCodexResume: false };
  }

  if (activeSession) {
    return {
      resumeSessionId: requestedResumeSessionId,
      clearedPersistedCodexResume: false,
    };
  }

  if (
    persistedSession?.harness === "codex"
    && persistedSession.backendRef?.kind !== "codex-app-server"
  ) {
    return {
      resumeSessionId: undefined,
      clearedPersistedCodexResume: true,
    };
  }

  return {
    resumeSessionId: requestedResumeSessionId,
    clearedPersistedCodexResume: false,
  };
}
