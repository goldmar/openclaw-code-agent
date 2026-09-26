import { Type } from "../tool-parameter-schema";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext, RepoIntegrationPolicy, RepoPolicyRecord } from "../types";
import { formatStoredRepoPolicyLine, validateRepoPolicyForPrAvailability } from "../repo-policy";
import { quoteCommandArg } from "../commands/args";

interface AgentRepoPolicyParams {
  workdir?: string;
  policy?: RepoIntegrationPolicy;
  reset?: boolean;
  list?: boolean;
  cleanup?: boolean;
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

type RepoPolicySurface = "tool" | "command";

/** Result text for a reset; lists the removed records when they differ from the reference. */
export function formatRepoPolicyReset(
  ref: string,
  removed: readonly RepoPolicyRecord[],
  surface: RepoPolicySurface = "tool",
): string {
  if (removed.length === 0) {
    return `No stored repo policy found for ${ref}. See ${surface === "tool" ? "agent_repo_policy(list=true)" : "/agent_policy list"} for stored repo paths.`;
  }
  if (removed.length === 1 && removed[0].repoRoot === ref) return `Repo policy reset for ${ref}.`;
  return [`Repo policy reset for ${ref}. Removed:`, ...removed.map((record) => formatStoredRepoPolicyLine(record, { includeRemote: true }))].join("\n");
}

/** Status text when the workdir is not a git repository (for example it was deleted). */
export function formatUnresolvedRepoPolicy(
  ref: string,
  stored: readonly RepoPolicyRecord[],
  surface: RepoPolicySurface = "tool",
): string {
  if (stored.length === 0) return `No git repository found for ${ref}.`;
  const quoted = quoteCommandArg(ref);
  const resetHint = surface === "tool"
    ? `agent_repo_policy(workdir=${JSON.stringify(ref)}, reset=true)`
    : quoted ? `/agent_policy reset ${quoted}` : "agent_repo_policy(reset=true) with this workdir";
  return [
    ...stored.flatMap((record, index) => [...(index > 0 ? [""] : []), formatPolicy(record)]),
    ``,
    `No git repository found for ${ref}; reset with ${resetHint}.`,
  ].join("\n");
}

export function makeAgentRepoPolicyTool(ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_repo_policy",
    description: "Show or set how a repository's worktree branches land: pr-required (PR only), pr-allowed (merge or PR), never-pr (merge only), manual (no automatic merge or PR).",
    parameters: Type.Object({
      workdir: Type.Optional(Type.String({ description: "Default: the current workspace. reset also accepts a stored path." })),
      policy: Type.Optional(Type.StringEnum(["pr-required", "pr-allowed", "never-pr", "manual"])),
      reset: Type.Optional(Type.Boolean()),
      list: Type.Optional(Type.Boolean({ description: "All stored policies" })),
      cleanup: Type.Optional(Type.Boolean({ description: "Remove policies of repositories that no longer exist" })),
    }),
    async execute(_id: string, params: AgentRepoPolicyParams | unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      const input = params && typeof params === "object" ? params as AgentRepoPolicyParams : {};
      if (input.cleanup === true) {
        const removed = await sessionManager.cleanupRepoPolicies();
        const text = removed.length === 0
          ? "No stale repo policies found."
          : [
              `Removed ${removed.length} stale repo ${removed.length === 1 ? "policy" : "policies"}.`,
              ...removed.map((record) => formatStoredRepoPolicyLine(record)),
            ].join("\n");
        return { content: [{ type: "text", text }] };
      }
      if (input.list === true) {
        const records = sessionManager.listRepoPolicies();
        const text = records.length === 0
          ? "No stored repo policies."
          : records.map((record) => formatStoredRepoPolicyLine(record, { includeRemote: true })).join("\n");
        return { content: [{ type: "text", text }] };
      }

      const workdir = input.workdir ?? ctx?.workspaceDir;
      if (!workdir) {
        return { content: [{ type: "text", text: "Error: workdir is required when no workspace directory is available." }] };
      }

      if (input.reset === true) {
        const removed = await sessionManager.resetRepoPolicy(workdir);
        return { content: [{ type: "text", text: formatRepoPolicyReset(workdir, removed) }] };
      }

      if (input.policy !== undefined) {
        if (!isPolicy(input.policy)) {
          return { content: [{ type: "text", text: "Error: policy must be one of pr-required, pr-allowed, never-pr, manual." }] };
        }
        if (typeof sessionManager.resolveRepoPolicy === "function") {
          const resolution = await sessionManager.resolveRepoPolicy(workdir);
          if (resolution.identity) {
            const validationError = validateRepoPolicyForPrAvailability(input.policy, resolution.prAvailable);
            if (validationError) return { content: [{ type: "text", text: `Error: ${validationError}` }] };
          }
        }
        const record = await sessionManager.setRepoPolicy(workdir, input.policy);
        if (!record) {
          return { content: [{ type: "text", text: `Error: ${workdir} is not a git repository.` }] };
        }
        let continuation: Awaited<ReturnType<NonNullable<typeof sessionManager>["continueLaunchAfterManualRepoPolicy"]>> | { kind: "none" };
        try {
          // Guard is intentional: tests and older plugin-injected managers may not have this newer method.
          continuation = typeof sessionManager.continueLaunchAfterManualRepoPolicy === "function"
            ? await sessionManager.continueLaunchAfterManualRepoPolicy(record.repoRoot, input.policy)
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

      const resolution = await sessionManager.resolveRepoPolicy(workdir);
      if (!resolution.identity) {
        return { content: [{ type: "text", text: formatUnresolvedRepoPolicy(workdir, sessionManager.findStoredRepoPolicies(workdir)) }] };
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
