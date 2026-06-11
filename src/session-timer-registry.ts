export class SessionTimerRegistry {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  get size(): number {
    return this.timers.size;
  }

  set(name: string, ms: number, cb: () => void): void {
    this.clear(name);
    const timer = setTimeout(() => {
      if (this.timers.get(name) === timer) this.timers.delete(name);
      cb();
    }, ms);
    timer.unref?.();
    this.timers.set(name, timer);
  }

  clear(name: string): void {
    const timer = this.timers.get(name);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(name);
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
