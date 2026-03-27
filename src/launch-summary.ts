import type {
  CodexApprovalPolicy,
  PlanApprovalMode,
  PermissionMode,
  ReasoningEffort,
  WorktreeStrategy,
} from "./types";

export interface LaunchSummaryInput {
  sessionId: string;
  sessionName: string;
  prompt: string;
  workdir: string;
  harness: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  permissionMode: PermissionMode;
  planApproval: PlanApprovalMode;
  worktreeStrategy?: WorktreeStrategy;
  worktreePath?: string;
  originalWorkdir?: string;
  codexApprovalPolicy?: CodexApprovalPolicy;
  resumeSessionId?: string;
  forkSession?: boolean;
  forceNewSession?: boolean;
  clearedPersistedCodexResume?: boolean;
}

export interface LaunchSummarySessionLike {
  id: string;
  name: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  worktreeStrategy?: WorktreeStrategy;
  worktreePath?: string;
  originalWorkdir?: string;
  codexApprovalPolicy?: CodexApprovalPolicy;
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
    `  Resolved workdir: ${formatResolvedWorkdir(input)}`,
    `  Model: ${input.model ?? "default"}`,
    `  Prompt: "${summarizePrompt(input.prompt)}"`,
  ];

  if (input.reasoningEffort) {
    details.push(`  Reasoning effort: ${input.reasoningEffort}`);
  }
  if (input.codexApprovalPolicy) {
    details.push(`  Codex approval policy: ${input.codexApprovalPolicy}`);
  }
  if (input.resumeSessionId) {
    details.push(`  Resume: ${input.resumeSessionId}${input.forkSession ? " (forked)" : ""}`);
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
  input: Omit<LaunchSummaryInput, "sessionId" | "sessionName" | "model" | "reasoningEffort" | "worktreeStrategy" | "worktreePath" | "originalWorkdir" | "codexApprovalPolicy">,
  session: LaunchSummarySessionLike,
): string {
  return formatLaunchSummary({
    ...input,
    sessionId: session.id,
    sessionName: session.name,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    worktreeStrategy: session.worktreeStrategy ?? "off",
    worktreePath: session.worktreePath,
    originalWorkdir: session.originalWorkdir,
    codexApprovalPolicy: session.codexApprovalPolicy,
  });
}
