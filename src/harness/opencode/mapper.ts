import type { OpenCodeEvent } from "./protocol/events";
import type { HarnessMessage } from "../types";
/** Pure, per-turn projection. Durable full text repairs missing live suffixes. */
export class EventMapper {
  private parts = new Map<string, string>();
  private messages = new Map<string, string[]>();
  private names = new Map<string, string>();
  private called = new Set<string>();
  private lastPart: string | undefined;
  private emitted = new Map<string, string>();
  private recovering = false;
  /** Deltas after a gap have unknown offsets; wait for authoritative full text. */
  beginRecovery(): void {
    this.recovering = true;
  }
  result(): string {
    return (
      [...this.messages.values()]
        .map((keys) => keys.map((k) => this.parts.get(k) ?? "").join("\n\n"))
        .filter(Boolean)
        .at(-1) ?? ""
    );
  }
  restore(messageID: string, parts: string[]): HarnessMessage[] {
    const output: HarnessMessage[] = [];
    parts.forEach((text, ordinal) => {
      const key = `${messageID}:${ordinal}`;
      const previous = this.emitted.get(key) ?? "";
      if (!this.parts.has(key)) {
        const keys = this.messages.get(messageID) ?? [];
        keys.push(key);
        this.messages.set(messageID, keys);
        if (this.lastPart) output.push({ type: "text_delta", text: "\n\n" });
        this.lastPart = key;
      }
      this.parts.set(key, text);
      if (text.startsWith(previous) && text.length > previous.length) {
        output.push({ type: "text_delta", text: text.slice(previous.length) });
        this.emitted.set(key, text);
      }
    });
    return output;
  }
  map(e: OpenCodeEvent): HarnessMessage[] {
    const output: HarnessMessage[] = [];
    if (e.type.startsWith("session.")) output.push({ type: "activity" });
    if (
      e.type === "session.text.started" ||
      e.type === "session.text.delta" ||
      e.type === "session.text.ended"
    ) {
      const d = e.data;
      const key = `${d.assistantMessageID}:${d.ordinal}`;
      if (!this.parts.has(key)) {
        this.parts.set(key, "");
        const keys = this.messages.get(d.assistantMessageID) ?? [];
        keys.push(key);
        this.messages.set(d.assistantMessageID, keys);
        if (this.lastPart) output.push({ type: "text_delta", text: "\n\n" });
        this.lastPart = key;
      }
      const previous = this.parts.get(key)!;
      if (e.type === "session.text.delta") {
        this.parts.set(key, previous + e.data.delta);
        if (!this.recovering) {
          output.push({ type: "text_delta", text: e.data.delta });
          this.emitted.set(key, previous + e.data.delta);
        }
      }
      if (e.type === "session.text.ended") {
        this.parts.set(key, e.data.text);
        const emitted = this.emitted.get(key) ?? "";
        if (
          e.data.text.startsWith(emitted) &&
          e.data.text.length > emitted.length
        ) {
          output.push({
            type: "text_delta",
            text: e.data.text.slice(emitted.length),
          });
          this.emitted.set(key, e.data.text);
        }
      }
    }
    if (e.type === "session.tool.input.started")
      this.names.set(e.data.id, e.data.name);
    if (e.type === "session.tool.called" && !this.called.has(e.data.id)) {
      this.called.add(e.data.id);
      output.push({
        type: "tool_call",
        name: this.names.get(e.data.id) ?? "tool",
        input: e.data.input,
      });
    }
    return output;
  }
}
