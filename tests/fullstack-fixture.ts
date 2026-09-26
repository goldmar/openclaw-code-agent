/**
 * Full-stack fixture: the real plugin entry (`index.ts` `register`) on the fake
 * host, with the real SessionManager, WakeDispatcher, route resolution, and
 * delivery transports. Only the host boundaries are fakes:
 *
 * - `sendDurableMessageBatch` (the host's durable outbound queue) is the fake
 *   host's recorder, reached through `directNotificationTransportInternals`;
 * - `openclaw gateway call chat.send` wakes run through a recorder installed as
 *   `wakeDeliveryExecutorInternals.execFile`;
 * - `runtime.system.enqueueSystemEvent` / `requestHeartbeat` and `runtime.llm`
 *   are the fake host's;
 * - the coding agent is a protocol-validated fake backend behind the real
 *   harness adapter (./harness-backends.ts).
 *
 * Buttons are clicked by delivering a Telegram or Discord callback to the
 * interactive handler the plugin registered, exactly as the host does.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginToolContext } from "../api";
import { register } from "../index";
import { setPluginConfig } from "../src/config";
import { directNotificationTransportInternals } from "../src/direct-notification-transport";
import { registerHarness } from "../src/harness";
import { resetSharedRuntimeSlotForTests } from "../src/process-runtime";
import { runtimeLlmTimeoutsMs } from "../src/runtime-llm";
import type { Session } from "../src/session";
import type { SessionManager } from "../src/session-manager";
import { goalController, sessionManager } from "../src/singletons";
import type { GoalController } from "../src/goal-controller";
import { wakeDeliveryExecutorInternals } from "../src/wake-delivery-executor";
import { createFakeHost, type DurableSendParams, type DurableSendResult, type FakeHost, type LlmReply } from "./fake-host";
import { createBackend, waitUntil, type BackendDriver, type BackendName } from "./harness-backends";
import { buildCallbackContext, type CallbackChannel } from "./user-interaction-fixture";

export type ChatSurface = {
  channel: CallbackChannel;
  accountId: string;
  /** Delivery target as the host reports it in a tool's delivery context. */
  to: string;
  threadId: string | number;
  sessionKey: string;
};

/** A Telegram forum topic (fake chat id). */
export const TELEGRAM_TOPIC: ChatSurface = {
  channel: "telegram",
  accountId: "bot",
  to: "-1001234567890",
  threadId: 42,
  sessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
};

/** A Discord thread (fake snowflakes). */
export const DISCORD_THREAD: ChatSurface = {
  channel: "discord",
  accountId: "default",
  to: "channel:1400000000000000002",
  threadId: "1400000000000000003",
  sessionKey: "agent:main:discord:channel:1400000000000000002:thread:1400000000000000003",
};

export type SentButton = { label: string; payload: string };
export type SentMessage = {
  index: number;
  channel: string;
  to: string;
  threadId?: string | number;
  accountId?: string;
  text: string;
  buttons: SentButton[];
};

export type WakeCall = { sessionKey: string; message: string; deliver: boolean };
export type WakeReply = { stdout?: string; error?: Error };

export type FullStackOptions = {
  backend: BackendName;
  surface?: ChatSurface;
  pluginConfig?: Record<string, unknown>;
  llmReplies?: LlmReply[];
  /** How the host's durable queue answers a send (default: delivered). */
  sendResult?: (params: DurableSendParams) => DurableSendResult | Promise<DurableSendResult>;
  /** How `openclaw gateway call chat.send` answers (default: a final reply). */
  wakeReply?: (call: WakeCall) => WakeReply;
};

export type LaunchOptions = {
  prompt?: string;
  workdir?: string;
  name?: string;
  worktreeStrategy?: "off" | "manual" | "ask" | "delegate" | "auto-merge" | "auto-pr";
  permissionMode?: "default" | "plan" | "bypassPermissions";
  planApproval?: "ask" | "delegate" | "approve";
  systemPrompt?: string;
};

export type ClickResult = { replies: string[]; cleared: number };

