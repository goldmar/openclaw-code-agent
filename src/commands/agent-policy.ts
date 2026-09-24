import { sessionManager } from "../singletons";
import type { RepoIntegrationPolicy } from "../types";
import { consumeFirstCommandArg } from "./args";
import { formatStoredRepoPolicyLine, getRepoPolicyOptionsForPrAvailability, validateRepoPolicyForPrAvailability } from "../repo-policy";
import { formatRepoPolicyReset, formatUnresolvedRepoPolicy } from "../tools/agent-repo-policy";

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
    handler: (ctx: AgentPolicyCommandContext) => Promise<{ text: string }>;
  }): void;
}

function isPolicy(value: string): value is RepoIntegrationPolicy {
  return value === "pr-required" || value === "pr-allowed" || value === "never-pr" || value === "manual";
}

export function registerAgentPolicyCommand(api: CommandApi): void {
  api.registerCommand({
    name: "agent_policy",
    description: "Inspect or set the current repo integration policy. Usage: /agent_policy [pr-required|pr-allowed|never-pr|manual|reset [repo-path]|list|cleanup]",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      if (!sessionManager) return { text: "Error: SessionManager not initialized. The code-agent service must be running." };
      const first = consumeFirstCommandArg((ctx.args ?? "").trim());
      const action = first?.value;
      if (action === "list") {
        const records = sessionManager.listRepoPolicies();
        return {
          text: records.length === 0
            ? "No stored repo policies."
            : records.map((record) => formatStoredRepoPolicyLine(record)).join("\n"),
        };
      }
      if (action === "cleanup") {
        const removed = await sessionManager.cleanupRepoPolicies();
        return {
          text: removed.length === 0
            ? "No stale repo policies found."
            : [
                `Removed ${removed.length} stale repo ${removed.length === 1 ? "policy" : "policies"}.`,
                ...removed.map((record) => formatStoredRepoPolicyLine(record)),
              ].join("\n"),
        };
      }
      if (action === "reset") {
        // `/agent_policy reset <path>` also targets a stored repo whose directory is gone.
        const target = (first?.rest ? consumeFirstCommandArg(first.rest)?.value : undefined) ?? ctx.workspaceDir;
        if (!target) return { text: "Error: workspaceDir is required. Usage: /agent_policy reset [repo-path]" };
        const removed = await sessionManager.resetRepoPolicy(target);
        return { text: formatRepoPolicyReset(target, removed, "command") };
      }
      const workdir = ctx.workspaceDir;
      if (!workdir) return { text: "Error: workspaceDir is required." };
      if (action && isPolicy(action)) {
        if (typeof sessionManager.resolveRepoPolicy === "function") {
          const resolution = await sessionManager.resolveRepoPolicy(workdir);
          if (resolution.identity) {
            const validationError = validateRepoPolicyForPrAvailability(action, resolution.prAvailable);
            if (validationError) return { text: `Error: ${validationError}` };
          }
        }
        const record = await sessionManager.setRepoPolicy(workdir, action);
        if (!record) return { text: `Error: ${workdir} is not a git repository.` };
        const savedText = `Repo policy set to ${record.policy} for ${record.repoRoot}.`;
        try {
          // Guard is intentional: tests and older plugin-injected managers may not have this newer method.
          if (typeof sessionManager.continueLaunchAfterManualRepoPolicy !== "function") {
            return { text: savedText };
          }
          const continuation = await sessionManager.continueLaunchAfterManualRepoPolicy(record.repoRoot, action);
          if (continuation.kind === "launched") {
            return { text: [savedText, "", continuation.text].join("\n") };
          }
          if (continuation.kind === "ambiguous") {
            return {
              text: [
                savedText,
                "",
                `Repo policy saved, but ${continuation.count} pending launches match this policy. Run the intended launch again to avoid starting the wrong session.`,
              ].join("\n"),
            };
          }
        } catch (err) {
          const errText = err instanceof Error ? err.message : String(err);
          return {
            text: [
              savedText,
              "",
              `Repo policy saved, but the deferred launch failed: ${errText}`,
              `The pending launch context was kept so you can retry the same /agent_policy command or run the intended launch again.`,
            ].join("\n"),
          };
        }
        return { text: savedText };
      }
      const resolution = await sessionManager.resolveRepoPolicy(workdir);
      if (!resolution.identity) return { text: formatUnresolvedRepoPolicy(workdir, sessionManager.findStoredRepoPolicies(workdir), "command") };
      const policyOptions = getRepoPolicyOptionsForPrAvailability(resolution.prAvailable)
        .map((option) => option.policy)
        .join(", ");
      return {
        text: [
          `Repo policy: ${resolution.policy ?? "unknown"}`,
          `Repo: ${resolution.identity.repoRoot}`,
          `Provider: ${resolution.provider}${resolution.prAvailable ? "" : " (PR automation unavailable)"}`,
          ...(resolution.identity.remoteUrl ? [`Remote: ${resolution.identity.remoteUrl}`] : []),
          ``,
          `Set with /agent_policy ${policyOptions}.`,
        ].join("\n"),
      };
    },
  });
}
