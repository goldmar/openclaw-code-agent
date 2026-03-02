import type { SessionManager } from "../session-manager";
import { pluginConfig } from "../config";
import { truncateText } from "../format";

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
const AUTO_RESUMABLE_REASONS = new Set(["post-turn-idle", "idle-timeout", "done"]);

function getResumeLabel(status: string): string {
  switch (status) {
    case "completed": return "completed";
    case "failed": return "failed";
    default: return "idle-kill";
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

  if (!session) {
    return { text: `Error: Session "${params.session}" not found.`, isError: true };
  }

  const canAutoResume =
    AUTO_RESUMABLE_STATUSES.has(session.status) &&
    session.harnessSessionId &&
    (session.status === "failed" || AUTO_RESUMABLE_REASONS.has(session.killReason));

  if (canAutoResume) {
    try {
      const resumed = sm.spawn({
        prompt: params.message,
        workdir: session.workdir,
        name: session.name,
        model: session.model,
        resumeSessionId: session.harnessSessionId,
        multiTurn: true,
        originChannel: session.originChannel,
        originThreadId: session.originThreadId,
        originAgentId: session.originAgentId,
        permissionMode: session.currentPermissionMode,
      });
      const resumeLabel = getResumeLabel(session.status);
      sm.deliverToTelegram(resumed, `🔄 [${resumed.name}] Auto-resumed from ${resumeLabel}`);
      return { text: `Auto-resumed ${resumeLabel} session ${resumed.name} [${resumed.id}]. Use agent_output to see the response.` };
    } catch (err: any) {
      return { text: `Error auto-resuming session ${session.name} [${session.id}]: ${err.message}`, isError: true };
    }
  }

  if (session.status !== "running") {
    return {
      text: `Error: Session ${session.name} [${session.id}] is not running (status: ${session.status}). Cannot send a message to a non-running session.`,
      isError: true,
    };
  }

  // Auto-respond safety cap
  const maxAutoResponds = pluginConfig.maxAutoResponds ?? 10;
  if (params.userInitiated) {
    session.resetAutoRespond();
  } else if (session.autoRespondCount >= maxAutoResponds) {
    return {
      text: `⚠️ Auto-respond limit reached (${session.autoRespondCount}/${maxAutoResponds}). Ask the user to provide the answer for session ${session.name}. Then call agent_respond with their answer and set userInitiated: true to reset the counter.`,
    };
  }

  // Lobster approval token intercept — consume BEFORE resume to prevent re-entry
  // (Lobster's proceed step calls agent_respond back into this plugin)
  const lobsterToken = session.lobsterResumeToken;
  if (lobsterToken) {
    session.lobsterResumeToken = undefined; // Consume before resume

    if (params.approve && session.pendingPlanApproval) {
      // Approval: resume Lobster workflow (proceed step will call agent_respond)
      sm.resumeLobsterApproval(lobsterToken, true).catch((err) => {
        // Fallback: direct mode switch if Lobster fails
        console.error(`[Respond] Lobster resume failed, falling back to direct mode switch: ${err.message}`);
        session.switchPermissionMode("bypassPermissions");
        session.sendMessage(params.message).catch((sendErr: any) => {
          console.error(`[Respond] Fallback sendMessage also failed: ${sendErr.message}`);
        });
      });
      return { text: `Plan approved. Lobster workflow resuming for session ${session.name} [${session.id}].` };
    } else {
      // Rejection/feedback: cancel Lobster (fire-and-forget), fall through to normal handling
      sm.resumeLobsterApproval(lobsterToken, false).catch((err) => {
        console.error(`[Respond] Lobster cancel failed (non-critical): ${err.message}`);
      });
    }
  }

  try {
    if (params.interrupt) {
      await session.interrupt();
    }

    // Plan approval — explicit approve flag
    let approvalWarning = "";
    if (params.approve && session.pendingPlanApproval) {
      // Detect if message contains substantive revision feedback
      const isSimpleApproval = params.message.trim().length < 100
        && !/\b(change|swap|replace|remove|add|update|instead|don't|revise|modify)\b/i.test(params.message);

      if (!isSimpleApproval) {
        return {
          text: [
            `Cannot approve and revise in the same call.`,
            `Your message appears to contain revision feedback. Send it first WITHOUT approve=true:`,
            `  agent_respond(session='${session.name}', message='<your feedback>')`,
            `The agent will revise the plan. Then approve the revised plan.`,
          ].join("\n"),
          isError: true,
        };
      }

      session.switchPermissionMode("bypassPermissions");
    } else if (params.approve) {
      approvalWarning = `\n⚠️ approve=true was set but session has no pending plan approval.`;
    } else if (session.pendingPlanApproval) {
      approvalWarning = `\nℹ️ Session has a pending plan — sending as revision feedback. The agent will revise and re-submit. Set approve=true to approve instead.`;
    }

    await session.sendMessage(params.message);

    if (!params.userInitiated) {
      session.incrementAutoRespond();
    }

    const msgSummary = truncateText(params.message, 80);

    return {
      text: [
        `Message sent to session ${session.name} [${session.id}].`,
        params.interrupt ? `  (interrupted current turn first)` : "",
        `  Message: "${msgSummary}"`,
        approvalWarning,
        `Use agent_output to see the response.`,
      ].filter(Boolean).join("\n"),
    };
  } catch (err: any) {
    return { text: `Error sending message to session ${session.name} [${session.id}]: ${err.message}`, isError: true };
  }
}
