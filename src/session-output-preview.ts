import { firstCompleteLines, lastCompleteLines } from "./format";
import type { Session } from "./session";

export function getSessionOutputPreview(session: Session, maxChars: number = 1000): string {
  const useFullOutput = !Number.isFinite(maxChars);
  const outputLines = typeof (session as Partial<Session>).getOutput === "function"
    ? session.getOutput()
    : [];
  const raw = useFullOutput
    ? outputLines.join("\n")
    : selectCompletionPreviewSource(session);
  if (useFullOutput) return raw;
  return raw.length > maxChars
    ? shouldPreferTailPreview(session)
      ? lastCompleteLines(raw, maxChars)
      : firstCompleteLines(raw, maxChars)
    : raw;
}

function selectCompletionPreviewSource(session: Session): string {
  const outputLines = typeof (session as Partial<Session>).getOutput === "function"
    ? session.getOutput()
    : [];
  const fullOutput = outputLines.join("\n").trim();
  if (!fullOutput) return "";
  if (!shouldPreferTailPreview(session)) {
    return outputLines.slice(-20).join("\n");
  }

  const lastBlock = extractLastSubstantiveBlock(fullOutput);
  return lastBlock ?? fullOutput;
}

function shouldPreferTailPreview(session: Session): boolean {
  if (session.status === "completed" || session.killReason === "done") return true;
  const control = session as unknown as {
    approvalState?: string;
    planDecisionVersion?: number;
    planModeApproved?: boolean;
    pendingPlanApproval?: boolean;
  };
  return control.approvalState === "approved"
    || control.planModeApproved === true
    || (control.planDecisionVersion ?? 0) > 0;
}

function extractLastSubstantiveBlock(text: string): string | undefined {
  const blocks = text
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter((block) => /[A-Za-z0-9]/.test(block));
  const lastBlock = blocks.at(-1);
  if (!lastBlock) return undefined;
  return lastBlock.length >= 120 || lastBlock.includes("\n")
    ? lastBlock
    : undefined;
}
