import "./test-env";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fc from "fast-check";
import { SessionStore, stableStringify } from "../src/session-store";
import { SESSION_STORE_LOCK_STALE_MS, tryAcquireSessionStoreLock } from "../src/session-store-storage";
import { resolveSessionOutputDir } from "../src/state-paths";

/**
 * Regression tests for the OCA 5.0.0 session-store blockers: B2 (terminal
 * re-persist keeps PR/merge state), B5 (output cleanup is multi-writer safe),
 * B6 (an older build never touches a newer-schema index), B7 (the three-way
 * merge compares canonical rows) and N62 (lock races).
 */

const ROUTE = { provider: "telegram", target: "12345", threadId: "42", sessionKey: "agent:main:telegram:group:12345:topic:42" };

function stubSession(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    id,
    name: `name-${id}`,
    harnessSessionId: `h-${id}`,
    prompt: "p",
    workdir: "/repo",
    startedAt: 1_700_000_000_000,
    route: ROUTE,
    harnessName: "codex",
    status: "completed",
    completedAt: 1_700_000_100_000,
    costUsd: 0,
    getOutput: (): never[] => [],
    ...overrides,
  };
}

function readIndex(indexPath: string): any {
  return JSON.parse(readFileSync(indexPath, "utf-8"));
}

/** Rewrite the index like another writer: keys in a different order, atomic replace. */
function writeExternally(indexPath: string, mutate: (index: any) => void, order: "reverse" | "sorted" = "reverse"): void {
  const index = readIndex(indexPath);
  mutate(index);
  index.sessions = index.sessions.map((row: Record<string, unknown>) => {
    const entries = Object.entries(row);
    return Object.fromEntries(order === "reverse" ? entries.reverse() : entries.sort(([a], [b]) => a.localeCompare(b)));
  });
  index.revision = (index.revision ?? 0) + 1;
  // Atomic replace, like the real writers: the index gets a new inode.
  const tmp = `${indexPath}.ext`;
  writeFileSync(tmp, JSON.stringify(index));
  renameSync(tmp, indexPath);
}

let dir: string;
let indexPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oca-store-safety-"));
  indexPath = join(dir, "sessions.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("B2: persistTerminal keeps state the runtime session does not track", () => {
  it("re-persisting a terminal session (runtime GC) keeps PR, merge, disposition, policy and completion-wake fields", () => {
    const store = new SessionStore({ indexPath, env: {}, instanceId: "store" });
    const session = stubSession("pr", {
      worktreePath: "/repo/.worktrees/pr",
      worktreeBranch: "agent/pr",
      worktreeStrategy: "ask",
      repoIntegrationPolicy: "pr-allowed",
      repoIntegrationPolicySource: "stored",
    });
    store.persistTerminal(session);
    const row = store.getPersistedSession("pr")!;
    store.replacePersistedSession({
      ...row,
      worktreePrUrl: "https://github.com/example/repo/pull/7",
      worktreePrNumber: 7,
      worktreeDisposition: "pr-opened",
      worktreeRemoteOutcome: "pr-opened",
      completionWakeSucceededAt: "2026-09-25T00:00:00.000Z",
      pendingWorktreeDecisionSince: "2026-09-25T00:00:00.000Z",
    });

    store.persistTerminal(session);

    const after = readIndex(indexPath).sessions.find((entry: { sessionId: string }) => entry.sessionId === "pr");
    assert.equal(after.worktreePrUrl, "https://github.com/example/repo/pull/7");
    assert.equal(after.worktreePrNumber, 7);
    assert.equal(after.worktreeDisposition, "pr-opened");
    assert.equal(after.worktreeRemoteOutcome, "pr-opened");
    assert.equal(after.completionWakeSucceededAt, "2026-09-25T00:00:00.000Z");
    assert.equal(after.repoIntegrationPolicy, "pr-allowed");
    assert.equal(after.repoIntegrationPolicySource, "stored");
    assert.equal(after.runtimeOwner, undefined);
  });

  it("still clears fields the runtime session did clear", () => {
    const store = new SessionStore({ indexPath, env: {}, instanceId: "store" });
    store.persistTerminal(stubSession("wt", { worktreePath: "/repo/.worktrees/wt", worktreeBranch: "agent/wt" }));
    store.persistTerminal(stubSession("wt", { worktreePath: undefined, worktreeBranch: undefined }));
    const after = readIndex(indexPath).sessions.find((entry: { sessionId: string }) => entry.sessionId === "wt");
    assert.equal(after.worktreePath, undefined);
    assert.equal(after.worktreeBranch, undefined);
  });
});

