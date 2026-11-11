#!/usr/bin/env node
// Read-only policy shared by CI and the weekly OCA owner. No installed packages.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const REPOSITORY = "goldmar/openclaw-code-agent";
export const RUNTIME_PATCHES = ["@hono/node-server", "express-rate-limit", "fast-uri", "hono", "ip-address", "qs", "zod"];
export const DEVELOPMENT_UPDATES = ["@types/node", "fast-check"];
export const REQUIRED_CHECKS = [
  "Verify (Node 24.16.0)", "Verify (Node 26.1.0)", "Bundle Size Check", "Lockfile Integrity Check",
  "pnpm audit --prod", "Dependency Review", "actionlint", "no-tabs", "Analyze (javascript-typescript)", "Analyze (actions)",
];
const GREPTILE_APP_ID = 867647;
export const REVIEW_MODEL = "claude-opus-5-5";
export const REVIEW_MARKER = "oca-dependency-claude-review:v2";
const GREPTILE_CHECK = "Greptile Review";
const GREPTILE_SCORE = /^<!-- greptile_confidence_score:(\d+) -->$/mu;
const SHA = /^[a-f0-9]{40}$/u;
const VERSION = /^(\^|~)?(\d+)\.(\d+)\.(\d+)$/u;
const READY = /^<!-- oca-dependencies-ready:v1 ([a-f0-9]{40}) ([a-f0-9]{40}) -->$/u;
export const COMBINED_LABEL = "dependency-combined";
const COMBINED_BRANCH = /^dependencies\/combined-\d{4}-\d{2}-\d{2}$/u;

export function releaseChange(before, after, patchOnly = false) {
  const a = VERSION.exec(before ?? "");
  const b = VERSION.exec(after ?? "");
  if (!a || !b || a[1] !== b[1] || Number(a[2]) === 0 || a[2] !== b[2]) return false;
  const minor = Number(b[3]) - Number(a[3]);
  const patch = Number(b[4]) - Number(a[4]);
  return patchOnly ? minor === 0 && patch > 0 : minor > 0 || (minor === 0 && patch > 0);
}

// The weekly owner's one combined PR. Branch and label only select the lane;
// preparation still requires a repository writer, and evaluate() applies every
// dependency, check and review gate to the actual head.
export function isCombined(pr) {
  return pr.user?.type === "User" && COMBINED_BRANCH.test(pr.head?.ref ?? "") &&
    (pr.labels ?? []).some(label => label.name === COMBINED_LABEL);
}

export function preparation(snapshot) {
  const { pr, comments = [], writers = [] } = snapshot;
  const combined = isCombined(pr);
  if (pr.user?.login !== "dependabot[bot]" && !combined) return { status: "ordinary" };
  if (pr.state !== "open" || pr.draft || pr.base?.ref !== "main" || pr.base?.repo?.full_name !== REPOSITORY ||
      pr.head?.repo?.full_name !== REPOSITORY || !SHA.test(pr.head?.sha ?? "") || !SHA.test(pr.base?.sha ?? "")) {
    return { status: "held", reason: "untrusted-or-inactive-pr" };
  }
  if (pr.auto_merge) return { status: "held", reason: "disable-inherited-auto-merge-first" };
  if (combined) {
    return writers.includes(pr.user.login) ? { status: "prepared", head: pr.head.sha, base: pr.base.sha } :
      { status: "held", reason: "combined-author-not-a-writer" };
  }
  if (!(pr.labels ?? []).some(label => label.name === "dependency-ready")) {
    return { status: "held", reason: "preparation-required" };
  }
  const receipt = comments.find(comment => {
    const match = READY.exec(comment.body ?? "");
    return match && match[1] === pr.head.sha && match[2] === pr.base.sha &&
      comment.user?.type === "User" && writers.includes(comment.user.login) &&
      comment.created_at === comment.updated_at;
  });
  return receipt ? { status: "prepared", head: pr.head.sha, base: pr.base.sha } :
    { status: "held", reason: "missing-authenticated-head-and-base-receipt" };
}

