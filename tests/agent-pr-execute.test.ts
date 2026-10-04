import "./test-env";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverExistingTargetPr, makeAgentPrTool } from "../src/tools/agent-pr";
import { resolveLandingBaseBranch, resolveWorktreeLifecycle } from "../src/worktree-lifecycle-resolver";
import { makeAgentWorktreeStatusTool } from "../src/tools/agent-worktree-status";
import { resetCanonicalRepoNamesForTests } from "../src/worktree-pr";
import { makeAgentMergeTool } from "../src/tools/agent-merge";
import { USER_BUTTON_TOOL_CALL_ID } from "../src/tools/worktree-tool-context";
import { SessionManager } from "../src/session-manager";
import { setSessionManager } from "../src/singletons";
import { setPluginRuntime } from "../src/runtime-store";
import { registerHarness } from "../src/harness";
import { commentOnPR, createWorktree, getBranchName, updatePRTitle } from "../src/worktree";
import type { PersistedSessionInfo } from "../src/types";
import type { SessionNotificationRequest } from "../src/wake-dispatcher";
import { createFakeGitHub, git, type FakeGitHub } from "./fake-github";
import { createFakeHost, type FakeHost } from "./fake-host";
import { createFakeHarness, createStubSession } from "./helpers";
import { waitUntil } from "./harness-backends";
import { createCallbackHandler } from "../src/callback-handler";
import { buildCallbackContext } from "./user-interaction-fixture";

const GENERATED_FOOTER = "Generated with [openclaw-code-agent](https://github.com/goldmar/openclaw-code-agent)";
const SESSION_NAME = "pr-flow";
const SESSION_ID = "s-pr-flow";

type AgentPrResult = { content: Array<{ type: "text"; text: string }>; meta: { success: boolean; state: string; outcomeNotified?: boolean } };
type Outcome = { line: string; detailLines?: string[]; completionWakeOutcomeKey?: string };

const LLM_METADATA = JSON.stringify({
  title: "Add the feature file",
  summary: ["Adds a feature file for the worktree flow."],
  changes: ["Adds `feature.txt`."],
  validation: ["Checked the file contents."],
  notes: ["No behavior change outside the new file."],
});

const SESSION_REPORT = [
  "## Summary",
  "- Added the feature file the task asked for.",
  "",
  "## Changes",
  "- Added feature.txt with the feature flag text.",
  "",
  "## Validation",
  "- Read the file back.",
].join("\n");

type Fixture = {
  gh: FakeGitHub;
  host: FakeHost;
  sm: SessionManager;
  worktreePath: string;
  branch: string;
  outcomes: Outcome[];
  dispatches: SessionNotificationRequest[];
  storeDir: string;
  persisted(): PersistedSessionInfo | undefined;
  commit(file: string, content: string, message: string): string;
  run(params?: Record<string, unknown>): Promise<AgentPrResult>;
};

// Teardown steps, registered as each resource is created so a setup that
// fails halfway still cleans up what it made.
const cleanups: Array<() => unknown> = [];
// One fake GitHub (bare remote, checkout, `gh`) per file; each test gets a fresh
// worktree branch, session store, and `gh` state.
let github: FakeGitHub;
let worktreeCounter = 0;

before(() => {
  github = createFakeGitHub();
});

after(() => {
  github.dispose();
});

type ManagerFixture = {
  host: FakeHost;
  sm: SessionManager;
  storeDir: string;
  outcomes: Outcome[];
  dispatches: SessionNotificationRequest[];
};

/** Remove a test worktree (it may already be gone after a strategy cleaned it up). */
function removeTestWorktree(worktreePath: string): void {
  try {
    git(github.repoDir, "worktree", "remove", "--force", worktreePath);
  } catch {
    rmSync(worktreePath, { recursive: true, force: true });
  }
}

/** Fake host plus a SessionManager on a fresh store, installed as the plugin singletons. */
function createManagerFixture(llmReplies: string[]): ManagerFixture {
  github.resetState();
  const host = createFakeHost({ llmReplies });
  cleanups.push(() => host.dispose());
  setPluginRuntime(host.runtime);
  cleanups.push(() => setPluginRuntime(undefined));
  const storeDir = mkdtempSync(join(tmpdir(), "oca-agent-pr-store-"));
  cleanups.push(() => rmSync(storeDir, { recursive: true, force: true }));
  const sm = new SessionManager(5, 50, { store: { env: {}, indexPath: join(storeDir, "sessions.json") } });
  cleanups.push(() => sm.shutdown());
  const outcomes: Outcome[] = [];
  const dispatches: SessionNotificationRequest[] = [];
  // Capture user-facing output instead of delivering it through the Gateway.
  Object.assign(sm["notifications"], {
    dispatch: (_session: unknown, request: SessionNotificationRequest) => {
      dispatches.push(request);
      request.hooks?.onNotifySucceeded?.();
    },
    notifyWorktreeOutcome: (_session: unknown, line: string, extra?: Omit<Outcome, "line">) => {
      outcomes.push({ line, ...extra });
    },
  });
  setSessionManager(sm);
  cleanups.push(() => setSessionManager(null));
  return { host, sm, storeDir, outcomes, dispatches };
}

async function setup(options: {
  llmReplies?: string[];
  commit?: boolean;
  persisted?: Partial<PersistedSessionInfo>;
  outputReport?: boolean;
} = {}): Promise<Fixture> {
  const gh = github;
  const { host, sm, storeDir, outcomes, dispatches } = createManagerFixture(options.llmReplies ?? []);

  worktreeCounter += 1;
  const worktreePath = await createWorktree(gh.repoDir, `${SESSION_NAME}-${worktreeCounter}`);
  cleanups.push(() => removeTestWorktree(worktreePath));
  const branch = await getBranchName(worktreePath);
  assert.ok(branch, "the worktree has a branch");

  const commit = (file: string, content: string, message: string): string => {
    writeFileSync(join(worktreePath, file), content, "utf-8");
    git(worktreePath, "add", file);
    git(worktreePath, "commit", "-m", message);
    return git(worktreePath, "rev-parse", "HEAD");
  };
  if (options.commit !== false) commit("feature.txt", "feature flag on\n", "feat: add feature file");

  let outputPath: string | undefined;
  if (options.outputReport) {
    outputPath = join(storeDir, "output.txt");
    writeFileSync(outputPath, SESSION_REPORT, "utf-8");
  }
  const entry: PersistedSessionInfo = {
    sessionId: SESSION_ID,
    harnessSessionId: "h-pr-flow",
    backendRef: { kind: "codex-app-server", conversationId: "thread-pr-flow" },
    name: SESSION_NAME,
    prompt: "Add a feature file.",
    workdir: gh.repoDir,
    status: "completed",
    costUsd: 0,
    worktreePath,
    worktreeBranch: branch,
    worktreeStrategy: "ask",
    worktreeBaseBranch: "main",
    route: { provider: "telegram", target: "12345", sessionKey: "agent:main:telegram:group:12345" },
    ...(outputPath ? { outputPath } : {}),
    ...options.persisted,
  };
  sm["store"].replacePersistedSession(entry);

  return {
    gh,
    host,
    sm,
    worktreePath,
    branch,
    outcomes,
    dispatches,
    storeDir,
    persisted: () => sm.getPersistedSession(SESSION_ID),
    commit,
    async run(params = {}) {
      return await makeAgentPrTool().execute("call-1", { session: SESSION_NAME, ...params }) as AgentPrResult;
    },
  };
}

function textOf(result: AgentPrResult): string {
  return result.content.map((entry) => entry.text).join("\n");
}

