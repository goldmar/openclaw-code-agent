import { existsSync } from "fs";
import {
  getDefaultHarnessName,
  parseThreadIdFromSessionKey,
  pluginConfig,
  resolveAgentChannel,
  resolveAllowedModelsForHarness,
  resolveDefaultModelForHarness,
  resolveOriginChannel,
  resolveOriginThreadId,
  resolveReasoningEffortForHarness,
  resolveSessionRoute,
  resolveToolChannel,
} from "../config";
import { decideResumeSessionId } from "../resume-policy";
import { getBackendConversationId, getPrimarySessionLookupRef } from "../session-backend-ref";
import type { OpenClawPluginToolContext, PersistedSessionInfo } from "../types";

export interface AgentLaunchParams {
  prompt: string;
  name?: string;
  workdir?: string;
  model?: string;
  system_prompt?: string;
  allowed_tools?: string[];
  resume_session_id?: string;
  fork_session?: boolean;
  force_new_session?: boolean;
  permission_mode?: "default" | "plan" | "bypassPermissions";
  plan_approval?: "ask" | "delegate" | "approve";
  harness?: string;
  worktree_strategy?: "off" | "manual" | "ask" | "delegate" | "auto-merge" | "auto-pr";
  worktree_base_branch?: string;
  worktree_pr_target_repo?: string;
  agentId?: string;
}

type LinkedSessionMatch = {
  ref: string;
  name: string;
  status: string;
  lifecycle?: string;
  resumable: boolean;
};

type SessionManagerLike = {
  list?: (filter?: "all") => Array<{
    id: string;
    name: string;
    status: string;
    lifecycle?: string;
    isExplicitlyResumable?: boolean;
    workdir: string;
    originSessionKey?: string;
    originChannel?: string;
    originThreadId?: string | number;
  }>;
  listPersistedSessions?: () => PersistedSessionInfo[];
  resolve?: (ref: string) => {
    backendConversationId?: string;
    harnessSessionId?: string;
  } | undefined;
  getPersistedSession?: (ref: string) => Pick<PersistedSessionInfo, "harness" | "backendRef"> | undefined;
  resolveBackendConversationId?: (ref: string) => string | undefined;
  resolveHarnessSessionId?: (ref: string) => string | undefined;
};

export type AgentLaunchResolution =
  | { kind: "error"; text: string }
  | { kind: "blocked"; text: string }
  | {
      kind: "resolved";
      workdir: string;
      harness: string;
      resolvedModel: string;
      permissionMode: "default" | "plan" | "bypassPermissions";
      planApproval: "ask" | "delegate" | "approve";
      originChannel: string;
      originThreadId?: string | number;
      originSessionKey?: string;
      route: ReturnType<typeof resolveSessionRoute>;
      resumeSessionId?: string;
      resolvedResumeId?: string;
      clearedPersistedCodexResume: boolean;
      reasoningEffort?: ReturnType<typeof resolveReasoningEffortForHarness>;
    };

