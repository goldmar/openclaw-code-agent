import "./test-env";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, mergeKeyedRows } from "../src/session-store";
import { SessionManager } from "../src/session-manager";
import { setSessionManager } from "../src/singletons";
import { createCallbackHandler } from "../src/callback-handler";

/**
 * Defense in depth behind the one-runtime-per-process rule: when a second writer
 * of the session index exists anyway (another process, a runtime that has not
 * stopped yet), lookups re-read the index before reporting "stale", saves merge
 * instead of overwriting, and nothing acts on a session another writer runs.
 */

const ROUTE = {
  provider: "telegram",
  accountId: "bot",
  target: "12345",
  threadId: "42",
  sessionKey: "agent:main:telegram:group:12345:topic:42",
};

function stubSession(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    name: `name-${id}`,
    harnessSessionId: `h-${id}`,
    prompt: "p",
    workdir: "/tmp",
    startedAt: Date.now(),
    route: ROUTE,
    harnessName: "codex",
    status: "completed",
    completedAt: Date.now(),
    costUsd: 0,
    getOutput: () => [],
    ...overrides,
  };
}

function readIndex(indexPath: string): any {
  return JSON.parse(readFileSync(indexPath, "utf-8"));
}

describe("mergeKeyedRows()", () => {
  it("keeps local changes, adopts disk changes, and honors deletes on either side", () => {
    const base = new Map([["kept", "1"], ["deletedLocally", "1"], ["deletedOnDisk", "1"], ["conflict", "1"]]);
    const local = new Map([["kept", "1"], ["deletedOnDisk", "1"], ["conflict", "local"], ["newLocal", "1"]]);
    const disk = new Map([["kept", "1"], ["deletedLocally", "1"], ["conflict", "disk"], ["newDisk", "1"]]);
    const choices = mergeKeyedRows(base, local, disk);
    assert.equal(choices.get("kept"), "local");
    assert.equal(choices.get("deletedLocally"), "drop");
    assert.equal(choices.get("deletedOnDisk"), "drop");
    assert.equal(choices.get("conflict"), "local");
    assert.equal(choices.get("newLocal"), "local");
    assert.equal(choices.get("newDisk"), "disk");
  });
});

