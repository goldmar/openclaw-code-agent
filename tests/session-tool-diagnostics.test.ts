import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setSessionManager } from "../src/singletons";
import { makeAgentRespondTool } from "../src/tools/agent-respond";
import { makeAgentMergeTool } from "../src/tools/agent-merge";
import { makeAgentEscalateTool } from "../src/tools/agent-escalate";
import { makeAgentOutputTool } from "../src/tools/agent-output";
import type { SessionManager } from "../src/session-manager";
import { distFiles, processFields, targetFacts } from "../scripts/e2e/oca-issue-504-host-acceptance";

afterEach(() => setSessionManager(null));

describe("representative host acceptance boundaries", () => {
  it("compares complete published dist membership and content, refusing symlink substitutes", () => {
    const fixture = mkdtempSync(join(tmpdir(), "oca504-dist-"));
    try {
      const built = join(fixture, "built"), published = join(fixture, "published");
      for (const path of [built, published]) {
        mkdirSync(join(path, "chunks"), { recursive: true });
        writeFileSync(join(path, "index.js"), "entry");
        writeFileSync(join(path, "chunks", "a.js"), "chunk");
      }
      assert.deepEqual(distFiles(built), distFiles(published));
      writeFileSync(join(published, "chunks", "a.js"), "different");
      assert.notDeepEqual(distFiles(built), distFiles(published));
      writeFileSync(join(published, "chunks", "a.js"), "chunk");
      writeFileSync(join(published, "extra.js"), "unexpected");
      assert.notDeepEqual(distFiles(built), distFiles(published));
      rmSync(join(published, "extra.js")); rmSync(join(published, "chunks", "a.js"));
      assert.notDeepEqual(distFiles(built), distFiles(published));
      symlinkSync(join(built, "chunks", "a.js"), join(published, "chunks", "a.js"));
      assert.throws(() => distFiles(published), /ordinary files/);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("keeps target/backend/lifecycle facts while excluding transcripts and unrelated private fields", () => {
    const row = { sessionId: "old", name: "alias", status: "completed", backendRef: { conversationId: "thread-old" },
      workdir: "/fixture", worktreePath: "/fixture/tree", worktreeBranch: "selected", worktreeLifecycle: { state: "kept" },
      output: "private transcript", route: { sessionKey: "private-requester" } };
    const facts = targetFacts(row);
    assert.ok(!JSON.stringify(facts).includes("private"));
    for (const changed of [{ sessionId: "new" }, { backendRef: { conversationId: "thread-new" } },
      { worktreeBranch: "other" }, { worktreeLifecycle: { state: "merged" } }]) {
      assert.notDeepEqual(targetFacts({ ...row, ...changed }), facts);
    }
  });

  it("reads kernel start time independently of process name and treats zombies as exited", () => {
    const fields = ["S", "12", "34", ...Array(16).fill("0"), "5678", "0"];
    assert.deepEqual(processFields(90, `90 (native ) name) ${fields.join(" ")}`), { pid: 90, parent: 12, group: 34, start: "5678" });
    fields[19] = "9999";
    assert.equal(processFields(90, `90 (same name) ${fields.join(" ")}`)?.start, "9999");
    fields[0] = "Z";
    assert.equal(processFields(90, `90 (same name) ${fields.join(" ")}`), undefined);
  });
});

const calls = () => [
  { tool: makeAgentRespondTool({ sessionKey: "requester-a" }), params: { message: "1" } },
  { tool: makeAgentMergeTool({ sessionKey: "requester-b" }), params: { base_branch: "invalid branch" } },
  { tool: makeAgentEscalateTool({ sessionKey: "requester-a" }), params: { kind: "plan", summary: "Review" } },
  { tool: makeAgentOutputTool({ sessionKey: "requester-b" }), params: { full: true } },
];

describe("native session diagnostics", () => {
  it("fails closed without leaking references or touching concurrent sessions or Git", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "oca-no-target-git-"));
    const marker = join(fixture, "git-was-invoked");
    const executable = join(fixture, "git");
    writeFileSync(executable, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(executable, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fixture}:${previousPath}`;
    let effects = 0;
    const sessions = new Map(["private-a", "private-b"].map((id) => [id, {
      id, name: id, status: "running", route: { sessionKey: `origin-${id}` },
      getOutput(): string[] { effects++; return []; },
      noteOutcomeSeen() { effects++; },
      sendMessage() { effects++; },
    }]));
    setSessionManager({
      resolve: (ref: string) => sessions.get(ref), getPersistedSession: (): undefined => undefined,
      requestPlanApprovalFromUser() { effects++; }, enqueueMerge() { effects++; },
    } as unknown as SessionManager);
    try {
      for (const ref of ["missing-private-target", "***", "prefix***suffix", " ", "…"]) {
        for (const { tool, params } of calls()) {
          const result = await tool.execute("same-call", { ...params, session: ref });
          const details = (result as any).details;
          assert.equal((result as any).isError, true, tool.name);
          assert.equal(details.status, "error");
          assert.equal(details.code, !ref.trim() || ref.includes("***") ? "session_reference_unusable" : "session_not_found");
          assert.equal(details.operationStarted, false);
          assert.equal(details.targetSelected, false);
          const serialized = JSON.stringify(result);
          for (const secret of ["missing-private-target", "private-a", "private-b", "requester-a", "requester-b", "origin-"]) assert.ok(!serialized.includes(secret));
        }
      }
      assert.equal(effects, 0);
      assert.equal(existsSync(marker), false);
    } finally {
      process.env.PATH = previousPath;
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("marks service and malformed parameters as native failures without asserting target selection", async () => {
    for (const { tool, params } of calls()) {
      setSessionManager(null);
      const unavailable = await tool.execute("id", { ...params, session: "s" });
      assert.equal((unavailable as any).details.code, "service_unavailable");
      assert.equal((unavailable as any).details.status, "error");
      assert.ok(!("targetSelected" in (unavailable as any).details));
      setSessionManager({} as SessionManager);
      const invalid = await tool.execute("id", { ...params, session: 1 });
      assert.equal((invalid as any).details.code, "invalid_parameters");
      assert.ok(!("targetSelected" in (invalid as any).details));
    }
  });

  it("resolves literal masked-looking names and string answers; never silently retries failed handoffs", async () => {
    let sends = 0;
    const session = {
      id: "exact-older", name: "***", status: "running", autoRespondCount: 0,
      currentPermissionMode: "bypassPermissions", incrementAutoRespond() {},
      async sendMessage(message: string) { assert.equal(message, "1"); sends++; },
    };
    setSessionManager({ resolve: (ref: string) => ref === "***" || ref === session.id ? session : undefined,
      getPersistedSession: (): undefined => undefined } as unknown as SessionManager);
    const tool = makeAgentRespondTool();
    const invalid = await tool.execute("same", { session: "***", message: 1 });
    assert.equal((invalid as any).details.code, "invalid_parameters");
    assert.equal(sends, 0);
    for (const callId of ["same", "same", "different"]) {
      assert.equal((await tool.execute(callId, { session: "***", message: "1" })).isError, false);
    }
    await Promise.all([tool.execute("concurrent", { session: "exact-older", message: "1" }), tool.execute("concurrent", { session: "exact-older", message: "1" })]);
    assert.equal(sends, 5, "call IDs are not durable backend delivery receipts");
    for (const failure of ["backend rejected handoff", "backend acceptance unknown"]) {
      const before: number = sends;
      session.sendMessage = async () => { sends++; throw new Error(failure); };
      const failed = await tool.execute("failed", { session: "***", message: "1" });
      assert.equal(failed.isError, true);
      assert.equal(sends, before + 1);
      assert.equal((failed as any).details, undefined, "never claim not-started after a handoff attempt");
    }
  });
});
