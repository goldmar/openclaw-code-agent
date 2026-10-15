import type { HarnessUsage, HarnessModelUsage } from "../types";
import type { S_Model_Info, S_Model_Ref } from "./protocol/api";
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
  private current = "unknown";
  private cost = 0;
  private contextTokens: number | undefined;
  apply(event: OpenCodeEvent): HarnessUsage | undefined {
    if (event.type === "session.step.started")
      this.current = `${event.data.model.providerID}/${event.data.model.id}`;
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
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    const d = event.data;
    if (!d.tokens && d.cost === undefined) return;
    const t = d.tokens ?? {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
    const model =
      event.type === "session.compaction.ended"
        ? event.data.model
          ? `${event.data.model.providerID}/${event.data.model.id}`
          : "unknown"
        : this.current;
    const value = this.models.get(model) ?? {
      model,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    value.costUsd += d.cost ?? 0;
    value.inputTokens += t.input;
    value.outputTokens += t.output;
    value.reasoningTokens += t.reasoning;
    value.cacheReadTokens += t.cache.read;
    value.cacheWriteTokens += t.cache.write;
    this.models.set(model, value);
    if (d.tokens) this.contextTokens = t.input + t.cache.read + t.cache.write;
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
