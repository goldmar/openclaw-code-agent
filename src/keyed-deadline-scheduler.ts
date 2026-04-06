export class KeyedDeadlineScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private static readonly MAX_DELAY_MS = 2_147_483_647;

  schedule(key: string, at: number, cb: () => void): void {
    if (this.disposed) return;
    this.cancel(key);

    const delayMs = Math.max(0, at - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(key);
      if (this.disposed) return;
      if (at - Date.now() > KeyedDeadlineScheduler.MAX_DELAY_MS) {
        this.schedule(key, at, cb);
        return;
      }
      cb();
    }, Math.min(delayMs, KeyedDeadlineScheduler.MAX_DELAY_MS));
    timer.unref?.();
    this.timers.set(key, timer);
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(key);
  }

  cancelPrefix(prefix: string): void {
    for (const key of this.timers.keys()) {
      if (key.startsWith(prefix)) {
        this.cancel(key);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
