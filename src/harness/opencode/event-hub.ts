import type { OpenCodeEvent } from "./protocol/events";
import type { EndpointLease } from "./endpoint";
import { sseFrames } from "./sse";
type Listener = {
  sessionID: string;
  event: (e: OpenCodeEvent) => void;
  gap: () => Promise<void>;
};
/** One public stream per endpoint generation; child requests retain their session ID. */
export class EventHub {
  private listeners = new Set<Listener>();
  private retrying = new Set<Listener>();
  private parents = new Map<string, string>();
  private controller = new AbortController();
  private started = false;
  get closed(): boolean {
    return this.controller.signal.aborted;
  }
  private connected = false;
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  private ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  constructor(
    private lease: EndpointLease,
    private delay = 1000,
  ) {
    this.ready.catch((): undefined => undefined);
  }
  async subscribe(
    sessionID: string,
    event: Listener["event"],
    gap: Listener["gap"],
    signal?: AbortSignal,
  ): Promise<() => void> {
    const listener = { sessionID, event, gap };
    this.listeners.add(listener);
    if (!this.started) {
      this.started = true;
      void this.run();
    }
    let timer: NodeJS.Timeout | undefined;
    let abort: () => void = (): void => undefined;
    try {
      await Promise.race([
        this.ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("OpenCode event stream never sent server.connected"),
              ),
            15000,
          );
          abort = () => reject(new Error("OpenCode event subscription closed"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } catch (e) {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.close();
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.close();
    };
  }
  trackChild(id: string, parent: string): void {
    this.parents.set(id, parent);
  }
  private root(id: string): string {
    const seen = new Set<string>();
    while (this.parents.has(id) && !seen.has(id)) {
      seen.add(id);
      id = this.parents.get(id)!;
    }
    return id;
  }
  private async run(): Promise<void> {
    let failures = 0;
    while (!this.controller.signal.aborted) {
      try {
        const response = await this.lease.client.raw(
          "GET",
          "/api/event",
          undefined,
          this.controller.signal,
          true,
        );
        for await (const frame of sseFrames(response)) {
          const event = frame.data as OpenCodeEvent;
          if (event.type === "server.connected") {
            const reconnect = this.connected;
            this.connected = true;
            failures = 0;
            this.readyResolve();
            // One session's failed reconcile must not tear down the stream
            // of every other session on this server; that session retries its
            // own recovery instead (events it missed are durable on the server).
            if (reconnect)
              for (const l of this.listeners)
                await l.gap().catch(() => this.retryGap(l));
            continue;
          }
          if (event.type === "session.created" && event.data.parentID)
            this.parents.set(event.data.sessionID, event.data.parentID);
          const sessionID =
            event.type === "form.created"
              ? event.data.form.sessionID
              : event.data &&
                  typeof event.data === "object" &&
                  "sessionID" in event.data
                ? event.data.sessionID
                : undefined;
          if (typeof sessionID === "string")
            for (const listener of this.listeners)
              if (this.root(sessionID) === listener.sessionID)
                listener.event(event);
        }
      } catch (e) {
        if (!this.connected) {
          this.readyReject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
      }
      if (this.controller.signal.aborted) break;
      await this.sleep(Math.min(30000, this.delay * 2 ** Math.min(failures++, 5)));
      // Reconcile before reconnecting too, and again after connected below: changes
      // in the reconnect window are durable, asks are fetched from their endpoints.
      if (this.controller.signal.aborted) break;
      for (const l of this.listeners)
        await l.gap().catch((): undefined => undefined);
    }
  }
  /** Retry one listener's reconcile with backoff until it succeeds, it unsubscribes, or the hub closes. */
  private retryGap(listener: Listener): void {
    if (this.retrying.has(listener)) return;
    this.retrying.add(listener);
    void (async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          if (!(await this.sleep(Math.min(30000, this.delay * 2 ** Math.min(attempt, 5))))) return;
          if (!this.listeners.has(listener)) return;
          try {
            await listener.gap();
            return;
          } catch {
            // Try again after the next backoff.
          }
        }
      } finally {
        this.retrying.delete(listener);
      }
    })();
  }
  /** Wait `ms`; false when the hub closed meanwhile. */
  private async sleep(ms: number): Promise<boolean> {
    if (this.controller.signal.aborted) return false;
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.controller.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    return !this.controller.signal.aborted;
  }
  close(): void {
    this.controller.abort();
    this.listeners.clear();
  }
}