export function preparationForEvent(snapshot, event) {
  if (snapshot.pr.head?.sha !== event.pull_request?.head?.sha || snapshot.pr.base?.sha !== event.pull_request?.base?.sha) {
    return { status: "held", reason: "event-head-or-base-changed" };
  }
  return preparation(snapshot);
}

function graphVersions(packages) {
  const result = new Map();
  for (const [path, item] of Object.entries(packages ?? {})) {
    if (!path) continue;
    const name = path.split("node_modules/").at(-1);
    if (!name || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(item.version ?? "")) throw new Error("unrecognized dependency resolution");
    const versions = result.get(name) ?? new Set();
    versions.add(item.version);
    result.set(name, versions);
  }
  return result;
}

// pnpm 11 canonical package keys; unknown syntax is a manual-review hold.
export function pnpmVersions(text) {
  if (!text.startsWith("lockfileVersion: '9.0'\n")) throw new Error("unsupported pnpm lockfile");
  const section = text.split("\npackages:\n")[1]?.split("\nsnapshots:\n")[0];
  if (!section) throw new Error("missing pnpm packages");
  const result = {};
  let current;
  for (const line of section.split("\n")) {
    if (line.startsWith("    resolution: ")) {
      if (!current) throw new Error("resolution without package");
      const resolution = /^    resolution: \{integrity: (sha(?:1|256|384|512)-[A-Za-z0-9+/=]+)\}$/u.exec(line);
      if (!resolution) throw new Error("noncanonical pnpm resolution requires manual review");
      current.integrity = resolution[1];
      continue;
    }
    if (!/^  \S/u.test(line)) continue;
    const match = /^  ['"]?(.+)@(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)['"]?:$/u.exec(line);
    if (!match) throw new Error("unsupported pnpm package key");
    current = { version: match[2], integrity: undefined, resolved: undefined };
    result[`node_modules/${match[1]}/${match[2]}/node_modules/${match[1]}`] = current;
  }
  if (!Object.keys(result).length) throw new Error("empty pnpm packages");
  return result;
}

function safeSources(before, after) {
  const previous = new Map();
  const identity = (path, item) => `${path.split("node_modules/").at(-1)}@${item.version}`;
  const source = item => JSON.stringify([item.integrity ?? null, item.resolved ?? null]);
  for (const [path, item] of Object.entries(before)) {
    if (!path) continue;
    const key = identity(path, item);
    const sources = previous.get(key) ?? new Set();
    sources.add(source(item));
    previous.set(key, sources);
  }
  for (const [path, item] of Object.entries(after)) {
    if (!path) continue;
    const sources = previous.get(identity(path, item));
    if (sources) {
      if (!sources.has(source(item))) return false;
    } else {
      if (!/^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/u.test(item.integrity ?? "")) return false;
      if (item.resolved && new URL(item.resolved).origin !== "https://registry.npmjs.org") return false;
    }
  }
  return true;
}

function safeGraph(before, after, patchOnly) {
  if (!safeSources(before, after)) return false;
  const old = graphVersions(before);
  const next = graphVersions(after);
  if (!old.size || !next.size) return false;
  for (const [name, versions] of next) {
    const previous = old.get(name);
    if (!previous) return false;
    if (/anthropic|claude|openclaw|modelcontextprotocol|esbuild|typescript|tsx|typebox/iu.test(name) &&
        !isDeepStrictEqual([...previous].sort(), [...versions].sort())) return false;
    for (const version of versions) {
      if (previous.has(version)) continue;
      if (/anthropic|claude|openclaw|modelcontextprotocol|esbuild|typescript|tsx|typebox/iu.test(name)) return false;
      // A combined PR may pair runtime patches with a development minor update.
      const patch = RUNTIME_PATCHES.includes(name) || (patchOnly && !DEVELOPMENT_UPDATES.includes(name));
      if (![...previous].some(oldVersion => releaseChange(oldVersion, version, patch))) return false;
    }
  }
  return true;
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// Each runtime patch moves exactly one whole override line, `name@<prev: prev`.
// YAML needs quotes around a selector that starts with `@`, so the selector may be
// single- or double-quoted; the quote style itself must not change.
function workspaceChange(before, after, changes) {
  let expected = before;
  for (const { name, previous, next } of changes) {
    const line = new RegExp(`^  (['"]?)${escapeRegExp(name)}@<${escapeRegExp(previous)}\\1: ${escapeRegExp(previous)}$`, "mu");
    expected = expected.replace(line, (_, quote) => `  ${quote}${name}@<${next}${quote}: ${next}`);
  }
  return expected === after;
}

function codeqlOnly(files, contents, verifiedActionPins = {}) {
  let changed = false;
  let pin;
  for (const file of files) {
    if (file.status !== "modified" || !/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file.filename)) return false;
    const pair = contents[file.filename];
    if (!pair) return false;
    const pattern = /(uses: github\/codeql-action\/(?:init|analyze)@)([a-f0-9]{40})( # v)(\d+\.\d+\.\d+)/gu;
    const a = [...pair.before.matchAll(pattern)];
    const b = [...pair.after.matchAll(pattern)];
    if (!a.length || a.length !== b.length || !b.some(match => match[1].includes("/init@")) ||
        !b.some(match => match[1].includes("/analyze@"))) return false;
    for (let index = 0; index < a.length; index++) {
      if (a[index][1] !== b[index][1] || a[index][2] === b[index][2] || !releaseChange(a[index][4], b[index][4])) return false;
      if (verifiedActionPins[b[index][4]] !== b[index][2]) return false;
      if (pin && pin !== b[index][2]) return false;
      pin = b[index][2];
    }
    const strip = value => value.replace(pattern, "$1<PIN> # v<VERSION>");
    if (strip(pair.before) !== strip(pair.after)) return false;
    changed = true;
  }
  return changed;
}

export function dependencyScope(snapshot) {
  const { files, contents } = snapshot;
  if (!files?.length || files.some(file => file.status !== "modified")) return "unapproved-file-change";
  if (files.every(file => file.filename.startsWith(".github/workflows/"))) {
    return codeqlOnly(files, contents, snapshot.verifiedActionPins) ? null : "workflow-behavior-or-non-codeql-change";
  }
  const allowed = ["package.json", "pnpm-lock.yaml", "npm-shrinkwrap.json", "pnpm-workspace.yaml"];
  if (files.some(file => !allowed.includes(file.filename))) return "unapproved-file-change";
  try {
    const before = JSON.parse(contents["package.json"].before);
    const after = JSON.parse(contents["package.json"].after);
    const changes = [];
    for (const section of ["dependencies", "devDependencies"]) {
      const a = before[section] ?? {};
      const b = after[section] ?? {};
      if (!isDeepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort())) return "dependency-added-or-removed";
      for (const name of Object.keys(a)) {
        if (a[name] === b[name]) continue;
        const runtime = section === "dependencies";
        if (!(runtime ? RUNTIME_PATCHES : DEVELOPMENT_UPDATES).includes(name) ||
            !releaseChange(a[name], b[name], runtime) || (runtime && !/^\d+\.\d+\.\d+$/u.test(b[name]))) {
          return "dependency-outside-routine-allowlist";
        }
        changes.push({ name, previous: a[name], next: b[name], runtime });
      }
      delete before[section];
      delete after[section];
    }
    if (!changes.length || !isDeepStrictEqual(before, after)) return "manifest-behavior-or-metadata-change";
    const runtime = changes.some(change => change.runtime);
    const pnpm = contents["pnpm-lock.yaml"];
    const shrinkwrap = contents["npm-shrinkwrap.json"];
    const workspace = contents["pnpm-workspace.yaml"];
    if (!runtime && shrinkwrap.before !== shrinkwrap.after) return "development-update-changes-published-graph";
    if (!safeGraph(pnpmVersions(pnpm.before), pnpmVersions(pnpm.after), runtime) ||
        !safeGraph(JSON.parse(shrinkwrap.before).packages, JSON.parse(shrinkwrap.after).packages, runtime)) {
      return "unapproved-transitive-change";
    }
    if (!workspaceChange(workspace.before, workspace.after, changes.filter(change => change.runtime))) return "override-or-build-policy-change";
    return null;
  } catch {
    return "unrecognized-or-missing-dependency-artifacts";
  }
}

export function evaluate(snapshot) {
  if (snapshot.enabled !== true) return { status: "held", reason: "activation-required" };
  const prepared = preparation(snapshot);
  if (prepared.status !== "prepared") return prepared;
  const reason = dependencyScope(snapshot);
  if (reason) return { status: "manual-review", reason };
  const { pr, checks = [], statuses = [], comments = [], threads = [], reviews = [] } = snapshot;
  if (pr.mergeable !== true || pr.mergeable_state !== "clean") return { status: "held", reason: "mergeability-not-clean" };
  for (const name of REQUIRED_CHECKS) {
    const candidates = checks.filter(check => check.name === name && check.head_sha === pr.head.sha && check.app?.id === 15368)
      .sort((a, b) => b.id - a.id);
    if (!candidates.length || candidates[0].status !== "completed" || candidates[0].conclusion !== "success") {
      return { status: "held", reason: `required-check:${name}` };
    }
  }
  const exhausted = snapshot.reviewEvidence && budgetExhausted(snapshot.reviewEvidence);
  const fallback = exhausted ? claudeReceipt({ pr, comments }) : null;
  if (fallback && greptileObjection(snapshot)) return { status: "held", reason: "current-head-greptile-objection" };
  // Ignore superseded attempts, but never hide a current failing/pending check.
  const latestChecks = new Map();
  for (const check of [...checks].sort((a, b) => a.id - b.id)) {
    if (check.head_sha === pr.head.sha) latestChecks.set(`${check.app?.id}:${check.name}`, check);
  }
  if (statuses.some(status => status.state !== "success") || [...latestChecks.values()].some(check =>
    !(fallback && check.app?.id === GREPTILE_APP_ID && check.name === GREPTILE_CHECK) &&
    !["success", "neutral", "skipped"].includes(check.conclusion))) {
    return { status: "held", reason: "additional-checks-not-green" };
  }
  const greptile = comments.filter(comment => comment.user?.login === "greptile-apps[bot]" && comment.user?.type === "Bot" &&
    (comment.body ?? "").startsWith("<!-- greptile_summary -->"))
    .sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? "") || b.id - a.id)[0];
  const reviewed = greptile?.body.match(/Last reviewed commit: \[[^\n]*?\]\(https:\/\/github\.com\/goldmar\/openclaw-code-agent\/commit\/([a-f0-9]{40})\)/u)?.[1];
  // Greptile's machine-readable results decide this; its prose never does.
  const reviewCheck = checks.filter(check => check.name === GREPTILE_CHECK && check.head_sha === pr.head.sha &&
    check.app?.id === GREPTILE_APP_ID).sort((a, b) => b.id - a.id)[0];
  if (!fallback && (exhausted || reviewed !== pr.head.sha || GREPTILE_SCORE.exec(greptile?.body ?? "")?.[1] !== "5" ||
      reviewCheck?.status !== "completed" || reviewCheck.conclusion !== "success")) {
    return { status: "held", reason: "final-head-greptile-required" };
  }
  if (threads.some(thread => thread.isResolved !== true)) return { status: "held", reason: "unresolved-review-threads" };
  const latestReview = new Map();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latestReview.set(review.user?.login, review.state);
  }
  if ([...latestReview.values()].includes("CHANGES_REQUESTED")) return { status: "held", reason: "changes-requested" };
  return { status: "eligible", head: prepared.head, base: prepared.base, number: pr.number,
    reviewer: fallback ? "claude" : "greptile", model: fallback ? fallback.model : null };
}

