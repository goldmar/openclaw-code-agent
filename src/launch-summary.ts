import { hasDisplayableReasoning } from "./session-display";
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
  rewindTurns?: number;
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

function formatResolvedWorkdir(input: LaunchSummaryInput): string {
  if (!input.worktreePath) return input.workdir;
  if (!input.originalWorkdir || input.originalWorkdir === input.worktreePath) {
    return `${input.worktreePath} (worktree)`;
  }
  return `${input.worktreePath} (worktree of ${input.originalWorkdir})`;
}

function formatLaunchSummary(input: LaunchSummaryInput): string {
  const model = [input.harness, input.model ?? "default model", ...(hasDisplayableReasoning(input) ? [`reasoning ${input.reasoningEffort}`] : []), ...(input.fastMode ? ["fast"] : [])].join(" | ");
  const plan = input.permissionMode === "plan"
    ? `plan first, approval: ${input.planApproval}`
    : input.permissionMode === "bypassPermissions" ? "no plan gate, no prompts" : "no plan gate";
  const worktree = `worktree: ${input.worktreeStrategy ?? "off"}${input.repoIntegrationPolicy ? ` (repo policy ${input.repoIntegrationPolicy})` : ""}`;
  const lines = [
    `Launched ${input.sessionName} [${input.sessionId}] · ${model}`,
    `Dir: ${formatResolvedWorkdir(input)}`,
    `Mode: ${plan} · ${worktree}`,
  ];
  if (input.resumeSessionId) {
    const resumeLabel = input.resumeSessionName
      ? `${input.resumeSessionName} [${input.resumeSessionId}]`
      : input.resumeSessionId;
    lines.push(`${input.forkSession ? "Forked from" : "Resumed"}: ${resumeLabel}${!input.forkSession && input.resumeSessionName && input.sessionName !== input.resumeSessionName ? ` (now labelled ${input.sessionName})` : ""}`);
  } else if (input.forceNewSession) {
    lines.push("New session forced (a linked session was not resumed).");
  }
  if (input.rewindTurns) {
    lines.push(input.forkSession
      ? `Rewind: forked before the last ${input.rewindTurns} turn(s) (conversation only; files unchanged)`
      : `Rewind: reverted the last ${input.rewindTurns} turn(s) of the thread (conversation only; files unchanged)`);
  }
  lines.push("Send follow-ups with agent_respond. You are notified when it needs you or finishes.");
  return lines.join("\n");
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
