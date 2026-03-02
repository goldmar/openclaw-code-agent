/**
 * Claude Code harness — wraps @anthropic-ai/claude-agent-sdk.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentHarness,
  HarnessLaunchOptions,
  HarnessSession,
  HarnessMessage,
} from "./types";

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

  launch(options: HarnessLaunchOptions): HarnessSession {
    const sdkOptions: any = {
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
      allowDangerouslySkipPermissions:
        options.permissionMode === "bypassPermissions",
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

    const q = query({ prompt: options.prompt, options: sdkOptions });

    return {
      messages: this.adaptMessages(q),

      async setPermissionMode(mode: string): Promise<void> {
        if (typeof (q as any).setPermissionMode === "function") {
          await (q as any).setPermissionMode(mode);
        }
      },

      async streamInput(input: AsyncIterable<any>): Promise<void> {
        if (typeof (q as any).streamInput === "function") {
          await (q as any).streamInput(input);
        }
      },

      async interrupt(): Promise<void> {
        if (typeof (q as any).interrupt === "function") {
          await (q as any).interrupt();
        }
      },
    };
  }

  buildUserMessage(text: string, sessionId: string): any {
    return {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }

  // -- internal ----------------------------------------------------------------

  private async *adaptMessages(
    q: AsyncIterable<any>,
  ): AsyncGenerator<HarnessMessage> {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        yield { type: "init", session_id: msg.session_id };
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
            duration_ms: msg.duration_ms,
            total_cost_usd: msg.total_cost_usd,
            num_turns: msg.num_turns,
            result: msg.result,
            session_id: msg.session_id,
          },
        };
      }
    }
  }
}
