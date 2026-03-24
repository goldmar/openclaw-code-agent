import type { SessionManager } from "../session-manager";
import { pluginConfig } from "../config";
import { truncateText } from "../format";
import { decideResumeSessionId } from "../resume-policy";
import type { Session } from "../session";
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

const AUTO_RESUMABLE_STATUSES = new Set(["killed", "completed", "failed"]);
const NON_RESUMABLE_KILL_REASONS = new Set(["startup-timeout"]);
const DEFAULT_MAX_AUTO_RESPONDS = 10;
const SIMPLE_APPROVAL_MAX_CHARS = 100;
const REVISION_KEYWORDS_RE = /\b(change|swap|replace|remove|add|update|instead|don't|revise|modify)\b/i;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ResumableSession = Session | PersistedSessionInfo;

function getSessionRef(session: ResumableSession): string {
  return "id" in session ? session.id : (session.sessionId ?? session.harnessSessionId);
}

function isRecoveredRunningStub(session: PersistedSessionInfo): boolean {
  return session.status === "killed" && session.completedAt == null;
}

function canAutoResume(session: ResumableSession, allowRecoveredRunningStub: boolean): boolean {
  return (
    AUTO_RESUMABLE_STATUSES.has(session.status) &&
    !!session.harnessSessionId &&
    (
      session.status === "failed"
      || (session.status === "completed" && session.killReason === "done")
      || (
        session.status === "killed"
        && (
          !NON_RESUMABLE_KILL_REASONS.has(session.killReason ?? "")
          || (allowRecoveredRunningStub && isRecoveredRunningStub(session as PersistedSessionInfo))
        )
      )
    )
  );
}

/**
 * Returns true when a session was killed by a shutdown signal before the
 * harness ever initialised — i.e. it has no harness session ID to resume.
 */
function isNeverStartedShutdown(session: ResumableSession): boolean {
  return session.killReason === "shutdown" && !session.harnessSessionId;
}

async function spawnFreshRelaunch(
  sm: SessionManager,
  session: ResumableSession,
  _message: string,
): Promise<RespondResult> {
  try {
    const freshConfig: SessionConfig = {
      prompt: session.prompt,
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
      permissionMode: session.currentPermissionMode,
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

function validateApprovalMessage(sessionName: string, message: string): RespondResult | undefined {
  const isSimpleApproval =
    message.trim().length < SIMPLE_APPROVAL_MAX_CHARS &&
    !REVISION_KEYWORDS_RE.test(message);
  if (isSimpleApproval) return undefined;

  return {
    text: [
      `Cannot approve and revise in the same call.`,
      `Your message appears to contain revision feedback. Send it first WITHOUT approve=true:`,
      `  agent_respond(session='${sessionName}', message='<your feedback>')`,
      `The agent will revise the plan. Then approve the revised plan.`,
    ].join("\n"),
    isError: true,
  };
}

const PLAN_APPROVAL_SYSTEM_PREFIX =
  "[SYSTEM: The user has approved your plan. Exit plan mode immediately and implement the changes with full permissions. Do not ask for further confirmation.]\n\n";

async function tryAutoResume(
  sm: SessionManager,
  session: ResumableSession,
  message: string,
  options: { allowRecoveredRunningStub?: boolean; approve?: boolean } = {},
): Promise<RespondResult | undefined> {
  if (!canAutoResume(session, options.allowRecoveredRunningStub === true)) return undefined;

  // When approve=true is sent to a dead plan-mode session, forward the approval
  // into the resumed session by switching its permission mode to bypassPermissions
  // and prepending the system approval prefix. Without this, the resume would
  // inherit permissionMode="plan", the first turn-end would re-set
  // pendingPlanApproval=true, and Alice would be asked to approve a second time.
  const isPlanApproval = !!(options.approve && session.currentPermissionMode === "plan");
  if (isPlanApproval) {
    const invalid = validateApprovalMessage(session.name, message);
    if (invalid) return invalid;
  }

  try {
    const activeSession = "harnessName" in session ? session : undefined;
    const persistedSession = "harnessName" in session ? undefined : session;
    const { resumeSessionId } = decideResumeSessionId({
      requestedResumeSessionId: session.harnessSessionId,
      activeSession: activeSession
        ? { harnessSessionId: activeSession.harnessSessionId }
        : undefined,
      persistedSession: persistedSession
        ? { harness: persistedSession.harness }
        : undefined,
    });

    // Preserve all relevant runtime/session-routing knobs so auto-resume is a
    // continuation of the exact same lifecycle, not a best-effort relaunch.
    const resumeConfig: SessionConfig = {
      // Inject the approval prefix so Claude knows it's approved and switches
      // out of plan mode without re-presenting the plan.
      prompt: isPlanApproval ? PLAN_APPROVAL_SYSTEM_PREFIX + message : message,
      workdir: session.workdir,
      name: session.name,
      model: session.model,
      reasoningEffort: session.reasoningEffort,
      resumeSessionId,
      multiTurn: true,
      originChannel: session.originChannel,
      originThreadId: session.originThreadId,
      originAgentId: session.originAgentId,
      originSessionKey: session.originSessionKey,
      // For a plan approval, start the resumed session in bypassPermissions so
      // the harness launches without plan-mode constraints and the turn-end
      // fallback (currentPermissionMode === "plan") cannot re-fire.
      permissionMode: isPlanApproval ? "bypassPermissions" : session.currentPermissionMode,
      codexApprovalPolicy: session.codexApprovalPolicy,
      harness: "harnessName" in session ? session.harnessName : session.harness,
    };
    const resumed = await sm.spawnAndAwaitRunning(resumeConfig, { notifyLaunch: false });
    if (isPlanApproval) {
      sm.notifySession(resumed, `👍 [${resumed.name}] Plan approved (resumed)`, "plan-approved");
    } else {
      sm.notifySession(resumed, `▶️ [${resumed.name}] Auto-resumed`);
    }
    return { text: `Auto-resumed session ${resumed.name} [${resumed.id}]. Use agent_output to see the response.` };
  } catch (err: unknown) {
    return { text: `Error auto-resuming session ${session.name} [${getSessionRef(session)}]: ${errorMessage(err)}`, isError: true };
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

  if (isNeverStartedShutdown(target)) {
    return spawnFreshRelaunch(sm, target, params.message);
  }

  const autoResumeResult = await tryAutoResume(sm, target, params.message, { allowRecoveredRunningStub: !session, approve: params.approve });
  if (autoResumeResult) {
    return autoResumeResult;
  }

  if (!session) {
    return {
      text: `Error: Session ${persisted!.name} [${getSessionRef(persisted!)}] is not running (status: ${persisted!.status}). Cannot send a message to a non-running session.`,
      isError: true,
    };
  }

  if (session.status !== "running") {
    return {
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
    let redirectedActiveTurn = false;
    if (params.interrupt) {
      redirectedActiveTurn = await session.interrupt();
    }

    // Permission escalation — explicit approve flag
    const isPlanApproval = !!(params.approve && session.pendingPlanApproval);
    let approvalWarning = "";
    if (params.approve && session.pendingPlanApproval) {
      // Plan mode approval (existing behavior)
      const invalidApprovalResult = validateApprovalMessage(session.name, params.message);
      if (invalidApprovalResult) {
        return invalidApprovalResult;
      }
      session.switchPermissionMode("bypassPermissions");
    } else if (params.approve && session.currentPermissionMode === "default") {
      // Non-plan mode escalation — switch to bypassPermissions
      session.switchPermissionMode("bypassPermissions");
    } else if (params.approve && session.currentPermissionMode === "bypassPermissions") {
      // Already at maximum permissions — no-op, just inform
      approvalWarning = `\nℹ️ approve=true was set but session is already in bypassPermissions mode.`;
    } else if (params.approve) {
      approvalWarning = `\n⚠️ approve=true was set but session has no pending plan approval.`;
    } else if (session.pendingPlanApproval) {
      approvalWarning = `\nℹ️ Session has a pending plan — sending as revision feedback. The agent will revise and re-submit. Set approve=true to approve instead.`;
    }

    await session.sendMessage(params.message);

    // Single notification: plan approval gets a dedicated icon; everything else
    // (including interrupt/redirect) collapses into one ↪️ message with preview.
    if (isPlanApproval) {
      sm.notifySession(session, `👍 [${session.name}] Plan approved`, "plan-approved");
    } else {
      const notifyPreview = truncateText(params.message, 100);
      sm.notifySession(session, `↪️ [${session.name}] "${notifyPreview}"`, "agent-respond");
    }

    if (!params.userInitiated) {
      session.incrementAutoRespond();
    }

    const msgSummary = truncateText(params.message, 80);

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
