import { branchNameValidationError, targetRepoValidationError } from "../worktree-ref-validation";
import { REASONING_EFFORTS, type ReasoningEffort } from "../types";
import { Type } from "../tool-parameter-schema";
import { sessionManager } from "../singletons";
import { formatLaunchSummaryFromSession, type LaunchSummarySessionLike } from "../launch-summary";
import {
  pluginConfig,
  resolveReasoningEffortForHarness,
} from "../config";
import { assessResumeCandidate } from "../session-resume";
import type { OpenClawPluginToolContext, PersistedSessionInfo } from "../types";
import {
  resolveAgentLaunchRequest,
  type AgentLaunchParams,
} from "./agent-launch-resolution";
import { resolveSessionTaskLifecycle } from "../session-task-lifecycle";
import { buildResumedPlanState } from "../plan-decision-state";
import { createLogger } from "../logger";
import { awaitLaunchEarlyOutcome } from "./launch-early-outcome";

const log = createLogger("agent-launch");

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resumeTargetRef(target: PersistedSessionInfo | { id: string; name: string } | undefined, fallback?: string): string {
  if (!target) return fallback ?? "unknown-session";
  return ("id" in target ? target.id : target.sessionId) ?? fallback ?? "unknown-session";
}

function isAgentLaunchParams(value: unknown): value is AgentLaunchParams {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.prompt === "string"
    && (p.reasoning_effort === undefined || REASONING_EFFORTS.includes(p.reasoning_effort as ReasoningEffort));
}


function hasFormatLaunchResult(value: unknown): value is {
  formatLaunchResult: (config: {
    prompt: string;
    workdir: string;
    harness: string;
    permissionMode: "default" | "plan" | "bypassPermissions";
    planApproval: "ask" | "delegate" | "approve";
    forceNewSession?: boolean;
    resumeSessionId?: string;
    resumeSessionName?: string;
    forkSession?: boolean;
    rewindTurns?: number;
  }, session: LaunchSummarySessionLike) => string;
} {
  return !!value
    && typeof value === "object"
    && typeof (value as { formatLaunchResult?: unknown }).formatLaunchResult === "function";
}

type RepoPolicyLaunchCheck = { ok: true; resolution: unknown } | { ok: false; text: string };

function hasRequestRepoPolicyForLaunch(value: unknown): value is {
  checkRepoPolicyForLaunch: (
    workdir: string,
    requestedStrategy?: "off" | "manual" | "ask" | "delegate" | "auto-merge" | "auto-pr",
  ) => RepoPolicyLaunchCheck | Promise<RepoPolicyLaunchCheck>;
  requestRepoPolicyForLaunch: (args: {
    route?: Record<string, unknown>;
    prompt: string;
    workdir: string;
    name?: string;
    model?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    systemPrompt?: string;
    allowedTools?: string[];
    resumeSessionId?: string;
    resumedFromSessionName?: string;
    resumeWorktreeFrom?: string;
    sessionIdOverride?: string;
    rewindTurns?: number;
    forkSession?: boolean;
    forceNewSession?: boolean;
    permissionMode?: "default" | "plan" | "bypassPermissions";
    planApproval?: "ask" | "delegate" | "approve";
    harness?: string;
    worktreeStrategy?: "off" | "manual" | "ask" | "delegate" | "auto-merge" | "auto-pr";
    worktreeBaseBranch?: string;
    worktreePrTargetRepo?: string;
    originAgentId?: string;
  }) => string | Promise<string>;
} {
  return !!value
    && typeof value === "object"
    && typeof (value as { checkRepoPolicyForLaunch?: unknown }).checkRepoPolicyForLaunch === "function"
    && typeof (value as { requestRepoPolicyForLaunch?: unknown }).requestRepoPolicyForLaunch === "function";
}

