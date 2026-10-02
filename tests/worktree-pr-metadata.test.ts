import "./test-env";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setPluginRuntime } from "../src/runtime-store";
import {
  buildPrMetadata,
  createRuntimePrMetadataProvider,
  formatPrBody,
  isOcaFallbackPrBody,
  type PrMetadata,
  type PrMetadataDiagnostic,
  type PrMetadataResult,
} from "../src/worktree-pr-metadata";

const safeMetadata: PrMetadata = {
  title: "Improve the README overview",
  summary: ["Clarifies the project overview."],
  changes: ["Updates `README.md`."],
  validation: ["Review the documentation diff."],
  notes: ["Documentation changes only."],
};

const evidenceArgs = {
  sessionName: "docs-overview",
  prompt: "Improve docs. Keep the hidden customer migration instructions private.",
  diffSummary: {
    commits: 1,
    filesChanged: 1,
    insertions: 10,
    deletions: 19,
    changedFiles: ["README.md"],
    commitMessages: [{ hash: "abc1234", message: "docs: improve overview", author: "Test" }],
  },
};

const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
const privatePath = "/home/example/private-project";
const privatePrompt = "Keep the hidden customer migration instructions private";

function captureRuntime(complete?: (...args: never[]) => unknown): string[] {
  const logs: string[] = [];
  setPluginRuntime({
    logging: {
      getChildLogger: () => ({
        warn: (message: string, details: unknown) => logs.push(JSON.stringify({ message, details })),
      }),
    },
    ...(complete ? { llm: { complete } } : {}),
  });
  return logs;
}

function assertFallback(
  result: PrMetadataResult,
  diagnostic: PrMetadataDiagnostic,
  fallbackReason: "no-provider" | "provider-failed" | "provider-invalid",
  logs: string[],
): void {
  assert.equal(result.ok, true);
  assert.equal(result.fallbackReason, fallbackReason);
  assert.deepEqual(result.diagnostic, diagnostic);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`stage=${diagnostic.stage} reason=${diagnostic.reason}`));
  const diagnostics = JSON.stringify({ logs, diagnostic: result.diagnostic });
  for (const privateText of [secret, privatePath, privatePrompt, evidenceArgs.sessionName]) {
    assert.ok(!diagnostics.includes(privateText), "diagnostics must omit private input and output");
  }
  const body = formatPrBody({ sessionName: evidenceArgs.sessionName, metadata: result.metadata });
  assert.equal(isOcaFallbackPrBody(body), true);
  for (const privateText of [secret, privatePath, privatePrompt]) {
    assert.ok(!body.includes(privateText), "fallback must preserve existing safety guards");
  }
}

afterEach(() => setPluginRuntime(undefined));

