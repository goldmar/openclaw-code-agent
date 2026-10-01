/**
 * A fake OpenClaw host for plugin-level tests.
 *
 * It implements the host surfaces OCA uses, typed against the published SDK
 * (`OpenClawPluginApi`, `PluginRuntime` from `openclaw/plugin-sdk/plugin-entry`
 * and `sendDurableMessageBatch` from `openclaw/plugin-sdk/channel-outbound`),
 * and records every call so tests can assert on them:
 *
 * - `runtime.llm.complete` (scripted replies or failures),
 * - `runtime.system.enqueueSystemEvent` / `requestHeartbeat`,
 * - `runtime.logging.getChildLogger`, `runtime.config.current`,
 *   `runtime.state.resolveStateDir`,
 * - `sendDurableMessageBatch` (for `RuntimeDirectNotificationTransport`),
 * - tool, command, service, and interactive-handler registration, with
 *   helpers to run a registered tool/command and start/stop services.
 *
 * Only the members OCA calls are implemented. Each one is typed as the
 * matching SDK member, so a host signature change breaks `pnpm typecheck`.
 * The single cast to the full `OpenClawPluginApi` / `PluginRuntime` is in
 * `createFakeHost`, because those types carry hundreds of unrelated members.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
  OpenClawPluginToolContext,
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveTelegramHandlerContext,
} from "../api";
import { RuntimeDirectNotificationTransport } from "../src/direct-notification-transport";
import type { PluginRuntime } from "../src/runtime-store";

type Api = OpenClawPluginApi;
export type ToolRegistration = { tool: Parameters<Api["registerTool"]>[0]; options?: Parameters<Api["registerTool"]>[1] };
export type CommandDefinition = Parameters<Api["registerCommand"]>[0];
export type CommandContext = Parameters<CommandDefinition["handler"]>[0];
export type CommandResult = Awaited<ReturnType<CommandDefinition["handler"]>>;
export type InteractiveRegistration = Parameters<Api["registerInteractiveHandler"]>[0];
export type ServiceDefinition = Parameters<Api["registerService"]>[0];
export type HostLogger = Api["logger"];

type LlmComplete = PluginRuntime["llm"]["complete"];
export type LlmCompleteParams = Parameters<LlmComplete>[0];
export type LlmCompleteResult = Awaited<ReturnType<LlmComplete>>;
export type SystemEventOptions = Parameters<PluginRuntime["system"]["enqueueSystemEvent"]>[1];
export type HeartbeatRequest = Parameters<PluginRuntime["system"]["requestHeartbeat"]>[0];
type RuntimeLogger = ReturnType<PluginRuntime["logging"]["getChildLogger"]>;
type RuntimeConfigSnapshot = ReturnType<PluginRuntime["config"]["current"]>;

type ChannelOutboundModule = typeof import("openclaw/plugin-sdk/channel-outbound");
export type SendDurableMessageBatch = ChannelOutboundModule["sendDurableMessageBatch"];
export type DurableSendParams = Parameters<SendDurableMessageBatch>[0];
export type DurableSendResult = Awaited<ReturnType<SendDurableMessageBatch>>;

/** The runtime members OCA uses, each typed as the SDK member. */
export type FakeRuntime = {
  version: PluginRuntime["version"];
  config: Pick<PluginRuntime["config"], "current">;
  llm: Pick<PluginRuntime["llm"], "complete">;
  system: Pick<PluginRuntime["system"], "enqueueSystemEvent" | "requestHeartbeat">;
  logging: Pick<PluginRuntime["logging"], "getChildLogger" | "shouldLogVerbose">;
  state: Pick<PluginRuntime["state"], "resolveStateDir">;
};

export type LlmReply = string | Error | ((params: LlmCompleteParams) => string | Promise<string>);
export type LogEntry = { level: "debug" | "info" | "warn" | "error"; bindings: Record<string, unknown>; message: string };
export type SystemEventCall = { text: string; options: SystemEventOptions };

export type FakeHostOptions = {
  pluginConfig?: Record<string, unknown>;
  /** What `runtime.config.current()` and the service context `config` return. */
  config?: RuntimeConfigSnapshot;
  /**
   * Replies for `runtime.llm.complete`, consumed in order; the last one repeats.
   * Default: every call fails with `LLM_COMPLETION_FAILED`, like a host without a model.
   */
  llmReplies?: LlmReply[];
  /** `enqueueSystemEvent` return value (false = an identical event is already queued). */
  systemEventAccepted?: boolean;
  /** Result of `sendDurableMessageBatch`; default: every payload delivered. */
  sendResult?: (params: DurableSendParams) => DurableSendResult | Promise<DurableSendResult>;
  version?: string;
};