export function collectReview(number, { api = githubRead } = {}) {
  const read = path => api(["api", `repos/${REPOSITORY}/${path}`]);
  const pages = path => api(["api", `repos/${REPOSITORY}/${path}`, "--paginate", "--slurp"]).flat();
  const pr = read(`pulls/${number}`);
  if (pr.number !== number || !SHA.test(pr.head?.sha ?? "") || !SHA.test(pr.base?.sha ?? "") ||
      !Number.isInteger(pr.commits) || pr.commits < 1 || pr.commits > 250) throw new Error("unproven PR history");
  const commits = pages(`pulls/${number}/commits?per_page=100`);
  if (commits.length !== pr.commits || new Set(commits.map(c => c.sha)).size !== commits.length ||
      !commits.every(c => SHA.test(c.sha ?? "")) || !commits.some(c => c.sha === pr.head.sha)) throw new Error("incomplete PR history");
  const comments = pages(`issues/${number}/comments?per_page=100`);
  // Summaries and authenticated head-bound requests survive a force-push.
  // Keep their reviewed heads even when no longer reachable in PR commits.
  const persistentHeads = comments.flatMap(c => {
    if (c.user?.login === "greptile-apps[bot]" && c.user?.type === "Bot" && (c.body ?? "").startsWith("<!-- greptile_summary -->")) {
      return [...(c.body ?? "").matchAll(/Last reviewed commit: \[[^\n]*?\]\(https:\/\/github\.com\/goldmar\/openclaw-code-agent\/commit\/([a-f0-9]{40})\)/gu)].map(m => m[1]);
    }
    if (c.user?.login === "goldmar" && c.user?.type === "User" && /@greptileai\b/u.test(c.body ?? "")) {
      return [...(c.body ?? "").matchAll(/<!-- dependency-review-request:v1 ([a-f0-9]{40}) -->/gu)].map(m => m[1]);
    }
    return [];
  });
  const checks = [];
  for (const sha of new Set([...commits.map(c => c.sha), ...persistentHeads])) {
    const responses = api(["api", `repos/${REPOSITORY}/commits/${sha}/check-runs?check_name=Greptile%20Review&filter=all&per_page=100`, "--paginate", "--slurp"]);
    const rows = responses.flatMap(page => page.check_runs ?? []);
    if (!responses.length || responses.some(page => page.total_count !== rows.length) ||
        new Set(rows.map(c => c.id)).size !== rows.length) throw new Error("incomplete review history");
    checks.push(...rows.filter(c => c.app?.id === GREPTILE_APP_ID && c.name === "Greptile Review" && c.head_sha === sha));
  }
  if (new Set(checks.map(c => c.id)).size !== checks.length) throw new Error("changed review history");
  const current = read(`pulls/${number}`);
  if (current.head?.sha !== pr.head.sha || current.base?.sha !== pr.base.sha || current.commits !== pr.commits) throw new Error("PR changed during review read");
  return { pr, comments, checks };
}

