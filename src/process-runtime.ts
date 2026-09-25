import { randomUUID } from "crypto";

/**
 * Process-wide ownership of the OCA runtime.
 *
 * OpenClaw loads a non-bundled plugin once per plugin registry (the Gateway's
 * active registry, prepared agent-runtime registries, inspection registries,
 * hot-reload generations), and every load is its own captured module graph. A
 * module-level singleton therefore exists once per registry, not once per
 * process. Two SessionManagers over one session index diverge: a button minted by
 * one is "stale" in the other, and each rewrites the index from its own memory.
 *
 * This slot lives on `globalThis` under a `Symbol.for` key, which every module
 * graph in the process shares. Plugin instances ("owners") attach to one shared
 * runtime; the last owner to detach stops it. The runtime always runs with the
 * host handles (`api.runtime`, service config, plugin config) of the newest live
 * owner, and a retired owner's handles are never used again. A different build
 * (hot reload) takes over only after the previous runtime has stopped, so at most
 * one SessionManager writes the store at any time.
 *
 * Keep the slot shape backward compatible within a `v1` key: a newer build must be
 * able to read and stop a runtime published by an older build of the same key.
 */

const SLOT_KEY = Symbol.for("openclaw-code-agent.process-runtime.v1");
const SHARED_STATE_PREFIX = "openclaw-code-agent.process-shared.";

/** Host handles one plugin instance contributes to the shared runtime. */
export type RuntimeHostHandles = {
  runtime: unknown;
  /** Service-context config (`ctx.config`), when the owner started as a service. */
  runtimeConfig?: unknown;
  hasRuntimeConfig: boolean;
  pluginConfig: Record<string, unknown>;
};

export type RuntimeOwnerSpec = {
  id: string;
  /** Registration order across the process; later registrations are newer host generations. */
  regSeq: number;
  buildId: string;
  /**
   * Identity of the settings the runtime's services are built from (plugin
   * config). A newer owner with different settings restarts the runtime.
   */
  configKey: string;
  handles: RuntimeHostHandles;
  /** Called when the owner loses its runtime (last-owner stop or a newer build taking over). */
  onDetached: (reason: RuntimeDetachReason) => void;
};

export type RuntimeDetachReason = "stopped" | "superseded";

/** What the creating build contributes: its services and how to rebind their host handles. */
export type RuntimeServices<T> = {
  services: T;
  /** Point the creating module graph at these handles; `undefined` clears them. */
  bindHost: (handles: RuntimeHostHandles | undefined) => void;
  stop: () => Promise<void>;
};

export type SharedRuntime<T = unknown> = {
  instanceId: string;
  buildId: string;
  configKey: string;
  services: T;
  owners: Map<string, RuntimeOwnerSpec>;
  currentOwnerId?: string;
  /** Highest registration sequence among owners that ever attached. */
  maxRegSeq: number;
  bindHost: (handles: RuntimeHostHandles | undefined) => void;
  stop: () => Promise<void>;
};

type RuntimeSlot = {
  nextRegSeq: number;
  /** Build of the most recent registration; only it may create a runtime. */
  newestBuildId?: string;
  runtime?: SharedRuntime;
  transition?: Promise<void>;
};

export class SupersededRuntimeError extends Error {
  constructor(buildId: string, activeBuildId: string) {
    super(
      `This OpenClaw Code Agent build (${buildId}) was superseded by a newer build (${activeBuildId}) in this Gateway process. `
      + "Retry the action; it runs on the current build.",
    );
    this.name = "SupersededRuntimeError";
  }
}

function slot(): RuntimeSlot {
  const host = globalThis as typeof globalThis & { [SLOT_KEY]?: RuntimeSlot };
  return (host[SLOT_KEY] ??= { nextRegSeq: 1 });
}

/**
 * Allocate a process-wide registration sequence for a new plugin instance. The
 * newest registration's build becomes the only build allowed to run the
 * runtime: an older build is superseded even while no runtime is running, and
 * a host recovery that re-registers previous code makes that build newest again.
 */
export function allocateRuntimeOwnerSequence(buildId: string): number {
  const state = slot();
  const regSeq = state.nextRegSeq;
  state.nextRegSeq += 1;
  state.newestBuildId = buildId;
  return regSeq;
}

/** Short random id for one shared runtime; used in diagnostics only. */
export function newRuntimeInstanceId(): string {
  return randomUUID().slice(0, 8);
}

function newestOwner(runtime: SharedRuntime): RuntimeOwnerSpec | undefined {
  let newest: RuntimeOwnerSpec | undefined;
  for (const owner of runtime.owners.values()) {
    if (!newest || owner.regSeq > newest.regSeq) newest = owner;
  }
  return newest;
}

function rebindToNewestOwner(runtime: SharedRuntime): void {
  const owner = newestOwner(runtime);
  runtime.currentOwnerId = owner?.id;
  runtime.bindHost(owner?.handles);
}

async function runTransition(state: RuntimeSlot, work: () => Promise<void>): Promise<void> {
  const transition = work();
  state.transition = transition;
  try {
    await transition;
  } finally {
    if (state.transition === transition) state.transition = undefined;
  }
}

