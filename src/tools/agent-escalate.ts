import { normalizeSessionReferenceParams, sessionReferenceProperties, requiredSessionReference } from "./session-reference-params";
import { sessionToolError, unknownSessionError } from "./session-tool-error";
import { Type } from "../tool-parameter-schema";
import { sessionManager } from "../singletons";
import type { OpenClawPluginToolContext } from "../types";

type EscalationKind = "plan" | "worktree";

interface AgentEscalateParams {
  ocaSessionId: string;
  kind: EscalationKind;
  summary: string;
}

function isAgentEscalateParams(value: unknown): value is AgentEscalateParams {
  if (!value || typeof value !== "object") return false;
  const params = value as Record<string, unknown>;
  return typeof params.ocaSessionId === "string"
    && (params.kind === "plan" || params.kind === "worktree")
    && typeof params.summary === "string"
    && params.summary.trim().length > 0;
}

/**
 * `agent_escalate`: hand a delegated decision to the user. `plan` posts the
 * Approve / Revise / Reject prompt for a session waiting on plan approval;
 * `worktree` posts the Merge / Open PR / Later / Discard prompt for a finished
 * worktree session.
 */
export function makeAgentEscalateTool(_ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_escalate",
    description:
      "Hand a decision to the user with buttons, once per decision. kind='plan': Approve/Revise/Reject for a session waiting on plan approval. kind='worktree': Merge/Open PR/Later/Discard for a finished worktree session. Then wait for the user.",
    parameters: Type.Object({
      ...sessionReferenceProperties(),
      kind: Type.StringEnum(["plan", "worktree"]),
      summary: Type.String({ description: "Shown to the user: why you escalate, what changes, risk, and open questions. A few short lines." }),
    }, requiredSessionReference),
    async execute(_id: string, params: unknown) {
      if (!sessionManager) {
        return sessionToolError("service_unavailable", "Error: SessionManager not initialized. The code-agent service must be running.");
      }
      const normalized = normalizeSessionReferenceParams(params);
      if (normalized.ok === false) return normalized.error;
      params = normalized.params;
      if (!isAgentEscalateParams(params)) {
        return sessionToolError("invalid_parameters", "Error: Invalid parameters. Expected { ocaSessionId, kind: 'plan' | 'worktree', summary }.");
      }
      const sm = sessionManager;
      const session = sm.resolve(params.ocaSessionId) ?? sm.getPersistedSession(params.ocaSessionId);
      if (!session) return unknownSessionError(params.ocaSessionId);
      const ref = "id" in session ? session.id : session.sessionId ?? session.backendRef?.conversationId ?? session.harnessSessionId;
      const text = params.kind === "plan"
        ? sm.requestPlanApprovalFromUser(ref, params.summary)
        : await sm.requestWorktreeDecisionFromUser(ref, params.summary);
      return {
        isError: text.startsWith("Error:"),
        content: [{ type: "text", text }],
      };
    },
  };
}
