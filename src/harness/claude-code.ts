/**
 * Claude Code harness — wraps @anthropic-ai/claude-agent-sdk.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { dirname, join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";
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
    "bypassPermissions",
  ] as const;

  readonly questionToolNames = ["AskUserQuestion"] as const;
  readonly planApprovalToolNames = ["ExitPlanMode", "set_permission_mode"] as const;

  /** Launch a Claude Code session and adapt SDK messages into harness events. */
  launch(options: HarnessLaunchOptions): HarnessSession {
    const canUseToolCallback = options.canUseTool;
    const sdkOptions: Record<string, unknown> = {
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
      // Always bypass the bwrap filesystem sandbox. On this VPS deployment,
      // OpenClaw is the security boundary; bwrap adds friction without benefit.
      // Plan mode remains a *behavioural* constraint — CC presents a plan and
      // waits for approval — but does not restrict filesystem writes.
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: (() => {
        try {
          const req = createRequire(import.meta.url);
          const sdkMain = req.resolve("@anthropic-ai/claude-agent-sdk");
          return join(dirname(sdkMain), "cli.js");
        } catch {
          // Fallback: resolve relative to this file
          const thisDir = dirname(fileURLToPath(import.meta.url));
          return join(thisDir, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js");
        }
      })(),
      allowedTools: options.allowedTools,
      systemPrompt: options.systemPrompt,
      includePartialMessages: true,
      abortController: options.abortController,
      mcpServers: options.mcpServers,
      // AskUserQuestion intercept — forwards questions to the user as inline buttons.
      // Only wired when the caller provides a handler (CC sessions only).
      ...(canUseToolCallback
        ? {
            canUseTool: async (toolName: string, input: Record<string, unknown>) => {
              if (toolName === "AskUserQuestion") {
                return canUseToolCallback(toolName, input);
              }
              // Default: allow all other tools
              return { behavior: "allow" as const };
            },
          }
        : {}),
    };

    if (options.resumeSessionId) {
      sdkOptions.resume = options.resumeSessionId;
      sdkOptions.forkSession = options.forkSession ?? false;
    }

    // Read fresh OAuth token from credentials file, refresh if near expiry
    const credsPath = join(homedir(), ".claude", ".credentials.json");
    if (existsSync(credsPath)) {
      try {
        const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
        const oauth = creds?.claudeAiOauth;
        if (oauth?.accessToken) {
          const now = Date.now();
          const expiresAt = oauth.expiresAt || 0;
          // If token expires within 30 minutes, refresh synchronously via curl
          if (expiresAt > 0 && expiresAt < now + 7200000 && oauth.refreshToken) {
            try {
              console.log("[ClaudeCodeHarness] Token expires in", Math.round((expiresAt - now) / 60000), "min — refreshing...");
              const curlResult = execFileSync("curl", [
                "-s", "-X", "POST",
                "https://platform.claude.com/v1/oauth/token",
                "-H", "Content-Type: application/json",
                "-d", JSON.stringify({
                  grant_type: "refresh_token",
                  refresh_token: oauth.refreshToken,
                  client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
                }),
              ], { timeout: 15000, encoding: "utf-8" });
              const data = JSON.parse(curlResult) as Record<string, unknown>;
              if (data.access_token && typeof data.access_token === "string") {
                oauth.accessToken = data.access_token;
                if (typeof data.refresh_token === "string") oauth.refreshToken = data.refresh_token;
                if (typeof data.expires_in === "number") oauth.expiresAt = now + data.expires_in * 1000;
                creds.claudeAiOauth = oauth;
                writeFileSync(credsPath, JSON.stringify(creds, null, 2));
                console.log("[ClaudeCodeHarness] OAuth token refreshed, expires in", data.expires_in, "seconds");
              } else {
                console.warn("[ClaudeCodeHarness] OAuth refresh unexpected response:", JSON.stringify(data).slice(0, 200));
              }
            } catch (refreshErr) {
              console.warn("[ClaudeCodeHarness] OAuth refresh failed:", (refreshErr as Error).message);
            }
          }
          process.env.CLAUDE_CODE_OAUTH_TOKEN = oauth.accessToken;
        }
      } catch {
        // Ignore errors reading credentials
      }
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
