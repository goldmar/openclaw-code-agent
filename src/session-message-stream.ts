/**
 * Async queue used as the prompt stream for multi-turn harnesses.
 *
 * `Session.sendMessage()` pushes follow-up user messages into this queue and
 * the harness consumes it with `for await`.
 *
 * `hasPending()` is critical at turn boundaries: if follow-up prompts were
 * queued during an active turn, we keep the session alive so the queue can be
 * drained on the next turn instead of killing with reason `done`.
 *
 * `consumedCount` counts items the harness has pulled. A turn-sequential
 * harness (Codex, OpenCode) may pull the next queued prompt before Session has
 * applied the previous turn's completion, so the queue alone cannot tell
 * Session that a follow-up is still outstanding.
 */
export class MessageStream {
  private queue: unknown[] = [];
  private resolve: (() => void) | null = null;
  private done = false;
  private consumed = 0;

  hasPending(): boolean {
    return this.queue.length > 0;
  }

  /** Number of items the consumer has pulled so far. */
  get consumedCount(): number {
    return this.consumed;
  }

  push(msg: unknown): void {
    this.queue.push(msg);
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  end(): void {
    this.done = true;
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, undefined> {
    while (true) {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        this.consumed += 1;
        yield item;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.resolve = resolve;
      });
    }
  }
}
