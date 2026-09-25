/**
 * A fake GitHub for worktree/PR tests: real git repositories behind a
 * github.com remote URL, and a scriptable `gh` executable on PATH.
 *
 * - The primary checkout's `origin` is `git@github.com:<owner>/<repo>.git`, so
 *   OCA's GitHub detection (`hasGitHubRemote`, repo-policy provider, fork owner
 *   inference) sees a real GitHub remote. A repo-local `core.sshCommand`
 *   (with `ssh.variant=simple`) serves that URL from a local bare repository,
 *   so `git fetch` / `git push` work offline. (A `url.<base>.insteadOf` rewrite
 *   cannot be used here: `git remote get-url` / `git remote -v` print the
 *   rewritten local path, and OCA's GitHub detection would then fail.)
 * - `gh` is a small Node script backed by a JSON state file. It implements the
 *   `gh` calls OCA makes (`--version`, `pr list`, `pr view`, `pr create`,
 *   `pr edit`, `pr comment`), records every call, checks that the PR head was
 *   pushed, and can be told to fail specific operations.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setGitHubCliAvailabilityForTests } from "../src/worktree-repo";

export type FakePrState = "OPEN" | "MERGED" | "CLOSED";

export type FakePullRequest = {
  number: number;
  url: string;
  title: string;
  body: string;
  state: FakePrState;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headOwner: string;
  repo: string;
};

export type FakeGhCall = { args: string[]; cwd: string };

export type FakeGhFailures = {
  /** `pr create` fails with this stderr text. */
  create?: string;
  /** `pr create` exits 1 without writing anything to stderr. */
  createSilent?: boolean;
  /** `pr create --draft` fails as on a repository without draft PRs; the retry without `--draft` succeeds. */
  draftUnsupported?: boolean;
  /** `pr comment` fails. */
  comment?: boolean;
  /** `pr edit --title` fails. */
  editTitle?: boolean;
  /** `pr edit --body` fails. */
  editBody?: boolean;
  /** `pr view` fails for every PR. */
  view?: boolean;
};

export type FakeGhState = {
  /** Default `owner/repo` for PRs created without `--repo`. */
  repo: string;
  nextNumber: number;
  prs: FakePullRequest[];
  comments: Array<{ number: number; body: string; repo: string }>;
  calls: FakeGhCall[];
  failures: FakeGhFailures;
};

