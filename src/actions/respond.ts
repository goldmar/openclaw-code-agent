import type { SessionManager } from "../session-manager";
import { pluginConfig } from "../config";
import { truncateText } from "../format";
import type { Session } from "../session";
import { getBackendConversationId, getPrimarySessionLookupRef } from "../session-backend-ref";
import {
  assessResumeCandidate,
  getStableSessionId,
  isCompletedByDefault,
  type ResumeUnavailableReason,
  type ResumableSessionLike,
} from "../session-resume";
import type { PersistedSessionInfo, SessionConfig } from "../types";

interface RespondParams {
  session: string;
  message: string;
  interrupt?: boolean;
  userInitiated?: boolean;
  approve?: boolean;
}

interface RespondResult {
  text: string;
  isError?: boolean;
}

const DEFAULT_MAX_AUTO_RESPONDS = 10;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ResumableSession = ResumableSessionLike;

type PlanApprovalTarget = Pick<
  ResumableSession,
  | "approvalState"
  | "pendingPlanApproval"
  | "currentPermissionMode"
  | "requestedPermissionMode"
  | "name"
  | "planDecisionVersion"
  | "actionablePlanDecisionVersion"
>;

function getSessionRef(session: ResumableSession): string {
  return getPrimarySessionLookupRef(session) ?? session.harnessSessionId ?? "unknown-session";
}

function canAutoResumeStoppedPlanDecision(session: ResumableSession): boolean {
  return session.status !== "running"
    && !!session.pendingPlanApproval
    && !!getBackendConversationId(session);
}

/**
 * Returns true when a session was killed by a shutdown signal before the
 * harness ever initialised — i.e. it has no harness session ID to resume.
 */
function isNeverStartedShutdown(session: ResumableSession): boolean {
  return session.killReason === "shutdown" && !getBackendConversationId(session);
}

function formatResumeUnavailable(
  session: ResumableSession,
  reason: ResumeUnavailableReason,
  details?: string,
): RespondResult {
  const guidance = reason === "completed"
    ? `This session is closed by default. Launch a fresh session, or fork from prior context with agent_launch(resume_session_id='${getSessionRef(session)}', fork_session=true, prompt='<new task>').`
    : reason === "legacy_non_resumable"
      ? `Persisted historical backend state is intentionally non-resumable here. Launch fresh, or fork with agent_launch(resume_session_id='${getSessionRef(session)}', fork_session=true, prompt='<new task>').`
      : reason === "missing_backend_state"
        ? `No resumable backend state is available. Launch a fresh session, or fork from prior context with agent_launch(resume_session_id='${getSessionRef(session)}', fork_session=true, prompt='<new task>').`
        : `Use agent_respond(session='${getSessionRef(session)}', message='<next instruction>') to continue the running session.`;
  const detailLine = details ? ` ${details}` : "";
  return {
    text: `Resume unavailable for session ${session.name} [${getSessionRef(session)}] (${reason}).${detailLine} ${guidance}`,
    isError: true,
  };
}

async function spawnFreshRelaunch(
  sm: SessionManager,
  session: ResumableSession,
  _message: string,
): Promise<RespondResult> {
  try {
    const freshConfig: SessionConfig = {
      prompt: session.prompt,
      sessionIdOverride: getStableSessionId(session),
      workdir: session.workdir,
      name: session.name,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      worktreeStrategy: session.worktreeStrategy,
      multiTurn: true,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originAgentId: session.originAgentId,
      originSessionKey: session.originSessionKey,
      route: session.route,
      permissionMode: session.currentPermissionMode,
      requestedPermissionMode: session.requestedPermissionMode ?? session.currentPermissionMode,
      planApproval: session.planApproval,
      codexApprovalPolicy: session.codexApprovalPolicy,
      harness: "harnessName" in session ? session.harnessName : session.harness,
    };
    const relaunched = await sm.spawnAndAwaitRunning(freshConfig, { notifyLaunch: false });
    sm.notifySession(relaunched, `▶️ [${relaunched.name}] Relaunched fresh`);
    return {
      text: `Session ${session.name} was relaunched fresh — it was killed during startup before the harness initialized. New session: ${relaunched.name} [${relaunched.id}].`,
    };
  } catch (err: unknown) {
    return { text: `Error relaunching session ${session.name} [${getSessionRef(session)}]: ${errorMessage(err)}`, isError: true };
  }
}