async function stopRuntime(state: RuntimeSlot, runtime: SharedRuntime, reason: RuntimeDetachReason): Promise<void> {
  if (state.runtime === runtime) state.runtime = undefined;
  const owners = [...runtime.owners.values()];
  runtime.owners.clear();
  for (const owner of owners) {
    try {
      owner.onDetached(reason);
    } catch {
      // Detach callbacks only reset module-local references.
    }
  }
  try {
    await runtime.stop();
  } finally {
    // Never keep a retired owner's handles bound after the runtime stopped.
    runtime.currentOwnerId = undefined;
    runtime.bindHost(undefined);
  }
}

/**
 * Attach an owner to the process runtime, creating it when none is running.
 *
 * - Only the newest registered build may attach or create; an older build
 *   throws `SupersededRuntimeError` and never creates a second writer.
 * - A runtime of another (older) build stops first (sessions are persisted the
 *   same way a service stop persists them); this build then creates a fresh
 *   runtime from the persisted store.
 * - A newer registration of the same build with different settings restarts
 *   the runtime so its services use those settings.
 * - Otherwise the owner attaches and shares.
 */
export async function acquireSharedRuntime<T>(
  owner: RuntimeOwnerSpec,
  create: (handles: RuntimeHostHandles, instanceId: string) => Promise<RuntimeServices<T>>,
): Promise<SharedRuntime<T>> {
  const state = slot();
  for (;;) {
    while (state.transition) {
      await state.transition.catch(() => {});
    }
    const newestBuildId = state.newestBuildId ?? owner.buildId;
    const runtime = state.runtime as SharedRuntime<T> | undefined;
    if (owner.buildId !== newestBuildId) {
      // An older build never runs again once a newer one registered.
      throw new SupersededRuntimeError(owner.buildId, newestBuildId);
    }
    if (runtime && runtime.buildId !== owner.buildId) {
      // A newer build takes over: the old runtime persists and stops first.
      await runTransition(state, () => stopRuntime(state, runtime as SharedRuntime, "superseded"));
      continue;
    }
    if (runtime && owner.regSeq > runtime.maxRegSeq && owner.configKey !== runtime.configKey) {
      // A newer registration with different settings (a config reload) gets
      // services built from those settings, as a host plugin reload would.
      await runTransition(state, () => stopRuntime(state, runtime as SharedRuntime, "superseded"));
      continue;
    }
    if (runtime?.owners.has(owner.id)) {
      runtime.owners.set(owner.id, owner);
      if (runtime.currentOwnerId === owner.id) runtime.bindHost(owner.handles);
      return runtime;
    }
    if (!runtime) {
      let created: SharedRuntime<T> | undefined;
      await runTransition(state, async () => {
        const instanceId = newRuntimeInstanceId();
        const services = await create(owner.handles, instanceId);
        created = {
          instanceId,
          buildId: owner.buildId,
          configKey: owner.configKey,
          services: services.services,
          owners: new Map(),
          maxRegSeq: owner.regSeq,
          bindHost: services.bindHost,
          stop: services.stop,
        };
        state.runtime = created as SharedRuntime;
      });
      if (!created) throw new Error("OpenClaw Code Agent runtime creation did not complete");
      continue;
    }
    runtime.owners.set(owner.id, owner);
    runtime.maxRegSeq = Math.max(runtime.maxRegSeq, owner.regSeq);
    rebindToNewestOwner(runtime as SharedRuntime);
    return runtime;
  }
}

/** Replace an attached owner's host handles (for example when its service starts with config). */
export function updateSharedRuntimeOwnerHandles(ownerId: string, handles: RuntimeHostHandles): void {
  const runtime = slot().runtime;
  const owner = runtime?.owners.get(ownerId);
  if (!runtime || !owner) return;
  owner.handles = handles;
  if (runtime.currentOwnerId === ownerId) runtime.bindHost(handles);
}

/**
 * Detach an owner. The last owner stops the runtime; otherwise the runtime
 * switches to the newest remaining owner's handles before this call returns.
 */
export async function releaseSharedRuntime(ownerId: string): Promise<void> {
  const state = slot();
  while (state.transition) {
    await state.transition.catch(() => {});
  }
  const runtime = state.runtime;
  if (!runtime?.owners.has(ownerId)) return;
  runtime.owners.delete(ownerId);
  if (runtime.owners.size === 0) {
    await runTransition(state, () => stopRuntime(state, runtime, "stopped"));
    return;
  }
  if (runtime.currentOwnerId === ownerId) rebindToNewestOwner(runtime);
}

/** The runtime currently published for this process, if any. */
export function getSharedRuntime<T = unknown>(): SharedRuntime<T> | undefined {
  return slot().runtime as SharedRuntime<T> | undefined;
}

/**
 * Process-wide state shared by every module graph (per-repository git locks,
 * callback de-duplication, rate-limit snapshots). `name` must include a shape
 * version so an incompatible build never reads another build's structure.
 */
export function processShared<T>(name: string, init: () => T): T {
  const key = Symbol.for(`${SHARED_STATE_PREFIX}${name}`);
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  if (!(key in host)) host[key] = init();
  return host[key] as T;
}

/** Test-only: forget the process slot without stopping anything. */
export function resetSharedRuntimeSlotForTests(): void {
  const host = globalThis as typeof globalThis & { [SLOT_KEY]?: RuntimeSlot };
  delete host[SLOT_KEY];
}