function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("agent_pr execute(): new PRs", () => {
  it("revalidates canonical resolution after the awaited hook diff before decision dispatch", async () => {
    const f = await setup();
    mkdirSync(join(f.worktreePath, ".openclaw"));
    f.commit(".openclaw/worktree-setup.sh", "#!/bin/sh\ntrue\n", "add setup hook");
    const originalResolve = f.sm.resolve.bind(f.sm);
    let scheduled = false;
    f.sm.resolve = (ref) => {
      const selected = originalResolve(ref);
      if (ref === SESSION_ID && !scheduled) {
        scheduled = true;
        queueMicrotask(() => f.sm["sessions"].set("foreign-b", {
          id: "foreign-b", name: SESSION_ID, status: "running", startedAt: Date.now(),
        } as any));
      }
      return selected;
    };
    let escalated = false;
    f.sm.requestWorktreeDecisionFromUser = async () => { escalated = true; return "Decision queued"; };
    const result = await f.run();
    assert.equal(originalResolve(SESSION_ID)?.id, "foreign-b", "negative control: supported ref now resolves foreign live B");
    assert.equal(escalated, false);
    assert.equal((result as any).details?.code, "session_target_changed");
    assert.equal(f.gh.ghCalls("create").length, 0);
    f.sm["sessions"].delete("foreign-b");
  });

  it("escalates hook changes for captured A after the name alias moves to B during preparation", async () => {
    const f = await setup({ persisted: { worktreeBaseBranch: undefined } });
    mkdirSync(join(f.worktreePath, ".openclaw"));
    f.commit(".openclaw/worktree-setup.sh", "#!/bin/sh\ntrue\n", "add setup hook");
    const selectedA = f.persisted()!;
    const originalRead = f.sm.getPersistedSession.bind(f.sm);
    let scheduled = false;
    f.sm.getPersistedSession = (ref) => {
      const selected = originalRead(ref);
      if (ref === SESSION_NAME && !scheduled) {
        scheduled = true;
        queueMicrotask(() => f.sm["store"].replacePersistedSession({
          ...selectedA, sessionId: "foreign-b", harnessSessionId: "foreign-hb", createdAt: Date.now() + 1,
          worktreeBranch: "agent/foreign-b", route: { sessionKey: "foreign-route" },
        }));
      }
      return selected;
    };
    let escalated: string | undefined;
    f.sm.requestWorktreeDecisionFromUser = async (ref) => { escalated = ref; return "Decision queued"; };
    const result = await f.run();
    assert.equal(originalRead(SESSION_NAME)?.sessionId, "foreign-b", "negative control: alias actually moved");
    assert.equal(escalated, SESSION_ID);
    assert.deepEqual(result.meta, { success: false, state: "error" });
    assert.equal(f.gh.ghCalls("create").length, 0);
    assert.equal(originalRead("foreign-b")?.worktreePrUrl, undefined);
  });

  it("pushes the branch and opens a draft PR with LLM metadata from runtime.llm", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA], persisted: { status: "running" } });
    const head = git(f.worktreePath, "rev-parse", "HEAD");

    const result = await f.run();

    assert.deepEqual(result.meta, { success: true, state: "created", outcomeNotified: true });
    assert.equal(textOf(result), "ℹ️ [pr-flow] PR opened: https://github.com/acme/widget/pull/101");
    assert.equal(f.gh.remoteHead(f.branch), head, "the branch was pushed before the PR was opened");
    const [create] = f.gh.ghCalls("create");
    assert.ok(create);
    assert.ok(create.args.includes("--draft"), "PRs open as drafts by default");
    assert.equal(argAfter(create.args, "--base"), "main");
    assert.equal(argAfter(create.args, "--head"), f.branch);
    assert.equal(argAfter(create.args, "--title"), "Add the feature file");
    const body = argAfter(create.args, "--body") ?? "";
    assert.match(body, /^OpenClaw Code Agent session: pr-flow/);
    assert.match(body, /- Adds `feature\.txt`\./);
    assert.match(body, /## Commits\n- [0-9a-f]+ feat: add feature file \(OpenClaw Tests\)/);
    assert.ok(body.endsWith(GENERATED_FOOTER));

    assert.equal(f.host.llmCalls.length, 1);
    assert.equal(f.host.llmCalls[0]?.purpose, "openclaw-code-agent.pr-metadata");

    const pr = f.gh.readState().prs[0];
    assert.equal(pr?.isDraft, true);
    const persisted = f.persisted();
    assert.equal(persisted?.worktreePrUrl, "https://github.com/acme/widget/pull/101");
    assert.equal(persisted?.worktreePrNumber, 101);
    assert.equal(persisted?.worktreeDisposition, "pr-opened");
    assert.equal(persisted?.worktreeLifecycle?.state, "pr_open");

    assert.equal(f.outcomes.length, 1);
    assert.equal(f.outcomes[0]?.line, "ℹ️ [pr-flow] PR opened: https://github.com/acme/widget/pull/101");
    assert.equal(f.persisted()?.status, "running", "opening a PR does not finish execution");
    assert.deepEqual(f.outcomes[0]?.detailLines, [
      `Opened PR for branch ${f.branch} into main.`,
      "PR URL: https://github.com/acme/widget/pull/101.",
      "PR number: #101.",
    ]);
  });

  it("records the PR on the manager it started with when a Gateway stop clears the shared one mid-call", async () => {
    const f = await setup();
    // The Gateway stops while the PR metadata is generated: the shared reference is cleared.
    f.host.setLlmReplies([() => {
      setSessionManager(null);
      return LLM_METADATA;
    }]);

    const result = await f.run();

    assert.deepEqual(result.meta, { success: true, state: "created", outcomeNotified: true });
    assert.equal(f.persisted()?.worktreeLifecycle?.state, "pr_open");
    assert.equal(f.persisted()?.worktreePrNumber, 101);
  });

  it("falls back to deterministic metadata when runtime.llm fails", async () => {
    const f = await setup();

    const result = await f.run();

    assert.equal(result.meta.state, "created");
    assert.equal(f.host.llmCalls.length, 1, "the host model was asked first");
    const [create] = f.gh.ghCalls("create");
    assert.equal(argAfter(create!.args, "--title"), "OpenClaw agent changes: pr flow");
    assert.match(argAfter(create!.args, "--body") ?? "", /Deterministic fallback metadata generated because the LLM PR metadata provider failed/);
  });

  it("uses an explicit title and body without asking the model", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });

    const result = await f.run({ title: "Custom title", body: "Custom body" });

    assert.equal(result.meta.state, "created");
    assert.equal(f.host.llmCalls.length, 0);
    const [create] = f.gh.ghCalls("create");
    assert.equal(argAfter(create!.args, "--title"), "Custom title");
    assert.equal(argAfter(create!.args, "--body"), "Custom body");
    assert.equal(f.persisted()?.status, "completed");
    assert.match(f.outcomes[0]?.line ?? "", /^ℹ️ \[pr-flow\] PR opened:/);
  });

  it("retries without --draft when the repository has no draft PRs and says so", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    f.gh.updateState((state) => { state.failures.draftUnsupported = true; });

    const result = await f.run();

    assert.deepEqual(result.meta, { success: true, state: "created", outcomeNotified: true });
    assert.match(textOf(result), /Target repo does not support draft PRs; created as regular \(non-draft\) PR instead\./);
    const creates = f.gh.ghCalls("create");
    assert.equal(creates.length, 2);
    assert.equal(creates[1]?.args.includes("--draft"), false);
    assert.equal(f.gh.readState().prs[0]?.isDraft, false);
  });

  it("reports a gh failure without persisting a PR", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    f.gh.updateState((state) => { state.failures.create = "GraphQL: Resource not accessible by integration (createPullRequest)"; });

    const result = await f.run();

    assert.deepEqual(result.meta, { success: false, state: "error" });
    assert.equal(textOf(result), "❌ Failed to create PR: GraphQL: Resource not accessible by integration (createPullRequest)");
    // Only a draft-related gh error is retried without --draft: the failed
    // command line itself always contains `--draft`.
    assert.equal(f.gh.ghCalls("create").length, 1);
    assert.equal(f.persisted()?.worktreePrUrl, undefined);
    assert.equal(f.outcomes.length, 0);
  });

  it("describes a gh failure without stderr and never echoes the command or PR body", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    f.gh.updateState((state) => { state.failures.createSilent = true; });

    const result = await f.run();

    assert.deepEqual(result.meta, { success: false, state: "error" });
    assert.equal(textOf(result), "❌ Failed to create PR: gh exited with code 1 without an error message");
    assert.equal(f.gh.ghCalls("create").length, 1, "no draft retry without a draft-related gh error");
  });

  it("refuses to open a PR when the repo policy forbids PRs", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    await f.sm.setRepoPolicy(f.gh.repoDir, "never-pr");

    const result = await f.run();

    assert.deepEqual(result.meta, { success: false, state: "error" });
    assert.match(textOf(result), /Repo policy forbids PR creation/);
    assert.equal(f.gh.ghCalls("create").length, 0);
  });
});

describe("agent_pr execute(): existing open PRs", () => {
  it("comments on new commits and refreshes generated metadata through runtime.llm", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA], persisted: { status: "running" } });
    const seeded = f.gh.seedPr({
      headRefName: f.branch,
      title: "OpenClaw agent changes: pr flow",
      body: `Old generated body\n\n---\n${GENERATED_FOOTER}`,
    });

    const result = await f.run();

    assert.deepEqual(result.meta, { success: true, state: "pr_updated", outcomeNotified: true });
    const text = textOf(result);
    assert.match(text, new RegExp(`^ℹ️ \\[pr-flow\\] PR updated: ${seeded.url} \\(1 file, \\+1/-0\\)`));
    assert.match(text, /📝 Added comment detailing 1 new commit \(\+1 \/ -0\)/);
    assert.match(text, /📝 Refreshed PR title\/body from current OpenClaw metadata\./);

    const state = f.gh.readState();
    assert.equal(state.comments.length, 1);
    assert.match(state.comments[0]!.body, /🔄 \*\*New commits pushed\*\*/);
    assert.match(state.comments[0]!.body, /• [0-9a-f]+ feat: add feature file \(OpenClaw Tests\)/);
    assert.equal(state.prs[0]?.title, "Add the feature file");
    assert.match(state.prs[0]?.body ?? "", /- Adds `feature\.txt`\./);
    assert.equal(f.gh.ghCalls("create").length, 0);
    assert.equal(f.persisted()?.worktreePrUrl, seeded.url);
    assert.equal(f.persisted()?.worktreePrNumber, seeded.number);
    assert.equal(f.outcomes[0]?.line, `ℹ️ [pr-flow] PR updated: ${seeded.url} (1 file, +1/-0)`);
    assert.equal(f.persisted()?.status, "running");
  });

  it("refreshes an OCA fallback body from the session report when runtime.llm fails", async () => {
    const f = await setup({ outputReport: true });
    const seeded = f.gh.seedPr({
      headRefName: f.branch,
      title: "OpenClaw agent changes: pr flow",
      body: `Deterministic fallback metadata generated because no LLM PR metadata provider is configured.\n\n---\n${GENERATED_FOOTER}`,
    });

    const result = await f.run();

    assert.equal(result.meta.state, "pr_updated");
    assert.match(textOf(result), /Refreshed PR title\/body from current OpenClaw metadata/);
    const pr = f.gh.readState().prs.find((entry) => entry.number === seeded.number);
    assert.equal(pr?.title, "add feature file", "the fallback title comes from the commit subject");
    assert.match(pr?.body ?? "", /PR metadata generated from the coding agent's final session report\./);
    assert.match(pr?.body ?? "", /Added the feature file the task asked for\./);
  });

  it("keeps richer generated metadata when runtime.llm fails and there is no session report", async () => {
    const f = await setup();
    const body = `## Summary\n- Carefully written generated summary.\n\n---\n${GENERATED_FOOTER}`;
    f.gh.seedPr({ headRefName: f.branch, title: "Generated title", body });

    const result = await f.run();

    assert.equal(result.meta.state, "pr_updated");
    assert.match(textOf(result), /⚠️ PR metadata refresh failed: generated PR metadata was unavailable; preserved existing generated PR metadata/);
    assert.equal(f.gh.ghCalls("edit").length, 0);
    assert.equal(f.gh.readState().prs[0]?.body, body);
    assert.equal(f.gh.readState().comments.length, 1, "the new-commit comment is still added");
  });

  it("keeps a human-edited body and replaces only an explicitly passed title", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    f.gh.seedPr({ headRefName: f.branch, title: "Human title", body: "Written by a human." });

    const result = await f.run({ title: "Explicit title" });

    assert.equal(result.meta.state, "pr_updated");
    assert.match(textOf(result), /📝 Replaced PR title with the explicitly provided title\./);
    const pr = f.gh.readState().prs[0];
    assert.equal(pr?.title, "Explicit title");
    assert.equal(pr?.body, "Written by a human.");
    assert.equal(f.host.llmCalls.length, 0);
  });

  it("records a pushed open PR as updated when only the comment cannot be posted", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const seeded = f.gh.seedPr({ headRefName: f.branch, title: "Human title", body: "Written by a human." });
    f.gh.updateState((state) => { state.failures.comment = true; });

    const result = await f.run();

    // The push succeeded and the PR exists: state, buttons and the outcome line agree.
    assert.deepEqual(result.meta, { success: true, state: "pr_updated", outcomeNotified: true });
    assert.equal(f.outcomes.length, 1);
    const [outcomeLine, commentLine, ...rest] = (f.outcomes[0]?.line ?? "").split("\n");
    assert.ok(outcomeLine?.startsWith(`ℹ️ [pr-flow] PR updated: ${seeded.url}`), outcomeLine);
    assert.equal(commentLine, "⚠️ The PR comment could not be added.");
    assert.deepEqual(rest, []);
    assert.deepEqual(textOf(result).split("\n").slice(0, 2), [outcomeLine, commentLine]);
    assert.doesNotMatch(textOf(result), /Added comment/);
    assert.equal(f.persisted()?.worktreePrUrl, seeded.url, "the pushed PR is recorded as open");
    assert.equal(f.persisted()?.worktreeLifecycle?.state, "pr_open");
  });

  it("reports an open PR without new commits as up to date", async () => {
    const f = await setup({ commit: false });
    const seeded = f.gh.seedPr({ headRefName: f.branch, title: "Human title", body: "Written by a human." });

    const result = await f.run();

    assert.deepEqual(result.meta, { success: true, state: "pr_open" });
    assert.match(textOf(result), new RegExp(`ℹ️ \\[pr-flow\\] PR is up to date: ${seeded.url}\\n\\nNo new commits to push\\.`));
    assert.equal(f.gh.readState().comments.length, 0);
    assert.equal(f.persisted()?.worktreePrNumber, seeded.number);
  });

  it("refreshes metadata of a PR recorded for the session when update_metadata is set", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const seeded = f.gh.seedPr({ headRefName: f.branch, title: "Human title", body: "Written by a human." });
    f.sm.updatePersistedSession(SESSION_ID, { worktreePrUrl: seeded.url, worktreePrNumber: seeded.number });

    const result = await f.run({ update_metadata: true });

    assert.equal(result.meta.state, "pr_updated");
    const pr = f.gh.readState().prs[0];
    assert.equal(pr?.title, "Add the feature file", "update_metadata replaces even a human title");
    assert.match(pr?.body ?? "", /Adds `feature\.txt`/);
  });
});