const PLAN_APPROVAL_SYSTEM_PREFIX =
  "[SYSTEM: The user has approved your plan. Exit plan mode immediately and implement the changes with full permissions. Do not ask for further confirmation.]\n\n";

function approvalBlockedReason(session: PlanApprovalTarget): string | undefined {
  if (session.approvalState === "changes_requested" && !hasLatestActionablePlan(session)) {
    return `Plan changes were already requested for session ${session.name}. Wait for the revised plan before approving.`;
  }
  if (session.approvalState === "rejected") {
    return `Plan for session ${session.name} was already rejected.`;
  }
  return undefined;
}

function hasLatestActionablePlan(session: Pick<PlanApprovalTarget, "approvalState" | "pendingPlanApproval" | "planDecisionVersion" | "actionablePlanDecisionVersion">): boolean {
  if (!session.pendingPlanApproval) return false;
  const version = session.approvalState === "changes_requested"
    ? session.actionablePlanDecisionVersion
    : (session.actionablePlanDecisionVersion ?? session.planDecisionVersion);
  return version > 0;
}

function canAutoResumePlanApproval(session: PlanApprovalTarget): boolean {
  if (approvalBlockedReason(session)) return false;
  return hasLatestActionablePlan(session) || session.currentPermissionMode === "plan";
}

async function tryAutoResume(
  sm: SessionManager,
  session: ResumableSession,
  message: string,
  options: { approve?: boolean } = {},
): Promise<RespondResult | undefined> {
  const assessment = assessResumeCandidate(session);
  const resumable = assessment.kind === "resume" || canAutoResumeStoppedPlanDecision(session);
  if (!resumable) return undefined;

  // When approve=true is sent to a dead plan-mode session, forward the approval
  // into the resumed session by switching its permission mode to bypassPermissions
  // and prepending the system approval prefix. Without this, the resume would
  // inherit permissionMode="plan", the first turn-end would re-set
  // pendingPlanApproval=true, and Alice would be asked to approve a second time.
  const isPlanApproval = !!(options.approve && canAutoResumePlanApproval(session));

  try {
    if (assessment.kind !== "resume") {
      return assessment.kind === "relaunch"
        ? spawnFreshRelaunch(sm, session, message)
        : formatResumeUnavailable(session, assessment.reason);
    }

    // Preserve all relevant runtime/session-routing knobs so auto-resume is a
    // continuation of the exact same lifecycle, not a best-effort relaunch.
    const resumeConfig: SessionConfig = {
      // Inject the approval prefix so Claude knows it's approved and switches
      // out of plan mode without re-presenting the plan.
      prompt: isPlanApproval ? PLAN_APPROVAL_SYSTEM_PREFIX + message : message,
      sessionIdOverride: assessment.stableSessionId,
      workdir: session.workdir,
      name: session.name,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      resumeSessionId: assessment.resumeSessionId,
      multiTurn: true,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originAgentId: session.originAgentId,
      originSessionKey: session.originSessionKey,
      route: session.route,
      // For a plan approval, start the resumed session in bypassPermissions so
      // the harness launches without plan-mode constraints and the turn-end
      // fallback (currentPermissionMode === "plan") cannot re-fire.
      permissionMode: isPlanApproval ? "bypassPermissions" : session.currentPermissionMode,
      requestedPermissionMode: session.requestedPermissionMode ?? session.currentPermissionMode,
      planApproval: session.planApproval,
      codexApprovalPolicy: session.codexApprovalPolicy,
      pendingPlanApproval: isPlanApproval ? false : session.pendingPlanApproval,
      planApprovalContext: session.planApprovalContext,
      planDecisionVersion: session.planDecisionVersion,
      actionablePlanDecisionVersion: isPlanApproval ? undefined : session.actionablePlanDecisionVersion,
      canonicalPlanPromptVersion: session.canonicalPlanPromptVersion,
      approvalPromptRequiredVersion: session.approvalPromptRequiredVersion,
      approvalPromptVersion: session.approvalPromptVersion,
      approvalPromptStatus: session.approvalPromptStatus,
      approvalPromptTransport: session.approvalPromptTransport,
      approvalPromptMessageKind: session.approvalPromptMessageKind,
      approvalPromptLastAttemptAt: session.approvalPromptLastAttemptAt,
      approvalPromptDeliveredAt: session.approvalPromptDeliveredAt,
      approvalPromptFailedAt: session.approvalPromptFailedAt,
      ...(isPlanApproval
        ? {
            approvalState: "approved" as const,
            approvalExecutionState: "approved_then_implemented" as const,
            planModeApproved: true,
          }
        : {}),
      harness: "harnessName" in session ? session.harnessName : session.harness,
    };
    const resumed = await sm.spawnAndAwaitRunning(resumeConfig, { notifyLaunch: false });
    if (isPlanApproval) {
      sm.notifySession(resumed, `👍 [${resumed.name}] Plan approved (resumed)`, "plan-approved");
      return {
        text: `Plan approved for session ${resumed.name} [${resumed.id}]. Session resumed in bypassPermissions mode. Use agent_output to see the response.`,
      };
    } else {
      sm.notifySession(resumed, `▶️ [${resumed.name}] Auto-resumed`);
    }
    return { text: `Auto-resumed session ${resumed.name} [${resumed.id}]. Use agent_output to see the response.` };
  } catch (err: unknown) {
    return formatResumeUnavailable(session, "missing_backend_state", `Backend resume failed: ${errorMessage(err)}`);
  }
}


