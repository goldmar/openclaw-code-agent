import { Type } from "@sinclair/typebox";
import type { ManagedWorktreeLifecycleState, OpenClawPluginToolContext } from "../types";
import { sessionManager } from "../singletons";
import { usesNativeBackendWorktree } from "../session-backend-ref";
import { resolveWorktreeLifecycle } from "../worktree-lifecycle-resolver";
import { deleteBranch, removeWorktree } from "../worktree";
import { listWorktreeToolTargets, matchesWorktreeToolRef, resolveWorktreeToolTarget } from "./worktree-tool-context";

interface AgentWorktreeCleanupParams {
  workdir?: string;
  base_branch?: string;
  mode?: "preview_safe" | "clean_safe" | "preview_all";
  skip_session_check?: boolean;
  force?: boolean;
  dry_run?: boolean;
  session?: string;
  dismiss_session?: boolean;
}

function isAgentWorktreeCleanupParams(value: unknown): value is AgentWorktreeCleanupParams {
  return Boolean(value) && typeof value === "object";
}

function formatLifecycleState(state: ManagedWorktreeLifecycleState): string {
  switch (state) {
    case "none":
      return "none";
    case "provisioned":
      return "active";
    case "pending_decision":
      return "needs decision";
    case "pr_open":
      return "pr open";
    case "merged":
      return "merged";
    case "released":
      return "released";
    case "dismissed":
      return "dismissed";
    case "no_change":
      return "no change";
    case "cleanup_failed":
      return "cleanup failed";
  }
}

function formatReason(reason: string): string {
  switch (reason) {
    case "active_session":
      return "active session";
    case "pending_decision":
      return "pending decision";
    case "dirty_tracked_changes":
      return "dirty worktree";
    case "unique_content":
      return "still has unique content";
    case "topology_merged":
      return "merged by ancestry";
    case "merge_noop_content_already_on_base":
      return "content already on base";
    case "pr_open":
      return "PR open";
    case "pr_merged_not_reflected_locally":
      return "merged PR not reflected locally";
    case "repo_missing":
      return "repo missing";
    case "branch_missing":
      return "branch missing";
    case "worktree_missing":
      return "worktree missing";
    case "base_branch_missing":
      return "base branch missing";
    default:
      return reason.replaceAll("_", " ");
  }
}

export function makeAgentWorktreeCleanupTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_worktree_cleanup",
    description: "Manage worktree cleanup with lifecycle-aware safety rules. Use preview_safe to list what Clean all safe would remove, clean_safe to execute it, or preview_all to see both safe and retained sandboxes with kept reasons.",
    parameters: Type.Object({
      workdir: Type.Optional(Type.String({ description: "Restrict cleanup to sessions rooted in this repository" })),
      base_branch: Type.Optional(Type.String({ description: "Override base branch for lifecycle resolution" })),
      mode: Type.Optional(Type.Union([
        Type.Literal("preview_safe"),
        Type.Literal("clean_safe"),
        Type.Literal("preview_all"),
      ], {
        description: "Cleanup mode. preview_safe shows what Clean all safe would remove, clean_safe performs that cleanup, preview_all shows both safe and retained worktrees. Defaults to preview_safe when dry_run=true, otherwise clean_safe.",
      })),
      skip_session_check: Type.Optional(Type.Boolean({ description: "Deprecated. Safe cleanup never removes live sessions." })),
      force: Type.Optional(Type.Boolean({ description: "Deprecated alias for skip_session_check." })),
      dry_run: Type.Optional(Type.Boolean({ description: "Show what would be cleaned without deleting anything." })),
      session: Type.Optional(Type.String({ description: "Session name or ID to clean or dismiss." })),
      dismiss_session: Type.Optional(Type.Boolean({ description: "When true and session is provided, permanently dismiss the worktree." })),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentWorktreeCleanupParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { workdir?, base_branch?, mode?, dry_run?, session?, dismiss_session? }." }] };
      }

      const sessionRef = params.session;
      const mode = params.mode ?? (params.dry_run === true ? "preview_safe" : "clean_safe");
      const dryRun = mode !== "clean_safe";
      const includeRetained = mode === "preview_all" || mode === "clean_safe";
      if (sessionRef && params.dismiss_session === true) {
        const dismissResult = await sessionManager.dismissWorktree(sessionRef);
        return { content: [{ type: "text", text: dismissResult }] };
      }

      let targets = listWorktreeToolTargets(sessionManager);
      if (sessionRef) {
        targets = targets.filter((target) => matchesWorktreeToolRef(target, sessionRef));
        if (targets.length === 0) {
          const resolved = resolveWorktreeToolTarget(sessionManager, sessionRef);
          if (!resolved.persistedSession && !resolved.activeSession) {
            return { content: [{ type: "text", text: `Error: Session "${sessionRef}" not found.` }] };
          }
        }
      }
      if (params.workdir) {
        targets = targets.filter((target) => target.workdir === params.workdir);
      }
      if (targets.length === 0) {
        return { content: [{ type: "text", text: "No managed worktrees matched the requested scope." }] };
      }

      const safeNow: string[] = [];
      const preserved: string[] = [];
      const cleaned: string[] = [];
      const failures: string[] = [];

      for (const target of targets) {
        const persisted = sessionManager.getPersistedSession(target.id)
          ?? (target.backendConversationId ? sessionManager.getPersistedSession(target.backendConversationId) : undefined)
          ?? (target.harnessSessionId ? sessionManager.getPersistedSession(target.harnessSessionId) : undefined)
          ?? sessionManager.getPersistedSession(target.name);
        const active = sessionManager.resolve(target.id)
          ?? (target.backendConversationId ? sessionManager.resolve(target.backendConversationId) : undefined)
          ?? (target.harnessSessionId ? sessionManager.resolve(target.harnessSessionId) : undefined)
          ?? sessionManager.resolve(target.name);

        const resolved = resolveWorktreeLifecycle({
          workdir: target.workdir,
          worktreePath: target.worktreePath,
          worktreeBranch: target.worktreeBranch,
          worktreeBaseBranch: params.base_branch ?? persisted?.worktreeBaseBranch,
          worktreePrTargetRepo: persisted?.worktreePrTargetRepo,
          worktreePushRemote: persisted?.worktreePushRemote,
          worktreePrUrl: persisted?.worktreePrUrl,
          worktreePrNumber: persisted?.worktreePrNumber,
          worktreeLifecycle: persisted?.worktreeLifecycle,
        }, {
          activeSession: Boolean(active && (active.status === "starting" || active.status === "running")),
          includePrSync: Boolean(persisted?.worktreeLifecycle?.state === "pr_open" || persisted?.worktreePrUrl),
        });

        if (!resolved.cleanupSafe) {
          if (includeRetained) {
            const retainedReasons = resolved.reasons.length > 0
              ? resolved.reasons.map(formatReason).join(", ")
              : formatLifecycleState(resolved.derivedState);
            preserved.push(`${target.name} [kept: ${retainedReasons}]`);
          }
          continue;
        }

        safeNow.push(`${target.name} (${formatLifecycleState(resolved.derivedState)})`);
        if (dryRun) continue;

        try {
          const repoDir = target.workdir;
          const nativeBackendWorktree = Boolean((persisted ?? active) && usesNativeBackendWorktree((persisted ?? active)!));
          if (!nativeBackendWorktree && target.worktreePath) {
            removeWorktree(repoDir, target.worktreePath, { destructive: false });
          }
          if (target.worktreeBranch) {
            deleteBranch(repoDir, target.worktreeBranch);
          }
          if (persisted) {
            const nextLifecycleState = resolved.derivedState === "merged" || resolved.derivedState === "released"
              ? resolved.derivedState
              : resolved.lifecycle.state;
            sessionManager.updatePersistedSession(target.id, {
              worktreePath: undefined,
              worktreeBranch: undefined,
              worktreeState: "none",
              worktreeMerged: nextLifecycleState === "merged" ? true : persisted.worktreeMerged,
              worktreeMergedAt: nextLifecycleState === "merged" ? (persisted.worktreeMergedAt ?? new Date().toISOString()) : persisted.worktreeMergedAt,
              worktreeLifecycle: {
                ...(persisted.worktreeLifecycle ?? resolved.lifecycle),
                state: nextLifecycleState,
                updatedAt: new Date().toISOString(),
                resolvedAt: (persisted.worktreeLifecycle?.resolvedAt ?? new Date().toISOString()),
                resolutionSource: persisted.worktreeLifecycle?.resolutionSource ?? "maintenance",
                baseBranch: params.base_branch ?? resolved.lifecycle.baseBranch ?? persisted.worktreeBaseBranch,
                targetRepo: persisted.worktreePrTargetRepo,
                pushRemote: persisted.worktreePushRemote,
                notes: resolved.reasons,
              },
            });
          }
          cleaned.push(`${target.name} (${formatLifecycleState(resolved.derivedState)})`);
        } catch (err) {
          failures.push(`${target.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const lines = [
        mode === "clean_safe"
          ? "Clean all safe:"
          : (mode === "preview_all" ? "Worktree lifecycle review:" : "Clean all safe preview:"),
      ];
      lines.push(`  SAFE ${dryRun ? "NOW" : "FOUND"} (${safeNow.length}): ${safeNow.join(", ") || "(none)"}`);
      if (includeRetained) {
        lines.push(`  KEPT (${preserved.length}): ${preserved.join(", ") || "(none)"}`);
      }
      if (!dryRun) {
        lines.push(`  CLEANED (${cleaned.length}): ${cleaned.join(", ") || "(none)"}`);
        lines.push(`  FAILURES (${failures.length}): ${failures.join(", ") || "(none)"}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  };
}
