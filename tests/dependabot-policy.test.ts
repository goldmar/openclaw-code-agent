import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPOSITORY, REQUIRED_CHECKS, RUNTIME_PATCHES, DEVELOPMENT_UPDATES,
  preparation, preparationForEvent, dependencyScope, evaluate, collectSnapshot, releaseChange, pnpmVersions,
} from "../scripts/dependency-maintenance.mjs";

const repoRoot = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const head = "a".repeat(40);
const base = "b".repeat(40);
const other = "c".repeat(40);
const ready = `<!-- oca-dependencies-ready:v1 ${head} ${base} -->`;
const lock = (version: string) => `lockfileVersion: '9.0'\n\npackages:\n\n  'qs@${version}':\n    resolution: {integrity: sha512-example}\n\nsnapshots:\n`;

function fixture(): any {
  const before = { name: "example", dependencies: { qs: "6.16.1" }, devDependencies: { "fast-check": "^4.10.2" } };
  const after = structuredClone(before);
  after.dependencies.qs = "6.16.2";
  const shrinkwrap = (version: string) => JSON.stringify({ packages: { "": {}, "node_modules/qs": {
    version, integrity: "sha512-example", resolved: `https://registry.npmjs.org/qs/-/qs-${version}.tgz`,
  } } });
  return {
    enabled: true,
    pr: { number: 700, state: "open", draft: false, user: { login: "dependabot[bot]" },
      base: { ref: "main", sha: base, repo: { full_name: REPOSITORY } },
      head: { sha: head, repo: { full_name: REPOSITORY } },
      auto_merge: null, mergeable: true, mergeable_state: "clean", changed_files: 4,
      labels: [{ name: "dependency-ready" }, { name: "dependency-preparing" }],
    },
    comments: [
      { id: 1, user: { login: "maintainer", type: "User" }, body: ready, created_at: "now", updated_at: "now" },
      { id: 2, user: { login: "greptile-apps[bot]", type: "Bot" }, body: `<!-- greptile_summary -->\n<h2>Confidence Score: 5/5</h2>\nThe PR appears safe to merge; no blocking issue remains in the reviewed changes.\n<h3>Summary</h3>\nLast reviewed commit: [fix](https://github.com/goldmar/openclaw-code-agent/commit/${head})` },
    ],
    writers: ["maintainer"],
    files: ["package.json", "pnpm-lock.yaml", "npm-shrinkwrap.json", "pnpm-workspace.yaml"].map(filename => ({ filename, status: "modified" })),
    contents: {
      "package.json": { before: JSON.stringify(before), after: JSON.stringify(after) },
      "pnpm-lock.yaml": { before: lock("6.16.1"), after: lock("6.16.2") },
      "npm-shrinkwrap.json": { before: shrinkwrap("6.16.1"), after: shrinkwrap("6.16.2") },
      "pnpm-workspace.yaml": { before: "overrides:\n  qs@<6.16.1: 6.16.1\n", after: "overrides:\n  qs@<6.16.2: 6.16.2\n" },
    },
    checks: REQUIRED_CHECKS.map((name: string, index: number) => ({ id: index + 1, name, app: { id: 15368 }, head_sha: head, status: "completed", conclusion: "success" })),
    statuses: [], threads: [], reviews: [],
  };
}

function editManifest(snapshot: any, edit: (manifest: any) => void) {
  const value = JSON.parse(snapshot.contents["package.json"].after);
  edit(value);
  snapshot.contents["package.json"].after = JSON.stringify(value);
}

