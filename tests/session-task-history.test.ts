import "./test-env";
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session";
import { SessionManager } from "../src/session-manager";
import { SessionStore } from "../src/session-store";
import { STORE_SCHEMA_VERSION } from "../src/session-store-normalization";
import { setPluginRuntime } from "../src/runtime-store";
import { createFakeHost } from "./fake-host";
import type { PersistedSessionInfo } from "../src/types";

const route = { provider: "telegram", target: "12345", threadId: "42", sessionKey: "agent:main:telegram:group:12345:topic:42" };
const mirror = { flowId: "historical-flow", revision: 7, status: "running" as const, cancelRequestedAt: 123 };
const historical: PersistedSessionInfo = {
  sessionId: "historical-session", harnessSessionId: "historical-thread", name: "historical", prompt: "plan", workdir: "/tmp",
  backendRef: { kind: "codex-app-server", conversationId: "historical-thread" },
  harness: "codex", model: "gpt-6-sol", status: "killed", lifecycle: "suspended", costUsd: 0,
  route, pendingPlanApproval: true, taskFlowMirror: mirror,
};

afterEach(() => setPluginRuntime(undefined));

it("starts without runtime.tasks and preserves historical projection without calling the retired runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oca-task-history-"));
  const host = createFakeHost();
  let manager: SessionManager | undefined;
  try {
    assert.equal("tasks" in host.runtime, false);
    Object.defineProperty(host.runtime, "tasks", { get() { assert.fail("retired tasks runtime must never be read"); } });
    setPluginRuntime(host.runtime);
    const indexPath = join(dir, "sessions.json");
    writeFileSync(indexPath, JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, sessions: [historical], actionTokens: [], repoPolicies: [] }));
    manager = new SessionManager(5, 50, { store: { indexPath, env: {} } });
    await manager.ready;
    assert.deepEqual(manager.getPersistedSession(historical.sessionId)?.taskFlowMirror, mirror);
    assert.equal(manager.getPersistedSession(historical.sessionId)?.pendingPlanApproval, true);
    await manager.shutdown();
    assert.deepEqual(JSON.parse(readFileSync(indexPath, "utf8")).sessions[0].taskFlowMirror, mirror);
  } finally {
    manager?.dispose();
    await host.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("retains historical mirror evidence when a resumed session runs and completes", () => {
  const dir = mkdtempSync(join(tmpdir(), "oca-task-history-resume-"));
  const session = new Session({ prompt: "continue", workdir: "/tmp", permissionMode: "plan", harness: "codex",
    sessionIdOverride: historical.sessionId, model: "gpt-6-sol", route }, historical.name);
  try {
    const store = new SessionStore({ indexPath: join(dir, "sessions.json"), env: {} });
    store.replacePersistedSession(historical);
    session.harnessSessionId = "resumed-thread";
    session.transition("running");
    store.markRunning(session);
    assert.deepEqual(store.getPersistedSession(session.id)?.taskFlowMirror, mirror);
    session.complete();
    store.persistTerminal(session);
    assert.equal(store.getPersistedSession(session.id)?.status, "completed");
    assert.deepEqual(store.getPersistedSession(session.id)?.taskFlowMirror, mirror);
    assert.deepEqual(new SessionStore({ indexPath: join(dir, "sessions.json"), env: {} }).getPersistedSession(session.id)?.taskFlowMirror, mirror);
  } finally {
    session.kill("user");
    rmSync(dir, { recursive: true, force: true });
  }
});
