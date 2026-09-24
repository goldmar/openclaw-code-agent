import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session-store";
import { normalizePersistedEntry, STORE_SCHEMA_VERSION } from "../src/session-store-normalization";

const FIXTURE = join(import.meta.dirname, "fixtures", "session-store-4.7.20.json");

function loadFixtureStore(t: { after: (fn: () => void) => void }): { store: SessionStore; dir: string; indexPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "oca-store-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const indexPath = join(dir, "code-agent-sessions.json");
  copyFileSync(FIXTURE, indexPath);
  return { store: new SessionStore({ indexPath, env: {} }), dir, indexPath };
}

describe("session store upgrade from 4.7.x", () => {
  it("loads current-format sessions from a 4.7.20 store and keeps a verbatim backup", (t) => {
    const { store, dir, indexPath } = loadFixtureStore(t);

    const names = store.listPersistedSessions().map((session) => session.name).sort();
    assert.deepEqual(names, ["add-metrics-endpoint", "docs-cleanup", "fix-login-redirect"]);
    const backups = readdirSync(dir).filter((name) => name.includes(".legacy-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(dir, backups[0]!), "utf-8"), readFileSync(FIXTURE, "utf-8"));
    assert.notEqual(readFileSync(indexPath, "utf-8"), readFileSync(FIXTURE, "utf-8"));

    const codex = store.getPersistedSession("add-metrics-endpoint");
    assert.equal(codex?.backendRef?.kind, "codex-app-server");
    assert.equal(codex?.worktreeLifecycle?.state, "pr_open");
    assert.equal(codex?.worktreePrNumber, 12);
    assert.equal(store.getPersistedSession("019e6c36-1321-7130-a871-7b4303e8ff32")?.sessionId, "Cd4eF6gH");
    assert.equal(store.getRepoPolicy("github.com/example/api")?.policy, "pr-required");
  });

  it("drops retired enum values and synthesizes worktree lifecycle from legacy fields", (t) => {
    const { store } = loadFixtureStore(t);

    const merged = store.getPersistedSession("fix-login-redirect");
    assert.equal(merged?.planApprovalContext, undefined, "retired soft-plan context is dropped, not remapped");
    assert.equal(merged?.worktreeLifecycle?.state, "merged");
    assert.equal(merged?.worktreeLifecycle?.resolvedAt, "2026-09-22T10:09:00.000Z");

    const dismissed = store.getPersistedSession("docs-cleanup");
    assert.equal(dismissed?.worktreeLifecycle?.state, "dismissed");
    assert.equal(dismissed?.worktreeLifecycle?.resolvedAt, "2026-09-22T12:00:00.000Z");
  });

  it("dates a synthesized worktree lifecycle from the row instead of the Unix epoch", () => {
    const entry = normalizePersistedEntry({
      sessionId: "wt-no-dates",
      harnessSessionId: "h-wt-no-dates",
      name: "wt-no-dates",
      prompt: "p",
      workdir: "/repo",
      status: "completed",
      harness: "claude-code",
      route: { provider: "telegram", target: "1", sessionKey: "agent:main:telegram:group:1" },
      worktreePath: "/repo/.worktrees/wt-no-dates",
      worktreeBranch: "agent/wt-no-dates",
      worktreeDisposition: "no-change-cleaned",
      createdAt: 1790000000000,
      completedAt: 1790000600000,
    });
    assert.ok(entry?.worktreeLifecycle, "lifecycle is synthesized");
    assert.equal(entry.worktreeLifecycle.updatedAt, new Date(1790000600000).toISOString());
    assert.notEqual(entry.worktreeLifecycle.updatedAt, new Date(0).toISOString());
  });

  it("skips unreadable rows and retired action token kinds while keeping valid ones", (t) => {
    const { store, indexPath } = loadFixtureStore(t);

    assert.equal(store.getPersistedSession("row-without-harness-session-id"), undefined);
    assert.equal(store.getPersistedSession("Gh6iJ8kL"), undefined);

    const rewritten = JSON.parse(readFileSync(indexPath, "utf-8")) as {
      schemaVersion: number;
      sessions: Array<{ sessionId?: string }>;
      actionTokens: Array<{ id: string }>;
    };
    assert.equal(rewritten.schemaVersion, STORE_SCHEMA_VERSION);
    assert.deepEqual(rewritten.sessions.map((session) => session.sessionId).sort(), ["Ab3dE5fG", "Cd4eF6gH", "Ef5gH7iJ"]);
    assert.deepEqual(rewritten.actionTokens.map((token) => token.id), ["tok-merge-1"]);
  });
});