function apiFixture(snapshot: any, mutateRead?: () => void) {
  const calls: string[][] = [];
  let prReads = 0;
  const api = (args: string[]) => {
    calls.push(args);
    const path = args[1];
    if (path.endsWith(`/pulls/${snapshot.pr.number}`)) {
      prReads++;
      if (prReads === 2) mutateRead?.();
      return snapshot.pr;
    }
    if (path.includes("/comments?")) return [[snapshot.comments[1]], [snapshot.comments[0]]];
    if (path.includes("/collaborators/")) return { permission: "write" };
    if (path.includes("/files?")) return [snapshot.files.slice(0, 2), snapshot.files.slice(2)];
    if (path.includes("/contents/")) {
      const [filename, ref] = path.split("/contents/")[1].split("?ref=");
      const content = snapshot.contents[filename][ref === base ? "before" : "after"];
      return { encoding: "base64", content: Buffer.from(content).toString("base64") };
    }
    if (path.includes("/check-runs?")) return [{ check_runs: snapshot.checks.slice(0, 5) }, { check_runs: snapshot.checks.slice(5) }];
    if (path.includes("/status?")) return [{ statuses: snapshot.statuses }];
    if (path === "graphql") return [{ data: { repository: { pullRequest: { reviewThreads: {
      nodes: snapshot.threads, pageInfo: { hasNextPage: false, endCursor: null },
    } } } } }];
    if (path.includes("/reviews?")) return [snapshot.reviews];
    throw new Error(`Unexpected fixture endpoint ${path}`);
  };
  return { api, calls };
}

describe("weekly dependency admission", () => {
  it("holds activation by default and permits only a prepared final head", () => {
    const s = fixture();
    assert.deepEqual(evaluate({ ...s, enabled: false }), { status: "held", reason: "activation-required" });
    assert.deepEqual(evaluate(s), { status: "eligible", head, base, number: 700 });
    assert.equal(preparation(s).status, "prepared", "preparing label suppresses Greptile while CI is admitted");
  });

  it("rejects stale, edited, spoofed, or unprivileged readiness receipts", () => {
    for (const change of [
      (s: any) => { s.pr.head.sha = other; },
      (s: any) => { s.pr.base.sha = other; },
      (s: any) => { s.comments[0].updated_at = "later"; },
      (s: any) => { s.comments[0].user.type = "Bot"; },
      (s: any) => { s.writers = []; },
      (s: any) => { s.pr.labels = []; },
      (s: any) => { s.comments[0].body += "\nextra instructions"; },
    ]) {
      const s = fixture(); change(s);
      assert.equal(preparation(s).status, "held");
    }
  });

  it("does not admit an obsolete workflow event using a newer head's receipt", () => {
    const s = fixture();
    const event = { pull_request: { head: { sha: head }, base: { sha: base } } };
    assert.equal(preparationForEvent(s, event).status, "prepared");
    for (const field of ["head", "base"]) {
      const stale: any = structuredClone(event); stale.pull_request[field].sha = other;
      assert.equal(preparationForEvent(s, stale).reason, "event-head-or-base-changed");
    }
  });

  it("requires a fresh synchronize event after another group advances main", () => {
    const s = fixture();
    const original = { pull_request: { head: { sha: head }, base: { sha: base } } };
    s.pr.base.sha = other;
    s.comments[0].body = `<!-- oca-dependencies-ready:v1 ${head} ${other} -->`;
    assert.equal(preparation(s).status, "prepared");
    assert.deepEqual(preparationForEvent(s, original), { status: "held", reason: "event-head-or-base-changed" });
    const refreshed = "d".repeat(40);
    s.pr.head.sha = refreshed;
    s.comments[0].body = `<!-- oca-dependencies-ready:v1 ${refreshed} ${other} -->`;
    assert.equal(preparationForEvent(s, { pull_request: { head: { sha: refreshed }, base: { sha: other } } }).status, "prepared");
  });

  it("holds draft, foreign, inactive and inherited auto-merge PRs and never touches #568", () => {
    for (const change of [
      (s: any) => { s.pr.number = 568; }, (s: any) => { s.pr.draft = true; },
      (s: any) => { s.pr.state = "closed"; }, (s: any) => { s.pr.base.ref = "release"; },
      (s: any) => { s.pr.head.repo.full_name = "outsider/fork"; },
      (s: any) => { s.pr.base.repo.full_name = "outsider/fork"; },
      (s: any) => { s.pr.auto_merge = {}; },
    ]) {
      const s = fixture(); change(s); assert.equal(preparation(s).status, "held");
    }
    const s = fixture(); s.pr.number = 568;
    const f = apiFixture(s);
    assert.equal(collectSnapshot(568, { api: f.api }).pr.number, 568);
    assert.equal(f.calls.length, 1);
    s.pr.user.login = "contributor";
    assert.equal(preparation(s).status, "ordinary");
  });
});