export type FullStack = {
  host: FakeHost;
  backend: BackendDriver;
  surface: ChatSurface;
  /** The live runtime's SessionManager (changes after `restartGateway`). */
  readonly sm: SessionManager;
  readonly gc: GoalController;
  wakes: WakeCall[];
  /** Every durable send, newest last, with its buttons decoded. */
  messages(): SentMessage[];
  /** Wait for a message after `after` sends whose text matches. */
  waitForMessage(pattern: RegExp, after?: number): Promise<SentMessage>;
  /** Wait for a message carrying a button with this label. */
  waitForButton(label: string, after?: number): Promise<SentButton>;
  launch(options?: LaunchOptions): Promise<Session>;
  runTool(name: string, params: unknown): Promise<string>;
  click(button: SentButton | string, options?: { surface?: ChatSurface }): Promise<ClickResult>;
  /** Stop the service and start it again, as a Gateway restart does. */
  restartGateway(): Promise<void>;
  /** Stop the service, replace the session index with `index`, and start again. */
  restartFromIndex(index: string): Promise<void>;
  dispose(): Promise<void>;
};

const GATEWAY_CONFIG: FakeHost["serviceContext"]["config"] = {};

function testHomeDir(): string {
  return process.env.OPENCLAW_CODE_AGENT_TEST_HOME?.trim() || tmpdir();
}

function decodeMessage(params: DurableSendParams, index: number): SentMessage[] {
  return params.payloads.map((payload) => {
    const blocks = payload.presentation?.blocks ?? [];
    const buttons: SentButton[] = [];
    for (const block of blocks) {
      if (block.type !== "buttons") continue;
      for (const button of block.buttons) {
        const value = typeof button.value === "string" ? button.value : "";
        buttons.push({ label: button.label, payload: value.replace(/^code-agent:/, "") });
      }
    }
    return {
      index,
      channel: params.channel,
      to: params.to,
      threadId: params.threadId ?? undefined,
      accountId: params.accountId ?? undefined,
      text: payload.text ?? "",
      buttons,
    };
  });
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: unknown }> } | undefined)?.content;
  return content?.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n") ?? "";
}

/**
 * Point each new runtime at its own session index and goal store, so tests in
 * one file never share state (the test runner sets one path per file).
 */