// Plain CommonJS (the temp bin dir has no package.json), no dependencies.
const FAKE_GH_SCRIPT = String.raw`#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const statePath = process.env.OCA_FAKE_GH_STATE;
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("gh version 2.99.0 (fake)\n");
  process.exit(0);
}
if (!statePath) {
  process.stderr.write("fake gh: OCA_FAKE_GH_STATE is not set\n");
  process.exit(4);
}
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
state.calls.push({ args, cwd: process.cwd() });
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const fail = (message, code = 1) => { save(); process.stderr.write(message + "\n"); process.exit(code); };
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
const repoOf = () => flag("--repo") || state.repo;
const pick = (pr, fields) => {
  const all = {
    url: pr.url, number: pr.number, title: pr.title, body: pr.body, state: pr.state, isDraft: pr.isDraft,
    headRefName: pr.headRefName, baseRefName: pr.baseRefName, headRepositoryOwner: { login: pr.headOwner },
  };
  const out = {};
  for (const field of fields.split(",")) if (field in all) out[field] = all[field];
  return out;
};
const findPr = (ref) => {
  if (state.failures.view) return undefined;
  const repo = repoOf();
  return state.prs.find((pr) => pr.url === ref || (String(pr.number) === String(ref) && pr.repo === repo));
};
const [group, command, target] = args;
if (group !== "pr") fail("fake gh: unsupported command " + args.join(" "), 2);

if (command === "list") {
  const head = flag("--head");
  const repo = repoOf();
  // Like GitHub, newest first.
  const prs = state.prs.filter((pr) => pr.repo === repo && (!head || pr.headRefName === head)).sort((a, b) => b.number - a.number);
  save();
  process.stdout.write(JSON.stringify(prs.map((pr) => pick(pr, flag("--json") || "url,number"))) + "\n");
  process.exit(0);
}
if (command === "view") {
  const pr = findPr(target);
  if (!pr) fail("no pull requests found for " + target);
  save();
  process.stdout.write(JSON.stringify(pick(pr, flag("--json") || "url,number")) + "\n");
  process.exit(0);
}
if (command === "create") {
  if (state.failures.create) fail(state.failures.create);
  if (state.failures.createSilent) { save(); process.exit(1); }
  const draft = has("--draft");
  if (draft && state.failures.draftUnsupported) fail("pull request create failed: GraphQL: Draft pull requests are not supported in this repository. (createPullRequest)");
  const base = flag("--base");
  const repo = repoOf();
  const headArg = flag("--head");
  const [headOwner, headRefName] = headArg.includes(":") ? headArg.split(":") : [repo.split("/")[0], headArg];
  const title = flag("--title");
  const body = flag("--body");
  if (!title || !body) fail("fake gh: --title and --body are required (OCA never uses --fill here)", 2);
  let pushed = "";
  try {
    pushed = execFileSync("git", ["ls-remote", "--heads", "origin", headRefName], { encoding: "utf8" }).trim();
  } catch (error) {
    fail("fake gh: could not read origin: " + error.message);
  }
  if (!pushed) fail("pull request create failed: GraphQL: Head sha can't be blank, Head ref must be a branch (createPullRequest)");
  const existing = state.prs.find((pr) => pr.repo === repo && pr.headRefName === headRefName && pr.state === "OPEN");
  if (existing) fail("a pull request for branch \"" + headRefName + "\" into branch \"" + existing.baseRefName + "\" already exists:\n" + existing.url);
  const number = state.nextNumber++;
  const pr = {
    number, url: "https://github.com/" + repo + "/pull/" + number, title, body, state: "OPEN", isDraft: draft,
    headRefName, baseRefName: base, headOwner, repo,
  };
  state.prs.push(pr);
  save();
  process.stdout.write(pr.url + "\n");
  process.exit(0);
}
if (command === "edit") {
  const pr = findPr(target);
  if (!pr) fail("no pull requests found for " + target);
  if (has("--title")) {
    if (state.failures.editTitle) fail("GraphQL: title update rejected (updatePullRequest)");
    pr.title = flag("--title");
  }
  if (has("--body")) {
    if (state.failures.editBody) fail("GraphQL: body update rejected (updatePullRequest)");
    pr.body = flag("--body");
  }
  save();
  process.stdout.write(pr.url + "\n");
  process.exit(0);
}
if (command === "comment") {
  if (state.failures.comment) fail("GraphQL: Resource not accessible by integration (addComment)");
  const pr = findPr(target);
  if (!pr) fail("no pull requests found for " + target);
  state.comments.push({ number: pr.number, body: flag("--body"), repo: pr.repo });
  save();
  process.stdout.write(pr.url + "#issuecomment-1\n");
  process.exit(0);
}
fail("fake gh: unsupported command " + args.join(" "), 2);
`;

/** `git@github.com:<owner>/<repo>.git` served from `<root>/<owner>/<repo>.git`. */
const FAKE_SSH_SCRIPT = (root: string): string => [
  "#!/bin/sh",
  "# ssh.variant=simple: $1 is the host, $2 the remote git command (git-upload-pack 'owner/repo.git').",
  `cd ${JSON.stringify(root)} || exit 128`,
  "exec sh -c \"git ${2#git-}\"",
  "",
].join("\n");

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

export type FakeGitHub = {
  /** Primary checkout (the session's `workdir`). */
  repoDir: string;
  /** Local bare repository behind `origin`. */
  remoteDir: string;
  owner: string;
  repo: string;
  readState(): FakeGhState;
  /** Forget every PR, comment, call, and failure (the repositories are kept). */
  resetState(): void;
  updateState(update: (state: FakeGhState) => void): void;
  /** Add a PR as if it had been opened on GitHub. */
  seedPr(pr: Partial<FakePullRequest> & Pick<FakePullRequest, "headRefName">): FakePullRequest;
  /** `gh` calls, optionally filtered by subcommand (`create`, `edit`, ...). */
  ghCalls(subcommand?: string): FakeGhCall[];
  /** Commit hash of `branch` on the fake remote, or "" when it was never pushed. */
  remoteHead(branch: string): string;
  dispose(): void;
};