/** Register the `agent_launch` tool factory. */
export function makeAgentLaunchTool(ctx: OpenClawPluginToolContext) {
  return {
    name: "agent_launch",
    description:
      "Start a coding agent session in the background. Sessions keep their conversation: continue one with agent_respond instead of launching again.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Task for the agent" }),
      name: Type.Optional(Type.String({ description: "Short kebab-case name (default: from the prompt)" })),
      workdir: Type.Optional(Type.String({ description: "Repository directory (default: the configured workdir)" })),
      model: Type.Optional(Type.String({ description: "Default: the harness default" })),
      reasoning_effort: Type.Optional(Type.StringEnum(
        REASONING_EFFORTS,
        { description: "Default: the resumed session's, else the harness default" },
      )),
      system_prompt: Type.Optional(Type.String({ description: "Extra system prompt" })),
      allowed_tools: Type.Optional(Type.Array(Type.String())),
      resume_session_id: Type.Optional(Type.String({ description: "Session to continue (or fork with fork_session=true)" })),
      fork_session: Type.Optional(Type.Boolean({ description: "With resume_session_id: start a new session from its context" })),
      rewind_turns: Type.Optional(
        Type.Number({ minimum: 1, description: "With resume_session_id: drop the last N turns first (Codex, Claude Code; OpenCode only with fork_session=true, which keeps the original). Files are not reverted." }),
      ),
      force_new_session: Type.Optional(Type.Boolean({ description: "Start a new session even if a linked one could be resumed" })),
      permission_mode: Type.Optional(
        Type.StringEnum(["default", "plan", "bypassPermissions"],
          { description: "'plan': the agent plans first; work starts after approval. 'default': no plan gate; the harness's own permission rules apply (Claude Code allows tools, Codex follows its sandbox settings, OpenCode asks). 'bypassPermissions': no gate, no prompts. Default: plugin config (plan)." },
        ),
      ),
      plan_approval: Type.Optional(
        Type.StringEnum(["ask", "delegate", "approve"],
          { description: "Who approves plans. 'ask': the user, with buttons. 'delegate': you review; approve or agent_escalate. 'approve': you may approve after checking the full plan. Default: plugin config (delegate)." },
        ),
      ),
      harness: Type.Optional(Type.String({ description: "claude-code, codex or opencode (default: plugin config)" })),
      worktree_strategy: Type.Optional(
        Type.StringEnum(["off", "manual", "ask", "delegate", "auto-merge", "auto-pr"],
          { description: "Branch isolation. 'delegate': you decide merge or escalate. 'ask': the user gets Merge / PR buttons. 'auto-merge', 'auto-pr': automatic. 'manual': kept for later. 'off': work in the checkout. Default: plugin config (delegate)." },
        ),
      ),
      worktree_base_branch: Type.Optional(Type.String({ description: "Branch to merge or PR into (default: detected)" })),
      worktree_pr_target_repo: Type.Optional(Type.String({ description: "owner/repo for cross-fork PRs (default: the upstream remote, else origin)" })),
    }),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return { content: [{ type: "text", text: "Error: SessionManager not initialized. The code-agent service must be running." }] };
      }
      if (!isAgentLaunchParams(params)) {
        return { content: [{ type: "text", text: "Error: Invalid parameters. Expected at least { prompt }." }] };
      }

      if (params.worktree_base_branch !== undefined) {
        const branchError = await branchNameValidationError(params.worktree_base_branch);
        if (branchError) return { content: [{ type: "text", text: `Error: ${branchError}` }] };
      }
      if (params.worktree_pr_target_repo !== undefined) {
        const repoError = targetRepoValidationError(params.worktree_pr_target_repo);
        if (repoError) return { content: [{ type: "text", text: `Error: worktree_pr_target_repo: ${repoError}` }] };
      }

      // Guard: agentId is NOT a valid parameter for agent_launch. It belongs to sessions_spawn (OpenClaw sub-agents).
      // If present in params, it was passed by mistake — log a warning and ignore it.
      if (params.agentId) {
        log.warn(`[agent_launch] ⚠️ agentId="${params.agentId}" was passed as a parameter — this is WRONG. agentId is only for sessions_spawn (OpenClaw sub-agents), not agent_launch (CC sessions). The field is being ignored. ctx.agentId="${ctx.agentId}" will be used for origin routing instead.`);
      }

      try {
        const resolution = resolveAgentLaunchRequest(params, ctx, sessionManager);
        if (resolution.kind !== "resolved") {
          return { content: [{ type: "text", text: resolution.text }] };
        }
        const {
          workdir,
          harness,
          resolvedModel,
          permissionMode,
          planApproval,
          originChannel,
          originThreadId,
          originSessionKey,
          route,
          resumeSessionId,
          resolvedResumeId,
          rewindTurns,
          reasoningEffort,
          fastMode,
        } = resolution;
        const resumeTarget = params.resume_session_id
          ? sessionManager.resolve(params.resume_session_id) ?? sessionManager.getPersistedSession(params.resume_session_id)
          : undefined;
        const resumeAssessment = (!params.fork_session && resumeTarget)
          ? assessResumeCandidate(resumeTarget)
          : undefined;

        if (resumeAssessment?.kind === "direct") {
          return {
            content: [{
              type: "text",
              text: `Session ${resumeTarget!.name} [${resumeTargetRef(resumeTarget, params.resume_session_id)}] is already running. Use agent_respond(session='${params.resume_session_id}', message='<next instruction>') instead of agent_launch(resume_session_id=...).`,
            }],
          };
        }
        if (resumeAssessment?.kind === "unavailable") {
          return {
            content: [{
              type: "text",
              text: `Resume unavailable for session ${resumeTarget!.name} [${resumeTargetRef(resumeTarget, params.resume_session_id)}] (${resumeAssessment.reason}). Use agent_launch(prompt='<new task>') for a fresh session or set fork_session=true to fork from prior context.`,
            }],
          };
        }

        const persistedResumeIdentity = resumeTarget && "resumedFromSessionName" in resumeTarget
          ? resumeTarget.resumedFromSessionName
          : undefined;
        const resumedFromSessionName = resumeAssessment?.kind === "resume" && !params.fork_session
          ? persistedResumeIdentity ?? resumeTarget?.name
          : undefined;
        const launchName = resumedFromSessionName && !params.name
          ? resumedFromSessionName
          : params.name;
        const launchWorktreeStrategy = params.worktree_strategy ?? pluginConfig.defaultWorktreeStrategy ?? "off";
        const launchSessionIdOverride = !params.fork_session
          ? (resumeAssessment?.kind === "resume" || resumeAssessment?.kind === "relaunch"
            ? resumeAssessment.stableSessionId
            : undefined)
          : undefined;
        const resumedPlanState = resumeAssessment?.kind === "resume" && !params.fork_session && resumeTarget
          ? buildResumedPlanState(resumeTarget, permissionMode)
          : { permissionMode, approvalApplied: false, patch: {} };
        if (launchWorktreeStrategy !== "off" && hasRequestRepoPolicyForLaunch(sessionManager)) {
          const policyCheck = await sessionManager.checkRepoPolicyForLaunch(workdir, params.worktree_strategy);
          if (policyCheck.ok === false) {
            return {
              content: [{
                type: "text",
                text: await sessionManager.requestRepoPolicyForLaunch({
                  route,
                  prompt: params.prompt,
                  workdir,
                  name: launchName,
                  model: resolvedModel,
                  reasoningEffort,
                  fastMode,
                  systemPrompt: params.system_prompt,
                  allowedTools: params.allowed_tools,
                  resumeSessionId: resumeAssessment?.kind === "resume" ? resumeAssessment.resumeSessionId : resumeSessionId,
                  resumedFromSessionName,
                  resumeWorktreeFrom: launchSessionIdOverride ?? params.resume_session_id ?? resolvedResumeId,
                  sessionIdOverride: launchSessionIdOverride,
                  rewindTurns,
                  forkSession: resumeSessionId ? params.fork_session : false,
                  forceNewSession: params.force_new_session,
                  permissionMode,
                  planApproval,
                  harness,
                  worktreeStrategy: params.worktree_strategy,
                  worktreeBaseBranch: params.worktree_base_branch,
                  worktreePrTargetRepo: params.worktree_pr_target_repo,
                  originAgentId: ctx.agentId || undefined,
                }),
              }],
            };
          }
        }

        const session = await sessionManager.launchSession({
          prompt: params.prompt,
          sessionIdOverride: launchSessionIdOverride,
          name: launchName,
          workdir,
          model: resolvedModel,
          reasoningEffort,
          fastMode,
          systemPrompt: params.system_prompt,
          allowedTools: params.allowed_tools,
          resumeSessionId: resumeAssessment?.kind === "resume" ? resumeAssessment.resumeSessionId : resumeSessionId,
          resumedFromSessionName,
          // Worktree inheritance needs the original resolved session ref even when
          // backend resume state is intentionally cleared for a fresh launch.
          resumeWorktreeFrom: launchSessionIdOverride ?? params.resume_session_id ?? resolvedResumeId,
          forkSession: resumeSessionId ? params.fork_session : false,
          rewindTurns,
          multiTurn: true,
          permissionMode: resumedPlanState.permissionMode,
          planApproval,
          ...resumedPlanState.patch,
          originChannel,
          originThreadId,
          originAgentId: ctx.agentId || undefined,
          originSessionKey,
          route,
          harness,
          taskLifecycle: resolveSessionTaskLifecycle(ctx),
          worktreeStrategy: params.worktree_strategy,
          worktreeBaseBranch: params.worktree_base_branch,
          worktreePrTargetRepo: params.worktree_pr_target_repo,
        });
        const launchText = hasFormatLaunchResult(sessionManager)
          ? sessionManager.formatLaunchResult({
              prompt: params.prompt,
              workdir,
              harness,
              permissionMode: resumedPlanState.permissionMode,
              planApproval,
              forceNewSession: params.force_new_session,
              resumeSessionId: params.resume_session_id,
              resumeSessionName: resumedFromSessionName,
              forkSession: params.fork_session,
              rewindTurns,
            }, session)
          : formatLaunchSummaryFromSession({
              prompt: params.prompt,
              workdir,
              harness,
              permissionMode: resumedPlanState.permissionMode,
              planApproval,
              resumeSessionId: params.resume_session_id,
              resumeSessionName: resumedFromSessionName,
              forkSession: params.fork_session,
              forceNewSession: params.force_new_session,
              rewindTurns,
            }, {
              id: session.id,
              name: session.name,
              model: session.model,
              reasoningEffort: session.reasoningEffort ?? resolveReasoningEffortForHarness(harness),
              fastMode: session.fastMode ?? fastMode,
              worktreeStrategy: session.worktreeStrategy ?? params.worktree_strategy ?? pluginConfig.defaultWorktreeStrategy ?? "off",
              repoIntegrationPolicy: session.repoIntegrationPolicy,
              repoProvider: session.repoProvider,
              worktreePath: session.worktreePath,
              originalWorkdir: session.originalWorkdir,
            });

        const earlyOutcome = await awaitLaunchEarlyOutcome(session, originSessionKey);
        return {
          content: [{
            type: "text",
            text: earlyOutcome ? `${launchText}\n\n${earlyOutcome}` : launchText,
          }],
        };
      } catch (err: unknown) {
        const message = errorMessage(err);
        const hint = message.includes("Max sessions") ? "" : "\n\nUse agent_sessions to see active sessions and their status.";
        return { content: [{ type: "text", text: `Error launching session: ${message}${hint}` }] };
      }
    },
  };
}