describe("PR metadata fallback diagnostics", () => {
  it("identifies a closed inherited work scope without dispatching or rebinding", async () => {
    const workScope = new AsyncLocalStorage<{ closed: boolean }>();
    const owner = { closed: false };
    let attempts = 0;
    let providerDispatches = 0;
    const logs = captureRuntime(async () => {
      attempts++;
      assert.equal(workScope.getStore(), owner, "requester context must remain inherited");
      if (workScope.getStore()?.closed) throw new Error("Async work scope is closed");
      providerDispatches++;
      return { text: JSON.stringify(safeMetadata) };
    });
    // Session event continuations retain the launch request context after it closes.
    const laterSessionEvent = workScope.run(owner, () => AsyncLocalStorage.snapshot());
    owner.closed = true;
    const result = await laterSessionEvent(() => buildPrMetadata({
      ...evidenceArgs,
      provider: createRuntimePrMetadataProvider(),
    }));

    assertFallback(result, { stage: "completion", reason: "work-scope-closed" }, "provider-failed", logs);
    assert.equal(attempts, 1, "must not retry under another context");
    assert.equal(providerDispatches, 0);
    assert.match(logs[0], /supported host work ownership/);
  });

  it("retains named-role authorization denial and omits the host error message", async () => {
    const role = new AsyncLocalStorage<{ allowed: boolean }>();
    let attempts = 0;
    const logs = captureRuntime(async () => {
      attempts++;
      assert.equal(role.getStore()?.allowed, false);
      throw Object.assign(new Error(`Role denied ${secret} ${privatePath} ${privatePrompt}`), {
        code: "LLM_COMPLETION_NOT_AUTHORIZED",
      });
    });
    const result = await role.run({ allowed: false }, () => buildPrMetadata({
      ...evidenceArgs,
      provider: createRuntimePrMetadataProvider(),
    }));

    assertFallback(result, {
      stage: "completion", reason: "authorization-denied", code: "LLM_COMPLETION_NOT_AUTHORIZED",
    }, "provider-failed", logs);
    assert.equal(attempts, 1);
    assert.match(logs[0], /do not bypass the denial/);
  });

  const hostFailures = [
    ["LLM_RUNTIME_UNAVAILABLE", "runtime-unavailable"],
    ["LLM_COMPLETION_ABORTED", "completion-aborted"],
    ["LLM_COMPLETION_TIMEOUT", "timeout"],
    ["LLM_COMPLETION_OUTPUT_REJECTED", "output-rejected"],
    ["LLM_COMPLETION_FAILED", "completion-failed"],
    ["LLM_ISOLATED_INPUT_REJECTED", "completion-failed"],
    ["LLM_ISOLATED_UNSUPPORTED", "completion-failed"],
  ] as const;
  for (const [code, reason] of hostFailures) {
    it(`classifies the stable host code ${code} without inferring configuration causes`, async () => {
      const logs = captureRuntime();
      const result = await buildPrMetadata({
        ...evidenceArgs,
        provider: { async generatePrMetadata() {
          throw Object.assign(new Error(`No model configured ${secret} ${privatePath}`), { code });
        } },
      });
      assertFallback(result, { stage: "completion", reason, code }, "provider-failed", logs);
      assert.ok(!logs[0].includes("No model configured"));
    });
  }

  for (const thrown of [
    new Error(`Provider failed ${secret} ${privatePath} ${privatePrompt}`),
    Object.assign(new Error(secret), { code: `LLM_COMPLETION_FAILED\n${secret}` }),
    { code: "__proto__", message: privatePrompt },
    `${secret} ${privatePath} ${privatePrompt}`,
  ]) {
    it("omits arbitrary thrown values and unrecognized error codes", async () => {
      const logs = captureRuntime();
      const result = await buildPrMetadata({
        ...evidenceArgs,
        provider: { async generatePrMetadata() { throw thrown; } },
      });
      assertFallback(result, { stage: "completion", reason: "completion-failed" }, "provider-failed", logs);
      assert.ok(!logs[0].includes("code="));
    });
  }

  const uninspectableFailures: Array<{ name: string; thrown: unknown }> = [
    {
      name: "throwing code getter",
      thrown: Object.defineProperty({}, "code", { get() { throw new Error(`${secret} ${privatePath} ${privatePrompt}`); } }),
    },
    {
      name: "Error with a throwing message getter",
      thrown: Object.defineProperty(new Error(), "message", { get() { throw new Error(`${secret} ${privatePath} ${privatePrompt}`); } }),
    },
  ];
  const revokedFailure = Proxy.revocable({}, {});
  revokedFailure.revoke();
  uninspectableFailures.push({ name: "revoked Proxy", thrown: revokedFailure.proxy });
  for (const { name, thrown } of uninspectableFailures) {
    it(`preserves sanitized fallback for a ${name}`, async () => {
      const logs = captureRuntime();
      const result = await buildPrMetadata({
        ...evidenceArgs,
        provider: { async generatePrMetadata() { throw thrown; } },
      });
      assertFallback(result, { stage: "completion", reason: "completion-failed" }, "provider-failed", logs);
      assert.ok(!logs[0].includes("code="));
    });
  }

  it("identifies absence of a provider while keeping the no-provider marker", async () => {
    const logs = captureRuntime();
    const result = await buildPrMetadata(evidenceArgs);
    assertFallback(result, { stage: "availability", reason: "no-provider" }, "no-provider", logs);
  });

  const rejectedPayloads: Array<{ payload: unknown; diagnostic: PrMetadataDiagnostic }> = [
    { payload: " \n ", diagnostic: { stage: "parsing", reason: "empty-output" } },
    { payload: `{"summary":"${secret} ${privatePath} ${privatePrompt}`, diagnostic: { stage: "parsing", reason: "malformed-json" } },
    { payload: "null", diagnostic: { stage: "validation", reason: "invalid-shape" } },
    { payload: { ...safeMetadata, title: "x".repeat(91) }, diagnostic: { stage: "validation", reason: "invalid-shape" } },
    { payload: { ...safeMetadata, summary: [] }, diagnostic: { stage: "validation", reason: "invalid-shape" } },
    { payload: { ...safeMetadata, notes: [secret] }, diagnostic: { stage: "validation", reason: "sensitive-content" } },
    { payload: { ...safeMetadata, summary: [privatePrompt] }, diagnostic: { stage: "validation", reason: "prompt-leak" } },
    { payload: { ...safeMetadata, changes: ["Updates `src/private-customer.ts`."] }, diagnostic: { stage: "validation", reason: "unknown-file" } },
  ];
  for (const { payload, diagnostic } of rejectedPayloads) {
    it(`distinguishes ${diagnostic.reason} from completion failure`, async () => {
      const logs = captureRuntime();
      const result = await buildPrMetadata({
        ...evidenceArgs,
        provider: { async generatePrMetadata() { return payload; } },
      });
      assertFallback(result, diagnostic, "provider-invalid", logs);
    });
  }

  for (const payload of [safeMetadata, JSON.stringify(safeMetadata), "```json\n" + JSON.stringify(safeMetadata) + "\n```"]) {
    it("accepts valid metadata without a fallback diagnostic or warning", async () => {
      const logs = captureRuntime();
      const result = await buildPrMetadata({
        ...evidenceArgs,
        provider: { async generatePrMetadata() { return payload; } },
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.metadata, safeMetadata);
      assert.equal(result.fallbackReason, undefined);
      assert.equal(result.diagnostic, undefined);
      assert.deepEqual(logs, []);
    });
  }

  it("aborts timed-out work and ignores late provider success", async () => {
    const logs = captureRuntime();
    let aborted = false;
    let attempts = 0;
    let lateResponse: Promise<PrMetadata> | undefined;
    const result = await buildPrMetadata({
      ...evidenceArgs,
      timeoutMs: 5,
      provider: { generatePrMetadata(_evidence, signal) {
        attempts++;
        signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
        lateResponse = new Promise((resolve) => setTimeout(() => resolve(safeMetadata), 30));
        return lateResponse;
      } },
    });
    assertFallback(result, {
      stage: "completion", reason: "timeout", code: "LLM_COMPLETION_TIMEOUT",
    }, "provider-failed", logs);
    assert.equal(aborted, true);
    await lateResponse;
    assert.equal(attempts, 1);
    assert.equal(logs.length, 1);
    assert.equal(result.ok && result.metadata.title, "OpenClaw agent changes: docs overview");
  });

  it("preserves final-session-report fallback when completion is unavailable", async () => {
    const logs = captureRuntime();
    const result = await buildPrMetadata({
      ...evidenceArgs,
      outputPreview: "Summary:\n- Clarifies the README overview.\nChanges:\n- Updates `README.md`.\nValidation:\n- Documentation diff reviewed.",
      provider: { async generatePrMetadata() { throw new Error("Async work scope is closed"); } },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.diagnostic, { stage: "completion", reason: "work-scope-closed" });
    assert.equal(result.fallbackReason, "provider-failed");
    assert.equal(result.metadata.title, "improve overview");
    assert.ok(result.metadata.summary.includes("PR metadata generated from the coding agent's final session report."));
    assert.deepEqual(result.metadata.validation, ["Documentation diff reviewed."]);
    assert.equal(logs.length, 1);
  });
});