describe("B7: the three-way merge compares canonical rows", () => {
  it("stableStringify ignores key order and undefined members", () => {
    assert.equal(stableStringify({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } }), stableStringify({ a: { c: [2, { y: 2, z: 1 }] }, b: 1 }));
  });

  it("adopts a second external edit of a row it synced from disk", () => {
    const store = new SessionStore({ indexPath, env: {}, instanceId: "store" });
    store.persistTerminal(stubSession("row"));
    writeExternally(indexPath, (index) => { index.sessions[0].prompt = "edit-1"; });
    assert.equal(store.getPersistedSession("row")?.prompt, "edit-1");
    writeExternally(indexPath, (index) => { index.sessions[0].prompt = "edit-2"; });
    store.setRepoPolicy({ key: "k", repoRoot: "/repo", policy: "never-pr", createdAt: "2026-01-01T00:00:00.000Z" } as any);
    assert.equal(readIndex(indexPath).sessions[0].prompt, "edit-2");
  });

  it("property: sync row A, apply an external A', sync again: A' is adopted", () => {
    fc.assert(fc.property(
      fc.array(fc.stringMatching(/^[a-z0-9-]{1,12}$/), { minLength: 2, maxLength: 4 }),
      fc.constantFrom<"reverse" | "sorted">("reverse", "sorted"),
      fc.constantFrom("prompt", "name", "model"),
      fc.boolean(),
      (edits, order, field, saveBetween) => {
        const caseDir = mkdtempSync(join(dir, "case-"));
        const casePath = join(caseDir, "sessions.json");
        try {
          const store = new SessionStore({ indexPath: casePath, env: {}, instanceId: "store" });
          store.persistTerminal(stubSession("row", { model: "gpt-6-sol" }));
          for (const [index, value] of edits.entries()) {
            const edited = `${field}-${index}-${value}`;
            writeExternally(casePath, (disk) => { disk.sessions[0][field] = edited; }, order);
            if (saveBetween) {
              store.setRepoPolicy({ key: `k${index}`, repoRoot: "/repo", policy: "never-pr", createdAt: "2026-01-01T00:00:00.000Z" } as any);
            } else {
              store.getPersistedSession("row");
            }
            const onDisk = readIndex(casePath).sessions[0][field];
            const inMemory = (store.listPersistedSessions()[0] as unknown as Record<string, unknown>)[field];
            if (onDisk !== edited || inMemory !== edited) return false;
          }
          store.setRepoPolicy({ key: "final", repoRoot: "/repo", policy: "never-pr", createdAt: "2026-01-01T00:00:00.000Z" } as any);
          return readIndex(casePath).sessions[0][field] === `${field}-${edits.length - 1}-${edits.at(-1)}`;
        } finally {
          rmSync(caseDir, { recursive: true, force: true });
        }
      },
    ), { numRuns: 40 });
  });
});

describe("B6: an older build and a newer-schema index", () => {
  const newer = JSON.stringify({ schemaVersion: 99, revision: 3, sessions: [{ future: true }], actionTokens: [], repoPolicies: [], futureCollection: [1] });

  it("loads nothing, never archives, backs up, or overwrites a newer index", () => {
    writeFileSync(indexPath, newer);
    const store = new SessionStore({ indexPath, env: {}, instanceId: "old-build" });
    assert.equal(store.isReadOnly(), true);
    store.persistTerminal(stubSession("mine"));
    store.setRepoPolicy({ key: "k", repoRoot: "/repo", policy: "never-pr", createdAt: "2026-01-01T00:00:00.000Z" } as any);
    assert.equal(readFileSync(indexPath, "utf-8"), newer);
    assert.deepEqual(readdirSync(dir).sort(), ["sessions.json"]);
  });

  it("stops writing once a newer build replaces the index mid-run", () => {
    const store = new SessionStore({ indexPath, env: {}, instanceId: "old-build" });
    store.persistTerminal(stubSession("mine"));
    writeFileSync(indexPath, newer);
    for (let save = 0; save < 3; save += 1) {
      store.setRepoPolicy({ key: `k${save}`, repoRoot: "/repo", policy: "never-pr", createdAt: "2026-01-01T00:00:00.000Z" } as any);
    }
    assert.equal(readFileSync(indexPath, "utf-8"), newer);
    assert.deepEqual(readdirSync(dir).sort(), ["sessions.json"], "no backup per save");
  });

  it("backs up one unmergeable (corrupt) index once per distinct content, not once per save", () => {
    const store = new SessionStore({ indexPath, env: {}, instanceId: "store" });
    store.persistTerminal(stubSession("mine"));
    for (let save = 0; save < 3; save += 1) {
      writeFileSync(indexPath, "{ corrupt");
      store.setRepoPolicy({ key: `k${save}`, repoRoot: "/repo", policy: "never-pr", createdAt: "2026-01-01T00:00:00.000Z" } as any);
    }
    assert.equal(readdirSync(dir).filter((name) => name.startsWith("sessions.json.legacy-")).length, 1);
  });
});

