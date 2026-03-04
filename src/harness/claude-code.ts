/**
 * Claude Code harness — wraps @anthropic-ai/claude-agent-sdk.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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

export class ClaudeCodeHarness implements AgentHarness {
  readonly name = "claude-code";

  readonly supportedPermissionModes = [
    "default",
    "plan",
    "acceptEdits",
    "bypassPermissions",
  ] as const;

  readonly questionToolNames = ["AskUserQuestion"] as const;
  readonly planApprovalToolNames = ["ExitPlanMode", "set_permission_mode"] as const;

  /** Launch a Claude Code session and adapt SDK messages into harness events. */
  launch(options: HarnessLaunchOptions): HarnessSession {
    const sdkOptions: Record<string, unknown> = {
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
      // Always bypass bwrap sandbox on this VPS — plan mode remains a behavioral
      // constraint (present plan, wait for approval) without filesystem restrictions
      allowDangerouslySkipPermissions: true,
      allowedTools: options.allowedTools,
      systemPrompt: options.systemPrompt,
      includePartialMessages: true,
      abortController: options.abortController,
      mcpServers: options.mcpServers,
    };

    if (options.resumeSessionId) {
      sdkOptions.resume = options.resumeSessionId;
      sdkOptions.forkSession = options.forkSession ?? false;
    }

    const q = query({
      prompt: options.prompt as string | AsyncIterable<SDKUserMessage>,
      options: sdkOptions,
    }) as ClaudeQueryHandle;

    return {
      messages: this.adaptMessages(q),

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

  // -- internal ----------------------------------------------------------------

  private async *adaptMessages(
    q: AsyncIterable<unknown>,
  ): AsyncGenerator<HarnessMessage> {
    for await (const raw of q) {
      const msg = raw as ClaudeMessageEnvelope;
      if (msg.type === "system" && msg.subtype === "init") {
        yield { type: "init", session_id: msg.session_id ?? "" };
      } else if (msg.type === "system" && msg.subtype === "status" && msg.permissionMode) {
        // Defensive: SDK does not currently emit system/status with permissionMode,
        // but future versions may. Keep this path so it activates automatically.
        yield { type: "permission_mode_change", mode: msg.permissionMode };
      } else if (msg.type === "assistant") {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text") {
            yield { type: "text", text: block.text };
          } else if (block.type === "tool_use") {
            yield { type: "tool_use", name: block.name, input: block.input };
          }
        }
      } else if (msg.type === "result") {
        yield {
          type: "result",
          data: {
            success: msg.subtype === "success",
            duration_ms: msg.duration_ms ?? 0,
            total_cost_usd: msg.total_cost_usd ?? 0,
            num_turns: msg.num_turns ?? 0,
            result: msg.result,
            session_id: msg.session_id ?? "",
          },
        };
      }
    }
  }
}
