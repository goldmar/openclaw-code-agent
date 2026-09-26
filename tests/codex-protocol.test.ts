import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCollaborationMode,
  buildCommandApprovalRequest,
  buildFileChangeApprovalRequest,
  buildPermissionsApprovalRequest,
  buildReviewStartParams,
  buildThreadForkParams,
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
  buildTurnSteerParams,
  buildUserInputRequest,
  classifyTurnOutcome,
  DEFAULT_CODEX_EXECUTION_SETTINGS,
  matchApprovalChoiceFromText,
  readOpenClawExecMode,
  resetCodexExecOverrideWarningsForTests,
  resolveCodexExecutionSettings,
  turnErrorMessage,
} from "../src/harness/codex-protocol";
import type { CommandExecutionRequestApprovalParams } from "../src/harness/codex-app-server-protocol/v2/CommandExecutionRequestApprovalParams";

const execution = DEFAULT_CODEX_EXECUTION_SETTINGS;

describe("codex protocol thread payloads", () => {
  it("sends the system prompt as thread developerInstructions and never the removed reasoningEffort/service_tier fields", () => {
    const params = buildThreadStartParams({
      cwd: "/repo",
      model: "gpt-6-sol",
      fastMode: true,
      developerInstructions: "  Follow the worktree rules.  ",
      execution,
    });
    assert.deepEqual(params, {
      cwd: "/repo",
      model: "gpt-6-sol",
      serviceTier: "priority",
      developerInstructions: "Follow the worktree rules.",
      permissions: ":danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    });
    assert.equal("reasoningEffort" in params, false);
    assert.equal("service_tier" in params, false);
    assert.equal("sandbox" in params, false, "permissions cannot be combined with sandbox");
  });

  it("omits the service tier when fast mode is off so the thread keeps its configured tier", () => {
    const params = buildThreadStartParams({ cwd: "/repo", execution });
    assert.equal("serviceTier" in params, false);
    assert.equal("model" in params, false);
  });

  it("resumes with excludeTurns instead of the removed persistExtendedHistory flag", () => {
    const params = buildThreadResumeParams({ threadId: "t-1", cwd: "/wt", developerInstructions: "x", execution });
    assert.equal(params.excludeTurns, true);
    assert.equal(params.threadId, "t-1");
    assert.equal(params.cwd, "/wt");
    assert.equal(params.developerInstructions, "x");
    assert.equal("persistExtendedHistory" in params, false);
  });

  it("forks before a turn only when asked", () => {
    assert.equal("beforeTurnId" in buildThreadForkParams({ threadId: "t-1", execution }), false);
    const params = buildThreadForkParams({ threadId: "t-1", beforeTurnId: "turn-9", execution });
    assert.equal(params.beforeTurnId, "turn-9");
    assert.equal(params.excludeTurns, true);
  });

  it("applies configured execution settings and rejects unknown values", () => {
    assert.deepEqual(DEFAULT_CODEX_EXECUTION_SETTINGS, {
      permissionProfile: ":danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    });
    const settings = resolveCodexExecutionSettings({
      permissionProfile: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    assert.deepEqual(buildThreadStartParams({ cwd: "/r", execution: settings }), {
      cwd: "/r",
      permissions: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    assert.deepEqual(
      resolveCodexExecutionSettings({ permissionProfile: "root", approvalPolicy: "sometimes", approvalsReviewer: "bob" }),
      DEFAULT_CODEX_EXECUTION_SETTINGS,
    );
    assert.deepEqual(resolveCodexExecutionSettings(undefined), DEFAULT_CODEX_EXECUTION_SETTINGS);
  });

  it("maps the host tools.exec.mode like the bundled Codex plugin when OCA keys are unset", () => {
    assert.deepEqual(resolveCodexExecutionSettings({}, "auto"), { permissionProfile: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
    assert.deepEqual(resolveCodexExecutionSettings({}, "ask"), { permissionProfile: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "user" });
    assert.deepEqual(resolveCodexExecutionSettings({}, "full"), DEFAULT_CODEX_EXECUTION_SETTINGS);
    assert.deepEqual(resolveCodexExecutionSettings({}, undefined), DEFAULT_CODEX_EXECUTION_SETTINGS);
    assert.throws(() => resolveCodexExecutionSettings({}, "deny"), /tools\.exec\.mode is "deny"/);
    assert.throws(() => resolveCodexExecutionSettings({}, "allowlist"), /tools\.exec\.mode is "allowlist"/);
    assert.deepEqual(readOpenClawExecMode({ tools: { exec: { mode: "auto" } } }), "auto");
    assert.equal(readOpenClawExecMode({ tools: { exec: { mode: "bogus" } } }), undefined);
    assert.equal(readOpenClawExecMode(undefined), undefined);
  });

  it("lets explicit OCA settings win over the host exec mode", () => {
    assert.deepEqual(
      resolveCodexExecutionSettings({ permissionProfile: ":danger-full-access", approvalPolicy: "never" }, "auto"),
      { permissionProfile: ":danger-full-access", approvalPolicy: "never", approvalsReviewer: "auto_review" },
    );
    assert.deepEqual(
      resolveCodexExecutionSettings({ permissionProfile: ":read-only" }, "deny"),
      { permissionProfile: ":read-only", approvalPolicy: "on-request", approvalsReviewer: "user" },
    );
  });

  it("warns once when explicit settings run Codex although the host blocks local execution (N7)", () => {
    resetCodexExecOverrideWarningsForTests();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      resolveCodexExecutionSettings({ permissionProfile: ":danger-full-access", approvalPolicy: "never" }, "deny");
      resolveCodexExecutionSettings({ permissionProfile: ":danger-full-access", approvalPolicy: "never" }, "deny");
      resolveCodexExecutionSettings({ permissionProfile: ":workspace" }, "allowlist");
      resolveCodexExecutionSettings({ permissionProfile: ":danger-full-access" }, "auto");
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 2, warnings.join("\n"));
    assert.match(warnings[0]!, /tools\.exec\.mode is "deny".*unsandboxed or unapproved/s);
    assert.match(warnings[1]!, /tools\.exec\.mode is "allowlist"/);
    assert.doesNotMatch(warnings[1]!, /unsandboxed/);
  });
});

describe("codex protocol turn payloads", () => {
  it("uses snake_case collaboration settings with built-in mode instructions", () => {
    assert.deepEqual(buildCollaborationMode("plan", "gpt-6-sol", "high"), {
      mode: "plan",
      settings: { model: "gpt-6-sol", reasoning_effort: "high", developer_instructions: null },
    });
    assert.deepEqual(buildCollaborationMode("default", "gpt-6-sol"), {
      mode: "default",
      settings: { model: "gpt-6-sol", reasoning_effort: null, developer_instructions: null },
    });
  });

  it("sends top-level effort, the model, and a collaboration mode for every turn", () => {
    const plan = buildTurnStartParams({
      threadId: "t-1",
      prompt: "Plan it",
      model: "gpt-6-sol",
      reasoningEffort: "xhigh",
      permissionMode: "plan",
    });
    assert.deepEqual(plan, {
      threadId: "t-1",
      input: [{ type: "text", text: "Plan it", text_elements: [] }],
      model: "gpt-6-sol",
      effort: "xhigh",
      // D5: a plan turn is read-only and cannot escalate, whatever the thread posture.
      permissions: ":read-only",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      collaborationMode: {
        mode: "plan",
        settings: { model: "gpt-6-sol", reasoning_effort: "xhigh", developer_instructions: null },
      },
    });
    const restored = buildTurnStartParams({
      threadId: "t-1",
      prompt: "Go",
      model: "gpt-6-sol",
      permissionMode: "default",
      execution: { permissionProfile: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "auto_review" },
    });
    assert.deepEqual([restored.permissions, restored.approvalPolicy, restored.approvalsReviewer], [":workspace", "on-request", "auto_review"]);
    const implement = buildTurnStartParams({ threadId: "t-1", prompt: "Go", model: "gpt-6-sol", permissionMode: "bypassPermissions" });
    assert.equal(implement.collaborationMode?.mode, "default");
    assert.equal("effort" in implement, false);
    for (const removed of ["approvalPolicy", "sandbox", "service_tier", "systemPrompt"]) {
      assert.equal(removed in implement, false, removed);
    }
  });

  it("steers with the required expectedTurnId precondition", () => {
    assert.deepEqual(buildTurnSteerParams({ threadId: "t-1", expectedTurnId: "turn-2", text: "also do X" }), {
      threadId: "t-1",
      input: [{ type: "text", text: "also do X", text_elements: [] }],
      expectedTurnId: "turn-2",
    });
  });

  it("starts inline reviews", () => {
    assert.deepEqual(buildReviewStartParams("t-1", { type: "baseBranch", branch: "main" }), {
      threadId: "t-1",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });
    assert.deepEqual(buildReviewStartParams("t-1", { type: "commit", sha: "abc" }).target, { type: "commit", sha: "abc", title: null });
  });

  it("classifies terminal turn status from turn/completed only", () => {
    assert.equal(classifyTurnOutcome({ status: "completed" }), "completed");
    assert.equal(classifyTurnOutcome({ status: "failed" }), "failed");
    assert.equal(classifyTurnOutcome({ status: "interrupted" }), "interrupted");
    assert.equal(classifyTurnOutcome(undefined), "completed");
    assert.equal(turnErrorMessage({
      error: { message: "boom", codexErrorInfo: null, additionalDetails: "details", misalignment: null },
    }), "boom\ndetails");
    assert.equal(turnErrorMessage({ error: null }), undefined);
  });
});

describe("codex protocol server requests", () => {
  const commandParams: CommandExecutionRequestApprovalParams = {
    kind: "command",
    threadId: "t-1",
    turnId: "turn-1",
    itemId: "item-1",
    startedAtMs: 0,
    environmentId: null,
    command: "rm -rf build",
    cwd: "/repo",
    reason: "Clean the build",
  };

  it("maps command approvals to typed decisions from availableDecisions", () => {
    const request = buildCommandApprovalRequest("7", {
      ...commandParams,
      availableDecisions: [
        "accept",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm", "-rf"] } },
        "decline",
        "cancel",
      ],
    });
    assert.equal(request.kind, "approval");
    if (request.kind !== "approval") return;
    assert.equal(request.state.requestId, "7");
    assert.equal(request.state.kind, "approval");
    assert.deepEqual(request.state.options, ["Approve once", "Always allow `rm -rf`", "Decline", "Decline and stop turn"]);
    assert.match(request.state.promptText ?? "", /Command: rm -rf build/);
    assert.match(request.state.promptText ?? "", /Reason: Clean the build/);
    assert.deepEqual(request.choices.map((choice) => choice.response), [
      { decision: "accept" },
      { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm", "-rf"] } } },
      { decision: "decline" },
      { decision: "cancel" },
    ]);
    assert.deepEqual(request.declineResponse, { decision: "decline" });
  });

  it("defaults command approvals to the standard decision set", () => {
    const request = buildCommandApprovalRequest("8", commandParams);
    assert.deepEqual(request.state.options, ["Approve once", "Approve for session", "Decline", "Decline and stop turn"]);
  });

  it("maps file-change approvals", () => {
    const request = buildFileChangeApprovalRequest("9", { threadId: "t", turnId: "u", itemId: "i", startedAtMs: 0, grantRoot: "/repo/out" });
    assert.match(request.state.promptText ?? "", /Requested write root: \/repo\/out/);
    assert.equal(request.state.options.length, 4);
  });

  it("answers permission requests with granted profiles and a decline that grants nothing", () => {
    const request = buildPermissionsApprovalRequest("10", {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      environmentId: null,
      startedAtMs: 0,
      cwd: "/repo",
      reason: "Needs network",
      permissions: { network: { enabled: true }, fileSystem: null },
    });
    if (request.kind !== "approval") throw new Error("expected approval");
    assert.deepEqual(request.choices[0].response, { permissions: { network: { enabled: true } }, scope: "turn" });
    assert.deepEqual(request.choices[1].response, { permissions: { network: { enabled: true } }, scope: "session" });
    assert.deepEqual(request.declineResponse, { permissions: {}, scope: "turn" });
    assert.match(request.state.promptText ?? "", /Network access/);
  });

  it("shows every requested filesystem entry before offering a grant", () => {
    const request = buildPermissionsApprovalRequest("11", {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      environmentId: null,
      startedAtMs: 0,
      cwd: "/repo",
      reason: null,
      permissions: {
        network: null,
        fileSystem: {
          read: null,
          write: null,
          entries: [
            { path: { type: "path", path: "/home/user/.ssh" }, access: "write" },
            { path: { type: "glob_pattern", pattern: "/etc/**" }, access: "read" },
            { path: { type: "special", value: { kind: "root" } }, access: "read" },
          ],
        },
      },
    });
    const prompt = request.state.promptText ?? "";
    assert.match(prompt, /Filesystem write: \/home\/user\/\.ssh/);
    assert.match(prompt, /Filesystem read: glob \/etc\/\*\*/);
    assert.match(prompt, /Filesystem read: \/ \(entire filesystem\)/);
  });

  it("maps request_user_input questions into a wizard", () => {
    const request = buildUserInputRequest("11", {
      threadId: "t",
      turnId: "u",
      itemId: "i",
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: "env",
          header: "Environment",
          question: "Where?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Staging", description: "safe" }, { label: "Prod", description: "" }],
        },
        { id: "name", header: "", question: "Name?", isOther: true, isSecret: true, options: null },
      ],
    });
    assert.equal(request.kind, "question");
    assert.equal(request.state.activeQuestionIndex, 0);
    assert.deepEqual(request.state.options, ["Staging", "Prod"]);
    assert.deepEqual(request.state.questions?.[0].options[0], { label: "Staging", value: "Staging", description: "safe" });
    assert.equal(request.state.questions?.[1].allowsFreeText, true);
    assert.equal(request.state.questions?.[1].isSecret, true);
    assert.throws(() => buildUserInputRequest("12", {
      threadId: "t", turnId: "u", itemId: "i", isBlocking: true, autoResolutionMs: null, questions: [],
    }), /expected non-empty questions/);
  });

  it("never maps a plain free-text yes/no onto a persistent policy amendment", () => {
    const request = buildCommandApprovalRequest("9", {
      ...commandParams,
      availableDecisions: [
        { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "evil.test", action: "deny" } } },
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["curl"] } },
        "accept",
        "decline",
      ],
    });
    if (request.kind !== "approval") throw new Error("expected approval");
    assert.deepEqual(matchApprovalChoiceFromText(request.choices, "no")?.response, { decision: "decline" });
    assert.deepEqual(matchApprovalChoiceFromText(request.choices, "yes")?.response, { decision: "accept" });
    assert.equal(matchApprovalChoiceFromText(request.choices, "always"), undefined);
    assert.deepEqual(matchApprovalChoiceFromText(request.choices, "1")?.response, request.choices[0].response, "explicit numeric choice still works");
  });

  it("matches free-text approval replies without guessing at arbitrary text", () => {
    const request = buildCommandApprovalRequest("8", commandParams);
    if (request.kind !== "approval") throw new Error("expected approval");
    assert.equal(matchApprovalChoiceFromText(request.choices, "yes")?.decision, "accept");
    assert.equal(matchApprovalChoiceFromText(request.choices, "Approve for session")?.decision, "acceptForSession");
    assert.equal(matchApprovalChoiceFromText(request.choices, "2")?.decision, "acceptForSession");
    assert.equal(matchApprovalChoiceFromText(request.choices, "no.")?.decision, "decline");
    assert.equal(matchApprovalChoiceFromText(request.choices, "cancel")?.decision, "cancel");
    assert.equal(matchApprovalChoiceFromText(request.choices, "use a dry run first"), undefined);
  });
});
