import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBundleSizeReport } from "../scripts/check-bundle-size.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDistFixture(indexBytes: number, chunkBytes: number) {
  const root = mkdtempSync(join(tmpdir(), "bundle-size-check-"));
  temporaryDirectories.push(root);
  const distDir = join(root, "dist");
  mkdirSync(join(distDir, "chunks"), { recursive: true });
  writeFileSync(join(distDir, "index.js"), Buffer.alloc(indexBytes));
  writeFileSync(join(distDir, "chunks", "npm-release-client.js"), Buffer.alloc(chunkBytes));
  return distDir;
}

describe("complete bundle size reporting", () => {
  it("includes nested generated chunks in the total and limit decision", () => {
    const distDir = createDistFixture(400, 250);
    const report = createBundleSizeReport(distDir, 600);

    assert.equal(report.sizeBytes, 650);
    assert.equal(report.overLimit, true);
    assert.deepEqual(report.files.map((file) => file.path), [
      `${distDir}/chunks/npm-release-client.js`,
      `${distDir}/index.js`,
    ]);
    assert.match(report.body, /\*\*Total\*\* \| \*\*0\.6 KB\*\*/);
    assert.match(report.body, /❌ EXCEEDS LIMIT/);
  });

  it("passes when the complete generated bundle is within the limit", () => {
    const report = createBundleSizeReport(createDistFixture(300, 200), 600);

    assert.equal(report.sizeBytes, 500);
    assert.equal(report.overLimit, false);
    assert.match(report.body, /✅ Within limit/);
  });
});
