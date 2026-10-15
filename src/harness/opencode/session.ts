import { createLogger } from "../../logger";
import { pluginConfig } from "../../config";
import { REASONING_EFFORT_SET, type ReasoningEffort } from "../../types";
import { HarnessMessageQueue, PromptReader } from "../harness-events";
import type {
  HarnessLaunchOptions,
  HarnessMessage,
  HarnessResult,
  HarnessSession,
} from "../types";
import { FollowUpDeliveryUnconfirmedError } from "../follow-up-delivery-error";
import type { EndpointLease, OpenCodeEndpoint } from "./endpoint";
import type { OpenCodeEvent } from "./protocol/events";
import type { S_Model_Info, S_Model_Ref, S_Session_Info } from "./protocol/api";
import { EventHub } from "./event-hub";
import { EventCursor } from "./event-cursor";
import { OpenCodeApiError, classifyApiError } from "./errors";
import { PendingInputCoordinator } from "./interaction";
import { EventMapper } from "./mapper";
import { rulesForMode, agentForMode } from "./permissions";
import { UsageAccumulator, modelFacts } from "./usage";
import { TurnTracker, type TurnOutcome } from "./turn";
import { newMessageId } from "./ids";
export interface SessionDependencies {
  endpoint: OpenCodeEndpoint;
  hubs: Map<number, EventHub>;
  turnTimeoutMs?: number;
  streamReconnectDelayMs?: number;
}
function promptText(message: unknown): string {
  if (typeof message === "string") return message;
  const value = message as { text?: string; message?: { content?: string } };
  return value?.text ?? value?.message?.content ?? "";
}
export function launchOpenCodeSession(
  options: HarnessLaunchOptions,
  deps: SessionDependencies,
): HarnessSession {
  const output = new HarnessMessageQueue();
  const emit = (e: HarnessMessage) => output.enqueue(e);
  const input: AsyncIterable<unknown> =
    typeof options.prompt === "string"
      ? (async function* () {
          yield options.prompt;
        })()
      : options.prompt;
  const prompts = new PromptReader(input);
  const cursor = new EventCursor();
  const usage = new UsageAccumulator();
  const lifetime = new AbortController();
  let lease: EndpointLease | undefined;
  let unsubscribe: (() => void) | undefined;
  let sessionID = options.resumeSessionId;
  let closed = false;
  let mode = options.permissionMode ?? "default";
  let models: S_Model_Info[] = [];
  let runCounter = 0;
  let fallbackInstructions = false;
  let run:
    | {
        tracker: TurnTracker;
        mapper: EventMapper;
        resolve: (o: TurnOutcome) => void;
        start: number;
        activity: number;
        idle?: number;
        continuing?: number;
        settled: boolean;
      }
    | undefined;
  const submissions = new Set<Promise<unknown>>();
  let interrupting = false;
  let recovery: Promise<void> | undefined;
  const params = () => ({ sessionID: sessionID! });
  const assertLease = (): EndpointLease => {
    if (closed || !lease)
      throw new Error(
        "OpenCode endpoint unavailable; resume the session before replying.",
      );
    return lease;
  };
  const inputs = new PendingInputCoordinator(emit, async (request, reply) => {
    const client = assertLease().client;
    const p = {
      sessionID: request.value.sessionID,
      requestID: request.value.id,
      formID: request.value.id,
    };
    if (reply.kind === "permission")
      await client.request(
        "POST /api/session/{sessionID}/permission/{requestID}/reply",
        p,
        {
          decision: reply.decision,
          ...(reply.message ? { message: reply.message } : {}),
        },
      );
    if (reply.kind === "form")
      await client.request(
        "POST /api/session/{sessionID}/form/{formID}/reply",
        p,
        { answer: reply.answer },
      );
    if (reply.kind === "cancel")
      await client.request(
        "DELETE /api/session/{sessionID}/form/{formID}",
        p,
        undefined,
        `?message=${encodeURIComponent(reply.message)}`,
      );
  });
  const finish = (outcome: TurnOutcome) => {
    if (run && !run.settled) {
      run.settled = true;
      run.resolve(outcome);
    }
  };
  const reportModel = (model: S_Model_Ref) => {
    const facts = modelFacts(models, model, options.reasoningEffort);
    const variant = model.variant;
    emit({
      type: "backend_info",
      info: {
        model: facts.model,
        reasoningEffort:
          variant && REASONING_EFFORT_SET.has(variant as ReasoningEffort)
            ? (variant as ReasoningEffort)
            : null,
        reasoningEffortSupported:
          variant === options.reasoningEffort
            ? facts.reasoningEffortSupported
            : !options.reasoningEffort &&
              !!variant &&
              modelFacts(models, model, variant).reasoningEffortSupported,
      },
    });
    if (facts.contextWindow)
      emit({
        type: "usage_updated",
        usage: { contextWindow: facts.contextWindow },
      });
  };
  let modelUpdate: Promise<void> | undefined;
  async function applyEffort(model: S_Model_Ref): Promise<S_Model_Ref> {
    if (
      !options.reasoningEffort ||
      model.variant === options.reasoningEffort ||
      !modelFacts(models, model, options.reasoningEffort)
        .reasoningEffortSupported
    )
      return model;
    const selected = { ...model, variant: options.reasoningEffort };
    await assertLease().client.request(
      "POST /api/session/{sessionID}/model",
      params(),
      { model: selected },
    );
    return selected;
  }
  const apply = (event: OpenCodeEvent) => {
    if (event.type === "permission.asked") {
      if (mode === "bypassPermissions")
        void autoReply(event.data).catch((e) =>
          finish({
            outcome: "failed",
            errorCode: classifyApiError(e),
            message: String(e),
          }),
        );
      else inputs.add({ kind: "permission", value: event.data });
    }
    if (event.type === "form.created")
      inputs.add({ kind: "form", value: event.data.form });
    if (event.type === "permission.replied")
      inputs.resolve(event.data.requestID);
    if (event.type === "form.replied" || event.type === "form.cancelled")
      inputs.resolve(event.data.id);
    if (
      !run ||
      run.settled ||
      !event.data ||
      typeof event.data !== "object" ||
      !("sessionID" in event.data)
    )
      return;
    run.activity = Date.now();
    // The hub has already verified this session's parent/child relationship.
    // Child activity keeps the parent alive without replacing its answer/usage.
    if (event.data.sessionID !== sessionID) {
      emit({ type: "activity" });
      return;
    }
    for (const message of run.mapper.map(event)) emit(message);
    const snapshot = usage.apply(event);
    if (snapshot) emit({ type: "usage_updated", usage: snapshot });
    if (
      event.type === "session.step.started" ||
      event.type === "session.model.selected"
    ) {
      reportModel(event.data.model);
      // Some servers first resolve their configured default during execution.
      // Apply the requested variant as soon as that model becomes known.
      if (!options.model && !modelUpdate) {
        modelUpdate = applyEffort(event.data.model)
          .then((): void => undefined)
          .catch((error) => finish({
            outcome: "failed",
            errorCode: classifyApiError(error),
            message: String(error),
          }))
          .finally(() => {
            modelUpdate = undefined;
          });
      }
    }
    if (event.type === "session.compaction.ended" && fallbackInstructions)
      void instructions().catch((e) =>
        finish({
          outcome: "failed",
          errorCode: classifyApiError(e),
          message: String(e),
        }),
      );
    if (event.type === "session.status") {
      if (event.data.status.type === "idle") run.idle ??= Date.now();
      else run.idle = undefined;
    }
    if (event.type === "session.execution.started") run.idle = undefined;
    const outcome = run.tracker.apply(event);
    if (outcome) finish(outcome);
    if (run.tracker.continuing) run.continuing ??= Date.now();
    else run.continuing = undefined;
  };
  async function autoReply(request: {
    sessionID: string;
    id: string;
  }): Promise<void> {
    await assertLease().client.request(
      "POST /api/session/{sessionID}/permission/{requestID}/reply",
      { sessionID: request.sessionID, requestID: request.id },
      { decision: "once" },
    );
    inputs.resolve(request.id);
  }
  const receive = (e: OpenCodeEvent) => {
    if (cursor.accept(e)) apply(e);
  };
  async function instructions(): Promise<void> {
    if (!options.systemPrompt) return;
    const client = assertLease().client;
    if (!fallbackInstructions) {
      try {
        await client.request(
          "PUT /api/experimental/session/{sessionID}/instructions/entries/{key}",
          { ...params(), key: "oca.system" },
          { value: options.systemPrompt },
        );
        return;
      } catch (e) {
        if (!(e instanceof OpenCodeApiError) || ![404, 413].includes(e.status))
          throw e;
        fallbackInstructions = true;
      }
    }
    await client.request("POST /api/session/{sessionID}/synthetic", params(), {
      text: options.systemPrompt,
      resume: false,
    });
  }
  const children = new Set<string>();
  let replayWarned = false;
  async function reconcile(): Promise<void> {
    if (recovery) return recovery;
    recovery = (async () => {
      if (!lease || !sessionID || closed) return;
      const replayed = await cursor.catchUp(
        lease.client,
        sessionID,
        apply,
        lifetime.signal,
      );
      if (!replayed && !replayWarned) {
        replayWarned = true;
        createLogger("opencode-harness").warn(
          "OpenCode durable log unavailable or payload retention disabled; reconciling session messages and pending input.",
        );
      }
      const pendingParents = [sessionID, ...children];
      for (let i = 0; i < pendingParents.length; i++) {
        const parent = pendingParents[i];
        let pageCursor: string | undefined;
        do {
          const page = await lease.client.request(
            "GET /api/session",
            {},
            undefined,
            `?parentID=${encodeURIComponent(parent)}&limit=100${pageCursor ? `&cursor=${encodeURIComponent(pageCursor)}` : ""}`,
          );
          for (const child of page.data)
            if (!children.has(child.id)) {
              children.add(child.id);
              pendingParents.push(child.id);
              deps.hubs.get(lease.generation)?.trackChild(child.id, parent);
            }
          pageCursor = page.cursor.next ?? undefined;
        } while (pageCursor);
      }
      for (const id of [sessionID, ...children]) {
        const [permissions, forms] = await Promise.all([
          lease.client.data("GET /api/session/{sessionID}/permission", {
            sessionID: id,
          }),
          lease.client.data("GET /api/session/{sessionID}/form", {
            sessionID: id,
          }),
        ]);
        inputs.reconcile(id, [
          ...permissions.map((value) => ({
            kind: "permission" as const,
            value,
          })),
          ...forms.map((value) => ({ kind: "form" as const, value })),
        ]);
        if (mode === "bypassPermissions")
          for (const p of permissions) await autoReply(p);
      }
      if (run && !run.settled) {
        const recoveringRun = run;
        const [info, active, inbox] = await Promise.all([
          lease.client.data("GET /api/session/{sessionID}", params()),
          lease.client.data("GET /api/session/active"),
          lease.client.data("GET /api/session/{sessionID}/inbox", params()),
        ]);
        // Default CLI builds can expose /log without retaining its payloads.
        // Exact message lookup confirms delivery even when that log is empty.
        for (const id of recoveringRun.tracker.owned)
          if (
            !recoveringRun.tracker.delivered.has(id) &&
            !inbox.some((i) => i.id === id)
          ) {
            const confirmed = await admitted(id);
            if (confirmed === true) recoveringRun.tracker.delivered.add(id);
            else if (confirmed === undefined && recoveringRun.tracker.continuing)
              throw new FollowUpDeliveryUnconfirmedError();
          }
        // Repair text before the hub forwards any post-gap deltas, including
        // parts whose text.ended event was lost while the execution stayed active.
        const messages = [];
        let messageCursor: string | undefined;
        do {
          const page = await lease.client.request(
            "GET /api/session/{sessionID}/message",
            params(),
            undefined,
            messageCursor
              ? `?limit=100&cursor=${encodeURIComponent(messageCursor)}`
              : "?order=desc&limit=100",
          );
          messages.push(...page.data.filter((m) => m.time.created >= recoveringRun.start));
          messageCursor = page.data.some((m) => m.time.created < recoveringRun.start)
            ? undefined
            : page.cursor.next ?? undefined;
        } while (messageCursor);
        if (run !== recoveringRun || recoveringRun.settled || closed) return;
        recoveringRun.mapper.beginRecovery();
        for (const message of [...messages].reverse())
          if (message.type === "assistant")
            for (const mapped of recoveringRun.mapper.restore(
              message.id,
              message.content.filter((p) => p.type === "text").map((p) => p.text),
            )) emit(mapped);
        if (
          !active[sessionID] &&
          info.time.idle >= recoveringRun.start &&
          recoveringRun.tracker.delivered.size &&
          ![...recoveringRun.tracker.owned].some(
            (id) => !recoveringRun.tracker.delivered.has(id),
          ) &&
          info.outcome
        ) {
          const idle = messages.find(
            (m) => m.type === "idle" && m.time.created >= recoveringRun.start,
          );
          finish({
            outcome:
              info.outcome === "succeeded"
                ? "completed"
                : info.outcome === "failed"
                  ? "failed"
                  : "interrupted",
            ...(info.outcome === "failed"
              ? {
                  errorCode:
                    idle?.type === "idle"
                      ? (idle.error?.type ?? "opencode_execution_failed")
                      : "opencode_execution_failed",
                }
              : {}),
          });
        }
      }
    })().finally(() => {
      recovery = undefined;
    });
    return recovery;
  }
  async function ensureSession(): Promise<void> {
    if (lease) return;
    const acquired = await deps.endpoint.acquire();
    if (closed || lifetime.signal.aborted) {
      await acquired.release();
      throw new Error("OpenCode launch cancelled during endpoint startup.");
    }
    lease = acquired;
    const generation = lease.generation;
    lease.onLost((reason) => {
      if (lease?.generation !== generation) return;
      finish({
        outcome: "failed",
        errorCode: "opencode_shutdown",
        message: reason,
      });
      unsubscribe?.();
      unsubscribe = undefined;
      const old = lease;
      lease = undefined;
      void old.release();
      deps.hubs.get(generation)?.close();
      deps.hubs.delete(generation);
    });
    const client = lease.client;
    models = await client.data(
      "GET /api/model",
      {},
      undefined,
      `?${new URLSearchParams({ "location[directory]": options.cwd })}`,
    );
    assertLease();
    const requested = options.model;
    let model: S_Model_Ref | undefined;
    if (requested) {
      const slash = requested.indexOf("/");
      if (slash <= 0) throw new Error("OpenCode model must be provider/model");
      model = {
        providerID: requested.slice(0, slash),
        id: requested.slice(slash + 1),
      };
      if (
        modelFacts(models, model, options.reasoningEffort)
          .reasoningEffortSupported
      )
        model.variant = options.reasoningEffort;
    }
    let info: S_Session_Info;
    if (sessionID) {
      try {
        info = await client.data("GET /api/session/{sessionID}", params());
      } catch (e) {
        if (e instanceof OpenCodeApiError && e.status === 404)
          throw new Error(
            "OpenCode session not found in OCA's private database; start a new session.",
          );
        throw e;
      }
      if (info.location.directory !== options.cwd)
        throw new Error(
          "OpenCode resumed session location differs from the requested working directory.",
        );
      let before: string | undefined;
      if (options.rewindTurns) {
        const messages = await client.data(
          "GET /api/session/{sessionID}/message",
          params(),
          undefined,
          `?type=user&order=desc&limit=${options.rewindTurns}`,
        );
        if (messages.length < options.rewindTurns)
          throw new Error("OpenCode rewind exceeds the available user turns.");
        before = messages.at(-1)!.id;
      }
      if (options.forkSession && runCounter === 0) {
        info = await client.data(
          "POST /api/session/{sessionID}/fork",
          params(),
          before ? { before } : {},
        );
        sessionID = info.id;
      } else if (before && runCounter === 0) {
        await client.request(
          "POST /api/session/{sessionID}/revert/stage",
          params(),
          { messageID: before, files: false },
        );
        await client.request(
          "POST /api/session/{sessionID}/revert/commit",
          params(),
        );
      }
      if (model)
        await client.request("POST /api/session/{sessionID}/model", params(), {
          model,
        });
      await client.request("PATCH /api/session/{sessionID}", params(), {
        permissions: rulesForMode(mode),
      });
      await client.request("POST /api/session/{sessionID}/agent", params(), {
        agent: agentForMode(
          mode,
          pluginConfig.harnesses.opencode?.defaultAgent,
        ),
      });
    } else {
      info = await client.data(
        "POST /api/session",
        {},
        {
          location: { directory: options.cwd },
          permissions: rulesForMode(mode),
          agent: agentForMode(
            mode,
            pluginConfig.harnesses.opencode?.defaultAgent,
          ),
          ...(model ? { model } : {}),
        },
      );
      sessionID = info.id;
    }
    emit({
      type: "backend_ref",
      ref: { kind: "opencode-v2", conversationId: sessionID! },
    });
    model ??= info.model;
    if (model) model = await applyEffort(model);
    if (model) reportModel(model);
    let hub = deps.hubs.get(generation);
    if (!hub || hub.closed) {
      hub = new EventHub(lease, deps.streamReconnectDelayMs);
      deps.hubs.set(generation, hub);
    }
    const subscription = await hub.subscribe(
      sessionID!,
      (e) => {
        if (e.type === "session.created" && e.data.parentID)
          children.add(e.data.sessionID);
        receive(e);
      },
      async () => {
        run?.mapper.beginRecovery();
        await reconcile();
      },
      lifetime.signal,
    );
    if (closed) {
      subscription();
      throw new Error("OpenCode launch cancelled during event subscription.");
    }
    unsubscribe = subscription;
    await reconcile();
    const history = [];
    let historyCursor: string | undefined;
    do {
      const page = await client.request(
        "GET /api/session/{sessionID}/message",
        params(),
        undefined,
        historyCursor
          ? `?limit=100&cursor=${encodeURIComponent(historyCursor)}`
          : "?limit=100&order=asc",
      );
      history.push(...page.data);
      historyCursor = page.cursor.next ?? undefined;
      assertLease();
    } while (historyCursor);
    const baseline = await client.data("GET /api/session/{sessionID}", params());
    usage.restore(history, baseline.cost);
    emit({ type: "usage_updated", usage: usage.snapshot() });
    await instructions();
  }
  async function admitted(id: string): Promise<boolean | undefined> {
    try {
      const client = assertLease().client;
      const inbox = await client.data(
        "GET /api/session/{sessionID}/inbox",
        params(),
      );
      if (inbox.some((i) => i.id === id)) return true;
      // The exact message endpoint avoids pagination races after execution.
      try {
        await client.data("GET /api/session/{sessionID}/message/{messageID}", {
          ...params(),
          messageID: id,
        });
        return true;
      } catch (e) {
        if (e instanceof OpenCodeApiError && e.status === 404) return false;
        throw e;
      }
    } catch {
      return undefined;
    }
  }
  async function submit(
    text: string,
    id: string,
    delivery: "queue" | "steer",
    compact = false,
  ): Promise<boolean> {
    let submission: Promise<unknown> | undefined;
    try {
      submission = compact
        ? assertLease().client.request(
            "POST /api/session/{sessionID}/compact",
            params(),
            { id, delivery },
          )
        : assertLease().client.request(
            "POST /api/session/{sessionID}/prompt",
            params(),
            { id, text, delivery },
          );
      submissions.add(submission);
      await submission;
      return true;
    } catch (e) {
      if (e instanceof OpenCodeApiError && e.status === 409) {
        const confirmed = await admitted(id);
        if (confirmed === true) return true;
        if (confirmed === undefined)
          throw new FollowUpDeliveryUnconfirmedError();
        if (delivery === "steer") return false;
        throw e;
      }
      if (
        e instanceof OpenCodeApiError &&
        e.status === 404 &&
        delivery === "steer"
      )
        return false;
      if (e instanceof OpenCodeApiError) throw e;
      const confirmed = await admitted(id);
      if (confirmed === true) return true;
      if (confirmed === false && delivery === "steer") return false;
      throw new FollowUpDeliveryUnconfirmedError();
    } finally {
      if (submission) submissions.delete(submission);
    }
  }
  async function interrupt(): Promise<void> {
    if (!run || run.settled || interrupting) return;
    const interruptedRun = run;
    interrupting = true;
    run.tracker.interruptRequested = true;
    try {
      await Promise.allSettled([...submissions]);
      const client = assertLease().client;
      await client.request(
        "POST /api/session/{sessionID}/interrupt",
        params(),
        undefined,
        "?resume=false",
      );
      for (const id of interruptedRun.tracker.owned)
        if (!interruptedRun.tracker.delivered.has(id)) {
          try {
            await client.request(
              "DELETE /api/session/{sessionID}/inbox/{inboxID}",
              { ...params(), inboxID: id },
            );
          } catch (e) {
            if (!(e instanceof OpenCodeApiError) || e.status !== 404) throw e;
          }
        }
      if (!interruptedRun.tracker.delivered.size && run === interruptedRun)
        finish({ outcome: "interrupted" });
      // The terminal may close this launch while a reconciliation is in flight.
      // The accepted interrupt must not fail because close aborts that read.
      if (!closed && run === interruptedRun && !interruptedRun.settled)
        void reconcile().catch((error) => {
          if (!lifetime.signal.aborted)
            finish({ outcome: "failed", errorCode: classifyApiError(error) });
        });
    } finally {
      interrupting = false;
    }
  }
  const close = async () => {
    if (closed) return;
    try {
      await interrupt();
    } catch {
      // Closing must release transports even after server or connection loss.
      finish({ outcome: "interrupted" });
    } finally {
      closed = true;
      lifetime.abort();
      finish({ outcome: "interrupted" });
      inputs.clear();
      unsubscribe?.();
      if (lease) {
        await lease.release();
        lease = undefined;
      }
      output.close();
    }
  };
  const onAbort = () => {
    void close();
  };
  options.abortController?.signal.addEventListener("abort", onAbort, {
    once: true,
  });
  if (options.abortController?.signal.aborted) void close();
  async function nextPrompt(): Promise<IteratorResult<unknown>> {
    let abort: () => void = (): void => undefined;
    try {
      return await Promise.race([
        prompts.next(),
        new Promise<IteratorResult<unknown>>((resolve) => {
          abort = () => resolve({ done: true, value: undefined });
          if (lifetime.signal.aborted) abort();
          else lifetime.signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      lifetime.signal.removeEventListener("abort", abort);
    }
  }
  void (async () => {
    let priorFailure: TurnOutcome | undefined;
    try {
      while (!closed) {
        const next = await nextPrompt();
        if (next.done || closed) break;
        if (inputs.pending && (await inputs.text(promptText(next.value)))) {
          emit({ type: "prompt_settled" });
          continue;
        }
        try {
          await ensureSession();
        } catch (error) {
          runCounter++;
          emit({ type: "run_started", runId: newMessageId() });
          throw error;
        }
        if (closed) break;
        await modelUpdate;
        const id = newMessageId();
        const tracker = new TurnTracker();
        tracker.begin(id);
        let resolve!: (o: TurnOutcome) => void;
        const done = new Promise<TurnOutcome>((r) => {
          resolve = r;
        });
        run = {
          tracker,
          mapper: new EventMapper(),
          resolve,
          start: Date.now(),
          activity: Date.now(),
          settled: false,
        };
        runCounter++;
        emit({ type: "run_started", runId: id });
        const timer = setInterval(() => {
          if (!run || run.settled || closed) return;
          if (inputs.pending) {
            run.activity = Date.now();
            return;
          }
          if (Date.now() - run.activity > (deps.turnTimeoutMs ?? 15 * 60000)) {
            void assertLease()
              .client.request(
                "POST /api/session/{sessionID}/interrupt",
                params(),
                undefined,
                "?resume=false",
              )
              .catch((): undefined => undefined);
            finish({ outcome: "failed", errorCode: "opencode_inactivity" });
          }
          if (
            (run.idle && Date.now() - run.idle > 3000) ||
            (run.continuing && Date.now() - run.continuing > 5000)
          )
            void reconcile().catch((e) =>
              finish({
                outcome: "failed",
                errorCode: classifyApiError(e),
                message: String(e),
              }),
            );
        }, 1000);
        let outcome: TurnOutcome;
        try {
          const compact =
            (next.value as { ocaAction?: string })?.ocaAction === "compact";
          await submit(promptText(next.value), id, "queue", compact);
          outcome = await done;
        } catch (e) {
          outcome = {
            outcome: "failed",
            errorCode: classifyApiError(e),
            message: e instanceof Error ? e.message : String(e),
          };
        } finally {
          clearInterval(timer);
        }
        const mapper = run.mapper;
        const started = run.start;
        run = undefined;
        inputs.clear();
        let cost = usage.snapshot().costUsd ?? 0;
        if (lease)
          try {
            cost = (
              await lease.client.data("GET /api/session/{sessionID}", params())
            ).cost;
          } catch {
            /* Preserve the last confirmed usage. */
          }
        if (outcome.outcome === "failed") priorFailure = outcome;
        if (!closed && (await prompts.hasQueued())) continue;
        outcome = priorFailure ?? outcome;
        priorFailure = undefined;
        const result: HarnessResult = {
          success: outcome.outcome === "completed",
          outcome: outcome.outcome,
          outcomeAuthoritative: true,
          errorCode: outcome.errorCode,
          duration_ms: Date.now() - started,
          total_cost_usd: cost,
          num_turns: runCounter,
          result: outcome.message ?? mapper.result(),
          session_id: sessionID!,
          usage: usage.snapshot(),
        };
        emit({ type: "run_completed", data: result });
      }
    } catch (e) {
      emit({
        type: "run_completed",
        data: {
          success: false,
          outcome: "failed",
          outcomeAuthoritative: true,
          errorCode: classifyApiError(e),
          duration_ms: 0,
          total_cost_usd: 0,
          num_turns: runCounter,
          result: e instanceof Error ? e.message : String(e),
          session_id: sessionID ?? "",
        },
      });
    } finally {
      options.abortController?.signal.removeEventListener("abort", onAbort);
      await close();
    }
  })();
  return {
    messages: output.messages(),
    close,
    interrupt,
    setPermissionMode: async (value) => {
      const client = assertLease().client;
      await client.request("PATCH /api/session/{sessionID}", params(), {
        permissions: rulesForMode(value),
      });
      await client.request("POST /api/session/{sessionID}/agent", params(), {
        agent: agentForMode(
          value,
          pluginConfig.harnesses.opencode?.defaultAgent,
        ),
      });
      mode = value;
      emit({ type: "settings_changed", permissionMode: value });
    },
    steer: async (text) => {
      if (!run || run.settled || interrupting || closed) return false;
      const tracker = run.tracker;
      const id = newMessageId();
      tracker.begin(id);
      try {
        const accepted = await submit(text, id, "steer");
        if (!accepted) tracker.forget(id);
        return accepted;
      } catch (e) {
        if (!(e instanceof FollowUpDeliveryUnconfirmedError))
          tracker.forget(id);
        throw e;
      }
    },
    submitPendingInputOption: (i, c) => inputs.option(i, c),
    submitPendingInputText: (t) => inputs.text(t),
  };
}
