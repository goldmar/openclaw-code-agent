import "./test-env";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { SessionStore } from "../src/session-store";
import { tryAcquireSessionStoreLock } from "../src/session-store-storage";
import { propertyParams } from "./property-harness";
import { waitUntil } from "./harness-backends";
import { startFullStack, type FullStack } from "./fullstack-fixture";

/**
 * Concurrency: two writers of one session index, concurrent button callbacks,
 * and callbacks racing a Gateway stop.
 *
 * The two-writer model generalizes tests/session-store-multi-writer.test.ts:
 * random interleavings of token mints, consumptions (button clicks), session
 * rows, disk syncs, and lock contention (which defers saves and lets the two
 * writers' memories diverge) against a reference model. Invariants:
 *
 * - every minted token and every session row either writer created is on disk
 *   once both writers settled (nothing is lost by a merge);
 * - a consumption, once on disk, stays on disk;
 * - each token acts at most once across both writers: a click acts when the
 *   writer's consumption is confirmed after it is persisted, exactly as the
 *   callback handler does;
 * - the on-disk revision never goes backwards.
 */

type Writer = 0 | 1;
type Op =
  | { t: "mint"; w: Writer; session: number }
  | { t: "click"; w: Writer; token: number }
  | { t: "row"; w: Writer; session: number }
  | { t: "sync"; w: Writer }
  | { t: "lock" }
  | { t: "unlock" }
  | { t: "settle" };

const writerArb = fc.constantFrom<Writer>(0, 1);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.tuple(writerArb, fc.nat(2)).map(([w, session]): Op => ({ t: "mint", w, session })) },
  { weight: 6, arbitrary: fc.tuple(writerArb, fc.nat(3)).map(([w, token]): Op => ({ t: "click", w, token })) },
  { weight: 2, arbitrary: fc.tuple(writerArb, fc.nat(3)).map(([w, session]): Op => ({ t: "row", w, session })) },
  { weight: 1, arbitrary: writerArb.map((w): Op => ({ t: "sync", w })) },
  { weight: 2, arbitrary: fc.constant<Op>({ t: "lock" }) },
  { weight: 1, arbitrary: fc.constant<Op>({ t: "unlock" }) },
  { weight: 1, arbitrary: fc.constant<Op>({ t: "settle" }) },
);

type DiskIndex = {
  revision?: number;
  sessions: Array<{ sessionId?: string }>;
  actionTokens: Array<{ id: string; consumedAt?: number }>;
};

function readDisk(indexPath: string): DiskIndex | undefined {
  try {
    return JSON.parse(readFileSync(indexPath, "utf-8")) as DiskIndex;
  } catch {
    return undefined;
  }
}

function stubSession(id: string) {
  return {
    id,
    name: `name-${id}`,
    harnessSessionId: `h-${id}`,
    prompt: "p",
    workdir: "/tmp",
    startedAt: 1,
    harnessName: "codex",
    status: "completed",
    completedAt: 2,
    costUsd: 0,
    getOutput: (): string[] => [],
  } as unknown as Parameters<SessionStore["persistTerminal"]>[0];
}

type StoreLike = Pick<SessionStore, "actionTokenStore" | "consumeActionToken" | "confirmActionTokenConsumption" | "persistTerminal" | "syncFromDisk" | "whenPersisted" | "saveIndex">;

/**
 * Run one interleaving. A click acts like the callback handler: consume, wait
 * until the consumption is persisted, then act only if it is still this
 * writer's consumption.
 */
