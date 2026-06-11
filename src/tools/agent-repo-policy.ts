import { Type } from "../tool-schema";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext, RepoIntegrationPolicy, RepoPolicyRecord } from "../types";

interface AgentRepoPolicyParams {
  workdir?: string;
  policy?: RepoIntegrationPolicy;
  reset?: boolean;
  list?: boolean;
}

function isPolicy(value: unknown): value is RepoIntegrationPolicy {
  return value === "pr-required" || value === "pr-allowed" || value === "never-pr" || value === "manual";
}

function formatPolicy(record: RepoPolicyRecord | undefined): string {
  if (!record) return "No stored repo policy found.";
  return [
    `Repo policy: ${record.policy}`,
    `Repo: ${record.repoRoot}`,
    `Provider: ${record.provider}`,
    ...(record.remoteUrl ? [`Remote: ${record.remoteUrl}`] : []),
    `Updated: ${record.updatedAt}`,
  ].join("\n");
}

export function makeAgentRepoPolicyTool(ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_repo_policy",
    description: "Inspect or set the repository integration policy that governs OCA worktree merge/PR follow-through.",
    parameters: Type.Object({
      workdir: Type.Optional(Type.String({ description: "Repository workdir. Defaults to the current workspace directory." })),
      policy: Type.Optional(Type.Union([
        Type.Literal("pr-required"),
        Type.Literal("pr-allowed"),
        Type.Literal("never-pr"),
        Type.Literal("manual"),
      ], { description: "Policy to set for this repo." })),
      reset: Type.Optional(Type.Boolean({ description: "Remove the stored policy for this repo." })),
      list: Type.Optional(Type.Boolean({ description: "List all stored repo policies." })),
    }),
    async execute(_id: string, params: AgentRepoPolicyParams | unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      const input = params && typeof params === "object" ? params as AgentRepoPolicyParams : {};
      if (input.list === true) {
        const records = sessionManager.listRepoPolicies();
        const text = records.length === 0
          ? "No stored repo policies."
          : records.map((record) => `${record.policy} | ${record.provider} | ${record.repoRoot}${record.remoteUrl ? ` | ${record.remoteUrl}` : ""}`).join("\n");
        return { content: [{ type: "text", text }] };
      }

      const workdir = input.workdir ?? ctx?.workspaceDir;
      if (!workdir) {
        return { content: [{ type: "text", text: "Error: workdir is required when no workspace directory is available." }] };
      }

      if (input.reset === true) {
        const ok = sessionManager.resetRepoPolicy(workdir);
        return { content: [{ type: "text", text: ok ? `Repo policy reset for ${workdir}.` : `No stored repo policy found for ${workdir}.` }] };
      }

      if (input.policy !== undefined) {
        if (!isPolicy(input.policy)) {
          return { content: [{ type: "text", text: "Error: policy must be one of pr-required, pr-allowed, never-pr, manual." }] };
        }
        const record = sessionManager.setRepoPolicy(workdir, input.policy);
        if (!record) {
          return { content: [{ type: "text", text: `Error: ${workdir} is not a git repository.` }] };
        }
        let continuation: ReturnType<NonNullable<typeof sessionManager>["continueLaunchAfterManualRepoPolicy"]> | { kind: "none" };
        try {
          // Guard is intentional: tests and older plugin-injected managers may not have this newer method.
          continuation = typeof sessionManager.continueLaunchAfterManualRepoPolicy === "function"
            ? sessionManager.continueLaunchAfterManualRepoPolicy(record.repoRoot, input.policy)
            : { kind: "none" as const };
        } catch (err) {
          const errText = err instanceof Error ? err.message : String(err);
          return {
            content: [{
              type: "text",
              text: [
                formatPolicy(record),
                ``,
                `Repo policy saved, but the deferred launch failed: ${errText}`,
                `The pending launch context was kept so you can retry the same agent_repo_policy call or run the intended launch again.`,
              ].join("\n"),
            }],
          };
        }
        if (continuation.kind === "launched") {
          return {
            content: [{
              type: "text",
              text: [
                formatPolicy(record),
                ``,
                continuation.text,
              ].join("\n"),
            }],
          };
        }
        if (continuation.kind === "ambiguous") {
          return {
            content: [{
              type: "text",
              text: [
                formatPolicy(record),
                ``,
                `Repo policy saved, but ${continuation.count} pending launches match this policy. Run the intended launch again to avoid starting the wrong session.`,
              ].join("\n"),
            }],
          };
        }
        return { content: [{ type: "text", text: formatPolicy(record) }] };
      }

      const resolution = sessionManager.resolveRepoPolicy(workdir);
      if (!resolution.identity) {
        return { content: [{ type: "text", text: `No git repository found for ${workdir}.` }] };
      }
      const record = resolution.record;
      if (record) {
        return { content: [{ type: "text", text: formatPolicy(record) }] };
      }
      return {
        content: [{
          type: "text",
          text: [
            `Repo policy: unknown`,
            `Repo: ${resolution.identity.repoRoot}`,
            `Provider: ${resolution.provider}${resolution.prAvailable ? "" : " (PR automation unavailable)"}`,
            ...(resolution.identity.remoteUrl ? [`Remote: ${resolution.identity.remoteUrl}`] : []),
          ].join("\n"),
        }],
      };
    },
  };
}