export type FakeHost = {
  api: OpenClawPluginApi;
  runtime: PluginRuntime;
  fakeRuntime: FakeRuntime;
  stateDir: string;
  serviceContext: OpenClawPluginServiceContext;
  llmCalls: LlmCompleteParams[];
  systemEvents: SystemEventCall[];
  heartbeats: HeartbeatRequest[];
  durableSends: DurableSendParams[];
  logs: LogEntry[];
  tools: ToolRegistration[];
  commands: CommandDefinition[];
  services: ServiceDefinition[];
  interactiveHandlers: InteractiveRegistration[];
  disposers: Array<() => void | Promise<void>>;
  /** Replace the scripted `runtime.llm.complete` replies. */
  setLlmReplies(replies: LlmReply[]): void;
  /** The host's `sendDurableMessageBatch` stand-in. */
  sendDurableMessageBatch: SendDurableMessageBatch;
  /** A direct-notification transport wired to `sendDurableMessageBatch`. */
  directNotificationTransport(): RuntimeDirectNotificationTransport;
  /** Build a registered tool by name for a tool context (runs its factory, not the tool). */
  tool(name: string, ctx?: Partial<OpenClawPluginToolContext>): AgentToolLike;
  /** Resolve a registered tool by name and run it. */
  runTool(name: string, params: unknown, ctx?: Partial<OpenClawPluginToolContext>): Promise<unknown>;
  /** Run a registered chat command by name. */
  runCommand(name: string, ctx?: Partial<CommandContext>): Promise<CommandResult>;
  interactiveHandler(channel: string): InteractiveRegistration;
  /**
   * Deliver a button callback to the registered handler for `channel`. The SDK
   * publishes only the generic registration type; the concrete context shapes
   * are the channel plugins' (see api.ts).
   */
  runInteractive(channel: "telegram" | "discord", ctx: PluginInteractiveTelegramHandlerContext | PluginInteractiveDiscordHandlerContext | Record<string, unknown>): Promise<unknown>;
  /** Start every registered service, as Gateway startup does (optionally with a different `config`). */
  startServices(config?: OpenClawPluginServiceContext["config"]): Promise<void>;
  /** Stop every registered service (started explicitly or lazily by a tool call). */
  stopServices(): Promise<void>;
  /** Stop services, run lifecycle disposers, and remove the state dir. */
  dispose(): Promise<void>;
};

function llmError(message: string): Error {
  return Object.assign(new Error(message), { code: "LLM_COMPLETION_FAILED" });
}

export type AgentToolLike = { name?: string; execute: (id: string, params: unknown) => unknown };