async function runModel(
  ops: Op[],
  makeWriters: (indexPath: string) => [StoreLike, StoreLike],
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oca-two-writer-model-"));
  const indexPath = join(dir, "sessions.json");
  const writers = makeWriters(indexPath);
  const minted: string[] = [];
  const rows = new Set<string>();
  const acted = new Map<string, number>();
  const everConsumedOnDisk = new Set<string>();
  const pendingActs: Array<Promise<void>> = [];
  let lock: { release: () => void } | undefined;
  let lastRevision = 0;

  const observeDisk = (): void => {
    const disk = readDisk(indexPath);
    if (!disk) return;
    const revision = disk.revision ?? 0;
    assert.ok(revision >= lastRevision, `the index revision went backwards (${lastRevision} -> ${revision})`);
    lastRevision = revision;
    for (const token of disk.actionTokens) {
      if (token.consumedAt != null) everConsumedOnDisk.add(token.id);
    }
    for (const id of everConsumedOnDisk) {
      const token = disk.actionTokens.find((candidate) => candidate.id === id);
      assert.ok(token, `consumed token ${id} vanished from disk`);
      assert.notEqual(token.consumedAt, undefined, `consumption of ${id} was undone on disk`);
    }
  };

  const settle = async (): Promise<void> => {
    lock?.release();
    lock = undefined;
    await Promise.all(writers.map((writer) => writer.whenPersisted()));
    await Promise.all(pendingActs.splice(0));
    observeDisk();
  };

  try {
    for (const op of ops) {
      switch (op.t) {
        case "mint": {
          const token = writers[op.w].actionTokenStore.createActionToken(`s${op.session}`, "worktree-merge", {
            expiresAt: Date.now() + 60 * 60 * 1000,
          });
          minted.push(token.id);
          break;
        }
        case "click": {
          const id = minted[op.token % Math.max(1, minted.length)];
          if (!id) break;
          const writer = writers[op.w];
          const consumed = writer.consumeActionToken(id);
          if (!consumed) break;
          const consumptionId = consumed.consumptionId;
          pendingActs.push((async () => {
            await writer.whenPersisted();
            if (writer.confirmActionTokenConsumption(id, consumptionId)) acted.set(id, (acted.get(id) ?? 0) + 1);
          })());
          break;
        }
        case "row":
          rows.add(`s${op.session}`);
          writers[op.w].persistTerminal(stubSession(`s${op.session}`));
          break;
        case "sync":
          writers[op.w].syncFromDisk("model");
          break;
        case "lock": {
          if (lock) break;
          const attempt = tryAcquireSessionStoreLock(indexPath);
          if (typeof attempt === "object") lock = attempt;
          break;
        }
        case "unlock":
          lock?.release();
          lock = undefined;
          // Let deferred saves retry.
          await new Promise((resolve) => setTimeout(resolve, 30));
          break;
        case "settle":
          await settle();
          break;
      }
      observeDisk();
    }
    await settle();
    // A final save from each writer merges whatever the other one wrote last.
    for (const writer of writers) writer.saveIndex();
    await settle();

    const disk = readDisk(indexPath)!;
    const tokenIds = new Set(disk.actionTokens.map((token) => token.id));
    for (const id of minted) assert.ok(tokenIds.has(id), `minted token ${id} was lost`);
    const sessionIds = new Set(disk.sessions.map((row) => row.sessionId));
    for (const id of rows) assert.ok(sessionIds.has(id), `session row ${id} was lost`);
    for (const [id, count] of acted) assert.equal(count, 1, `token ${id} acted ${count} times across two writers`);
  } finally {
    lock?.release();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("two writers of one session index (model)", () => {
  it("never loses rows or tokens and acts on each token at most once", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 40 }), async (ops) => {
        await runModel(ops, (indexPath) => [
          new SessionStore({ indexPath, env: {}, instanceId: "writer-a" }),
          new SessionStore({ indexPath, env: {}, instanceId: "writer-b" }),
        ]);
      }),
      propertyParams(100),
    );
  });

  it("acts once when one button is clicked in both writers while their saves are deferred", async () => {
    // The shrunk counterexample the model found: both writers consume the same
    // token while another writer holds the index lock, so neither sees the
    // other's consumption before both are persisted.
    await runModel(
      [
        { t: "mint", w: 0, session: 0 },
        { t: "settle" },
        { t: "lock" },
        { t: "click", w: 0, token: 0 },
        { t: "click", w: 1, token: 0 },
        { t: "settle" },
      ],
      (indexPath) => [
        new SessionStore({ indexPath, env: {}, instanceId: "writer-a" }),
        new SessionStore({ indexPath, env: {}, instanceId: "writer-b" }),
      ],
    );
  });
});

