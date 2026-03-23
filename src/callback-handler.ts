import { sessionManager } from "./singletons";
import { executeRespond } from "./actions/respond";
import { makeAgentMergeTool } from "./tools/agent-merge";
import { makeAgentPrTool } from "./tools/agent-pr";
import { makeAgentOutputTool } from "./tools/agent-output";

/** Namespace prefix used in all button callbackData values. */
export const CALLBACK_NAMESPACE = "code-agent";

/**
 * Minimal Telegram callback handler context (mirrors OpenClaw's
 * PluginInteractiveTelegramHandlerContext — no import from OpenClaw internals needed).
 */
interface TelegramCallbackContext {
  auth: { isAuthorizedSender: boolean };
  callback: { payload: string };
  respond: {
    reply: (params: { text: string }) => Promise<void>;
    clearButtons: () => Promise<void>;
  };
}

/**
 * Parse "action:sessionId" payload (everything after the namespace colon).
 * Uses indexOf so session IDs containing colons are handled safely.
 */
function parsePayload(payload: string): { action: string; sessionId: string } | null {
  const colonIdx = payload.indexOf(":");
  if (colonIdx === -1) return null;
  const action = payload.slice(0, colonIdx).trim();
  const sessionId = payload.slice(colonIdx + 1).trim();
  if (!action || !sessionId) return null;
  return { action, sessionId };
}

/** Extract text from a tool execute result content array. */
function toolResultText(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as { content: unknown[] }).content)
  ) {
    const first = (result as { content: Array<{ text?: unknown }> }).content[0];
    return typeof first?.text === "string" ? first.text : "(done)";
  }
  return "(done)";
}

/**
 * Create the Telegram interactive handler registration for button callbacks.
 *
 * Register via: `api.registerInteractiveHandler(createCallbackHandler())`
 *
 * Flow:
 * 1. Check sender authorization.
 * 2. Parse payload → action + sessionId.
 * 3. Answer callback (clear buttons / remove spinner) immediately.
 * 4. Execute action programmatically.
 * 5. Reply with result in the same Telegram thread.
 *
 * Alice never sees raw callback_data strings.
 */
export function createCallbackHandler() {
  return {
    channel: "telegram" as const,
    namespace: CALLBACK_NAMESPACE,
    handler: async (ctx: TelegramCallbackContext): Promise<{ handled?: boolean } | void> => {
      // Authorization check
      if (!ctx.auth.isAuthorizedSender) {
        await ctx.respond.reply({ text: "⛔ Unauthorized." });
        return { handled: true };
      }

      // Parse payload
      const parsed = parsePayload(ctx.callback.payload);
      if (!parsed) {
        await ctx.respond.reply({
          text: `⚠️ Unrecognized callback payload: "${ctx.callback.payload}". Expected "action:session-id".`,
        });
        return { handled: true };
      }

      const { action, sessionId } = parsed;

      // Guard service initialization
      if (!sessionManager) {
        await ctx.respond.reply({ text: "⚠️ Code agent service not running." });
        return { handled: true };
      }

      // Answer the callback query immediately: removes spinner and buttons from message.
      await ctx.respond.clearButtons();

      // Route action
      switch (action) {
        case "merge":
        case "merge-locally": {
          const result = await makeAgentMergeTool().execute("callback", { session: sessionId });
          await ctx.respond.reply({ text: toolResultText(result) });
          break;
        }

        case "pr":
        case "open-pr": {
          const result = await makeAgentPrTool().execute("callback", { session: sessionId });
          await ctx.respond.reply({ text: toolResultText(result) });
          break;
        }

        case "new-pr": {
          const result = await makeAgentPrTool().execute("callback", { session: sessionId, force_new: true });
          await ctx.respond.reply({ text: toolResultText(result) });
          break;
        }

        case "dismiss": {
          const activeSession = sessionManager.resolve(sessionId);
          const persistedSession = sessionManager.getPersistedSession(sessionId);
          const harnessId = activeSession?.harnessSessionId ?? persistedSession?.harnessSessionId;

          if (!harnessId) {
            await ctx.respond.reply({ text: `⚠️ Session "${sessionId}" not found.` });
            break;
          }

          sessionManager.updatePersistedSession(harnessId, {
            pendingWorktreeDecisionSince: undefined,
            lastWorktreeReminderAt: undefined,
          });

          const name = activeSession?.name ?? persistedSession?.name ?? sessionId;
          await ctx.respond.reply({
            text: `❌ Dismissed worktree for session "${name}". No merge or PR will be created.`,
          });
          break;
        }

        case "approve": {
          const result = await executeRespond(sessionManager, {
            session: sessionId,
            message: "Approved. Go ahead.",
            approve: true,
            userInitiated: true,
          });
          await ctx.respond.reply({ text: result.isError ? `⚠️ ${result.text}` : `👍 ${result.text}` });
          break;
        }

        case "reject": {
          const result = await executeRespond(sessionManager, {
            session: sessionId,
            message: "Plan rejected. Please stop.",
            userInitiated: true,
          });
          await ctx.respond.reply({ text: result.isError ? `⚠️ ${result.text}` : `❌ ${result.text}` });
          break;
        }

        case "revise": {
          const reviseSession = sessionManager.resolve(sessionId);
          const revisePersisted = sessionManager.getPersistedSession(sessionId);
          const reviseName = reviseSession?.name ?? revisePersisted?.name ?? sessionId;
          await ctx.respond.reply({
            text: `✏️ Type your revision feedback for [${reviseName}] and I'll forward it to the agent.`,
          });
          break;
        }

        case "reply": {
          const replySession = sessionManager.resolve(sessionId);
          const replyPersisted = sessionManager.getPersistedSession(sessionId);
          const replyName = replySession?.name ?? replyPersisted?.name ?? sessionId;
          await ctx.respond.reply({
            text: `💬 Type your reply for [${replyName}] and I'll forward it to the agent.`,
          });
          break;
        }

        case "retry": {
          const result = await executeRespond(sessionManager, {
            session: sessionId,
            message: "Retry.",
            userInitiated: true,
          });
          await ctx.respond.reply({ text: result.isError ? `⚠️ ${result.text}` : `🔄 ${result.text}` });
          break;
        }

        case "view-output": {
          const result = await makeAgentOutputTool().execute("callback", { session: sessionId, lines: 50 });
          await ctx.respond.reply({ text: toolResultText(result) });
          break;
        }

        default: {
          await ctx.respond.reply({
            text: `⚠️ Unknown callback action: "${action}". Supported: merge, pr, open-pr, new-pr, dismiss, approve, reject, revise, reply, retry, view-output.`,
          });
          break;
        }
      }

      return { handled: true };
    },
  };
}
