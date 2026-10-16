import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionMaintenanceService } from "../src/session-maintenance-service";
import type { PersistedSessionInfo } from "../src/types";

describe("SessionMaintenanceService", () => {
  it("starts no persisted maintenance work after dispose", async () => {
    let reminderLookups = 0;
    // Only the reminder lookup is reached by a sync; the rest is never called.
    const service = new SessionMaintenanceService({
      reminders: { getNextReminderAt: async (): Promise<undefined> => { reminderLookups += 1; return undefined; } },
    } as unknown as ConstructorParameters<typeof SessionMaintenanceService>[0]);
    const row = { sessionId: "s1", harnessSessionId: "thread-1" } as PersistedSessionInfo;

    service.dispose();
    service.syncPersistedSessionMaintenance(row);
    await service.whenIdle();

    assert.equal(reminderLookups, 0);
  });
});
