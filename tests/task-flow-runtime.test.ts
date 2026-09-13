import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTaskFlowRuntimeAvailability, resolveTaskFlowRuntime } from "../src/task-flow-runtime";
import { setPluginRuntime } from "../src/runtime-store";

afterEach(() => {
  setPluginRuntime(undefined);
});

describe("task-flow runtime seam", () => {
  it("treats missing managed TaskFlow runtime as unavailable", () => {
    setPluginRuntime({});
    assert.equal(resolveTaskFlowRuntime(), undefined);
    assert.deepEqual(getTaskFlowRuntimeAvailability(), { available: false });
  });

  it("detects the current managed TaskFlow runtime", async () => {
    const taskFlow = {
      async show(lookup: string) {
        return { id: "flow-1", lookupKey: lookup };
      },
    };
    setPluginRuntime({ tasks: { async: { managedFlows: taskFlow } } });

    const runtime = resolveTaskFlowRuntime();
    assert.equal(runtime, taskFlow);
    assert.equal(getTaskFlowRuntimeAvailability().available, true);
    assert.deepEqual(await runtime?.show?.("session-123"), {
      id: "flow-1",
      lookupKey: "session-123",
    });
  });

  it("does not fall back to synchronous or legacy managed-flow surfaces", () => {
    const taskFlow = {
      async lookup(lookup: string) {
        return { id: "flow-legacy", lookupKey: lookup };
      },
    };
    setPluginRuntime({ tasks: { managedFlows: taskFlow }, taskFlow });

    assert.equal(resolveTaskFlowRuntime(), undefined);
    assert.deepEqual(getTaskFlowRuntimeAvailability(), { available: false });
  });

  it("uses async managed flows when synchronous and legacy surfaces also exist", () => {
    const current = { show: async () => ({ id: "current" }) };
    const legacy = { show: async () => ({ id: "legacy" }) };
    setPluginRuntime({
      tasks: { async: { managedFlows: current }, managedFlows: legacy },
      taskFlow: legacy,
    });

    assert.equal(resolveTaskFlowRuntime(), current);
  });
});
