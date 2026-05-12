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
    setPluginRuntime({ tasks: { managedFlows: taskFlow } });

    const runtime = resolveTaskFlowRuntime();
    assert.equal(runtime, taskFlow);
    assert.equal(getTaskFlowRuntimeAvailability().available, true);
    assert.deepEqual(await runtime?.show?.("session-123"), {
      id: "flow-1",
      lookupKey: "session-123",
    });
  });

  it("falls back to the legacy taskFlow alias without requiring a specific host version", async () => {
    const taskFlow = {
      async lookup(lookup: string) {
        return { id: "flow-legacy", lookupKey: lookup };
      },
    };
    setPluginRuntime({ taskFlow });

    const runtime = resolveTaskFlowRuntime();
    assert.equal(runtime, taskFlow);
    assert.equal(getTaskFlowRuntimeAvailability().available, true);
    assert.deepEqual(await runtime?.lookup?.("session-legacy"), {
      id: "flow-legacy",
      lookupKey: "session-legacy",
    });
  });

  it("prefers the current managed TaskFlow runtime over the legacy alias", () => {
    const current = { show: async () => ({ id: "current" }) };
    const legacy = { show: async () => ({ id: "legacy" }) };
    setPluginRuntime({
      tasks: { managedFlows: current },
      taskFlow: legacy,
    });

    assert.equal(resolveTaskFlowRuntime(), current);
  });
});
