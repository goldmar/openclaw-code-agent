import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/session-store";

describe("SessionStore getLatestPersistedByName", () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
    store.persisted.clear();
    store.idIndex.clear();
    store.nameIndex.clear();
  });

  it("returns latest created entry when sessions share same name", () => {
    store.persisted.set("h-old", {
      harnessSessionId: "h-old",
      name: "dup",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      costUsd: 0,
      createdAt: 100,
      completedAt: 120,
    } as any);
    store.persisted.set("h-new", {
      harnessSessionId: "h-new",
      name: "dup",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      costUsd: 0,
      createdAt: 200,
      completedAt: 220,
    } as any);

    const resolved = store.resolveHarnessSessionId("dup");
    const persisted = store.getPersistedSession("dup");

    assert.equal(resolved, "h-new");
    assert.equal(persisted?.harnessSessionId, "h-new");
  });

  it("legacy entries without createdAt fall back to completedAt", () => {
    store.persisted.set("h-older", {
      harnessSessionId: "h-older",
      name: "legacy",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      costUsd: 0,
      completedAt: 100,
    } as any);
    store.persisted.set("h-latest", {
      harnessSessionId: "h-latest",
      name: "legacy",
      prompt: "p",
      workdir: "/tmp",
      status: "completed",
      costUsd: 0,
      completedAt: 300,
    } as any);

    const resolved = store.resolveHarnessSessionId("legacy");
    const persisted = store.getPersistedSession("legacy");

    assert.equal(resolved, "h-latest");
    assert.equal(persisted?.harnessSessionId, "h-latest");
  });
});