function isAgentTool(value: unknown): value is AgentToolLike {
  return !!value && typeof value === "object" && typeof (value as { execute?: unknown }).execute === "function";
}

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const stateDir = mkdtempSync(join(tmpdir(), "oca-fake-host-state-"));
  mkdirSync(stateDir, { recursive: true });
  const config = (options.config ?? {}) as RuntimeConfigSnapshot;
  let llmReplies: LlmReply[] = options.llmReplies ?? [];
  let llmIndex = 0;

  const llmCalls: LlmCompleteParams[] = [];
  const systemEvents: SystemEventCall[] = [];
  const heartbeats: HeartbeatRequest[] = [];
  const durableSends: DurableSendParams[] = [];
  const logs: LogEntry[] = [];
  const tools: ToolRegistration[] = [];
  const commands: CommandDefinition[] = [];
  const services: ServiceDefinition[] = [];
  const interactiveHandlers: InteractiveRegistration[] = [];
  const disposers: Array<() => void | Promise<void>> = [];

  const loggerFor = (bindings: Record<string, unknown>): RuntimeLogger => ({
    debug: (message) => { logs.push({ level: "debug", bindings, message }); },
    info: (message) => { logs.push({ level: "info", bindings, message }); },
    warn: (message) => { logs.push({ level: "warn", bindings, message }); },
    error: (message) => { logs.push({ level: "error", bindings, message }); },
  });
  const hostLogger: HostLogger = loggerFor({ plugin: "host" });

  const complete: LlmComplete = async (params) => {
    llmCalls.push(params);
    if (llmReplies.length === 0) throw llmError("fake host: no model configured");
    const reply = llmReplies[Math.min(llmIndex, llmReplies.length - 1)]!;
    llmIndex += 1;
    if (reply instanceof Error) throw reply;
    const text = typeof reply === "function" ? await reply(params) : reply;
    return {
      text,
      provider: "fake",
      model: "fake-model",
      agentId: "main",
      usage: {},
      execution: { mode: "direct-provider", owner: { kind: "provider", id: "fake" } },
      audit: { caller: { kind: "plugin", id: "openclaw-code-agent" }, purpose: params.purpose },
    } satisfies LlmCompleteResult;
  };

  const fakeRuntime: FakeRuntime = {
    version: options.version ?? "2026.9.7",
    config: { current: () => config },
    llm: { complete },
    system: {
      enqueueSystemEvent: (text, eventOptions) => {
        systemEvents.push({ text, options: eventOptions });
        return options.systemEventAccepted ?? true;
      },
      requestHeartbeat: (request) => {
        heartbeats.push(request);
      },
    },
    logging: {
      shouldLogVerbose: () => false,
      getChildLogger: (bindings = {}) => loggerFor(bindings),
    },
    state: { resolveStateDir: () => stateDir },
  };
  // The full PluginRuntime has hundreds of members OCA never touches.
  const runtime = fakeRuntime as unknown as PluginRuntime;

  const sendDurableMessageBatch: SendDurableMessageBatch = async (params) => {
    durableSends.push(params);
    if (options.sendResult) return await options.sendResult(params);
    const messageIds = params.payloads.map((_, index) => `fake-message-${durableSends.length}-${index}`);
    return {
      status: "sent",
      results: messageIds.map((messageId) => ({ channel: params.channel, messageId })),
      receipt: {
        primaryPlatformMessageId: messageIds[0],
        platformMessageIds: messageIds,
        parts: messageIds.map((platformMessageId, index) => ({ platformMessageId, kind: "text", index })),
        sentAt: Date.now(),
      },
    } satisfies DurableSendResult;
  };

  const serviceContext = {
    config: config as OpenClawPluginServiceContext["config"],
    stateDir,
    logger: hostLogger,
  } satisfies OpenClawPluginServiceContext;

  const apiMembers = {
    id: "openclaw-code-agent",
    name: "Code Agent",
    version: options.version ?? "2026.9.7",
    source: "fake-host",
    registrationMode: "full",
    config: serviceContext.config,
    pluginConfig: options.pluginConfig ?? { autoUpdate: false },
    runtime,
    logger: hostLogger,
    lifecycle: {
      onDispose: (dispose: () => void | Promise<void>) => {
        disposers.push(dispose);
        return () => {
          const index = disposers.indexOf(dispose);
          if (index >= 0) disposers.splice(index, 1);
        };
      },
      registerRuntimeLifecycle: (): undefined => undefined,
    },
    registerTool: (tool, toolOptions) => { tools.push({ tool, options: toolOptions }); },
    registerCommand: (command) => { commands.push(command); },
    registerService: (service) => { services.push(service); },
    registerInteractiveHandler: (registration) => { interactiveHandlers.push(registration); },
  } satisfies Partial<Record<keyof Api, unknown>> & Pick<Api, "registerTool" | "registerCommand" | "registerService" | "registerInteractiveHandler" | "runtime" | "logger">;
  const api = apiMembers as unknown as OpenClawPluginApi;

  const resolveTool = (name: string, ctx: Partial<OpenClawPluginToolContext>): AgentToolLike => {
    for (const registration of tools) {
      const registeredNames = [registration.options?.name, ...(registration.options?.names ?? [])];
      const candidate = typeof registration.tool === "function"
        ? (registration.tool as (context: OpenClawPluginToolContext) => unknown)(ctx as OpenClawPluginToolContext)
        : registration.tool;
      const list = Array.isArray(candidate) ? candidate : [candidate];
      for (const tool of list) {
        if (isAgentTool(tool) && (tool.name === name || registeredNames.includes(name))) return tool;
      }
    }
    throw new Error(`fake host: no tool named ${name} was registered`);
  };

  const host: FakeHost = {
    api,
    runtime,
    fakeRuntime,
    stateDir,
    serviceContext,
    llmCalls,
    systemEvents,
    heartbeats,
    durableSends,
    logs,
    tools,
    commands,
    services,
    interactiveHandlers,
    disposers,
    setLlmReplies(replies) {
      llmReplies = replies;
      llmIndex = 0;
    },
    sendDurableMessageBatch,
    directNotificationTransport: () => new RuntimeDirectNotificationTransport(async () => sendDurableMessageBatch),
    tool: (name, ctx = {}) => resolveTool(name, ctx),
    async runTool(name, params, ctx = {}) {
      return await resolveTool(name, ctx).execute(`fake-call-${name}`, params);
    },
    async runCommand(name, ctx = {}) {
      const command = commands.find((entry) => entry.name === name);
      if (!command) throw new Error(`fake host: no command named ${name} was registered`);
      return await command.handler({ args: "", channel: "telegram", isAuthorizedSender: true, ...ctx } as CommandContext);
    },
    interactiveHandler(channel) {
      const registration = interactiveHandlers.find((entry) => entry.channel === channel);
      if (!registration) throw new Error(`fake host: no interactive handler for ${channel}`);
      return registration;
    },
    async runInteractive(channel, ctx) {
      const registration = host.interactiveHandler(channel);
      return await registration.handler(ctx as Parameters<InteractiveRegistration["handler"]>[0]);
    },
    async startServices(config) {
      for (const service of services) await service.start(config === undefined ? serviceContext : { ...serviceContext, config });
    },
    async stopServices() {
      for (const service of [...services].reverse()) await service.stop?.(serviceContext);
    },
    async dispose() {
      await host.stopServices();
      for (const dispose of disposers.splice(0).reverse()) await dispose();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
  return host;
}