describe("a consumption from an older build", () => {
  it("wins over a later click whose save was deferred, although it carries no consumption id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oca-old-build-consumption-"));
    const indexPath = join(dir, "sessions.json");
    try {
      const store = new SessionStore({ indexPath, env: {}, instanceId: "new-build" });
      const token = store.actionTokenStore.createActionToken("s1", "worktree-merge", { expiresAt: Date.now() + 60_000 });
      const lock = tryAcquireSessionStoreLock(indexPath);
      assert.ok(typeof lock === "object");
      const consumed = store.consumeActionToken(token.id);
      assert.ok(consumed?.consumptionId, "this build records who consumed the token");
      const consumptionId = consumed.consumptionId;
      // Meanwhile an older runtime persists its own click, without a consumption id.
      const disk = JSON.parse(readFileSync(indexPath, "utf-8")) as DiskIndex;
      const row = disk.actionTokens.find((candidate) => candidate.id === token.id)!;
      row.consumedAt = Date.now() - 1;
      disk.revision = (disk.revision ?? 0) + 1;
      writeFileSync(indexPath, JSON.stringify(disk));
      lock.release();
      await store.whenPersisted();
      assert.equal(store.confirmActionTokenConsumption(token.id, consumptionId), false, "the older build's click acts; this one does not");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("overlapping saves from two plugin copies", () => {
  const repoRoot = join(import.meta.dirname, "..");
  let copyRoot: string | undefined;
  after(() => {
    if (copyRoot) rmSync(copyRoot, { recursive: true, force: true });
  });

  it("merges the saves of two module copies of the store (an old runtime still stopping and its successor)", async () => {
    // A second copy of the source is a second module graph, like a hot-reloaded build.
    copyRoot = mkdtempSync(join(repoRoot, ".instance-store-copy-"));
    cpSync(join(repoRoot, "src"), join(copyRoot, "src"), { recursive: true });
    cpSync(join(repoRoot, "package.json"), join(copyRoot, "package.json"));
    const copy = await import(pathToFileURL(join(copyRoot, "src", "session-store.ts")).href) as { SessionStore: typeof SessionStore };
    assert.notEqual(copy.SessionStore, SessionStore, "a separate module copy");
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 30 }), async (ops) => {
        await runModel(ops, (indexPath) => [
          new SessionStore({ indexPath, env: {}, instanceId: "old-build" }),
          new copy.SessionStore({ indexPath, env: {}, instanceId: "new-build" }),
        ]);
      }),
      propertyParams(15),
    );
  });
});

describe("concurrent callbacks through the plugin entry", () => {
  let stack: FullStack | undefined;
  beforeEach(() => { stack = undefined; });
  afterEach(async () => {
    await stack?.dispose();
    stack = undefined;
  });

  it("acts once when the same question button is clicked twice at the same time", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const session = await s.launch();
    const answered = s.backend.ask([{ id: "color", question: "Which color?", options: ["Red", "Green"] }]);
    const green = await s.waitForButton("Green");
    const [first, second] = await Promise.all([s.click(green), s.click(green)]);
    const replies = [...first.replies, ...second.replies];
    assert.equal(replies.filter((text) => /Pending input request submitted/.test(text)).length, 1, replies.join(" | "));
    assert.deepEqual(await answered, { kind: "answered", answers: { "Which color?": ["Green"] } });
    await waitUntil(() => !session.pendingInputState, "question cleared");
  });

  it("acts once when Approve is clicked twice at the same time", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const session = await s.launch({ permissionMode: "plan", planApproval: "ask" });
    s.backend.proposePlan("1. Do it");
    await waitUntil(() => session.pendingPlanApproval === true, "pending plan");
    const approve = await s.waitForButton("Approve");
    const turnsBefore = s.backend.turns.length;
    await Promise.all([s.click(approve), s.click(approve)]);
    await waitUntil(() => s.backend.turns.length > turnsBefore, "implementation turn");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(s.backend.turns.length, turnsBefore + 1, "exactly one implementation turn");
  });

  it("handles a callback that races a Gateway stop without acting twice or hanging", async () => {
    const s = stack = await startFullStack({ backend: "codex" });
    const session = await s.launch();
    const answered = s.backend.ask([{ id: "color", question: "Which color?", options: ["Red", "Green"] }]);
    const green = await s.waitForButton("Green");
    const [click] = await Promise.all([s.click(green), s.host.stopServices()]);
    // Either the click won the race and answered, or the runtime stopped first
    // and the click (which restarts the service lazily) reports it cannot act.
    const text = click.replies.join("\n");
    if (/Pending input request submitted/.test(text)) {
      assert.deepEqual(await answered, { kind: "answered", answers: { "Which color?": ["Green"] } });
    } else {
      assert.match(text, /stale|no longer active|not running|could not/i);
    }
    void session;
    // A second click after the stop never acts again.
    const late = await s.click(green);
    assert.doesNotMatch(late.replies.join("\n"), /Pending input request submitted/);
  });
});