export function budgetExhausted({ pr, checks = [], comments = [] }) {
  const runs = checks.filter(c => c.app?.id === GREPTILE_APP_ID && c.name === "Greptile Review");
  // One review is allowed per combined PR. A spent prior head or multiple
  // attempts cannot demand another paid review to make the final head eligible.
  if (runs.length > 1 || runs.some(c => c.head_sha !== pr.head.sha)) return true;
  if (comments.some(c => c.user?.login === "greptile-apps[bot]" && c.user?.type === "Bot" &&
      (c.body ?? "").startsWith("<!-- greptile_summary -->") &&
      (Number((c.body ?? "").match(/Reviews \((\d+)\) · Last reviewed commit:/u)?.[1] ?? 0) > 1 ||
       ((c.body ?? "").match(/Last reviewed commit: \[[^\n]*?\]\(https:\/\/github\.com\/goldmar\/openclaw-code-agent\/commit\/([a-f0-9]{40})\)/u)?.[1] ?? pr.head.sha) !== pr.head.sha))) return true;
  // Only the authentic application's explicit quota notice, never owner/PR prose.
  return comments.some(c => c.user?.login === "greptile-apps[bot]" && c.user?.type === "Bot" &&
    /^(?:your |the |greptile )?(?:(?:monthly )?review limit (?:has been )?reached|(?:review |monthly )?(?:budget|quota) (?:is |has been )?exhausted)[.!]?$/imu.test(c.body ?? ""));
}

