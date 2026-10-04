import "./test-env";
import { it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeGitHub } from "./fake-github";
import { waitUntil } from "./harness-backends";

it("read-only gh calls cannot overwrite a newer API state during maintenance", async () => {
  const github = createFakeGitHub();
  const controls = mkdtempSync(join(tmpdir(), "oca-gh-read-race-"));
  const preload = join(controls, "hold-state-read.cjs");
  // Pause only this child's initial API-state read. This reproduces an ordinary
  // scheduling gap between a gh read and a later seed/update in the test owner.
  writeFileSync(preload, String.raw`
const fs = require("node:fs");
const originalRead = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  const contents = originalRead.call(this, path, ...args);
  if (path === process.env.OCA_FAKE_GH_STATE) {
    fs.writeFileSync(process.env.OCA_GH_READ_ENTERED, "read\n");
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(process.env.OCA_GH_READ_RELEASE)) {
      if (Date.now() > deadline) throw Error("TEST_READ_BARRIER_TIMEOUT");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return contents;
};
`);
  try {
    for (const [index, args] of [
      ["repo", "view", "acme/widget", "--json", "nameWithOwner"],
      ["pr", "list", "--state", "all", "--json", "number"],
      ["pr", "view", "101", "--json", "number"],
      ["pr", "view", "missing", "--json", "number"],
      ["pr", "create", "--head", "main", "--base", "main", "--title", "A title", "--body", "A body"],
    ].entries()) {
      github.resetState();
      github.seedPr({ headRefName: "main", state: "MERGED" });
      if (args[1] === "create") github.updateState(state => { state.failures.createSilent = true; });
      const entered = join(controls, `entered-${index}`);
      const release = join(controls, `release-${index}`);
      const completion = new Promise<void>((resolve, reject) => {
        execFile("gh", args, {
          cwd: github.repoDir,
          env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, OCA_GH_READ_ENTERED: entered, OCA_GH_READ_RELEASE: release },
        }, (error) => {
          if (args[2] === "missing" || args[1] === "create") {
            try { assert.equal(error?.code, 1, "the configured read/create failure still exits 1"); resolve(); } catch (failure) { reject(failure); }
          } else if (error) reject(error);
          else resolve();
        });
      });
      try {
        await waitUntil(() => existsSync(entered), "gh initial API snapshot", 10000);
        const replacement = github.seedPr({ headRefName: "main", state: "MERGED" });
        const stateBefore = readFileSync(process.env.OCA_FAKE_GH_STATE!, "utf8");
        writeFileSync(release, "continue\n");
        await completion;
        assert.equal(readFileSync(process.env.OCA_FAKE_GH_STATE!, "utf8"), stateBefore, `${args.join(" ")} must preserve the newer API row`);
        assert.ok(github.readState().prs.some(pr => pr.number === replacement.number));
      } finally {
        writeFileSync(release, "continue\n");
        await completion;
      }
    }
  } finally {
    github.dispose();
    rmSync(controls, { recursive: true, force: true });
  }
});
