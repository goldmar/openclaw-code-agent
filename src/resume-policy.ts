interface ActiveResumeSessionInfo {
  harnessSessionId?: string;
}

interface PersistedResumeSessionInfo {
  harness?: string;
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
 * Codex thread state is tied to the auth/org context that created it.
 * Historical persisted thread IDs can fail after a gateway restart if the
 * underlying SDK auth context changed, so only live in-memory Codex sessions
 * are allowed to reuse their prior thread id.
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

  if (persistedSession?.harness === "codex") {
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