export function createFakeGitHub(options: { owner?: string; repo?: string } = {}): FakeGitHub {
  const owner = options.owner ?? "acme";
  const repo = options.repo ?? "widget";
  const rootDir = mkdtempSync(join(tmpdir(), "oca-fake-github-"));
  const serverRoot = join(rootDir, "server");
  const remoteDir = join(serverRoot, owner, `${repo}.git`);
  const binDir = join(rootDir, "bin");
  const repoDir = join(rootDir, "checkout");
  const statePath = join(rootDir, "gh-state.json");
  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(binDir);
  mkdirSync(repoDir);

  writeFileSync(join(binDir, "gh"), FAKE_GH_SCRIPT, "utf-8");
  chmodSync(join(binDir, "gh"), 0o755);
  const sshPath = join(binDir, "fake-github-ssh");
  writeFileSync(sshPath, FAKE_SSH_SCRIPT(serverRoot), "utf-8");
  chmodSync(sshPath, 0o755);

  const initialState: FakeGhState = { repo: `${owner}/${repo}`, nextNumber: 101, prs: [], comments: [], calls: [], failures: {} };
  writeFileSync(statePath, JSON.stringify(initialState, null, 2));

  git(remoteDir, "init", "--bare", "--initial-branch=main");
  git(repoDir, "init", "-b", "main");
  git(repoDir, "config", "user.name", "OpenClaw Tests");
  git(repoDir, "config", "user.email", "tests@example.com");
  git(repoDir, "config", "core.sshCommand", sshPath);
  git(repoDir, "config", "ssh.variant", "simple");
  git(repoDir, "remote", "add", "origin", `git@github.com:${owner}/${repo}.git`);
  writeFileSync(join(repoDir, "README.md"), "base\n", "utf-8");
  git(repoDir, "add", "README.md");
  git(repoDir, "commit", "-m", "init");
  git(repoDir, "push", "-u", "origin", "main");
  git(repoDir, "remote", "set-head", "origin", "main");

  const previousPath = process.env.PATH;
  const previousState = process.env.OCA_FAKE_GH_STATE;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  process.env.OCA_FAKE_GH_STATE = statePath;
  // Drop any cached `gh --version` probe so the fake binary is the one found.
  setGitHubCliAvailabilityForTests(undefined);

  const readState = (): FakeGhState => JSON.parse(readFileSync(statePath, "utf-8")) as FakeGhState;
  const writeState = (state: FakeGhState): void => writeFileSync(statePath, JSON.stringify(state, null, 2));

  return {
    repoDir,
    remoteDir,
    owner,
    repo,
    readState,
    resetState() {
      writeState({ ...initialState, prs: [], comments: [], calls: [], failures: {} });
    },
    updateState(update) {
      const state = readState();
      update(state);
      writeState(state);
    },
    seedPr(pr) {
      const state = readState();
      const number = pr.number ?? state.nextNumber++;
      const fullRepo = pr.repo ?? state.repo;
      const seeded: FakePullRequest = {
        number,
        url: pr.url ?? `https://github.com/${fullRepo}/pull/${number}`,
        title: pr.title ?? `PR ${number}`,
        body: pr.body ?? "",
        state: pr.state ?? "OPEN",
        isDraft: pr.isDraft ?? false,
        headRefName: pr.headRefName,
        baseRefName: pr.baseRefName ?? "main",
        headOwner: pr.headOwner ?? owner,
        repo: fullRepo,
      };
      state.prs.push(seeded);
      writeState(state);
      return seeded;
    },
    ghCalls(subcommand) {
      const calls = readState().calls;
      return subcommand ? calls.filter((call) => call.args[1] === subcommand) : calls;
    },
    remoteHead(branch) {
      return git(repoDir, "ls-remote", "--heads", "origin", branch).split(/\s+/)[0] ?? "";
    },
    dispose() {
      process.env.PATH = previousPath;
      if (previousState === undefined) delete process.env.OCA_FAKE_GH_STATE;
      else process.env.OCA_FAKE_GH_STATE = previousState;
      setGitHubCliAvailabilityForTests(undefined);
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