describe("agent_pr execute(): merged, closed, and force_new", () => {
  it("records a merged PR and points at branch cleanup", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const seeded = f.gh.seedPr({ headRefName: f.branch, state: "MERGED" });

    const result = await f.run();

    assert.deepEqual(result.meta, { success: true, state: "merged" });
    assert.match(textOf(result), new RegExp(`ℹ️ \\[pr-flow\\] PR was already merged: ${seeded.url}`));
    const persisted = f.persisted();
    assert.equal(persisted?.worktreeDisposition, "merged");
    assert.equal(persisted?.worktreePrUrl, seeded.url);
    assert.equal(persisted?.worktreePrNumber, seeded.number);
    assert.equal(persisted?.worktreeLifecycle?.state, "merged");
    assert.equal(f.gh.ghCalls("create").length, 0);
  });

  it("asks what to do with a PR closed without merging", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const seeded = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });

    const result = await f.run();

    assert.deepEqual(result.meta, { success: false, state: "closed" });
    assert.match(textOf(result), new RegExp(`A PR exists but was closed without merging: ${seeded.url}`));
    assert.match(textOf(result), /agent_pr\(force_new=true\)/);
    assert.equal(f.gh.ghCalls("create").length, 0);
    // The row remembers it, so every later decision prompt offers New PR ...
    assert.equal(f.persisted()?.worktreePrClosed, true);
    // ... until a PR is open again.
    const fresh = await f.run({ force_new: true });
    assert.equal(fresh.meta.success, true);
    assert.equal(f.persisted()?.worktreePrClosed, undefined);
  });

  it("refuses force_new while an open PR exists for the branch", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const seeded = f.gh.seedPr({ headRefName: f.branch });

    const result = await f.run({ force_new: true });

    assert.deepEqual(result.meta, { success: false, state: "force_new_refused", prState: "open" });
    assert.match(textOf(result), new RegExp(`Cannot create new PR: A PR already exists for \`${f.branch}\` \\(open\\)\\.\\n\\nExisting PR: ${seeded.url}`));
    assert.equal(f.gh.ghCalls("create").length, 0);
  });

  it("opens a fresh PR with force_new when the session's recorded PR was closed", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const closed = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });
    f.sm.updatePersistedSession(SESSION_ID, { worktreePrUrl: closed.url, worktreePrNumber: closed.number });

    const result = await f.run({ force_new: true });

    assert.deepEqual(result.meta, { success: true, state: "created", outcomeNotified: true });
    const fresh = f.gh.readState().prs.find((pr) => pr.state === "OPEN");
    assert.ok(fresh && fresh.number !== closed.number);
    assert.equal(f.persisted()?.worktreePrUrl, fresh.url);
    assert.equal(f.persisted()?.worktreePrNumber, fresh.number);
  });

  it("opens a fresh PR with force_new when the branch's PR was closed without being recorded", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const closed = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });

    const result = await f.run({ force_new: true });

    assert.deepEqual(result.meta, { success: true, state: "created", outcomeNotified: true });
    const fresh = f.gh.readState().prs.find((pr) => pr.state === "OPEN");
    assert.ok(fresh && fresh.number !== closed.number);
    assert.equal(f.persisted()?.worktreePrUrl, fresh.url);
    assert.equal(f.gh.ghCalls("create").length, 1);
  });

  it("clears a stale closed-PR marker when the PR was reopened: force_new refuses without pushing and the buttons return to Sync PR", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA, LLM_METADATA] });
    const pr = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });
    f.sm.updatePersistedSession(SESSION_ID, { worktreePrUrl: pr.url, worktreePrNumber: pr.number });
    const prLabels = async (): Promise<string[]> => {
      const rows = await (f.sm as unknown as { getWorktreeDecisionButtons(id: string, options: { allowDelegate: boolean }): Promise<Array<Array<{ label: string }>>> })
        .getWorktreeDecisionButtons(SESSION_ID, { allowDelegate: true });
      return rows.flat().map((button) => button.label).filter((label) => /PR/.test(label));
    };

    assert.equal((await f.run()).meta.state, "closed");
    assert.equal(f.persisted()?.worktreePrClosed, true);
    assert.deepEqual(await prLabels(), ["New PR", "View PR"]);

    // The user reopens the PR on GitHub (option 1 of the tool text).
    f.gh.updateState((state) => { state.prs.find((candidate) => candidate.number === pr.number)!.state = "OPEN"; });
    const headBefore = f.gh.remoteHead(f.branch);

    // New PR / force_new cannot replace an open PR: refused before anything is pushed ...
    const refused = await f.run({ force_new: true });
    assert.deepEqual(refused.meta, { success: false, state: "force_new_refused", prState: "open" });
    assert.match(textOf(refused), /Cannot create new PR: A PR already exists for `[^`]+` \(open\)\./);
    assert.equal(f.gh.remoteHead(f.branch), headBefore, "nothing was pushed");
    assert.equal(f.gh.ghCalls("create").length, 0);
    // ... and the stale marker is gone, so the next prompts offer Sync PR again.
    assert.equal(f.persisted()?.worktreePrClosed, undefined);
    assert.deepEqual(await prLabels(), ["Sync PR", "View PR"]);

    // The plain PR action (what the New PR button falls back to) syncs the reopened PR.
    const synced = await f.run();
    assert.equal(synced.meta.success, true);
    assert.equal(f.persisted()?.worktreePrUrl, pr.url);
    assert.notEqual(f.gh.remoteHead(f.branch), "", "the branch was pushed for the sync");
  });

  for (const variant of ["open", "merged"] as const) {
    it(`a New PR press adopts the ${variant} PR that replaced the recorded closed one, in one message`, async () => {
      const f = await setup({ llmReplies: [LLM_METADATA, LLM_METADATA] });
      const first = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });
      f.sm.updatePersistedSession(SESSION_ID, { worktreePrUrl: first.url, worktreePrNumber: first.number, pendingWorktreeDecisionSince: new Date().toISOString() });
      const buttons = async (): Promise<Array<{ label: string; callbackData: string }>> => (await (f.sm as unknown as {
        getWorktreeDecisionButtons(id: string, options: { allowDelegate: boolean }): Promise<Array<Array<{ label: string; callbackData: string }>>>;
      }).getWorktreeDecisionButtons(SESSION_ID, { allowDelegate: true })).flat();
      const prLabels = async (): Promise<string[]> => (await buttons()).map((button) => button.label).filter((label) => /PR/.test(label));

      assert.equal((await f.run()).meta.state, "closed");
      assert.deepEqual(await prLabels(), ["New PR", "View PR"]);

      // On GitHub the user opens another PR from the same branch.
      const second = f.gh.seedPr({ headRefName: f.branch, state: variant === "open" ? "OPEN" : "MERGED" });
      assert.notEqual(second.url, first.url);

      // The New PR press, through the real button handler and the real tool.
      const newPr = (await buttons()).find((button) => button.label === "New PR")!;
      const replies: string[] = [];
      const outcomesBefore = f.outcomes.length;
      const ctx = buildCallbackContext("telegram", newPr.callbackData, { target: "12345", onReply: (text) => { replies.push(text); }, onClear: () => {} });
      assert.deepEqual(await createCallbackHandler().handler(ctx as never), { handled: true });

      // One message about the second PR, and the session now targets it.
      const lines = [...f.outcomes.slice(outcomesBefore).map((outcome) => outcome.line), ...replies];
      assert.equal(lines.length, 1, lines.join(" | "));
      assert.ok(lines[0]!.includes(second.url), lines[0]);
      assert.doesNotMatch(lines[0]!, /❌|closed without merging/);
      assert.equal(f.persisted()?.worktreePrUrl, second.url);
      assert.equal(f.persisted()?.worktreePrNumber, second.number);
      assert.equal(f.persisted()?.worktreePrClosed, undefined);
      assert.equal(f.gh.ghCalls("create").length, 0, "no third PR");
      if (variant === "open") {
        assert.match(lines[0]!, /PR (?:updated|is up to date)/);
        assert.deepEqual(await prLabels(), ["Sync PR", "View PR"]);
      } else {
        assert.match(lines[0]!, /PR was already merged: /);
        assert.equal(f.persisted()?.worktreeDisposition, "merged");
        assert.equal(f.persisted()?.worktreeLifecycle?.state, "merged");
      }
    });
  }

  it("looks up the branch's PR by base, then open, then newest, and never a fork's PR with the same branch name", async () => {
    const f = await setup({ commit: false });
    const { syncWorktreePR } = await import("../src/worktree");
    // An open PR wins over newer merged and closed ones; a fork's PR never counts.
    const open = f.gh.seedPr({ headRefName: f.branch, state: "OPEN" });
    f.gh.seedPr({ headRefName: f.branch, state: "MERGED" });
    f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });
    f.gh.seedPr({ headRefName: f.branch, state: "OPEN", headOwner: "someone-else" });
    assert.equal((await syncWorktreePR(f.gh.repoDir, f.branch)).url, open.url, "open first");

    // Without an open PR the newest counts: a closed PR on a reused branch, not the older merged one.
    f.gh.resetState();
    f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });
    f.gh.seedPr({ headRefName: f.branch, state: "MERGED" });
    const newestClosed = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });
    assert.equal((await syncWorktreePR(f.gh.repoDir, f.branch)).url, newestClosed.url, "the newest when none is open");
    f.gh.resetState();
    f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });
    const newestMerged = f.gh.seedPr({ headRefName: f.branch, state: "MERGED" });
    assert.equal((await syncWorktreePR(f.gh.repoDir, f.branch)).url, newestMerged.url);

    // The session's base branch: its own PR is not beaten by a newer, open PR into another base.
    f.gh.resetState();
    const intoMain = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED", baseRefName: "main" });
    const intoRelease = f.gh.seedPr({ headRefName: f.branch, state: "OPEN", baseRefName: "release" });
    assert.equal((await syncWorktreePR(f.gh.repoDir, f.branch, undefined, "main")).url, intoMain.url);
    assert.equal((await syncWorktreePR(f.gh.repoDir, f.branch, undefined, "release")).url, intoRelease.url);
    assert.equal((await syncWorktreePR(f.gh.repoDir, f.branch)).url, intoRelease.url, "no known base: open first");
    // With no PR into the session's base, the other one is still found.
    assert.equal((await syncWorktreePR(f.gh.repoDir, f.branch, undefined, "develop")).url, intoRelease.url);

    // Only a fork's PR uses the branch name: this repository has no PR for it,
    // so a force_new is not refused for it and nothing is adopted.
    f.gh.resetState();
    f.gh.seedPr({ headRefName: f.branch, state: "OPEN", headOwner: "someone-else" });
    assert.deepEqual(await syncWorktreePR(f.gh.repoDir, f.branch), { exists: false, state: "none" });

    // The repository's owner was renamed (or the repository transferred) and
    // origin still carries the old name: its own PR is not a fork's PR.
    f.gh.resetState();
    const renamed = f.gh.seedPr({ headRefName: f.branch, state: "OPEN", headOwner: "new-owner-name", isCrossRepository: false });
    assert.equal((await syncWorktreePR(f.gh.repoDir, f.branch)).url, renamed.url);
    f.gh.resetState();
    const mergedRenamed = f.gh.seedPr({ headRefName: f.branch, state: "MERGED", headOwner: "new-owner-name", isCrossRepository: false });
    assert.equal((await syncWorktreePR(f.gh.repoDir, f.branch)).state, "merged");
    assert.equal((await syncWorktreePR(f.gh.repoDir, f.branch)).url, mergedRenamed.url);
  });

  it("excludes a deleted fork's PR without a target repo, and keeps the strict owner check with one", async () => {
    const f = await setup({ commit: false });
    const { syncWorktreePR } = await import("../src/worktree");
    const orphan = (pr: { number: number }): void => f.gh.updateState((state) => {
      // A fork that was deleted: GitHub reports the PR as cross-repository with no head owner.
      Object.assign(state.prs.find((candidate) => candidate.number === pr.number)!, { headOwner: null, isCrossRepository: true });
    });

    orphan(f.gh.seedPr({ headRefName: f.branch, state: "OPEN" }));
    assert.deepEqual(await syncWorktreePR(f.gh.repoDir, f.branch), { exists: false, state: "none" });
    // The repository's own (older, closed) PR is found behind it.
    f.gh.resetState();
    const own = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });
    orphan(f.gh.seedPr({ headRefName: f.branch, state: "OPEN" }));
    assert.equal((await syncWorktreePR(f.gh.repoDir, f.branch)).url, own.url);

    // Fork → upstream (`targetRepo`): the head owner must be origin's owner, as before.
    f.gh.resetState();
    const upstream = "upstream-org/widget";
    const mine = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED", repo: upstream, headOwner: f.gh.owner, isCrossRepository: true });
    f.gh.seedPr({ headRefName: f.branch, state: "OPEN", repo: upstream, headOwner: "someone-else", isCrossRepository: true });
    orphan(f.gh.seedPr({ headRefName: f.branch, state: "OPEN", repo: upstream }));
    assert.equal((await syncWorktreePR(f.gh.repoDir, f.branch, upstream)).url, mine.url);
    // A same-named owner string is still required there: a renamed-owner PR does not match with a target repo.
    f.gh.resetState();
    f.gh.seedPr({ headRefName: f.branch, state: "OPEN", repo: upstream, headOwner: "new-owner-name", isCrossRepository: false });
    assert.deepEqual(await syncWorktreePR(f.gh.repoDir, f.branch, upstream), { exists: false, state: "none" });
  });

  it("the lifecycle resolver prefers the session's recorded PR, else the branch's PR into the recorded base", async () => {
    const f = await setup({ commit: false });
    const session = (worktreePrUrl: string | undefined) => ({
      workdir: f.gh.repoDir,
      worktreePath: f.worktreePath,
      worktreeBranch: f.branch,
      worktreeBaseBranch: "main",
      ...(worktreePrUrl ? { worktreePrUrl } : {}),
    });
    const pr = async (worktreePrUrl: string | undefined) => {
      const resolved = await resolveWorktreeLifecycle(session(worktreePrUrl), { includePrSync: true });
      return { url: resolved.evidence.prUrl, state: resolved.evidence.prState };
    };

    // The recorded PR is this branch's PR: it counts, although a newer open PR exists for the branch.
    const recorded = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });
    const newer = f.gh.seedPr({ headRefName: f.branch, state: "OPEN" });
    assert.deepEqual(await pr(recorded.url), { url: recorded.url, state: "closed" });
    // Nothing recorded: the branch lookup (open first).
    assert.deepEqual(await pr(undefined), { url: newer.url, state: "open" });

    // The recorded URL is another branch's PR, or is gone: the lookup, with the recorded base.
    f.gh.resetState();
    const intoMain = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED", baseRefName: "main" });
    f.gh.seedPr({ headRefName: f.branch, state: "OPEN", baseRefName: "release" });
    const otherBranch = f.gh.seedPr({ headRefName: "another-branch", state: "OPEN" });
    assert.deepEqual(await pr(otherBranch.url), { url: intoMain.url, state: "closed" });
    assert.deepEqual(await pr(`https://github.com/${f.gh.owner}/${f.gh.repo}/pull/999`), { url: intoMain.url, state: "closed" });
  });

  it("agent_pr picks the branch's PR by base: explicit base_branch, then the session's recorded base, then the default branch", async () => {
    const seed = async (recordedBase: string | undefined) => {
      const f = await setup({ llmReplies: [LLM_METADATA, LLM_METADATA], persisted: { worktreeBaseBranch: recordedBase } });
      // A stacked session: PRs from its branch into the default branch and into the branch it is stacked on.
      const intoMain = f.gh.seedPr({ headRefName: f.branch, state: "OPEN", baseRefName: "main" });
      const intoParent = f.gh.seedPr({ headRefName: f.branch, state: "OPEN", baseRefName: "agent/parent-session" });
      return { f, intoMain, intoParent };
    };

    // The session's recorded base (the parent session's branch) decides, not the newest PR or the default branch.
    const stacked = await seed("agent/parent-session");
    assert.equal((await stacked.f.run()).meta.success, true);
    assert.equal(stacked.f.persisted()?.worktreePrUrl, stacked.intoParent.url);
    const stackedOnMain = await seed("main");
    assert.equal((await stackedOnMain.f.run()).meta.success, true);
    assert.equal(stackedOnMain.f.persisted()?.worktreePrUrl, stackedOnMain.intoMain.url);

    // An explicit base_branch overrides the recorded base for that call.
    const explicit = await seed("agent/parent-session");
    assert.equal((await explicit.f.run({ base_branch: "main" })).meta.success, true);
    assert.equal(explicit.f.persisted()?.worktreePrUrl, explicit.intoMain.url);

    // No recorded base: the detected default branch.
    const unrecorded = await seed(undefined);
    assert.equal((await unrecorded.f.run()).meta.success, true);
    assert.equal(unrecorded.f.persisted()?.worktreePrUrl, unrecorded.intoMain.url);
  });

  it("uses the session's recorded base for the whole call: a stacked session's first PR goes into the branch it is stacked on", async () => {
    const parent = "agent/parent-session";
    const f = await setup({ llmReplies: [LLM_METADATA], persisted: { worktreeBaseBranch: parent } });
    // The parent session's branch holds the first commit; this session added one on top.
    git(f.gh.repoDir, "branch", parent, f.branch);
    try {
      f.commit("stacked.txt", "stacked change\n", "feat: stacked change");

      const result = await f.run();

      assert.deepEqual(result.meta, { success: true, state: "created", outcomeNotified: true });
      const created = f.gh.readState().prs.at(-1)!;
      assert.equal(created.baseRefName, parent, "created into the recorded base, not the default branch");
      assert.equal(f.persisted()?.worktreePrUrl, created.url);
      assert.deepEqual(f.outcomes.at(-1)?.detailLines?.[0], `Opened PR for branch ${f.branch} into ${parent}.`);
      // The change summary is taken against that base: only the stacked commit, not the parent's.
      const evidence = JSON.stringify(f.host.llmCalls[0]);
      assert.match(evidence, /feat: stacked change/);
      assert.doesNotMatch(evidence, /feat: add feature file/);
    } finally {
      git(f.gh.repoDir, "branch", "-D", parent);
    }
  });

  it("still updates a recorded open PR into the default branch for a session with another recorded base", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA], persisted: { worktreeBaseBranch: "main" } });
    const intoMain = f.gh.seedPr({ headRefName: f.branch, state: "OPEN", baseRefName: "main" });
    f.sm.updatePersistedSession(SESSION_ID, { worktreePrUrl: intoMain.url, worktreePrNumber: intoMain.number, worktreeBaseBranch: "release" });
    // The recorded base already contains the session's commit: against it there is nothing new,
    // against the PR's own base (main) there is one commit.
    git(f.gh.repoDir, "branch", "release", f.branch);
    try {
      const result = await f.run();

      assert.equal(result.meta.success, true);
      assert.equal(f.gh.ghCalls("create").length, 0, "the recorded PR is updated, no second PR is opened");
      assert.equal(f.persisted()?.worktreePrUrl, intoMain.url);
      assert.notEqual(f.gh.remoteHead(f.branch), "", "the branch was pushed for the update");
      // Everything said, counted and recorded about the PR uses the PR's own base, not the session's.
      assert.equal(result.meta.state, "pr_updated", "one new commit against main");
      assert.match(textOf(result), /1 new commit/);
      assert.equal(f.outcomes.at(-1)?.detailLines?.[0], `Updated PR for branch ${f.branch} into main.`);
      assert.equal(f.persisted()?.worktreeLifecycle?.baseBranch, "main");
      assert.equal(f.gh.readState().prs.find((pr) => pr.number === intoMain.number)?.baseRefName, "main", "the PR is not retargeted");

      // An explicit base that differs from the open PR's base does not retarget it either: the PR is updated as it is.
      f.commit("more.txt", "more\n", "feat: more");
      const explicit = await f.run({ base_branch: "release" });
      assert.equal(explicit.meta.success, true);
      assert.equal(f.gh.ghCalls("create").length, 0);
      assert.equal(f.outcomes.at(-1)?.detailLines?.[0], `Updated PR for branch ${f.branch} into main.`);
      assert.equal(f.persisted()?.worktreeLifecycle?.baseBranch, "main");
    } finally {
      git(f.gh.repoDir, "branch", "-D", "release");
    }
  });

  it("a recorded PR that merged into the default branch resolves the session against that branch, not the session's recorded base", async () => {
    const f = await setup({ persisted: { worktreeBaseBranch: "main" } });
    const intoMain = f.gh.seedPr({ headRefName: f.branch, state: "MERGED", baseRefName: "main" });
    f.sm.updatePersistedSession(SESSION_ID, { worktreePrUrl: intoMain.url, worktreePrNumber: intoMain.number, worktreeBaseBranch: "release" });
    const mainBefore = git(f.gh.repoDir, "rev-parse", "main");
    git(f.gh.repoDir, "branch", "release", "main");
    try {
      const result = await f.run();
      assert.equal(result.meta.state, "merged");
      // The base the PR was merged into is the base the session landed on.
      assert.equal(f.persisted()?.worktreeLifecycle?.state, "merged");
      assert.equal(f.persisted()?.worktreeLifecycle?.baseBranch, "main");

      // Until the merge is fetched locally the worktree is kept ...
      const beforePull = await resolveWorktreeLifecycle(f.persisted()!, { includePrSync: true });
      assert.ok(beforePull.reasons.includes("pr_merged_not_reflected_locally"), beforePull.reasons.join(","));
      // ... and once the default branch has the content it is no longer preserved,
      // although the session's recorded base (release) never gets it.
      git(f.gh.repoDir, "merge", "--no-edit", f.branch);
      const afterPull = await resolveWorktreeLifecycle(f.persisted()!, { includePrSync: true });
      assert.equal(afterPull.reasons.includes("pr_merged_not_reflected_locally"), false, afterPull.reasons.join(","));
      assert.equal(afterPull.preserve, false);
      assert.equal(afterPull.cleanupSafe, true);
    } finally {
      git(f.gh.repoDir, "reset", "--hard", mainBefore);
      git(f.gh.repoDir, "branch", "-D", "release");
    }
  });

  it("a base fixed by an existing PR is the session's landing base for the status tool and a bare agent_merge", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA], persisted: { worktreeBaseBranch: undefined } });
    await f.sm.setRepoPolicy(f.gh.repoDir, "pr-allowed");
    const mainBefore = git(f.gh.repoDir, "rev-parse", "main");
    git(f.gh.repoDir, "branch", "release", "main");
    try {
      // No recorded base: the PR is opened into the base this call names.
      const opened = await f.run({ base_branch: "release" });
      assert.equal(opened.meta.state, "created");
      assert.equal(f.gh.readState().prs.at(-1)?.baseRefName, "release");
      assert.equal(f.persisted()?.worktreeLifecycle?.baseBranch, "release");
      assert.equal(await resolveLandingBaseBranch(f.persisted(), f.gh.repoDir), "release");
      assert.equal(await resolveLandingBaseBranch(f.persisted(), f.gh.repoDir, "main"), "main", "an explicit base still wins");

      const status = await makeAgentWorktreeStatusTool().execute("call-status", { session: SESSION_NAME }) as { content: Array<{ text: string }> };
      const statusText = status.content.map((entry) => entry.text).join("\n");
      assert.ok(statusText.includes(`${f.branch} → release`), statusText);

      // A bare merge goes where the PR goes.
      git(f.gh.repoDir, "switch", "release");
      const merged = await makeAgentMergeTool().execute("call-merge", { session: SESSION_NAME }) as { content: Array<{ text: string }> };
      const text = merged.content.map((entry) => entry.text).join("\n");
      assert.match(text, /Merged: `[^`]+` → `release`/, text);
      assert.equal(git(f.gh.repoDir, "rev-parse", "main"), mainBefore, "the default branch is untouched");
    } finally {
      git(f.gh.repoDir, "switch", "main");
      git(f.gh.repoDir, "reset", "--hard", mainBefore);
      git(f.gh.repoDir, "branch", "-D", "release");
    }
  });

  it("a maintenance pass asks GitHub for no branch lookups for resolved sessions, and for one per repository and branch otherwise", async () => {
    const f = await setup({ commit: false });
    const merged = f.gh.seedPr({ headRefName: f.branch, state: "MERGED" });
    const base = f.persisted()!;
    const now = new Date().toISOString();
    for (const index of [1, 2, 3]) {
      f.sm["store"].replacePersistedSession({
        ...base,
        sessionId: `s-resolved-${index}`,
        harnessSessionId: `h-resolved-${index}`,
        backendRef: { kind: "codex-app-server", conversationId: `thread-resolved-${index}` },
        name: `resolved-${index}`,
        worktreePrUrl: merged.url,
        worktreePrNumber: merged.number,
        worktreeMerged: true,
        worktreeLifecycle: { state: "merged", updatedAt: now, resolvedAt: now, baseBranch: "main" },
      } as PersistedSessionInfo);
    }
    const maintenance = (f.sm as unknown as { maintenance: { bootstrapMaintenanceSchedules(): void; whenIdle(): Promise<void> } }).maintenance;
    const prCalls = (subcommand: string): number => f.gh.ghCalls().filter((call) => call.args[0] === "pr" && call.args[1] === subcommand).length;
    await maintenance.whenIdle();

    let lists = prCalls("list");
    let views = prCalls("view");
    maintenance.bootstrapMaintenanceSchedules();
    await maintenance.whenIdle();
    // (The sessions are resolved concurrently and the fake gh records its calls with
    // a read-modify-write of one file, so a count can be short, never long.)
    assert.equal(prCalls("list") - lists, 0, "a merged recorded PR needs no branch lookup");
    assert.ok(prCalls("view") - views >= 1 && prCalls("view") - views <= 3, "at most one read of the recorded PR per session");

    // Closed recorded PRs with a worktree left: the open-PR check is needed, once for the shared repository and branch.
    f.gh.updateState((state) => { state.prs.find((pr) => pr.number === merged.number)!.state = "CLOSED"; });
    lists = prCalls("list");
    views = prCalls("view");
    maintenance.bootstrapMaintenanceSchedules();
    await maintenance.whenIdle();
    assert.ok(prCalls("list") - lists <= 1, "one branch lookup for three sessions of one branch, not three");
    assert.ok(prCalls("view") - views <= 3);
    // The lookup did run: each of the three sessions was resolved with its result.
    const lookups = new Map<string, Promise<unknown>>();
    for (const index of [1, 2, 3]) {
      await resolveWorktreeLifecycle(f.sm.getPersistedSession(`s-resolved-${index}`)!, { includePrSync: true, prLookups: lookups as never });
    }
    assert.equal(lookups.size, 1, "three sessions of one repository and branch share one lookup");
  });

  it("trusts a recorded PR of the repository after its owner was renamed", async () => {
    const f = await setup({ commit: false });
    resetCanonicalRepoNamesForTests();
    try {
      // origin still names the old owner; GitHub answers with the new one.
      f.gh.updateState((state) => { state.canonicalRepo = `new-acme/${f.gh.repo}`; });
      const recorded = f.gh.seedPr({
        headRefName: f.branch,
        state: "MERGED",
        url: `https://github.com/new-acme/${f.gh.repo}/pull/4242`,
        number: 4242,
        headOwner: "new-acme",
        isCrossRepository: false,
      });
      // The branch was reused: a newer PR was closed without merging.
      f.gh.seedPr({ headRefName: f.branch, state: "CLOSED", number: 4243 });
      const session = { workdir: f.gh.repoDir, worktreePath: f.worktreePath, worktreeBranch: f.branch, worktreeBaseBranch: "main", worktreePrUrl: recorded.url };

      const resolved = await resolveWorktreeLifecycle(session, { includePrSync: true });
      assert.equal(resolved.evidence.prUrl, recorded.url);
      assert.equal(resolved.evidence.prState, "merged", "the merged state of the recorded PR is not lost");
      // The canonical name is asked once per checkout.
      const repoViews = (): number => f.gh.ghCalls().filter((call) => call.args[0] === "repo").length;
      const asked = repoViews();
      await resolveWorktreeLifecycle(session, { includePrSync: true });
      assert.equal(repoViews(), asked);
      assert.equal(asked, 1);
    } finally {
      resetCanonicalRepoNamesForTests();
    }
  });

  it("recovers from gh's own duplicate check, and a second PR into another base is a new PR", async () => {
    const f = await setup();
    const { createPR, pushBranch } = await import("../src/worktree");
    assert.equal(await pushBranch(f.gh.repoDir, f.branch), true);
    const intoMain = f.gh.seedPr({ headRefName: f.branch, state: "OPEN", baseRefName: "main" });

    // gh refuses before the request: `a pull request for branch "X" into branch "Y" already exists:`.
    const reused = await createPR(f.gh.repoDir, f.branch, "main", "Title", "Body");
    assert.equal(reused.success, true);
    assert.equal(reused.prUrl, intoMain.url);
    assert.match((reused.warnings ?? []).join(" "), /reused the existing open PR/);

    // GitHub allows one open PR per head and base: another base is a new PR.
    const second = await createPR(f.gh.repoDir, f.branch, "release", "Title", "Body");
    assert.equal(second.success, true);
    assert.notEqual(second.prUrl, intoMain.url);
    assert.equal(f.gh.readState().prs.find((candidate) => candidate.url === second.prUrl)?.baseRefName, "release");
  });

  it("the lifecycle resolver preserves a worktree while any PR of its branch is open, and trusts a recorded URL only for this repository", async () => {
    const f = await setup({ commit: false });
    const session = (worktreePrUrl: string) => ({
      workdir: f.gh.repoDir,
      worktreePath: f.worktreePath,
      worktreeBranch: f.branch,
      worktreeBaseBranch: "main",
      worktreePrUrl,
    });

    // The recorded PR was closed; someone opened another PR from the branch by hand.
    const recorded = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });
    const byHand = f.gh.seedPr({ headRefName: f.branch, state: "OPEN" });
    const withOpen = await resolveWorktreeLifecycle(session(recorded.url), { includePrSync: true });
    // Actions still follow the recorded PR ...
    assert.equal(withOpen.evidence.prUrl, recorded.url);
    assert.equal(withOpen.evidence.prState, "closed");
    // ... but the worktree is kept while a PR of the branch is open.
    assert.equal(withOpen.preserve, true);
    assert.equal(withOpen.cleanupSafe, false);
    assert.ok(withOpen.reasons.includes("branch_pr_open"), withOpen.reasons.join(","));
    // One `gh pr view` for the recorded URL per call, also when both places that need
    // it run: with the repository on a third branch the resolver also asks whether
    // that branch represents the recorded PR.
    const prViews = (): number => f.gh.ghCalls().filter((call) => call.args[0] === "pr" && call.args[1] === "view").length;
    git(f.gh.repoDir, "switch", "-c", "scratch-branch");
    try {
      const views = prViews();
      await resolveWorktreeLifecycle(session(recorded.url), { includePrSync: true });
      assert.equal(prViews(), views + 1);
    } finally {
      git(f.gh.repoDir, "switch", "main");
      git(f.gh.repoDir, "branch", "-D", "scratch-branch");
    }

    // Open-ness is decided over every PR of the branch, into whatever base: the
    // lookup prefers the closed PR into the session's base, yet the open one into
    // another base still keeps the worktree.
    f.gh.resetState();
    const closedRecorded = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED", baseRefName: "main" });
    f.gh.seedPr({ headRefName: f.branch, state: "OPEN", baseRefName: "release" });
    f.gh.seedPr({ headRefName: f.branch, state: "CLOSED", baseRefName: "main" });
    const acrossBases = await resolveWorktreeLifecycle(session(closedRecorded.url), { includePrSync: true });
    assert.equal(acrossBases.evidence.prState, "closed");
    assert.equal(acrossBases.preserve, true);
    assert.ok(acrossBases.reasons.includes("branch_pr_open"), acrossBases.reasons.join(","));
    // No recorded PR: the same rule.
    const unrecorded = await resolveWorktreeLifecycle({ ...session(closedRecorded.url), worktreePrUrl: undefined }, { includePrSync: true });
    assert.equal(unrecorded.preserve, true);
    f.gh.resetState();
    f.gh.seedPr({ headRefName: f.branch, state: "CLOSED", number: recorded.number, url: recorded.url });
    f.gh.seedPr({ headRefName: f.branch, state: "OPEN", number: byHand.number, url: byHand.url });

    f.gh.updateState((state) => { state.prs.find((candidate) => candidate.number === byHand.number)!.state = "CLOSED"; });
    const withoutOpen = await resolveWorktreeLifecycle(session(recorded.url), { includePrSync: true });
    assert.equal(withoutOpen.reasons.includes("branch_pr_open"), false);
    assert.equal(withoutOpen.reasons.includes("pr_open"), false);

    // A recorded URL of another repository's PR with the same branch name is not this branch's PR.
    f.gh.resetState();
    const own = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });
    const foreign = f.gh.seedPr({ headRefName: f.branch, state: "OPEN", repo: "other-org/other-repo", headOwner: "other-org", isCrossRepository: false });
    const resolved = await resolveWorktreeLifecycle(session(foreign.url), { includePrSync: true });
    assert.equal(resolved.evidence.prUrl, own.url);
    assert.equal(resolved.evidence.prState, "closed");
    assert.equal(resolved.reasons.includes("pr_open"), false);
    // A fork's PR (cross-repository, another owner) recorded by URL is not trusted either.
    f.gh.resetState();
    const ownAgain = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });
    const fork = f.gh.seedPr({ headRefName: f.branch, state: "OPEN", headOwner: "someone-else" });
    const forkResolved = await resolveWorktreeLifecycle(session(fork.url), { includePrSync: true });
    assert.equal(forkResolved.evidence.prUrl, ownAgain.url);
  });

  it("an \"already exists\" recovery reuses only the open PR into the base that was asked for", async () => {
    const f = await setup({ commit: false });
    const { createPR } = await import("../src/worktree");
    f.gh.updateState((state) => { state.failures.create = "GraphQL: A pull request already exists for this branch. (createPullRequest)"; });

    // Only a PR into another base exists: it is not "the existing PR".
    const intoRelease = f.gh.seedPr({ headRefName: f.branch, state: "OPEN", baseRefName: "release" });
    const refused = await createPR(f.gh.repoDir, f.branch, "main", "Title", "Body");
    assert.equal(refused.success, false);
    assert.equal(refused.prUrl, undefined);
    assert.doesNotMatch(refused.error ?? "", new RegExp(intoRelease.url));
    assert.match(refused.error ?? "", /already exists/);

    // The PR into the requested base is reused, also when a newer one into another base exists.
    const intoMain = f.gh.seedPr({ headRefName: f.branch, state: "OPEN", baseRefName: "main" });
    f.gh.seedPr({ headRefName: f.branch, state: "OPEN", baseRefName: "hotfix" });
    const reused = await createPR(f.gh.repoDir, f.branch, "main", "Title", "Body");
    assert.equal(reused.success, true);
    assert.equal(reused.prUrl, intoMain.url);
    assert.match((reused.warnings ?? []).join(" "), /reused the existing open PR/);
  });

  it("the parent-branch lookup finds the parent's PR into the session's base behind a newer one into another base", async () => {
    const f = await setup({ commit: false });
    const parent = "agent/parent-session";
    git(f.gh.repoDir, "switch", "-c", parent);
    try {
      const matching = f.gh.seedPr({ headRefName: parent, state: "OPEN", baseRefName: "main" });
      f.gh.seedPr({ headRefName: parent, state: "OPEN", baseRefName: "release" });
      const args = { repoDir: f.gh.repoDir, worktreeBranch: f.branch, expectedParentBranch: parent };

      assert.equal((await discoverExistingTargetPr({ ...args, baseBranch: "main" }))?.url, matching.url);
      // No PR of the parent into that base: nothing is discovered.
      assert.equal(await discoverExistingTargetPr({ ...args, baseBranch: "develop" }), undefined);
    } finally {
      git(f.gh.repoDir, "switch", "main");
      git(f.gh.repoDir, "branch", "-D", parent);
    }
  });

  it("never adopts a PR the session did not record unless it was found by the session's branch", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    // The recorded PR itself is open: force_new is refused and the record is unchanged.
    const recorded = f.gh.seedPr({ headRefName: f.branch });
    f.gh.seedPr({ headRefName: "someone-elses-branch" });
    f.sm.updatePersistedSession(SESSION_ID, { worktreePrUrl: recorded.url, worktreePrNumber: recorded.number });

    const result = await f.run({ force_new: true });

    assert.deepEqual(result.meta, { success: false, state: "force_new_refused", prState: "open" });
    assert.equal(f.persisted()?.worktreePrUrl, recorded.url);
    assert.equal(f.persisted()?.worktreePrNumber, recorded.number);
  });

  it("does not push the branch when force_new meets an unrecorded open PR", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    f.gh.seedPr({ headRefName: f.branch });
    const headBefore = f.gh.remoteHead(f.branch);

    const result = await f.run({ force_new: true });

    assert.deepEqual(result.meta, { success: false, state: "force_new_refused", prState: "open" });
    assert.equal(f.gh.remoteHead(f.branch), headBefore, "nothing was pushed before the refusal");
  });

  it("still refuses force_new when the session's recorded PR was merged", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const merged = f.gh.seedPr({ headRefName: f.branch, state: "MERGED" });
    f.sm.updatePersistedSession(SESSION_ID, { worktreePrUrl: merged.url, worktreePrNumber: merged.number });

    const result = await f.run({ force_new: true });

    assert.deepEqual(result.meta, { success: false, state: "force_new_refused", prState: "merged" });
    assert.match(textOf(result), /Cannot create new PR: A PR already exists for `[^`]+` \(merged\)\./);
    assert.equal(f.gh.ghCalls("create").length, 0, "a merged PR is never replaced");
    assert.equal(f.persisted()?.worktreePrUrl, merged.url);
  });

  it("still refuses force_new while a merged PR exists for the branch", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const merged = f.gh.seedPr({ headRefName: f.branch, state: "MERGED" });

    const result = await f.run({ force_new: true });

    assert.deepEqual(result.meta, { success: false, state: "force_new_refused", prState: "merged" });
    assert.match(textOf(result), new RegExp(`Cannot create new PR: A PR already exists for \`${f.branch}\` \\(merged\\)\\.\\n\\nExisting PR: ${merged.url}`));
    assert.equal(f.gh.ghCalls("create").length, 0);
  });

  it("refuses to open a sibling PR when the recorded PR cannot be resolved", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    f.sm.updatePersistedSession(SESSION_ID, { worktreePrUrl: "https://github.com/acme/widget/pull/999" });

    const result = await f.run();

    assert.deepEqual(result.meta, { success: false, state: "error" });
    assert.match(textOf(result), /pull\/999, but that PR could not be resolved\. Refusing to create a sibling PR/);
    assert.equal(f.gh.ghCalls("create").length, 0);
  });
});

