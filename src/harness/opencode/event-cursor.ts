import type { OpenCodeEvent } from "./protocol/events";
import type { OpenCodeClient } from "./client";
import { OpenCodeApiError } from "./errors";
import { sseFrames } from "./sse";
export class EventCursor {
  private positions = new Map<string, number>();
  private missing = false;
  replayUnavailable = false;
  accept(event: OpenCodeEvent): boolean {
    if (!("durable" in event)) return true;
    const d = event.durable;
    const previous = this.positions.get(d.aggregateID);
    if (previous !== undefined && d.seq <= previous) return false;
    this.positions.set(d.aggregateID, d.seq);
    return true;
  }
  async catchUp(
    client: OpenCodeClient,
    sessionID: string,
    emit: (event: OpenCodeEvent) => void,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.missing) return false;
    try {
      const after = this.positions.get(sessionID);
      const response = await client.raw(
        "GET",
        `/api/experimental/session/${encodeURIComponent(sessionID)}/log?follow=false${after === undefined ? "" : `&after=${after}`}`,
        undefined,
        signal,
        true,
      );
      let count = 0;
      for await (const frame of sseFrames(response)) {
        const value =
          typeof frame.data === "string" ? JSON.parse(frame.data) : frame.data;
        if (frame.event === "log.synced" || value.type === "log.synced") {
          if (
            count === 0 &&
            value.seq !== undefined &&
            (after === undefined || value.seq > after)
          )
            this.replayUnavailable = true;
          return !this.replayUnavailable;
        }
        const event = (value.event ?? value) as OpenCodeEvent;
        if (this.accept(event)) {
          count++;
          emit(event);
        }
      }
      return true;
    } catch (e) {
      if (e instanceof OpenCodeApiError && e.status === 404) {
        this.missing = true;
        this.replayUnavailable = true;
        return false;
      }
      throw e;
    }
  }
}
