/**
 * Shared test helpers — fake harness, stub factories, and utilities.
 */

import type { AgentHarness, HarnessSession, HarnessMessage, HarnessLaunchOptions } from "../src/harness/types";
import type { SessionConfig } from "../src/types";

type LegacyHarnessMessage =
  | { type: "init"; session_id: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "permission_mode_change"; mode: string }
  | { type: "result"; data: Extract<HarnessMessage, { type: "run_completed" }>["data"] };

type TestHarnessMessage = HarnessMessage | LegacyHarnessMessage;

function normalizeHarnessMessage(message: TestHarnessMessage): HarnessMessage {
  switch (message.type) {
    case "init":
      return {
        type: "backend_ref",
        ref: {
          kind: "claude-code",
          conversationId: message.session_id,
        },
      };
    case "text":
      return { type: "text_delta", text: message.text };
    case "tool_use":
      return { type: "tool_call", name: message.name, input: message.input };
    case "permission_mode_change":
      return { type: "settings_changed", permissionMode: message.mode };
    case "result":
      return { type: "run_completed", data: message.data };
    default:
      return message;
  }
}

// ---------------------------------------------------------------------------
// Fake harness — implements AgentHarness without the Claude SDK
// ---------------------------------------------------------------------------

export interface FakeHarness extends AgentHarness {
  lastLaunchOptions: HarnessLaunchOptions | undefined;
  pushMessage: (msg: TestHarnessMessage) => void;
  endMessages: () => void;
  lastSetPermissionMode: string | undefined;
  lastStreamInput: AsyncIterable<any> | undefined;
  interruptCalled: boolean;
  setPromptConsumptionPaused: (paused: boolean) => void;
}

export function createFakeHarness(
  name: string = "fake-harness",
  options?: { initialPromptConsumptionPaused?: boolean },
): FakeHarness {
  let pushMessage: ((msg: HarnessMessage) => void) = () => {};
  let endMessages: (() => void) = () => {};
  let promptConsumptionPaused = options?.initialPromptConsumptionPaused ?? false;
  let resumePromptConsumption: (() => void) | null = null;

  const harness: FakeHarness = {
    name,
    backendKind: "claude-code",
    supportedPermissionModes: ["default", "plan", "bypassPermissions"],
    capabilities: {
      nativePendingInput: false,
      nativePlanArtifacts: false,
      worktrees: "plugin-managed",
    },
    lastLaunchOptions: undefined,
    lastSetPermissionMode: undefined,
    lastStreamInput: undefined,
    interruptCalled: false,
    setPromptConsumptionPaused(paused: boolean) {
      promptConsumptionPaused = paused;
      if (!paused && resumePromptConsumption) {
        resumePromptConsumption();
        resumePromptConsumption = null;
      }
    },

    pushMessage(msg: TestHarnessMessage) { pushMessage(normalizeHarnessMessage(msg)); },
    endMessages() { endMessages(); },

    launch(options: HarnessLaunchOptions): HarnessSession {
      harness.lastLaunchOptions = options;

      const queue: HarnessMessage[] = [];
      let resolve: (() => void) | null = null;
      let done = false;

      pushMessage = (msg) => { queue.push(msg); if (resolve) { resolve(); resolve = null; } };
      endMessages = () => { done = true; if (resolve) { resolve(); resolve = null; } };

      // Consume prompt stream in background so MessageStream queue behavior in tests
      // matches real harnesses; tests can pause consumption to create pending messages.
      if (options.prompt && typeof options.prompt !== "string") {
        (async () => {
          const it = options.prompt[Symbol.asyncIterator]();
          while (true) {
            while (promptConsumptionPaused) {
              await new Promise<void>((r) => { resumePromptConsumption = r; });
            }
            const { done: promptDone } = await it.next();
            if (promptDone) break;
          }
        })().catch(() => {
          // Best-effort only for test scaffolding.
        });
      }

      const messages: AsyncIterable<HarnessMessage> = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<HarnessMessage>> {
              while (queue.length === 0 && !done) {
                await new Promise<void>((r) => { resolve = r; });
              }
              if (queue.length > 0) return { value: queue.shift()!, done: false };
              return { value: undefined as any, done: true };
            },
          };
        },
      };

      return {
        messages,
        async setPermissionMode(mode: string): Promise<void> {
          harness.lastSetPermissionMode = mode;
        },
        async streamInput(input: AsyncIterable<any>): Promise<void> {
          harness.lastStreamInput = input;
        },
        async interrupt(): Promise<void> {
          harness.interruptCalled = true;
        },
      };
    },

    buildUserMessage(text: string, sessionId: string): any {
      return { type: "user", text, session_id: sessionId };
    },
  };

  return harness;
}

// ---------------------------------------------------------------------------
// Base session config
// ---------------------------------------------------------------------------

export const BASE_CONFIG: SessionConfig = {
  prompt: "test prompt",
  workdir: "/tmp",
  permissionMode: "plan",
};

export function makeSessionConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return { ...BASE_CONFIG, ...overrides };
}

// ---------------------------------------------------------------------------
// Stub session — lightweight object matching Session's interface for respond tests
// ---------------------------------------------------------------------------

export function createStubSession(overrides: Record<string, any> = {}): any {
  const session: any = {
    status: "running",
    name: "test-session",
    id: "test-id",
    harnessSessionId: undefined,
    killReason: "unknown",
    pendingPlanApproval: false,
    planDecisionVersion: 0,
    actionablePlanDecisionVersion: undefined,
    lifecycle: "active",
    approvalState: "not_required",
    worktreeState: "none",
    runtimeState: "live",
    deliveryState: "idle",
    approvalPromptRequiredVersion: undefined,
    approvalPromptVersion: undefined,
    approvalPromptStatus: "not_sent",
    approvalPromptTransport: "none",
    approvalPromptMessageKind: "none",
    approvalPromptLastAttemptAt: undefined,
    approvalPromptDeliveredAt: undefined,
    approvalPromptFailedAt: undefined,
    isExplicitlyResumable: false,
    lobsterResumeToken: undefined,
    currentPermissionMode: "plan",
    autoRespondCount: 0,
    workdir: "/tmp",
    model: undefined,
    reasoningEffort: undefined,
    originChannel: undefined,
    originThreadId: undefined,
    originAgentId: undefined,
    originSessionKey: undefined,
    route: {
      provider: "telegram",
      accountId: "bot",
      target: "12345",
      threadId: "42",
      sessionKey: "agent:main:telegram:group:12345:topic:42",
    },
    multiTurn: true,
    sendMessage: async (_text: string) => {},
    interrupt: async () => true,
    switchPermissionMode: (_mode: string) => {},
    resetAutoRespond() { session.autoRespondCount = 0; },
    incrementAutoRespond() { session.autoRespondCount++; },
    ...overrides,
  };
  return session;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Small delay for async processing in tests. */
export function tick(ms: number = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
