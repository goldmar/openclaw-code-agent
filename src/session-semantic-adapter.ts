import type { EmbeddedEvalResult } from "./embedded-eval";
import { EmbeddedEvalService } from "./embedded-eval";
import type { TurnBoundaryDecision, TurnBoundaryDecisionContext } from "./types";

export interface NoChangeDeliverableContext {
  harnessName?: string;
  sessionName: string;
  prompt: string;
  workdir: string;
  agentId?: string;
  outputText: string;
}

export class SessionSemanticAdapter {
  constructor(private readonly evaluator: EmbeddedEvalService = new EmbeddedEvalService()) {}

  async classifyTurnBoundary(context: TurnBoundaryDecisionContext): Promise<TurnBoundaryDecision> {
    if (context.harnessName !== "codex") return "complete";
    if (!context.turnText.trim()) return "complete";

    const planResult = await this.evaluator.classify({
      task: "plan_ready",
      workspaceDir: context.workdir,
      agentId: context.originAgentId,
      prompt: context.prompt,
      sessionName: context.sessionName,
      turnText: context.turnText,
    });
    if (planResult.classification === "plan_ready") {
      return "awaiting_plan_decision";
    }

    const questionResult = await this.evaluator.classify({
      task: "user_question",
      workspaceDir: context.workdir,
      agentId: context.originAgentId,
      prompt: context.prompt,
      sessionName: context.sessionName,
      turnText: context.turnText,
    });
    if (questionResult.classification === "user_question") {
      return "awaiting_user_input";
    }

    return "complete";
  }

  async classifyNoChangeDeliverable(context: NoChangeDeliverableContext): Promise<EmbeddedEvalResult> {
    return this.evaluator.classify({
      task: "report_worthy_no_change",
      workspaceDir: context.workdir,
      agentId: context.agentId,
      prompt: context.prompt,
      sessionName: context.sessionName,
      turnText: context.outputText,
    });
  }
}
