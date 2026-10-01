import { resolveAllowedModelsForHarness, resolveDefaultModelForHarness } from "../config";
import { getManagedTaskFlowRuntime } from "../runtime-store";
import { Type } from "../tool-parameter-schema";

const SCHEMA = "openclaw-code-agent.runtime-policy.v1";

/** Read only the already-bound runtime; never initialize services to diagnose them. */
export function makeAgentRuntimePolicyTool(isRuntimeReady: () => boolean) {
  return {
    name: "agent_runtime_policy",
    description: "Read the loaded Codex default model, model allowlist, and native task-mirror availability without starting a session.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id: string, _params: Record<string, never>) {
      if (!isRuntimeReady()) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ schema: SCHEMA, ready: false }) }],
        };
      }

      const allowedModels = resolveAllowedModelsForHarness("codex");
      const policy = {
        schema: SCHEMA,
        ready: true,
        codex: {
          defaultModel: resolveDefaultModelForHarness("codex") ?? null,
          allowedModels: allowedModels ? [...allowedModels] : null,
        },
        managedTaskMirror: {
          available: typeof getManagedTaskFlowRuntime()?.fromToolContext === "function",
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(policy) }] };
    },
  };
}
