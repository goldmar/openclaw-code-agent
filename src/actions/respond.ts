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

async function tryAutoResume(
  sm: SessionManager,
  session: ResumableSession,
  message: string,
  options: { allowRecoveredRunningStub?: boolean } = {},
): Promise<RespondResult | undefined> {
  if (!canAutoResume(session, options.allowRecoveredRunningStub === true)) return undefined;

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
      prompt: message,
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
      permissionMode: session.currentPermissionMode,
      codexApprovalPolicy: session.codexApprovalPolicy,
      harness: "harnessName" in session ? session.harnessName : session.harness,
    };
    const resumed = await sm.spawnAndAwaitRunning(resumeConfig, { notifyLaunch: false });
    sm.notifySession(resumed, `▶️ [${resumed.name}] Auto-resumed`);
    return { text: `Auto-resumed session ${resumed.name} [${resumed.id}]. Use agent_output to see the response.` };
  } catch (err: unknown) {
    return { text: `Error auto-resuming session ${session.name} [${getSessionRef(session)}]: ${errorMessage(err)}`, isError: true };
  }
}

function handleLobsterToken(
  sm: SessionManager,
  session: Session,
  params: RespondParams,
): RespondResult | undefined {
  const lobsterToken = session.lobsterResumeToken;
  if (!lobsterToken) return undefined;

  // Consume BEFORE resume to prevent re-entry loops.
  session.lobsterResumeToken = undefined;

  const canEscalate = session.pendingPlanApproval
    || session.currentPermissionMode === "default";
  if (params.approve && canEscalate) {
    sm.resumeLobsterApproval(lobsterToken, true).catch((err: unknown) => {
      // Fallback: direct mode switch if Lobster fails.
      console.error(`[Respond] Lobster resume failed, falling back to direct mode switch: ${errorMessage(err)}`);
      session.switchPermissionMode("bypassPermissions");
      session.sendMessage(params.message).catch((sendErr: unknown) => {
        console.error(`[Respond] Fallback sendMessage also failed: ${errorMessage(sendErr)}`);
      });
    });
    return { text: `Plan approved. Lobster workflow resuming for session ${session.name} [${session.id}].` };
  }

  // Rejection/feedback: cancel Lobster (fire-and-forget), then continue normal send flow.
  sm.resumeLobsterApproval(lobsterToken, false).catch((err: unknown) => {
    console.error(`[Respond] Lobster cancel failed (non-critical): ${errorMessage(err)}`);
  });
  return undefined;
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
  const autoResumeResult = await tryAutoResume(sm, target, params.message, { allowRecoveredRunningStub: !session });
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

  const lobsterResult = handleLobsterToken(sm, session, params);
  if (lobsterResult) {
    return lobsterResult;
  }

  try {
    let redirectedActiveTurn = false;
    if (params.interrupt) {
      redirectedActiveTurn = await session.interrupt();
    }

    // Permission escalation — explicit approve flag
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

    if (redirectedActiveTurn) {
      sm.notifySession(session, `↪️ [${session.name}] Redirected`, "redirected");
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