describe("actual dependency diff eligibility", () => {
  it("allows stable patches and preserves version range styles", () => {
    assert.equal(dependencyScope(fixture()), null);
    assert.equal(releaseChange("^4.10.2", "^4.11.0"), true);
    for (const [a, b] of [["4.1.0", "5.0.0"], ["0.3.311", "0.3.312"], ["^4.1.0", "4.1.1"],
      ["4.1.0", "latest"], ["4.1.0", "4.1.1-beta.0"], ["4.1.0", "4.0.9"]]) {
      assert.equal(releaseChange(a, b), false);
    }
    assert.equal(releaseChange("4.1.0", "4.2.0", true), false);
  });

  it("allows development minor changes without changing runtime graph", () => {
    const s = fixture();
    s.contents["package.json"].after = s.contents["package.json"].before;
    editManifest(s, m => { m.devDependencies["fast-check"] = "^4.11.0"; });
    s.contents["pnpm-lock.yaml"] = { before: lock("6.16.1").replace("qs@6.16.1", "fast-check@4.10.2"),
      after: lock("6.16.1").replace("qs@6.16.1", "fast-check@4.11.0") };
    s.contents["npm-shrinkwrap.json"].after = s.contents["npm-shrinkwrap.json"].before;
    s.contents["pnpm-workspace.yaml"].after = s.contents["pnpm-workspace.yaml"].before;
    assert.equal(dependencyScope(s), null);
    s.contents["npm-shrinkwrap.json"].after += " ";
    assert.equal(dependencyScope(s), "development-update-changes-published-graph");
  });

  it("rejects source, floor, manifest behavior, new dependency, protected SDK and override changes", () => {
    for (const change of [
      (s: any) => { s.files.push({ filename: "index.ts", status: "modified" }); },
      (s: any) => { s.files[0].status = "renamed"; },
      (s: any) => editManifest(s, m => { m.scripts = { test: "true" }; }),
      (s: any) => editManifest(s, m => { m.peerDependencies = { openclaw: "*" }; }),
      (s: any) => editManifest(s, m => { m.dependencies.extra = "1.0.0"; }),
      (s: any) => editManifest(s, m => { m.dependencies.qs = "6.17.0"; }),
      (s: any) => editManifest(s, m => { m.dependencies.qs = "^6.16.2"; }),
      (s: any) => { s.contents["pnpm-workspace.yaml"].after += "allowBuilds:\n  unsafe: true\n"; },
      (s: any) => { s.contents["pnpm-lock.yaml"].after = lock("6.16.2").replace("qs@6.16.2", "qs@7.0.0"); },
      (s: any) => { s.contents["pnpm-lock.yaml"].after = lock("6.16.2").replace("qs@6.16.2", "new-transitive@1.0.0"); },
    ]) {
      const s = fixture(); change(s); assert.notEqual(dependencyScope(s), null);
    }
    const s = fixture();
    for (const side of ["before", "after"]) {
      const m = JSON.parse(s.contents["package.json"][side]);
      m.dependencies["@anthropic-ai/claude-agent-sdk"] = side === "before" ? "0.3.311" : "0.3.312";
      s.contents["package.json"][side] = JSON.stringify(m);
    }
    assert.equal(dependencyScope(s), "dependency-outside-routine-allowlist");
  });

  it("rejects checksum or URL substitutions for existing versions and non-registry new tarballs", () => {
    for (const field of ["integrity", "resolved"]) {
      const s = fixture();
      for (const side of ["before", "after"]) {
        const graph = JSON.parse(s.contents["npm-shrinkwrap.json"][side]);
        graph.packages["node_modules/unchanged"] = { version: "1.0.0", integrity: "sha512-example",
          resolved: "https://registry.npmjs.org/unchanged/-/unchanged-1.0.0.tgz" };
        if (side === "after") graph.packages["node_modules/unchanged"][field] += "changed";
        s.contents["npm-shrinkwrap.json"][side] = JSON.stringify(graph);
      }
      assert.equal(dependencyScope(s), "unapproved-transitive-change");
    }
    const s = fixture();
    const graph = JSON.parse(s.contents["npm-shrinkwrap.json"].after);
    graph.packages["node_modules/qs"].resolved = "https://example.invalid/qs.tgz";
    s.contents["npm-shrinkwrap.json"].after = JSON.stringify(graph);
    assert.equal(dependencyScope(s), "unapproved-transitive-change");
    const p = fixture();
    for (const side of ["before", "after"]) {
      p.contents["pnpm-lock.yaml"][side] = p.contents["pnpm-lock.yaml"][side].replace("\nsnapshots:",
        `\n  unchanged@1.0.0:\n    resolution: {integrity: sha512-${side === "before" ? "example" : "changed"}}\n\nsnapshots:`);
    }
    assert.equal(dependencyScope(p), "unapproved-transitive-change");
  });

  it("reads the real pinned graph, allowing unchanged prereleases but holding unknown syntax", () => {
    assert.ok(Object.keys(pnpmVersions(read("pnpm-lock.yaml"))).length > 100);
    assert.throws(() => pnpmVersions("lockfileVersion: 'future'\n"));
    assert.throws(() => pnpmVersions(lock("6.16.1").replace("qs@6.16.1", "qs@https://invalid")));
  });

  it("only admits atomic CodeQL pins, not Actions behavior changes", () => {
    const s = fixture();
    const source = `steps:\n  - uses: github/codeql-action/init@${base} # v4.39.1\n  - uses: github/codeql-action/analyze@${base} # v4.39.1\n`;
    const updated = source.replaceAll(base, head).replaceAll("v4.39.1", "v4.39.2");
    s.verifiedActionPins = { "4.39.2": head };
    s.files = [{ filename: ".github/workflows/codeql.yml", status: "modified" }];
    s.contents = { ".github/workflows/codeql.yml": { before: source, after: updated } };
    assert.equal(dependencyScope(s), null);
    s.contents[".github/workflows/codeql.yml"].after += "permissions: write-all\n";
    assert.notEqual(dependencyScope(s), null);
    s.contents[".github/workflows/codeql.yml"].after = updated.replace(head, other);
    assert.notEqual(dependencyScope(s), null);
  });
});