describe("B5: output cleanup with several writers", () => {
  function outputFile(dirPath: string, id: string, ageMs: number): string {
    mkdirSync(dirPath, { recursive: true });
    const path = join(dirPath, `openclaw-agent-${id}.txt`);
    writeFileSync(path, "output\n");
    const at = (Date.now() - ageMs) / 1000;
    utimesSync(path, at, at);
    return path;
  }

  it("never sweeps the shared legacy temp dir and keeps fresh or carried files in the output dir", () => {
    const outputDir = resolveSessionOutputDir();
    const legacyTmp = outputFile(tmpdir(), "legacy-other-process", 5 * 60_000);
    const freshOther = outputFile(outputDir, "fresh-other-writer", 60_000);
    const carried = outputFile(outputDir, "carried-live", 3 * 60 * 60_000);
    const stale = outputFile(outputDir, "stale-orphan", 3 * 60 * 60_000);

    const store = new SessionStore({ indexPath, env: {}, instanceId: "store" });
    store.persistTerminal(stubSession("seed"));
    // Another live process runs "carried-live" (this test's parent pid owns the row).
    writeExternally(indexPath, (index) => {
      index.sessions.push({ ...index.sessions[0], sessionId: "carried-live", harnessSessionId: "h-carried", name: "carried", status: "running", runtimeOwner: `${process.ppid}/other` });
    });

    store.cleanupOrphanOutputFiles();

    assert.equal(existsSync(legacyTmp), true, "legacy temp-dir files belong to other processes");
    assert.equal(existsSync(freshOther), true, "a fresh unreferenced file may belong to a writer that has not persisted yet");
    assert.equal(existsSync(carried), true, "another writer's running row refers to it");
    assert.equal(existsSync(stale), false, "an old unreferenced file is an orphan");
    rmSync(legacyTmp, { force: true });
  });
});

describe("N62: session index lock races", () => {
  it("release never removes a lock another writer holds", () => {
    const lockPath = `${indexPath}.lock`;
    const held = tryAcquireSessionStoreLock(indexPath);
    assert.equal(typeof held, "object");
    // Someone broke our lock as stale and took it: our late release must not free theirs.
    const theirs = `${process.ppid} ${Date.now()} other-token`;
    writeFileSync(lockPath, theirs);
    (held as { release: () => void }).release();
    assert.equal(readFileSync(lockPath, "utf-8"), theirs);
  });

  it("breaks a lock only once it is stale, and a live holder's fresh lock is never broken by a waiting save", async () => {
    const lockPath = `${indexPath}.lock`;
    writeFileSync(lockPath, `${process.ppid} ${Date.now() - SESSION_STORE_LOCK_STALE_MS - 1_000}`);
    const stale = tryAcquireSessionStoreLock(indexPath);
    assert.equal(typeof stale, "object", "a lock older than the stale threshold is broken");
    (stale as { release: () => void }).release();

    const store = new SessionStore({ indexPath, env: {}, instanceId: "store" });
    store.persistTerminal(stubSession("first"));
    const liveLock = `${process.ppid} ${Date.now()} live-holder`;
    writeFileSync(lockPath, liveLock);
    store.persistTerminal(stubSession("waiting"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(readFileSync(lockPath, "utf-8"), liveLock, "the deferred save waits instead of breaking a live lock");
    rmSync(lockPath);
    await store.whenPersisted();
    assert.deepEqual(readIndex(indexPath).sessions.map((row: { sessionId: string }) => row.sessionId).sort(), ["first", "waiting"]);
  });
});
