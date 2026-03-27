/**
 * Claude Code harness — wraps @anthropic-ai/claude-agent-sdk and emits the
 * plugin's structured backend/run event model.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  PendingInputState,
  PlanArtifact,
} from "../types";
import type {
  AgentHarness,
  HarnessLaunchOptions,
  HarnessSession,
  HarnessMessage,
} from "./types";

type ClaudeQueryHandle = AsyncIterable<unknown> & {
  setPermissionMode?: (mode: string) => Promise<void>;
  streamInput?: (input: AsyncIterable<SDKUserMessage>) => Promise<void>;
  interrupt?: () => Promise<void>;
};

interface ClaudeAssistantTextBlock {
  type: "text";
  text: string;
}

interface ClaudeAssistantToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

interface ClaudeMessageEnvelope {
  type?: string;
  subtype?: string;
  session_id?: string;
  permissionMode?: string;
  message?: { content?: Array<ClaudeAssistantTextBlock | ClaudeAssistantToolUseBlock> };
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  result?: string;
}

function buildPendingInputState(
  sessionId: string,
  requestId: number,
  input: Record<string, unknown>,
): PendingInputState {
  const questions = Array.isArray((input as { questions?: unknown[] }).questions)
    ? (input as { questions: Array<Record<string, unknown>> }).questions
    : [];
  const first = questions[0] ?? {};
  const promptText = typeof first.question === "string" ? first.question : undefined;
  const options = Array.isArray(first.options)
    ? first.options
        .map((option) => {
          if (!option || typeof option !== "object") return "";
          const label = (option as { label?: unknown }).label;
          return typeof label === "string" ? label : "";
        })
        .filter(Boolean)
    : [];

  return {
    requestId: `${sessionId || "claude"}-ask-${requestId}`,
    kind: "question",
    promptText,
    options,
    allowsFreeText: options.length === 0 || first.multiSelect === true,
  };
}

export class ClaudeCodeHarness implements AgentHarness {
  readonly name = "claude-code";
  readonly backendKind = "claude-code" as const;
  readonly supportedPermissionModes = [
    "default",
    "plan",
    "bypassPermissions",
  ] as const;
  readonly capabilities = {
    nativePendingInput: false,
    nativePlanArtifacts: false,
    worktrees: "plugin-managed",
    nativeWorktreeRestore: false,
  } as const;

  /** Launch a Claude Code session and adapt SDK messages into structured events. */
  launch(options: HarnessLaunchOptions): HarnessSession {
    const queue: HarnessMessage[] = [];
    let queueResolve: (() => void) | null = null;
    let queueDone = false;
    let sawRunOutput = false;
    let currentTurnText = "";
    let sawPlanGateSignal = false;
    let requestCounter = 0;
    let currentSessionId = options.resumeSessionId ?? "";

    const flushResolve = (): void => {
      if (queueResolve) {
        queueResolve();
        queueResolve = null;
      }
    };

    const enqueue = (message: HarnessMessage): void => {
      queue.push(message);
      flushResolve();
    };

    const endQueue = (): void => {
      queueDone = true;
      flushResolve();
    };

    const canUseToolCallback = options.canUseTool;
    const sdkOptions: Record<string, unknown> = {
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: (() => {
        try {
          const req = createRequire(import.meta.url);
          const sdkMain = req.resolve("@anthropic-ai/claude-agent-sdk");
          return join(dirname(sdkMain), "cli.js");
        } catch {
          const thisDir = dirname(fileURLToPath(import.meta.url));
          return join(thisDir, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js");
        }
      })(),
      allowedTools: options.allowedTools,
      systemPrompt: options.systemPrompt,
      includePartialMessages: true,
      abortController: options.abortController,
      mcpServers: options.mcpServers,
      ...(canUseToolCallback
        ? {
            canUseTool: async (toolName: string, input: Record<string, unknown>) => {
              if (toolName !== "AskUserQuestion") {
                return { behavior: "allow" as const };
              }
              const state = buildPendingInputState(currentSessionId, ++requestCounter, input);
              enqueue({ type: "pending_input", state });
              try {
                const result = await canUseToolCallback(toolName, input);
                enqueue({ type: "pending_input_resolved", requestId: state.requestId });
                return result;
              } catch (error) {
                enqueue({ type: "pending_input_resolved", requestId: state.requestId });
                throw error;
              }
            },
          }
        : {}),
    };

    if (options.resumeSessionId) {
      sdkOptions.resume = options.resumeSessionId;
      sdkOptions.forkSession = options.forkSession ?? false;
    }

    const q = query({
      prompt: options.prompt as string | AsyncIterable<SDKUserMessage>,
      options: sdkOptions,
    }) as ClaudeQueryHandle;

    void (async () => {
      try {
        for await (const raw of q) {
          const msg = raw as ClaudeMessageEnvelope;
          if (msg.type === "system" && msg.subtype === "init") {
            currentSessionId = msg.session_id ?? currentSessionId;
            enqueue({
              type: "backend_ref",
              ref: {
                kind: "claude-code",
                conversationId: currentSessionId,
              },
            });
            continue;
          }

          if (msg.type === "system" && msg.subtype === "status" && msg.permissionMode) {
            enqueue({ type: "settings_changed", permissionMode: msg.permissionMode });
            continue;
          }

          if (msg.type === "assistant") {
            if (!sawRunOutput) {
              sawRunOutput = true;
              enqueue({ type: "run_started" });
            }
            for (const block of msg.message?.content ?? []) {
              if (block.type === "text") {
                currentTurnText += currentTurnText ? `\n${block.text}` : block.text;
                enqueue({ type: "text_delta", text: block.text });
                continue;
              }

              if (block.type === "tool_use") {
                if (block.name === "ExitPlanMode" || block.name === "set_permission_mode") {
                  sawPlanGateSignal = true;
                }
                if (block.name !== "AskUserQuestion") {
                  enqueue({ type: "tool_call", name: block.name, input: block.input });
                }
              }
            }
            continue;
          }

          if (msg.type === "result") {
            const finalizedPlanText = currentTurnText.trim();
            if (
              finalizedPlanText &&
              (options.permissionMode === "plan" || sawPlanGateSignal)
            ) {
              const artifact: PlanArtifact = {
                explanation: undefined,
                steps: [],
                markdown: finalizedPlanText,
              };
              enqueue({ type: "plan_artifact", artifact, finalized: true });
            }

            enqueue({
              type: "run_completed",
              data: {
                success: msg.subtype === "success",
                duration_ms: msg.duration_ms ?? 0,
                total_cost_usd: msg.total_cost_usd ?? 0,
                num_turns: msg.num_turns ?? 0,
                result: msg.result,
                session_id: msg.session_id ?? currentSessionId,
              },
            });
            currentTurnText = "";
            sawPlanGateSignal = false;
            sawRunOutput = false;
          }
        }
      } finally {
        endQueue();
      }
    })().catch((error: unknown) => {
      enqueue({
        type: "run_completed",
        data: {
          success: false,
          duration_ms: 0,
          total_cost_usd: 0,
          num_turns: 0,
          result: error instanceof Error ? error.message : String(error),
          session_id: currentSessionId,
        },
      });
      endQueue();
    });

    return {
      messages: (async function* (): AsyncGenerator<HarnessMessage> {
        while (true) {
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          if (queueDone) return;
          await new Promise<void>((resolve) => {
            queueResolve = resolve;
          });
        }
      })(),

      async setPermissionMode(mode: string): Promise<void> {
        if (typeof q.setPermissionMode === "function") {
          await q.setPermissionMode(mode);
        }
      },

      async streamInput(input: AsyncIterable<unknown>): Promise<void> {
        if (typeof q.streamInput === "function") {
          await q.streamInput(input as AsyncIterable<SDKUserMessage>);
        }
      },

      async interrupt(): Promise<void> {
        if (typeof q.interrupt === "function") {
          await q.interrupt();
        }
      },
    };
  }

  /** Build the multi-turn user-message payload expected by Claude Code SDK. */
  buildUserMessage(text: string, sessionId: string): SDKUserMessage {
    return {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }
}
