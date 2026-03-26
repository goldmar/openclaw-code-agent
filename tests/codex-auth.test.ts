import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createCodexAuthWorkspace } from "../src/harness/codex-auth";
import { resolveCodexAuthWorkspaceRoot } from "../src/openclaw-paths";

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "openclaw-codex-auth-test-"));
  const canonicalHome = join(rootDir, "canonical-home");
  const canonicalCodexDir = join(canonicalHome, ".codex");
  const canonicalAuthPath = join(canonicalCodexDir, "auth.json");
  const canonicalSessionsPath = join(canonicalCodexDir, "sessions");
  const canonicalConfigPath = join(canonicalCodexDir, "config.toml");
  const tempRootDir = join(rootDir, "isolated-homes");
  const lockDir = join(rootDir, "lockdir");

  await mkdir(canonicalSessionsPath, { recursive: true });
  await mkdir(tempRootDir, { recursive: true });

  return {
    rootDir,
    canonicalHome,
    canonicalAuthPath,
    canonicalSessionsPath,
    canonicalConfigPath,
    lockDir,
    tempRootDir,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

describe("createCodexAuthWorkspace", () => {
  it("defaults the isolated Codex home root to OpenClaw state instead of /tmp", async () => {
    const resolved = resolveCodexAuthWorkspaceRoot({
      HOME: "/home/tester",
      OPENCLAW_HOME: "/home/tester/.openclaw-state",
    });

    assert.equal(resolved, "/home/tester/.openclaw-state/codex-auth");
  });

  it("creates an isolated temp home with the expected structure", async () => {
    const fixture = await createFixture();

    try {
      await writeFile(fixture.canonicalConfigPath, "model = \"gpt-5\"\n", "utf8");

      const workspace = await createCodexAuthWorkspace(
        { HOME: fixture.canonicalHome, PATH: process.env.PATH ?? "" },
        { lockDir: fixture.lockDir, tempRootDir: fixture.tempRootDir },
      );

      assert.ok(await pathExists(workspace.tempHome));
      assert.ok(await pathExists(workspace.tempCodexDir));

      const sessionsLink = join(workspace.tempCodexDir, "sessions");
      const configLink = join(workspace.tempCodexDir, "config.toml");

      assert.ok((await lstat(sessionsLink)).isSymbolicLink());
      assert.equal(await readlink(sessionsLink), workspace.canonicalSessionsPath);

      assert.ok((await lstat(configLink)).isSymbolicLink());
      assert.equal(await readlink(configLink), workspace.canonicalConfigPath);

      await workspace.cleanup();
      assert.equal(await pathExists(workspace.tempHome), false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("copies auth.json into the isolated .codex directory during bootstrap", async () => {
    const fixture = await createFixture();

    try {
      await writeFile(fixture.canonicalAuthPath, JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: 100,
        tokens: { refresh_token: "canonical" },
      }), "utf8");

      const workspace = await createCodexAuthWorkspace(
        { HOME: fixture.canonicalHome, PATH: process.env.PATH ?? "" },
        { lockDir: fixture.lockDir, tempRootDir: fixture.tempRootDir },
      );

      const release = await workspace.prepareForTurn();
      const copied = await readJson(join(workspace.tempCodexDir, "auth.json"));
      assert.equal(copied.tokens.refresh_token, "canonical");

      await release();
      await workspace.cleanup();
    } finally {
      await fixture.cleanup();
    }
  });

  it("syncs back to canonical auth.json only when the isolated copy is newer", async () => {
    const fixture = await createFixture();

    try {
      await writeFile(fixture.canonicalAuthPath, JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: 100,
        tokens: { refresh_token: "old-token" },
      }), "utf8");

      const workspace = await createCodexAuthWorkspace(
        { HOME: fixture.canonicalHome, PATH: process.env.PATH ?? "" },
        { lockDir: fixture.lockDir, tempRootDir: fixture.tempRootDir },
      );

      const release = await workspace.prepareForTurn();
      await writeFile(join(workspace.tempCodexDir, "auth.json"), JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: 200,
        tokens: { refresh_token: "new-token" },
      }), "utf8");

      await release();

      const canonical = await readJson(fixture.canonicalAuthPath);
      assert.equal(canonical.last_refresh, 200);
      assert.equal(canonical.tokens.refresh_token, "new-token");

      await workspace.cleanup();
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the canonical auth.json when the isolated copy is older or equal", async () => {
    const fixture = await createFixture();

    try {
      await writeFile(fixture.canonicalAuthPath, JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: 200,
        tokens: { refresh_token: "canonical-token" },
      }), "utf8");

      const workspace = await createCodexAuthWorkspace(
        { HOME: fixture.canonicalHome, PATH: process.env.PATH ?? "" },
        { lockDir: fixture.lockDir, tempRootDir: fixture.tempRootDir },
      );

      const release = await workspace.prepareForTurn();
      await writeFile(join(workspace.tempCodexDir, "auth.json"), JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: 200,
        tokens: { refresh_token: "stale-token" },
      }), "utf8");

      await release();

      const canonical = await readJson(fixture.canonicalAuthPath);
      assert.equal(canonical.last_refresh, 200);
      assert.equal(canonical.tokens.refresh_token, "canonical-token");

      await workspace.cleanup();
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not overwrite canonical auth.json when the isolated copy is malformed", async () => {
    const fixture = await createFixture();

    try {
      await writeFile(fixture.canonicalAuthPath, JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: 100,
        tokens: { refresh_token: "canonical-token" },
      }), "utf8");

      const workspace = await createCodexAuthWorkspace(
        { HOME: fixture.canonicalHome, PATH: process.env.PATH ?? "" },
        { lockDir: fixture.lockDir, tempRootDir: fixture.tempRootDir },
      );

      const release = await workspace.prepareForTurn();
      await writeFile(join(workspace.tempCodexDir, "auth.json"), "{ malformed", "utf8");

      await release();

      const canonical = await readJson(fixture.canonicalAuthPath);
      assert.equal(canonical.last_refresh, 100);
      assert.equal(canonical.tokens.refresh_token, "canonical-token");

      await workspace.cleanup();
    } finally {
      await fixture.cleanup();
    }
  });

  it("acquires and releases the lock directory around bootstrap", async () => {
    const fixture = await createFixture();

    try {
      const workspace = await createCodexAuthWorkspace(
        { HOME: fixture.canonicalHome, PATH: process.env.PATH ?? "" },
        { lockDir: fixture.lockDir, tempRootDir: fixture.tempRootDir },
      );

      const release = await workspace.prepareForTurn();
      assert.equal(await pathExists(fixture.lockDir), true);

      await release();
      assert.equal(await pathExists(fixture.lockDir), false);

      await workspace.cleanup();
    } finally {
      await fixture.cleanup();
    }
  });

  it("serializes concurrent lock attempts so the second bootstrap waits", async () => {
    const fixture = await createFixture();

    try {
      const workspaceOne = await createCodexAuthWorkspace(
        { HOME: fixture.canonicalHome, PATH: process.env.PATH ?? "" },
        { lockDir: fixture.lockDir, tempRootDir: fixture.tempRootDir, lockRetryMs: 10, lockTimeoutMs: 1_000 },
      );

      const workspaceTwo = await createCodexAuthWorkspace(
        { HOME: fixture.canonicalHome, PATH: process.env.PATH ?? "" },
        { lockDir: fixture.lockDir, tempRootDir: fixture.tempRootDir, lockRetryMs: 10, lockTimeoutMs: 1_000 },
      );

      const releaseOne = await workspaceOne.prepareForTurn();
      let secondResolved = false;
      const startedAt = Date.now();

      const secondBootstrap = workspaceTwo.prepareForTurn().then((release) => {
        secondResolved = true;
        return release;
      });

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
      assert.equal(secondResolved, false);

      await releaseOne();
      const releaseTwo = await secondBootstrap;
      assert.ok(Date.now() - startedAt >= 80);

      await releaseTwo();
      await workspaceOne.cleanup();
      await workspaceTwo.cleanup();
    } finally {
      await fixture.cleanup();
    }
  });
});
