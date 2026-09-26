import "./test-env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPlanApprovalPromptContent, buildPlanReviewSummary, paginatePlanApprovalText } from "../src/plan-review-summary";
import { buildWaitingForInputPayload, buildPlanApprovalFallbackMessages } from "../src/session-notification-builders/waiting";

const observed = [
  "## Objective / scope", "", "- **Decision:** Enable agentic video understanding.",
  "| Repository/component | Verified evidence | Decision |",
  "|---|---|---|",
  "| video.ts | Existing reader verified | Use local decoding |",
  "## Implementation approach", "1. Add bounded frame sampling.",
  "## Empty section", "## Tests / verification", "- Run video fixtures.",
  "## Destructive / external effects", "- Send frames to the external provider only after approval.",
  "## Costs", "- Budget: $12 per run.",
  "## Rollback", "- Restore the previous reader.",
  "## Material risks", "- Frames can expose private information.",
  "## Unknowns / decisions", "- Choose local decoding or the hosted alternative.",
  "Implementation approach:",
].join("\n");

function assertPresentation(messages: string[]): void {
  for (const message of messages) {
    assert.ok(message.length <= 3_200);
    assert.doesNotMatch(message, /(?:^|\n)\s*[-•]?\s*\|/);
    assert.doesNotMatch(message, /Full plan:|omitted for brevity|Empty section/);
    const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const [index, line] of lines.entries()) {
      if (!line.endsWith(":")) continue;
      const next = lines[index + 1];
      assert.ok(next, `Heading has no body: ${line}`);
      assert.doesNotMatch(next, /^[A-Z][^:]*:|^Continued in next message\.$/);
    }
    assert.doesNotMatch(message, /Decision brief\s*\n\s*Continued/);
  }
}