describe("gh PR helpers", () => {
  it("updatePRTitle and commentOnPR target the given repository and report failures", async () => {
    const f = await setup({ commit: false });
    const pr = f.gh.seedPr({ headRefName: f.branch, title: "Before" });

    assert.equal(await updatePRTitle(f.gh.repoDir, pr.number, "After", "acme/widget"), true);
    assert.equal(await commentOnPR(f.gh.repoDir, pr.number, "Looks good", "acme/widget"), true);
    const state = f.gh.readState();
    assert.equal(state.prs[0]?.title, "After");
    assert.deepEqual(state.comments, [{ number: pr.number, body: "Looks good", repo: "acme/widget" }]);
    const edit = f.gh.ghCalls("edit")[0];
    assert.deepEqual(edit?.args, ["pr", "edit", String(pr.number), "--title", "After", "--repo", "acme/widget"]);
    assert.deepEqual(f.gh.ghCalls("comment")[0]?.args, ["pr", "comment", String(pr.number), "--body", "Looks good", "--repo", "acme/widget"]);

    f.gh.updateState((next) => { next.failures.editTitle = true; next.failures.comment = true; });
    assert.equal(await updatePRTitle(f.gh.repoDir, pr.url, "Again"), false);
    assert.equal(await commentOnPR(f.gh.repoDir, pr.number, "Again"), false);
    assert.equal(f.gh.readState().prs[0]?.title, "After");
  });
});

