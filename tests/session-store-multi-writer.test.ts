import "./test-env";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore, mergeKeyedRows } from "../src/session-store";
import { tryAcquireSessionStoreLock } from "../src/session-store-storage";
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

/**
 * Make a running row look like it belongs to another live process (this test
 * process's parent), the way a second Gateway or CLI process would write it.
 */
function handRowToOtherProcess(indexPath: string, sessionId: string): void {
  const index = readIndex(indexPath);
  const row = index.sessions.find((entry: { sessionId: string }) => entry.sessionId === sessionId);
  assert.ok(row, `expected row ${sessionId}`);
  row.status = "running";
  row.runtimeOwner = `${process.ppid}/other-process`;
  index.revision = (index.revision ?? 0) + 1;
  writeFileSync(indexPath, JSON.stringify(index));
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
    handRowToOtherProcess(indexPath, "live");

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

describe("SessionStore ownership and write safety", () => {
  let dir: string;
  let indexPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oca-store-ownership-"));
    indexPath = join(dir, "sessions.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not recover or overwrite a running row another live process owns when opening the index", () => {
    const writer = new SessionStore({ indexPath, env: {}, instanceId: "writer" });
    writer.markRunning(stubSession("live", { status: "running", completedAt: undefined }));
    handRowToOtherProcess(indexPath, "live");

    const opened = new SessionStore({ indexPath, env: {}, instanceId: "opened" });
    assert.equal(opened.getPersistedSession("live"), undefined);
    assert.equal(opened.isSessionOwnedElsewhere("live"), true);
    opened.setRepoPolicy({ key: "k", repoRoot: "/repo", policy: "never-pr", createdAt: "2026-01-01T00:00:00.000Z" } as any);
    const row = readIndex(indexPath).sessions.find((entry: { sessionId: string }) => entry.sessionId === "live");
    assert.equal(row.status, "running");
    assert.equal(row.runtimeOwner, `${process.ppid}/other-process`);
  });

  it("stops returning a cached session once another process runs it, even after a local edit", () => {
    const reader = new SessionStore({ indexPath, env: {}, instanceId: "reader" });
    reader.persistTerminal(stubSession("shared"));
    assert.equal(reader.getPersistedSession("shared")?.status, "completed");

    handRowToOtherProcess(indexPath, "shared");
    assert.equal(reader.getPersistedSession("shared"), undefined, "the stale cached copy must not be resumable");
    assert.equal(reader.isSessionOwnedElsewhere("shared"), true);

    // A local edit of the cached copy made before this store noticed must not win either.
    const writer = new SessionStore({ indexPath, env: {}, instanceId: "writer" });
    writer.persistTerminal(stubSession("edited"));
    const editor = new SessionStore({ indexPath, env: {}, instanceId: "editor" });
    const cached = editor.getPersistedSession("edited")!;
    handRowToOtherProcess(indexPath, "edited");
    (editor as any).persisted.set(cached.harnessSessionId, { ...cached, name: "renamed-locally" });
    editor.setRepoPolicy({ key: "k2", repoRoot: "/repo2", policy: "never-pr", createdAt: "2026-01-01T00:00:00.000Z" } as any);
    const row = readIndex(indexPath).sessions.find((entry: { sessionId: string }) => entry.sessionId === "edited");
    assert.equal(row.status, "running");
    assert.equal(row.runtimeOwner, `${process.ppid}/other-process`);
  });

  it("sees a token consumed by another writer even when the token is cached", () => {
    const first = new SessionStore({ indexPath, env: {}, instanceId: "first" });
    const token = first.actionTokenStore.createActionToken("s1", "question-answer", {
      expiresAt: Date.now() + 60_000,
      optionIndex: 0,
    });
    assert.equal(first.getActionToken(token.id)?.consumedAt, undefined);
    const second = new SessionStore({ indexPath, env: {}, instanceId: "second" });
    assert.ok(second.consumeActionToken(token.id));
    assert.equal(typeof first.getActionToken(token.id)?.consumedAt, "number");
  });

  it("backs up an index another writer left in a form this build cannot merge before replacing it", () => {
    const store = new SessionStore({ indexPath, env: {}, instanceId: "store" });
    store.persistTerminal(stubSession("mine"));
    writeFileSync(indexPath, "{ not json");
    store.setRepoPolicy({ key: "k", repoRoot: "/repo", policy: "never-pr", createdAt: "2026-01-01T00:00:00.000Z" } as any);
    const backups = readdirSync(dir).filter((name) => name.startsWith("sessions.json.legacy-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(dir, backups[0]!), "utf-8"), "{ not json");
    assert.deepEqual(readIndex(indexPath).sessions.map((row: { sessionId: string }) => row.sessionId), ["mine"]);
  });

  it("breaks a lock whose holder is gone and releases its own lock after writing", () => {
    const lockPath = `${indexPath}.lock`;
    // A lock left by a process that no longer exists (pid 0 is never a live process here).
    writeFileSync(lockPath, `0 ${Date.now()}`);
    const attempt = tryAcquireSessionStoreLock(indexPath);
    assert.equal(typeof attempt, "object");
    assert.ok(readFileSync(lockPath, "utf-8").startsWith(`${process.pid} `));
    (attempt as { release: () => void }).release();
    assert.equal(existsSync(lockPath), false);

    const store = new SessionStore({ indexPath, env: {}, instanceId: "store" });
    store.persistTerminal(stubSession("after-lock"));
    assert.equal(existsSync(lockPath), false, "the lock is released after the write");
    assert.deepEqual(readIndex(indexPath).sessions.map((row: { sessionId: string }) => row.sessionId), ["after-lock"]);
  });

  it("defers a save while another live writer holds the lock, without blocking, and never loses it", async () => {
    const lockPath = `${indexPath}.lock`;
    const store = new SessionStore({ indexPath, env: {}, instanceId: "store" });
    store.persistTerminal(stubSession("first"));
    // Another live process (this test's parent) holds the lock.
    writeFileSync(lockPath, `${process.ppid} ${Date.now()}`);
    assert.equal(tryAcquireSessionStoreLock(indexPath), "busy");

    const started = Date.now();
    store.persistTerminal(stubSession("while-locked"));
    assert.ok(Date.now() - started < 1_000, "the save must not block the event loop");
    assert.deepEqual(readIndex(indexPath).sessions.map((row: { sessionId: string }) => row.sessionId), ["first"]);

    // Meanwhile the other writer adds its own row, then releases the lock.
    const index = readIndex(indexPath);
    index.sessions.push({ ...index.sessions[0], sessionId: "from-other", harnessSessionId: "h-from-other", name: "other" });
    writeFileSync(indexPath, JSON.stringify(index));
    rmSync(lockPath);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const rows = readIndex(indexPath).sessions.map((row: { sessionId: string }) => row.sessionId).sort();
    assert.deepEqual(rows, ["first", "from-other", "while-locked"]);
  });

  it("holds buttons back until their tokens are persisted", async () => {
    const lockPath = `${indexPath}.lock`;
    const store = new SessionStore({ indexPath, env: {}, instanceId: "store" });
    store.persistTerminal(stubSession("first"));
    writeFileSync(lockPath, `${process.ppid} ${Date.now()}`);
    const token = store.actionTokenStore.createActionToken("s1", "worktree-merge", { expiresAt: Date.now() + 60_000 });
    let persisted = false;
    const waiting = store.whenPersisted().then(() => { persisted = true; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(persisted, false, "the token is not on disk while the lock is held");
    rmSync(lockPath);
    await waiting;
    assert.ok(readIndex(indexPath).actionTokens.some((row: { id: string }) => row.id === token.id));
  });

  // A privileged process ignores directory permissions, so the write would not fail.
  const runsAsRoot = process.getuid?.() === 0;
  it("keeps persistence waiters waiting while a write fails, then persists once it succeeds", { skip: runsAsRoot && "directory permissions do not apply to root" }, async () => {
    const store = new SessionStore({ indexPath, env: {}, instanceId: "store" });
    store.persistTerminal(stubSession("first"));
    chmodSync(dir, 0o500);
    try {
      store.persistTerminal(stubSession("while-unwritable"));
      let persisted = false;
      const waiting = store.whenPersisted().then(() => { persisted = true; });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(persisted, false, "a failed write must not satisfy the wait");
      chmodSync(dir, 0o700);
      await waiting;
    } finally {
      chmodSync(dir, 0o700);
    }
    const rows = readIndex(indexPath).sessions.map((row: { sessionId: string }) => row.sessionId).sort();
    assert.deepEqual(rows, ["first", "while-unwritable"]);
  });

  it("flushes a deferred save at shutdown", () => {
    const lockPath = `${indexPath}.lock`;
    const store = new SessionStore({ indexPath, env: {}, instanceId: "store" });
    store.persistTerminal(stubSession("first"));
    writeFileSync(lockPath, `${process.ppid} ${Date.now()}`);
    store.persistTerminal(stubSession("pending"));
    store.flushPendingSave();
    const rows = readIndex(indexPath).sessions.map((row: { sessionId: string }) => row.sessionId).sort();
    assert.deepEqual(rows, ["first", "pending"]);
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
    handRowToOtherProcess(indexPath, "owned");
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