describe("plan decision brief presentation", () => {
  it("renders the observed headings and table as populated fields", () => {
    const prompt = buildPlanApprovalPromptContent({ sessionName: "enable-agentic-video-understanding", actionableVersion: 1,
      preview: "", artifact: { markdown: observed, steps: [] }, hasButtons: true,
      escalationRationale: "Scope:\n\nDecision:\nConfirm provider use.\n\nEmpty section:",
    });
    assertPresentation(prompt.userMessages);
    assert.match(prompt.reviewSummary, /Objective \/ scope: Decision: Enable/);
    assert.match(prompt.reviewSummary, /Repository\/component: video.ts; Verified evidence: Existing reader verified; Decision: Use local decoding/);
    for (const text of ["external provider", "$12", "Restore the previous reader", "private information", "hosted alternative", "Run video fixtures"])
      assert.ok(prompt.reviewSummary.includes(text), text);
    assert.equal(prompt.userMessages.join("\n").split("Choose Approve, Revise, or Reject below.").length - 1, 1);
  });

  it("handles already bulleted tables and escaped pipes without losing values", () => {
    const summary = buildPlanReviewSummary({ preview: "", artifact: { steps: [], markdown:
      "• | File | Choice |\n• |---|---|\n• | a.ts | A \\| B |\n" } });
    assert.match(summary, /File: a.ts; Choice: A \| B/);
    assert.doesNotMatch(summary, /• \||- \||---/);
  });

  it("accepts compact Markdown delimiters and preserves code identifiers", () => {
    const summary = buildPlanReviewSummary({ preview: "", artifact: { steps: [], markdown:
      "| File | Validation |\n| - | :-: |\n| `__init__.py` | Run `__all__` checks |\n**Risks:**\n- Check `**/*.ts` without changing __init__.py." } });
    assert.doesNotMatch(summary, /\| - \|/);
    for (const literal of ["`__init__.py`", "`__all__`", "`**/*.ts`", "__init__.py"])
      assert.ok(summary.includes(literal), literal);
  });

  it("normalizes structured metadata and retains substantive decision questions", () => {
    const table = "| Component | Choice |\n|---|---|\n| video.ts | Local or hosted |";
    const summary = buildPlanReviewSummary({ preview: "", artifact: { markdown: "Should production archives be deleted?\nShould I proceed?",
      explanation: table, steps: [{ step: table, status: "pending" }] } });
    assert.doesNotMatch(summary, /\|---|\*\*|Should I proceed/);
    assert.match(summary, /Component: video.ts; Choice: Local or hosted/);
    assert.match(summary, /Should production archives be deleted\?/);
  });

  it("does not invent absent sections or claims of no risk", () => {
    const summary = buildPlanReviewSummary({ preview: "", artifact: { steps: [], markdown: "Objective / scope:\n\n**Material risks:**\nImplementation approach:" } });
    assert.match(summary, /No concrete plan content/);
    assert.doesNotMatch(summary, /Objective \/ scope:|Material risks:|Implementation approach:|No material risk/);
  });

  it("bounds routine steps but preserves late material details and long risk tails", () => {
    const routine = Array.from({ length: 90 }, (_, i) => `${i + 1}. Step ${i + 1}: update routine helper ${i + 1}.`);
    const tail = "private frames ".repeat(250) + "NEVER publish without explicit approval";
    const summary = buildPlanReviewSummary({ preview: "", artifact: { steps: [{ step: "Add basic sampling", status: "pending" }], markdown:
      [...routine, "91. Step 91: delete the legacy bucket permanently.", "92. Step 92: Option A or Option B requires confirmation.", "93. Step 93: Expand scope to cover audio.", "## Material risks", "- " + tail,
        "## Scope", "- Include all 12 readers.", "## Tests", ...Array.from({ length: 12 }, (_, i) => `- Verify fixture ${i}.`),
        "## Rollback", "- Restore the backup."].join("\n") } });
    assert.doesNotMatch(summary, /routine helper 90/);
    for (const text of ["more routine step", "delete the legacy bucket permanently", tail, "Include all 12 readers", "Option A or Option B", "Expand scope to cover audio", "Verify fixture 11", "Restore the backup"])
      assert.ok(summary.includes(text), text.slice(0, 60));
    assert.match(summary, /Reply asking for the full plan to see everything/);
  });

  it("never compacts late validation or affected-system steps, in metadata or Markdown", () => {
    const entries = [
      ...Array.from({ length: 8 }, (_, index) => `Step ${index + 1}: update ordinary helper behavior ${index + 1}.`),
      "Step 9: Run integration tests.",
      "Step 10: change `src/video-reader.ts` and `src/audio-reader.ts`.",
    ];
    for (const structured of [true, false]) {
      const summary = buildPlanReviewSummary({ preview: "", artifact: {
        markdown: structured ? "" : entries.join("\n"),
        steps: structured ? entries.map((step) => ({ step, status: "pending" as const })) : [],
      } });
      assert.match(summary, /Tests \/ verification: Step 9: Run integration tests/);
      assert.match(summary, /Files \/ systems affected: Step 10: change `src\/video-reader.ts` and `src\/audio-reader.ts`/);
      assert.doesNotMatch(summary, /ordinary helper behavior 8/);
      assert.match(summary, /2 more routine steps not shown/);
    }
  });

  it("keeps headings attached at exact boundaries and splits oversized content without loss", () => {
    for (const padding of [2300, 2370, 2398, 2399, 2400]) {
      const body = "x".repeat(padding) + "\n\nMaterial risks:\n" + "private data ".repeat(500) + "TAIL\nEmpty section:";
      const pages = paginatePlanApprovalText(body);
      assert.ok(pages.every((page) => page.length <= 2400));
      assert.ok(pages.every((page) => !page.trimEnd().endsWith("Material risks:")));
      assert.equal(pages.join(" ").replace(/\s+/g, " ").trim(), body.replace(/\nEmpty section:$/, "").replace(/\s+/g, " ").trim());
    }
  });

  it("puts exactly one set of controls on the final required page, including fallback", () => {
    const buttons = [[{ label: "Approve", callback_data: "approve" }, { label: "Revise", callback_data: "revise" }, { label: "Reject", callback_data: "reject" }]];
    const session = { id: "brief", name: "brief", pendingPlanApproval: true, planDecisionVersion: 1, multiTurn: true } as any;
    const payload = buildWaitingForInputPayload({ session, preview: "", planArtifact: { steps: [], markdown: observed + "\n## Risks\n" + "Private frames can leak. ".repeat(400) }, originThreadLine: "", planApprovalMode: "ask", planApprovalButtons: buttons as any });
    assert.ok(payload.userMessages!.length > 1);
    assertPresentation(payload.userMessages!.map((m) => m.text));
    assert.equal(payload.userMessages!.filter((m) => m.buttons).length, 1);
    assert.equal(payload.userMessages!.at(-1)!.buttons, buttons);
    assert.ok(payload.userMessages!.every((m) => m.requiredForSequenceSuccess));
    const fallback = buildPlanApprovalFallbackMessages({ session, summary: payload.planReviewSummary! });
    assert.ok(fallback.every((m) => !m.buttons && m.requiredForSequenceSuccess));
    assertPresentation(fallback.map((m) => m.text));
    assert.equal(fallback.map((m) => m.text).join("\n").split('Reply "approve"').length - 1, 1);
  });

  it("keeps a fenced code block with the step that introduces it instead of splitting it into fields", () => {
    const plan = [
      "## Plan", "",
      "1. Edit `calc.py` to add:",
      "   ```python",
      "   def mul(a, b):",
      '       """Return the product of a and b."""',
      "       return a * b",
      "   ```",
      "   appended after the existing `add` function.",
      "2. Commit the change with git.", "",
      "No tests exist in the repo to run; verification is visual (read file back).",
    ].join("\n");
    const message = buildPlanApprovalPromptContent({ sessionName: "ux-plan", actionableVersion: 1, preview: plan, hasButtons: true }).userMessages[0]!;
    assert.match(message, /Edit `calc\.py` to add: `def mul\(a, b\): """Return the product of a and b\."""; return a \* b`/);
    assert.doesNotMatch(message, /```/);
    assert.doesNotMatch(message, /: return a \* b$/m);
    assert.match(message, /Tests \/ verification: No tests exist/);
  });

  it("shows an unterminated fence as code, and clips long code", () => {
    const plan = ["1. Update `parser.ts` so it reads:", "```", ...Array.from({ length: 30 }, (_, i) => `line_${i} = ${i}`)].join("\n");
    const summary = buildPlanReviewSummary({ preview: plan });
    assert.match(summary, /Update `parser\.ts` so it reads: `line_0 = 0; line_1 = 1;/);
    assert.match(summary, /\.\.\.`/);
    assert.doesNotMatch(summary, /```/);
  });

  it("shows the plan itself instead of a brief when a section heading maps to no field", () => {
    const plan = [
      "# Add mul(a, b) to calc.py", "",
      "## Current file", "```python", "def add(a, b):", "    return a + b", "```", "",
      "## Change", "Append `mul(a, b)` returning `a * b` to `calc.py`.", "",
      "## Commit", "Commit `calc.py` with a short message.",
    ].join("\n");
    const message = buildPlanApprovalPromptContent({ sessionName: "ux-plan", actionableVersion: 1, preview: plan, hasButtons: true }).userMessages[0]!;
    assert.doesNotMatch(message, /Decision brief|Files \/ systems affected: `def add/);
    assert.match(message, /\nPlan\n# Add mul\(a, b\) to calc\.py\n\n## Current file\n```python\ndef add\(a, b\):/);
    assert.match(message, /## Commit\nCommit `calc\.py` with a short message\./);
  });

  it("keeps the decision brief when every section heading maps to a field", () => {
    const plan = ["# Add mul", "", "## Goal", "Add `mul(a, b)`.", "", "## Steps", "1. Edit `calc.py`.", "", "## Verification", "Run the tests."].join("\n");
    const message = buildPlanApprovalPromptContent({ sessionName: "ux-plan", actionableVersion: 1, preview: plan, hasButtons: true }).userMessages[0]!;
    assert.match(message, /Decision brief\nObjective \/ scope: Add `mul\(a, b\)`\./);
    assert.match(message, /Tests \/ verification: Run the tests\./);
  });
});
