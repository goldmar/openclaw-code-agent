import { sessionManager } from "../singletons";
import { getDefaultHarnessName, resolveDefaultModelForHarness, resolveOriginChannel, resolveOriginThreadId, resolveSessionRoute } from "../config";
import { formatDuration } from "../format";
import { decideResumeSessionId } from "../resume-policy";

interface ResumeCommandContext {
  args?: string;
  agentId?: string;
  sessionKey?: string;
  channel?: string;
  chatId?: string | number;
  senderId?: string | number;
  id?: string | number;
  channelId?: string;
  messageThreadId?: string | number;
}

interface CommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: (ctx: ResumeCommandContext) => { text: string };
  }): void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Register `/agent_resume` chat command. */
export function registerAgentResumeCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent_resume",
    description:
      "Resume a previous coding agent session. Usage: /agent_resume <id-or-name> [prompt] or /agent_resume --list to see resumable sessions.",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: ResumeCommandContext) => {
      if (!sessionManager) {
        return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      }

      let args = (ctx.args ?? "").trim();
      if (!args) {
        return { text: "Usage: /agent_resume <id-or-name> [prompt]\n       /agent_resume --list — list resumable sessions\n       /agent_resume --fork <id-or-name> [prompt] — fork instead of continuing" };
      }

      if (args === "--list") {
        const persisted = sessionManager.listPersistedSessions().filter((info) => info.resumable);
        if (persisted.length === 0) {
          return { text: "No resumable sessions found." };
        }

        const lines = persisted.map((info) => {
          const promptSummary = info.prompt.length > 60 ? info.prompt.slice(0, 60) + "..." : info.prompt;
          const completedStr = info.lifecycle === "suspended" && info.completedAt
            ? `suspended ${formatDuration(Date.now() - info.completedAt)} ago`
            : (info.completedAt ? `completed ${formatDuration(Date.now() - info.completedAt)} ago` : info.status);
          return [
            `  ${info.name} — ${completedStr}`,
            `    Session ID: ${info.harnessSessionId}`,
            `    📁 ${info.workdir}`,
            `    📝 "${promptSummary}"`,
          ].join("\n");
        });

        return { text: `Resumable sessions:\n\n${lines.join("\n\n")}` };
      }

      let fork = false;
      if (args.startsWith("--fork ")) {
        fork = true;
        args = args.slice("--fork ".length).trim();
      }

      const spaceIdx = args.indexOf(" ");
      let ref: string;
      let prompt: string;
      if (spaceIdx === -1) {
        ref = args;
        prompt = "Continue where you left off.";
      } else {
        ref = args.slice(0, spaceIdx);
        prompt = args.slice(spaceIdx + 1).trim() || "Continue where you left off.";
      }

      const harnessSessionId = sessionManager.resolveHarnessSessionId(ref);
      if (!harnessSessionId) {
        return { text: `Error: Could not find a session ID for "${ref}".\nUse /agent_resume --list to see available sessions.` };
      }

      const active = sessionManager.resolve(ref);
      const persisted = sessionManager.getPersistedSession(ref);
      if (persisted && !persisted.resumable) {
        return { text: `Error: Session "${ref}" is not explicitly resumable. Start a fresh session or inspect it with agent_output.` };
      }
      const { resumeSessionId, clearedPersistedCodexResume } = decideResumeSessionId({
        requestedResumeSessionId: harnessSessionId,
        activeSession: active
          ? { harnessSessionId: active.harnessSessionId }
          : undefined,
        persistedSession: persisted
          ? { harness: persisted.harness }
          : undefined,
      });
      const workdir = persisted?.workdir ?? process.cwd();
      const harness = persisted?.harness ?? getDefaultHarnessName();
      const model = persisted?.model ?? resolveDefaultModelForHarness(harness);

      try {
        if (!model) {
          return {
            text: `Error: No default model configured for harness "${harness}". Set plugins.entries["openclaw-code-agent"].config.harnesses.${harness}.defaultModel or pass model explicitly when launching a fresh session.`,
          };
        }
        const session = sessionManager.spawn({
          prompt,
          workdir,
          name: persisted?.name,
          model,
          codexApprovalPolicy: active?.codexApprovalPolicy ?? persisted?.codexApprovalPolicy,
          resumeSessionId,
          forkSession: resumeSessionId ? fork : false,
          originChannel: resolveOriginChannel(ctx),
          originThreadId: resolveOriginThreadId(ctx) ?? persisted?.originThreadId,
          originAgentId: ctx?.agentId ?? persisted?.originAgentId,
          originSessionKey: ctx?.sessionKey ?? persisted?.originSessionKey,
          route: resolveSessionRoute(ctx, undefined, ctx?.sessionKey) ?? persisted?.route,
          harness,
        });

        const promptSummary = prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;
        return {
          text: [
            `Session resumed${fork ? " (forked)" : ""}.`,
            `  Name: ${session.name}`,
            `  ID: ${session.id}`,
            resumeSessionId
              ? `  Resume from: ${harnessSessionId}`
              : `  Resume from: fresh thread`,
            `  Dir: ${workdir}`,
            `  Prompt: "${promptSummary}"`,
            clearedPersistedCodexResume
              ? `  Note: cleared persisted Codex thread state after restart to avoid org-mismatch resume failures.`
              : ``,
          ].join("\n"),
        };
      } catch (err: unknown) {
        const message = errorMessage(err);
        const hint = message.includes("Max sessions") ? "" : "\n\nUse /agent_sessions to see active sessions or /agent_resume --list to see resumable sessions.";
        return { text: `Error resuming session: ${message}${hint}` };
      }
    },
  });
}