export function greptileObjection({ pr, checks = [], comments = [] }) {
  // An independent fallback never erases an actual current-head objection.
  const summaries = comments.filter(c => c.user?.login === "greptile-apps[bot]" && c.user?.type === "Bot" &&
    (c.body ?? "").startsWith("<!-- greptile_summary -->") &&
    (c.body ?? "").match(/Last reviewed commit: \[[^\n]*?\]\(https:\/\/github\.com\/goldmar\/openclaw-code-agent\/commit\/([a-f0-9]{40})\)/u)?.[1] === pr.head.sha);
  if (summaries.some(c => GREPTILE_SCORE.exec(c.body ?? "")?.[1] !== "5")) return true;
  const latest = checks.filter(c => c.app?.id === GREPTILE_APP_ID && c.name === GREPTILE_CHECK && c.head_sha === pr.head.sha)
    .sort((a, b) => b.id - a.id)[0];
  const unavailable = [latest?.output?.title, latest?.output?.summary].some(value => typeof value === "string" &&
    /^(?:your |the |greptile )?(?:(?:monthly )?review limit (?:has been )?reached|(?:review |monthly )?(?:budget|quota) (?:is |has been )?exhausted)[.!]?$/imu.test(value));
  return Boolean(latest && !unavailable && (latest.status !== "completed" || !["success", "neutral", "skipped"].includes(latest.conclusion)));
}

