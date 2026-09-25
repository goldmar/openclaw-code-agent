import "./test-env";
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAgentPrTool } from "../src/tools/agent-pr";
import { SessionManager } from "../src/session-manager";
import { setSessionManager } from "../src/singletons";
import { setPluginRuntime } from "../src/runtime-store";
import { registerHarness } from "../src/harness";
import { commentOnPR, createWorktree, getBranchName, updatePRTitle } from "../src/worktree";
import type { PersistedSessionInfo } from "../src/types";
import type { SessionNotificationRequest } from "../src/wake-dispatcher";
import { createFakeGitHub, git, type FakeGitHub } from "./fake-github";
import { createFakeHost, type FakeHost } from "./fake-host";
import { createFakeHarness } from "./helpers";
import { waitUntil } from "./harness-backends";

const GENERATED_FOOTER = "Generated with [openclaw-code-agent](https://github.com/goldmar/openclaw-code-agent)";
const SESSION_NAME = "pr-flow";
const SESSION_ID = "s-pr-flow";

type AgentPrResult = { content: Array<{ type: "text"; text: string }>; meta: { success: boolean; state: string } };
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
  it("pushes the branch and opens a draft PR with LLM metadata from runtime.llm", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const head = git(f.worktreePath, "rev-parse", "HEAD");

    const result = await f.run();

    assert.deepEqual(result.meta, { success: true, state: "created" });
    assert.equal(textOf(result), "✅ PR opened: https://github.com/acme/widget/pull/101");
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
    assert.equal(f.outcomes[0]?.line, "✅ PR opened: https://github.com/acme/widget/pull/101");
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

    assert.deepEqual(result.meta, { success: true, state: "created" });
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
  });

  it("retries without --draft when the repository has no draft PRs and says so", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    f.gh.updateState((state) => { state.failures.draftUnsupported = true; });

    const result = await f.run();

    assert.deepEqual(result.meta, { success: true, state: "created" });
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
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const seeded = f.gh.seedPr({
      headRefName: f.branch,
      title: "OpenClaw agent changes: pr flow",
      body: `Old generated body\n\n---\n${GENERATED_FOOTER}`,
    });

    const result = await f.run();

    assert.deepEqual(result.meta, { success: true, state: "pr_updated" });
    const text = textOf(result);
    assert.match(text, new RegExp(`^✅ PR updated: ${seeded.url} \\(1 files, \\+1/-0\\)`));
    assert.match(text, /📝 Added comment detailing 1 new commits \(\+1 \/ -0\)/);
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
    assert.equal(f.outcomes[0]?.line, `✅ PR updated: ${seeded.url} (1 files, +1/-0)`);
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
    assert.match(textOf(result), /⚠️ {2}PR metadata refresh failed: generated PR metadata was unavailable; preserved existing generated PR metadata/);
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

  it("reports an open PR as current when a comment cannot be posted", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const seeded = f.gh.seedPr({ headRefName: f.branch, title: "Human title", body: "Written by a human." });
    f.gh.updateState((state) => { state.failures.comment = true; });

    const result = await f.run();

    assert.deepEqual(result.meta, { success: true, state: "pr_open" });
    assert.match(textOf(result), new RegExp(`⚠️ {2}Pushed to ${seeded.url} but failed to add comment\\.`));
    assert.equal(f.outcomes.length, 0);
    assert.equal(f.persisted()?.worktreePrUrl, undefined, "a failed update does not claim the PR");
  });

  it("reports an open PR without new commits as up to date", async () => {
    const f = await setup({ commit: false });
    const seeded = f.gh.seedPr({ headRefName: f.branch, title: "Human title", body: "Written by a human." });

    const result = await f.run();

    assert.deepEqual(result.meta, { success: true, state: "pr_open" });
    assert.match(textOf(result), new RegExp(`ℹ️ {2}PR already exists and is up to date: ${seeded.url}\\n\\nNo new commits to push\\.`));
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
    assert.match(textOf(result), new RegExp(`✅ PR was already merged: ${seeded.url}`));
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
  });

  it("refuses force_new while an open PR exists for the branch", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const seeded = f.gh.seedPr({ headRefName: f.branch });

    const result = await f.run({ force_new: true });

    assert.deepEqual(result.meta, { success: false, state: "error" });
    assert.match(textOf(result), new RegExp(`Cannot create new PR: A PR already exists for ${f.branch} \\(open\\)\\.\\n\\nExisting PR: ${seeded.url}`));
    assert.equal(f.gh.ghCalls("create").length, 0);
  });

  it("opens a fresh PR with force_new when the session's recorded PR was closed", async () => {
    const f = await setup({ llmReplies: [LLM_METADATA] });
    const closed = f.gh.seedPr({ headRefName: f.branch, state: "CLOSED" });
    f.sm.updatePersistedSession(SESSION_ID, { worktreePrUrl: closed.url, worktreePrNumber: closed.number });

    const result = await f.run({ force_new: true });

    assert.deepEqual(result.meta, { success: true, state: "created" });
    const fresh = f.gh.readState().prs.find((pr) => pr.state === "OPEN");
    assert.ok(fresh && fresh.number !== closed.number);
    assert.equal(f.persisted()?.worktreePrUrl, fresh.url);
    assert.equal(f.persisted()?.worktreePrNumber, fresh.number);
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

describe("auto-pr worktree strategy", () => {
  it("opens a draft PR through runAutoPr when an auto-pr session completes", async () => {
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

    harness.pushMessage({ type: "init", session_id: "fake-auto-pr-conversation" });
    harness.pushMessage({ type: "text", text: "Added the feature file." });
    harness.pushMessage({
      type: "result",
      data: { success: true, duration_ms: 1, total_cost_usd: 0, num_turns: 1, result: "Added the feature file.", session_id: "fake-auto-pr-conversation" },
    });
    harness.endMessages();

    await waitUntil(() => outcomes.length > 0 || dispatches.some((request) => request.label === "worktree-auto-pr-failed"), "the auto-pr outcome", 15_000);

    const [create] = gh.ghCalls("create");
    assert.ok(create, `expected gh pr create; notifications: ${dispatches.map((request) => request.label).join(", ")}`);
    assert.ok(create.args.includes("--draft"));
    assert.equal(argAfter(create.args, "--title"), "Add the feature file");
    const branch = argAfter(create.args, "--head");
    assert.ok(branch);
    assert.equal(gh.remoteHead(branch), git(gh.repoDir, "rev-parse", branch));
    assert.equal(outcomes[0]?.line, "✅ PR opened: https://github.com/acme/widget/pull/101");
    const persisted = sm.getPersistedSession(session.id);
    assert.equal(persisted?.worktreePrUrl, "https://github.com/acme/widget/pull/101");
    assert.equal(persisted?.worktreeStrategy, "auto-pr");
  });
});
