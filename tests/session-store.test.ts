import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/session-store";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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

describe("SessionStore path resolution", () => {
  function markRunningAt(store: SessionStore, sessionId: string): void {
    store.markRunning({
      id: sessionId,
      name: "test",
      harnessSessionId: `h-${sessionId}`,
      prompt: "p",
      workdir: "/tmp",
      model: undefined,
      startedAt: Date.now(),
      originAgentId: undefined,
      originChannel: undefined,
      originThreadId: undefined,
      originSessionKey: undefined,
      harnessName: "codex",
    } as any);
  }

  it("prefers OPENCLAW_CODE_AGENT_SESSIONS_PATH over OPENCLAW_HOME", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-path-"));
    const explicit = join(dir, "explicit-sessions.json");
    const openclawHome = join(dir, "ignored-openclaw-home");
    const homeIndex = join(openclawHome, "code-agent-sessions.json");
    mkdirSync(openclawHome, { recursive: true });
    writeFileSync(explicit, "[]", "utf-8");
    writeFileSync(homeIndex, "[]", "utf-8");

    const store = new SessionStore({
      env: {
        OPENCLAW_CODE_AGENT_SESSIONS_PATH: explicit,
        OPENCLAW_HOME: openclawHome,
      },
    });
    markRunningAt(store, "explicit");

    assert.equal(existsSync(explicit), true);
    assert.equal(existsSync(homeIndex), true);
    const explicitJson = JSON.parse(readFileSync(explicit, "utf-8"));
    const homeJson = JSON.parse(readFileSync(homeIndex, "utf-8"));
    assert.equal(explicitJson.length, 1);
    assert.equal(homeJson.length, 0);
  });

  it("uses OPENCLAW_HOME when explicit sessions path is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-home-"));
    const sessionsPath = join(dir, "code-agent-sessions.json");
    writeFileSync(sessionsPath, "[]", "utf-8");

    const store = new SessionStore({
      env: { OPENCLAW_HOME: dir },
    });
    markRunningAt(store, "home");

    const persisted = JSON.parse(readFileSync(sessionsPath, "utf-8"));
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].sessionId, "home");
  });

  it("allows constructor indexPath override for deterministic callers", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-store-override-"));
    const indexPath = join(dir, "custom-index.json");
    writeFileSync(indexPath, "[]", "utf-8");

    const store = new SessionStore({
      indexPath,
      env: {},
    });

    assert.deepEqual([...store.persisted.keys()], []);
  });
});