describe("SessionStore with two writers", () => {
  let dir: string;
  let indexPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oca-store-two-writers-"));
    indexPath = join(dir, "sessions.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-reads the index on a token miss instead of reporting the token stale", () => {
    const reader = new SessionStore({ indexPath, env: {}, instanceId: "reader" });
    const writer = new SessionStore({ indexPath, env: {}, instanceId: "writer" });
    const token = writer.actionTokenStore.createActionToken("repo-policy:key", "repo-policy-set", {
      repoPolicy: "never-pr",
      expiresAt: Date.now() + 60_000,
    });

    const found = reader.getActionToken(token.id);
    assert.equal(found?.kind, "repo-policy-set");
    assert.equal(reader.actionTokenStore.isAdopted(token.id), true);
    assert.equal(reader.getActionToken("missing-token"), undefined);
  });

  it("re-reads the index on a session miss, but never adopts a session another writer runs", () => {
    const reader = new SessionStore({ indexPath, env: {}, instanceId: "reader" });
    const writer = new SessionStore({ indexPath, env: {}, instanceId: "writer" });
    writer.persistTerminal(stubSession("done"));
    writer.markRunning(stubSession("live", { status: "running", completedAt: undefined }));

    assert.equal(reader.getPersistedSession("done")?.status, "completed");
    // The running row is carried for persistence only: this writer cannot resume it.
    assert.equal(reader.getPersistedSession("live"), undefined);
    assert.equal(reader.isSessionOwnedElsewhere("live"), true);
    assert.equal(reader.isSessionOwnedElsewhere("done"), false);

    // The reader's next save keeps the other writer's running row on disk.
    reader.setRepoPolicy({ key: "k", repoRoot: "/repo", policy: "never-pr", createdAt: "2026-01-01T00:00:00.000Z" } as any);
    const rows = readIndex(indexPath).sessions as Array<{ sessionId: string; status: string }>;
    assert.deepEqual(rows.map((row) => `${row.sessionId}:${row.status}`).sort(), ["done:completed", "live:running"]);
  });

  it("merges on save instead of overwriting another writer's rows", () => {
    const first = new SessionStore({ indexPath, env: {}, instanceId: "first" });
    const second = new SessionStore({ indexPath, env: {}, instanceId: "second" });

    second.setRepoPolicy({ key: "second", repoRoot: "/second", policy: "never-pr", createdAt: "2026-01-01T00:00:00.000Z" } as any);
    second.persistTerminal(stubSession("from-second"));
    first.setRepoPolicy({ key: "first", repoRoot: "/first", policy: "pr-required", createdAt: "2026-01-01T00:00:00.000Z" } as any);

    const afterFirst = readIndex(indexPath);
    assert.deepEqual(afterFirst.repoPolicies.map((policy: { key: string }) => policy.key).sort(), ["first", "second"]);
    assert.deepEqual(afterFirst.sessions.map((row: { sessionId: string }) => row.sessionId), ["from-second"]);
    assert.ok(afterFirst.revision >= 3, `revision should advance across writers, got ${afterFirst.revision}`);

    // A delete by one writer is not resurrected by the other writer's next save.
    first.resetRepoPolicy("first");
    second.persistTerminal(stubSession("another"));
    const afterSecond = readIndex(indexPath);
    assert.deepEqual(afterSecond.repoPolicies.map((policy: { key: string }) => policy.key), ["second"]);
    assert.deepEqual(afterSecond.sessions.map((row: { sessionId: string }) => row.sessionId).sort(), ["another", "from-second"]);
  });

  it("treats a consumption persisted by either writer as final", () => {
    const first = new SessionStore({ indexPath, env: {}, instanceId: "first" });
    const token = first.actionTokenStore.createActionToken("s1", "worktree-merge", { expiresAt: Date.now() + 60_000 });
    const second = new SessionStore({ indexPath, env: {}, instanceId: "second" });

    assert.ok(second.consumeActionToken(token.id));
    // The first writer still holds the unconsumed token in memory; consuming syncs first.
    assert.equal(first.consumeActionToken(token.id), undefined);
    first.setRepoPolicy({ key: "k", repoRoot: "/repo", policy: "never-pr", createdAt: "2026-01-01T00:00:00.000Z" } as any);
    const persisted = readIndex(indexPath).actionTokens.find((row: { id: string }) => row.id === token.id);
    assert.equal(typeof persisted?.consumedAt, "number");
  });
});

describe("callbacks for a session another writer runs", () => {
  let dir: string;
  let indexPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oca-callback-owned-elsewhere-"));
    indexPath = join(dir, "sessions.json");
  });
  afterEach(() => {
    setSessionManager(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses the action instead of resuming the session here", async () => {
    const here = new SessionManager(1, 10, { store: { indexPath, env: {}, instanceId: "here" } });
    const elsewhere = new SessionStore({ indexPath, env: {}, instanceId: "elsewhere" });
    elsewhere.markRunning(stubSession("owned", { status: "running", completedAt: undefined }));
    const token = elsewhere.actionTokenStore.createActionToken("owned", "session-resume", {
      expiresAt: Date.now() + 60_000,
    });
    setSessionManager(here);
    let resumed = false;
    (here as any).launchSession = async () => { resumed = true; throw new Error("must not resume"); };

    const replies: string[] = [];
    const ctx = {
      channel: "telegram",
      auth: { isAuthorizedSender: true },
      callback: { data: `code-agent:${token.id}`, namespace: "code-agent", payload: token.id, messageId: 1, chatId: "12345" },
      respond: {
        acknowledge: async () => {},
        reply: async ({ text }: { text: string }) => { replies.push(text); },
        clearButtons: async () => {},
        editButtons: async () => {},
      },
    };
    await createCallbackHandler("telegram").handler(ctx as any);

    assert.equal(resumed, false);
    assert.match(replies.join("\n"), /running in another OpenClaw Code Agent runtime/);
    assert.equal(here.getActionToken(token.id)?.consumedAt, undefined);
    here.dispose();
  });
});
