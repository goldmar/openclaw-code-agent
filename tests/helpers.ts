/**
 * Shared test helpers — fake harness, stub factories, and utilities.
 */

import type { AgentHarness, HarnessSession, HarnessMessage, HarnessLaunchOptions } from "../src/harness/types";
import type { SessionConfig } from "../src/types";

// ---------------------------------------------------------------------------
// Fake harness — implements AgentHarness without the Claude SDK
// ---------------------------------------------------------------------------

export interface FakeHarness extends AgentHarness {
  lastLaunchOptions: HarnessLaunchOptions | undefined;
  pushMessage: (msg: HarnessMessage) => void;
  endMessages: () => void;
  lastSetPermissionMode: string | undefined;
  lastStreamInput: AsyncIterable<any> | undefined;
  interruptCalled: boolean;
}

export function createFakeHarness(name: string = "fake-harness"): FakeHarness {
  let pushMessage: ((msg: HarnessMessage) => void) = () => {};
  let endMessages: (() => void) = () => {};

  const harness: FakeHarness = {
    name,
    supportedPermissionModes: ["default", "plan", "acceptEdits", "bypassPermissions"],
    questionToolNames: ["AskUserQuestion"],
    planApprovalToolNames: ["ExitPlanMode"],
    lastLaunchOptions: undefined,
    lastSetPermissionMode: undefined,
    lastStreamInput: undefined,
    interruptCalled: false,

    pushMessage(msg: HarnessMessage) { pushMessage(msg); },
    endMessages() { endMessages(); },

    launch(options: HarnessLaunchOptions): HarnessSession {
      harness.lastLaunchOptions = options;

      const queue: HarnessMessage[] = [];
      let resolve: (() => void) | null = null;
      let done = false;

      pushMessage = (msg) => { queue.push(msg); if (resolve) { resolve(); resolve = null; } };
      endMessages = () => { done = true; if (resolve) { resolve(); resolve = null; } };

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
    lobsterResumeToken: undefined,
    currentPermissionMode: "plan",
    autoRespondCount: 0,
    workdir: "/tmp",
    model: undefined,
    originChannel: undefined,
    originThreadId: undefined,
    originAgentId: undefined,
    multiTurn: true,
    sendMessage: async (_text: string) => {},
    interrupt: async () => {},
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
