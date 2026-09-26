import { branchNameValidationError } from "../worktree-ref-validation";
import { Type } from "../tool-parameter-schema";
import type { OpenClawPluginToolContext } from "../types";
import { sessionManager } from "../singletons";
import { deleteBranch, removeWorktree } from "../worktree";
import {
  formatWorktreeLifecycleState,
  formatWorktreePreserveReason,
  listWorktreeToolTargets,
  matchesWorktreeToolRef,
  resolveWorktreeToolLifecycle,
  resolveWorktreeToolTarget,
} from "./worktree-tool-context";

interface AgentWorktreeCleanupParams {
  workdir?: string;
  base_branch?: string;
  mode?: "preview_safe" | "clean_safe" | "preview_all";
  session?: string;
  dismiss_session?: boolean;
}

function isAgentWorktreeCleanupParams(value: unknown): value is AgentWorktreeCleanupParams {
  return Boolean(value) && typeof value === "object";
}

export function makeAgentWorktreeCleanupTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_worktree_cleanup",
    description: "Remove finished worktrees that are safe to delete (merged, released, no changes); never removes pending, dirty, PR-open or running ones. With session + dismiss_session=true, permanently discards that session's branch and worktree.",
    parameters: Type.Object({
      workdir: Type.Optional(Type.String({ description: "Only this repository" })),
      base_branch: Type.Optional(Type.String({ description: "Base branch for the merged check (default: detected)" })),
      mode: Type.Optional(Type.StringEnum(["preview_safe", "clean_safe", "preview_all"], {
        description: "clean_safe (default) removes; preview_safe lists what would be removed; preview_all also lists kept worktrees and why",
      })),
      session: Type.Optional(Type.String({ description: "Only this session" })),
      dismiss_session: Type.Optional(Type.Boolean({ description: "With session: delete its branch and worktree even if unmerged (cannot be undone)" })),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentWorktreeCleanupParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected { workdir?, base_branch?, mode?, session?, dismiss_session? }." }] };
      }

      if (params.base_branch !== undefined) {
        const branchError = await branchNameValidationError(params.base_branch);
        if (branchError) return { content: [{ type: "text", text: `Error: ${branchError}` }] };
      }

      const sessionRef = params.session;
      const mode = params.mode ?? "clean_safe";
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
        const { persistedSession: persisted, resolvedLifecycle: resolved } = await resolveWorktreeToolLifecycle(sessionManager, target, {
          baseBranch: params.base_branch,
        });

        if (!resolved.cleanupSafe) {
          if (includeRetained) {
            const retainedReasons = resolved.reasons.length > 0
              ? resolved.reasons.map(formatWorktreePreserveReason).join(", ")
              : formatWorktreeLifecycleState(resolved.derivedState);
            preserved.push(`${target.name} [kept: ${retainedReasons}]`);
          }
          continue;
        }

        safeNow.push(`${target.name} (${formatWorktreeLifecycleState(resolved.derivedState)})`);
        if (dryRun) continue;

        try {
          const repoDir = target.workdir;
          if (target.worktreePath) {
            await removeWorktree(repoDir, target.worktreePath, { destructive: false });
          }
          if (target.worktreeBranch) {
            await deleteBranch(repoDir, target.worktreeBranch);
          }
          if (persisted) {
            const nextLifecycleState = resolved.derivedState === "merged" || resolved.derivedState === "released"
              ? resolved.derivedState
              : resolved.lifecycle.state;
            const nowIso = new Date().toISOString();
            const legacyResolvedAt = nextLifecycleState === "merged"
              ? persisted.worktreeMergedAt
              : (nextLifecycleState === "dismissed" ? persisted.worktreeDismissedAt : undefined);
            sessionManager.updatePersistedSession(target.id, {
              worktreePath: undefined,
              worktreeBranch: undefined,
              lifecycle: "terminal",
              worktreeState: "none",
              pendingWorktreeDecisionSince: undefined,
              lastWorktreeReminderAt: undefined,
              worktreeDecisionSnoozedUntil: undefined,
              worktreeMerged: nextLifecycleState === "merged" ? true : persisted.worktreeMerged,
              worktreeMergedAt: nextLifecycleState === "merged" ? (persisted.worktreeMergedAt ?? nowIso) : persisted.worktreeMergedAt,
              worktreeLifecycle: {
                ...(persisted.worktreeLifecycle ?? resolved.lifecycle),
                state: nextLifecycleState,
                updatedAt: nowIso,
                resolvedAt: (persisted.worktreeLifecycle?.resolvedAt ?? legacyResolvedAt ?? nowIso),
                resolutionSource: persisted.worktreeLifecycle?.resolutionSource ?? "maintenance",
                baseBranch: params.base_branch ?? resolved.lifecycle.baseBranch ?? persisted.worktreeBaseBranch,
                targetRepo: persisted.worktreePrTargetRepo,
                pushRemote: persisted.worktreePushRemote,
                notes: resolved.reasons,
              },
            });
          }
          cleaned.push(`${target.name} (${formatWorktreeLifecycleState(resolved.derivedState)})`);
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