export function claudeReceipt({ pr, comments = [] }) {
  const pattern = new RegExp(`^<!-- ${REVIEW_MARKER} (\\{[^\\n]+\\}) -->$`, "u");
  const receipts = comments.filter(c => c.user?.login === "goldmar" && c.user?.type === "User" &&
    c.created_at && c.created_at === c.updated_at).map(c => {
    const match = pattern.exec(c.body ?? "");
    try { return match ? JSON.parse(match[1]) : null; } catch { return null; }
  }).filter(r => r && r.schema === REVIEW_MARKER && r.repo === REPOSITORY && r.number === pr.number &&
    r.head === pr.head.sha && r.base === pr.base.sha && r.reviewer === "claude" && r.model === REVIEW_MODEL &&
    r.transport === "claude-cli" && r.isolation === "empty-cwd-safe-mode-v1" && r.reason === "greptile-budget-exhausted" &&
    r.verdict === "clean" && Array.isArray(r.findings) && r.findings.length === 0 &&
    typeof r.cliVersion === "string" && /^\d+\.\d+\.\d+$/u.test(r.cliVersion) &&
    typeof r.reviewedAt === "string" && Number.isFinite(Date.parse(r.reviewedAt)));
  return receipts.at(-1) ?? null;
}


// Transport is injectable. Every operation is a read, including GraphQL query.
export function githubRead(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }));
}

