import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { KeyedOperationQueue } from "../src/keyed-operation-queue";

describe("KeyedOperationQueue", () => {
  it("serializes operations per key and reports queued operations", async () => {
    const queue = new KeyedOperationQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue("repo-a", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    await Promise.resolve();

    const second = queue.enqueue("repo-a", async () => {
      events.push("second");
    }, () => {
      events.push("second:queued");
    });
    const other = queue.enqueue("repo-b", async () => {
      events.push("other");
    });

    await other;
    assert.deepEqual(events, ["first:start", "second:queued", "other"]);

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:start", "second:queued", "other", "first:end", "second"]);
  });

  it("does not let a failed operation block later work for the same key", async () => {
    const queue = new KeyedOperationQueue();
    const events: string[] = [];

    await assert.rejects(
      queue.enqueue("repo-a", async () => {
        events.push("first");
        throw new Error("merge failed");
      }),
      /merge failed/,
    );

    await queue.enqueue("repo-a", async () => {
      events.push("second");
    });

    assert.deepEqual(events, ["first", "second"]);
  });

  it("clear drops queued tails without cancelling already-created operations", async () => {
    const queue = new KeyedOperationQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue("repo-a", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    await Promise.resolve();

    const second = queue.enqueue("repo-a", async () => {
      events.push("second");
    });
    queue.clear();
    const third = queue.enqueue("repo-a", async () => {
      events.push("third");
    });

    await third;
    assert.deepEqual(events, ["first:start", "third"]);

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:start", "third", "first:end", "second"]);
  });
});
