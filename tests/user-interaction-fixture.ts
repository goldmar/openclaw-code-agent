/**
 * Fixture for cross-harness user-interaction tests: a real SessionManager and
 * Session in front of a real harness adapter with a fake backend
 * (see ./harness-backends.ts), captured notifications, and Telegram/Discord
 * button callback contexts for the real callback handler.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHarness } from "../src/harness";
import { createCallbackHandler } from "../src/callback-handler";
import { SessionManager } from "../src/session-manager";
import { setSessionManager } from "../src/singletons";
import type { Session } from "../src/session";
import type { NotificationButton } from "../src/session-interactions";
import type { SessionNotificationRequest } from "../src/wake-dispatcher";
import type { PermissionMode, PlanApprovalMode, SessionConfig } from "../src/types";
import { createBackend, waitUntil, type BackendDriver, type BackendName } from "./harness-backends";

export type CapturedNotification = { sessionId: string; request: SessionNotificationRequest };

export type InteractionFixture = {
  backend: BackendDriver;
  sm: SessionManager;
  session: Session;
  notifications: CapturedNotification[];
  /** Latest notification whose label matches. */
  lastNotification(label: string | RegExp): CapturedNotification | undefined;
  /** Wait for a notification with this label (counting from `after`). */
  waitForNotification(label: string | RegExp, after?: number): Promise<CapturedNotification>;
  /** Buttons of the latest notification with this label, flattened. */
  buttons(label: string | RegExp): NotificationButton[];
  /** Stop the manager and start a new one on the same store, as a Gateway restart does. */
  restartGateway(): Promise<void>;
  dispose(): Promise<void>;
};

export type FixtureOptions = {
  permissionMode?: PermissionMode;
  planApproval?: PlanApprovalMode;
  /** How the fake channel answers plan-approval deliveries. */
  planPromptDelivery?: "delivered" | "failed";
  config?: Partial<SessionConfig>;
  /** Prepare the manager before the session launches (for example a repo policy). */
  beforeLaunch?: (sm: SessionManager) => Promise<void>;
};

export const TEST_ROUTE = {
  provider: "telegram",
  accountId: "bot",
  target: "-1001234567890",
  threadId: "42",
  sessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
} as const;

function matches(label: string | undefined, wanted: string | RegExp): boolean {
  if (!label) return false;
  return typeof wanted === "string" ? label === wanted : wanted.test(label);
}

/**
 * Launch a session on the named harness with a fake backend and wait until the
 * backend is running the first turn.
 */