/**
 * Shared respond logic used by both tool and command.
 * Handles: auto-resume, permission mode switch, auto-respond cap, interrupt.
 */
export async function executeRespond(
  sm: SessionManager,
  params: RespondParams,
): Promise<RespondResult> {
  const session = sm.resolve(params.session);
  const persisted = session ? undefined : sm.getPersistedSession(params.session);

  if (!session && !persisted) {
    return { text: `Error: Session "${params.session}" not found.`, isError: true };
  }

  const target = session ?? persisted!;
  const resumeAssessment = target.status === "running" ? { kind: "direct" as const } : assessResumeCandidate(target);

  if (params.approve) {
    const blockedReason = approvalBlockedReason(target);
    if (blockedReason) {
      return { text: blockedReason, isError: true };
    }
  }

  if (resumeAssessment.kind === "resume" || canAutoResumeStoppedPlanDecision(target)) {
    const autoResumeResult = await tryAutoResume(sm, target, params.message, { approve: params.approve });
    if (autoResumeResult) {
      return autoResumeResult;
    }
  } else {
    if (resumeAssessment.kind === "relaunch") {
      return spawnFreshRelaunch(sm, target, params.message);
    }
    if (resumeAssessment.kind === "unavailable") {
      return formatResumeUnavailable(target, resumeAssessment.reason);
    }
  }

  if (!session) {
    return isCompletedByDefault(persisted!)
      ? formatResumeUnavailable(persisted!, "completed")
      : {
          text: `Error: Session ${persisted!.name} [${getSessionRef(persisted!)}] is not running (status: ${persisted!.status}). Cannot send a message to a non-running session.`,
          isError: true,
        };
  }

  if (session.status !== "running") {
    return isCompletedByDefault(session)
      ? formatResumeUnavailable(session, "completed")
      : {
          text: `Error: Session ${session.name} [${session.id}] is not running (status: ${session.status}). Cannot send a message to a non-running session.`,
          isError: true,
        };
  }

  // Auto-respond safety cap
  const maxAutoResponds = pluginConfig.maxAutoResponds ?? DEFAULT_MAX_AUTO_RESPONDS;
  if (params.userInitiated) {
    session.resetAutoRespond();
  } else if (session.autoRespondCount >= maxAutoResponds) {
    return {
      text: `⚠️ Auto-respond limit reached (${session.autoRespondCount}/${maxAutoResponds}). Ask the user to provide the answer for session ${session.name}. Then call agent_respond with their answer and set userInitiated: true to reset the counter.`,
    };
  }


  try {
    if (params.approve) {
      const blockedReason = approvalBlockedReason(session);
      if (blockedReason) {
        return { text: blockedReason, isError: true };
      }
    }

    const submittedPendingText =
      !params.approve
      && session.pendingInputState?.allowsFreeText
      && (await session.submitPendingInputText?.(params.message)) === true;

    if (submittedPendingText) {
      if (params.userInitiated) {
        const notifyPreview = truncateText(params.message, 100);
        sm.notifySession(session, `↪️ [${session.name}] "${notifyPreview}"`, "agent-respond");
      }
      if (!params.userInitiated) {
        session.incrementAutoRespond();
      }
      const msgSummary = truncateText(params.message, 80);
      return {
        text: [
          `Pending input answered for session ${session.name} [${session.id}].`,
          `  Message: "${msgSummary}"`,
          `Use agent_output to see the response.`,
        ].join("\n"),
      };
    }

    let redirectedActiveTurn = false;
    if (params.interrupt) {
      redirectedActiveTurn = await session.interrupt();
    }

    // Permission escalation — explicit approve flag
    const isPlanApproval = !!(params.approve && hasLatestActionablePlan(session));
    let approvalWarning = "";
    if (params.approve && hasLatestActionablePlan(session)) {
      session.switchPermissionMode("bypassPermissions");
    } else if (params.approve && session.currentPermissionMode === "default") {
      // Non-plan mode escalation — switch to bypassPermissions
      session.switchPermissionMode("bypassPermissions");
    } else if (params.approve && session.currentPermissionMode === "bypassPermissions") {
      // Already at maximum permissions — no-op, just inform
      approvalWarning = `\nℹ️ approve=true was set but session is already in bypassPermissions mode.`;
    } else if (params.approve) {
      approvalWarning = `\n⚠️ approve=true was set but session has no pending plan approval.`;
    } else if (session.pendingPlanApproval || session.approvalState === "changes_requested") {
      approvalWarning = `\nℹ️ Session has a pending plan — sending as revision feedback. The agent will revise and re-submit. Set approve=true to approve instead.`;
    }

    await session.sendMessage(params.message);

    // Single notification: plan approval gets a dedicated icon; everything else
    // (including interrupt/redirect) collapses into one ↪️ message with preview.
    if (isPlanApproval) {
      sm.notifySession(session, `👍 [${session.name}] Plan approved`, "plan-approved");
    } else if (params.userInitiated) {
      const notifyPreview = truncateText(params.message, 100);
      sm.notifySession(session, `↪️ [${session.name}] "${notifyPreview}"`, "agent-respond");
    }
    // else: silent auto-respond — no notification

    if (!params.userInitiated) {
      session.incrementAutoRespond();
    }

    const msgSummary = truncateText(params.message, 80);
    if (isPlanApproval) {
      return {
        text: `Plan approved for session ${session.name} [${session.id}]. Use agent_output to see the response.`,
      };
    }

    return {
      text: [
        `Message sent to session ${session.name} [${session.id}].`,
        redirectedActiveTurn
          ? `  (redirected active turn first)`
          : (params.interrupt ? `  (no active turn to interrupt)` : ""),
        `  Message: "${msgSummary}"`,
        approvalWarning,
        `Use agent_output to see the response.`,
      ].filter(Boolean).join("\n"),
    };
  } catch (err: unknown) {
    return { text: `Error sending message to session ${session.name} [${session.id}]: ${errorMessage(err)}`, isError: true };
  }
}
