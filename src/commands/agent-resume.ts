import { sessionManager } from "../singletons";
import { resolveOriginChannel } from "../config";
import { formatDuration } from "../format";

export function registerAgentResumeCommand(api: any): void {
  api.registerCommand({
    name: "agent_resume",
    description:
      "Resume a previous coding agent session. Usage: /agent_resume <id-or-name> [prompt] or /agent_resume --list to see resumable sessions.",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx: any) => {
      if (!sessionManager) {
        return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      }

      let args = (ctx.args ?? "").trim();
      if (!args) {
        return { text: "Usage: /agent_resume <id-or-name> [prompt]\n       /agent_resume --list — list resumable sessions\n       /agent_resume --fork <id-or-name> [prompt] — fork instead of continuing" };
      }

      if (args === "--list") {
        const persisted = sessionManager.listPersistedSessions();
        if (persisted.length === 0) {
          return { text: "No resumable sessions found. Sessions are persisted after completion." };
        }

        const lines = persisted.map((info) => {
          const promptSummary = info.prompt.length > 60 ? info.prompt.slice(0, 60) + "..." : info.prompt;
          const completedStr = info.completedAt
            ? `completed ${formatDuration(Date.now() - info.completedAt)} ago`
            : info.status;
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

      const persisted = sessionManager.getPersistedSession(ref);
      const workdir = persisted?.workdir ?? process.cwd();

      try {
        const session = sessionManager.spawn({
          prompt,
          workdir,
          name: persisted?.name,
          model: persisted?.model,
          resumeSessionId: harnessSessionId,
          forkSession: fork,
          originChannel: resolveOriginChannel(ctx),
          harness: persisted?.harness,
        });

        const promptSummary = prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;
        return {
          text: [
            `Session resumed${fork ? " (forked)" : ""}.`,
            `  Name: ${session.name}`,
            `  ID: ${session.id}`,
            `  Resume from: ${harnessSessionId}`,
            `  Dir: ${workdir}`,
            `  Prompt: "${promptSummary}"`,
          ].join("\n"),
        };
      } catch (err: any) {
        const hint = err.message.includes("Max sessions") ? "" : "\n\nUse /agent_sessions to see active sessions or /agent_resume --list to see resumable sessions.";
        return { text: `Error resuming session: ${err.message}${hint}` };
      }
    },
  });
}