function isolateStores(): { restore: () => void } {
  const previous = {
    sessions: process.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH,
    goals: process.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH,
  };
  const dir = mkdtempSync(join(testHomeDir(), "fullstack-store-"));
  process.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH = join(dir, "code-agent-sessions.json");
  process.env.OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH = join(dir, "goal-tasks.json");
  return {
    restore: () => {
      for (const [name, value] of [
        ["OPENCLAW_CODE_AGENT_SESSIONS_PATH", previous.sessions],
        ["OPENCLAW_CODE_AGENT_GOAL_TASKS_PATH", previous.goals],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

export function sessionsIndexPath(): string {
  const path = process.env.OPENCLAW_CODE_AGENT_SESSIONS_PATH;
  if (!path) throw new Error("full-stack fixture: no session index path");
  return path;
}

export async function startFullStack(options: FullStackOptions): Promise<FullStack> {
  const surface = options.surface ?? TELEGRAM_TOPIC;
  const stores = isolateStores();
  const backend = createBackend(options.backend);
  registerHarness(backend.harness);
  const host = createFakeHost({
    pluginConfig: { autoUpdate: false, ...options.pluginConfig },
    llmReplies: options.llmReplies,
    sendResult: options.sendResult,
  });
  const wakes: WakeCall[] = [];

  const originalLoadSender = directNotificationTransportInternals.loadSendDurableMessageBatch;
  const originalExecFile = wakeDeliveryExecutorInternals.execFile;
  const originalTimeouts = { ...runtimeLlmTimeoutsMs };
  directNotificationTransportInternals.loadSendDurableMessageBatch = async () => host.sendDurableMessageBatch;
  const fakeExecFile = (
    file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void => {
    if (file !== "openclaw") {
      queueMicrotask(() => callback(new Error(`fake host: unexpected command ${file}`), "", ""));
      return;
    }
    const paramsIndex = args.indexOf("--params");
    const params = JSON.parse(args[paramsIndex + 1] ?? "{}") as { sessionKey?: string; message?: string; deliver?: boolean };
    const call: WakeCall = { sessionKey: params.sessionKey ?? "", message: params.message ?? "", deliver: params.deliver === true };
    wakes.push(call);
    const reply = options.wakeReply?.(call) ?? { stdout: JSON.stringify({ final: "OK" }) };
    queueMicrotask(() => callback(reply.error ?? null, reply.stdout ?? "", ""));
  };
  wakeDeliveryExecutorInternals.execFile = fakeExecFile as unknown as typeof wakeDeliveryExecutorInternals.execFile;

  const restoreBoundaries = (): void => {
    resetSharedRuntimeSlotForTests();
    setPluginConfig({});
    directNotificationTransportInternals.loadSendDurableMessageBatch = originalLoadSender;
    wakeDeliveryExecutorInternals.execFile = originalExecFile;
    Object.assign(runtimeLlmTimeoutsMs, originalTimeouts);
    stores.restore();
  };
  try {
    register(host.api);
    await host.startServices(GATEWAY_CONFIG);
    if (!sessionManager) throw new Error("full-stack fixture: the service did not start a SessionManager");
  } catch (err) {
    await host.dispose().catch((): undefined => undefined);
    restoreBoundaries();
    throw err;
  }

  const messages = (): SentMessage[] => host.durableSends.flatMap((params, index) => decodeMessage(params, index));

  const fullStack: FullStack = {
    host,
    backend,
    surface,
    get sm(): SessionManager {
      if (!sessionManager) throw new Error("full-stack fixture: no running SessionManager");
      return sessionManager;
    },
    get gc(): GoalController {
      if (!goalController) throw new Error("full-stack fixture: no running GoalController");
      return goalController;
    },
    wakes,
    messages,
    async waitForMessage(pattern, after = 0) {
      await waitUntil(() => messages().some((message) => message.index >= after && pattern.test(message.text)), `a message matching ${pattern}`);
      return messages().find((message) => message.index >= after && pattern.test(message.text))!;
    },
    async waitForButton(label, after = 0) {
      const find = () => [...messages()].reverse()
        .filter((message) => message.index >= after)
        .flatMap((message) => message.buttons)
        .find((button) => button.label === label);
      await waitUntil(() => Boolean(find()), `a "${label}" button`);
      return find()!;
    },
    async launch(launch = {}) {
      const workdir = launch.workdir ?? mkdtempSync(join(testHomeDir(), `fullstack-${options.backend}-`));
      const before = new Set(fullStack.sm.list("all").map((session) => session.id));
      const turnsBefore = backend.turns.length;
      const text = await fullStack.runTool("agent_launch", {
        prompt: launch.prompt ?? "Start the task",
        workdir,
        name: launch.name ?? `${options.backend}-fullstack`,
        harness: options.backend,
        worktree_strategy: launch.worktreeStrategy ?? "off",
        permission_mode: launch.permissionMode ?? "default",
        ...(launch.planApproval ? { plan_approval: launch.planApproval } : {}),
        ...(launch.systemPrompt ? { system_prompt: launch.systemPrompt } : {}),
      });
      let session: Session | undefined;
      await waitUntil(() => {
        session = fullStack.sm.list("all").find((candidate) => !before.has(candidate.id));
        return Boolean(session);
      }, `a launched session (agent_launch said: ${text})`);
      await backend.waitForTurns(turnsBefore + 1);
      await waitUntil(() => session!.status === "running", `${options.backend} session running`);
      return session!;
    },
    async runTool(name, params) {
      const ctx: Partial<OpenClawPluginToolContext> = {
        sessionKey: surface.sessionKey,
        messageChannel: surface.channel,
        deliveryContext: {
          channel: surface.channel,
          to: surface.to,
          accountId: surface.accountId,
          threadId: surface.threadId,
        },
      };
      return toolText(await host.runTool(name, params, ctx));
    },
    async click(button, clickOptions = {}) {
      const payload = typeof button === "string" ? button : button.payload;
      const clickSurface = clickOptions.surface ?? surface;
      const replies: string[] = [];
      let cleared = 0;
      const ctx = buildCallbackContext(clickSurface.channel, payload, {
        target: clickSurface.to,
        threadId: clickSurface.threadId,
        accountId: clickSurface.accountId,
        onReply: (text) => { replies.push(text); },
        onClear: () => { cleared += 1; },
      });
      await host.runInteractive(clickSurface.channel, ctx);
      return { replies, cleared };
    },
    async restartGateway() {
      await host.stopServices();
      await host.startServices(GATEWAY_CONFIG);
      if (!sessionManager) throw new Error("full-stack fixture: restart did not start a SessionManager");
      await sessionManager.ready;
    },
    async restartFromIndex(index) {
      await host.stopServices();
      writeFileSync(sessionsIndexPath(), index);
      await host.startServices(GATEWAY_CONFIG);
      if (!sessionManager) throw new Error("full-stack fixture: restart did not start a SessionManager");
      await sessionManager.ready;
    },
    async dispose() {
      try {
        await host.dispose();
      } finally {
        restoreBoundaries();
      }
      if (backend.protocolViolations.length > 0) {
        throw new Error(`${options.backend} fake backend saw protocol violations:\n${backend.protocolViolations.join("\n")}`);
      }
    },
  };
  return fullStack;
}
