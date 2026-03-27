import { mkdtemp, rm } from "fs/promises";
import { randomUUID } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import { getPluginRuntime, type PluginRuntimeStore } from "./runtime-store";

export type EmbeddedEvalTask =
  | "plan_ready"
  | "user_question"
  | "report_worthy_no_change";

export type EmbeddedEvalClassification =
  | "plan_ready"
  | "user_question"
  | "report_worthy_no_change"
  | "none"
  | "uncertain";

export interface EmbeddedEvalResult {
  classification: EmbeddedEvalClassification;
  reason?: string;
}

interface EmbeddedEvalInput {
  task: EmbeddedEvalTask;
  workspaceDir: string;
  agentId?: string;
  prompt: string;
  sessionName?: string;
  turnText: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extractText(result: { payloads?: Array<{ text?: string }> } | undefined): string {
  if (!result?.payloads?.length) return "";
  return result.payloads
    .map((payload) => payload?.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join("\n")
    .trim();
}

function safeJsonParse(text: string): EmbeddedEvalResult {
  try {
    const parsed = JSON.parse(text) as { classification?: unknown; reason?: unknown };
    const classification = parsed?.classification;
    if (
      classification === "plan_ready"
      || classification === "user_question"
      || classification === "report_worthy_no_change"
      || classification === "none"
      || classification === "uncertain"
    ) {
      return {
        classification,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      };
    }
  } catch {
    // Fall through.
  }
  return { classification: "uncertain", reason: "invalid_json" };
}

function buildTaskPrompt(input: EmbeddedEvalInput): string {
  const baseInstructions = [
    "You are a classifier inside the openclaw-code-agent plugin.",
    "Return strict JSON only. No markdown, no prose, no code fences.",
    "Never recommend actions. Only classify.",
    "",
  ];

  if (input.task === "plan_ready") {
    return [
      ...baseInstructions,
      "Task: Determine whether the assistant output is presenting an implementation plan that is ready for user approval before implementation begins.",
      'Return exactly one of: "plan_ready", "none", "uncertain".',
      "Use plan_ready only when the output clearly contains a concrete plan or implementation steps and is explicitly awaiting approval or next-step confirmation before coding.",
      "Use none when it is ordinary progress/output and not a plan gate.",
      "Use uncertain when the evidence is mixed or incomplete.",
      'JSON schema: {"classification":"plan_ready|none|uncertain","reason":"optional short reason"}',
      "",
      `Session name: ${input.sessionName ?? "(unknown)"}`,
      `Original task: ${input.prompt.slice(0, 1500)}`,
      "",
      "Assistant output:",
      input.turnText.slice(0, 4000),
    ].join("\n");
  }

  if (input.task === "user_question") {
    return [
      ...baseInstructions,
      "Task: Determine whether the assistant output ends in a genuine user-facing question or decision request that requires a user reply before work should continue.",
      'Return exactly one of: "user_question", "none", "uncertain".',
      "Use user_question only when the assistant is clearly asking the user to answer, choose, confirm, approve, clarify, or provide missing information.",
      "Do not classify rhetorical questions, internal reasoning, or generic completion text as user_question.",
      "Use none when the assistant does not clearly need a reply.",
      "Use uncertain when the evidence is mixed or incomplete.",
      'JSON schema: {"classification":"user_question|none|uncertain","reason":"optional short reason"}',
      "",
      `Session name: ${input.sessionName ?? "(unknown)"}`,
      `Original task: ${input.prompt.slice(0, 1500)}`,
      "",
      "Assistant output:",
      input.turnText.slice(0, 4000),
    ].join("\n");
  }

  return [
    ...baseInstructions,
    "Task: Determine whether the assistant output is a real user-facing deliverable worth surfacing even though no code changes were made.",
    'Return exactly one of: "report_worthy_no_change", "none", "uncertain".',
    "Use report_worthy_no_change only when the output contains substantive findings, a plan, a report, an audit, research results, or other meaningful written deliverable for the user.",
    "Do not classify short status updates, generic completion text, or empty output as report_worthy_no_change.",
    "Use uncertain when the evidence is mixed or incomplete.",
    'JSON schema: {"classification":"report_worthy_no_change|none|uncertain","reason":"optional short reason"}',
    "",
    `Session name: ${input.sessionName ?? "(unknown)"}`,
    `Original task: ${input.prompt.slice(0, 1500)}`,
    "",
    "Assistant output:",
    input.turnText.slice(0, 5000),
  ].join("\n");
}

export class EmbeddedEvalService {
  constructor(
    private readonly runtime: PluginRuntimeStore | undefined = getPluginRuntime(),
    private readonly timeoutMs: number = 12_000,
  ) {}

  async classify(input: EmbeddedEvalInput): Promise<EmbeddedEvalResult> {
    const runner = this.runtime?.agent?.runEmbeddedPiAgent;
    if (typeof runner !== "function") {
      return { classification: "uncertain", reason: "runtime_unavailable" };
    }

    const trimmedTurnText = input.turnText.trim();
    if (!trimmedTurnText) {
      return { classification: "none", reason: "empty_output" };
    }

    let tempDir: string | undefined;
    try {
      tempDir = await mkdtemp(join(tmpdir(), "openclaw-code-agent-eval-"));
      const sessionFile = join(tempDir, "session.jsonl");
      const result = await runner({
        sessionId: `openclaw-code-agent:${input.task}:${randomUUID()}`,
        sessionKey: `plugin:openclaw-code-agent:${input.task}`,
        agentId: input.agentId ?? "main",
        sessionFile,
        workspaceDir: input.workspaceDir,
        prompt: buildTaskPrompt({ ...input, turnText: trimmedTurnText }),
        disableTools: true,
        timeoutMs: this.timeoutMs,
        runId: `openclaw-code-agent-eval-${randomUUID()}`,
      });
      const rawText = extractText(result);
      return safeJsonParse(rawText);
    } catch (err) {
      return { classification: "uncertain", reason: errorMessage(err) };
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