export async function startInteractionFixture(
  name: BackendName,
  options: FixtureOptions = {},
): Promise<InteractionFixture> {
  const backend = createBackend(name);
  registerHarness(backend.harness);
  const notifications: CapturedNotification[] = [];
  const delivery = options.planPromptDelivery ?? "delivered";
  const createManager = (): SessionManager => {
    const manager = new SessionManager(5, 50);
    (manager as unknown as { notifications: unknown }).notifications = {
      dispatch: (session: { id: string }, request: SessionNotificationRequest) => {
        notifications.push({ sessionId: session.id, request });
        if (request.shouldDispatch && !request.shouldDispatch()) return;
        request.hooks?.onNotifyStarted?.();
        if (request.label === "plan-approval" && delivery === "failed" && request.notifyUser === "always") {
          request.hooks?.onNotifyFailed?.();
          request.onUserNotifyFailed?.();
        } else {
          request.hooks?.onNotifySucceeded?.();
        }
      },
      notifyWorktreeOutcome: (): undefined => undefined,
      dispose: (): undefined => undefined,
    };
    (manager as unknown as { wakeDispatcher: unknown }).wakeDispatcher = {
      clearRetryTimersForSession: (): undefined => undefined,
      dispose: (): undefined => undefined,
    };
    return manager;
  };
  const sm = createManager();
  setSessionManager(sm);
  await options.beforeLaunch?.(sm);
  const workdir = mkdtempSync(join(tmpdir(), `oca-${name}-interaction-`));
  const session = await sm.launchSession({
    prompt: "Start the task",
    workdir,
    name: `${name}-flow`,
    harness: name,
    worktreeStrategy: "off",
    multiTurn: true,
    permissionMode: options.permissionMode ?? "default",
    ...(options.planApproval ? { planApproval: options.planApproval } : {}),
    route: { ...TEST_ROUTE },
    ...options.config,
  }, { notifyLaunch: false });
  await backend.waitForTurns(1);
  await waitUntil(() => session.status === "running", `${name} session running`);

  const fixture: InteractionFixture = {
    backend,
    sm,
    session,
    notifications,
    lastNotification(label) {
      return [...notifications].reverse().find((entry) => matches(entry.request.label, label));
    },
    async waitForNotification(label, after = 0) {
      await waitUntil(
        () => notifications.slice(after).some((entry) => matches(entry.request.label, label)),
        `a ${String(label)} notification`,
      );
      return notifications.slice(after).find((entry) => matches(entry.request.label, label))!;
    },
    buttons(label) {
      const entry = fixture.lastNotification(label);
      const rows = entry?.request.buttons
        ?? entry?.request.userMessages?.flatMap((message) => message.buttons ?? []);
      return (rows ?? []).flat();
    },
    async restartGateway() {
      // Like a Gateway restart: the runtime stops its sessions, and a new
      // runtime loads the persisted sessions and buttons from the store.
      await fixture.sm.shutdown();
      const next = createManager();
      await next.drainTaskLifecycle();
      fixture.sm = next;
      setSessionManager(next);
    },
    async dispose() {
      await fixture.sm.shutdown();
      setSessionManager(null);
      // A violation also threw where it happened, but a harness may have caught it.
      if (backend.protocolViolations.length > 0) {
        throw new Error(`${name} fake backend saw protocol violations:\n${backend.protocolViolations.join("\n")}`);
      }
    },
  };
  return fixture;
}

export type CallbackResult = { replies: string[]; cleared: number };

/** Click a button through the real callback handler, as Telegram or Discord delivers it. */
export async function clickButton(
  button: Pick<NotificationButton, "callbackData">,
  channel: "telegram" | "discord" = "telegram",
): Promise<CallbackResult> {
  const replies: string[] = [];
  let cleared = 0;
  const payload = button.callbackData;
  const ctx = channel === "telegram"
    ? {
        channel,
        accountId: "bot",
        callbackId: `callback-${payload}`,
        conversationId: `${TEST_ROUTE.target}:topic:${TEST_ROUTE.threadId}`,
        parentConversationId: TEST_ROUTE.target,
        senderId: "12345",
        senderUsername: "user",
        threadId: Number(TEST_ROUTE.threadId),
        isGroup: true,
        isForum: true,
        auth: { isAuthorizedSender: true },
        callback: {
          data: `code-agent:${payload}`,
          namespace: "code-agent",
          payload,
          messageId: 99,
          chatId: TEST_ROUTE.target,
          messageText: "prompt",
        },
        respond: {
          acknowledge: async (): Promise<undefined> => undefined,
          reply: async ({ text }: { text: string }) => { replies.push(text); },
          clearButtons: async () => { cleared += 1; },
          editButtons: async () => { cleared += 1; },
          editMessage: async (): Promise<undefined> => undefined,
        },
      }
    : {
        channel,
        auth: { isAuthorizedSender: true },
        interaction: { payload },
        respond: {
          acknowledge: async (): Promise<undefined> => undefined,
          reply: async ({ text }: { text: string }) => { replies.push(text); },
          followUp: async ({ text }: { text: string }) => { replies.push(text); },
          editMessage: async (): Promise<undefined> => undefined,
          clearComponents: async () => { cleared += 1; },
        },
      };
  await createCallbackHandler(channel).handler(ctx as never);
  return { replies, cleared };
}

export function buttonNamed(buttons: NotificationButton[], label: string): NotificationButton {
  const button = buttons.find((candidate) => candidate.label === label);
  if (!button) throw new Error(`No "${label}" button among: ${buttons.map((candidate) => candidate.label).join(", ")}`);
  return button;
}
