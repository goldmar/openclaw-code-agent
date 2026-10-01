import { resolveAllowedModelsForHarness, resolveDefaultModelForHarness } from "../config";
import { Type } from "../tool-parameter-schema";

const SCHEMA = "openclaw-code-agent.runtime-policy.v1";

export function readCodexRuntimePolicy() {
  const allowedModels = resolveAllowedModelsForHarness("codex");
  return {
    defaultModel: resolveDefaultModelForHarness("codex") ?? null,
    allowedModels: allowedModels ? [...allowedModels] : null,
  };
}

/** Read only the already-bound runtime; never initialize services to diagnose them. */
export function makeAgentRuntimePolicyTool(readLoadedPolicy: () => ReturnType<typeof readCodexRuntimePolicy> | undefined) {
  return {
    name: "agent_runtime_policy",
    description: "Read the loaded Codex default model, model allowlist, and native task-mirror availability without starting a session.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id: string, _params: Record<string, never>) {
      const codex = readLoadedPolicy();
      if (!codex) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ schema: SCHEMA, ready: false }) }],
        };
      }

      const policy = {
        schema: SCHEMA,
        ready: true,
        codex,
        managedTaskMirror: {
          // Native task mirroring was removed for OpenClaw 2026.9.7.
          available: false,
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(policy) }] };
    },
  };
}
