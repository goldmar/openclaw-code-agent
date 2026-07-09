import type {
  PlanApprovalMode,
  PermissionMode,
  ReasoningEffort,
  WorktreeStrategy,
  RepoIntegrationPolicy,
  RepoProviderKind,
} from "./types";

export interface LaunchSummaryInput {
  sessionId: string;
  sessionName: string;
  prompt: string;
  workdir: string;
  harness: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
  permissionMode: PermissionMode;
  planApproval: PlanApprovalMode;
  worktreeStrategy?: WorktreeStrategy;
  repoIntegrationPolicy?: RepoIntegrationPolicy;
  repoProvider?: RepoProviderKind;
  worktreePath?: string;
  originalWorkdir?: string;
  resumeSessionId?: string;
  resumeSessionName?: string;
  forkSession?: boolean;
  forceNewSession?: boolean;
  clearedPersistedCodexResume?: boolean;
}

export interface LaunchSummarySessionLike {
  id: string;
  name: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  fastMode?: boolean;
  worktreeStrategy?: WorktreeStrategy;
  repoIntegrationPolicy?: RepoIntegrationPolicy;
  repoProvider?: RepoProviderKind;
  worktreePath?: string;
  originalWorkdir?: string;
  resumedFromSessionName?: string;
}

function summarizePrompt(prompt: string): string {
  return prompt.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;
}

function formatResolvedWorkdir(input: LaunchSummaryInput): string {
  if (!input.worktreePath) return input.workdir;
  if (!input.originalWorkdir || input.originalWorkdir === input.worktreePath) {
    return `${input.worktreePath} (worktree)`;
  }
  return `${input.worktreePath} (worktree of ${input.originalWorkdir})`;
}

export function formatLaunchSummary(input: LaunchSummaryInput): string {
  const details = [
    "Session launched successfully.",
    `  Name: ${input.sessionName}`,
    `  ID: ${input.sessionId}`,
    `  Harness: ${input.harness}`,
    `  Permission mode: ${input.permissionMode}`,
    `  Plan approval: ${input.planApproval}`,
    `  Worktree strategy: ${input.worktreeStrategy ?? "off"}`,
    ...(input.repoIntegrationPolicy ? [`  Repo policy: ${input.repoIntegrationPolicy}${input.repoProvider ? ` (${input.repoProvider})` : ""}`] : []),
    `  Resolved workdir: ${formatResolvedWorkdir(input)}`,
    `  Model: ${input.model ?? "default"}`,
    `  Prompt: "${summarizePrompt(input.prompt)}"`,
  ];

  if (input.reasoningEffort) {
    details.push(`  Reasoning effort: ${input.reasoningEffort}`);
  }
  if (input.fastMode) {
    details.push("  Fast mode: enabled");
  }
  if (input.resumeSessionId) {
    const resumeLabel = input.resumeSessionName
      ? `${input.resumeSessionName} [${input.resumeSessionId}]`
      : input.resumeSessionId;
    details.push(`  Resume: ${resumeLabel}${input.forkSession ? " (forked)" : ""}`);
    if (!input.forkSession && input.resumeSessionName && input.sessionName !== input.resumeSessionName) {
      details.push(`  Follow-up label: ${input.sessionName}`);
    }
  } else if (input.forceNewSession) {
    details.push("  Force new session: true");
  }
  if (input.clearedPersistedCodexResume) {
    details.push("  Thread state: historical Codex state cleared; starting a fresh thread.");
  }
  details.push("  Mode: multi-turn (use agent_respond to send follow-up messages)");
  details.push("", "Use agent_sessions to check status, agent_output to see output.");
  return details.join("\n");
}

export function formatLaunchSummaryFromSession(
  input: Omit<LaunchSummaryInput, "sessionId" | "sessionName" | "model" | "reasoningEffort" | "fastMode" | "worktreeStrategy" | "repoIntegrationPolicy" | "repoProvider" | "worktreePath" | "originalWorkdir">,
  session: LaunchSummarySessionLike,
): string {
  return formatLaunchSummary({
    ...input,
    sessionId: session.id,
    sessionName: session.name,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    fastMode: session.fastMode,
    worktreeStrategy: session.worktreeStrategy ?? "off",
    repoIntegrationPolicy: session.repoIntegrationPolicy,
    repoProvider: session.repoProvider,
    worktreePath: session.worktreePath,
    originalWorkdir: session.originalWorkdir,
    resumeSessionName: session.resumedFromSessionName ?? input.resumeSessionName,
  });
}

export function formatResumedLaunchMessage(input: {
  sessionName: string;
  resumedFromSessionName?: string;
  workdirLabel: string;
  harnessLabel: string;
}): string {
  const identity = input.resumedFromSessionName || input.sessionName;
  const labelSuffix = input.resumedFromSessionName && input.sessionName !== input.resumedFromSessionName
    ? ` | Follow-up label: ${input.sessionName}`
    : "";
  return `▶️ [${identity}] Resumed${labelSuffix} | ${input.workdirLabel} | ${input.harnessLabel}`;
}