describe("exact-head CI and review gates", () => {
  it("rejects every missing, skipped, stale, foreign-app and failing required context", () => {
    for (const name of REQUIRED_CHECKS) {
      for (const change of [
        (s: any) => { s.checks = s.checks.filter((c: any) => c.name !== name); },
        (s: any) => { s.checks.find((c: any) => c.name === name).conclusion = "skipped"; },
        (s: any) => { s.checks.find((c: any) => c.name === name).head_sha = other; },
        (s: any) => { s.checks.find((c: any) => c.name === name).app.id = 42; },
        (s: any) => { s.checks.find((c: any) => c.name === name).conclusion = "failure"; },
      ]) {
        const s = fixture(); change(s); assert.equal(evaluate(s).status, "held", name);
      }
    }
  });

  it("uses current attempts and blocks pending extra checks and statuses", () => {
    const s = fixture();
    s.checks.push({ ...s.checks[0], id: 100, conclusion: "failure" });
    assert.equal(evaluate(s).status, "held");
    s.checks.push({ ...s.checks[0], id: 101 });
    assert.equal(evaluate(s).status, "eligible");
    s.statuses.push({ state: "pending" });
    assert.equal(evaluate(s).status, "held");
    s.statuses = [];
    s.checks.push({ id: 102, name: "extra", app: { id: 42 }, head_sha: head, conclusion: null });
    assert.equal(evaluate(s).status, "held");
  });

  it("rejects stale, downgraded, spoofed Greptile, open threads and review objections", () => {
    for (const change of [
      (s: any) => { s.comments[1].body = s.comments[1].body.replace(head, other); },
      (s: any) => { s.comments[1].user.login = "outsider"; },
      (s: any) => { s.comments[1].user.type = "User"; },
      (s: any) => { s.comments[1].body = s.comments[1].body.replace(`/commit/${head}`, `/commit/${other}`) + `\nA quoted SHA: ${head}`; },
      (s: any) => { s.comments.push({ ...s.comments[1], id: 5, body: `<!-- greptile_summary -->\nConfidence Score: 3/5 ${head}` }); },
      (s: any) => { s.threads = [{ isResolved: false }]; },
      (s: any) => { s.reviews = [{ id: 1, user: { login: "reviewer" }, state: "CHANGES_REQUESTED" }]; },
      (s: any) => { s.pr.mergeable = null; },
    ]) {
      const s = fixture(); change(s); assert.equal(evaluate(s).status, "held");
    }
  });
});

