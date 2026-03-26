import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "url";
import { getSessionsListingText, getSessionOutputText } from "../src/application/session-view";
import { getSessionOutputFilePath } from "../src/session";

describe("session-view app layer", () => {
  it("shows only the 5 most recent sessions by default", () => {
    const now = Date.now();
    const sm: any = {
      list: () => [
        { status: "running", name: "s1", id: "1", duration: 1000, prompt: "x", multiTurn: true, workdir: "/tmp", costUsd: 0, phase: "running", startedAt: now - 1000 },
        { status: "running", name: "s2", id: "2", duration: 1000, prompt: "x", multiTurn: true, workdir: "/tmp", costUsd: 0, phase: "running", startedAt: now - 2000 },
        { status: "running", name: "s3", id: "3", duration: 1000, prompt: "x", multiTurn: true, workdir: "/tmp", costUsd: 0, phase: "running", startedAt: now - 3000 },
        { status: "running", name: "s4", id: "4", duration: 1000, prompt: "x", multiTurn: true, workdir: "/tmp", costUsd: 0, phase: "running", startedAt: now - 4000 },
        { status: "running", name: "s5", id: "5", duration: 1000, prompt: "x", multiTurn: true, workdir: "/tmp", costUsd: 0, phase: "running", startedAt: now - 5000 },
        { status: "running", name: "s6", id: "6", duration: 1000, prompt: "x", multiTurn: true, workdir: "/tmp", costUsd: 0, phase: "running", startedAt: now - 6 * 24 * 60 * 60 * 1000 },
      ],
      listPersistedSessions: () => [],
    };

    const text = getSessionsListingText(sm, "all");
    assert.match(text, /🟢 s1 \[1\]/);
    assert.match(text, /🟢 s5 \[5\]/);
    assert.doesNotMatch(text, /🟢 s6 \[6\]/);
  });

  it("includes harness metadata for active sessions in the listing text", () => {
    const now = Date.now();
    const sm: any = {
      list: () => [
        {
          status: "running",
          name: "live-codex",
          id: "1",
          duration: 1000,
          prompt: "x",
          multiTurn: true,
          workdir: "/tmp",
          costUsd: 0,
          phase: "implementing",
          harnessName: "codex",
          startedAt: now - 1000,
        },
      ],
      listPersistedSessions: () => [],
    };

    const text = getSessionsListingText(sm, "all", undefined, { full: true });
    assert.match(text, /🧰 Harness: codex/);
  });

  it("shows all sessions from the last 24h when full is enabled", () => {
    const now = Date.now();
    const sm: any = {
      list: () => [
        { status: "running", name: "recent-active", id: "1", duration: 1000, prompt: "x", multiTurn: true, workdir: "/tmp", costUsd: 0, phase: "running", startedAt: now - 1000 },
      ],
      listPersistedSessions: () => [
        {
          sessionId: "recent-persisted",
          harnessSessionId: "h-recent",
          name: "recent-persisted",
          status: "completed",
          prompt: "ok",
          workdir: "/tmp",
          createdAt: now - (23 * 60 * 60 * 1000),
          completedAt: now - 500,
          costUsd: 0,
        },
        {
          sessionId: "old-persisted",
          harnessSessionId: "h-old",
          name: "old-persisted",
          status: "completed",
          prompt: "old",
          workdir: "/tmp",
          createdAt: now - (25 * 60 * 60 * 1000),
          completedAt: now - 1000,
          costUsd: 0,
        },
      ],
    };

    const text = getSessionsListingText(sm, "all", undefined, { full: true });
    assert.match(text, /recent-active \[1\]/);
    assert.match(text, /recent-persisted \[recent-persisted\]/);
    assert.doesNotMatch(text, /old-persisted \[old-persisted\]/);
  });

  it("returns not found when output session reference is unknown", () => {
    const sm: any = {
      resolve: () => undefined,
      getPersistedSession: () => undefined,
    };
    const text = getSessionOutputText(sm, "unknown");
    assert.equal(text, 'Error: Session "unknown" not found.');
  });

  it("prefers listing only requested channel when provided", () => {
    const sm: any = {
      list: () => [
        {
          status: "running",
          name: "a",
          id: "1",
          duration: 1000,
          prompt: "x",
          multiTurn: true,
          originChannel: "chan:a",
        },
        {
          status: "running",
          name: "b",
          id: "2",
          duration: 1000,
          prompt: "x",
          multiTurn: true,
          originChannel: "chan:b",
        },
      ],
      listPersistedSessions: () => [],
    };
    const text = getSessionsListingText(sm, "all", "chan:b");
    assert.match(text, /🟢 b \[2\]/);
    assert.doesNotMatch(text, /🟢 a \[1\]/);
  });

  it("shows persisted sessions in merged listing after GC from memory", () => {
    const sm: any = {
      list: () => [],
      listPersistedSessions: () => [
        {
          sessionId: "s-persisted",
          harnessSessionId: "h-persisted",
          name: "done-job",
          status: "completed",
          prompt: "build",
          workdir: "/tmp",
          createdAt: 1000,
          completedAt: 3000,
          costUsd: 0,
        },
      ],
    };
    const text = getSessionsListingText(sm, "completed");
    assert.match(text, /✅ done-job \[s-persisted\]/);
  });

  it("does not crash when persisted rows are missing prompt/workdir fields", () => {
    const sm: any = {
      list: () => [],
      listPersistedSessions: () => [
        {
          sessionId: "s-legacy",
          harnessSessionId: "h-legacy",
          name: "legacy-session",
          status: "completed",
          createdAt: 1000,
          completedAt: 2000,
          costUsd: 0,
        },
      ],
    };

    const text = getSessionsListingText(sm, "completed");
    assert.match(text, /✅ legacy-session \[s-legacy\]/);
    assert.match(text, /📁 \(unknown\)/);
  });

  it("skips malformed persisted rows missing valid status", () => {
    const sm: any = {
      list: () => [],
      listPersistedSessions: () => [
        { harnessSessionId: "h2", completedAt: 3000 },
        {
          sessionId: "s-good",
          harnessSessionId: "h-good",
          name: "good-session",
          status: "completed",
          prompt: "ok",
          workdir: "/tmp",
          createdAt: 1000,
          completedAt: 4000,
          costUsd: 0,
        },
      ],
    };

    const text = getSessionsListingText(sm, "all");
    assert.match(text, /✅ good-session \[s-good\]/);
    assert.doesNotMatch(text, /h2 \[h2\]/);
  });

  it("de-dups same internal ID but keeps same-name different IDs separate", () => {
    const sm: any = {
      list: () => [
        {
          status: "running",
          name: "same-name",
          id: "same-id",
          duration: 5000,
          prompt: "active",
          multiTurn: true,
          workdir: "/tmp/a",
          costUsd: 0,
          phase: "running",
          originChannel: "chan:a",
          startedAt: 2000,
        },
        {
          status: "running",
          name: "same-name",
          id: "other-id",
          duration: 6000,
          prompt: "active2",
          multiTurn: true,
          workdir: "/tmp/b",
          costUsd: 0,
          phase: "running",
          originChannel: "chan:b",
          startedAt: 2500,
        },
      ],
      listPersistedSessions: () => [
        {
          sessionId: "same-id",
          harnessSessionId: "h-same-id",
          name: "same-name",
          status: "completed",
          prompt: "persisted-duplicate",
          workdir: "/tmp/p",
          createdAt: 1000,
          completedAt: 1100,
          costUsd: 0,
          originChannel: "chan:a",
        },
        {
          sessionId: "persisted-other",
          harnessSessionId: "h-persisted-other",
          name: "same-name",
          status: "completed",
          prompt: "persisted-unique",
          workdir: "/tmp/p2",
          createdAt: 900,
          completedAt: 1000,
          costUsd: 0,
          originChannel: "chan:c",
        },
      ],
    };

    const all = getSessionsListingText(sm, "all");
    assert.match(all, /same-name \[same-id\]/);
    assert.match(all, /same-name \[other-id\]/);
    assert.match(all, /same-name \[persisted-other\]/);
    assert.equal((all.match(/same-name \[same-id\]/g) ?? []).length, 1, "same-id should appear once");

    const channelFiltered = getSessionsListingText(sm, "all", "chan:a");
    assert.match(channelFiltered, /same-name \[same-id\]/);
    assert.doesNotMatch(channelFiltered, /same-name \[other-id\]/);
    assert.doesNotMatch(channelFiltered, /same-name \[persisted-other\]/);
  });

  it("uses updated persisted output label", () => {
    const sm: any = {
      resolve: () => undefined,
      getPersistedSession: () => ({
        name: "old",
        status: "completed",
        costUsd: 0,
        outputPath: fileURLToPath(import.meta.url),
      }),
    };
    const text = getSessionOutputText(sm, "old", { full: false, lines: 1 });
    assert.match(text, /evicted from runtime cache — showing persisted output/);
  });

  it("clamps invalid line counts to the default window", () => {
    const sm: any = {
      resolve: () => ({
        id: "s",
        name: "run",
        status: "running",
        phase: "running",
        duration: 1000,
        costUsd: 0,
        getOutput: (lines?: number) => {
          if (lines === undefined) return ["a", "b", "c"];
          return lines === 50 ? ["default-window"] : [`lines:${lines}`];
        },
      }),
    };

    const text = getSessionOutputText(sm, "run", { lines: -10, full: false });
    assert.match(text, /default-window/);
  });

  it("reads live output from the streaming temp file for active sessions", () => {
    const outputPath = getSessionOutputFilePath("live-123");
    writeFileSync(outputPath, "older line\nlatest line\n", "utf-8");

    try {
      const sm: any = {
        resolve: () => ({
          id: "live-123",
          name: "run",
          status: "running",
          phase: "running",
          duration: 1000,
          costUsd: 0,
          getOutput: () => ["buffered line"],
        }),
      };

      const text = getSessionOutputText(sm, "run", { full: false, lines: 1 });
      assert.match(text, /latest line/);
      assert.doesNotMatch(text, /buffered line/);
    } finally {
      rmSync(outputPath, { force: true });
    }
  });

  it("uses harness session ID when persisted session name is missing", () => {
    const sm: any = {
      resolve: () => undefined,
      getPersistedSession: () => ({
        harnessSessionId: "h-123",
        status: "completed",
        costUsd: 0,
        outputPath: fileURLToPath(import.meta.url),
      }),
    };
    const text = getSessionOutputText(sm, "h-123", { full: false, lines: 1 });
    assert.match(text, /Session: h-123 \| Status: COMPLETED/);
  });
});
