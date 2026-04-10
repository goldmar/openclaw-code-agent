import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTaskFlowRuntimeAvailability, resolveTaskFlowRuntime } from "../src/task-flow-runtime";
import { setOpenClawConfig, setPluginRuntime } from "../src/runtime-store";

afterEach(() => {
  setPluginRuntime(undefined);
  setOpenClawConfig(undefined);
});

describe("task-flow runtime seam", () => {
  it("treats missing taskFlow runtime as unavailable", () => {
    setPluginRuntime({});
    assert.equal(resolveTaskFlowRuntime(), undefined);
    assert.deepEqual(getTaskFlowRuntimeAvailability(), { available: false });
  });

  it("detects an available taskFlow runtime without requiring a specific host version", async () => {
    const taskFlow = {
      async show(lookup: string) {
        return { id: "flow-1", lookupKey: lookup };
      },
    };
    setPluginRuntime({ taskFlow });

    const runtime = resolveTaskFlowRuntime();
    assert.equal(runtime, taskFlow);
    assert.equal(getTaskFlowRuntimeAvailability().available, true);
    assert.deepEqual(await runtime?.show?.("session-123"), {
      id: "flow-1",
      lookupKey: "session-123",
    });
  });
});