describe("read-only live evidence transport", () => {
  it("collects all pages, validates writer permission and returns current evidence", () => {
    const s = fixture(); const f = apiFixture(s);
    const result = collectSnapshot(700, { api: f.api });
    assert.equal(evaluate({ ...result, enabled: true }).status, "eligible");
    assert.ok("comments" in result && "checks" in result);
    assert.equal(result.comments.length, 2);
    assert.equal(result.checks?.length, 10);
    assert.ok(f.calls.some(args => args[1].includes("collaborators/maintainer/permission")));
    assert.ok(f.calls.find(args => args[1] === "graphql")?.join(" ").includes("$endCursor"));
    assert.ok(f.calls.every(args => !args.includes("--method") && !args.includes("-X")));
    const queries = f.calls.filter(args => args[1] === "graphql");
    assert.ok(queries.every(args => args.join(" ").includes("query(")));
  });

  it("dereferences official CodeQL tags and holds a misleading version annotation", () => {
    const s = fixture();
    const source = `steps:\n  - uses: github/codeql-action/init@${base} # v4.39.1\n  - uses: github/codeql-action/analyze@${base} # v4.39.1\n`;
    s.files = [{ filename: ".github/workflows/codeql.yml", status: "modified" }];
    s.pr.changed_files = 1;
    s.contents = { ".github/workflows/codeql.yml": { before: source,
      after: source.replaceAll(base, head).replaceAll("v4.39.1", "v4.39.2") } };
    for (const tagTarget of [head, other]) {
      const f = apiFixture(s);
      const api = (args: string[]) => {
        if (args[1].includes("git/ref/tags/")) return { object: { type: "tag", sha: base } };
        if (args[1].includes("git/tags/")) return { object: { type: "commit", sha: tagTarget } };
        return f.api(args);
      };
      const result = collectSnapshot(700, { api });
      assert.equal(evaluate({ ...result, enabled: true }).status, tagTarget === head ? "eligible" : "manual-review");
    }
  });

  it("fails closed when review-thread pagination is incomplete", () => {
    const f = apiFixture(fixture());
    assert.throws(() => collectSnapshot(700, { api: args => {
      const data: any = f.api(args);
      if (args[1] === "graphql") data[0].data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage = true;
      return data;
    } }));
  });

  it("does not need gh, credentials, or installed packages while disabled or checking ordinary PRs", () => {
    const dir = mkdtempSync(join(tmpdir(), "dependency-admission-"));
    try {
      const event = join(dir, "event.json");
      writeFileSync(event, JSON.stringify({ pull_request: { user: { login: "contributor" } } }));
      const env = { ...process.env, PATH: "/nonexistent", OCA_DEPENDENCY_BATCHING_ENABLED: "false" };
      const result = execFileSync(process.execPath, [join(repoRoot, "scripts/dependency-maintenance.mjs"), "--pr", "700"], { env, encoding: "utf8" });
      assert.equal(JSON.parse(result).reason, "activation-required");
      assert.equal(execFileSync(process.execPath, [join(repoRoot, "scripts/dependency-maintenance.mjs"), "--preparation"], {
        env: { ...env, OCA_DEPENDENCY_BATCHING_ENABLED: "true", GITHUB_EVENT_PATH: event }, encoding: "utf8",
      }), "");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects changed heads/bases and truncated file inventories", () => {
    for (const field of ["head", "base"]) {
      const s = fixture(); const f = apiFixture(s, () => { s.pr[field].sha = other; });
      // API snapshots must not share mutable object identity with the caller.
      assert.throws(() => collectSnapshot(700, { api: args => structuredClone(f.api(args)) }));
    }
    const s = fixture(); s.pr.changed_files = 20; const f = apiFixture(s);
    assert.throws(() => collectSnapshot(700, { api: f.api }));
    assert.throws(() => collectSnapshot(-1, { api: f.api }));
  });

  it("stops after preparation reads on an unprepared head; duplicate evaluation never writes", () => {
    const s = fixture(); s.pr.labels = [];
    const f = apiFixture(s);
    for (let index = 0; index < 2; index++) {
      assert.equal(preparation(collectSnapshot(700, { api: f.api })).status, "held");
    }
    assert.ok(!f.calls.some(args => args[1].includes("/contents/")));
  });
});

describe("configuration and integration boundaries", () => {
  it("bounds five weekly groups, preserves cooldown, and does not weekly-delay security updates", () => {
    const config = read(".github/dependabot.yml");
    const entries = config.split(/\n  - package-ecosystem: /).slice(1);
    assert.equal(entries.length, 3);
    for (const entry of entries) {
      assert.match(entry, /interval: weekly\n\s+day: monday/);
      assert.match(entry, /timezone: America\/Los_Angeles/);
      assert.match(entry, /cooldown:\n\s+default-days: 3/);
      assert.match(entry, /rebase-strategy: disabled/);
      assert.match(entry, /labels: \[dependencies, dependency-preparing\]/);
    }
    assert.equal((config.match(/^      [a-z-]+:\n        patterns:/gm) ?? []).length, 5);
    assert.doesNotMatch(config, /applies-to: security-updates|ignore:|target-branch:/);
    assert.match(config, /open-pull-requests-limit: 4/);
    assert.deepEqual(DEVELOPMENT_UPDATES, ["@types/node", "fast-check"]);
    assert.equal(RUNTIME_PATCHES.length, 7);
  });

  it("gates before installations and analysis without duplicate label-triggered suites", () => {
    for (const name of ["ci", "security-audit", "dependency-review", "codeql", "workflow-sanity"]) {
      const workflow = read(`.github/workflows/${name}.yml`);
      assert.match(workflow, /OCA_DEPENDENCY_BATCHING_ENABLED: \$\{\{ vars.OCA_DEPENDENCY_BATCHING_ENABLED \}\}/);
      assert.match(workflow, /node "\$policy_path" --preparation/);
      assert.match(workflow, /BASE_SHA: \$\{\{ github.event.pull_request.base.sha \}\}/);
      assert.match(workflow, /dependency-maintenance.mjs\?ref=\$\{BASE_SHA\}/);
      assert.ok(workflow.indexOf("name: Check dependency preparation") < workflow.indexOf("name: Checkout"));
      assert.doesNotMatch(workflow, /types:.*labeled/);
      const gate = workflow.indexOf("name: Check dependency preparation");
      for (const later of ["name: Setup pnpm", "name: Initialize CodeQL", "name: Install actionlint"]) {
        if (workflow.includes(later)) assert.ok(gate < workflow.indexOf(later));
      }
    }
    const observer = read(".github/workflows/dependabot-automerge.yml");
    assert.match(observer, /ref: \$\{\{ github.workflow_sha \}\}/);
    assert.match(observer, /persist-credentials: false/);
    assert.doesNotMatch(observer, /: write|gh pr merge|fetch-metadata|--admin|--force|head\.sha/);
    assert.match(observer, /types: \[created, edited\]/);
  });
});
