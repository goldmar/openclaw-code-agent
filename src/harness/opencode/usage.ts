import type { HarnessUsage, HarnessModelUsage } from "../types";
import type {
  S_Model_Info,
  S_Model_Ref,
  S_Session_Message_Info,
  S_TokenUsage_Info,
} from "./protocol/api";
import type { OpenCodeEvent } from "./protocol/events";
export function modelFacts(
  models: S_Model_Info[],
  model: S_Model_Ref,
  effort?: string,
) {
  const info = models.find(
    (m) =>
      m.providerID === model.providerID &&
      (m.id === model.id || m.modelID === model.id),
  );
  return {
    model: `${model.providerID}/${model.id}`,
    reasoningEffortSupported:
      !!effort && !!info?.variants.some((v) => v.id === effort),
    contextWindow: info?.limit.context,
  };
}
export class UsageAccumulator {
  private seen = new Set<string>();
  private models = new Map<string, HarnessModelUsage>();
  private current: S_Model_Ref | undefined;
  private compactionID: string | undefined;
  private messageModels = new Map<string, S_Model_Ref>();
  private messageStarted = new Map<string, number>();
  private cost = 0;
  private contextTokens: number | undefined;
  private contextPosition: { created: number; id: string } | undefined;
  restore(messages: S_Session_Message_Info[], cost: number): void {
    this.seen.clear();
    this.models.clear();
    this.contextTokens = undefined;
    this.current = undefined;
    this.compactionID = undefined;
    this.messageModels.clear();
    this.messageStarted.clear();
    this.contextPosition = undefined;
    this.merge(messages, cost);
  }
  merge(messages: S_Session_Message_Info[], cost: number): void {
    this.cost = cost;
    for (const message of messages) {
      if (message.type !== "assistant" && message.type !== "compaction")
        continue;
      this.messageStarted.set(message.id, message.time.created);
      if (message.type === "compaction" && message.status === "running") {
        this.compactionID = message.id;
        continue;
      }
      if (message.type === "assistant") {
        this.current = message.model;
        this.messageModels.set(message.id, message.model);
      }
      if (message.type === "assistant" && !message.time.completed) continue;
      // Context is the newest message's size, independent of cumulative
      // accounting: a live step may already be seen when recovery reads it.
      this.updateContext(message.id, message.time.created, message.tokens);
      if (this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      this.add(
        "model" in message ? message.model : undefined,
        message.cost,
        message.tokens,
      );
    }
  }
  private add(
    model: S_Model_Ref | undefined,
    cost: number | undefined,
    tokens: S_TokenUsage_Info | undefined,
  ): void {
    if (!tokens && cost === undefined) return;
    const key = model ? `${model.providerID}/${model.id}` : "unknown";
    const value = this.models.get(key) ?? {
      model: key,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    value.costUsd += cost ?? 0;
    value.inputTokens += tokens?.input ?? 0;
    value.outputTokens += tokens?.output ?? 0;
    value.reasoningTokens += tokens?.reasoning ?? 0;
    value.cacheReadTokens += tokens?.cache.read ?? 0;
    value.cacheWriteTokens += tokens?.cache.write ?? 0;
    this.models.set(key, value);
  }
  private updateContext(id: string, created: number, tokens: S_TokenUsage_Info | undefined): void {
    const previous = this.contextPosition;
    if (!tokens || (previous && (created < previous.created ||
      (created === previous.created && id < previous.id)))) return;
    this.contextPosition = { created, id };
    this.contextTokens = tokens.input + tokens.cache.read + tokens.cache.write;
  }
  apply(event: OpenCodeEvent): HarnessUsage | undefined {
    if (event.type === "session.step.started") {
      this.current = event.data.model;
      this.messageModels.set(event.data.assistantMessageID, event.data.model);
      this.messageStarted.set(event.data.assistantMessageID, event.data.started);
    }
    // Match the native projector's exact message identity (message-updater.ts):
    // compaction inputID, or SessionMessage.ID.fromEvent(startEvent.id).
    if (event.type === "session.compaction.started") {
      this.compactionID = event.data.inputID ?? event.id.replace(/^evt_/, "msg_");
      this.messageStarted.set(this.compactionID, event.created);
    }
    if (event.type === "session.usage.updated") {
      this.cost = event.data.cost;
      return this.snapshot();
    }
    if (
      event.type !== "session.step.ended" &&
      event.type !== "session.step.failed" &&
      event.type !== "session.compaction.ended" &&
      event.type !== "session.compaction.failed"
    )
      return;
    if (this.seen.has(event.id)) return;
    const compaction = event.type === "session.compaction.ended" || event.type === "session.compaction.failed";
    const key = compaction
      ? this.compactionID ?? (event.type === "session.compaction.failed" ? event.data.inputID : undefined) ?? event.id.replace(/^evt_/, "msg_")
      : event.data.assistantMessageID;
    this.updateContext(key, this.messageStarted.get(key) ?? event.created, event.data.tokens);
    this.seen.add(event.id);
    if (compaction) this.compactionID = undefined;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const d = event.data;
    if (!d.tokens && d.cost === undefined) return;
    const model =
      event.type === "session.compaction.ended"
        ? event.data.model
        : event.type === "session.compaction.failed"
          ? undefined
          : this.messageModels.get(event.data.assistantMessageID) ?? this.current;
    this.add(model, d.cost, d.tokens);
    return this.snapshot();
  }
  snapshot(): HarnessUsage {
    return {
      costUsd: this.cost,
      models: [...this.models.values()].map((v) => ({ ...v })),
      contextTokens: this.contextTokens,
    };
  }
}
