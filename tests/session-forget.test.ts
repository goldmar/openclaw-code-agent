import "./test-env";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../src/session-manager";
import { getForgetSessionText } from "../src/application/session-control";
import { makeAgentKillTool } from "../src/tools/agent-kill";
import { registerAgentKillCommand } from "../src/commands/agent-kill";
import { setGoalController, setSessionManager } from "../src/singletons";
import type { PersistedSessionInfo } from "../src/types";

function record(overrides: Partial<PersistedSessionInfo> = {}): PersistedSessionInfo {
  return {
    sessionId: "s-done",
    harnessSessionId: "h-done",
    name: "done-session",
    prompt: "do it",
    workdir: "/repo",
    status: "completed",
    lifecycle: "terminal",
    runtimeState: "stopped",
    costUsd: 0.01,
    completedAt: Date.now(),
    ...overrides,
  };
}

describe("forgetting finished sessions", () => {
  let dir: string;
  let indexPath: string;
  let sm: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openclaw-forget-"));
    indexPath = join(dir, "sessions.json");
    sm = new SessionManager(5, 50, { store: { indexPath, env: {} } });
  });

  afterEach(() => {
    setSessionManager(null);
    setGoalController(null);
    sm.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  const store = (): any => (sm as any).store;
  const storedIds = (): string[] => JSON.parse(readFileSync(indexPath, "utf-8")).sessions.map((entry: PersistedSessionInfo) => entry.sessionId);

  it("removes a terminal session's record, output file, and action tokens", () => {
    const outputPath = join(dir, "output.txt");
    writeFileSync(outputPath, "out");
    store().replacePersistedSession(record({ outputPath }));
    store().replacePersistedSession(record({ sessionId: "s-keep", harnessSessionId: "h-keep", name: "keep" }));
    let deletedTokensFor: string | undefined;
    const deleteTokens = store().deleteActionTokensForSession.bind(store());
    store().deleteActionTokensForSession = (id: string) => { deletedTokensFor = id; deleteTokens(id); };

    const text = getForgetSessionText(sm, "done-session");

    assert.match(text, /Session done-session \[s-done\] forgotten/);
    assert.equal(sm.getPersistedSession("done-session"), undefined);
    assert.equal(sm.getPersistedSession("h-done"), undefined, "backend id index is removed too");
    assert.ok(sm.getPersistedSession("keep"));
    assert.deepEqual(storedIds(), ["s-keep"]);
    assert.equal(existsSync(outputPath), false);
    assert.equal(deletedTokensFor, "s-done");
  });

  it("also drops a finished runtime session that is still in memory", () => {
    store().replacePersistedSession(record());
    (sm as any).sessions.set("s-done", { id: "s-done", name: "done-session", status: "completed" });

    assert.match(getForgetSessionText(sm, "s-done"), /forgotten/);
    assert.equal(sm.resolve("s-done"), undefined);
    assert.equal(sm.getPersistedSession("s-done"), undefined);
  });

  it("refuses running, suspended, and not-yet-persisted sessions", () => {
    (sm as any).sessions.set("s-run", { id: "s-run", name: "runner", status: "running" });
    assert.match(getForgetSessionText(sm, "runner"), /still running/);

    (sm as any).sessions.set("s-fresh", { id: "s-fresh", name: "fresh", status: "completed" });
    assert.match(getForgetSessionText(sm, "fresh"), /no stored record yet/);

    store().replacePersistedSession(record({ sessionId: "s-susp", harnessSessionId: "h-susp", name: "susp", status: "killed", lifecycle: "suspended", resumable: true }));
    assert.match(getForgetSessionText(sm, "susp"), /not finished \(suspended\).*agent_kill first/);
    assert.ok(sm.getPersistedSession("susp"));

    assert.equal(getForgetSessionText(sm, "missing"), 'Error: Session "missing" not found.');
  });

  it("refuses sessions whose worktree is not settled", () => {
    const worktreePath = join(dir, "wt");
    mkdirSync(worktreePath);
    store().replacePersistedSession(record({ sessionId: "s-pending", harnessSessionId: "h-pending", name: "pending", pendingWorktreeDecisionSince: new Date().toISOString(), worktreeState: "pending_decision" }));
    store().replacePersistedSession(record({ sessionId: "s-pr", harnessSessionId: "h-pr", name: "pr", worktreeState: "pr_open" }));
    store().replacePersistedSession(record({ sessionId: "s-disk", harnessSessionId: "h-disk", name: "disk", worktreeState: "merged", worktreePath }));
    store().replacePersistedSession(record({ sessionId: "s-gone", harnessSessionId: "h-gone", name: "gone", worktreeState: "merged", worktreePath: join(dir, "removed") }));

    assert.match(getForgetSessionText(sm, "pending"), /unsettled worktree \(pending_decision\)/);
    assert.match(getForgetSessionText(sm, "pr"), /unsettled worktree \(pr_open\)/);
    assert.match(getForgetSessionText(sm, "disk"), /worktree still on disk/);
    assert.match(getForgetSessionText(sm, "gone"), /forgotten/, "a merged session whose worktree is gone can be forgotten");
    assert.deepEqual(storedIds().sort(), ["s-disk", "s-pending", "s-pr"]);
  });

  it("refuses sessions with an in-flight terminal notification", () => {
    store().replacePersistedSession(record({ deliveryState: "wake_pending" }));
    assert.match(getForgetSessionText(sm, "done-session"), /still delivering/);
  });

  it("refuses sessions that a live goal loop owns", () => {
    store().replacePersistedSession(record());
    const goals = { listTasks: () => [{ id: "g1", name: "goal-one", status: "waiting_for_session", sessionId: "s-done" }] as any };
    assert.match(getForgetSessionText(sm, "done-session", goals), /owned by goal task goal-one/);
    const finishedGoals = { listTasks: () => [{ id: "g1", name: "goal-one", status: "succeeded", sessionId: "s-done" }] as any };
    assert.match(getForgetSessionText(sm, "done-session", finishedGoals), /forgotten/);
  });

  it("is reachable through agent_kill(forget=true) and /agent_kill --forget", async () => {
    setSessionManager(sm);
    store().replacePersistedSession(record());
    store().replacePersistedSession(record({ sessionId: "s-two", harnessSessionId: "h-two", name: "two" }));

    const tool = makeAgentKillTool();
    const result = await tool.execute("id", { session: "done-session", forget: true });
    assert.match((result.content[0] as { text: string }).text, /forgotten/);
    const invalid = await tool.execute("id", { session: "two", forget: "yes" });
    assert.match((invalid.content[0] as { text: string }).text, /Invalid parameters/);

    let handler: ((ctx: { args?: string }) => { text: string }) | undefined;
    registerAgentKillCommand({ registerCommand: (command) => { handler = command.handler; } });
    assert.match(handler!({ args: "--forget" }).text, /Usage/);
    assert.match(handler!({ args: "--forget two" }).text, /Session two \[s-two\] forgotten/);
    assert.deepEqual(storedIds(), []);
  });
});
