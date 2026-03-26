/**
 * Claude Code harness — wraps @anthropic-ai/claude-agent-sdk.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { dirname, join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
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

/** Refresh window: refresh token if it expires within 30 minutes. */
const TOKEN_REFRESH_WINDOW_MS = 30 * 60 * 1000; // 1_800_000

/** Timeout for the token refresh HTTP request. */
const TOKEN_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Refresh the OAuth token using an in-process HTTPS POST via native fetch().
 * Returns the new access token string, or throws on failure.
 *
 * Secrets never appear in process argv — they are sent in the request body
 * via fetch(), which keeps them in-process memory only.
 */
async function refreshOAuthToken(oauth: {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
}): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_REFRESH_TIMEOUT_MS);

  try {
    const response = await fetch("https://platform.claude.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken,
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "<unreadable>");
      throw new Error(
        `OAuth refresh failed: HTTP ${response.status} — ${text.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (!data.access_token || typeof data.access_token !== "string") {
      throw new Error(
        `OAuth refresh returned unexpected payload: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }

    return {
      accessToken: data.access_token,
      refreshToken:
        typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      expiresIn:
        typeof data.expires_in === "number" ? data.expires_in : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the OAuth credentials, refresh if near expiry, and return the
 * access token to use. This is fully async — no main-thread blocking.
 *
 * On refresh success the credentials file is updated. On refresh failure
 * an error is thrown (fail-fast) rather than silently using a stale token.
 */
async function resolveOAuthToken(): Promise<string | undefined> {
  const credsPath = join(homedir(), ".claude", ".credentials.json");
  if (!existsSync(credsPath)) return undefined;

  let creds: Record<string, unknown>;
  try {
    creds = JSON.parse(readFileSync(credsPath, "utf-8"));
  } catch {
    return undefined; // unreadable credentials file
  }

  const oauth = creds?.claudeAiOauth as
    | { accessToken?: string; refreshToken?: string; expiresAt?: number }
    | undefined;

  if (!oauth?.accessToken) return undefined;

  const now = Date.now();
  const expiresAt = oauth.expiresAt || 0;
  const needsRefresh =
    expiresAt > 0 &&
    expiresAt < now + TOKEN_REFRESH_WINDOW_MS &&
    oauth.refreshToken;

  if (needsRefresh) {
    console.log(
      "[ClaudeCodeHarness] Token expires in",
      Math.round((expiresAt - now) / 60000),
      "min — refreshing asynchronously...",
    );
    // This throws on failure — caller must handle
    const result = await refreshOAuthToken(
      oauth as { accessToken: string; refreshToken: string; expiresAt?: number },
    );
    oauth.accessToken = result.accessToken;
    if (result.refreshToken) oauth.refreshToken = result.refreshToken;
    if (result.expiresIn != null) oauth.expiresAt = now + result.expiresIn * 1000;
    creds.claudeAiOauth = oauth;
    writeFileSync(credsPath, JSON.stringify(creds, null, 2));
    console.log(
      "[ClaudeCodeHarness] OAuth token refreshed, expires in",
      result.expiresIn ?? "?",
      "seconds",
    );
  }

  return oauth.accessToken;
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

    // Kick off async token resolution immediately (non-blocking).
    // The messages generator awaits this before starting the SDK query.
    const tokenPromise = resolveOAuthToken();

    // We store the query handle here so setPermissionMode/streamInput/interrupt
    // can reference it once the async generator has initialised the SDK.
    let q: ClaudeQueryHandle | undefined;

    return {
      messages: this.launchAndAdaptMessages(
        tokenPromise,
        options,
        sdkOptions,
        (handle) => { q = handle; },
      ),

      async setPermissionMode(mode: string): Promise<void> {
        if (q && typeof q.setPermissionMode === "function") {
          await q.setPermissionMode(mode);
        }
      },

      async streamInput(input: AsyncIterable<unknown>): Promise<void> {
        if (q && typeof q.streamInput === "function") {
          await q.streamInput(input as AsyncIterable<SDKUserMessage>);
        }
      },

      async interrupt(): Promise<void> {
        if (q && typeof q.interrupt === "function") {
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

  /**
   * Awaits the async token refresh, sets the env var for the SDK subprocess,
   * starts the SDK query, then yields adapted harness messages.
   *
   * The env var is set just before query() and restored immediately after,
   * minimising the window of global state mutation.
   */
  private async *launchAndAdaptMessages(
    tokenPromise: Promise<string | undefined>,
    options: HarnessLaunchOptions,
    sdkOptions: Record<string, unknown>,
    onQuery: (q: ClaudeQueryHandle) => void,
  ): AsyncGenerator<HarnessMessage> {
    // Await the async OAuth refresh (non-blocking to event loop until consumed)
    const token = await tokenPromise;

    // Set the env var only for the duration of query() initialisation.
    // The SDK spawns a child process that inherits env, so we need it set
    // at call time, but we restore immediately after to avoid leaking into
    // unrelated code paths.
    const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (token) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }

    let q: ClaudeQueryHandle;
    try {
      q = query({
        prompt: options.prompt as string | AsyncIterable<SDKUserMessage>,
        options: sdkOptions,
      }) as ClaudeQueryHandle;
    } finally {
      // Restore previous env state
      if (previousToken !== undefined) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
      } else {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      }
    }

    onQuery(q);

    yield* this.adaptMessages(q);
  }

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