function normalizeThreadId(value: unknown): string | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function stripOptionalQuotes(value: string): string {
  return value.trim().replace(/^['"`](.*)['"`]$/s, "$1").trim();
}

export function extractPromptDeclaredWorkdir(prompt: string): string | undefined {
  const headerBlock = prompt
    .split(/\n\s*\n/, 1)[0]
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean) ?? [];

  if (headerBlock.length === 0) return undefined;

  for (const line of headerBlock) {
    const match = line.match(/^(Workdir|Repo):\s*(.+)$/);
    const candidate = stripOptionalQuotes(match?.[2] ?? "");
    if (candidate.startsWith("/") && existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function routeMatchesSession(
  session: {
    workdir?: string;
    originSessionKey?: string;
    originChannel?: string;
    originThreadId?: string | number;
  },
  route: {
    workdir: string;
    originSessionKey?: string;
    originChannel?: string;
    originThreadId?: string | number;
  },
): boolean {
  if (session.workdir !== route.workdir) return false;
  if (route.originSessionKey && session.originSessionKey) {
    return session.originSessionKey === route.originSessionKey;
  }
  if (!route.originChannel || !session.originChannel) return false;
  return session.originChannel === route.originChannel
    && normalizeThreadId(session.originThreadId) === normalizeThreadId(route.originThreadId);
}

function summarizeLinkedSessions(matches: LinkedSessionMatch[]): string {
  return matches
    .slice(0, 3)
    .map((match) => `  - ${match.name} [${match.ref}] | status=${match.status}${match.lifecycle ? ` | lifecycle=${match.lifecycle}` : ""}`)
    .join("\n");
}

function findLinkedSessionMatches(
  sessions: Pick<SessionManagerLike, "list" | "listPersistedSessions">,
  route: {
    workdir: string;
    originSessionKey?: string;
    originChannel?: string;
    originThreadId?: string | number;
  },
): { resumable: LinkedSessionMatch[]; active: LinkedSessionMatch[] } {
  const resumable: LinkedSessionMatch[] = [];
  const active: LinkedSessionMatch[] = [];
  const seen = new Set<string>();

  for (const session of sessions.list?.("all") ?? []) {
    if (!routeMatchesSession(session, route)) continue;
    const key = session.id;
    if (seen.has(key)) continue;
    seen.add(key);
    if (session.isExplicitlyResumable) {
      resumable.push({
        ref: session.id,
        name: session.name,
        status: session.status,
        lifecycle: session.lifecycle,
        resumable: true,
      });
      continue;
    }
    if (session.status === "starting" || session.status === "running") {
      active.push({
        ref: session.id,
        name: session.name,
        status: session.status,
        lifecycle: session.lifecycle,
        resumable: false,
      });
    }
  }

  for (const session of sessions.listPersistedSessions?.() ?? []) {
    if (!session.resumable) continue;
    if (!routeMatchesSession(session, route)) continue;
    const ref = getPrimarySessionLookupRef(session) ?? session.harnessSessionId;
    const key = session.sessionId ?? getBackendConversationId(session) ?? session.harnessSessionId;
    if (!ref || !key || seen.has(key)) continue;
    seen.add(key);
    resumable.push({
      ref,
      name: session.name,
      status: session.status,
      lifecycle: session.lifecycle,
      resumable: true,
    });
  }

  return { resumable, active };
}

function isModelAllowed(model: string | undefined, allowedModels: string[] | undefined): boolean {
  if (!allowedModels || allowedModels.length === 0) return true;
  if (!model) return false;
  const modelLower = model.toLowerCase();
  return allowedModels.some((pattern) => modelLower.includes(pattern.toLowerCase()));
}

export function resolveAgentLaunchRequest(
  params: AgentLaunchParams,
  ctx: OpenClawPluginToolContext,
  sessionManager: SessionManagerLike,
): AgentLaunchResolution {
  const workdir = params.workdir
    || extractPromptDeclaredWorkdir(params.prompt)
    || ctx.workspaceDir
    || pluginConfig.defaultWorkdir
    || process.cwd();

  if (!existsSync(workdir)) {
    return { kind: "error", text: `Error: Working directory does not exist: ${workdir}` };
  }

  const harness = params.harness ?? getDefaultHarnessName();
  const defaultModel = resolveDefaultModelForHarness(harness);
  const resolvedModel = params.model ?? defaultModel;
  const wasExplicitModel = params.model !== undefined;
  if (!resolvedModel) {
    return {
      kind: "error",
      text: `Error: No default model configured for harness "${harness}". Set plugins.entries["openclaw-code-agent"].config.harnesses.${harness}.defaultModel or pass model explicitly.`,
    };
  }

  const allowedModels = resolveAllowedModelsForHarness(harness);
  if (allowedModels && allowedModels.length > 0 && !isModelAllowed(resolvedModel, allowedModels)) {
    return {
      kind: "error",
      text: wasExplicitModel
        ? `Error: Model "${resolvedModel}" is not allowed. Permitted models: ${allowedModels.join(", ")}`
        : `Error: Default model "${resolvedModel || "undefined"}" is not in allowedModels (${allowedModels.join(", ")}). Update your plugin config to set a compatible defaultModel.`,
    };
  }

  const ctxChannel = resolveToolChannel(ctx);
  const originChannel = resolveOriginChannel(ctx, ctxChannel || resolveAgentChannel(workdir));
  const originSessionKey = ctx.sessionKey || undefined;
  const originThreadId = parseThreadIdFromSessionKey(originSessionKey) ?? resolveOriginThreadId(ctx);

  if (!params.resume_session_id && !params.force_new_session) {
    const linked = findLinkedSessionMatches(sessionManager, {
      workdir,
      originSessionKey,
      originChannel,
      originThreadId,
    });
    if (linked.resumable.length > 0 || linked.active.length > 0) {
      const resumableText = linked.resumable.length > 0
        ? [
            `Linked resumable session(s) already exist for this thread/workdir:`,
            summarizeLinkedSessions(linked.resumable),
            ``,
            `Resume the latest one with:`,
            `  agent_respond(session='${linked.resumable[0].ref}', message='<next instruction>')`,
            `Fork from it with:`,
            `  agent_launch(prompt='<new task>', resume_session_id='${linked.resumable[0].ref}', fork_session=true)`,
          ].join("\n")
        : "";
      const activeText = linked.active.length > 0
        ? [
            linked.resumable.length > 0 ? `Linked active session(s):` : `Linked active session(s) already exist for this thread/workdir:`,
            summarizeLinkedSessions(linked.active),
            ``,
            `Send a follow-up instead of launching a duplicate:`,
            `  agent_respond(session='${linked.active[0].ref}', message='<next instruction>')`,
          ].join("\n")
        : "";
      return {
        kind: "blocked",
        text: [
          `Resume-first protection blocked a fresh launch.`,
          ``,
          resumableText,
          activeText,
          [
            `If you intentionally want a brand-new independent session here, call:`,
            `  agent_launch(prompt='<new task>', force_new_session=true)`,
          ].join("\n"),
        ].filter(Boolean).join("\n\n"),
      };
    }
  }

  let resolvedResumeId = params.resume_session_id;
  const activeResumeSession = resolvedResumeId
    ? sessionManager.resolve?.(resolvedResumeId)
    : undefined;
  const persistedResumeSession = resolvedResumeId
    ? sessionManager.getPersistedSession?.(resolvedResumeId)
    : undefined;
  if (resolvedResumeId) {
    const resolved = sessionManager.resolveBackendConversationId?.(resolvedResumeId)
      ?? sessionManager.resolveHarnessSessionId?.(resolvedResumeId);
    if (!resolved) {
      return {
        kind: "error",
        text: `Error: Could not resolve resume_session_id "${resolvedResumeId}" to a session ID. Use agent_sessions to list available sessions.`,
      };
    }
    resolvedResumeId = resolved;
  }

  const { resumeSessionId, clearedPersistedCodexResume } = decideResumeSessionId({
    requestedResumeSessionId: resolvedResumeId,
    activeSession: activeResumeSession
      ? { harnessSessionId: activeResumeSession.backendConversationId ?? activeResumeSession.harnessSessionId }
      : undefined,
    persistedSession: persistedResumeSession
      ? { harness: persistedResumeSession.harness, backendRef: persistedResumeSession.backendRef }
      : undefined,
  });

  const permissionMode = params.permission_mode ?? pluginConfig.permissionMode;
  const planApproval = params.plan_approval ?? pluginConfig.planApproval;

  return {
    kind: "resolved",
    workdir,
    harness,
    resolvedModel,
    permissionMode,
    planApproval,
    originChannel,
    originThreadId,
    originSessionKey,
    route: resolveSessionRoute(ctx, originChannel, originSessionKey),
    resumeSessionId,
    resolvedResumeId,
    clearedPersistedCodexResume,
    reasoningEffort: resolveReasoningEffortForHarness(harness),
  };
}
