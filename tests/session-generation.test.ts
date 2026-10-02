import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionStoreQueries } from "../src/session-store-queries";
import { SessionStateSyncService } from "../src/session-state-sync-service";
import { persistedGeneration } from "../src/session-generation";
import { resolveWorktreeToolTarget, patchWorktreeTarget } from "../src/tools/worktree-tool-context";
import { withGenerationMethods } from "./session-generation-fixture";
import type { PersistedSessionInfo } from "../src/types";
import type { SessionManager } from "../src/session-manager";

const row = (sessionId: string | undefined, harnessSessionId: string, createdAt: number): PersistedSessionInfo => ({
  sessionId, harnessSessionId, createdAt, name: "shared-name", status: "completed", costUsd: 0,
  prompt: "p", workdir: "/repo", worktreePath: `/repo/${harnessSessionId}`, worktreeBranch: `agent/${harnessSessionId}`,
  backendRef: { kind: "codex-app-server", conversationId: "shared-backend" },
});

describe("captured session generations", () => {
  it("reads OCA IDs and legacy storage keys exactly despite colliding names/backend aliases", () => {
    const a = row("a", "ha", 1), b = row("b", "hb", 2), legacy = row(undefined, "legacy-key", 0);
    const queries = new SessionStoreQueries({ persisted: new Map([["ha", a], ["hb", b], ["legacy-key", legacy]]),
      idIndex: new Map([["a", "ha"], ["b", "hb"]]), nameIndex: new Map([["shared-name", "hb"]]), backendIdIndex: new Map([["shared-backend", "hb"]]) });
    assert.equal(queries.getPersistedSession("shared-name"), b);
    assert.equal(queries.getSessionGeneration(persistedGeneration(a)), a);
    assert.equal(queries.getSessionGeneration(persistedGeneration(legacy)), legacy);
    assert.equal(queries.getSessionGeneration({ kind: "oca", sessionId: "shared-name" }), undefined);
    assert.equal(queries.getSessionGeneration({ kind: "legacy", storageKey: "hb", backendConversationId: "shared-backend" }), undefined);
    const bound = persistedGeneration(legacy);
    legacy.backendRef = { kind: "codex-app-server", conversationId: "replaced" };
    assert.equal(queries.getSessionGeneration(bound), undefined);
  });

  it("pairs active A with A's row, never newer alias B or its output/route", () => {
    const a = row("a", "ha", 1), b = row("b", "hb", 2);
    b.outputPath = "/must-not-read-b-output";
    b.route = { sessionKey: "private-b-route" };
    const active = { id: "a", name: "shared-name", worktreeBranch: "agent/ha", getOutput: (): string[] => [] };
    const sm = withGenerationMethods({ resolve: () => active, getPersistedSession: (ref: string) => ref === "a" ? a : b,
      listPersistedSessions: () => [a, b] });
    const target = resolveWorktreeToolTarget(sm as unknown as SessionManager, "shared-name");
    assert.equal(target.persistedSession, a);
    assert.equal(target.worktreePath, a.worktreePath);
    assert.equal(target.notificationTarget, active);
    const noA = withGenerationMethods({ resolve: () => active, getPersistedSession: () => b, listPersistedSessions: () => [b] });
    const activeOnly = resolveWorktreeToolTarget(noA as unknown as SessionManager, "shared-name");
    assert.equal(activeOnly.persistedSession, undefined);
    assert.equal(activeOnly.worktreePath, undefined);
  });

  it("patches only the exact OCA row and live ID, leaving a shared-name/backend live B untouched", () => {
    const a = row("a", "ha", 1), b = row("b", "hb", 2);
    let saves = 0;
    const liveB = { id: "b", name: "shared-name", backendRef: b.backendRef, applyControlPatch: () => assert.fail("live B must not be patched") };
    const sessions = new Map([["b", liveB as any]]);
    const sync = new SessionStateSyncService({ sessions, resolveSession: () => liveB as any,
      store: { getPersistedSession: () => b, assertPersistedEntry() {}, saveIndex() { saves++; } } });
    assert.equal(sync.applyGenerationPatch(persistedGeneration(a), a, { worktreeState: "merged" }), true);
    assert.equal(a.worktreeState, "merged");
    assert.equal(b.worktreeState, undefined);
    assert.equal(saves, 1);
    assert.equal(sync.applyGenerationPatch({ kind: "oca", sessionId: "missing" }, undefined, { worktreeState: "merged" }), false);
  });

  it("does not synchronize an ID-less row to ambiguous live backend matches", () => {
    const legacy = row(undefined, "legacy", 0);
    const candidates = ["a", "b"].map((id) => [id, { id, backendRef: legacy.backendRef,
      applyControlPatch() { assert.fail("ambiguous live lineage must not be selected"); } }] as const);
    const sync = new SessionStateSyncService({ sessions: new Map(candidates) as any, resolveSession: () => undefined,
      store: { getPersistedSession: () => legacy, assertPersistedEntry() {}, saveIndex() {} } });
    assert.equal(sync.applyGenerationPatch(persistedGeneration(legacy), legacy, { worktreeState: "merged" }), true);
    assert.equal(legacy.worktreeState, "merged");
  });

  it("requires a pinned legacy live ID and excludes competing persisted OCA generations", () => {
    const legacy = row(undefined, "legacy", 0), foreign = row("b", "hb", 1);
    const liveA = { id: "a", backendRef: legacy.backendRef, worktreeState: undefined as string | undefined,
      applyControlPatch(patch: any) { Object.assign(this, patch); } };
    const liveB = { id: "b", backendRef: legacy.backendRef, applyControlPatch() { assert.fail("replacement B must not receive legacy A patch"); } };
    const sessions = new Map<string, any>([["a", liveA]]);
    let persistedRows = [legacy];
    const sync = new SessionStateSyncService({ sessions, resolveSession: () => undefined,
      store: { getPersistedSession: () => legacy, listPersistedSessions: () => persistedRows, assertPersistedEntry() {}, saveIndex() {} } });
    const generation = { ...persistedGeneration(legacy), pinnedLiveSessionId: "a" };
    assert.equal(sync.applyGenerationPatch(generation, legacy, { worktreeState: "merged" }), true);
    assert.equal(liveA.worktreeState, "merged", "unique captured counterpart may synchronize");
    liveA.worktreeState = undefined;
    persistedRows = [legacy, foreign];
    sync.applyGenerationPatch(generation, legacy, { worktreeState: "released" });
    assert.equal(liveA.worktreeState, undefined, "persisted competing generation prevents live sync");
    sessions.delete("a"); sessions.set("b", liveB);
    persistedRows = [legacy];
    sync.applyGenerationPatch(generation, legacy, { worktreeState: "dismissed" });
    assert.equal(legacy.worktreeState, "dismissed", "exact legacy row remains patchable");
    sync.applyGenerationPatch(persistedGeneration(legacy), legacy, { worktreeState: "merged" });
  });

  it("does not fan out worktree mutations to shared backend aliases", () => {
    const patches: unknown[] = [];
    const sm = { updateSessionGeneration(generation: unknown, patch: unknown, options: unknown) { patches.push({ generation, patch, options }); return true; } };
    assert.equal(patchWorktreeTarget(sm as unknown as SessionManager, { generation: { kind: "oca", sessionId: "a" }, initiallyPersisted: true, sessionName: "a" }, { worktreeMerged: true }), true);
    assert.deepEqual(patches, [{ generation: { kind: "oca", sessionId: "a" }, patch: { worktreeMerged: true }, options: { persisted: true } }]);
  });
});