export function collectSnapshot(number, { api = githubRead, preparedOnly = false } = {}) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("invalid PR number");
  const root = `repos/${REPOSITORY}`;
  const read = path => api(["api", `${root}/${path}`]);
  const pages = path => api(["api", `${root}/${path}`, "--paginate", "--slurp"]).flat();
  const pr = read(`pulls/${number}`);
  const combined = isCombined(pr);
  if (pr.user?.login !== "dependabot[bot]" && !combined) return { pr };
  const comments = pages(`issues/${number}/comments?per_page=100`);
  const writers = [];
  const receiptAuthors = comments.filter(comment => READY.test(comment.body ?? "")).map(comment => comment.user?.login);
  for (const login of new Set(combined ? [pr.user.login] : receiptAuthors)) {
    if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/iu.test(login ?? "")) continue;
    const permission = read(`collaborators/${login}/permission`);
    if (["admin", "maintain", "write"].includes(permission.permission)) writers.push(login);
  }
  const snapshot = { pr, comments, writers };
  if (preparedOnly || preparation(snapshot).status !== "prepared") return snapshot;
  const files = pages(`pulls/${number}/files?per_page=100`);
  if (files.length !== pr.changed_files) throw new Error("incomplete PR file inventory");
  const contents = {};
  const paths = new Set(files.map(file => file.filename));
  if (paths.has("package.json")) {
    for (const path of ["package.json", "pnpm-lock.yaml", "npm-shrinkwrap.json", "pnpm-workspace.yaml"]) paths.add(path);
  }
  for (const path of paths) {
    if (!["package.json", "pnpm-lock.yaml", "npm-shrinkwrap.json", "pnpm-workspace.yaml"].includes(path) &&
        !/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)) continue;
    const fetch = ref => {
      const file = read(`contents/${path}?ref=${ref}`);
      if (file.encoding !== "base64" || !file.content) throw new Error("missing file content");
      return Buffer.from(file.content, "base64").toString("utf8");
    };
    contents[path] = { before: fetch(pr.base.sha), after: fetch(pr.head.sha) };
  }
  const verifiedActionPins = {};
  for (const [path, pair] of Object.entries(contents)) {
    if (!path.startsWith(".github/workflows/")) continue;
    for (const match of pair.after.matchAll(/uses: github\/codeql-action\/(?:init|analyze)@[a-f0-9]{40} # v(\d+\.\d+\.\d+)/gu)) {
      const version = match[1];
      if (verifiedActionPins[version]) continue;
      let object = api(["api", `repos/github/codeql-action/git/ref/tags/v${version}`]).object;
      if (object?.type === "tag" && SHA.test(object.sha)) object = api(["api", `repos/github/codeql-action/git/tags/${object.sha}`]).object;
      if (object?.type !== "commit" || !SHA.test(object.sha)) throw new Error("unverified upstream action pin");
      verifiedActionPins[version] = object.sha;
    }
  }
  const checkPages = api(["api", `${root}/commits/${pr.head.sha}/check-runs?per_page=100`, "--paginate", "--slurp"]);
  const statusPages = api(["api", `${root}/commits/${pr.head.sha}/status?per_page=100`, "--paginate", "--slurp"]);
  const query = `query($endCursor:String){repository(owner:"goldmar",name:"openclaw-code-agent"){pullRequest(number:${number}){reviewThreads(first:100,after:$endCursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}`;
  const threadPages = api(["api", "graphql", "-f", `query=${query}`, "--paginate", "--slurp"]);
  if (!threadPages.length || threadPages.some(page => page.errors ||
      !Array.isArray(page.data?.repository?.pullRequest?.reviewThreads?.nodes)) ||
      threadPages.at(-1).data.repository.pullRequest.reviewThreads.pageInfo?.hasNextPage !== false) {
    throw new Error("incomplete review threads");
  }
  const threads = threadPages.flatMap(page => page.data.repository.pullRequest.reviewThreads.nodes);
  const reviews = pages(`pulls/${number}/reviews?per_page=100`);
  const reviewEvidence = collectReview(number, { api });
  const current = read(`pulls/${number}`);
  if (reviewEvidence.pr.head.sha !== pr.head.sha || reviewEvidence.pr.base.sha !== pr.base.sha || current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha) throw new Error("PR changed during policy read");
  return { ...snapshot, reviewEvidence, pr: current, files, contents, verifiedActionPins, checks: checkPages.flatMap(page => page.check_runs),
    statuses: statusPages.flatMap(page => page.statuses), threads, reviews };
}

export function main(args = process.argv.slice(2)) {
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : null;
  const preparedOnly = args.includes("--preparation");
  const index = args.indexOf("--pr");
  const number = index >= 0 ? Number(args[index + 1]) : event?.pull_request?.number;
  if (preparedOnly && (!event?.pull_request || event.pull_request.user?.login !== "dependabot[bot]")) return;
  const enabled = process.env.OCA_DEPENDENCY_BATCHING_ENABLED === "true";
  if (preparedOnly && !enabled) return;
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== REPOSITORY) throw new Error("wrong repository");
  if (!enabled) { console.log(JSON.stringify({ status: "held", reason: "activation-required" })); return; }
  const snapshot = collectSnapshot(number, { preparedOnly });
  const result = preparedOnly ? preparationForEvent(snapshot, event) : evaluate({ ...snapshot, enabled });
  console.log(JSON.stringify(result));
  if (preparedOnly && !["ordinary", "prepared"].includes(result.status)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch {
    console.error("Dependency policy could not verify current evidence; hold and inspect the owning run.");
    process.exitCode = 1;
  }
}
