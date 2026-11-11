import { normalizeSessionReferenceParams, sessionReferenceProperties, requiredSessionReference } from "./session-reference-params";
import { sessionToolError, unknownSessionError } from "./session-tool-error";
import { Type } from "../tool-parameter-schema";
import { sessionManager } from "../singletons";
import { parseTaskOutcomeInput, type TaskOutcomeReviewer } from "../session-task-outcome";
import type { OpenClawPluginToolContext } from "../types";

/** The orchestrator reviews receipts; this tool never runs commands supplied by a report. */
export function makeAgentReportOutcomeTool(ctx?: OpenClawPluginToolContext) {
  return {
    name: "agent_report_outcome",
    description: "Report a reviewed task outcome after execution ended. Read agent_output(full=true), review requested scope and check receipts, then report the exact executionCycle and current repository heads. Missing, failed, timed-out or unrun required checks prevent successful completion and integration prompts. This is a review attestation, not independent execution of the checks.",
    parameters: Type.Object({
      ...sessionReferenceProperties(),
      executionCycle: Type.Number({ description: "Exact execution cycle from agent_output or agent_sessions." }),
      task: Type.StringEnum(["completed", "incomplete", "blocked", "failed"]),
      checks: Type.Array(Type.Object({
        name: Type.String(), scope: Type.String(), required: Type.Boolean(),
        status: Type.StringEnum(["passed", "failed", "timed_out", "not_run", "not_applicable"]),
        stage: Type.String({ description: "What actually ran; distinguish prerequisites from file analysis." }),
        evidence: Type.String({ description: "Reviewed receipt reference, or explicit reason a check is not applicable." }),
        source: Type.StringEnum(["reviewed_receipt"], { description: "The orchestrator attests receipt review; OCA-verifier provenance is recorded internally by the goal controller." }),
        exitCode: Type.Optional(Type.Number()),
      }, { additionalProperties: false })),
      repositories: Type.Array(Type.Object({ workdir: Type.String(), head: Type.String({ description: "Full Git HEAD verified by the receipts." }) }, { additionalProperties: false })),
      blockers: Type.Array(Type.String()), remainingWork: Type.Array(Type.String()),
      summary: Type.String({ description: "Concise factual outcome, including incomplete work and blockers." }),
    }, { ...requiredSessionReference, additionalProperties: false }),
    async execute(_id: string, raw: unknown) {
      if (!sessionManager) return sessionToolError("service_unavailable", "Error: SessionManager not initialized.");
      const normalized = normalizeSessionReferenceParams(raw);
      if (normalized.ok === false) return normalized.error;
      const { ocaSessionId, ...input } = normalized.params;
      if (typeof ocaSessionId !== "string") return sessionToolError("invalid_parameters", "Error: Provide an exact OCA session reference.");
      const parsed = parseTaskOutcomeInput(input);
      if (parsed.ok === false) return sessionToolError("invalid_parameters", `Error: ${parsed.error}`);
      const sm = sessionManager;
      if (!sm.resolve(ocaSessionId) && !sm.getPersistedSession(ocaSessionId)) return unknownSessionError(ocaSessionId);
      const reviewer: TaskOutcomeReviewer = { source: "orchestrator", ...(ctx?.sessionKey ? { sessionKey: ctx.sessionKey } : {}) };
      const text = await sm.reportTaskOutcome(ocaSessionId, parsed.value, reviewer);
      return { isError: text.startsWith("Error:"), content: [{ type: "text", text }] };
    },
  };
}
