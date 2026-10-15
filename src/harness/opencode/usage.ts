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
  private cost = 0;
  private contextTokens: number | undefined;
  restore(messages: S_Session_Message_Info[], cost: number): void {
    this.seen.clear();
    this.models.clear();
    this.contextTokens = undefined;
    this.current = undefined;
    this.cost = cost;
    for (const message of messages) {
      if (message.type !== "assistant" && message.type !== "compaction")
        continue;
      if (message.type === "compaction" && message.status === "running")
        continue;
      if (message.type === "assistant" && !message.time.completed) continue;
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
    if (tokens)
      this.contextTokens = tokens.input + tokens.cache.read + tokens.cache.write;
  }
  apply(event: OpenCodeEvent): HarnessUsage | undefined {
    if (event.type === "session.step.started")
      this.current = event.data.model;
    if (event.type === "session.usage.updated") {
      this.cost = event.data.cost;
      return this.snapshot();
    }
    if (
      event.type !== "session.step.ended" &&
      event.type !== "session.step.failed" &&
      event.type !== "session.compaction.ended"
    )
      return;
    const key = event.type === "session.compaction.ended"
      ? event.id
      : event.data.assistantMessageID;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const d = event.data;
    if (!d.tokens && d.cost === undefined) return;
    const model =
      event.type === "session.compaction.ended"
        ? event.data.model
        : this.current;
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
