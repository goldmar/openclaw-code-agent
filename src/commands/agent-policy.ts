import { sessionManager } from "../singletons";
import type { RepoIntegrationPolicy } from "../types";
import { consumeFirstCommandArg } from "./args";

interface AgentPolicyCommandContext {
  args?: string;
  workspaceDir?: string;
}

interface CommandApi {
  registerCommand(config: {
    name: string;
    description: string;
    acceptsArgs: boolean;
    requireAuth: boolean;
    handler: (ctx: AgentPolicyCommandContext) => { text: string };
  }): void;
}

function isPolicy(value: string): value is RepoIntegrationPolicy {
  return value === "pr-required" || value === "pr-allowed" || value === "never-pr" || value === "manual";
}

export function registerAgentPolicyCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent_policy",
    description: "Inspect or set the current repo integration policy. Usage: /agent_policy [pr-required|pr-allowed|never-pr|manual|reset|list|cleanup]",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => {
      if (!sessionManager) return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      const first = consumeFirstCommandArg((ctx.args ?? "").trim());
      const action = first?.value;
      if (action === "list") {
        const records = sessionManager.listRepoPolicies();
        return {
          text: records.length === 0
            ? "No stored repo policies."
            : records.map((record) => `${record.policy} | ${record.provider} | ${record.repoRoot}`).join("\n"),
        };
      }
      if (action === "cleanup") {
        const removed = sessionManager.cleanupRepoPolicies();
        return {
          text: removed.length === 0
            ? "No stale repo policies found."
            : [
                `Removed ${removed.length} stale repo ${removed.length === 1 ? "policy" : "policies"}.`,
                ...removed.map((record) => `${record.policy} | ${record.provider} | ${record.repoRoot}`),
              ].join("\n"),
        };
      }
      const workdir = ctx.workspaceDir;
      if (!workdir) return { text: "Error: workspaceDir is required." };
      if (action === "reset") {
        const ok = sessionManager.resetRepoPolicy(workdir);
        return { text: ok ? `Repo policy reset for ${workdir}.` : `No stored repo policy found for ${workdir}.` };
      }
      if (action && isPolicy(action)) {
        const record = sessionManager.setRepoPolicy(workdir, action);
        return { text: record ? `Repo policy set to ${record.policy} for ${record.repoRoot}.` : `Error: ${workdir} is not a git repository.` };
      }
      const resolution = sessionManager.resolveRepoPolicy(workdir);
      if (!resolution.identity) return { text: `No git repository found for ${workdir}.` };
      return {
        text: [
          `Repo policy: ${resolution.policy ?? "unknown"}`,
          `Repo: ${resolution.identity.repoRoot}`,
          `Provider: ${resolution.provider}${resolution.prAvailable ? "" : " (PR automation unavailable)"}`,
          ...(resolution.identity.remoteUrl ? [`Remote: ${resolution.identity.remoteUrl}`] : []),
          ``,
          `Set with /agent_policy pr-required, pr-allowed, never-pr, or manual.`,
        ].join("\n"),
      };
    },
  });
}
