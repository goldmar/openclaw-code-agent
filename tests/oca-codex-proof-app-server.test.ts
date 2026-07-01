import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHarness } from "../src/harness/codex";
import { StdioJsonRpcClient } from "../src/harness/codex-rpc";
import type { HarnessMessage } from "../src/harness/types";
import { scenarioByName, redactProofValue } from "../scripts/e2e/oca-codex-proof-app-server";

const repoRoot = join(import.meta.dirname, "..");
const serverPath = join(repoRoot, "scripts", "e2e", "oca-codex-proof-app-server.ts");

async function collect(session: { messages: AsyncIterable<HarnessMessage> }): Promise<HarnessMessage[]> {
  const messages: HarnessMessage[] = [];
  for await (const message of session.messages) {
    messages.push(message);
    if (message.type === "run_completed") break;
  }
  return messages;
}

async function withScenario<T>(scenario: string, run: (requestLog: string) => Promise<T>): Promise<T> {
  const temp = mkdtempSync(join(tmpdir(), "oca-codex-proof-server-test-"));
  const originalScenario = process.env.OCA_CODEX_PROOF_SCENARIO;
  const originalLog = process.env.OCA_CODEX_PROOF_REQUEST_LOG;
  try {
    process.env.OCA_CODEX_PROOF_SCENARIO = scenario;
    process.env.OCA_CODEX_PROOF_REQUEST_LOG = join(temp, "requests.jsonl");
    return await run(process.env.OCA_CODEX_PROOF_REQUEST_LOG);
  } finally {
    if (originalScenario === undefined) delete process.env.OCA_CODEX_PROOF_SCENARIO;
    else process.env.OCA_CODEX_PROOF_SCENARIO = originalScenario;
    if (originalLog === undefined) delete process.env.OCA_CODEX_PROOF_REQUEST_LOG;
    else process.env.OCA_CODEX_PROOF_REQUEST_LOG = originalLog;
    rmSync(temp, { recursive: true, force: true });
  }
}

function createServerWrapper(temp: string): string {
  const wrapper = join(temp, "oca-fake-codex");
  writeFileSync(wrapper, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"${1:-}\" == \"app-server\" ]]; then shift; fi",
    `exec ${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(serverPath)} "$@"`,
    "",
  ].join("\n"));
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function harnessForProofServer(wrapper: string): CodexHarness {
  return new CodexHarness({
    createClient: (settings) => new StdioJsonRpcClient(wrapper, settings.args, settings.requestTimeoutMs),
  });
}

describe("OCA Codex proof fake App Server", () => {
  it("exposes deterministic scenarios", () => {
    assert.equal(scenarioByName("basic").terminalStatus, "completed");
    assert.equal(scenarioByName("plan").plan?.markdown.includes("OCA Codex Proof Plan"), true);
    assert.equal(scenarioByName("fail").terminalStatus, "failed");
    assert.throws(() => scenarioByName("unknown"), /Unknown OCA Codex proof scenario/);
  });

  it("drives the real Codex harness through plan artifacts", async () => {
    await withScenario("plan", async (requestLog) => {
      const temp = mkdtempSync(join(tmpdir(), "oca-codex-proof-wrapper-test-"));
      try {
        const messages = await collect(harnessForProofServer(createServerWrapper(temp)).launch({
        cwd: repoRoot,
        permissionMode: "plan",
        prompt: "Plan only.",
        }));
      assert.ok(messages.some((message) => message.type === "backend_ref"));
      const artifact = messages.find((message): message is Extract<HarnessMessage, { type: "plan_artifact" }> => (
        message.type === "plan_artifact"
      ));
      assert.ok(artifact);
      assert.match(artifact.artifact.markdown, /OCA Codex Proof Plan/);
      const terminal = messages.find((message): message is Extract<HarnessMessage, { type: "run_completed" }> => (
        message.type === "run_completed"
      ));
      assert.equal(terminal?.data.success, true);
      assert.match(readFileSync(requestLog, "utf8"), /"method":"turn\/start"/);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });
  });

  it("emits structured pending input and resolves button selections", async () => {
    await withScenario("pending-question", async () => {
      const temp = mkdtempSync(join(tmpdir(), "oca-codex-proof-wrapper-test-"));
      try {
        const session = harnessForProofServer(createServerWrapper(temp)).launch({
          cwd: repoRoot,
          prompt: "Ask.",
        });
        const messages: HarnessMessage[] = [];
        for await (const message of session.messages) {
          messages.push(message);
          if (message.type === "pending_input") {
            assert.deepEqual(message.state.options, ["Staging (Recommended)", "Production"]);
            await session.submitPendingInputOption?.(0, { requestId: message.state.requestId });
          }
          if (message.type === "run_completed") break;
        }
        assert.ok(messages.some((message) => message.type === "pending_input_resolved"));
        const terminal = messages.find((message): message is Extract<HarnessMessage, { type: "run_completed" }> => (
          message.type === "run_completed"
        ));
        assert.equal(terminal?.data.success, true);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });
  });

  it("exposes approval actions as selectable Codex harness options", async () => {
    await withScenario("approval", async () => {
      const temp = mkdtempSync(join(tmpdir(), "oca-codex-proof-wrapper-test-"));
      try {
        const session = harnessForProofServer(createServerWrapper(temp)).launch({
          cwd: repoRoot,
          prompt: "Approve.",
        });
        const messages: HarnessMessage[] = [];
        for await (const message of session.messages) {
          messages.push(message);
          if (message.type === "pending_input") {
            assert.deepEqual(message.state.options, ["Approve", "Decline"]);
            await session.submitPendingInputOption?.(0, { requestId: message.state.requestId });
          }
          if (message.type === "run_completed") break;
        }
        assert.ok(messages.some((message) => message.type === "pending_input_resolved"));
        const terminal = messages.find((message): message is Extract<HarnessMessage, { type: "run_completed" }> => (
          message.type === "run_completed"
        ));
        assert.equal(terminal?.data.success, true);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });
  });

  it("redacts obvious credentials and private paths in proof logs", () => {
    const redacted = JSON.stringify(redactProofValue({
      token: "sk-secret-token",
      nested: {
        url: "https://alice:hunter2@example.test/path",
        path: "/home/alice/private/worktree",
        cwd: "/tmp/trex-codex-proof/head",
        outputDir: "/tmp/trex-codex-proof/head-out/proof",
        worktreePath: "/tmp/oca-proof/worktrees/native-codex/openclaw-code-agent",
      },
    }));
    assert.doesNotMatch(redacted, /sk-secret-token/);
    assert.doesNotMatch(redacted, /home\/alice/);
    assert.doesNotMatch(redacted, /trex-codex-proof/);
    assert.doesNotMatch(redacted, /oca-proof/);
    assert.match(redacted, /redacted/);
  });
});
