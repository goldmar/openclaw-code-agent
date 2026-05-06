export class KeyedOperationQueue {
  private tails: Map<string, Promise<void>> = new Map();

  /**
   * Serializes operations per key. A failed operation rejects only its caller;
   * later operations still run.
   */
  enqueue(
    key: string,
    fn: () => Promise<void>,
    onQueued?: () => void,
  ): Promise<void> {
    const current = this.tails.get(key);
    if (current !== undefined) onQueued?.();

    const previous = current?.catch(() => {}) ?? Promise.resolve();
    const next = previous.then(() => fn());

    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    tail.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });

    return next;
  }

  clear(): void {
    this.tails.clear();
  }
}
