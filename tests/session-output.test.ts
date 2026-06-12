import { afterEach, describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getSessionOutputText } from "../src/application/session-view";
import { appendSessionOutput, getSessionOutputFilePath } from "../src/session-output";
import { cleanupOrphanOutputFiles, cleanupTmpOutputFiles, getNextTmpOutputCleanupAt } from "../src/session-store-storage";

const TEMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;

function redirectTmpDir(t: TestContext, dir: string): void {
  const previousEnv = new Map(
    TEMP_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of TEMP_ENV_KEYS) {
    process.env[key] = dir;
  }
  t.after(() => {
    for (const key of TEMP_ENV_KEYS) {
      const previous = previousEnv.get(key);
      if (previous == null) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });
}

function useIsolatedTmpDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-output-cleanup-test-"));
  redirectTmpDir(t, dir);
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

describe("session output file paths", () => {
  it("keeps nanoid-safe session IDs compatible with the existing filename format", () => {
    const sessionId = "GccpSIqJ_-stable-123";

    assert.equal(
      getSessionOutputFilePath(sessionId),
      join(tmpdir(), "openclaw-agent-GccpSIqJ_-stable-123.txt"),
    );
  });

  it("maps unsafe path-like session IDs to a deterministic filename under tmpdir", (t) => {
    const dir = useIsolatedTmpDir(t);
    const sessionId = "../escape\\session:name*?";
    const expectedFilename = "openclaw-agent-unsafe-bcbf2e65c6cd70c9a169c787417be7aafd1644fe94a0776ebdc212404ed52d76.txt";
    const outputPath = getSessionOutputFilePath(sessionId);

    assert.equal(dirname(outputPath), dir);
    assert.equal(basename(outputPath), expectedFilename);
    assert.equal(outputPath, join(dir, expectedFilename));
    assert.doesNotMatch(basename(outputPath), /[<>:"\/\\|?*\x00-\x1F]/u);
  });
});

describe("session output buffering", () => {
  const sessionId = "session-output-test";
  const outputPath = getSessionOutputFilePath(sessionId);

  afterEach(() => {
    if (existsSync(outputPath)) {
      rmSync(outputPath, { force: true });
    }
  });

  it("coalesces token-sized deltas into a single output line", () => {
    const buffer: string[] = [];

    appendSessionOutput(buffer, sessionId, "Hello");
    appendSessionOutput(buffer, sessionId, " world");
    appendSessionOutput(buffer, sessionId, "!");

    assert.deepEqual(buffer, ["Hello world!"]);
    assert.equal(readFileSync(outputPath, "utf-8"), "Hello world!");
  });

  it("starts a new output line only when the streamed text contains a newline", () => {
    const buffer: string[] = [];

    appendSessionOutput(buffer, sessionId, "First line\nSecond");
    appendSessionOutput(buffer, sessionId, " line");

    assert.deepEqual(buffer, ["First line", "Second line"]);
    assert.equal(readFileSync(outputPath, "utf-8"), "First line\nSecond line");
  });

  it("renders live session output without inserting one line per token", () => {
    const buffer: string[] = [];

    appendSessionOutput(buffer, sessionId, "Investigating");
    appendSessionOutput(buffer, sessionId, " output");
    appendSessionOutput(buffer, sessionId, " formatting.");

    const sm: any = {
      resolve: () => ({
        id: sessionId,
        name: "live-session",
        status: "running",
        phase: "active",
        lifecycle: "active",
        duration: 1000,
        costUsd: 0,
        getOutput: () => buffer,
      }),
    };

    const text = getSessionOutputText(sm, "live-session");
    assert.match(text, /Investigating output formatting\./);
    assert.doesNotMatch(text, /Investigating\n output\n formatting\./);
  });
});

describe("session output temp cleanup", () => {
  it("discovers only temp output txt files for cleanup operations", (t) => {
    const dir = useIsolatedTmpDir(t);
    const referenced = join(dir, "openclaw-agent-referenced.txt");
    const orphan = join(dir, "openclaw-agent-orphan.txt");
    const ignoredPrefix = join(dir, "not-openclaw-agent-old.txt");
    const ignoredSuffix = join(dir, "openclaw-agent-old.log");

    for (const filePath of [referenced, orphan, ignoredPrefix, ignoredSuffix]) {
      writeFileSync(filePath, "output\n", "utf-8");
    }

    const now = 100_000;
    const maxAgeMs = 10_000;
    utimesSync(referenced, new Date(95_000), new Date(95_000));
    utimesSync(orphan, new Date(96_000), new Date(96_000));
    utimesSync(ignoredPrefix, new Date(1_000), new Date(1_000));
    utimesSync(ignoredSuffix, new Date(1_000), new Date(1_000));

    assert.equal(getNextTmpOutputCleanupAt(now, maxAgeMs), statSync(referenced).mtimeMs + maxAgeMs);

    cleanupOrphanOutputFiles([referenced]);
    assert.equal(existsSync(referenced), true);
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(ignoredPrefix), true);
    assert.equal(existsSync(ignoredSuffix), true);

    cleanupTmpOutputFiles(200_000, maxAgeMs);
    assert.equal(existsSync(referenced), false);
    assert.equal(existsSync(ignoredPrefix), true);
    assert.equal(existsSync(ignoredSuffix), true);
  });

  it("does not age out temp output files still referenced by persisted sessions", (t) => {
    const dir = useIsolatedTmpDir(t);
    const referenced = join(dir, "openclaw-agent-referenced.txt");
    const orphan = join(dir, "openclaw-agent-orphan.txt");

    for (const filePath of [referenced, orphan]) {
      writeFileSync(filePath, "output\n", "utf-8");
      utimesSync(filePath, new Date(1_000), new Date(1_000));
    }

    const now = 100_000;
    const maxAgeMs = 10_000;

    assert.equal(getNextTmpOutputCleanupAt(now, maxAgeMs, [referenced]), now);
    cleanupTmpOutputFiles(now, maxAgeMs, [referenced]);

    assert.equal(existsSync(referenced), true);
    assert.equal(existsSync(orphan), false);
    assert.equal(getNextTmpOutputCleanupAt(now, maxAgeMs, [referenced]), undefined);
  });

  it("keeps temp output discovery failures non-fatal", (t) => {
    const missingTmpDir = join(tmpdir(), `openclaw-output-cleanup-missing-${process.pid}-${Date.now()}`);
    redirectTmpDir(t, missingTmpDir);

    assert.doesNotThrow(() => cleanupTmpOutputFiles(100_000, 10_000));
    assert.equal(getNextTmpOutputCleanupAt(100_000, 10_000), undefined);
    assert.doesNotThrow(() => cleanupOrphanOutputFiles([]));
  });
});