describe("worktree outcome completion", () => {
  for (const status of ["completed", "failed"] as const) {
    for (const resolved of ["pr_open", "merged"] as const) {
      it(`emits ${status} once after an earlier PR milestone resolves the worktree as ${resolved}`, async () => {
        const f = await setup({ persisted: { status: "running" } });
        await f.run({ title: "Feature", body: "Adds a feature." });
        assert.match(f.outcomes[0]?.line ?? "", /^ℹ️ /);
        const session = createStubSession({
          ...f.persisted(), id: SESSION_ID, status, worktreeState: resolved,
          worktreeLifecycle: { state: resolved }, worktreeMerged: resolved === "merged",
          originalWorkdir: f.gh.repoDir, workdir: f.worktreePath,
          startedAt: Date.now() - 60_000, duration: 60_000,
          error: status === "failed" ? "QA failed" : undefined,
          getOutput: () => ["Execution finished; acceptance remains separate."],
        });
        await f.sm["onSessionTerminal"](session);
        await f.sm["onSessionTerminal"](session);
        assert.equal(f.dispatches.length, 1);
        assert.equal(f.dispatches[0]?.label, status);
        assert.match(f.dispatches[0]?.userMessage ?? "", status === "completed" ? /^✅ \[pr-flow\] Completed/ : /QA failed/);
        assert.equal(f.outcomes.length, 1, "no repeated worktree milestone");
      });
    }
  }

  for (const killReason of ["user", "idle-timeout"] as const) {
    for (const resolved of ["pr_open", "merged"] as const) {
      it(`reports a ${killReason} stop after an earlier PR milestone resolved the worktree as ${resolved}`, async () => {
        const f = await setup({ persisted: { status: "running" } });
        await f.run({ title: "Feature", body: "Adds a feature." });
        assert.match(f.outcomes[0]?.line ?? "", /^ℹ️ /);
        const session = createStubSession({
          ...f.persisted(), id: SESSION_ID, status: "killed", killReason, worktreeState: resolved,
          worktreeLifecycle: { state: resolved }, worktreeMerged: resolved === "merged",
          originalWorkdir: f.gh.repoDir, workdir: f.worktreePath,
          startedAt: Date.now() - 60_000, duration: 60_000,
          getOutput: () => ["Stopped before finishing."],
        });
        await f.sm["onSessionTerminal"](session);
        assert.equal(f.dispatches.length, 1);
        if (killReason === "idle-timeout") {
          assert.equal(f.dispatches[0]?.label, "suspended");
          assert.match(f.dispatches[0]?.userMessage ?? "", /^💤 \[pr-flow\] Suspended after idle timeout/);
        } else {
          assert.match(f.dispatches[0]?.userMessage ?? "", /^⛔ \[pr-flow\] Stopped by user/);
        }
        assert.equal(f.outcomes.length, 1, "no repeated worktree milestone");
      });
    }
  }

  /** Finish the fixture session through the real terminal path with the given strategy. */
  async function completeSession(f: Fixture, strategy: "ask" | "delegate" | "auto-merge" | "auto-pr") {
    f.sm.updatePersistedSession(SESSION_ID, { worktreeStrategy: strategy });
    const session = createStubSession({
      ...f.persisted(), id: SESSION_ID, status: "completed", phase: "implementing",
      originalWorkdir: f.gh.repoDir, workdir: f.worktreePath,
      startedAt: Date.now() - 60_000, duration: 60_000,
      worktreeStrategy: strategy,
      getOutput: () => ["Finished."],
    });
    await f.sm["onSessionTerminal"](session);
    await f.sm["onSessionTerminal"](session);
    return session;
  }
  const checkmarks = (f: Fixture): string[] => [
    ...f.dispatches.map((request) => request.userMessage ?? ""),
    ...f.outcomes.map((outcome) => outcome.line),
  ].filter((text) => text.startsWith("✅"));
  /** A fake GitHub of its own: merging changes main. */
  function isolateGitHub(): void {
    const previousGitHub = github;
    github = createFakeGitHub();
    cleanups.push(() => { github.dispose(); github = previousGitHub; });
  }
  const runMerge = async (): Promise<string> => {
    const result = await makeAgentMergeTool().execute("call-merge", { session: SESSION_NAME }) as { content: Array<{ text: string }> };
    return result.content.map((entry) => entry.text).join("\n");
  };

  it("sends a delegate completion to the user once, with the delegate wake as the only orchestrator wake", async () => {
    const f = await setup();
    await f.sm.setRepoPolicy(f.gh.repoDir, "pr-allowed");
    const session = await completeSession(f, "delegate");

    const completed = f.dispatches.filter((request) => request.label === "completed");
    assert.equal(completed.length, 1);
    assert.match(completed[0]?.userMessage ?? "", /^✅ \[pr-flow\] Completed/);
    assert.equal(completed[0]?.notifyUser, "always");
    assert.equal(completed[0]?.wakeMessage, undefined);
    assert.equal(completed[0]?.wakeMessageOnNotifySuccess, undefined);
    assert.equal(completed[0]?.wakeMessageOnNotifyFailed, undefined);
    assert.equal(completed[0]?.completionWakeSummaryRequired, false);
    const delegateWakes = f.dispatches.filter((request) => request.label === "worktree-delegate");
    assert.ok(delegateWakes.length >= 1);
    assert.equal(new Set(delegateWakes.map((request) => request.idempotencyKey)).size, 1, "one delegate wake identity");
    assert.equal(delegateWakes[0]?.notifyUser, "never");
    assert.ok(delegateWakes[0]?.wakeMessage);
    assert.deepEqual([...new Set(f.dispatches.map((request) => request.label))], ["worktree-delegate", "completed"]);

    // A manual PR afterwards is a milestone, and a PR update too.
    const result = await f.run({ title: "Feature", body: "Adds a feature." });
    assert.deepEqual(result.meta, { success: true, state: "created", outcomeNotified: true });
    assert.match(f.outcomes[0]?.line ?? "", /^ℹ️ \[pr-flow\] PR opened: /);
    Object.assign(session, { worktreeState: "pr_open", worktreeLifecycle: { state: "pr_open" } });
    await f.sm["onSessionTerminal"](session);
    assert.equal(checkmarks(f).length, 1, "exactly one ✅ for the terminal cycle");
  });

  it("reports a manual merge after a delegate completion as a milestone", async () => {
    isolateGitHub();
    const f = await setup();
    await f.sm.setRepoPolicy(f.gh.repoDir, "never-pr");
    await completeSession(f, "delegate");
    assert.equal(checkmarks(f).length, 1);

    const text = await runMerge();
    assert.match(text, /\nMerge type: (Fast-forward|Merge commit)\./);
    assert.equal(f.outcomes.length, 1);
    assert.match(f.outcomes[0]?.line ?? "", /^ℹ️ \[pr-flow\] Merged: /);
    assert.equal(checkmarks(f).length, 1, "no second ✅");
  });

  it("announces an ask completion with the decision prompt and completes it with the PR that resolves it", async () => {
    const f = await setup();
    await f.sm.setRepoPolicy(f.gh.repoDir, "pr-allowed");
    await completeSession(f, "ask");
    assert.deepEqual([...new Set(f.dispatches.map((request) => request.label))], ["worktree-merge-ask"]);
    assert.match(f.dispatches[0]?.userMessage ?? f.dispatches[0]?.userMessages?.[0]?.text ?? "", /^🔀 \[pr-flow\] Finished on /);
    assert.equal(checkmarks(f).length, 0, "the prompt is the completion-time message");

    // Later keeps the decision pending: still no ✅.
    assert.doesNotMatch(f.sm.snoozeWorktreeDecision(SESSION_ID, { notifyUser: false }), /^Error/);
    assert.equal(checkmarks(f).length, 0);

    const opened = await f.run({ title: "Feature", body: "Adds a feature." });
    assert.deepEqual(opened.meta, { success: true, state: "created", outcomeNotified: true });
    assert.match(f.outcomes[0]?.line ?? "", /^✅ \[pr-flow\] Completed — PR opened: /);

    f.commit("more.txt", "more\n", "feat: add more");
    const updated = await f.run();
    assert.deepEqual(updated.meta, { success: true, state: "pr_updated", outcomeNotified: true });
    assert.match(f.outcomes[1]?.line ?? "", /^ℹ️ \[pr-flow\] PR updated: /);
    assert.equal(checkmarks(f).length, 1, "exactly one ✅ for the terminal cycle");
  });

  it("completes an ask session with the merge that resolves its pending decision", async () => {
    isolateGitHub();
    const f = await setup();
    await f.sm.setRepoPolicy(f.gh.repoDir, "never-pr");
    await completeSession(f, "ask");
    assert.equal(checkmarks(f).length, 0);

    const text = await runMerge();
    assert.match(text, /\nMerge type: (Fast-forward|Merge commit)\./);
    assert.equal(f.outcomes.length, 1);
    assert.match(f.outcomes[0]?.line ?? "", /^✅ \[pr-flow\] Completed — Merged: /);
    assert.equal(checkmarks(f).length, 1);
  });

  // The 🔀 prompt replaces the ✅ whatever strategy led to it: a branch that
  // changes hook / worktree-setup files is never merged or PR'd automatically.
  it("completes an auto-merge session that ended in the decision prompt (hook change) with the merge button", async () => {
    isolateGitHub();
    const f = await setup();
    await f.sm.setRepoPolicy(f.gh.repoDir, "never-pr");
    mkdirSync(join(f.worktreePath, ".openclaw"));
    f.commit(".openclaw/worktree-setup.sh", "#!/bin/sh\ntrue\n", "add setup hook");
    await completeSession(f, "auto-merge");
    assert.deepEqual([...new Set(f.dispatches.map((request) => request.label))], ["worktree-merge-ask"]);
    assert.match(f.dispatches[0]?.userMessage ?? "", /^🔀 \[pr-flow\] Finished on /);
    assert.equal(f.persisted()?.worktreeStrategy, "auto-merge");
    assert.equal(checkmarks(f).length, 0);

    const result = await makeAgentMergeTool().execute(USER_BUTTON_TOOL_CALL_ID, { session: SESSION_NAME }) as { content: Array<{ text: string }> };
    assert.match(f.outcomes[0]?.line ?? "", /^✅ \[pr-flow\] Completed — Merged: /);
    assert.equal(result.content[0]?.text.split("\n")[0], f.outcomes[0]?.line, "the tool result starts with the line the user got");
    assert.equal(f.persisted()?.deferredCompletionCycle, undefined, "consumed");
    assert.equal(checkmarks(f).length, 1);
  });

  it("completes an auto-pr session that ended in the decision prompt (hook change) with the PR button", async () => {
    const f = await setup();
    await f.sm.setRepoPolicy(f.gh.repoDir, "pr-allowed");
    mkdirSync(join(f.worktreePath, ".openclaw"));
    f.commit(".openclaw/worktree-setup.sh", "#!/bin/sh\ntrue\n", "add setup hook");
    await completeSession(f, "auto-pr");
    assert.deepEqual([...new Set(f.dispatches.map((request) => request.label))], ["worktree-merge-ask"]);
    assert.equal(f.persisted()?.worktreeStrategy, "auto-pr");
    assert.equal(checkmarks(f).length, 0);

    const opened = await makeAgentPrTool().execute(USER_BUTTON_TOOL_CALL_ID, { session: SESSION_NAME, title: "Feature", body: "Adds a feature." }) as AgentPrResult;
    assert.deepEqual(opened.meta, { success: true, state: "created", outcomeNotified: true });
    assert.match(f.outcomes[0]?.line ?? "", /^✅ \[pr-flow\] Completed — PR opened: /);

    f.commit("more.txt", "more\n", "feat: add more");
    await makeAgentPrTool().execute(USER_BUTTON_TOOL_CALL_ID, { session: SESSION_NAME });
    assert.match(f.outcomes[1]?.line ?? "", /^ℹ️ \[pr-flow\] PR updated: /);
    assert.equal(checkmarks(f).length, 1, "exactly one ✅ for the terminal cycle");
  });

  it("keeps the ✅ owed after a failed PR attempt and sends it once on the retry", async () => {
    const f = await setup();
    await f.sm.setRepoPolicy(f.gh.repoDir, "pr-allowed");
    await completeSession(f, "ask");
    f.gh.updateState((state) => { state.failures.create = "GraphQL: Resource not accessible by integration (createPullRequest)"; });

    const failed = await f.run({ title: "Feature", body: "Adds a feature." });
    assert.deepEqual(failed.meta, { success: false, state: "error" });
    assert.equal(f.outcomes.length, 0);
    assert.equal(typeof f.persisted()?.deferredCompletionCycle, "number", "still owed");

    f.gh.updateState((state) => { delete state.failures.create; });
    const opened = await f.run({ title: "Feature", body: "Adds a feature." });
    assert.equal(opened.meta.state, "created");
    assert.match(f.outcomes[0]?.line ?? "", /^✅ \[pr-flow\] Completed — PR opened: /);
    f.commit("more.txt", "more\n", "feat: add more");
    await f.run();
    assert.match(f.outcomes[1]?.line ?? "", /^ℹ️ \[pr-flow\] PR updated: /);
    assert.equal(checkmarks(f).length, 1);
  });

  it("completes a pending decision whose PR was already merged, and says so", async () => {
    const f = await setup();
    await f.sm.setRepoPolicy(f.gh.repoDir, "pr-allowed");
    await completeSession(f, "ask");
    const seeded = f.gh.seedPr({ headRefName: f.branch, state: "MERGED" });

    const result = await f.run();
    assert.deepEqual(result.meta, { success: true, state: "merged", outcomeNotified: true });
    assert.equal(f.outcomes.length, 1);
    assert.equal(f.outcomes[0]?.line, `✅ [pr-flow] Completed — PR was already merged: ${seeded.url}`);
    assert.equal(textOf(result).split("\n")[0], f.outcomes[0]?.line);
    assert.equal(f.persisted()?.deferredCompletionCycle, undefined, "consumed");
    assert.equal(checkmarks(f).length, 1);
  });

  it("does not owe a ✅ after a completion that ended in an attention line", async () => {
    const f = await setup();
    // No stored repo policy: the completion is policy-blocked (⚠️ with buttons).
    await completeSession(f, "ask");
    assert.deepEqual([...new Set(f.dispatches.map((request) => request.label))], ["worktree-policy-blocked"]);
    assert.equal(f.persisted()?.deferredCompletionCycle, undefined);
    await f.sm.setRepoPolicy(f.gh.repoDir, "pr-allowed");

    await f.run({ title: "Feature", body: "Adds a feature." });
    assert.match(f.outcomes[0]?.line ?? "", /^ℹ️ \[pr-flow\] PR opened: /);
    assert.equal(checkmarks(f).length, 0);
  });

  it("keeps a pending ask decision a milestone when the session is running again", async () => {
    const f = await setup();
    await f.sm.setRepoPolicy(f.gh.repoDir, "pr-allowed");
    await completeSession(f, "ask");
    f.sm.updatePersistedSession(SESSION_ID, { status: "running" });
    assert.equal(f.persisted()?.worktreeState, "pending_decision");

    const result = await f.run({ title: "Feature", body: "Adds a feature." });
    assert.deepEqual(result.meta, { success: true, state: "created", outcomeNotified: true });
    assert.match(f.outcomes[0]?.line ?? "", /^ℹ️ \[pr-flow\] PR opened: /);
    assert.equal(checkmarks(f).length, 0);
  });

  it("still completes a pending ask decision after a Gateway restart", async () => {
    const f = await setup();
    await f.sm.setRepoPolicy(f.gh.repoDir, "pr-allowed");
    await completeSession(f, "ask");
    assert.equal(f.persisted()?.worktreeState, "pending_decision");

    // A new manager on the same store: no in-memory terminal gate survives.
    const restarted = new SessionManager(5, 50, { store: { env: {}, indexPath: join(f.storeDir, "sessions.json") } });
    cleanups.push(() => restarted.shutdown());
    const outcomes: string[] = [];
    Object.assign(restarted["notifications"], {
      dispatch: (): void => {},
      notifyWorktreeOutcome: (_session: unknown, line: string) => { outcomes.push(line); },
    });
    setSessionManager(restarted);
    const row = restarted.getPersistedSession(SESSION_ID);
    assert.equal(row?.worktreeState, "pending_decision", "the pending decision was loaded from disk");
    assert.equal(typeof row?.deferredCompletionCycle, "number", "the owed ✅ was loaded from disk");
    assert.equal(row?.status, "completed");

    const opened = await f.run({ title: "Feature", body: "Adds a feature." });
    assert.deepEqual(opened.meta, { success: true, state: "created", outcomeNotified: true });
    f.commit("more.txt", "more\n", "feat: add more");
    await f.run();
    assert.equal(outcomes.length, 2);
    assert.match(outcomes[0] ?? "", /^✅ \[pr-flow\] Completed — PR opened: /);
    assert.match(outcomes[1] ?? "", /^ℹ️ \[pr-flow\] PR updated: /);
  });

  for (const scenario of ["merged-while-queued", "resolver-active"] as const) {
    it(`falls back to the completion notice when auto-merge sends no outcome: ${scenario}`, async () => {
      const f = await setup();
      await f.sm.setRepoPolicy(f.gh.repoDir, "never-pr");
      const deps = f.sm["worktreeStrategy"]["deps"];
      let mergedElsewhere = false;
      deps.isAlreadyMerged = () => mergedElsewhere;
      deps.enqueueMerge = async (_repoDir, fn) => { mergedElsewhere = true; await fn(); };
      const session = createStubSession({
        ...f.persisted(), id: SESSION_ID, status: "completed", phase: "implementing",
        originalWorkdir: f.gh.repoDir, workdir: f.worktreePath,
        startedAt: Date.now() - 60_000, duration: 60_000,
        worktreeStrategy: "auto-merge", getOutput: () => ["Finished."],
        ...(scenario === "resolver-active" ? { autoMergeResolverSessionId: "resolver-1" } : {}),
      });
      const main = git(f.gh.repoDir, "rev-parse", "main");
      await f.sm["onSessionTerminal"](session);
      await f.sm["onSessionTerminal"](session);
      assert.equal(mergedElsewhere, scenario === "merged-while-queued");
      assert.equal(git(f.gh.repoDir, "rev-parse", "main"), main, "this run merged nothing");
      assert.equal(f.dispatches.length, 1);
      assert.equal(f.dispatches[0]?.label, "completed");
      assert.match(f.dispatches[0]?.userMessage ?? "", /^✅ \[pr-flow\] Completed/);
    });
  }

  it("does not repeat completion after an authoritative automatic merge outcome", async () => {
    // Merging changes main, so isolate this case from the shared PR fixture.
    const previousGitHub = github;
    github = createFakeGitHub();
    cleanups.push(() => { github.dispose(); github = previousGitHub; });
    const f = await setup();
    await f.sm.setRepoPolicy(f.gh.repoDir, "never-pr");
    const session = createStubSession({
      ...f.persisted(), id: SESSION_ID, status: "completed", phase: "implementing",
      originalWorkdir: f.gh.repoDir, workdir: f.worktreePath,
      startedAt: Date.now() - 60_000, duration: 60_000,
      worktreeStrategy: "auto-merge", getOutput: () => ["Finished."],
    });
    await f.sm["onSessionTerminal"](session);
    await f.sm["onSessionTerminal"](session);
    assert.equal(f.dispatches.length, 1);
    assert.equal(f.dispatches[0]?.label, "worktree-merge-success");
    assert.match(f.dispatches[0]?.userMessage ?? "", /^✅ \[pr-flow\] Completed — Merged:/);
  });

  it("checks current captured-generation execution status after async metadata work", async () => {
    const f = await setup();
    const captured = f.persisted()!;
    const result = await makeAgentPrTool(undefined, {
      terminalCompletion: true,
      metadataProvider: { generatePrMetadata: async () => {
        f.sm["store"].replacePersistedSession({ ...captured, status: "running" });
        return JSON.parse(LLM_METADATA);
      } },
    }).execute("auto-pr", { session: SESSION_ID });
    assert.equal(result.meta.success, true);
    assert.equal(captured.status, "completed", "the initially captured row is now stale");
    assert.equal(f.persisted()?.status, "running");
    assert.match(f.outcomes[0]?.line ?? "", /^ℹ️ /);
    assert.doesNotMatch(f.outcomes[0]?.line ?? "", /Completed|continues/);
  });

  it("prefers the live session's status over a stale stored row for the completion form", async () => {
    const f = await setup();
    const live = createStubSession({
      ...f.persisted(), id: SESSION_ID, status: "completed",
      originalWorkdir: f.gh.repoDir, workdir: f.worktreePath,
      startedAt: Date.now() - 60_000, getOutput: () => ["Finished."],
    });
    f.sm["sessions"].set(SESSION_ID, live);
    cleanups.push(() => { f.sm["sessions"].delete(SESSION_ID); });
    const result = await makeAgentPrTool(undefined, {
      terminalCompletion: true,
      // The same live session started another turn; its stored row still says completed.
      metadataProvider: { generatePrMetadata: async () => { live.status = "running"; return JSON.parse(LLM_METADATA); } },
    }).execute("auto-pr", { session: SESSION_ID });
    assert.equal(result.meta.success, true);
    assert.equal(f.persisted()?.status, "completed");
    assert.equal(f.sm.get(SESSION_ID)?.status, "running");
    assert.match(f.outcomes[0]?.line ?? "", /^ℹ️ /);
    assert.doesNotMatch(f.outcomes[0]?.line ?? "", /Completed/);
  });

  for (const state of ["up-to-date", "merged", "comment-failed"] as const) {
    it(`sends one completion line when managed PR handling succeeds (${state}: ${state === "comment-failed" ? "the PR outcome" : "the terminal fallback"})`, async () => {
      const f = await setup({ commit: state !== "up-to-date" });
      f.gh.seedPr({ headRefName: f.branch, title: "Human title", body: "Human body", state: state === "merged" ? "MERGED" : "OPEN" });
      if (state === "comment-failed") f.gh.updateState((next) => { next.failures.comment = true; });
      const session = createStubSession({
        ...f.persisted(), id: SESSION_ID, status: "completed", phase: "implementing",
        originalWorkdir: f.gh.repoDir, workdir: f.worktreePath,
        startedAt: Date.now() - 60_000, duration: 60_000,
        worktreeStrategy: "auto-pr", getOutput: () => ["Finished."],
      });
      const result = await f.sm["worktreeStrategy"]["deps"].runAutoPr(session, "main");
      if (state === "comment-failed") {
        // The push landed and the PR exists: the PR outcome is the one completion
        // line, with the failed comment under it, and no generic `✅` follows.
        assert.deepEqual(result, { success: true, notificationSent: true });
        assert.equal(f.outcomes.length, 1);
        assert.match(f.outcomes[0]?.line ?? "", /^✅ \[pr-flow\] Completed — PR updated: [^\n]+\n⚠️ The PR comment could not be added\.$/);
        f.sm["worktreeStrategy"]["deps"].runAutoPr = async () => result;
        f.sm["worktrees"].getCompletionState = async () => "has-commits";
        await f.sm["onSessionTerminal"](session);
        assert.equal(f.dispatches.length, 0);
        return;
      }
      assert.deepEqual(result, { success: true, notificationSent: false });
      assert.equal(f.outcomes.length, 0);
      // Reuse the actual result to exercise terminal strategy suppression/fallback.
      f.sm["worktreeStrategy"]["deps"].runAutoPr = async () => result;
      f.sm["worktrees"].getCompletionState = async () => "has-commits";
      await f.sm["onSessionTerminal"](session);
      assert.equal(f.dispatches.length, 1);
      assert.equal(f.dispatches[0]?.label, "completed");
      assert.match(f.dispatches[0]?.userMessage ?? "", /^✅ \[pr-flow\] Completed/);
    });
  }

  for (const action of ["opened", "updated"] as const) {
    it(`reports completion with a PR ${action} through runAutoPr`, async () => {
      const gh = github;
      const { sm, outcomes, dispatches } = createManagerFixture([LLM_METADATA]);
      const harness = createFakeHarness("fake-auto-pr");
      registerHarness(harness);

      await sm.setRepoPolicy(gh.repoDir, "pr-required");
      const session = await sm.launchSession({
        prompt: "Add a feature file.",
        workdir: gh.repoDir,
        name: "auto-pr-flow",
        harness: "fake-auto-pr",
        permissionMode: "bypassPermissions",
        worktreeStrategy: "auto-pr",
        multiTurn: false,
        route: { provider: "telegram", target: "12345", sessionKey: "agent:main:telegram:group:12345" },
      }, { notifyLaunch: false });
      const worktreePath = session.worktreePath;
      assert.ok(worktreePath, "auto-pr sessions run in a worktree");
      cleanups.push(() => removeTestWorktree(worktreePath));
      writeFileSync(join(worktreePath, "feature.txt"), "feature flag on\n", "utf-8");
      git(worktreePath, "add", "feature.txt");
      git(worktreePath, "commit", "-m", "feat: add feature file");

      if (action === "updated") gh.seedPr({ headRefName: session.worktreeBranch!, title: "Human title", body: "Human body" });

      harness.pushMessage({ type: "init", session_id: "fake-auto-pr-conversation" });
      harness.pushMessage({ type: "text", text: "Added the feature file." });
      harness.pushMessage({
        type: "result",
        data: { success: true, duration_ms: 1, total_cost_usd: 0, num_turns: 1, result: "Added the feature file.", session_id: "fake-auto-pr-conversation" },
      });
      harness.endMessages();

      await waitUntil(() => outcomes.length > 0 || dispatches.some((request) => request.label === "worktree-auto-pr-failed"), "the auto-pr outcome", 15_000);

      const [create] = gh.ghCalls("create");
      if (action === "opened") {
        assert.ok(create, `expected gh pr create; notifications: ${dispatches.map((request) => request.label).join(", ")}`);
        assert.ok(create.args.includes("--draft"));
        assert.equal(argAfter(create.args, "--title"), "Add the feature file");
        const branch = argAfter(create.args, "--head");
        assert.ok(branch);
        assert.equal(gh.remoteHead(branch), git(gh.repoDir, "rev-parse", branch));
      } else {
        assert.equal(gh.ghCalls("create").length, 0);
        assert.equal(gh.ghCalls("comment").length, 1);
      }
      assert.match(outcomes[0]?.line ?? "", new RegExp(`^✅ \\[auto-pr-flow\\] Completed — PR ${action}: https://github.com/acme/widget/pull/101`));
      assert.equal(outcomes.length, 1);
      assert.equal(dispatches.length, 0, "combined terminal outcome replaces generic completion");
      const persisted = sm.getPersistedSession(session.id);
      assert.equal(persisted?.worktreePrUrl, "https://github.com/acme/widget/pull/101");
      assert.equal(persisted?.worktreeStrategy, "auto-pr");
      assert.equal(persisted?.status, "completed");
    });
  }
});
