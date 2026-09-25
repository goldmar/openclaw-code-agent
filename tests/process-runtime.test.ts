import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acquireSharedRuntime,
  allocateRuntimeOwnerSequence,
  getSharedRuntime,
  releaseSharedRuntime,
  resetSharedRuntimeSlotForTests,
  SupersededRuntimeError,
  updateSharedRuntimeOwnerHandles,
  type RuntimeDetachReason,
  type RuntimeHostHandles,
  type RuntimeOwnerSpec,
  type RuntimeServices,
} from "../src/process-runtime";

/**
 * The process-wide runtime slot, driven directly: build hand-over (a hot
 * reload), a config reload by a newer registration, a stale registration of an
 * older build, and host-handle switching between owners. The plugin-level
 * version of these runs separate module copies (tests/plugin-multi-instance.test.ts).
 */

type Services = { label: string };

const handles = (label: string): RuntimeHostHandles => ({
  runtime: { label },
  hasRuntimeConfig: false,
  pluginConfig: { label },
});

function owner(id: string, buildId: string, configKey = "config-a"): RuntimeOwnerSpec & { detached: RuntimeDetachReason[] } {
  const detached: RuntimeDetachReason[] = [];
  return {
    id,
    regSeq: allocateRuntimeOwnerSequence(),
    buildId,
    configKey,
    handles: handles(id),
    onDetached: (reason) => { detached.push(reason); },
    detached,
  };
}

function factory(log: string[], bound: Array<string | undefined>) {
  return async (hostHandles: RuntimeHostHandles, instanceId: string): Promise<RuntimeServices<Services>> => {
    const label = String((hostHandles.pluginConfig as { label?: string }).label);
    log.push(`create:${label}`);
    return {
      services: { label: `${label}@${instanceId}` },
      bindHost: (next) => { bound.push(next ? String((next.pluginConfig as { label?: string }).label) : undefined); },
      stop: async () => { log.push(`stop:${label}`); },
    };
  };
}

afterEach(() => {
  resetSharedRuntimeSlotForTests();
});

describe("process runtime slot", () => {
  it("stops the old build's runtime before a newer build creates its own, and never runs the old build again", async () => {
    const log: string[] = [];
    const bound: Array<string | undefined> = [];
    const old = owner("old", "build-1");
    await acquireSharedRuntime(old, factory(log, bound));
    const next = owner("next", "build-2");
    const runtime = await acquireSharedRuntime(next, factory(log, bound));
    assert.deepEqual(log, ["create:old", "stop:old", "create:next"]);
    assert.deepEqual(old.detached, ["superseded"]);
    assert.equal(runtime.buildId, "build-2");
    // The old build's registration is older than code that already ran.
    await assert.rejects(() => acquireSharedRuntime(old, factory(log, bound)), SupersededRuntimeError);
    assert.equal(getSharedRuntime()?.buildId, "build-2");
  });

  it("rebuilds the runtime when a newer registration of the same build brings different settings", async () => {
    const log: string[] = [];
    const bound: Array<string | undefined> = [];
    const first = owner("first", "build-1", "config-a");
    const firstRuntime = await acquireSharedRuntime(first, factory(log, bound));
    const reloaded = owner("reloaded", "build-1", "config-b");
    const reloadedRuntime = await acquireSharedRuntime(reloaded, factory(log, bound));
    assert.notEqual(reloadedRuntime.instanceId, firstRuntime.instanceId);
    assert.deepEqual(log, ["create:first", "stop:first", "create:reloaded"]);
    assert.deepEqual(first.detached, ["superseded"]);
    // An owner with the runtime's own settings just attaches.
    const same = owner("same", "build-1", "config-b");
    assert.equal((await acquireSharedRuntime(same, factory(log, bound))).instanceId, reloadedRuntime.instanceId);
    assert.equal(log.length, 3);
  });

  it("runs with the newest live owner's handles and switches when that owner leaves", async () => {
    const log: string[] = [];
    const bound: Array<string | undefined> = [];
    const a = owner("a", "build-1");
    const b = owner("b", "build-1");
    await acquireSharedRuntime(a, factory(log, bound));
    await acquireSharedRuntime(b, factory(log, bound));
    assert.equal(getSharedRuntime()?.currentOwnerId, "b");
    updateSharedRuntimeOwnerHandles("b", handles("b-with-service-config"));
    updateSharedRuntimeOwnerHandles("a", handles("a-ignored"));
    updateSharedRuntimeOwnerHandles("missing", handles("missing"));
    await releaseSharedRuntime("b");
    assert.equal(getSharedRuntime()?.currentOwnerId, "a");
    await releaseSharedRuntime("missing");
    await releaseSharedRuntime("a");
    assert.equal(getSharedRuntime(), undefined);
    assert.deepEqual(bound, ["a", "b", "b-with-service-config", "a-ignored", undefined]);
    assert.deepEqual(log, ["create:a", "stop:a"]);
    assert.deepEqual(a.detached, [], "an owner that leaves is not told it was detached");
  });
});
