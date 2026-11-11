import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetExhausted, claudeReceipt, parseClaudeReview, collectReview, REVIEW_MARKER, REVIEW_MODEL } from "../scripts/lib/dependency-review.mjs";
import { runReview } from "../scripts/dependency-claude-review.mjs";
const head = "a".repeat(40), base = "b".repeat(40), old = "c".repeat(40);
const pr = { number: 591, head: { sha: head }, base: { sha: base }, commits: 2, changed_files: 1 };
const check = { id: 1, name: "Greptile Review", app: { id: 867647 }, head_sha: old };
const identity = { number: 591, head, base };
const events = () => [
  { type: "system", subtype: "init", model: REVIEW_MODEL, apiKeySource: "none", claude_code_version: "2.1.319", tools: ["StructuredOutput"], mcp_servers: [] },
  { type: "assistant", message: { model: REVIEW_MODEL } },
  { type: "result", subtype: "success", is_error: false, modelUsage: { [REVIEW_MODEL]: {} }, structured_output: { head, base, verdict: "clean", findings: [] } },
];
const stream = values => values.map(v => JSON.stringify(v)).join("\n");
const receipt = () => parseClaudeReview(stream(events()), identity);
const comment = value => ({ user: { login: "goldmar", type: "User" }, created_at: "2026-11-10T12:00:00Z", updated_at: "2026-11-10T12:00:00Z", body: `<!-- ${REVIEW_MARKER} ${JSON.stringify(value)} -->` });

test("budget distinguishes available head from spent prior head and authentic quota notice", () => {
  assert.equal(budgetExhausted({ pr, checks: [] }), false);
  assert.equal(budgetExhausted({ pr, checks: [{ ...check, head_sha: head }] }), false);
  assert.equal(budgetExhausted({ pr, checks: [check] }), true);
  assert.equal(budgetExhausted({ pr, checks: [check, { ...check, id: 2, head_sha: head }] }), true);
  assert.equal(budgetExhausted({ pr, comments: [{ user: { login: "contributor", type: "User" }, body: "review budget exhausted" }] }), false);
  assert.equal(budgetExhausted({ pr, comments: [{ user: { login: "greptile-apps[bot]", type: "Bot" }, body: "Monthly review limit reached" }] }), true);
  for (const body of ["Monthly review limit has not been reached", "Example: monthly review limit reached", "> Monthly review limit reached", "The monthly review limit is available"]) {
    assert.equal(budgetExhausted({ pr, comments: [{ user: { login: "greptile-apps[bot]", type: "Bot" }, body }] }), false);
  }
});

test("only exact-head/base unedited owner CLI attestation supplies fallback", () => {
  const valid = receipt(); assert.deepEqual(claudeReceipt({ pr, comments: [comment(valid)] }), valid);
  for (const change of [r => { r.head = old; }, r => { r.base = old; }, r => { r.model = "claude-fable-5"; },
    r => { r.findings = ["unsafe"]; }, r => { r.transport = "api"; }, r => { r.reason = "timeout"; }]) {
    const r = receipt(); change(r); assert.equal(claudeReceipt({ pr, comments: [comment(r)] }), null);
  }
  for (const change of [c => { c.user.login = "contributor"; }, c => { c.updated_at = "later"; }, c => { c.body += " extra"; }]) {
    const c = comment(receipt()); change(c); assert.equal(claudeReceipt({ pr, comments: [c] }), null);
  }
});

test("transport refuses wrong model, tools, auth, findings and incomplete result", () => {
  for (const change of [e => { e[0].model = "claude-fable-5"; }, e => { e[2].modelUsage = { "claude-fable-5": {} }; },
    e => { e[1].message.model = "claude-fable-5"; }, e => { e[0].tools.push("Bash"); }, e => { e[0].apiKeySource = "env"; },
    e => { e[0].mcp_servers.push({ name: "unsafe" }); }, e => { e[2].is_error = true; },
    e => { e[2].structured_output.findings.push("unsafe"); }, e => { e[2].structured_output.head = old; }, e => { e.pop(); }, e => { e.splice(1, 1); }]) {
    const e = events(); change(e); assert.throws(() => parseClaudeReview(stream(e), identity));
  }
});

function apiFixture() {
  const calls = [];
  const api = args => {
    calls.push(args);
    const path = args[1];
    if (path.endsWith("/pulls/591")) return structuredClone(pr);
    if (path.includes("/commits?")) return [[{ sha: old }, { sha: head }]];
    if (path.includes("/comments?")) return [[]];
    if (path.includes("/check-runs?")) return [{ total_count: path.includes(old) ? 1 : 0, check_runs: path.includes(old) ? [check] : [] }];
    if (path.includes("/files?")) return [[{ filename: "package.json", status: "modified" }]];
    if (path.includes("/contents/")) return { encoding: "base64", content: Buffer.from('{"dependencies":{"qs":"6.16.2"}}').toString("base64") };
    throw new Error("unexpected endpoint");
  };
  return { api, calls };
}

test("review fetches complete bytes, pins CLI, posts structured owner receipt only after clean review", () => {
  const f = apiFixture(), writes = [];
  const execute = (command, args, options) => {
    if (command === "claude") {
      assert.equal(args[args.indexOf("--model") + 1], REVIEW_MODEL);
      assert.equal(args.includes("--fallback-model"), false);
      assert.equal(args[args.indexOf("--tools") + 1], "");
      assert.equal(JSON.parse(options.input.slice(options.input.indexOf("\n") + 1)).files.length, 1);
      return stream(events());
    }
    writes.push({ command, args, options }); return "{}";
  };
  assert.equal(runReview(591, { api: f.api, execute, post: true }).model, REVIEW_MODEL);
  assert.equal(writes.length, 1);
  assert.match(JSON.parse(writes[0].options.input).body, /oca-dependency-claude-review:v1/u);
  assert.throws(() => runReview(591, { api: f.api, execute: () => { throw new Error("quota"); }, post: true }));
  assert.equal(writes.length, 1);
});

test("missing history and changing heads fail closed before Claude or posting", () => {
  for (const mode of ["history", "head"]) {
    const f = apiFixture(); let reads = 0;
    const api = args => {
      const value = f.api(args);
      if (args[1].includes("/commits?")) return mode === "history" ? [[{ sha: head }]] : value;
      if (args[1].endsWith("/pulls/591") && ++reads > 1 && mode === "head") value.head.sha = old;
      return value;
    };
    assert.throws(() => collectReview(591, { api }));
  }
});
